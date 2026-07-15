import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * ตัวช่วยตอบกลับ error อย่างปลอดภัย (Reviewer 🟠#4)
 *   - ไม่คืน e.message / DB error ดิบสู่ client (กันรั่วโครงสร้าง DB)
 *   - log ฝั่ง server พร้อม request id เพื่อสืบย้อน
 */

export function newRequestId(): string {
  return randomUUID();
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
