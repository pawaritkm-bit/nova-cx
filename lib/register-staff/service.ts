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

/** 1 ตัวเลือกใน dropdown "เลือกหัวหน้าทีม" ของหน้าลงทะเบียน */
export type TeamLeaderOption = {
  teamId: string;
  teamName: string;
  /** ชื่อหัวหน้าทีม (ชื่อเล่นถ้ามี ไม่งั้นชื่อจริง) — null = ทีมยังไม่ตั้งหัวหน้า */
  leaderName: string | null;
};

/**
 * รายชื่อทีมบัญชี + ชื่อหัวหน้า สำหรับ dropdown หน้าลงทะเบียน (scope tenant)
 *   - เฉพาะ teams type='accounting' ที่ยังไม่ถูกลบ
 *   - join lead_employee_id → employees เพื่อได้ชื่อหัวหน้า (nickname ก่อน first_name)
 *   ★ ผู้เรียก (route) ต้อง verify code ก่อนเรียก — ห้าม leak ชื่อหัวหน้าให้คนไม่มีรหัส
 */
export async function listAccountingTeamsWithLeader(
  db: DB,
  tenantId: string
): Promise<TeamLeaderOption[]> {
  const { data, error } = await db
    .from("teams")
    .select("id, name, employees:lead_employee_id(first_name, nickname)")
    .eq("tenant_id", tenantId)
    .eq("type", "accounting")
    .is("deleted_at", null)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);

  type Row = {
    id: string;
    name: string;
    // Supabase คืน object (to-one) หรือ array แล้วแต่ shape — รองรับทั้งสอง
    employees:
      | { first_name?: string | null; nickname?: string | null }
      | { first_name?: string | null; nickname?: string | null }[]
      | null;
  };

  return ((data ?? []) as unknown as Row[]).map((r) => {
    const emp = Array.isArray(r.employees) ? r.employees[0] ?? null : r.employees;
    const leaderName = emp
      ? (emp.nickname?.trim() || emp.first_name?.trim() || null)
      : null;
    return { teamId: r.id, teamName: r.name, leaderName };
  });
}

/** 1 ตัวเลือกใน dropdown "เลือกชื่อของคุณ" (พนักงานเดิมที่เป็น staff ได้) */
export type RegisterableEmployee = {
  id: string;
  /** ชื่อสำหรับแสดง (ชื่อเล่นก่อนชื่อจริง) — ★ ไม่คืน line_user_id/PII อื่น (PDPA) */
  name: string;
  /** true = record นี้เคยผูก LINE ไว้แล้ว (โชว์ป้าย "ผูกแล้ว"; ยังเลือกเพื่อ re-link ได้) */
  linked: boolean;
};

/**
 * รายชื่อพนักงานที่ "เป็น staff ได้ทั้งหมด" ให้ผู้ลงทะเบียนเลือกตัวเอง (scope tenant)
 * เกณฑ์: active + ไม่ลบ + เป็นนักบัญชี "หรือ" หัวหน้าทีมบัญชี
 *   - accountant: employees.employee_type = 'accountant'
 *   - หัวหน้าทีมบัญชี: อยู่เป็น teams.lead_employee_id ของ teams type='accounting'
 *     (หัวหน้าอาจ type อื่น จึงต้องรวมเข้ามาด้วย)
 * ★ คืน "ทั้งหมด" (ทั้งที่ผูกแล้ว/ยังไม่ผูก) พร้อมธง linked — คนที่ผูกไว้ด้วย userId เก่าที่
 *   login ไม่ได้ ต้องเลือกชื่อตัวเองเพื่อ re-link ได้
 * ★ ผู้เรียก (route) ต้อง verify code ก่อน — ห้าม leak รายชื่อพนักงานให้คนไม่มีรหัส
 * ★ อ่าน line_user_id ฝั่ง server เพื่อคำนวณ linked เท่านั้น — คืนแค่ { id, name, linked } ไม่คืน PII
 */
