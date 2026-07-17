/**
 * Admin service — ชั้นเขียน/อ่านข้อมูลจริง (teams / employees / customers / assignments)
 *
 * สัญญา (contract) ของทุกฟังก์ชัน:
 *   - รับ db (คาดหวัง service-role client เพื่อข้าม RLS สำหรับงาน admin) + tenantId + data
 *   - inject tenant_id จาก "tenantId ที่ caller ส่งมา (จาก session)" เท่านั้น — ไม่อ่านจาก data
 *   - อ้างอิงข้าม entity (lead/team/customer/employee) ต้องอยู่ tenant เดียวกัน → กัน cross-tenant
 *   - throw Error ข้อความสั้นเมื่อเขียนพัง (actions ชั้นบน map เป็นข้อความสุภาพ)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CreateTeamInput,
  CreateEmployeeInput,
  CreateCustomerInput,
  CreateAssignmentInput,
} from "./schema";

type DB = SupabaseClient;

/** วันที่วันนี้รูปแบบ YYYY-MM-DD (ใช้เป็น valid_from / service ref) */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * ยืนยันว่า mutation (update) แตะจริงอย่างน้อย 1 แถว
 *   - service-role ข้าม RLS → update ที่ id ผิด/ต่าง tenant จะ match 0 แถวโดยไม่ error
 *     ถ้าไม่เช็คจะตอบ "สำเร็จ" ทั้งที่ไม่ได้แก้อะไร → throw ให้ actions ชั้นบนแจ้งผู้ใช้
 */
function assertAffected(
  data: unknown[] | null,
  error: unknown
): void {
  if (error) throw new Error((error as { message?: string }).message ?? "update failed");
  if (!data || data.length === 0) {
    throw new Error("ไม่พบรายการที่ต้องการแก้ไข");
  }
}

/**
 * ตรวจว่า record (id) อยู่ใน tenant นี้จริงและยังไม่ถูกลบ — กัน caller อ้าง id ข้าม tenant
 * (service-role ข้าม RLS จึงต้องเช็ค tenant เองที่ชั้นนี้)
 */
