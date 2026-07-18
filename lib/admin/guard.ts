/**
 * Admin guard — เช็คสิทธิ์เข้าถึงหน้า/การเขียนของโมดูล Admin
 *
 * หลักความปลอดภัย (allow-list / default-deny):
 *   - บทบาทที่จัดการข้อมูลได้ = admin, executive เท่านั้น (role อื่น/null ถูกปฏิเสธเสมอ)
 *   - tenant_id ต้องมาจาก session (users row ตาม auth.uid()) — "ห้าม" เชื่อค่าจาก client
 *   - resolve จาก DB ทุกครั้ง ไม่ cache ข้าม request
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isRoleCode, type RoleCode } from "@/lib/dashboard/types";

/** บทบาทที่มีสิทธิ์จัดการข้อมูล admin (allow-list) */
export const ADMIN_ROLES: readonly RoleCode[] = ["admin", "executive"] as const;

/** true เฉพาะบทบาทใน allow-list — null/undefined/บทบาทอื่น = false เสมอ */
export function isAdminRole(role: string | null | undefined): role is RoleCode {
  if (!role) return false;
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

export type AdminContext = {
  tenantId: string;
  role: RoleCode;
  /** users.id ของผู้ล็อกอิน (ใช้เป็น actor/mapped_by ใน audit — ไม่ null เมื่อผ่าน guard) */
  userId: string | null;
};

export type AdminResolution = {
  /** มี session พนักงานจริงไหม (login แล้ว) */
  hasSession: boolean;
  /** บทบาทจาก DB (null = ไม่มี users row/บทบาท) */
  role: RoleCode | null;
  /** tenant จาก session (null = ไม่มี) */
  tenantId: string | null;
  /** users.id ของผู้ล็อกอิน (null = ไม่มี users row) */
  userId: string | null;
  /** ผ่านเกณฑ์ admin ครบ (มี session + tenant + บทบาทใน allow-list) */
  isAdmin: boolean;
};

/** error สื่อความหมายสำหรับชั้น write (แปลงเป็นข้อความสุภาพให้ผู้ใช้) */
export class AdminAuthError extends Error {
  constructor(message = "คุณไม่มีสิทธิ์ทำรายการนี้") {
    super(message);
    this.name = "AdminAuthError";
  }
}

/**
 * อ่านบทบาท + tenant ของผู้ใช้จาก session (users → roles.code, tenant_id)
 * ใช้ client ที่ผูก cookie (anon) เพื่อให้ auth.uid()/RLS ทำงานตามผู้ล็อกอินจริง
 */
export async function resolveAdminContext(
  db: SupabaseClient
): Promise<AdminResolution> {
  const deny: AdminResolution = {
    hasSession: false,
    role: null,
    tenantId: null,
    userId: null,
    isAdmin: false,
  };

  try {
    const { data } = await db.auth.getUser();
    if (!data?.user) return deny;

    const { data: row } = await db
      .from("users")
      .select("id, tenant_id, roles(code)")
      .eq("auth_user_id", data.user.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (!row) return { ...deny, hasSession: true };

    const tenantId = (row as { tenant_id?: string | null }).tenant_id ?? null;
    const userId = (row as { id?: string | null }).id ?? null;
    const rel = (row as { roles?: unknown }).roles;
    const code =
      Array.isArray(rel) && rel.length > 0
        ? (rel[0] as { code?: string }).code
        : (rel as { code?: string } | null | undefined)?.code;

    const role = code && isRoleCode(code) ? code : null;
    const isAdmin = !!tenantId && isAdminRole(role);

    return { hasSession: true, role, tenantId, userId, isAdmin };
  } catch {
    // อ่าน session/DB ไม่ได้ → ปฏิเสธ (fail-closed)
    return deny;
  }
}

/**
 * บังคับสิทธิ์ admin สำหรับชั้น write — คืน AdminContext หรือ throw AdminAuthError
 * (ใช้ใน server action ก่อนเขียนด้วย service-role)
 */
export async function requireAdminContext(
  db: SupabaseClient
): Promise<AdminContext> {
  const res = await resolveAdminContext(db);
  if (!res.isAdmin || !res.tenantId || !res.role) {
    throw new AdminAuthError();
  }
  return { tenantId: res.tenantId, role: res.role, userId: res.userId };
}
