import { addBusinessHours, computeSlaDueAt, type CaseLevel } from "@/lib/ai/case";

/**
 * SLA rule engine (Phase 3) — ★ ฟังก์ชันบริสุทธิ์ (ไม่แตะ DB / รับ now เป็น argument)
 *   - selectSlaRule : เลือก rule ที่ match บริบทเคส ตาม priority (config-driven)
 *   - computeSlaDue : คำนวณกำหนดตอบครั้งแรก + ปิดงาน ด้วยเวลาทำการเดิม (lib/ai/case.ts)
 *
 * scope matching: field ใน rule เป็น null = "match ทั้งหมด" (wildcard)
 *   priority สูงกว่าถูกเลือกก่อน; เท่ากันใช้ rule ที่เจาะจงกว่า (scope non-null มากกว่า)
 *
 * fallback (ไม่มี rule match): ใช้ default เท่าเดิมใน case.ts
 *   - critical : ตอบใน 4 ชม.ทำการ / ปิดใน 8 ชม.ทำการ
 *   - high     : ตอบภายในสิ้นวันทำการ / ปิดใน 16 ชม.ทำการ (~2 วันทำการ)
 */

export type SlaRule = {
  id: string;
  customer_type: string | null;
  urgency: string | null;
  work_type: string | null;
  team_id: string | null;
  first_response_minutes: number | null;
  resolution_minutes: number | null;
  priority: number;
  is_active: boolean;
};

export type SlaMatchContext = {
  customerType?: string | null;
  urgency?: string | null;
  workType?: string | null;
  teamId?: string | null;
};

/** จำนวน scope field ที่ไม่ null (ยิ่งมาก = rule เจาะจงกว่า) */
function specificity(r: SlaRule): number {
  return [r.customer_type, r.urgency, r.work_type, r.team_id].filter(
    (v) => v !== null && v !== undefined
  ).length;
}

/** rule จะ match เมื่อทุก scope field เป็น null (wildcard) หรือตรงกับบริบท */
function ruleMatches(r: SlaRule, ctx: SlaMatchContext): boolean {
  if (!r.is_active) return false;
  const ok = (field: string | null, val: string | null | undefined) =>
    field === null || field === undefined || field === (val ?? null);
  return (
    ok(r.customer_type, ctx.customerType ?? null) &&
    ok(r.urgency, ctx.urgency ?? null) &&
    ok(r.work_type, ctx.workType ?? null) &&
    ok(r.team_id, ctx.teamId ?? null)
  );
}

/** เลือก rule ที่ match ตาม priority (สูงก่อน) → เจาะจงกว่าก่อน; ไม่มี = null */
export function selectSlaRule(rules: SlaRule[], ctx: SlaMatchContext): SlaRule | null {
  const matched = rules.filter((r) => ruleMatches(r, ctx));
  if (matched.length === 0) return null;
  matched.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return specificity(b) - specificity(a);
  });
  return matched[0];
}

export type SlaDue = {
  firstResponseDueAt: Date;
  resolutionDueAt: Date;
};

/** default resolution (ชม.ทำการ) ตามระดับ เมื่อไม่มี rule match */
const DEFAULT_RESOLUTION_HOURS: Record<CaseLevel, number> = {
  critical: 8,
  high: 16,
};

/**
 * คำนวณกำหนด SLA (ตอบครั้งแรก + ปิดงาน) — คิดบนเวลาทำการ (จ–ศ 9–18 Asia/Bangkok)
 *   - มี rule (มี minutes) → บวกนาทีทำการจาก rule
 *   - ไม่มี rule → fallback default ตาม level (เท่าเดิมใน case.ts)
 */
export function computeSlaDue(rule: SlaRule | null, level: CaseLevel, now: Date): SlaDue {
  let firstResponseDueAt: Date;
  let resolutionDueAt: Date;

  if (rule && (rule.first_response_minutes != null || rule.resolution_minutes != null)) {
    const frMin = rule.first_response_minutes ?? rule.resolution_minutes ?? 0;
    const resMin = rule.resolution_minutes ?? rule.first_response_minutes ?? 0;
    firstResponseDueAt = addBusinessHours(now, frMin / 60);
    resolutionDueAt = addBusinessHours(now, resMin / 60);
  } else {
    firstResponseDueAt = computeSlaDueAt(level, now);
    resolutionDueAt = addBusinessHours(now, DEFAULT_RESOLUTION_HOURS[level]);
  }

  // L1: กัน misconfig (ตอบช้ากว่าปิด) — first-response ต้องไม่เกินกำหนดปิดงาน
  if (firstResponseDueAt.getTime() > resolutionDueAt.getTime()) {
    firstResponseDueAt = resolutionDueAt;
  }
  return { firstResponseDueAt, resolutionDueAt };
}
