/**
 * เลขประจำตัวผู้เสียภาษี (tax_id) — normalize + validate (pure, ทดสอบได้)
 *
 * ใช้ตอนนักบัญชีกรอกเลขภาษีของลูกค้าที่ขาด (หน้า /chat-audit/accounting)
 *   - รับค่าที่พิมพ์มาแบบมีขีด/ช่องว่างได้ (เช่น "0-9940-00000-00-1")
 *   - strip เหลือแต่ตัวเลข แล้วต้องเป็น 13 หลักพอดี
 *   - ผิดรูป → null (ผู้เรียกแปลงเป็น error ไทย)
 *
 * ★ PDPA: เลขภาษีเป็นข้อมูลอ่อนไหว — โมดูลนี้ไม่ log ค่าใด ๆ
 */

/** ความยาวเลขภาษีไทยที่ถูกต้อง (13 หลัก) */
export const TAX_ID_LENGTH = 13;

/** เหลือเฉพาะตัวเลข (ตัดขีด/ช่องว่าง/อักขระอื่น) */
export function taxIdDigits(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\D/g, "") : "";
}

/**
 * normalize เลขภาษี → คืน 13 หลักที่ strip แล้ว หรือ null ถ้าไม่ครบ/เกิน
 *   (ไม่ตรวจ checksum — ข้อมูลบางส่วนจาก NOVA Sale อาจไม่สมบูรณ์ แต่ต้อง 13 หลัก)
 */
export function normalizeTaxId(raw: unknown): string | null {
  const digits = taxIdDigits(raw);
  return digits.length === TAX_ID_LENGTH ? digits : null;
}

/** true เมื่อเป็นเลขภาษี 13 หลักที่ถูกต้อง */
export function isValidTaxId(raw: unknown): boolean {
  return normalizeTaxId(raw) !== null;
}
