/**
 * resolve พนักงาน (นักบัญชี) จาก LINE userId — ใช้ตอน login ด้วย LINE
 *
 * ★ ไม่เชื่อ userId จาก client: ตัวเรียก (callback route) ต้อง verify idToken กับ LINE ก่อน
 *   จนได้ userId จริง แล้วค่อยส่งเข้ามา resolve เป็น employee
 * ★ default-deny: อนุญาตเฉพาะ employee_type='accountant' + is_active + ยังไม่ถูกลบ
 *   (เซลล์/คนอื่นที่บังเอิญมี line_user_id จะ login เข้าหน้าบัญชีไม่ได้)
 * ★ role: position = 'หัวหน้านักบัญชี' → 'lead' (เห็นกว้าง) ไม่งั้น 'accountant'
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StaffRole } from "@/lib/staff/session";

/** ตำแหน่งที่ถือเป็นหัวหน้าทีมบัญชี (เห็นได้กว้างเหมือน admin ไปก่อน) */
export const ACC_LEAD_POSITION = "หัวหน้านักบัญชี";

/** map ตำแหน่ง → StaffRole */
export function roleFromPosition(position: string | null | undefined): StaffRole {
  return (position ?? "").trim() === ACC_LEAD_POSITION ? "lead" : "accountant";
}

export type ResolvedStaffEmployee = {
  employeeId: string;
  tenantId: string;
  role: StaffRole;
  name: string;
};

type RawEmployee = {
  id: string;
  tenant_id: string;
  first_name: string | null;
  nickname: string | null;
  position: string | null;
  employee_type: string | null;
  is_active: boolean | null;
};

/**
 * หา employee จาก LINE userId (ต้องเป็นนักบัญชีที่ active)
 *   - envTenantId (optional): ถ้าตั้งไว้ จำกัด tenant (multi-tenant future) — ไม่ตั้ง = ทุก tenant
 *   - คืน null ถ้าไม่พบ / ไม่ใช่นักบัญชี / ถูกปิดใช้งาน
 */
export async function resolveStaffEmployeeByLineUserId(
  db: SupabaseClient,
  lineUserId: string,
  envTenantId?: string
): Promise<ResolvedStaffEmployee | null> {
  const uid = (lineUserId ?? "").trim();
  if (!uid) return null;

  let q = db
    .from("employees")
    .select("id, tenant_id, first_name, nickname, position, employee_type, is_active")
    .eq("line_user_id", uid)
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1);
  if (envTenantId) q = q.eq("tenant_id", envTenantId);

  const { data } = await q.maybeSingle();
  const row = (data ?? null) as RawEmployee | null;
  if (!row) return null;

  // default-deny: เฉพาะนักบัญชีเท่านั้นที่ login เข้าหน้าบัญชีได้
  if (row.employee_type !== "accountant") return null;

  const name = row.nickname?.trim() || row.first_name?.trim() || "นักบัญชี";
  return {
    employeeId: row.id,
    tenantId: row.tenant_id,
    role: roleFromPosition(row.position),
    name,
  };
}
