/**
 * ค่าคงที่ (config) สำหรับงบกระแสเงินสด (Cash Flow Statement, Direct Method) — pure ทั้งไฟล์
 *   mirror statement-config.ts (แก้ง่ายที่เดียว)
 *
 * บริบท: เฟส 4 ส่วน O (docs/06-accounting-features-roadmap.md, หมวด 0.6/0.7)
 *   - cash pool = "เงินสดและรายการเทียบเท่าเงินสด" ของ tenant นั้น (คำนวณจากผังจริง ไม่ hardcode
 *     เลขบัญชีธนาคารตรง ๆ เพราะ tenant เพิ่มบัญชีธนาคารเองได้ตั้งแต่เฟส 1)
 *   - investing/financing codes = รหัสบัญชีมาตรฐานที่ผังกลาง seed ไว้ (migration 0063) — ถ้า tenant
 *     เพิ่มบัญชีสินทรัพย์ถาวร/เงินกู้ใหม่นอกชุดนี้เอง จะ fallback เป็น operating (0.7 [⚠️ FLAG])
 */
import { bankAccountCodesOf, type ChartAccount } from "@/lib/accounting/chart-of-accounts";

/** รหัสเงินสด (1010) + เงินสดย่อย (1015) — ส่วนคงที่ของ cash pool (0.6) */
export const CASH_POOL_STATIC_CODES: string[] = ["1010", "1015"];

/**
 * รหัสบัญชี "เงินสดและรายการเทียบเท่าเงินสด" ทั้งหมดของ tenant (0.6):
 *   {1010, 1015} ∪ ทุกรหัสที่ is_bank=true ในผังของ tenant นั้น (bankAccountCodesOf เดิมจากเฟส 1)
 *   ★ 1160 (บัตรเครดิต) ไม่รวม — เป็นยอดรอเคลียร์ ไม่ใช่เงินสดพร้อมใช้จริง (fallback → operating)
 */
export function cashPoolCodesOf(chart: ChartAccount[]): string[] {
  return [...new Set([...CASH_POOL_STATIC_CODES, ...bankAccountCodesOf(chart)])];
}

/** รหัสนี้อยู่ใน cash pool ของ tenant ไหม */
export function isCashPoolCode(chart: ChartAccount[], code: string): boolean {
  return cashPoolCodesOf(chart).includes(code);
}

/**
 * รหัสสินทรัพย์ถาวร (0.7) — ที่ดิน(1610)/อาคาร(1615)/อุปกรณ์สำนักงาน(1640)/รถยนต์(1645)
 *   ★ เดิมไม่รวมรหัสค่าเสื่อมสะสม (`.1`) เพราะรายการค่าเสื่อมราคาปกติ (Dr ค่าเสื่อม / Cr ค่าเสื่อมสะสม)
 *   ไม่มีขาไหนแตะเงินสดอยู่แล้ว (ยังไม่ปรากฏใน CF เหมือนเดิม ไม่เปลี่ยน) — เฟส 7 (docs/06, 0.10) เพิ่ม
 *   `1615.1`/`1640.1`/`1645.1` เข้ามาเพราะ**รายการจำหน่ายทรัพย์สิน**มีขาเงินสดจริง (`proceeds`) พร้อมขา
 *   ค่าเสื่อมสะสมที่ต้องจัดเป็น "ลงทุน" คู่กับขาสินทรัพย์เดิมด้วย ไม่ให้ตกไปเป็น operating ผิดประเภท
 */
export const INVESTING_CODES: string[] = ["1610", "1615", "1615.1", "1640", "1640.1", "1645", "1645.1"];

/**
 * รหัสกิจกรรมจัดหาเงิน (0.7) — ทุนเรือนหุ้น(3010)/หุ้นกู้(2110)/เงินปันผลค้างจ่าย(2035 — มีผลเฉพาะตอน
 *   "จ่ายจริง" ที่มีบรรทัดแตะเงินสดเท่านั้น การตั้งพักหนี้ปันผลเองไม่แตะเงินสด จึงไม่เข้า CF อยู่แล้ว)
 */
export const FINANCING_CODES: string[] = ["3010", "2110", "2035"];

export type CashFlowActivity = "operating" | "investing" | "financing";

/**
 * จัดกิจกรรมกระแสเงินสดของรหัสบัญชี (0.7) — ทุกรหัสอื่นที่ไม่อยู่ 2 ชุดข้างบน (รวม AR/AP/VAT/WHT/
 *   รายได้/ค่าใช้จ่ายทั้งหมด) → operating (ค่าเริ่มต้น fallback)
 */
export function classifyCashFlowActivity(code: string): CashFlowActivity {
  if (INVESTING_CODES.includes(code)) return "investing";
  if (FINANCING_CODES.includes(code)) return "financing";
  return "operating";
}
