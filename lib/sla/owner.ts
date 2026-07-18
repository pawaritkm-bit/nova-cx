import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolve owner/หัวหน้าทีมของเคส จาก customer_assignments (effective-dated)
 *   ★ owner ของเคส = นักบัญชีที่ดูแลลูกค้ารายนั้น "ณ เวลานั้น"
 *     (แม้ยัง map สมาชิก LINE→พนักงานไม่ได้ ก็รู้ owner ผ่าน assignment ได้)
 *
 * effective-dated: valid_from <= at และ (valid_to is null หรือ valid_to >= at)
 *   เลือกผู้ดูแลตรง (member/coordinator) ก่อน แล้วค่อย lead — best-effort (หาไม่เจอ = null)
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

/** yyyy-mm-dd ของวันที่ (ใช้เทียบกับ valid_from/valid_to ซึ่งเป็น date) */
function toDateStr(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** โหลด assignment ที่ยัง effective ณ วันที่ at สำหรับลูกค้ารายนี้ */
async function loadEffectiveAssignments(
  db: SupabaseClient,
  customerId: string,
  at: Date
): Promise<AssignmentRow[]> {
  const atStr = toDateStr(at);
  const { data } = await db
    .from("customer_assignments")
    .select("employee_id, team_id, role, valid_from, valid_to")
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .lte("valid_from", atStr);
  const rows = (data ?? []) as AssignmentRow[];
  // กรอง valid_to ฝั่ง JS (รองรับ null = ปัจจุบัน) — เลี่ยง or() ซับซ้อนบน PostgREST
  return rows.filter((r) => r.valid_to === null || r.valid_to >= atStr);
}

/** ลำดับความสำคัญของ role ในการเป็น "owner" (ผู้ดูแลตรงก่อนหัวหน้า) */
function ownerRank(role: string): number {
  if (role === "member") return 0;
  if (role === "coordinator") return 1;
  if (role === "lead") return 2;
  return 3;
}

/**
 * หา owner ของเคส (นักบัญชีผู้ดูแลลูกค้า ณ เวลานั้น)
 *   customerId = null → null (ยังจับคู่กลุ่ม↔ลูกค้าไม่ได้ → ไม่มี owner)
 */
export async function resolveCaseOwner(
  db: SupabaseClient,
  customerId: string | null,
  at: Date
): Promise<CaseOwner | null> {
  if (!customerId) return null;
  const rows = await loadEffectiveAssignments(db, customerId, at);
  if (rows.length === 0) return null;
  rows.sort((a, b) => ownerRank(a.role) - ownerRank(b.role));
  const pick = rows[0];
  return { employeeId: pick.employee_id, teamId: pick.team_id };
}

/**
 * หาหัวหน้าทีมสำหรับ escalate (owner→lead)
 *   1) teams.lead_employee_id ของทีมที่ผูกกับ assignment (ถ้ามี team)
 *   2) fallback: assignment role='lead' ของลูกค้ารายนั้น ณ เวลานั้น
 *   คืน employeeId ของหัวหน้า (best-effort → null ถ้าหาไม่เจอ)
 */
export async function resolveTeamLead(
  db: SupabaseClient,
  customerId: string | null,
  teamId: string | null,
  at: Date
): Promise<string | null> {
  let rows: AssignmentRow[] | null = null;
  let resolvedTeamId = teamId;

  // ไม่ได้รับ teamId มา → หา team จาก assignment ปัจจุบันของลูกค้า
  if (!resolvedTeamId && customerId) {
    rows = await loadEffectiveAssignments(db, customerId, at);
    const withTeam = rows.find((r) => r.team_id);
    if (withTeam) resolvedTeamId = withTeam.team_id;
  }

  if (resolvedTeamId) {
    const { data: team } = await db
      .from("teams")
      .select("lead_employee_id")
      .eq("id", resolvedTeamId)
      .maybeSingle();
    const leadId = (team as { lead_employee_id: string | null } | null)?.lead_employee_id;
    if (leadId) return leadId;
  }

  // fallback: assignment role='lead' ของลูกค้ารายนั้น ณ เวลานั้น
  if (customerId) {
    rows = rows ?? (await loadEffectiveAssignments(db, customerId, at));
    const lead = rows.find((r) => r.role === "lead");
    if (lead) return lead.employee_id;
  }
  return null;
}
