import { redactText, hasResidualPii, PII_PLACEHOLDER } from "./redact";

/**
 * PII Redaction สำหรับ "แชตดิบ" (Phase 2) — PII หนากว่า survey
 *   ★ แยกไฟล์จาก redact.ts ของ survey (ไม่แตะ redact เดิม กัน regress)
 *   เสริม pattern เฉพาะแชต: เลขบัญชีธนาคาร / ที่อยู่ / ยอดเงิน
 *   ต่อยอดจาก redactText เดิม (อีเมล/เลขภาษี/เบอร์/ชื่อคำนำหน้า/ชื่อที่รู้จัก)
 *
 * หลักการ: redact base ก่อน (เบอร์/เลขภาษี 13 หลักถูกกินไปแล้ว) → ค่อยจับ pattern แชต
 *   เพื่อไม่ให้เลขบัญชีไปตัดเลขภาษี/เบอร์ผิดลำดับ
 */

export const CHAT_PII_PLACEHOLDER = {
  bankAccount: "[เลขบัญชี]",
  amount: "[จำนวนเงิน]",
  address: "[ที่อยู่]",
} as const;

// เลขบัญชีธนาคารไทย: 10–12 หลัก (อาจมีขีด/เว้นวรรค) — จับหลัง base redact
//   เช่น 123-4-56789-0 , 1234567890 , 012-3-45678-9
const BANK_ACCOUNT_RE = /\b\d(?:[-\s]?\d){9,11}\b/g;

// ยอดเงิน: ตัวเลข(มี , คั่นหลักพันหรือทศนิยม) ตามด้วยหน่วยเงิน บาท/บ./THB/฿
//   เช่น 12,500 บาท , 3500.50 บ. , ฿1,000
const AMOUNT_RE =
  /(?:฿\s?\d[\d,]*(?:\.\d+)?)|(?:\d[\d,]*(?:\.\d+)?\s?(?:บาท|บ\.|thb|฿))/gi;

// ที่อยู่ (คร่าว ๆ): คำนำที่อยู่ไทย + ข้อความตามหลังจนสุดบรรทัด/จุด
//   เช่น "บ้านเลขที่ 99/1 หมู่ 2 ต.บางรัก" , "ที่อยู่ 12 ถนนสุขุมวิท"
const ADDRESS_RE =
  /(?:บ้านเลขที่|ที่อยู่|เลขที่)\s?\d[^\n]{0,80}?(?=(?:[.\n])|$)/g;

/**
 * redact ข้อความแชต 1 ท่อน
 * @param input ข้อความดิบ
 * @param knownNames ชื่อที่ระบบรู้ (ลูกค้า/ธุรกิจ/พนักงาน) แทนตรงตัว
 */
export function redactChatText(input: string, knownNames: string[] = []): string {
  if (typeof input !== "string" || input.length === 0) return input ?? "";

  // 1) base redact (email/tax13/phone/ชื่อ) — ใช้ของ survey ตรง ๆ
  let text = redactText(input, knownNames).text;

  // 2) เสริม pattern แชต (ตามลำดับ: ที่อยู่ → ยอดเงิน → เลขบัญชี)
  //    ที่อยู่ก่อน เพราะภายในอาจมีเลขที่ไปโดน bank account จับผิด
  text = text.replace(ADDRESS_RE, CHAT_PII_PLACEHOLDER.address);
  text = text.replace(AMOUNT_RE, CHAT_PII_PLACEHOLDER.amount);
  text = text.replace(BANK_ACCOUNT_RE, CHAT_PII_PLACEHOLDER.bankAccount);

  return text;
}

/**
 * ตรวจ residual PII หลัง redact สำหรับแชต — รวม base (เบอร์/อีเมล/เลขภาษี)
 *   + เลขบัญชี/เลขยาวที่ยังหลุด (fail-safe: หลุด = บล็อกไม่ส่ง AI ภายนอก)
 */
export function hasResidualChatPii(text: string): boolean {
  if (typeof text !== "string") return false;
  if (hasResidualPii(text)) return true;
  // เลขยาว 10+ หลักที่ยังหลง (เลขบัญชี/เลขอ้างอิงที่อาจเป็น PII)
  const longDigits = /\b\d(?:[-\s]?\d){9,}\b/;
  return longDigits.test(text);
}

export { PII_PLACEHOLDER };
