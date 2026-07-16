/**
 * ตรวจ input ฟอร์ม login ฝั่ง client ก่อนยิง Supabase Auth
 * (แยกเป็น pure function เพื่อ unit test + ใช้ซ้ำ)
 */

export type LoginValidation = { ok: true } | { ok: false; error: string };

// รูปแบบอีเมลอย่างง่าย (ไม่เข้มเกินจนปฏิเสธอีเมลจริง)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateLoginInput(
  email: string,
  password: string
): LoginValidation {
  const trimmed = email.trim();
  if (!trimmed) return { ok: false, error: "กรุณากรอกอีเมล" };
  if (!EMAIL_RE.test(trimmed))
    return { ok: false, error: "รูปแบบอีเมลไม่ถูกต้อง" };
  if (!password) return { ok: false, error: "กรุณากรอกรหัสผ่าน" };
  return { ok: true };
}

/**
 * แปลง error จาก Supabase Auth เป็นข้อความสุภาพภาษาไทย
 * (ไม่เปิดเผยรายละเอียดภายในระบบ — มาตรฐานความปลอดภัย §3)
 */
export function loginErrorMessage(rawMessage?: string | null): string {
  const msg = (rawMessage || "").toLowerCase();
  if (msg.includes("invalid login credentials")) {
    return "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
  }
  if (msg.includes("email not confirmed")) {
    return "บัญชีนี้ยังไม่ได้ยืนยันอีเมล กรุณาติดต่อผู้ดูแลระบบ";
  }
  return "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
}
