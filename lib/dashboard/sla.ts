/**
 * SLA helpers สำหรับ escalation บน dashboard — ★ ฟังก์ชันบริสุทธิ์ (ไม่แตะ DB / ไม่เรียก Date.now เอง)
 *   - รับ `nowMs` เป็นพารามิเตอร์เสมอ → unit test ได้แน่นอน + ผู้เรียก (server component)
 *     เป็นคนกำหนดเวลา ณ ตอน render (ห้ามใช้ Date ใน worker/pure lib ที่ห้าม)
 *   - คำนวณสถานะ SLA ต่อเคส (เกิน/ใกล้ครบ/ปกติ/ไม่มี) + สรุปจำนวนเคสด่วน + จัดลำดับ urgency
 */

/** สถานะ SLA ของเคสเทียบเวลาปัจจุบัน */
export type SlaState = "overdue" | "due-soon" | "ok" | "none";

export type SlaStatus = {
  state: SlaState;
  /**
   * ชั่วโมง (ปัดขึ้นเป็นจำนวนเต็ม):
   *   - overdue = ชั่วโมงที่ "เกิน" กำหนดมาแล้ว
   *   - due-soon / ok = ชั่วโมงที่ "เหลือ" ก่อนครบกำหนด
   *   - none = null (ไม่มี sla_due_at)
   */
  hours: number | null;
};

/** เกณฑ์ "ใกล้ครบ SLA" — เหลือ ≤ 2 ชม. ถือว่าใกล้ครบ (ป้ายส้ม) */
export const SLA_DUE_SOON_HOURS = 2;

const MS_PER_HOUR = 3_600_000;

/**
 * คำนวณสถานะ SLA จาก sla_due_at เทียบ nowMs
 *   - sla_due_at ว่าง/parse ไม่ได้ → { state: "none", hours: null }
 *   - เลยกำหนดแล้ว (diff < 0) → overdue (hours = จำนวน ชม.ที่เกิน, ปัดขึ้น อย่างน้อย 1)
 *   - เหลือ ≤ dueSoonHours → due-soon
 *   - เหลือมากกว่านั้น → ok
 */
export function computeSlaStatus(
  slaDueAt: string | null | undefined,
  nowMs: number,
  dueSoonHours: number = SLA_DUE_SOON_HOURS
): SlaStatus {
  if (!slaDueAt) return { state: "none", hours: null };
  const dueMs = Date.parse(slaDueAt);
  if (!Number.isFinite(dueMs)) return { state: "none", hours: null };

  const diffMs = dueMs - nowMs;
  if (diffMs < 0) {
    // เกิน SLA — รายงานจำนวน ชม.ที่เกิน (ปัดขึ้น อย่างน้อย 1 ชม. เพื่อไม่แสดง "เกิน 0h")
    return { state: "overdue", hours: Math.max(1, Math.ceil(-diffMs / MS_PER_HOUR)) };
  }
  const hoursLeft = Math.ceil(diffMs / MS_PER_HOUR);
  if (diffMs <= dueSoonHours * MS_PER_HOUR) {
    return { state: "due-soon", hours: hoursLeft };
  }
  return { state: "ok", hours: hoursLeft };
}

/** ป้ายข้อความภาษาไทยสำหรับสถานะ SLA (ใช้แสดงบน badge) */
export function formatSlaLabel(status: SlaStatus): string {
  switch (status.state) {
    case "overdue":
      return `เกิน SLA ${status.hours}h`;
    case "due-soon":
    case "ok":
      return `เหลือ ${status.hours}h`;
    case "none":
    default:
      return "ไม่มี SLA";
  }
}

// ---------------------------------------------------------------------
// จัดลำดับความเร่งด่วน (urgency)
// ---------------------------------------------------------------------
/** ชนิดขั้นต่ำที่ helper ต้องใช้ (subset ของ CaseFactRow) */
export type CaseLike = {
  level: string;
  sla_due_at: string | null;
};

/** อันดับความรุนแรงของ level (ยิ่งน้อยยิ่งด่วน) — critical มาก่อน high */
function levelRank(level: string): number {
  const l = level.toLowerCase();
  if (l === "critical") return 0;
  if (l === "high") return 1;
  return 2;
}

/**
 * ตัวเปรียบเทียบเรียงเคสด่วนตาม urgency:
 *   1) เกิน SLA (overdue) มาก่อน
 *   2) critical ก่อน high
 *   3) sla_due_at ใกล้สุด (เร็วกว่า) มาก่อน — ไม่มี sla_due_at ไปท้ายสุด
 */
export function compareUrgency<T extends CaseLike>(
  a: T,
  b: T,
  nowMs: number
): number {
  const sa = computeSlaStatus(a.sla_due_at, nowMs);
  const sb = computeSlaStatus(b.sla_due_at, nowMs);

  // 1) overdue ก่อน
  const aOver = sa.state === "overdue" ? 0 : 1;
  const bOver = sb.state === "overdue" ? 0 : 1;
  if (aOver !== bOver) return aOver - bOver;

  // 2) critical ก่อน high
  const lr = levelRank(a.level) - levelRank(b.level);
  if (lr !== 0) return lr;

  // 3) sla_due_at ใกล้สุดก่อน (null = ท้ายสุด)
  const aDue = a.sla_due_at ? Date.parse(a.sla_due_at) : Number.POSITIVE_INFINITY;
  const bDue = b.sla_due_at ? Date.parse(b.sla_due_at) : Number.POSITIVE_INFINITY;
  return aDue - bDue;
}

// ---------------------------------------------------------------------
// สรุปเคสด่วน (escalation summary) สำหรับแถบแจ้งเตือน
// ---------------------------------------------------------------------
export type EscalationSummary = {
  /** จำนวนเคสด่วนทั้งหมด (critical + high ที่ยังเปิดอยู่) */
  total: number;
  critical: number;
  high: number;
  /** จำนวนที่เกิน SLA แล้ว */
  overdue: number;
};

/**
 * สรุปจำนวนเคสด่วนจากรายการเคส (ต้องเป็นเคส critical/high ที่ยังเปิดอยู่แล้ว
 * — ผู้เรียกกรอง status ปิดออกก่อน). นับ overdue เทียบ nowMs
 */
export function summarizeEscalation<T extends CaseLike>(
  cases: T[],
  nowMs: number
): EscalationSummary {
  let critical = 0;
  let high = 0;
  let overdue = 0;
  for (const c of cases) {
    const l = c.level.toLowerCase();
    if (l === "critical") critical += 1;
    else if (l === "high") high += 1;
    if (computeSlaStatus(c.sla_due_at, nowMs).state === "overdue") overdue += 1;
  }
  return { total: critical + high, critical, high, overdue };
}
