import { createHash } from "node:crypto";
import type { SurveyType } from "@/lib/survey/types";

/**
 * Eligibility engine (pure) สำหรับ scan-invitations cron (FR-SC-01/01b/05/06)
 *   - สำนักงาน (A): ถึงรอบทุก 3 เดือนนับจากวันเริ่มบริการ (รอบแรก = ครบ 3 เดือน;
 *     รอบ 0 คือส่งครั้งแรกตอนแอด LINE — จัดการโดย follow-trigger chunk อื่น)
 *   - นักบัญชี (B): รายเดือน (bucket ต่อเดือนปฏิทิน) → ต้นเดือนสร้าง แล้ว idempotent ทั้งเดือน
 *   - idempotency_key = hash(customer_id, survey_type, cycle_period) กันสร้างซ้ำ/เก็บตกรอบพลาด
 *   - stop conditions + snapshot ผู้ดูแล ณ ตอน trigger (temporal binding)
 *
 * ทุกฟังก์ชันเป็น pure → unit test ได้ทันทีโดยไม่ต้องมี DB/เวลา จริง
 * หมายเหตุเรื่องเวลา: คิดแบบ UTC date-only เพื่อให้ผลคงที่ (deterministic) ระหว่างรอบ cron
 */

/** จำนวนเดือนต่อรอบแบบประเมินสำนักงาน (A) */
export const OFFICE_CYCLE_MONTHS = 3;

// ---------------------------------------------------------------------
// date helpers (UTC date-only)
// ---------------------------------------------------------------------

/** parse 'YYYY-MM-DD' หรือ Date → Date (เที่ยงคืน UTC) ; คืน null ถ้าไม่ valid */
function parseDateOnly(input: string | Date | null | undefined): Date | null {
  if (!input) return null;
  if (input instanceof Date) {
    if (!Number.isFinite(input.getTime())) return null;
    return new Date(
      Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate())
    );
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  if (!m) {
    const d = new Date(input);
    if (!Number.isFinite(d.getTime())) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = new Date(Date.UTC(y, mo, day));
  return Number.isFinite(d.getTime()) ? d : null;
}

/** ตัดเวลาออกจาก Date → เที่ยงคืน UTC ของวันนั้น */
function toDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Date → 'YYYY-MM-DD' */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** บวกเดือนแบบ clamp วัน (เช่น 31 ม.ค. +1 เดือน → 28/29 ก.พ.) */
function addMonths(d: Date, months: number): Date {
  const total = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDay);
  return new Date(Date.UTC(year, month, day));
}

/** จำนวน "เดือนเต็ม" ที่ผ่านไประหว่าง from→to (นับตามปฏิทิน ไม่ใช่ 30 วัน) */
export function fullMonthsBetween(from: Date, to: Date): number {
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return months;
}

// ---------------------------------------------------------------------
// A — สำนักงาน (รอบ 3 เดือน)
// ---------------------------------------------------------------------

export type OfficeCycleResult =
  | { due: false; reason: "no_service_start" | "not_started" | "before_first_cycle" }
  | {
      due: true;
      /** cycle_period สำหรับ unique/idempotency (เช่น 'A:2026-04-01') */
      cyclePeriod: string;
      /** วันเริ่มของรอบที่ถึงกำหนด */
      cycleStartDate: string;
      /** ลำดับรอบ (1 = ครบ 3 เดือนแรก) */
      cycleIndex: number;
    };

/**
 * ลูกค้าถึงรอบแบบประเมินสำนักงาน (A) หรือยัง ณ วัน now
 *   - รอบที่ถึงกำหนด = รอบล่าสุดที่วันเริ่มรอบ <= today (จึงเก็บตกได้เมื่อ cron พลาดวัน)
 *   - รอบแรกคือครบ 3 เดือนพอดี (cycleIndex >= 1); รอบ 0 (วันเริ่มบริการ) ให้ follow-trigger จัดการ
 */
export function officeCycleDue(
  serviceStartDate: string | Date | null | undefined,
  now: Date
): OfficeCycleResult {
  const start = parseDateOnly(serviceStartDate);
  if (!start) return { due: false, reason: "no_service_start" };

  const today = toDateOnly(now);
  if (today.getTime() < start.getTime()) return { due: false, reason: "not_started" };

  const months = fullMonthsBetween(start, today);
  const cycleIndex = Math.floor(months / OFFICE_CYCLE_MONTHS);
  if (cycleIndex < 1) return { due: false, reason: "before_first_cycle" };

  const cycleStart = addMonths(start, cycleIndex * OFFICE_CYCLE_MONTHS);
  return {
    due: true,
    cyclePeriod: `A:${toIsoDate(cycleStart)}`,
    cycleStartDate: toIsoDate(cycleStart),
    cycleIndex,
  };
}