export async function listRegisterableEmployees(
  db: DB,
  tenantId: string
): Promise<RegisterableEmployee[]> {
  const displayName = (r: { first_name?: string | null; nickname?: string | null }) =>
    (r.nickname?.trim() || r.first_name?.trim() || "").trim();

  // (1) นักบัญชีทั้งหมด (active, ไม่ลบ) — ผูกแล้วหรือยังไม่ผูกก็คืน
  const { data: accs, error: e1 } = await db
    .from("employees")
    .select("id, first_name, nickname, line_user_id")
    .eq("tenant_id", tenantId)
    .eq("employee_type", "accountant")
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("first_name", { ascending: true });
  if (e1) throw new Error(e1.message);

  const byId = new Map<string, RegisterableEmployee>();
  for (const a of (accs ?? []) as {
    id: string;
    first_name?: string | null;
    nickname?: string | null;
    line_user_id?: string | null;
  }[]) {
    const name = displayName(a);
    if (name) byId.set(a.id, { id: a.id, name, linked: !!a.line_user_id });
  }

  // (2) หัวหน้าทีมบัญชี (อาจไม่ใช่ type accountant) — join lead มาเช็คเงื่อนไขเดียวกัน
  const { data: teams, error: e2 } = await db
    .from("teams")
    .select("id, lead:lead_employee_id(id, first_name, nickname, line_user_id, is_active, deleted_at)")
    .eq("tenant_id", tenantId)
    .eq("type", "accounting")
    .is("deleted_at", null);
  if (e2) throw new Error(e2.message);

  type LeadRow = {
    id?: string;
    first_name?: string | null;
    nickname?: string | null;
    line_user_id?: string | null;
    is_active?: boolean | null;
    deleted_at?: string | null;
  };
  for (const t of (teams ?? []) as { lead: LeadRow | LeadRow[] | null }[]) {
    const lead = Array.isArray(t.lead) ? t.lead[0] ?? null : t.lead;
    if (!lead?.id) continue;
    // เงื่อนไข: active + ไม่ลบ (ไม่กรอง line_user_id — คืนทั้งที่ผูกแล้ว/ยังไม่ผูก)
    if (lead.is_active === false || lead.deleted_at) continue;
    if (byId.has(lead.id)) continue;
    const name = displayName(lead);
    if (name) byId.set(lead.id, { id: lead.id, name, linked: !!lead.line_user_id });
  }

  return [...byId.values()];
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
  /**
   * ★ [เลือกจากรายชื่อ] employeeId ของพนักงานเดิมที่ผู้ลงทะเบียนเลือก
   *   มีค่า = ผูก LINE เข้ากับ "record เดิมนั้น" (ไม่สร้างใหม่)
   *   ไม่มี = พฤติกรรมเดิม (upsert by line_user_id / สร้างใหม่)
   */
  employeeId?: string | null;
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
): Promise<{ id: string; created: boolean; displayName: string }> {
  const inputDisplayName = input.nickname?.trim() || input.name;
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
    // มีอยู่แล้ว → อัปเดตแค่ชื่อ/ชื่อเล่น (idempotent)
    // ★ [M3] ห้าม force is_active=true — ถ้าแอดมินปิดพนักงานคนนี้ไว้ ต้องคงปิดต่อ
    //   (การลงทะเบียนซ้ำต้องไม่ reactivate คนที่ถูกปิดโดยเจตนา)
    const { error } = await db
      .from("employees")
      .update({
        first_name: input.name,
        nickname: input.nickname ?? null,
      })
      .eq("id", existingId)
      .eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);
    return { id: existingId, created: false, displayName: inputDisplayName };
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
        // ★ [M3] race path ก็ต้องไม่ reactivate เช่นกัน (คง is_active เดิม)
        await db
          .from("employees")
          .update({ first_name: input.name, nickname: input.nickname ?? null })
          .eq("id", afterId)
          .eq("tenant_id", tenantId);
        return { id: afterId, created: false, displayName: inputDisplayName };
      }
    }
    throw new Error(error.message);
  }

  const newId = (inserted as { id?: string } | null)?.id;
  if (!newId) throw new Error("สร้างพนักงานไม่สำเร็จ");
  return { id: newId, created: true, displayName: inputDisplayName };
}

// =====================================================================
// 1b) ★ [เลือกจากรายชื่อ] ผูก LINE เข้ากับ "record เดิม" ที่ผู้ใช้เลือก
// =====================================================================

/** true ถ้าพนักงานคนนี้เป็นนักบัญชี หรือ เป็นหัวหน้าทีมบัญชี (มีสิทธิ์เป็น staff) */
async function isAccountingEligible(
  db: DB,
  tenantId: string,
  employeeId: string,
  employeeType: string | null | undefined
): Promise<boolean> {
  if (employeeType === "accountant") return true;
  // ไม่ใช่ accountant → ผ่านได้ก็ต่อเมื่อเป็นหัวหน้าทีมบัญชีสักทีม
  const { data } = await db
    .from("teams")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("lead_employee_id", employeeId)
    .eq("type", "accounting")
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  return !!(data as { id?: string } | null)?.id;
}

