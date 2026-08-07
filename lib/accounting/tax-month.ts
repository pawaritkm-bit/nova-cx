/**
 * "ยื่น/ใช้ ภาษีในเดือน" (input VAT ยกเดือน) — helper คำนวณเดือน (pure, ทดสอบได้)
 *
 * บริบท: บิลซื้อยกภาษีซื้อไปใช้เดือนถัดไปได้ (ตามกฎหมาย ≤ 6 เดือน) → inputTaxMonth ('YYYY-MM').
 *   effectiveTaxMonth (queries.ts) = inputTaxMonth ?? เดือนของ doc_date.
 *
 * ★ รวม logic ที่เดิมกระจายใน EntryEditor / vat-report ไว้ที่เดียว (ใช้ร่วม + เทสต์ได้)
 * ★ pure ล้วน · PDPA: ไม่ log อะไร
 */
import { monthBounds, effectiveTaxMonth } from "@/lib/accounting/queries";

const YM_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** ชื่อเดือนสั้นไทย (index 0-11) */
const TH_MONTHS_SHORT = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

/** 'YYYY-MM' (ค.ศ.) → 'ก.ค. 2569' (พ.ศ.) · คืนค่าเดิมถ้ารูปแบบพัง */
export function taxMonthLabel(ym: string): string {
  const m = YM_RE.exec(ym);
  if (!m) return ym;
  return `${TH_MONTHS_SHORT[Number(m[2]) - 1] ?? m[2]} ${Number(m[1]) + 543}`;
}

/**
 * ตัวเลือกเดือนที่ใช้ภาษีซื้อ = เดือนฐาน (YYYY-MM ค.ศ.) + `ahead` เดือนถัดไป (รวมเดือนฐาน)
 *   default ahead=6 → คืน 7 เดือน (เดือนบิล + 6 เดือนถัดไป ตามเพดานยกภาษีซื้อ)
 *   คืน [] ถ้า baseYm รูปแบบพัง (บิลยังไม่ลงวันที่ + ไม่ระบุเดือน)
 */
export function taxMonthOptions(baseYm: string, ahead = 6): string[] {
  const m = YM_RE.exec(baseYm);
  if (!m) return [];
  let y = Number(m[1]);
  let mo = Number(m[2]);
  const out: string[] = [];
  for (let i = 0; i <= ahead; i++) {
    out.push(`${y}-${String(mo).padStart(2, "0")}`);
    mo++;
    if (mo > 12) { mo = 1; y++; }
  }
  return out;
}

/** เลื่อนเดือน 'YYYY-MM' ไป delta เดือน (delta ติดลบ = ย้อนหลัง) · คืนค่าเดิมถ้าพัง */
export function shiftMonth(ym: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  let y = Number(m[1]);
  let mo = Number(m[2]) + delta;
  while (mo < 1) { mo += 12; y -= 1; }
  while (mo > 12) { mo -= 12; y += 1; }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

/**
 * ขอบล่างของ doc_date ที่ต้องดึง เพื่อครอบบิลซื้อที่ "ยกเดือน" มาใช้ในช่วงที่เลือก
 *   = วันแรกของเดือน (startMonth - 6) · fallback (เช่น startMonth พัง) = ค่า fallback ที่ส่งมา
 *   ★ ใช้ร่วมกับรายงานภาษีซื้อ / สมุดรายวันซื้อ — ดึงกว้างแล้วค่อยกรองด้วย effectiveTaxMonth
 */
export function purchaseFetchLowerBound(startMonth: string, fallback: string): string {
  return monthBounds(shiftMonth(startMonth, -6))?.first ?? fallback;
}

/**
 * คัดเฉพาะบิลที่ "เดือนที่ใช้ภาษี" (effectiveTaxMonth) อยู่ในช่วง [startMonth, endMonth] (inclusive)
 *   ★ pure — ใช้กับบิลซื้อเพื่อให้บิลที่ยกเดือนไปโผล่ในเดือนที่ยื่นจริง (สอดคล้องรายงานภาษีซื้อ)
 *   ★ บิลที่ effectiveTaxMonth = null (ยังไม่ลงวันที่ + ไม่ระบุเดือน) → ตัดออก
 */
export function filterPurchaseByTaxMonth<
  T extends { inputTaxMonth?: string | null; docDate: string | null }
>(entries: T[], startMonth: string, endMonth: string): T[] {
  return entries.filter((e) => {
    const tm = effectiveTaxMonth(e);
    return tm != null && tm >= startMonth && tm <= endMonth;
  });
}