// ---------------------------------------------------------------------
// B — นักบัญชี (รายเดือน)
// ---------------------------------------------------------------------

/** cycle_period ของแบบประเมินนักบัญชี (B) = เดือนปฏิทินปัจจุบัน เช่น 'B:2026-07' */
export function accountantCyclePeriod(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `B:${y}-${m}`;
}

// ---------------------------------------------------------------------
// idempotency key
// ---------------------------------------------------------------------

/**
 * idempotency_key = hash(customer_id, survey_type, cycle_period)
 *   - deterministic → cron ยิงซ้ำ/พลาดรอบแล้วเก็บตก จะได้ key เดิม (unique constraint กันซ้ำ)
 *   - prefix 'sched:' แยกที่มาจาก integration ('nova-sales:...')
 */
export function schedulingIdempotencyKey(
  customerId: string,
  surveyType: SurveyType,
  cyclePeriod: string
): string {
  const raw = `${customerId}|${surveyType}|${cyclePeriod}`;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  return `sched:${digest}`;
}

// ---------------------------------------------------------------------
// stop conditions
// ---------------------------------------------------------------------

/** true เมื่อบริการลูกค้ายัง active (ไม่ยกเลิก/ไม่ถูกลบ) — FR-SC-04 หยุดเมื่อยกเลิกบริการ */
export function isCustomerServiceActive(
  status: string | null | undefined,
  deletedAt: string | null | undefined
): boolean {
  return !deletedAt && status === "active";
}

export type BlockState = "no_link" | "blocked" | "reachable";

/**
 * สถานะการติดต่อลูกค้าผ่าน LINE จากรายการ line_users
 *   - reachable : มีบัญชีที่ยังไม่บล็อกอย่างน้อย 1
 *   - blocked   : มีบัญชี แต่บล็อกทั้งหมด (หยุดส่งช่องส่วนตัว — FR-SC-04)
 *   - no_link   : ยังไม่ผูกบัญชี LINE (สร้าง invitation ได้ ให้ worker defer จนกว่าจะลิงก์)
 */
export function customerBlockState(
  lineUsers: { is_blocked: boolean }[]
): BlockState {
  if (lineUsers.length === 0) return "no_link";
  if (lineUsers.some((u) => !u.is_blocked)) return "reachable";
  return "blocked";
}

// ---------------------------------------------------------------------
// assignee snapshot (temporal binding — เคสพิเศษ 2 / FR-SC-06)
// ---------------------------------------------------------------------

export type AssignmentInput = {
  employee_id: string;
  role?: string | null;
};

export type EmployeeInput = {
  id: string;
  first_name?: string | null;
  nickname?: string | null;
  position?: string | null;
};

export type AssigneeSnapshotItem = {
  employee_id: string;
  /** บทบาทในการประเมิน (Form B แยกชุดคำถามหัวหน้า/ลูกทีม) */
  subject_role: "lead" | "member";
  name?: string;
  nickname?: string;
  position?: string;
};

/** map role ของ assignment → subject_role ของแบบประเมิน (lead = หัวหน้า, อื่น ๆ = member) */
function toSubjectRole(role: string | null | undefined): "lead" | "member" {
  return role === "lead" ? "lead" : "member";
}

/**
 * สร้าง snapshot รายชื่อผู้ดูแล ณ วัน trigger (บันทึกลง assignee_snapshot)
 *   - เก็บ employee_id + subject_role เป็นแกน temporal binding (ประเมินถูกคนแม้เปลี่ยนทีมภายหลัง)
 *   - enrich ชื่อ/ชื่อเล่น/ตำแหน่ง ณ ตอนนั้น (best-effort จาก employees ที่ส่งเข้ามา)
 *   - dedupe ตาม employee_id (ผู้ดูแลซ้ำในหลาย role → คงตัวแรก)
 */
export function buildAssigneeSnapshot(
  assignments: AssignmentInput[],
  employees: EmployeeInput[] = []
): AssigneeSnapshotItem[] {
  const empById = new Map(employees.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const out: AssigneeSnapshotItem[] = [];

  for (const a of assignments) {
    if (!a.employee_id || seen.has(a.employee_id)) continue;
    seen.add(a.employee_id);

    const emp = empById.get(a.employee_id);
    const item: AssigneeSnapshotItem = {
      employee_id: a.employee_id,
      subject_role: toSubjectRole(a.role),
    };
    if (emp?.first_name) item.name = emp.first_name;
    if (emp?.nickname) item.nickname = emp.nickname;
    if (emp?.position) item.position = emp.position;
    out.push(item);
  }

  return out;
}
