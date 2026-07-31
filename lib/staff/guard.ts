/**
 * อ่าน StaffContext จาก cookie session (LINE login) ใน Server Component / Route Handler
 *   - คืน null ถ้าไม่มี cookie / ลายเซ็นไม่ตรง / หมดอายุ / ยังไม่ตั้ง secret
 *   - ★ นี่คือชั้นบังคับสิทธิ์จริง (verify signature) — middleware แค่เช็ค "มี cookie ไหม" เพื่อ UX
 */
import { cookies } from "next/headers";
import { getStaffSessionSecret } from "@/lib/env";
import {
  STAFF_SESSION_COOKIE,
  verifyStaffSessionToken,
  type StaffSession,
} from "@/lib/staff/session";

export type StaffContext = StaffSession;

/** resolve StaffContext จาก cookie ปัจจุบัน (null = ไม่มี staff session ที่ถูกต้อง) */
export async function resolveStaffContext(): Promise<StaffContext | null> {
  const secret = getStaffSessionSecret();
  if (!secret) return null;
  try {
    const store = await cookies();
    const token = store.get(STAFF_SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifyStaffSessionToken(token, secret);
  } catch {
    return null;
  }
}
