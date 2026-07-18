import type { SupabaseClient } from "@supabase/supabase-js";
import { maxRiskLevel, type RiskLevel } from "./risk";

/**
 * upsert risk_alert ของเคส (shared — ใช้ทั้งตอนเปิดเคส และตอน SLA breach scan)
 *   - ยังไม่มี alert active (open/acknowledged) → insert
 *   - มีแล้ว → ยกระดับถ้ารุนแรงกว่า (ไม่ลดเอง) + เติม escalation ถ้าเพิ่ง escalate
 *   ★ idempotent ผ่าน unique active-per-case (23505 race = ถือว่ามีแล้ว)
 *   คืน true เมื่อสร้างใหม่หรือมีการเปลี่ยนแปลง
 */

export type UpsertAlertInput = {
  tenantId: string;
  caseId: string;
  customerId: string | null;
  ownerEmployeeId: string | null;
  level: RiskLevel;
  reason: string;
  /** employee ที่ถูก escalate ไป (owner→lead) — null = ยังไม่ escalate */
  escalatedTo?: string | null;
};

export async function upsertRiskAlert(
  db: SupabaseClient,
  input: UpsertAlertInput,
  nowIso: string
): Promise<boolean> {
  const escalatedTo = input.escalatedTo ?? null;

  const { data: existing } = await db
    .from("risk_alerts")
    .select("id, level, escalated_at")
    .eq("tenant_id", input.tenantId)
    .eq("case_id", input.caseId)
    .in("status", ["open", "acknowledged"])
    .maybeSingle();

  const ex = existing as { id: string; level: RiskLevel; escalated_at: string | null } | null;

  if (!ex) {
    const { error } = await db.from("risk_alerts").insert({
      tenant_id: input.tenantId,
      case_id: input.caseId,
      customer_id: input.customerId,
      level: input.level,
      reason: input.reason,
      owner_employee_id: input.ownerEmployeeId,
      status: "open",
      escalated_at: escalatedTo ? nowIso : null,
      escalated_to_employee_id: escalatedTo,
    });
    // ชน uq_risk_alerts_active_case (race) → ถือว่ามีแล้ว ไม่นับ error
    if (error && (error as { code?: string }).code !== "23505") {
      throw new Error(`risk_alert_insert_failed:${(error as { code?: string }).code ?? "err"}`);
    }
    return !error;
  }

  // มี alert อยู่แล้ว → ยกระดับ / เติม escalation
  const newLevel = maxRiskLevel(ex.level, input.level);
  const patch: Record<string, unknown> = {};
  if (newLevel !== ex.level) {
    patch.level = newLevel;
    patch.reason = input.reason;
  }
  if (escalatedTo && !ex.escalated_at) {
    patch.escalated_at = nowIso;
    patch.escalated_to_employee_id = escalatedTo;
    // L2: escalate แล้วต้อง refresh reason ด้วย (อย่าค้างเหตุผลเก่า)
    patch.reason = input.reason;
  }
  if (Object.keys(patch).length === 0) return false;
  await db.from("risk_alerts").update(patch).eq("id", ex.id);
  return true;
}
