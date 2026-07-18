import type { SupabaseClient } from "@supabase/supabase-js";
import type { CaseSignal, FlowStep } from "./scoring";

/**
 * Aggregate signal สำหรับประเมินนักบัญชี (Phase 4) — โหลดจาก DB
 *   รวม conversation_cases (owner = นักบัญชี, ในช่วง) + ai_chat_analysis (flow/problems/sentiment)
 *   + sop_violations → CaseSignal[] ให้ scoring.ts คำนวณต่อ
 *
 *   ★ scope:
 *     - case   : เคสเดียว (conversationCaseId)
 *     - period : ทุกเคสที่ owner เปิดในช่วง [periodStart, periodEnd]
 */

export type AggregateInput = {
  tenantId: string;
  employeeId: string;
  conversationCaseId?: string | null;
  periodStart?: string | null; // ISO
  periodEnd?: string | null; // ISO
};

export type AggregatedSignals = {
  cases: CaseSignal[];
  /** sentiment ภาพรวมของช่วง (แย่สุดที่พบ — ใช้ fallback มิติคุณภาพ) */
  sentiment?: "positive" | "neutral" | "negative";
  /** message id ทั้งหมดที่เกี่ยวข้อง (ไว้ให้ worker ทำ evidence/AI ต่อ) */
  chatGroupIds: string[];
};

type CaseRow = {
  id: string;
  chat_group_id: string;
  owner_employee_id: string | null;
  status: string;
  opened_at: string;
  first_responded_at: string | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  closed_at: string | null;
};

type AnalysisRow = {
  chat_group_id: string;
  flow_steps: unknown;
  problems: unknown;
  sentiment: string | null;
  window_end: string | null;
};

type SopRow = { chat_group_id: string; severity: string };

type StatusHistRow = { case_id: string; to_status: string };

function asFlowSteps(v: unknown): FlowStep[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ step: String(x.step ?? ""), status: String(x.status ?? "unknown") }));
}

