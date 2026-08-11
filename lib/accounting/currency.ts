/**
 * สกุลเงินต่างประเทศ + อัตราแลกเปลี่ยน — pure ทั้งไฟล์ (ไม่แตะ DB/network)
 *
 * บริบท: เฟส 10 (docs/06-accounting-features-roadmap.md, 0.3/0.4/0.6/0.11) — รองรับบิล/CN-DN/รับ-จ่ายเงิน
 *   เป็นสกุลเงินต่างประเทศ แล้วแปลงเป็น THB เก็บเป็นฟิลด์แยก (mirror `unit_cost` เฟส 8 — "compute at
 *   recording layer, store derived THB field") — ไฟล์นี้เป็น building block เดียวที่ทุกจุด derive/validate
 *   ใช้ร่วมกัน (0.6: กันสูตรคู่ขนาน)
 *
 * ★ currency เก็บเป็น ISO 4217 code (text 3 ตัวอักษรพิมพ์ใหญ่) — ไม่ hardcode รายชื่อตายตัว/ไม่ผูก enum
 *   (0.3) — validate รูปแบบเท่านั้น
 * ★ validateFxRate = hard-block (ปฏิเสธเสมอ) · fxRatePlausibilityWarning = soft-warn (แค่เตือน ไม่บล็อก) (0.11)
 */

/** สกุลเงิน ISO 4217 — text 3 ตัวอักษรพิมพ์ใหญ่ (0.3) */
export function isValidCurrencyCode(v: unknown): v is string {
  return typeof v === "string" && /^[A-Z]{3}$/.test(v);
}

/** ตัวเลือกสกุลเงินที่พบบ่อย (~20 สกุล) สำหรับ combobox — ไม่ใช่ลิสต์ตายตัวที่ block สกุลอื่น (0.3) */
export const COMMON_CURRENCIES: { code: string; label: string }[] = [
  { code: "USD", label: "USD — ดอลลาร์สหรัฐ" },
  { code: "EUR", label: "EUR — ยูโร" },
  { code: "GBP", label: "GBP — ปอนด์สเตอร์ลิง" },
  { code: "JPY", label: "JPY — เยนญี่ปุ่น" },
  { code: "CNY", label: "CNY — หยวนจีน" },
  { code: "SGD", label: "SGD — ดอลลาร์สิงคโปร์" },
  { code: "HKD", label: "HKD — ดอลลาร์ฮ่องกง" },
  { code: "AUD", label: "AUD — ดอลลาร์ออสเตรเลีย" },
  { code: "MYR", label: "MYR — ริงกิตมาเลเซีย" },
  { code: "KRW", label: "KRW — วอนเกาหลีใต้" },
  { code: "TWD", label: "TWD — ดอลลาร์ไต้หวัน" },
  { code: "INR", label: "INR — รูปีอินเดีย" },
  { code: "IDR", label: "IDR — รูเปียห์อินโดนีเซีย" },
  { code: "PHP", label: "PHP — เปโซฟิลิปปินส์" },
  { code: "VND", label: "VND — ดองเวียดนาม" },
  { code: "CHF", label: "CHF — ฟรังก์สวิส" },
  { code: "CAD", label: "CAD — ดอลลาร์แคนาดา" },
  { code: "NZD", label: "NZD — ดอลลาร์นิวซีแลนด์" },
  { code: "SEK", label: "SEK — โครนาสวีเดน" },
  { code: "AED", label: "AED — ดีแรห์มสหรัฐอาหรับเอมิเรตส์" },
];

/** ผลตรวจ (pure) — hard-block */
export type FxRateValidation = { ok: true; value: number } | { ok: false; message: string };

/**
 * validate อัตราแลกเปลี่ยนที่กรอกเอง (hard-block, 0.11) — ปฏิเสธเสมอถ้า:
 *   - ไม่ใช่ตัวเลข (NaN/string ไม่ใช่เลข)
 *   - fx_rate <= 0
 *   - fx_rate > 100000 (ไม่มีสกุลที่ ธปท. ประกาศเคยเกินหลักหมื่นต่อ 1 บาท — กันพิมพ์เกินหลักสิบ/ร้อยเท่า)
 */
export function validateFxRate(v: unknown): FxRateValidation {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return { ok: false, message: "อัตราแลกเปลี่ยนต้องเป็นตัวเลข" };
  if (n <= 0) return { ok: false, message: "อัตราแลกเปลี่ยนต้องมากกว่า 0" };
  if (n > 100000) return { ok: false, message: "อัตราแลกเปลี่ยนสูงเกินไป (เกิน 100,000) — ตรวจว่าพิมพ์ผิดหลักหรือไม่" };
  return { ok: true, value: n };
}

/**
 * ช่วงอัตราแลกเปลี่ยนคร่าว ๆ ของสกุลที่พบบ่อย (ไม่ใช่ real-time rate — กว้างพอรับความผันผวนจริง)
 *   ใช้เตือน (soft-warn) เท่านั้น — สกุลไม่มีในตารางนี้ = ไม่เตือนเลย (ไม่มีข้อมูลอ้างอิง ไม่เดา, 0.11)
 */
const PLAUSIBLE_RANGE: Record<string, { min: number; max: number }> = {
  USD: { min: 25, max: 45 },
  EUR: { min: 30, max: 55 },
  GBP: { min: 35, max: 60 },
  JPY: { min: 0.15, max: 0.35 },
  CNY: { min: 3.5, max: 7 },
  SGD: { min: 20, max: 32 },
  AUD: { min: 18, max: 30 },
  HKD: { min: 3, max: 6 },
  KRW: { min: 0.02, max: 0.04 },
};

/**
 * เตือน (ไม่ block) ว่าอัตราที่กรอกดูผิดปกติเทียบสกุลนั้น (soft-warn, 0.11) — คืน null = ไม่เตือน
 *   (สกุลนอกตาราง / ค่าอยู่ในช่วงปกติ)
 */
export function fxRatePlausibilityWarning(currency: string, rate: number): string | null {
  const range = PLAUSIBLE_RANGE[currency];
  if (!range) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (rate >= range.min && rate <= range.max) return null;
  return `อัตราแลกเปลี่ยน ${rate} ดูผิดปกติสำหรับ ${currency} (ช่วงปกติทั่วไปประมาณ ${range.min}-${range.max}) — ตรวจสอบก่อนบันทึก`;
}

/** ปัดทศนิยม 2 ตำแหน่ง (กัน floating error สะสม — เหมือน round2 ของ queries.ts) */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * แปลงยอดสกุลต่างประเทศ → THB (0.6/0.8) — จุดเดียวที่ทุกไฟล์ derive THB จาก fx ใช้ร่วมกัน (กันสูตรคู่ขนาน)
 *   ค่าที่ไม่ใช่ตัวเลข/ติดลบ → ปฏิบัติเป็น 0
 */
export function deriveThbAmount(fxAmount: number, fxRate: number): number {
  const a = Number.isFinite(fxAmount) && fxAmount > 0 ? fxAmount : 0;
  const r = Number.isFinite(fxRate) && fxRate > 0 ? fxRate : 0;
  return round2(a * r);
}

/** รหัสบัญชี GL "กำไร(ขาดทุน)จากอัตราแลกเปลี่ยน" ที่เสนอเป็นค่าเริ่มต้น (0.4) — ไม่ hardcode mapping ตายตัว
 *   นักบัญชีเปลี่ยนบัญชีที่ใช้ต่อรายการได้ทุกครั้งตอนสร้าง JV แนะนำ */
export const DEFAULT_FX_GAIN_LOSS_ACCOUNT_CODE = "4025";
