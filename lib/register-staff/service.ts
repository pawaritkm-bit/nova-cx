/**
 * register-staff service — ผูก LINE userId ↔ พนักงาน (นักบัญชี) แบบ idempotent
 *
 * เรียกจาก POST /api/register-staff หลังจาก:
 *   - verify รหัสลงทะเบียน (constant-time) ที่ route แล้ว
 *   - verify idToken กับ LINE จนได้ userId จริงที่ route แล้ว
 *
 * ขั้นตอน (ทั้งหมด scope ด้วย tenantId จาก server เท่านั้น — ไม่เชื่อ client):
 *   1) upsert employee by (tenant_id, line_user_id):
 *        - ไม่มี → สร้างใหม่ (employee_type='accountant', is_active, line_user_id)
 *        - มีแล้ว → อัปเดตชื่อ/ชื่อเล่น (idempotent)
 *   2) ผูกเข้าทีม (team_members) ถ้าระบุทีม (resolve teamName→team บัญชี best-effort)
 *   3) propagate: อัปเดต chat_members ทุกกลุ่มใน tenant ที่ line_user_id นี้
 *        → set employee_id + member_kind='accountant' (attribute แชตย้อนหลังทันที)
 *   4) audit_logs (append-only)
 *
 * degrade อย่างสุภาพ: resolve ทีมไม่เจอ/กำกวม = ไม่ผูกทีม (ไม่ throw) — ตาม lessons
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

/** true เมื่อ error เป็น unique violation (Postgres 23505) — ใช้ตัดสิน race idempotency */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}

/** วันที่วันนี้ YYYY-MM-DD (valid_from ของ team_members) */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * resolve tenant สำหรับการลงทะเบียน (ไม่เชื่อ client):
 *   1) env LINE_TENANT_ID override
 *   2) tenant แรกที่ active (เฟสแรก 1 tenant = Finovas)
 * คืน null ถ้าไม่พบ tenant เลย (route ตอบ 503)
 */