/**
 * ผูก/re-link LINE userId เข้ากับ record พนักงานเดิมที่เลือก (update ไม่สร้างใหม่)
 * ตรวจก่อนผูก:
 *   - มีจริงใน tenant, active, ไม่ลบ
 *   - เป็น accountant หรือ หัวหน้าทีมบัญชี
 *
 * ★ re-link เสมอ (แก้เคสจริง): overwrite line_user_id ด้วย userId ปัจจุบันที่ verify จาก
 *   login channel ปัจจุบันเสมอ — แม้ record จะเคยมี line_user_id เก่า (stale จาก channel เดิม
 *   ที่ทำให้ login ไม่ได้) ก็ทับด้วยของใหม่ให้เข้าได้
 * การจัดการเคสชนกัน:
 *   - ถ้า userId ปัจจุบันนี้เคยไปผูกกับ "อีก record" ไว้ → ปลด line_user_id ของ record นั้นทิ้งก่อน
 *     เพื่อให้ผลลัพธ์สุดท้าย = LINE นี้ชี้มาที่ record ที่เลือก "เท่านั้น" (ไม่ค้างผูกซ้อน)
 */
async function verifyAndLinkExistingEmployee(
  db: DB,
  tenantId: string,
  employeeId: string,
  input: RegisterStaffInput
): Promise<{ id: string; created: boolean; displayName: string }> {
  const { data, error } = await db
    .from("employees")
    .select("id, first_name, nickname, line_user_id, employee_type, is_active")
    .eq("id", employeeId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const emp = data as {
    id?: string;
    first_name?: string | null;
    nickname?: string | null;
    line_user_id?: string | null;
    employee_type?: string | null;
    is_active?: boolean | null;
  } | null;

  if (!emp?.id) throw new Error("ไม่พบรายชื่อพนักงานที่เลือก");
  if (emp.is_active === false) throw new Error("รายชื่อนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแล");

  const eligible = await isAccountingEligible(db, tenantId, emp.id, emp.employee_type);
  if (!eligible) throw new Error("รายชื่อนี้ไม่ใช่นักบัญชี กรุณาติดต่อผู้ดูแล");

  // ★ ไม่บล็อกกรณี record มี line_user_id เก่าอยู่ — ตั้งใจ re-link ทับด้วย userId ปัจจุบัน
  //   (เคสจริง: userId เก่า stale จาก channel เดิม → login ไม่ได้ ต้องทับให้เข้าได้)

  // (1) ปลด LINE นี้ออกจากทุก record เดิมในกองก่อน (เผื่อ userId ปัจจุบันเคยไปผูก record อื่น)
  //     → กัน userId ค้างผูกกับหลาย record; เดี๋ยวขั้น (2) ค่อยผูกกลับที่ record ที่เลือก
  const { error: unlinkErr } = await db
    .from("employees")
    .update({ line_user_id: null })
    .eq("tenant_id", tenantId)
    .eq("line_user_id", input.userId);
  if (unlinkErr) throw new Error(unlinkErr.message);

  // (2) ผูก LINE เข้ากับ record ที่เลือก + เติมชื่อ "เฉพาะเมื่อของเดิมว่าง"
  //     (คงชื่อจริง/ชื่อเล่นเดิมในระบบไว้ ไม่ทับด้วยชื่อจากฟอร์ม)
  const patch: Record<string, unknown> = { line_user_id: input.userId };
  if (!emp.first_name?.trim() && input.name?.trim()) patch.first_name = input.name.trim();
  if (!emp.nickname?.trim() && input.nickname?.trim()) patch.nickname = input.nickname.trim();

  const { error: linkErr } = await db
    .from("employees")
    .update(patch)
    .eq("id", employeeId)
    .eq("tenant_id", tenantId);
  if (linkErr) throw new Error(linkErr.message);

  const displayName =
    emp.nickname?.trim() || emp.first_name?.trim() || input.nickname?.trim() || input.name;
  return { id: employeeId, created: false, displayName };
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
  //   ★ [sec-a] บังคับ type='accounting' ให้ตรงกับเส้น teamName (กันผูกทีมที่ไม่ใช่บัญชี)
  if (input.teamId) {
    const { data } = await db
      .from("teams")
      .select("id, name")
      .eq("id", input.teamId)
      .eq("tenant_id", tenantId)
      .eq("type", "accounting")
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
  // 1) หา/ผูกพนักงาน:
  //    - ส่ง employeeId มา → ผูก LINE เข้า record เดิมที่เลือก (ไม่สร้างใหม่)
  //    - ไม่ส่ง → พฤติกรรมเดิม (upsert by line_user_id / สร้างใหม่) เพื่อ backward compat
  const employee = input.employeeId
    ? await verifyAndLinkExistingEmployee(db, tenantId, input.employeeId, input)
    : await upsertEmployeeByLineUser(db, tenantId, input);

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
    // เส้นเลือก record เดิม = ใช้ชื่อจริงในระบบ; เส้นสร้างใหม่ = ชื่อจากฟอร์ม
    employeeName: employee.displayName,
    created: employee.created,
    teamLinked: !!team,
    teamName: team?.name ?? null,
    propagatedGroups,
  };
}
