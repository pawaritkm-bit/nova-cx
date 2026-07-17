import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * ตัวช่วยตอบกลับ error อย่างปลอดภัย (Reviewer 🟠#4)
 *   - ไม่คืน e.message / DB error ดิบสู่ client (กันรั่วโครงสร้าง DB)
 *   - log ฝั่ง server พร้อม request id เพื่อสืบย้อน
 */

export function newRequestId(): string {
  return randomUUID();
}

/**
 * เทียบ string แบบ constant-time (กัน timing attack) — ใช้กับ secret/token
 *   - ยาวไม่เท่ากัน → false ทันที (timingSafeEqual จะ throw ถ้า buffer คนละยาว)
 *   - helper กลางให้ cron/webhook เทียบ secret แบบสม่ำเสมอ
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * ตรวจ Bearer secret ของ cron แบบ constant-time (fail-closed)
 *   - ไม่มี header authorization → false
 *   - เทียบ `Bearer <secret>` แบบ timing-safe
 *   ผู้เรียกต้องเช็ค `secret` ว่าตั้งค่าแล้วเอง (ไม่ตั้ง → ปิด endpoint 503)
 */
export function isValidCronAuth(
  authHeader: string | null,
  secret: string
): boolean {
  if (!authHeader) return false;
  return constantTimeEqual(authHeader, `Bearer ${secret}`);
}

/** log error ฝั่ง server (มี request id + context) — ไม่ส่งรายละเอียดออก client */
export function logServerError(
  context: string,
  requestId: string,
  error: unknown
): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[${context}] request_id=${requestId} :: ${detail}`);
}

/** response 500 มาตรฐาน (ข้อความ generic + request id ให้ผู้ใช้อ้างอิงได้) */
export function serverErrorResponse(requestId: string): NextResponse {
  return NextResponse.json(
    {
      error: "server_error",
      message: "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง",
      request_id: requestId,
    },
    { status: 500 }
  );
}
