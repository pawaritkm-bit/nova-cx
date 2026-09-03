/**
 * Session ของนักบัญชี (staff) ที่ล็อกอินด้วย LINE — เก็บเป็น signed cookie (httpOnly)
 *
 * ★ ไม่ใช่ Supabase Auth: staff ไม่มีบัญชีอีเมล/รหัสผ่าน — ยืนยันตัวตนด้วย LINE เท่านั้น
 *   หลัง verify LINE เสร็จ (ได้ employeeId/tenantId/role) จะออกโทเค็น signed เก็บใน cookie
 * ★ payload มองเห็นได้ (base64) แต่ปลอมไม่ได้ (HMAC) — เก็บเฉพาะ id/role/name/exp
 *   ห้ามเก็บ line userId ใน payload (PDPA — ไม่จำเป็นหลัง resolve เป็น employee แล้ว)
 */
import { signToken, verifyToken } from "@/lib/crypto/hmac-token";
import { STAFF_SESSION_COOKIE } from "@/lib/staff/cookie";

export { STAFF_SESSION_COOKIE };

/** บทบาท staff — accountant (เห็นเฉพาะลูกค้าตัวเอง) / lead (หัวหน้านักบัญชี เห็นกว้าง) */
export type StaffRole = "accountant" | "lead";

export type StaffSession = {
  employeeId: string;
  tenantId: string;
  role: StaffRole;
  /** ชื่อไว้แสดงบน nav (ชื่อเล่น/ชื่อจริงของพนักงานคนนั้นเอง) */
  name: string;
  /** epoch วินาที ที่หมดอายุ */
  exp: number;
};

/** อายุ session + ตัวเช็คต่ออายุ — ★ 2026-09-03 ย้ายไป cookie.ts (edge import ได้) · re-export
 *  ที่นี่เพื่อ backward-compat (callback route/เทสต์เดิม import จาก session.ts) */
export { STAFF_SESSION_TTL_SEC, staffSessionNeedsRenewal } from "@/lib/staff/cookie";
import { STAFF_SESSION_TTL_SEC } from "@/lib/staff/cookie";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** ออกโทเค็น session (signed) จากข้อมูลพนักงานที่ resolve แล้ว */
export function createStaffSessionToken(
  input: { employeeId: string; tenantId: string; role: StaffRole; name: string },
  secret: string,
  ttlSec: number = STAFF_SESSION_TTL_SEC,
  now: number = nowSeconds()
): string {
  const payload = {
    employeeId: input.employeeId,
    tenantId: input.tenantId,
    role: input.role,
    name: input.name,
    exp: now + ttlSec,
  };
  return signToken(payload, secret);
}

/** verify + parse โทเค็น session → StaffSession หรือ null (รูปแบบผิด/หมดอายุ/ลายเซ็นไม่ตรง) */
export function verifyStaffSessionToken(
  token: string | null | undefined,
  secret: string,
  now: number = nowSeconds()
): StaffSession | null {
  const p = verifyToken<Partial<StaffSession>>(token, secret, now);
  if (!p) return null;
  if (typeof p.employeeId !== "string" || !p.employeeId) return null;
  if (typeof p.tenantId !== "string" || !p.tenantId) return null;
  if (p.role !== "accountant" && p.role !== "lead") return null;
  if (typeof p.name !== "string") return null;
  if (typeof p.exp !== "number") return null;
  return {
    employeeId: p.employeeId,
    tenantId: p.tenantId,
    role: p.role,
    name: p.name,
    exp: p.exp,
  };
}
