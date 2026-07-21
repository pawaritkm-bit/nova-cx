import type { SupabaseClient } from "@supabase/supabase-js";
import type { CaseLevel } from "@/lib/ai/case";
import { selectSlaRule, computeSlaDue, type SlaRule } from "./rules";
import { resolveCaseOwner } from "./owner";
import { computeRiskLevel } from "./risk";
import { upsertRiskAlert } from "./alert";

/**
 * เปิด/อัปเดต conversation_case จากผลวิเคราะห์แชต (Phase 3)
 *   - ตัดสินใจว่าควรเปิดเคสไหม (มีคำขอ/งาน/ปัญหา หรือ urgency สูง)
 *   - resolve owner (นักบัญชีผู้ดูแลกลุ่มแชต จาก chat_groups.responsible_employee_id)
 *   - เลือก sla_rule ที่ match → คำนวณ due (fallback default business-hours)
 *   - เรียก RPC open_or_update_conversation_case (atomic + idempotent)
 *
 * ★ idempotent: RPC บังคับ 1 เคส active/กลุ่ม + โยง case_messages ผ่าน unique
 *   เรียกซ้ำด้วย analysis เดิม → ไม่เปิดเคสซ้ำ, ไม่โยงข้อความซ้ำ
 */

/** urgency จาก AI แชต (0033 chat-schema) */
export type ChatAnalysisForCase = {
  urgency: string; // critical|high|medium|low
  sentiment: string; // positive|neutral|negative
  summary: string | null;
  problems: unknown[];
  insufficient_data?: boolean;
};

/** map chat urgency → level ของเคส (critical|high|medium) สำหรับ SLA/escalation */
export function chatCaseLevel(urgency: string): CaseLevel {
  return urgency === "critical" ? "critical" : "high";
}

/**
 * ควรเปิดเคสจากผลวิเคราะห์นี้ไหม
 *   - insufficient_data → ไม่เปิด (ข้อมูลไม่พอ)
 *   - urgency critical/high → เปิด
 *   - มีปัญหา + sentiment ลบ → เปิด (เสี่ยงร้องเรียน)
 */
export function shouldOpenChatCase(a: ChatAnalysisForCase): boolean {
  if (a.insufficient_data) return false;
  if (a.urgency === "critical" || a.urgency === "high") return true;
  const hasProblems = Array.isArray(a.problems) && a.problems.length > 0;
  if (hasProblems && a.sentiment === "negative") return true;
  return false;
}

export type OpenCaseInput = {
  tenantId: string;
  chatGroupId: string;
  /** customer_id ของกลุ่ม (null = ยังจับคู่ไม่ได้ → เปิดเคสได้แต่ไม่มี owner) */
  customerId: string | null;
  analysisId: string | null;
  analysis: ChatAnalysisForCase;
  /** message id ทั้งหมดใน window เพื่อโยง case_messages */
  messageIds: string[];
};

export type OpenCaseResult = {
  skipped: boolean;
  reason?: string;
  caseId?: string;
  created?: boolean;
};

/** โหลด sla_rules ที่ active ของ tenant (best-effort) */
async function loadActiveRules(db: SupabaseClient, tenantId: string): Promise<SlaRule[]> {
  const { data } = await db
    .from("sla_rules")
    .select(
      "id, customer_type, urgency, work_type, team_id, first_response_minutes, resolution_minutes, priority, is_active"
    )
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("deleted_at", null);
  return (data ?? []) as SlaRule[];
}

/**
 * orchestrator — เรียกจาก chat-worker หลัง persist (หรือ worker แยก)
 *   ไม่ควร throw ให้ล้ม job วิเคราะห์ — คืน { skipped, reason } เมื่อทำไม่ได้
 */
export async function openCaseFromChatAnalysis(
  db: SupabaseClient,
  input: OpenCaseInput,
  now: Date = new Date()
): Promise<OpenCaseResult> {
  if (!shouldOpenChatCase(input.analysis)) {
    return { skipped: true, reason: "no_case_needed" };
  }

  const level = chatCaseLevel(input.analysis.urgency);

  // resolve owner จากนักบัญชีผู้ดูแลกลุ่มแชต (chat_groups.responsible_employee_id)
  const owner = await resolveCaseOwner(db, input.tenantId, input.chatGroupId);

  // เลือก SLA rule → คำนวณ due (fallback default)
  const rules = await loadActiveRules(db, input.tenantId);
  const rule = selectSlaRule(rules, {
    urgency: input.analysis.urgency,
    teamId: owner?.teamId ?? null,
  });
  const due = computeSlaDue(rule, level, now);

  const title = (input.analysis.summary ?? "").slice(0, 120) || "เคสจากบทสนทนา";

  const { data, error } = await db.rpc("open_or_update_conversation_case", {
    p_tenant_id: input.tenantId,
    p_chat_group_id: input.chatGroupId,
    p_customer_id: input.customerId,
    p_owner_employee_id: owner?.employeeId ?? null,
    p_title: title,
    p_summary: input.analysis.summary,
    p_urgency: input.analysis.urgency,
    p_level: level,
    p_sla_rule_id: rule?.id ?? null,
    p_first_response_due_at: due.firstResponseDueAt.toISOString(),
    p_resolution_due_at: due.resolutionDueAt.toISOString(),
    p_message_ids: input.messageIds,
    p_changed_by: null,
  });

  if (error) {
    return { skipped: true, reason: `rpc_failed:${(error as { code?: string }).code ?? "err"}` };
  }

  const res = (data ?? {}) as { case_id?: string; created?: boolean };

  // ★ M2: สร้าง/ยกระดับ risk_alert ตั้งแต่ตอนเปิดเคส จาก sentiment/ปัญหา
  //   → เคส sentiment ลบ/มีปัญหาได้ alert ทันที ไม่ต้องรอ SLA breach scan
  if (res.case_id) {
    const risk = computeRiskLevel({
      level,
      sentiment: input.analysis.sentiment,
      problemCount: Array.isArray(input.analysis.problems) ? input.analysis.problems.length : 0,
    });
    if (risk !== "green") {
      try {
        await upsertRiskAlert(
          db,
          {
            tenantId: input.tenantId,
            caseId: res.case_id,
            customerId: input.customerId,
            ownerEmployeeId: owner?.employeeId ?? null,
            level: risk,
            reason: "sentiment ลบ/พบปัญหาในบทสนทนา",
          },
          now.toISOString()
        );
      } catch {
        // alert พลาดต้องไม่ทำให้การเปิดเคส fail — SLA scan จะยกระดับให้ภายหลัง
      }
    }
  }

  return { skipped: false, caseId: res.case_id, created: res.created };
}
