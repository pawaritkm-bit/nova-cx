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
import { decryptField, hasEncKey } from "@/lib/crypto/field";
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
  /** ทีมดูแลลูกค้าประเภทไหน (0037): 'company'/'individual'/null (ทั้งสอง) */
  handles_customer_type: string | null;
  created_at: string;
};

export async function listTeams(db: DB, tenantId: string): Promise<TeamRow[]> {
  const { data, error } = await db
    .from("teams")
    .select("id, name, type, lead_employee_id, handles_customer_type, created_at")
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
      handles_customer_type: input.handles_customer_type ?? null, // null = ดูแลทั้งสองประเภท
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
  /** ทีมปัจจุบันที่ผูกอยู่ (team_members valid_to null) — null = ยังไม่อยู่ทีมใด
   *  ใช้ตั้งค่า default ให้ dropdown ทีมในแผงแก้ไขพนักงาน */
  team_id: string | null;
  created_at: string;
};

export async function listEmployees(
  db: DB,
  tenantId: string
): Promise<EmployeeRow[]> {
  // ดึงพนักงาน + membership ทีม (nested) เพื่อรู้ทีมปัจจุบันของแต่ละคน
  const { data, error } = await db
    .from("employees")
    .select(
      "id, first_name, nickname, position, employee_type, is_active, created_at, team_members(team_id, valid_to, deleted_at)"
    )
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  type RawMember = { team_id: string; valid_to: string | null; deleted_at: string | null };
  type Raw = Omit<EmployeeRow, "team_id"> & { team_members?: RawMember[] | null };

  return ((data ?? []) as unknown as Raw[]).map((r) => {
    // ทีมปัจจุบัน = membership ที่ยังไม่สิ้นสุด (valid_to null) และไม่ถูกลบ
    const current = (r.team_members ?? []).find(
      (m) => !m.valid_to && !m.deleted_at
    );
    const { team_members: _drop, ...rest } = r;
    void _drop;
    return { ...rest, team_id: current?.team_id ?? null } as EmployeeRow;
  });
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

/** ฟิลด์พนักงานที่แก้ไขได้ (patch) — key ที่ไม่ส่ง (undefined) = ไม่แตะ */
export type UpdateEmployeePatch = {
  first_name?: string;
  nickname?: string | null;
  position?: string | null;
  employee_type?: string;
  /** undefined = ไม่แตะทีม ; null = เอาออกจากทีม ; uuid = ย้าย/ผูกเข้าทีมนั้น */
  teamId?: string | null;
};

/**
 * แก้ไขพนักงานรายคน (edit panel)
 *   - อัปเดตฟิลด์ employees เฉพาะ key ที่ส่งมา (undefined = ไม่แตะ) + scope tenant + assertAffected
 *   - แก้ทีมผ่าน team_members (effective-dated): เปลี่ยนทีม = ปิด membership เดิม + insert ใหม่
 *   - ตรวจทีมอยู่ tenant เดียวกัน (assertBelongsToTenant) กัน cross-tenant
 */
export async function updateEmployee(
  db: DB,
  tenantId: string,
  employeeId: string,
  patch: UpdateEmployeePatch
): Promise<void> {
  // 1) อัปเดตฟิลด์ employees (เก็บเฉพาะ key ที่ส่งมาจริง)
  const update: Record<string, unknown> = {};
  if (patch.first_name !== undefined) update.first_name = patch.first_name;
  if (patch.nickname !== undefined) update.nickname = patch.nickname;
  if (patch.position !== undefined) update.position = patch.position;
  if (patch.employee_type !== undefined) update.employee_type = patch.employee_type;

  if (Object.keys(update).length > 0) {
    const { data, error } = await db
      .from("employees")
      .update(update)
      .eq("id", employeeId)
      .eq("tenant_id", tenantId) // ★ scope tenant จาก session (ไม่แก้ข้าม tenant)
      .is("deleted_at", null)
      .select("id");
    assertAffected(data as unknown[] | null, error);
  } else {
    // ไม่มีฟิลด์ employees ให้แก้ → ยืนยันพนักงานมีจริงใน tenant (กัน id ผิด/ข้าม tenant)
    await assertBelongsToTenant(db, "employees", employeeId, tenantId, "พนักงาน");
  }

  // 2) แก้ทีม (เฉพาะเมื่อส่ง teamId มา — undefined = ไม่แตะทีม)
  if (patch.teamId !== undefined) {
    await setEmployeeTeam(db, tenantId, employeeId, patch.teamId);
  }
}

/**
 * ตั้งทีมของพนักงาน (team_members, effective-dated)
 *   - teamId = null → เอาออกจากทีม (ปิด membership ปัจจุบัน ไม่ insert ใหม่)
 *   - teamId = uuid → ถ้าอยู่ทีมนั้นอยู่แล้ว = no-op ; ไม่งั้นปิดของเดิม + insert ใหม่
 *   - เก็บ history ด้วยการปิด (valid_to = วันนี้) ไม่ลบทิ้ง
 */
async function setEmployeeTeam(
  db: DB,
  tenantId: string,
  employeeId: string,
  teamId: string | null
): Promise<void> {
  // ระบุทีม → ต้องอยู่ tenant เดียวกัน (กัน cross-tenant)
  if (teamId) {
    await assertBelongsToTenant(db, "teams", teamId, tenantId, "ทีม");
  }

  // membership ปัจจุบัน (valid_to null) ของพนักงานคนนี้
  const { data: current, error: findErr } = await db
    .from("team_members")
    .select("id, team_id")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .is("valid_to", null)
    .is("deleted_at", null);
  if (findErr) throw new Error(findErr.message);
  const currentRows = (current ?? []) as { id: string; team_id: string }[];

  // อยู่ทีมเดิมอยู่แล้ว (ทีมเดียว ตรงกัน) → ไม่ต้องทำอะไร
  if (teamId && currentRows.length === 1 && currentRows[0].team_id === teamId) {
    return;
  }

  // ปิด membership ปัจจุบันทั้งหมด (set valid_to = วันนี้) — เก็บ history
  if (currentRows.length > 0) {
    const { error: closeErr } = await db
      .from("team_members")
      .update({ valid_to: todayISO() })
      .eq("tenant_id", tenantId)
      .eq("employee_id", employeeId)
      .is("valid_to", null)
      .is("deleted_at", null);
    if (closeErr) throw new Error(closeErr.message);
  }

  // เอาออกจากทีม (null) → จบแค่ปิดของเดิม
  if (!teamId) return;

  // insert membership ใหม่ (role_in_team = member เหมือนตอน createEmployee)
  const { error: insErr } = await db.from("team_members").insert({
    tenant_id: tenantId,
    team_id: teamId,
    employee_id: employeeId,
    role_in_team: "member",
    valid_from: todayISO(),
  });
  if (insErr) throw new Error(insErr.message);
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
  /** สวิตช์ส่งแบบประเมินอัตโนมัติ (A/B) — false = ปิด (ค่าเริ่มต้น, 0029) */
  auto_survey_enabled: boolean;
  /** ประเภทลูกค้า (0037): 'company'/'individual'/null (ยังไม่จัดประเภท) */
  customer_type: string | null;
  created_at: string;
};

export async function listCustomers(
  db: DB,
  tenantId: string
): Promise<CustomerRow[]> {
  const { data, error } = await db
    .from("customers")
    .select(
      "id, customer_code, name, business_name, service_start_date, status, auto_survey_enabled, customer_type, created_at"
    )
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as CustomerRow[];
}

/**
 * เปิด/ปิดสวิตช์ "ส่งแบบประเมินอัตโนมัติ" ต่อลูกค้า (0029)
 *   - scope ด้วย tenant จาก session (กันแก้ข้าม tenant) + assertAffected กัน id ผิด
 *   - ไม่แตะ deal-status/เซล C/D และไม่แตะปุ่มส่งเอง (flag นี้ควบคุมเฉพาะรอบ cron A/B)
 */
export async function setCustomerAutoSurvey(
  db: DB,
  tenantId: string,
  customerId: string,
  enabled: boolean
): Promise<void> {
  const { data, error } = await db
    .from("customers")
    .update({ auto_survey_enabled: enabled })
    .eq("id", customerId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .select("id");
  assertAffected(data as unknown[] | null, error);
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
      customer_type: input.customer_type ?? null, // null = ยังไม่จัดประเภท
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

/** ฟิลด์ลูกค้าที่แก้ไขได้ (patch) — key ที่ไม่ส่งมา (undefined) = ไม่แตะ */
export type UpdateCustomerPatch = {
  customer_code?: string | null;
  name?: string;
  business_name?: string | null;
  service_start_date?: string | null;
  /** ประเภทลูกค้า (0037): null = เคลียร์เป็น "ยังไม่จัดประเภท" */
  customer_type?: string | null;
};

/**
 * แก้ไขฟิลด์ลูกค้ารายคน (edit panel)
 *   - เขียนเฉพาะ key ที่ถูกส่งมา (undefined = ไม่แตะ) — null = เคลียร์ค่าใน DB
 *   - "ห้าม" แก้ tenant_id/id (scope ด้วย tenant จาก session กันข้าม tenant)
 *   - assertAffected กัน id ผิด/ข้าม tenant คืน success เท็จ
 *   - error.code 23505 (รหัสลูกค้าซ้ำใน tenant) → ข้อความไทยสุภาพ เหมือน createCustomer
 */
export async function updateCustomer(
  db: DB,
  tenantId: string,
  customerId: string,
  patch: UpdateCustomerPatch
): Promise<void> {
  // เก็บเฉพาะ key ที่ถูกส่งมาจริง (undefined = ไม่แก้) — กันเผลอ overwrite เป็น null
  const update: Record<string, unknown> = {};
  if (patch.customer_code !== undefined) update.customer_code = patch.customer_code;
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.business_name !== undefined) update.business_name = patch.business_name;
  if (patch.service_start_date !== undefined)
    update.service_start_date = patch.service_start_date;
  if (patch.customer_type !== undefined) update.customer_type = patch.customer_type;

  // ไม่มีฟิลด์ให้แก้ → ยืนยันแค่ว่าลูกค้ามีจริงใน tenant (กัน id ผิด) แล้วจบแบบ no-op
  if (Object.keys(update).length === 0) {
    await assertBelongsToTenant(db, "customers", customerId, tenantId, "ลูกค้า");
    return;
  }

  const { data, error } = await db
    .from("customers")
    .update(update)
    .eq("id", customerId)
    .eq("tenant_id", tenantId) // ★ scope tenant จาก session (ไม่แก้ข้าม tenant)
    .is("deleted_at", null)
    .select("id");
  // unique (tenant_id, customer_code) ชน → แจ้งสุภาพ (ก่อน map error ทั่วไป)
  if (error && (error as { code?: string }).code === "23505") {
    throw new Error("รหัสลูกค้านี้ถูกใช้แล้วในสำนักงานของคุณ");
  }
  assertAffected(data as unknown[] | null, error);
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
// ผู้ดูแลลูกค้า (มอบหมาย) — ยึด chat_groups เป็นแหล่งเดียว
//   "นักบัญชีดูแลลูกค้าคนไหน" = ผู้ดูแลของกลุ่มแชตที่จับคู่ลูกค้ารายนั้น
//   (chat_groups.responsible_employee_id + customer_id) — แหล่งเดียวกับหน้าตรวจแชต
//   ★ ไม่เขียน customer_assignments ใน flow นี้แล้ว (แต่ตารางยังคงอยู่ให้ evaluation/SLA)
// =====================================================================

/** group_kind ที่ถือเป็น "กลุ่มจริง" (ไม่ใช่บทสนทนา 1-1 ฝั่งลูกค้า) */
const REAL_GROUP_KINDS = ["group", "room"] as const;

/** ถอดรหัสชื่อกลุ่มแบบ best-effort — คืน null ถ้าไม่มีคีย์/ถอดไม่ได้ */
function safeDecryptGroupName(enc: string | null | undefined): string | null {
  if (!enc || !hasEncKey()) return null;
  try {
    return decryptField(enc);
  } catch {
    return null; // token เพี้ยน/คีย์ไม่ตรง — ไม่ให้ทั้งหน้าใช้ไม่ได้
  }
}

/** ผู้ดูแลปัจจุบันของลูกค้า 1 คู่ (customer × accountant) จาก chat_groups linkage */
export type CaretakerRow = {
  /** key ไว้ทำ React key + อ้างอิงในตาราง (customerId::employeeId) */
  key: string;
  customerId: string;
  customerCode: string | null;
  customerName: string | null;
  employeeId: string;
  employee_name: string | null;
  employee_nickname: string | null;
  /** ชื่อกลุ่มที่ decrypt ได้ (best-effort) — อาจว่างถ้าไม่มีคีย์/ยังไม่มีชื่อ */
  groupNames: string[];
  /** จำนวนกลุ่มของคู่นี้ */
  groupCount: number;
};

/**
 * รายการ "ผู้ดูแลปัจจุบัน" — อ่านจากกลุ่มแชตที่มีทั้งลูกค้า + นักบัญชีผู้ดูแล
 *   - รวมเป็นแถวต่อคู่ (customer × accountant) + list ชื่อกลุ่มที่ decrypt ได้
 *   - กรองลูกค้าที่ถูกปิดใช้งาน (soft-deleted) ออก
 *   - scope tenant จาก session เสมอ
 */
export async function listCurrentAssignments(
  db: DB,
  tenantId: string
): Promise<CaretakerRow[]> {
  const { data, error } = await db
    .from("chat_groups")
    .select(
      "customer_id, responsible_employee_id, display_name_enc, customers(name, customer_code, deleted_at), responsible:employees!responsible_employee_id(first_name, nickname)"
    )
    .eq("tenant_id", tenantId)
    .not("customer_id", "is", null)
    .not("responsible_employee_id", "is", null)
    .in("group_kind", REAL_GROUP_KINDS as unknown as string[])
    .is("deleted_at", null);
  if (error) throw new Error(error.message);

  type EmpEmbed = { first_name?: string; nickname?: string | null };
  type Raw = {
    customer_id: string;
    responsible_employee_id: string;
    display_name_enc: string | null;
    customers:
      | { name?: string; customer_code?: string | null; deleted_at?: string | null }
      | { name?: string; customer_code?: string | null; deleted_at?: string | null }[]
      | null;
    responsible: EmpEmbed | EmpEmbed[] | null;
  };

  const byPair = new Map<string, CaretakerRow>();

  for (const r of (data ?? []) as unknown as Raw[]) {
    const cust = Array.isArray(r.customers) ? r.customers[0] : r.customers;
    if (cust?.deleted_at) continue; // ลูกค้าปิดใช้งาน → ไม่โชว์
    const emp = Array.isArray(r.responsible) ? r.responsible[0] : r.responsible;

    const key = `${r.customer_id}::${r.responsible_employee_id}`;
    let row = byPair.get(key);
    if (!row) {
      row = {
        key,
        customerId: r.customer_id,
        customerCode: cust?.customer_code ?? null,
        customerName: cust?.name ?? null,
        employeeId: r.responsible_employee_id,
        employee_name: emp?.first_name ?? null,
        employee_nickname: emp?.nickname ?? null,
        groupNames: [],
        groupCount: 0,
      };
      byPair.set(key, row);
    }
    row.groupCount += 1;
    const name = safeDecryptGroupName(r.display_name_enc);
    if (name && !row.groupNames.includes(name)) row.groupNames.push(name);
  }

  // เรียงตามชื่อลูกค้า (คงที่) แล้วชื่อผู้ดูแล
  return Array.from(byPair.values()).sort(
    (a, b) =>
      (a.customerName ?? "").localeCompare(b.customerName ?? "", "th") ||
      (a.employee_name ?? "").localeCompare(b.employee_name ?? "", "th")
  );
}

/**
 * มอบหมายลูกค้า → นักบัญชี (ผ่านกลุ่มแชต)
 *   ตั้ง responsible_employee_id = นักบัญชีที่เลือก บน "ทุกกลุ่มแชตที่จับคู่ลูกค้ารายนี้"
 *   - guard cross-tenant: ลูกค้า + พนักงานต้องอยู่ tenant เดียวกัน
 *   - พนักงานต้องเป็นนักบัญชี/CS + ยัง active (สอดคล้องกับผู้ดูแลกลุ่มในหน้าตรวจแชต)
 *   - ลูกค้าไม่มีกลุ่มแชตผูก → error สุภาพ (ให้ไปจับคู่กลุ่ม→ลูกค้าก่อน)
 *   - คืนจำนวนกลุ่มที่อัปเดต (ให้ action แจ้งผลได้)
 */
export async function createAssignment(
  db: DB,
  tenantId: string,
  input: CreateAssignmentInput
): Promise<{ groupCount: number }> {
  // 1) ลูกค้าอยู่ tenant นี้จริง
  await assertBelongsToTenant(db, "customers", input.customer_id, tenantId, "ลูกค้า");

  // 2) พนักงานอยู่ tenant + เป็นนักบัญชี/CS + ยัง active
  const { data: emp, error: empErr } = await db
    .from("employees")
    .select("id, employee_type, is_active")
    .eq("id", input.employee_id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (empErr) throw new Error(empErr.message);
  const e = emp as { employee_type?: string; is_active?: boolean } | null;
  if (!e) throw new Error("ไม่พบพนักงานที่เลือก (หรืออยู่นอกสำนักงานของคุณ)");
  if (e.employee_type !== "accountant" && e.employee_type !== "cs") {
    throw new Error("ผู้ดูแลต้องเป็นนักบัญชีหรือทีมบริการลูกค้า (CS)");
  }
  if (!e.is_active) throw new Error("พนักงานที่เลือกถูกปิดใช้งานอยู่");

  // 3) ลูกค้ารายนี้มีกลุ่มแชตผูกไหม
  const { data: groups, error: gErr } = await db
    .from("chat_groups")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", input.customer_id)
    .in("group_kind", REAL_GROUP_KINDS as unknown as string[])
    .is("deleted_at", null);
  if (gErr) throw new Error(gErr.message);
  if (!groups || groups.length === 0) {
    throw new Error(
      "ลูกค้ารายนี้ยังไม่มีกลุ่มแชต — จับคู่กลุ่ม→ลูกค้าก่อนที่หน้าตั้งค่าตรวจแชต"
    );
  }

  // 4) ตั้งผู้ดูแลบนทุกกลุ่มของลูกค้ารายนี้
  const { data: upd, error: uErr } = await db
    .from("chat_groups")
    .update({ responsible_employee_id: input.employee_id })
    .eq("tenant_id", tenantId)
    .eq("customer_id", input.customer_id)
    .in("group_kind", REAL_GROUP_KINDS as unknown as string[])
    .is("deleted_at", null)
    .select("id");
  assertAffected(upd as unknown[] | null, uErr);

  return { groupCount: (upd ?? []).length };
}

/**
 * สิ้นสุดการเป็นผู้ดูแล — เอานักบัญชีออกจากทุกกลุ่มแชตของลูกค้ารายนี้
 *   (set responsible_employee_id = null บนกลุ่มที่ยังมีผู้ดูแลอยู่)
 */
export async function endAssignment(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<void> {
  const { data, error } = await db
    .from("chat_groups")
    .update({ responsible_employee_id: null })
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .in("group_kind", REAL_GROUP_KINDS as unknown as string[])
    .is("deleted_at", null)
    .not("responsible_employee_id", "is", null)
    .select("id");
  assertAffected(data as unknown[] | null, error);
}
