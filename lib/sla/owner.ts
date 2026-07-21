import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolve owner/หัวหน้าทีมของเคส
 *   ★ owner ของเคส = นักบัญชีผู้ดูแล "กลุ่มแชต" ที่เคสนั้นอยู่
 *     (chat_groups.responsible_employee_id — แอดมินตั้งผ่านหน้ามอบหมาย)
 *
 *   เดิม owner มาจาก customer_assignments (effective-dated) แต่ระบบย้ายการมอบหมาย
 *   มาผูกที่ระดับ "กลุ่มแชต" แล้ว (group-based) → customer_assignments ไม่ถูกเขียนอีก
 *   จึงต้อง resolve owner จากกลุ่มแทน ไม่งั้น owner=null และประเมิน/SLA พัง
 *
 *   หมายเหตุ: resolveTeamLead (escalation) ยังอ่าน customer_assignments อยู่ (คนละเรื่อง)
 */

export type CaseOwner = {
  employeeId: string;
  teamId: string | null;
};

type AssignmentRow = {
  employee_id: string;
  team_id: string | null;
  role: string;
  valid_from: string;
  valid_to: string | null;
};

/** offset เวลาไทย (Asia/Bangkok, UTC+7) เป็นมิลลิวินาที */
const THAI_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * yyyy-mm-dd ของ "วันไทย" (ใช้เทียบกับ valid_from/valid_to ซึ่งเป็น date ตามเวลาไทย)
 *   ★ M4: ต้องเลื่อนเป็นเวลาไทยก่อน slice — ไม่งั้นช่วง 00:00–07:00 ไทยจะได้วัน UTC ที่ผิด (off-by-one)
 */
function toThaiDateStr(at: Date): string {
  return new Date(at.getTime() + THAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** โหลด assignment ที่ยัง effective ณ วันที่ at สำหรับลูกค้ารายนี้ (scope ด้วย tenant explicit) */
async function loadEffectiveAssignments(
  db: SupabaseClient,
  tenantId: string,
  customerId: string,
  at: Date
): Promise<AssignmentRow[]> {
  const atStr = toThaiDateStr(at);
  const { data } = await db
    .from("customer_assignments")
    .select("employee_id, team_id, role, valid_from, valid_to")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .lte("valid_from", atStr);
  const rows = (data ?? []) as AssignmentRow[];
  // กรอง valid_to ฝั่ง JS (รองรับ null = ปัจจุบัน) — เลี่ยง or() ซับซ้อนบน PostgREST
  return rows.filter((r) => r.valid_to === null || r.valid_to >= atStr);
}

/**
 * ทีมปัจจุบันของนักบัญชี (best-effort เอาทีมแรกที่ยัง active)
 *   team_members: valid_to is null + deleted_at is null + tenant ตรง
 *   คืน null ถ้าไม่พบ (พนักงานยังไม่อยู่ทีมใด)
 */
async function resolveCurrentTeamId(
  db: SupabaseClient,
  tenantId: string,
  employeeId: string
): Promise<string | null> {
  const { data } = await db
    .from("team_members")
    .select("team_id")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .is("valid_to", null)
    .is("deleted_at", null)
    .limit(1);
  const rows = (data ?? []) as { team_id: string | null }[];
  return rows[0]?.team_id ?? null;
}

/**
 * หา owner ของเคส = นักบัญชีผู้ดูแลกลุ่มแชต (chat_groups.responsible_employee_id)
 *   chatGroupId = null → null (ไม่ทราบกลุ่ม → ไม่มี owner)
 *   กลุ่มไม่มีผู้ดูแล (responsible_employee_id null) → null
 *   teamId = ทีมปัจจุบันของนักบัญชีคนนั้น (best-effort จาก team_members)
 */
export async function resolveCaseOwner(
  db: SupabaseClient,
  tenantId: string,
  chatGroupId: string | null
): Promise<CaseOwner | null> {
  if (!chatGroupId) return null;
  const { data } = await db
    .from("chat_groups")
    .select("responsible_employee_id")
    .eq("tenant_id", tenantId)
    .eq("id", chatGroupId)
    .is("deleted_at", null)
    // เฉพาะกลุ่มจริง (group/room) — บทสนทนา 1-1 (group_kind='user') ไม่มีนักบัญชีผู้ดูแล
    .in("group_kind", ["group", "room"])
    .maybeSingle();
  const employeeId = (data as { responsible_employee_id: string | null } | null)
    ?.responsible_employee_id;
  if (!employeeId) return null;
  const teamId = await resolveCurrentTeamId(db, tenantId, employeeId);
  return { employeeId, teamId };
}

/**
 * หาหัวหน้าทีมสำหรับ escalate (owner→lead)
 *   1) teams.lead_employee_id ของทีมที่ผูกกับ assignment (ถ้ามี team)
 *   2) fallback: assignment role='lead' ของลูกค้ารายนั้น ณ เวลานั้น
 *   คืน employeeId ของหัวหน้า (best-effort → null ถ้าหาไม่เจอ)
 *
 *   ★ ยังอ่านจาก customer_assignments อยู่ (escalation เป็นคนละโดเมนกับ owner)
 *     เมื่อ customer_assignments ว่าง fallback (2) จะคืน null — เป็น follow-up
 *     แยกต่างหากถ้าจะย้าย escalation มาใช้ group/team ของ owner ด้วย
 */
export async function resolveTeamLead(
  db: SupabaseClient,
  tenantId: string,
  customerId: string | null,
  teamId: string | null,
  at: Date
): Promise<string | null> {
  let rows: AssignmentRow[] | null = null;
  let resolvedTeamId = teamId;

  // ไม่ได้รับ teamId มา → หา team จาก assignment ปัจจุบันของลูกค้า
  if (!resolvedTeamId && customerId) {
    rows = await loadEffectiveAssignments(db, tenantId, customerId, at);
    const withTeam = rows.find((r) => r.team_id);
    if (withTeam) resolvedTeamId = withTeam.team_id;
  }

  if (resolvedTeamId) {
    const { data: team } = await db
      .from("teams")
      .select("lead_employee_id")
      .eq("tenant_id", tenantId)
      .eq("id", resolvedTeamId)
      .maybeSingle();
    const leadId = (team as { lead_employee_id: string | null } | null)?.lead_employee_id;
    if (leadId) return leadId;
  }

  // fallback: assignment role='lead' ของลูกค้ารายนั้น ณ เวลานั้น
  if (customerId) {
    rows = rows ?? (await loadEffectiveAssignments(db, tenantId, customerId, at));
    const lead = rows.find((r) => r.role === "lead");
    if (lead) return lead.employee_id;
  }
  return null;
}
