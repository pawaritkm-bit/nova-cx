/**
 * รายงาน ภธ.40 (ภาษีธุรกิจเฉพาะ / Specific Business Tax) — ตัวคำนวณ (pure, เทสต์ได้)
 *
 * ★★ สมมติฐานบัญชี (ต้องให้นักบัญชียืนยัน) ★★
 *   1) ภาษีธุรกิจเฉพาะ (ภธ.40) ใช้กับ "บางกิจการ" เท่านั้น (ธนาคาร/ไฟแนนซ์/อสังหาริมทรัพย์/
 *      โรงรับจำนำ/ประกันชีวิต/ขายหลักทรัพย์ ฯลฯ) — ธุรกิจทั่วไป "ไม่ต้องยื่น".
 *      → ระบบไม่ตัดสินเองว่าลูกค้ารายไหนต้องยื่น: หน้าจอเปิดให้ทุกราย แต่ให้ "นักบัญชีเป็นคนตัดสิน".
 *   2) "ฐานภาษี" (base) ของ ภธ.40 = รายรับตามเกณฑ์เฉพาะของกิจการนั้น (เช่น ดอกเบี้ย/กำไรจากการขาย ฯลฯ)
 *      ซึ่ง "ไม่จำเป็นต้องเท่ากับรายได้จากการขายในสมุดบัญชี". Phase 1 จึงให้ฐาน "กรอก/แก้ได้"
 *      โดยตั้งค่าเริ่มต้น (default) = รายได้ฝั่งขายก่อน VAT ของเดือนนั้น (หรือ 0) เป็นเพียงจุดเริ่ม
 *      → ★ นักบัญชีต้องยืนยัน/แก้ฐานให้ตรงนิยาม ภธ.40 ของกิจการ.
 *   3) อัตรา = ภาษีธุรกิจเฉพาะ 3% + ภาษีท้องถิ่น 10% ของ SBT = รวม 3.3% ของฐาน
 *      (สอดคล้องกับสูตรวงแชร์ในระบบ: (ΣG+ΣI) × 3.3%).
 *
 * ★ pure ล้วน (ไม่แตะ DB/network) · PDPA: ไม่ log ฐาน/ตัวเลข
 */
import { round2, summarizeEntries, type BillEntry } from "@/lib/accounting/queries";

/** อัตราภาษีธุรกิจเฉพาะ (3%) */
export const SBT_RATE = 0.03;
/** อัตราภาษีท้องถิ่น (10% ของ SBT) */
export const LOCAL_TAX_RATE = 0.1;

/** ผลคำนวณ ภธ.40 ต่อฐาน 1 ก้อน */
export type SbtCalc = {
  /** ฐานภาษี (รายรับตามเกณฑ์เฉพาะ) */
  base: number;
  /** ภาษีธุรกิจเฉพาะ = ฐาน × 3% */
  sbt: number;
  /** ภาษีท้องถิ่น = SBT × 10% */
  localTax: number;
  /** รวมที่ต้องนำส่ง = SBT + ภาษีท้องถิ่น (= ฐาน × 3.3%) */
  total: number;
};

/** แปลงค่าเป็นเลขจำกัด (null/NaN/ติดลบ → clamp) */
function safeBase(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * คำนวณ ภธ.40 จากฐาน — SBT 3% + ภาษีท้องถิ่น 10% ของ SBT (รวม 3.3%)
 *   ปัด 2 ตำแหน่งทุกชั้น (กัน floating error) · ฐานติดลบ/ไม่ใช่ตัวเลข → 0
 */
export function calcSbt(base: number): SbtCalc {
  const b = round2(safeBase(base));
  const sbt = round2(b * SBT_RATE);
  const localTax = round2(sbt * LOCAL_TAX_RATE);
  const total = round2(sbt + localTax);
  return { base: b, sbt, localTax, total };
}

/**
 * ฐานเริ่มต้น (default) = รายได้ฝั่งขายก่อน VAT ของ entries ที่ส่งเข้ามา
 *   ★ เป็นเพียงค่าเริ่มต้นให้กรอกต่อ — ไม่ใช่ฐาน ภธ.40 ที่ถูกต้องเสมอ (ดูสมมติฐานข้อ 2)
 *   ผู้เรียกควรกรอง customer + month มาก่อน (ผ่าน listEntries)
 */
export function defaultSbtBase(entries: BillEntry[]): number {
  const { sale } = summarizeEntries(entries);
  return round2(sale.amount);
}
