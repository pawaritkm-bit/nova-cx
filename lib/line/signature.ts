import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ตรวจลายเซ็น webhook ของ LINE (x-line-signature)
 *   LINE เซ็น raw request body ด้วย HMAC-SHA256 โดยใช้ channel secret ของ OA นั้น
 *   แล้ว base64 → ส่งมาใน header `x-line-signature`
 *   เราต้องคำนวณเองแล้วเทียบแบบ timing-safe (กัน timing attack)
 *
 * pure function (ไม่พึ่ง env / network) → unit test ได้ทันที
 *
 * @param channelSecret  secret ของ OA (จาก env เท่านั้น)
 * @param rawBody        request body ดิบ (string — ต้องเป็น bytes เดียวกับที่ LINE ส่ง)
 * @param signature      ค่าใน header x-line-signature
 * @returns true เมื่อ signature ถูกต้อง
 */
export function verifyLineSignature(
  channelSecret: string,
  rawBody: string,
  signature: string | null | undefined
): boolean {
  if (!channelSecret || !signature) return false;

  const expected = createHmac("sha256", channelSecret)
    .update(rawBody, "utf8")
    .digest("base64");

  // เทียบแบบ timing-safe — ต้องยาวเท่ากันก่อน ไม่งั้น timingSafeEqual จะ throw
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;

  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
