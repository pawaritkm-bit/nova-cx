import type { SupabaseClient } from "@supabase/supabase-js";
import { computeSlaStatus } from "@/lib/dashboard/sla";
import { computeRiskLevel, maxRiskLevel, type RiskLevel } from "./risk";
import { resolveTeamLead } from "./owner";

/**
 * SLA Breach Scanner (Phase 3) — สแกน conversation_cases ที่เปิดอยู่
 *   เทียบ first_response_due_at / resolution_due_at กับเวลาปัจจุบัน →
 *     - เขียน sla_events (idempotent : unique case_id+event_type)
 *     - สร้าง/ยกระดับ risk_alert (green/yellow/orange/red)
 *     - enqueue notification: response_breached → แจ้ง owner ; resolution_breached → escalate หัวหน้าทีม
 *
 * ★ idempotent + fail-closed:
 *   - แจ้งเตือน/escalate ยิงเฉพาะเมื่อ sla_event นั้น "เพิ่งถูกสร้าง" (unique กันซ้ำ)
 *   - error ต่อเคส isolate ไม่ให้ล้มทั้ง batch
 *   - service_role bypass RLS (scanner รันเบื้องหลัง)
 *
 * inject deps (now) เพื่อ test ได้โดยไม่พึ่งเวลาจริง
 */

const DEFAULT_BATCH = 200;
const ACTIVE_STATUSES = ["open", "in_progress", "waiting_customer", "reopened"];

export type BreachScanDeps = {
  db: SupabaseClient;
  now?: () => Date;
};

export type BreachScanSummary = {
  scanned: number;
  events: number; // sla_events ที่สร้างใหม่รอบนี้
  alerts: number; // risk_alert สร้าง/ยกระดับ
  ownerNotified: number;
  escalated: number;
  failed: number;
};

type CaseRow = {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  owner_employee_id: string | null;
  level: string;
  status: string;
  first_responded_at: string | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
};

type SlaEventType =
  | "response_due_soon"
  | "response_breached"
  | "resolution_due_soon"
  | "resolution_breached";

/**
 * บันทึก sla_event แบบ idempotent — คืน true เมื่อ "เพิ่งสร้าง" (event ใหม่)
 *   ชน unique (case_id,event_type) = 23505 → false (มีอยู่แล้ว ไม่ยิงซ้ำ)
 */
async function recordEvent(
  db: SupabaseClient,
  tenantId: string,
  caseId: string,
  eventType: SlaEventType,
  nowIso: string
): Promise<boolean> {
  const { error } = await db.from("sla_events").insert({
    tenant_id: tenantId,
    case_id: caseId,
    event_type: eventType,
    occurred_at: nowIso,
  });
  if (error) {
    // 23505 = มี event ชนิดนี้แล้ว → idempotent skip (ไม่ใช่ error)
    if ((error as { code?: string }).code === "23505") return false;
    throw new Error(`sla_event_insert_failed:${(error as { code?: string }).code ?? "err"}`);
  }
  return true;
}

/** enqueue งานแจ้งเตือนเคส (queue แยก 'case_notification' — ไม่ชน survey notify) */
async function enqueueCaseNotification(
  db: SupabaseClient,
  tenantId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await db.from("job_queue").insert({
    tenant_id: tenantId,
    queue: "case_notification",
    payload,
  });
}

/**
 * upsert risk_alert ของเคส:
 *   - ยังไม่มี alert active → insert (level ที่คำนวณ)
 *   - มีแล้ว → ยกระดับถ้ารุนแรงกว่า (ไม่ลดระดับเอง) + set escalation ถ้าเพิ่ง escalate
 *   คืน true เมื่อสร้างใหม่หรือมีการเปลี่ยนแปลง
 */
