/**
 * งวดเปรียบเทียบ (comparative period) — pure ทั้งไฟล์ (ไม่แตะ DB)
 *
 * บริบท: เฟส 4 ส่วน M (docs/06-accounting-features-roadmap.md, หมวด 0.4) — โครงพื้นฐานที่ N (งบการเงิน
 *   ฉบับทางการ) ใช้เทียบงวด/ไตรมาส/ปีก่อนหน้า:
 *   - `resolveComparePeriod` shift งวดถอยหลังแบบทั่วไป ครอบคลุมทั้งเดือนเดียว/หลายเดือน/ไตรมาส
 *     (`prev_period` = ยาวเท่ากันกับงวดปัจจุบัน, `prev_year` = ปีก่อนหน้าเสมอไม่ว่างวดจะยาวเท่าไร)
 *   - `quarterRangeOf` เป็นแค่ "ปุ่มลัด" ตั้งงวดปัจจุบันให้เป็นไตรมาสปฏิทิน ไม่ใช่โหมดเทียบ (0.4)
 *
 * ★ เดือนทั้งหมดในไฟล์นี้เป็น "YYYY-MM" (ค.ศ.) — ตรงกับ report-filter.ts::validMonth เป๊ะ (reuse ตรง ๆ
 *   ไม่เขียน regex ซ้ำคู่ขนาน)
 */
import { validMonth } from "@/lib/accounting/report-filter";

export type ComparePeriodMode = "none" | "prev_period" | "prev_year" | "custom";

/** ช่วงงวด YYYY-MM (from/to รวมทั้งคู่ — inclusive) */
export type PeriodRange = { from: string; to: string };

/** แปลง "YYYY-MM" → {y, mo} (mo เริ่มที่ 1) — คืน null ถ้ารูปแบบผิด */
function parseMonth(m: string | null | undefined): { y: number; mo: number } | null {
  const v = validMonth(m);
  if (!v) return null;
  const [y, mo] = v.split("-").map(Number);
  return { y, mo };
}

/** เลขเดือน "สัมบูรณ์" นับจากปี ค.ศ. 0 (0-based) — ใช้บวก/ลบเดือนข้ามปีให้ถูกด้วยเลขจำนวนเต็มล้วน */
function monthIndex(y: number, mo: number): number {
  return y * 12 + (mo - 1);
}

function monthFromIndex(idx: number): string {
  // Math.floor หารด้วย 12 ปัดลงเสมอ (รองรับ idx ติดลบด้วย) → mo เหลือเศษ [0,11] เสมอ
  const y = Math.floor(idx / 12);
  const mo = idx - y * 12 + 1;
  return `${y.toString().padStart(4, "0")}-${mo.toString().padStart(2, "0")}`;
}

/**
 * จำนวนเดือนรวมของงวด from-to (inclusive) — เช่น 2569-01 ถึง 2569-03 = 3 เดือน
 *   คืน 0 ถ้ารูปแบบผิด หรือ from อยู่หลัง to (งวดไม่ถูกต้อง)
 */
export function periodLengthInMonths(from: string, to: string): number {
  const f = parseMonth(from);
  const t = parseMonth(to);
  if (!f || !t) return 0;
  const months = monthIndex(t.y, t.mo) - monthIndex(f.y, f.mo) + 1;
  return months > 0 ? months : 0;
}

/**
 * เลื่อนทั้งงวด (from,to) ถอยหลัง `months` เดือน (คงความยาวงวดเท่าเดิม) — จัดการข้ามปีถูกต้องเสมอ
 *   (รองรับ months ติดลบ = เลื่อนไปข้างหน้าด้วย แต่ในเฟสนี้ใช้แค่ถอยหลัง)
 *   คืน {from:"", to:""} ถ้า from/to รูปแบบผิด
 */
export function shiftPeriodBackward(from: string, to: string, months: number): PeriodRange {
  const f = parseMonth(from);
  const t = parseMonth(to);
  if (!f || !t) return { from: "", to: "" };
  return {
    from: monthFromIndex(monthIndex(f.y, f.mo) - months),
    to: monthFromIndex(monthIndex(t.y, t.mo) - months),
  };
}

/**
 * คำนวณ "งวดเทียบ" จากงวดปัจจุบัน + โหมดที่เลือก (0.4):
 *   - none        → ไม่เทียบ (null)
 *   - prev_period → งวดก่อนหน้าที่ "ยาวเท่ากัน" (shift ถอยหลังเท่าจำนวนเดือนของงวดปัจจุบัน)
 *   - prev_year   → งวดเดียวกัน ปีก่อนหน้า (shift ถอยหลัง 12 เดือนเสมอ ไม่ว่างวดจะยาวเท่าไร)
 *   - custom      → ใช้ค่าที่ผู้ใช้กรอกเอง (custom.from/custom.to) — validate รูปแบบเดือนก่อนเสมอ
 *   คืน null ถ้าคำนวณไม่ได้ (งวดปัจจุบันรูปแบบผิด/custom ไม่ครบ/ไม่ถูกรูปแบบ)
 */
export function resolveComparePeriod(
  current: PeriodRange,
  mode: ComparePeriodMode,
  custom?: { from?: string | null; to?: string | null }
): PeriodRange | null {
  if (mode === "none") return null;

  if (mode === "custom") {
    const f = validMonth(custom?.from);
    const t = validMonth(custom?.to);
    if (!f || !t) return null;
    return { from: f, to: t };
  }

  const length = periodLengthInMonths(current.from, current.to);
  if (length <= 0) return null;

  const shift = mode === "prev_year" ? 12 : length;
  const result = shiftPeriodBackward(current.from, current.to, shift);
  return result.from && result.to ? result : null;
}

/** ไตรมาสปฏิทิน 1-4 ของปี ค.ศ. ที่ระบุ → {from,to} (ปุ่มลัดตั้งงวดปัจจุบัน — ไม่ใช่โหมดเทียบ, 0.4) */
export function quarterRangeOf(ceYear: number, quarter: 1 | 2 | 3 | 4): PeriodRange {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const y = Math.trunc(ceYear).toString().padStart(4, "0");
  return {
    from: `${y}-${startMonth.toString().padStart(2, "0")}`,
    to: `${y}-${endMonth.toString().padStart(2, "0")}`,
  };
}
