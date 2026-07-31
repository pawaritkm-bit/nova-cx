/**
 * ชั้นบังคับสิทธิ์ของหน้า/แอ็กชัน "ลงบันทึกบัญชี" — รองรับ 2 บทบาท:
 *   1) admin/executive (Supabase Auth) — เห็นทุกลูกค้า เลือกดูของนักบัญชีคนไหนก็ได้
 *   2) staff นักบัญชี (LINE session) —
 *        - accountant: เห็น "เฉพาะลูกค้าที่ตัวเองดูแล" (บังคับสโคป server-side)
 *        - lead (หัวหน้านักบัญชี): เห็นทั้งหมดเหมือน admin ไปก่อน
 *
 * ★ ความปลอดภัย (default-deny): ไม่เข้าเงื่อนไขไหนเลย = null (ปฏิเสธ)
 *   staff มาก่อน admin (ถ้ามี staff session ที่ถูกต้อง ใช้สิทธิ์ staff)
 * ★ scope ของ accountant คำนวณจาก DB (chat_groups.responsible_employee_id) — ไม่เชื่อ client
 *   ทุก query/write ต้องกรองด้วย allowedCustomerIds นี้ (server-side enforce)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveStaffContext } from "@/lib/staff/guard";
import { resolveAdminContext } from "@/lib/admin/guard";
import { customerIdsForAccountant } from "@/lib/accounting/accountant-scope";

export type AccountingMode = "admin" | "lead" | "accountant";

/** บทบาทสำหรับป้าย/nav (subset ของ RoleCode) */
export type AccountingNavRole = "admin" | "executive" | "acc_lead" | "accountant";

export type AccountingAccess = {
  tenantId: string;
  mode: AccountingMode;
  /** employees.id ของ staff (null เมื่อเป็น admin/executive ผ่าน Supabase) */
  employeeId: string | null;
  /** ชื่อ staff สำหรับแสดง (null เมื่อ admin) */
  name: string | null;
  /** null = เห็นทุกลูกค้า (admin/lead); Set = จำกัดเฉพาะชุดนี้ (accountant) */
  allowedCustomerIds: Set<string> | null;
  navRole: AccountingNavRole;
};

export class AccountingAuthError extends Error {
  constructor(message = "คุณไม่มีสิทธิ์ทำรายการนี้") {
    super(message);
    this.name = "AccountingAuthError";
  }
}

/**
 * resolve สิทธิ์เข้าถึงหน้าบัญชี — คืน null ถ้าไม่มีสิทธิ์เลย (ต้อง login/ไม่ใช่ admin/นักบัญชี)
 *   - authed: Supabase client ที่ผูก cookie (สำหรับ admin path)
 *   - service: service-role client (อ่าน chat_groups เพื่อคำนวณสโคปนักบัญชี)
 */
export async function resolveAccountingAccess(
  authed: SupabaseClient,
  service: SupabaseClient
): Promise<AccountingAccess | null> {
  // staff (LINE) มาก่อน
  const staff = await resolveStaffContext();
  if (staff) {
    if (staff.role === "accountant") {
      const ids = await customerIdsForAccountant(service, staff.tenantId, staff.employeeId);
      return {
        tenantId: staff.tenantId,
        mode: "accountant",
        employeeId: staff.employeeId,
        name: staff.name,
        allowedCustomerIds: new Set(ids),
        navRole: "accountant",
      };
    }
    // lead — เห็นทั้งหมด
    return {
      tenantId: staff.tenantId,
      mode: "lead",
      employeeId: staff.employeeId,
      name: staff.name,
      allowedCustomerIds: null,
      navRole: "acc_lead",
    };
  }

  // admin/executive (Supabase Auth)
  const admin = await resolveAdminContext(authed);
  if (admin.isAdmin && admin.tenantId) {
    return {
      tenantId: admin.tenantId,
      mode: "admin",
      employeeId: null,
      name: null,
      allowedCustomerIds: null,
      navRole: admin.role === "executive" ? "executive" : "admin",
    };
  }

  return null;
}

/** บังคับสิทธิ์สำหรับ write path — คืน access หรือ throw */
export async function requireAccountingAccess(
  authed: SupabaseClient,
  service: SupabaseClient
): Promise<AccountingAccess> {
  const access = await resolveAccountingAccess(authed, service);
  if (!access) throw new AccountingAuthError();
  return access;
}

/**
 * ลูกค้ารายนี้อยู่ในสโคปของผู้เรียกไหม
 *   - admin/lead (allowedCustomerIds=null): จริงเสมอ (รวม unassigned/customerId=null)
 *   - accountant: จริงเฉพาะ customerId ที่ไม่ null และอยู่ในชุดที่ดูแล (ห้ามแตะ unassigned/คนอื่น)
 */
export function customerInScope(
  access: AccountingAccess,
  customerId: string | null
): boolean {
  if (access.allowedCustomerIds === null) return true;
  if (!customerId) return false;
  return access.allowedCustomerIds.has(customerId);
}

/** throw ถ้าลูกค้าไม่อยู่ในสโคป (ใช้ก่อนเขียนทุกครั้งใน write path) */
export function assertCustomerInScope(
  access: AccountingAccess,
  customerId: string | null
): void {
  if (!customerInScope(access, customerId)) {
    throw new AccountingAuthError("ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ");
  }
}

/**
 * โหลด customer_id ปัจจุบันของ entry (scope tenant) — สำหรับตรวจสโคปก่อนแก้/ลบ
 *   คืน undefined ถ้าไม่พบ entry, คืน string|null (customer_id) ถ้าพบ
 */
export async function loadEntryCustomerId(
  service: SupabaseClient,
  tenantId: string,
  entryId: string
): Promise<string | null | undefined> {
  const { data } = await service
    .from("bill_entries")
    .select("customer_id")
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return undefined;
  return (data as { customer_id: string | null }).customer_id;
}
