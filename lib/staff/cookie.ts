/**
 * ชื่อ cookie ของ session นักบัญชี (LINE login) — แยกไฟล์ไว้ให้ middleware (edge runtime)
 * import ได้โดยไม่ดึง node:crypto เข้ามา (session.ts/guard.ts ใช้ node:crypto)
 */
export const STAFF_SESSION_COOKIE = "nova_staff";

/** cookie ชั่วคราวเก็บ OAuth state (กัน CSRF ตอน callback) */
export const LINE_STATE_COOKIE = "nova_line_state";
