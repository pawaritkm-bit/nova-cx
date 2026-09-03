/**
 * ชื่อ cookie ของ session นักบัญชี (LINE login) — แยกไฟล์ไว้ให้ middleware (edge runtime)
 * import ได้โดยไม่ดึง node:crypto เข้ามา (session.ts/guard.ts ใช้ node:crypto)
 */
export const STAFF_SESSION_COOKIE = "nova_staff";

/** cookie ชั่วคราวเก็บ OAuth state (กัน CSRF ตอน callback) */
export const LINE_STATE_COOKIE = "nova_line_state";

/** อายุ session นักบัญชี — ★ 2026-09-03 ผู้ใช้: "กดยืนยันบิลแล้วโปรแกรมเด้งออก" (เดิม 12 ชม.
 *  ตายตัว ทำงานข้ามวันโดนเด้ง login กลางคัน) → 7 วัน + sliding renewal ใน middleware
 *  (อยู่ไฟล์นี้เพราะ middleware/edge import ได้โดยไม่ลาก node:crypto) */
export const STAFF_SESSION_TTL_SEC = 7 * 24 * 60 * 60;

/** ควรต่ออายุ session ไหม — เหลือน้อยกว่าครึ่งอายุ = ต่อ (sliding, กัน re-sign ทุก request) */
export function staffSessionNeedsRenewal(
  exp: number,
  now: number = Math.floor(Date.now() / 1000),
  ttlSec: number = STAFF_SESSION_TTL_SEC
): boolean {
  return exp - now < ttlSec / 2;
}