function problemCount(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

const SENTIMENT_RANK = { negative: 0, neutral: 1, positive: 2 } as const;

/** โหลด CaseSignal[] ของนักบัญชีในช่วงที่กำหนด */
export async function aggregateAccountantSignals(
  db: SupabaseClient,
  input: AggregateInput
): Promise<AggregatedSignals> {
  // 1) เคสที่นักบัญชีเป็น owner
  let q = db
    .from("conversation_cases")
    .select(
      "id, chat_group_id, owner_employee_id, status, opened_at, first_responded_at, first_response_due_at, resolution_due_at, closed_at"
    )
    .eq("tenant_id", input.tenantId)
    .eq("owner_employee_id", input.employeeId)
    .is("deleted_at", null);

  if (input.conversationCaseId) {
    q = q.eq("id", input.conversationCaseId);
  } else {
    // ★ M3: ช่วงเป็น [start, end) — periodEnd exclusive กันนับซ้ำที่ขอบช่วง (รอบถัดไปเริ่มที่ end พอดี)
    if (input.periodStart) q = q.gte("opened_at", input.periodStart);
    if (input.periodEnd) q = q.lt("opened_at", input.periodEnd);
  }

  const { data: caseData } = await q;
  const cases = (caseData ?? []) as CaseRow[];
  if (cases.length === 0) return { cases: [], chatGroupIds: [] };

  const groupIds = [...new Set(cases.map((c) => c.chat_group_id))];
  const caseIds = cases.map((c) => c.id);

  // 2) ผลวิเคราะห์ล่าสุดต่อกลุ่ม (flow/problems/sentiment)
  const { data: analysisData } = await db
    .from("ai_chat_analysis")
    .select("chat_group_id, flow_steps, problems, sentiment, window_end")
    .eq("tenant_id", input.tenantId)
    .in("chat_group_id", groupIds)
    .is("deleted_at", null)
    .order("window_end", { ascending: false });
  const analyses = (analysisData ?? []) as AnalysisRow[];

  const latestByGroup = new Map<string, AnalysisRow>();
  for (const a of analyses) {
    if (!latestByGroup.has(a.chat_group_id)) latestByGroup.set(a.chat_group_id, a); // อันแรก = ล่าสุด (order desc)
  }

  // 3) sop_violations ต่อกลุ่ม
  const { data: sopData } = await db
    .from("sop_violations")
    .select("chat_group_id, severity")
    .eq("tenant_id", input.tenantId)
    .in("chat_group_id", groupIds)
    .is("deleted_at", null);
  const sopByGroup = new Map<string, { severity: "low" | "medium" | "high" }[]>();
  for (const s of (sopData ?? []) as SopRow[]) {
    const sev = (["low", "medium", "high"].includes(s.severity) ? s.severity : "low") as
      | "low"
      | "medium"
      | "high";
    const list = sopByGroup.get(s.chat_group_id) ?? [];
    list.push({ severity: sev });
    sopByGroup.set(s.chat_group_id, list);
  }

  // 4) เคยถูก reopened ไหม (จาก case_status_history)
  const { data: histData } = await db
    .from("case_status_history")
    .select("case_id, to_status")
    .eq("tenant_id", input.tenantId)
    .in("case_id", caseIds);
  const reopenedCases = new Set<string>();
  for (const h of (histData ?? []) as StatusHistRow[]) {
    if (h.to_status === "reopened") reopenedCases.add(h.case_id);
  }

  // 4.5) ★ M1: หา message id ของ "การตอบครั้งแรก" ต่อกลุ่ม (ไว้ให้ evidence อ้างข้อความจริง)
  //   เลือกข้อความแรกที่ sent_at >= first_responded_at ของเคส (best-effort)
  const respondedAtByGroup = new Map<string, number>();
  for (const c of cases) {
    if (c.first_responded_at) {
      const ms = new Date(c.first_responded_at).getTime();
      const prev = respondedAtByGroup.get(c.chat_group_id);
      // เก็บเวลาตอบครั้งแรกที่ "เร็วสุด" ของกลุ่ม (เผื่อหลายเคส/กลุ่ม)
      if (prev === undefined || ms < prev) respondedAtByGroup.set(c.chat_group_id, ms);
    }
  }
  const firstMsgByCase = new Map<string, string>();
  if (respondedAtByGroup.size > 0) {
    const { data: msgData } = await db
      .from("chat_messages")
      .select("id, chat_group_id, sent_at")
      .eq("tenant_id", input.tenantId)
      .in("chat_group_id", [...respondedAtByGroup.keys()])
      .is("deleted_at", null)
      .order("sent_at", { ascending: true });
    const msgs = (msgData ?? []) as { id: string; chat_group_id: string; sent_at: string | null }[];
    // จับข้อความแรกที่ sent_at >= เวลาตอบครั้งแรกของเคสนั้น
    for (const c of cases) {
      if (!c.first_responded_at) continue;
      const targetMs = new Date(c.first_responded_at).getTime();
      let picked: string | null = null;
      for (const m of msgs) {
        if (m.chat_group_id !== c.chat_group_id || !m.sent_at) continue;
        if (new Date(m.sent_at).getTime() >= targetMs) {
          picked = m.id;
          break; // msgs เรียง sent_at asc แล้ว → ตัวแรกที่ผ่านเงื่อนไข = ใกล้สุด
        }
      }
      if (picked) firstMsgByCase.set(c.id, picked);
    }
  }

  // 5) ประกอบ CaseSignal
  let worstSentiment: number | undefined;
  const signals: CaseSignal[] = cases.map((c) => {
    const a = latestByGroup.get(c.chat_group_id);
    if (a?.sentiment && a.sentiment in SENTIMENT_RANK) {
      const rank = SENTIMENT_RANK[a.sentiment as keyof typeof SENTIMENT_RANK];
      worstSentiment = worstSentiment === undefined ? rank : Math.min(worstSentiment, rank);
    }
    return {
      caseId: c.id,
      hasOwner: !!c.owner_employee_id,
      status: c.status,
      requestAt: c.opened_at,
      firstRespondedAt: c.first_responded_at,
      firstResponseDueAt: c.first_response_due_at,
      resolutionDueAt: c.resolution_due_at,
      closedAt: c.closed_at,
      reopened: reopenedCases.has(c.id) || c.status === "reopened",
      flowSteps: asFlowSteps(a?.flow_steps),
      problemsCount: problemCount(a?.problems),
      sopViolations: sopByGroup.get(c.chat_group_id) ?? [],
      firstResponseMessageId: firstMsgByCase.get(c.id) ?? null,
    };
  });

  const sentiment =
    worstSentiment === undefined
      ? undefined
      : (Object.keys(SENTIMENT_RANK) as (keyof typeof SENTIMENT_RANK)[]).find(
          (k) => SENTIMENT_RANK[k] === worstSentiment
        );

  return { cases: signals, sentiment, chatGroupIds: groupIds };
}
