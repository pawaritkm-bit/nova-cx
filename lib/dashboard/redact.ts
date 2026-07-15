/**
 * Redaction เชิงป้องกัน (defense-in-depth) สำหรับข้อมูล feedback ที่ส่งถึงผู้ถูกประเมิน
 *   - ชั้นหลักการซ่อนชื่อลูกค้าอยู่ที่ view (0025 v_feedback_for_evaluatee ตัดคอลัมน์ออกแล้ว)
 *   - ชั้นนี้เป็น "safety net" ฝั่งแอป: ถ้ามีคีย์ PII หลุดมาใน object จะถูกตัดทิ้ง
 *     (กันเคสเผลอ join ตารางอื่น/เปลี่ยน view ในอนาคตแล้ว leak)
 *   - ฟังก์ชันบริสุทธิ์ — unit test ได้ทันที
 */

/** คีย์ที่ถือว่าเป็น PII/ชื่อลูกค้า ต้องไม่ปรากฏต่อผู้ถูกประเมิน */
export const PII_KEYS = [
  "customer_id",
  "customer_name",
  "customer_code",
  "name",
  "business_name",
  "phone",
  "phone_enc",
  "email",
  "email_enc",
  "contact_name",
  "line_user_id",
  "display_name",
] as const;

const PII_KEY_SET = new Set<string>(PII_KEYS);

/** true ถ้า key เป็น PII (เทียบแบบ case-insensitive) */
export function isPiiKey(key: string): boolean {
  return PII_KEY_SET.has(key.toLowerCase());
}

/** ตัดคีย์ PII ออกจาก object เดียว (คืน object ใหม่ ไม่ mutate ตัวเดิม) */
export function redactFeedbackRow<T extends Record<string, unknown>>(
  row: T
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isPiiKey(key)) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

/** ตัดคีย์ PII ออกจากทั้ง array */
export function redactFeedbackRows<T extends Record<string, unknown>>(
  rows: T[]
): Partial<T>[] {
  return rows.map(redactFeedbackRow);
}

/** ตรวจว่ามีคีย์ PII หลงเหลืออยู่ใน object หรือไม่ (ใช้ใน test/assertion) */
export function hasPii(row: Record<string, unknown>): boolean {
  return Object.keys(row).some(isPiiKey);
}