async function upsertRiskAlert(
  db: SupabaseClient,
  c: CaseRow,
  level: RiskLevel,
  reason: string,
  escalatedTo: string | null,
  nowIso: string
): Promise<boolean> {
  const { data: existing } = await db
    .from("risk_alerts")
    .select("id, level, escalated_at")
    .eq("case_id", c.id)
    .in("status", ["open", "acknowledged"])
    .maybeSingle();

  const ex = existing as { id: string; level: RiskLevel; escalated_at: string | null } | null;

  if (!ex) {
    const { error } = await db.from("risk_alerts").insert({
      tenant_id: c.tenant_id,
      case_id: c.id,
      customer_id: c.customer_id,
      level,
      reason,
      owner_employee_id: c.owner_employee_id,
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
  const newLevel = maxRiskLevel(ex.level, level);
  const patch: Record<string, unknown> = {};
  if (newLevel !== ex.level) {
    patch.level = newLevel;
    patch.reason = reason;
  }
  if (escalatedTo && !ex.escalated_at) {
    patch.escalated_at = nowIso;
    patch.escalated_to_employee_id = escalatedTo;
  }
  if (Object.keys(patch).length === 0) return false;
  await db.from("risk_alerts").update(patch).eq("id", ex.id);
  return true;
}

/** ประมวลผล SLA ของเคสเดียว */
async function scanCase(
  db: SupabaseClient,
  c: CaseRow,
  now: Date,
  summary: BreachScanSummary
): Promise<void> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  // สถานะ first-response (เฉพาะเมื่อยังไม่ตอบครั้งแรก)
  let responseDueSoon = false;
  let responseBreached = false;
  if (!c.first_responded_at && c.first_response_due_at) {
    const st = computeSlaStatus(c.first_response_due_at, nowMs);
    responseBreached = st.state === "overdue";
    responseDueSoon = st.state === "due-soon";
  }

  // สถานะ resolution (เฉพาะเมื่อเคสยังไม่ปิด)
  let resolutionDueSoon = false;
  let resolutionBreached = false;
  if (c.resolution_due_at) {
    const st = computeSlaStatus(c.resolution_due_at, nowMs);
    resolutionBreached = st.state === "overdue";
    resolutionDueSoon = st.state === "due-soon";
  }

  // เขียน sla_events (idempotent) + gate การแจ้งเตือนด้วย "event ใหม่"
  let ownerBreachNew = false;
  let resolutionBreachNew = false;

  if (responseDueSoon && (await recordEvent(db, c.tenant_id, c.id, "response_due_soon", nowIso))) {
    summary.events += 1;
  }
  if (responseBreached && (await recordEvent(db, c.tenant_id, c.id, "response_breached", nowIso))) {
    summary.events += 1;
    ownerBreachNew = true;
  }
  if (
    resolutionDueSoon &&
    (await recordEvent(db, c.tenant_id, c.id, "resolution_due_soon", nowIso))
  ) {
    summary.events += 1;
  }
  if (
    resolutionBreached &&
    (await recordEvent(db, c.tenant_id, c.id, "resolution_breached", nowIso))
  ) {
    summary.events += 1;
    resolutionBreachNew = true;
  }

  // escalate: resolution breach ใหม่ → หาหัวหน้าทีมไป escalate
  let escalatedTo: string | null = null;
  if (resolutionBreachNew) {
    const lead = await resolveTeamLead(db, c.customer_id, null, now);
    // หัวหน้าต้องไม่ใช่คนเดียวกับ owner (ไม่งั้น escalate ไปหาตัวเอง)
    if (lead && lead !== c.owner_employee_id) escalatedTo = lead;
  }

  // risk level จากสถานะ SLA
  const level = computeRiskLevel({
    responseBreached,
    resolutionBreached,
    responseDueSoon,
    resolutionDueSoon,
    level: c.level,
    escalated: !!escalatedTo,
  });

  // มีสถานะเสี่ยงจริง (ไม่ green) → upsert alert
  if (level !== "green") {
    const reason = resolutionBreached
      ? "เลยกำหนดปิดงาน (SLA resolution)"
      : responseBreached
        ? "เลยกำหนดตอบครั้งแรก (SLA first-response)"
        : "ใกล้ครบกำหนด SLA";
    try {
      if (await upsertRiskAlert(db, c, level, reason, escalatedTo, nowIso)) summary.alerts += 1;
    } catch {
      summary.failed += 1;
    }
  }

  // แจ้งเตือน owner เมื่อ response breach ใหม่
  if (ownerBreachNew && c.owner_employee_id) {
    await enqueueCaseNotification(db, c.tenant_id, {
      kind: "owner_breach",
      case_id: c.id,
      employee_id: c.owner_employee_id,
      event: "response_breached",
    });
    summary.ownerNotified += 1;
  }

  // escalate หัวหน้าทีมเมื่อ resolution breach ใหม่
  if (resolutionBreachNew && escalatedTo) {
    await enqueueCaseNotification(db, c.tenant_id, {
      kind: "lead_escalation",
      case_id: c.id,
      employee_id: escalatedTo,
      event: "resolution_breached",
    });
    summary.escalated += 1;
  }
}

/** สแกนเคสที่เปิดอยู่ → เขียน events + alerts + enqueue แจ้งเตือน */
export async function scanSlaBreaches(
  deps: BreachScanDeps,
  opts: { limit?: number } = {}
): Promise<BreachScanSummary> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const limit = opts.limit ?? DEFAULT_BATCH;

  const summary: BreachScanSummary = {
    scanned: 0,
    events: 0,
    alerts: 0,
    ownerNotified: 0,
    escalated: 0,
    failed: 0,
  };

  const { data: cases, error } = await db
    .from("conversation_cases")
    .select(
      "id, tenant_id, customer_id, owner_employee_id, level, status, first_responded_at, first_response_due_at, resolution_due_at"
    )
    .in("status", ACTIVE_STATUSES)
    .is("deleted_at", null)
    .order("resolution_due_at", { ascending: true })
    .limit(limit);

  if (error) return summary;

  for (const c of (cases ?? []) as CaseRow[]) {
    summary.scanned += 1;
    try {
      await scanCase(db, c, now, summary);
    } catch {
      // isolate ต่อเคส — เคสหนึ่งพังต้องไม่ล้มทั้ง batch
      summary.failed += 1;
    }
  }

  return summary;
}
