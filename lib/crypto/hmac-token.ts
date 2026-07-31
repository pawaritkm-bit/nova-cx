/**
 * โทเค็นแบบ signed (HMAC-SHA256) สำหรับ session/state ที่เก็บใน cookie
 *
 * รูปแบบ: `<base64url(json payload)>.<base64url(hmac)>`
 *   - payload เป็น JSON object; ควรมีฟิลด์ `exp` (epoch วินาที) เพื่อกำหนดอายุ
 *   - verify: ตรวจ signature แบบ constant-time (กัน timing attack) + ตรวจ exp
 *   - ทุกความล้มเหลว (รูปแบบผิด/ลายเซ็นไม่ตรง/หมดอายุ/parse ไม่ได้) → คืน null (fail-closed)
 *
 * ★ ความปลอดภัย: secret มาจาก env เท่านั้น (ไม่ฝังในโค้ด) — payload มองเห็นได้ (base64)
 *   จึงห้ามใส่ความลับใน payload; ใส่เฉพาะ id/role/exp ที่เปิดเผยได้ (แต่ปลอมไม่ได้)
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** เวลา epoch วินาทีปัจจุบัน */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** เซ็นโทเค็นจาก payload (object ต้อง JSON.stringify ได้) */
export function signToken(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * verify + parse โทเค็น — คืน payload (typed) หรือ null
 *   - ตรวจ signature ก่อน (constant-time) แล้วค่อย parse (ห้ามเชื่อ payload ที่ลายเซ็นไม่ตรง)
 *   - ถ้ามี `exp` (number) และเลยเวลาแล้ว → null
 */
export function verifyToken<T = Record<string, unknown>>(
  token: string | null | undefined,
  secret: string,
  now: number = nowSeconds()
): T | null {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp === "number" && now >= exp) return null;

  return payload as T;
}
