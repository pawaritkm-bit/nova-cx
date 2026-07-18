import type { SupabaseClient } from "@supabase/supabase-js";
import { computeSlaStatus } from "@/lib/dashboard/sla";
import { computeRiskLevel } from "./risk";
import { resolveTeamLead } from "./owner";
import { upsertRiskAlert } from "./alert";

/**
 * SLA Breach Scanner (Phase 3) — สแกน conversation_cases ที่เปิดอยู่
 *   เทียบ first_response_due_at / resolution_due_at กับเวลาปัจจุบัน →
 *     - เขียน sla_events (idempotent : unique case_id+event_type)
 *     - สร้าง/ยกระดับ risk_alert (green/yellow/orange/red)
 *     - escalate owner→หัวหน้าทีม เมื่อเลยกำหนดปิดงาน (บันทึกลง risk_alerts:
 *       escalated_at + escalated_to_employee_id)
 *
 * ★ การแจ้งเตือน/escalate เป็น "dashboard-only" (Phase 5 จะโชว์ risk_alerts + sla_events)
 *   ไม่ push LINE — สอดคล้อง survey escalation เดิม + ยัง map พนักงาน→LINE user ไม่ได้
 *   FUTURE: เมื่อมี employee→LINE mapping ค่อยเพิ่ม worker push แจ้ง owner/หัวหน้าทาง LINE
 *
 * ★ idempotent + fail-closed:
 *   - risk/escalate ยกระดับเฉพาะเมื่อ sla_event นั้น "เพิ่งถูกสร้าง" (unique กันซ้ำ)
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
  ownerAlerted: number; // เคสที่เพิ่งเลยกำหนดตอบครั้งแรก (alert owner ผ่าน dashboard)
  escalated: number; // เคสที่เพิ่ง escalate ไปหัวหน้าทีม
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

  // ★ M1: สถานะ resolution — pause เมื่อ waiting_customer (รอลูกค้าตอบ ไม่ใช่ความผิดนักบัญชี)
  let resolutionDueSoon = false;
  let resolutionBreached = false;
  const resolutionActive = c.status !== "waiting_customer" && !!c.resolution_due_at;
  if (resolutionActive) {
    const st = computeSlaStatus(c.resolution_due_at, nowMs);
    resolutionBreached = st.state === "overdue";
    resolutionDueSoon = st.state === "due-soon";
  }

  // เขียน sla_events (idempotent) + gate การยกระดับด้วย "event ใหม่"
  let responseBreachNew = false;
  let resolutionBreachNew = false;

  if (responseDueSoon && (await recordEvent(db, c.tenant_id, c.id, "response_due_soon", nowIso))) {
    summary.events += 1;
  }
  if (responseBreached && (await recordEvent(db, c.tenant_id, c.id, "response_breached", nowIso))) {
    summary.events += 1;
    responseBreachNew = true;
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

  // escalate: resolution breach ใหม่ → หาหัวหน้าทีมไป escalate (บันทึกลง risk_alerts)
  let escalatedTo: string | null = null;
  if (resolutionBreachNew) {
    const lead = await resolveTeamLead(db, c.tenant_id, c.customer_id, null, now);
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

  // มีสถานะเสี่ยงจริง (ไม่ green) → upsert alert (+ escalation ถ้ามี)
  if (level !== "green") {
    const reason = resolutionBreached
      ? "เลยกำหนดปิดงาน (SLA resolution)"
      : responseBreached
        ? "เลยกำหนดตอบครั้งแรก (SLA first-response)"
        : "ใกล้ครบกำหนด SLA";
    try {
      const changed = await upsertRiskAlert(
        db,
        {
          tenantId: c.tenant_id,
          caseId: c.id,
          customerId: c.customer_id,
          ownerEmployeeId: c.owner_employee_id,
          level,
          reason,
          escalatedTo,
        },
        nowIso
      );
      if (changed) summary.alerts += 1;
    } catch {
      summary.failed += 1;
    }
  }

  if (responseBreachNew) summary.ownerAlerted += 1;
  if (resolutionBreachNew && escalatedTo) summary.escalated += 1;
}

/** สแกนเคสที่เปิดอยู่ → เขียน events + alerts + escalation (dashboard-only) */
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
    ownerAlerted: 0,
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