export async function resolveRegisterTenantId(
  db: DB,
  envTenantId?: string
): Promise<string | null> {
  if (envTenantId) return envTenantId;
  const { data } = await db
    .from("tenants")
    .select("id")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

export type RegisterStaffInput = {
  /** LINE userId จริง (มาจาก verifyLineIdToken เท่านั้น) */
  userId: string;
  /** ชื่อ-นามสกุล */
  name: string;
  nickname?: string | null;
  /** ชื่อทีมบัญชีที่ผู้ลงทะเบียนพิมพ์ (best-effort resolve) — ว่าง = ไม่ผูกทีม */
  teamName?: string | null;
  /** teamId ตรง ๆ (ถ้า UI ส่งมา) — จะ verify ว่าอยู่ tenant นี้ */
  teamId?: string | null;
};

export type RegisterStaffResult = {
  employeeId: string;
  employeeName: string;
  created: boolean;
  teamLinked: boolean;
  /** ชื่อทีมที่ผูกได้จริง (null = ไม่ได้ผูก) */
  teamName: string | null;
  /** จำนวน chat_members ที่ถูก propagate (attribute แชตย้อนหลัง) */
  propagatedGroups: number;
};

// =====================================================================
// 1) upsert employee by (tenant, line_user_id)
// =====================================================================
async function upsertEmployeeByLineUser(
  db: DB,
  tenantId: string,
  input: RegisterStaffInput
): Promise<{ id: string; created: boolean }> {
  const selectExisting = () =>
    db
      .from("employees")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("line_user_id", input.userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

  const { data: existing } = await selectExisting();
  const existingId = (existing as { id?: string } | null)?.id ?? null;

  if (existingId) {
    // มีอยู่แล้ว → อัปเดตชื่อ/ชื่อเล่น + คง active (idempotent)
    const { error } = await db
      .from("employees")
      .update({
        first_name: input.name,
        nickname: input.nickname ?? null,
        is_active: true,
      })
      .eq("id", existingId)
      .eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);
    return { id: existingId, created: false };
  }

  // ยังไม่มี → สร้างใหม่ (นักบัญชี)
  const { data: inserted, error } = await db
    .from("employees")
    .insert({
      tenant_id: tenantId,
      first_name: input.name,
      nickname: input.nickname ?? null,
      employee_type: "accountant",
      is_active: true,
      line_user_id: input.userId,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // race: อีก request ลงทะเบียน LINE userId เดียวกันพร้อมกัน → ชน unique → re-select
    if (isUniqueViolation(error)) {
      const { data: after } = await selectExisting();
      const afterId = (after as { id?: string } | null)?.id ?? null;
      if (afterId) {
        await db
          .from("employees")
          .update({ first_name: input.name, nickname: input.nickname ?? null, is_active: true })
          .eq("id", afterId)
          .eq("tenant_id", tenantId);
        return { id: afterId, created: false };
      }
    }
    throw new Error(error.message);
  }

  const newId = (inserted as { id?: string } | null)?.id;
  if (!newId) throw new Error("สร้างพนักงานไม่สำเร็จ");
  return { id: newId, created: true };
}

// =====================================================================
// 2) resolve + ผูกทีม (best-effort) — ไม่ throw ถ้าหาไม่เจอ/กำกวม
// =====================================================================
async function resolveTeam(
  db: DB,
  tenantId: string,
  input: RegisterStaffInput
): Promise<{ id: string; name: string } | null> {
  // 2a) teamId ตรง ๆ → verify อยู่ tenant นี้ + เป็นทีมบัญชี
  if (input.teamId) {
    const { data } = await db
      .from("teams")
      .select("id, name")
      .eq("id", input.teamId)
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    const row = data as { id?: string; name?: string } | null;
    if (row?.id) return { id: row.id, name: row.name ?? "" };
    return null; // teamId ไม่ตรง → ไม่ผูก (ไม่ throw)
  }

  // 2b) teamName → match ทีมบัญชีในชื่อเดียวกัน (case-insensitive, trim) แบบ best-effort
  const wanted = input.teamName?.trim().toLowerCase();
  if (!wanted) return null;

  const { data } = await db
    .from("teams")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("type", "accounting")
    .is("deleted_at", null);
  const teams = (data ?? []) as { id: string; name: string }[];
  const matches = teams.filter((t) => (t.name ?? "").trim().toLowerCase() === wanted);
  // เจอพอดี 1 ทีม = ผูก; ไม่เจอ/กำกวม (>1) = ไม่ผูก (degrade ตาม lessons)
  if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };
  return null;
}

/** ผูกพนักงานเข้าทีม (team_members) ถ้ายังไม่ได้อยู่ในทีมนั้น (idempotent) */
async function ensureTeamMembership(
  db: DB,
  tenantId: string,
  teamId: string,
  employeeId: string
): Promise<void> {
  const { data: existing } = await db
    .from("team_members")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("team_id", teamId)
    .eq("employee_id", employeeId)
    .is("valid_to", null)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if ((existing as { id?: string } | null)?.id) return; // อยู่ในทีมแล้ว → ไม่ทำซ้ำ

  const { error } = await db.from("team_members").insert({
    tenant_id: tenantId,
    team_id: teamId,
    employee_id: employeeId,
    role_in_team: "member",
    valid_from: todayISO(),
  });
  // best-effort: ถ้าชน race unique ก็ถือว่าอยู่ในทีมแล้ว
  if (error && !isUniqueViolation(error)) throw new Error(error.message);
}

// =====================================================================
// 3) propagate → chat_members ทุกกลุ่มของ line_user_id นี้
// =====================================================================
async function propagateToChatMembers(
  db: DB,
  tenantId: string,
  lineUserId: string,
  employeeId: string
): Promise<number> {
  const { data, error } = await db
    .from("chat_members")
    .update({ employee_id: employeeId, member_kind: "accountant" })
    .eq("tenant_id", tenantId)
    .eq("line_user_id", lineUserId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  return (data as unknown[] | null)?.length ?? 0;
}

// =====================================================================
// entry point
// =====================================================================
export async function registerStaff(
  db: DB,
  tenantId: string,
  input: RegisterStaffInput
): Promise<RegisterStaffResult> {
  // 1) upsert พนักงานตาม LINE userId
  const employee = await upsertEmployeeByLineUser(db, tenantId, input);

  // 2) ผูกทีม (best-effort)
  const team = await resolveTeam(db, tenantId, input);
  if (team) {
    await ensureTeamMembership(db, tenantId, team.id, employee.id);
  }

  // 3) propagate ไป chat_members ทุกกลุ่ม
  const propagatedGroups = await propagateToChatMembers(db, tenantId, input.userId, employee.id);

  // 4) audit (ไม่บันทึก idToken/รหัส — เก็บเฉพาะ metadata ไม่ลับ)
  const { error: auditErr } = await db.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: null, // self-registration ผ่าน LIFF ไม่มี admin actor
    action: "staff_registered",
    resource: "employee",
    resource_id: employee.id,
    meta: {
      created: employee.created,
      line_user_id: input.userId,
      team_linked: !!team,
      team_id: team?.id ?? null,
      propagated_groups: propagatedGroups,
    },
  });
  if (auditErr) throw new Error(auditErr.message);

  return {
    employeeId: employee.id,
    employeeName: input.nickname?.trim() || input.name,
    created: employee.created,
    teamLinked: !!team,
    teamName: team?.name ?? null,
    propagatedGroups,
  };
}