async function assertBelongsToTenant(
  db: DB,
  table: "employees" | "teams" | "customers",
  id: string,
  tenantId: string,
  label: string
): Promise<void> {
  const { data, error } = await db
    .from(table)
    .select("id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`ไม่พบ${label}ที่เลือก (หรืออยู่นอกสำนักงานของคุณ)`);
}

// =====================================================================
// TEAMS
// =====================================================================
export type TeamRow = {
  id: string;
  name: string;
  type: string;
  lead_employee_id: string | null;
  created_at: string;
};

export async function listTeams(db: DB, tenantId: string): Promise<TeamRow[]> {
  const { data, error } = await db
    .from("teams")
    .select("id, name, type, lead_employee_id, created_at")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as TeamRow[];
}

export async function createTeam(
  db: DB,
  tenantId: string,
  input: CreateTeamInput
): Promise<{ id: string }> {
  if (input.lead_employee_id) {
    await assertBelongsToTenant(
      db,
      "employees",
      input.lead_employee_id,
      tenantId,
      "หัวหน้าทีม"
    );
  }
  const { data, error } = await db
    .from("teams")
    .insert({
      tenant_id: tenantId, // ★ จาก session เท่านั้น
      name: input.name,
      type: input.type,
      lead_employee_id: input.lead_employee_id ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data as { id: string };
}

export async function deactivateTeam(
  db: DB,
  tenantId: string,
  teamId: string
): Promise<void> {
  const { data, error } = await db
    .from("teams")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", teamId)
    .eq("tenant_id", tenantId) // scope tenant กันลบข้าม tenant
    .select("id");
  assertAffected(data as unknown[] | null, error);
}

// =====================================================================
// EMPLOYEES (+ ผูกทีมทันที optional)
// =====================================================================
export type EmployeeRow = {
  id: string;
  first_name: string;
  nickname: string | null;
  position: string | null;
  employee_type: string;
  is_active: boolean;
  created_at: string;
};

export async function listEmployees(
  db: DB,
  tenantId: string
): Promise<EmployeeRow[]> {
  const { data, error } = await db
    .from("employees")
    .select("id, first_name, nickname, position, employee_type, is_active, created_at")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as EmployeeRow[];
}

export async function createEmployee(
  db: DB,
  tenantId: string,
  input: CreateEmployeeInput
): Promise<{ id: string }> {
  if (input.team_id) {
    await assertBelongsToTenant(db, "teams", input.team_id, tenantId, "ทีม");
  }

  const { data, error } = await db
    .from("employees")
    .insert({
      tenant_id: tenantId, // ★ จาก session
      first_name: input.first_name,
      nickname: input.nickname ?? null,
      position: input.position ?? null,
      employee_type: input.employee_type,
      is_active: input.is_active,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const employee = data as { id: string };

  // ผูกเข้าทีมทันที (team_members) ถ้าเลือกทีม
  if (input.team_id) {
    const { error: tmErr } = await db.from("team_members").insert({
      tenant_id: tenantId,
      team_id: input.team_id,
      employee_id: employee.id,
      role_in_team: "member",
      valid_from: todayISO(),
    });
    if (tmErr) throw new Error(tmErr.message);
  }

  return employee;
}

export async function setEmployeeActive(
  db: DB,
  tenantId: string,
  employeeId: string,
  isActive: boolean
): Promise<void> {
  const { data, error } = await db
    .from("employees")
    .update({ is_active: isActive })
    .eq("id", employeeId)
    .eq("tenant_id", tenantId)
    .select("id");
  assertAffected(data as unknown[] | null, error);
}

// =====================================================================
// CUSTOMERS
// =====================================================================
export type CustomerRow = {
  id: string;
  customer_code: string | null;
  name: string;
  business_name: string | null;
  service_start_date: string | null;
  status: string;
  created_at: string;
};

export async function listCustomers(
  db: DB,
  tenantId: string
): Promise<CustomerRow[]> {
  const { data, error } = await db
    .from("customers")
    .select(
      "id, customer_code, name, business_name, service_start_date, status, created_at"
    )
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as CustomerRow[];
}

export async function createCustomer(
  db: DB,
  tenantId: string,
  input: CreateCustomerInput
): Promise<{ id: string }> {
  const { data, error } = await db
    .from("customers")
    .insert({
      tenant_id: tenantId, // ★ จาก session
      customer_code: input.customer_code ?? null,
      name: input.name,
      business_name: input.business_name ?? null,
      service_start_date: input.service_start_date ?? null,
      status: "active",
    })
    .select("id")
    .single();
  if (error) {
    // unique (tenant_id, customer_code) ชน → แจ้งสุภาพ
    if (error.code === "23505") {
      throw new Error("รหัสลูกค้านี้ถูกใช้แล้วในสำนักงานของคุณ");
    }
    throw new Error(error.message);
  }
  return data as { id: string };
}

export async function deactivateCustomer(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<void> {
  const { data, error } = await db
    .from("customers")
    .update({ deleted_at: new Date().toISOString(), status: "cancelled" })
    .eq("id", customerId)
    .eq("tenant_id", tenantId)
    .select("id");
  assertAffected(data as unknown[] | null, error);

  // cascade: ปิดผู้ดูแลปัจจุบัน (customer_assignments) ของลูกค้าที่ถูกปิดใช้งาน
  //   ไม่ให้ลูกค้าที่ยกเลิกแล้วยังโผล่ในรายการมอบหมาย (valid_to=วันนี้ เก็บ history)
  //   best-effort: ลูกค้าอาจไม่มีผู้ดูแล (0 แถว = ไม่ error) — throw เฉพาะเมื่อ error จริง
  const { error: cascadeErr } = await db
    .from("customer_assignments")
    .update({ valid_to: todayISO() })
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("valid_to", null)
    .is("deleted_at", null);
  if (cascadeErr) throw new Error(cascadeErr.message);
}

// =====================================================================
// ASSIGNMENTS (customer → employee, effective-dated)
// =====================================================================
export type AssignmentRow = {
  id: string;
  role: string;
  valid_from: string;
  customer_id: string;
  employee_id: string;
  team_id: string | null;
  customer_name: string | null;
  customer_code: string | null;
  employee_name: string | null;
  employee_nickname: string | null;
};

/** รายการ "ผู้ดูแลปัจจุบัน" (valid_to null) พร้อมชื่อ (enrich จาก 2 ตาราง) */
export async function listCurrentAssignments(
  db: DB,
  tenantId: string
): Promise<AssignmentRow[]> {
  const { data, error } = await db
    .from("customer_assignments")
    .select(
      "id, role, valid_from, customer_id, employee_id, team_id, customers(name, customer_code, deleted_at), employees(first_name, nickname)"
    )
    .eq("tenant_id", tenantId)
    .is("valid_to", null)
    .is("deleted_at", null)
    .order("valid_from", { ascending: false });
  if (error) throw new Error(error.message);

  type Raw = {
    id: string;
    role: string;
    valid_from: string;
    customer_id: string;
    employee_id: string;
    team_id: string | null;
    customers: {
      name?: string;
      customer_code?: string | null;
      deleted_at?: string | null;
    } | null;
    employees: { first_name?: string; nickname?: string | null } | null;
  };

  return ((data ?? []) as unknown as Raw[])
    // กรองลูกค้าที่ถูกปิดใช้งาน (soft-deleted) ออก — ไม่ให้โผล่ในรายการมอบหมาย
    .filter((r) => !r.customers?.deleted_at)
    .map((r) => ({
    id: r.id,
    role: r.role,
    valid_from: r.valid_from,
    customer_id: r.customer_id,
    employee_id: r.employee_id,
    team_id: r.team_id,
    customer_name: r.customers?.name ?? null,
    customer_code: r.customers?.customer_code ?? null,
    employee_name: r.employees?.first_name ?? null,
    employee_nickname: r.employees?.nickname ?? null,
  }));
}

/**
 * สร้าง assignment ใหม่ (ผู้ดูแลปัจจุบัน)
 *
 * กันชน "ผู้ดูแลปัจจุบันซ้ำ": ก่อน insert จะปิด assignment ปัจจุบันของ
 *   "ลูกค้าคน + พนักงานคนเดียวกัน" (set valid_to = วันนี้) — เก็บ history ไว้ ไม่ overwrite
 *   ทำให้ไม่มีแถว current ซ้ำของคู่เดิม (ปลอดภัยแม้ในอนาคตจะเพิ่ม unique index)
 *   ★ ลูกค้าคนเดียวกันมีผู้ดูแลได้หลายคน (lead + member) — ปิดเฉพาะคู่ที่ซ้ำเท่านั้น
 */
export async function createAssignment(
  db: DB,
  tenantId: string,
  input: CreateAssignmentInput
): Promise<{ id: string; replacedPrevious: boolean }> {
  // 1) ยืนยันว่า customer/employee/team อยู่ tenant เดียวกัน (กัน cross-tenant)
  await assertBelongsToTenant(db, "customers", input.customer_id, tenantId, "ลูกค้า");
  await assertBelongsToTenant(db, "employees", input.employee_id, tenantId, "พนักงาน");
  if (input.team_id) {
    await assertBelongsToTenant(db, "teams", input.team_id, tenantId, "ทีม");
  }

  const today = todayISO();

  // 2) ปิด assignment ปัจจุบันของคู่ (customer, employee) เดิม ถ้ามี
  const { data: existing, error: findErr } = await db
    .from("customer_assignments")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", input.customer_id)
    .eq("employee_id", input.employee_id)
    .is("valid_to", null)
    .is("deleted_at", null);
  if (findErr) throw new Error(findErr.message);

  const replacedPrevious = (existing ?? []).length > 0;
  if (replacedPrevious) {
    const { error: closeErr } = await db
      .from("customer_assignments")
      .update({ valid_to: today })
      .eq("tenant_id", tenantId)
      .eq("customer_id", input.customer_id)
      .eq("employee_id", input.employee_id)
      .is("valid_to", null)
      .is("deleted_at", null);
    if (closeErr) throw new Error(closeErr.message);
  }

  // 3) insert แถวใหม่ (ผู้ดูแลปัจจุบัน)
  const { data, error } = await db
    .from("customer_assignments")
    .insert({
      tenant_id: tenantId, // ★ จาก session
      customer_id: input.customer_id,
      employee_id: input.employee_id,
      team_id: input.team_id ?? null,
      role: input.role,
      valid_from: today,
    })
    .select("id")
    .single();
  if (error) {
    // unique violation จาก partial index 0028 (tenant, customer, employee) where valid_to null
    //   เกิดได้เมื่อ race กับอีก request ที่เพิ่งสร้างคู่เดียวกัน → แจ้งสุภาพ (idempotent-ish)
    if ((error as { code?: string }).code === "23505") {
      throw new Error("มีการมอบหมายลูกค้ารายนี้ให้พนักงานคนนี้อยู่แล้ว");
    }
    throw new Error(error.message);
  }

  return { id: (data as { id: string }).id, replacedPrevious };
}

/** สิ้นสุดการเป็นผู้ดูแลปัจจุบัน (set valid_to = วันนี้) — เก็บ history */
export async function endAssignment(
  db: DB,
  tenantId: string,
  assignmentId: string
): Promise<void> {
  const { data, error } = await db
    .from("customer_assignments")
    .update({ valid_to: todayISO() })
    .eq("id", assignmentId)
    .eq("tenant_id", tenantId)
    .is("valid_to", null)
    .select("id");
  assertAffected(data as unknown[] | null, error);
}
