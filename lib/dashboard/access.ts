/**
 * Access helpers ฝั่ง UI — ตัดสินใจ "แสดงลิงก์/หน้าไหน" ตามบทบาท (allow-list, default deny)
 *   ★ นี่เป็นเพียงชั้น presentation/route-guard เบา ๆ — ข้อมูลจริงยังบังคับด้วย view/RLS
 *     ตาม auth.uid() เสมอ (ต่อให้ปลอมบทบาทก็ไม่เห็นข้อมูลนอก scope)
 *   - isPrivilegedRole: บทบาทที่ดูภาพรวม/ข้อมูลผูกลูกค้าได้ (executive/admin/cs)
 *     ใช้ gate หน้า /cases (เคสร้องเรียนทั้งหมด)
 */
import { isRoleCode, type RoleCode } from "./types";

/** บทบาทที่เห็นภาพรวมทั้ง tenant (privileged) — ตรงกับ dashboard view = "exec" */
export const PRIVILEGED_ROLES: readonly RoleCode[] = [
  "executive",
  "admin",
  "cs",
] as const;

/** true เฉพาะบทบาทใน allow-list — null/undefined/บทบาทอื่น = false เสมอ (fail-closed) */
export function isPrivilegedRole(
  role: string | null | undefined
): role is RoleCode {
  if (!role || !isRoleCode(role)) return false;
  return (PRIVILEGED_ROLES as readonly string[]).includes(role);
}
