/**
 * Team Org Tree — data layer สำหรับหน้า /chat-audit/teams
 *   แสดง "ผังทีมบัญชี" แบบอ่านง่าย: หัวหน้าทีม → นักบัญชีในทีม → ลูกค้าที่ดูแล
 *
 * ★ ความปลอดภัย / มัลติเทแนนต์:
 *   - ทุก query กรอง tenant_id "จาก session" (ส่งเข้ามาเป็นพารามิเตอร์ — ห้ามรับจาก client)
 *     + ใช้ scoped client (RLS tenant_isolation) เป็นชั้นกันซ้ำ
 *   - ขอบเขตการมองเห็น (allow-list / default-deny):
 *       · privileged (admin / executive / acc_lead) → เห็นทุกทีมใน tenant
 *       · accountant                                → เห็นเฉพาะทีมที่ตัวเองสังกัด
 *       · role อื่น/null                             → คืน [] (หน้าโชว์ deny)
 *   - customers.name เป็น plaintext (ไม่ต้อง decrypt) — ตามสเปกตาราง customers
 *
 * ★ การนับ "ลูกค้าที่ดูแลปัจจุบัน" ใช้นิยามเดียวกับ lib/admin/workload.ts:
 *     valid_to null (ยังดูแลอยู่) + deleted_at null + valid_from ≤ วันนี้ (เริ่มมีผลแล้ว)
 *     และลูกค้าต้องยังไม่ถูกปิดใช้งาน (customers.deleted_at null)
 *
 * ★ ฟังก์ชัน assembleTeamStructure เป็นฟังก์ชันบริสุทธิ์ (ไม่แตะ DB) → unit test ได้แน่นอน
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Viewer } from "@/lib/evaluation/access";

type DB = SupabaseClient;

/** เพดานแถวต่อ query (กันดึงเยอะเกินจนหน้าอืด) */
const TEAM_LIMIT = 2000;

/** บทบาทที่เห็น "ทุกทีม" ใน tenant */
const TEAM_PRIVILEGED_ROLES = ["admin", "executive", "acc_lead"] as const;

/** true = บทบาทเห็นได้ทุกทีม */
function isTeamPrivileged(role: string | null | undefined): boolean {
  return !!role && (TEAM_PRIVILEGED_ROLES as readonly string[]).includes(role);
}

/**
 * true = บทบาทเข้าหน้าโครงสร้างทีมได้ (privileged หรือ accountant)
 *   ★ default-deny — role null/ไม่รู้จัก = false เสมอ
 */
export function canSeeTeamStructure(role: string | null | undefined): boolean {
  return isTeamPrivileged(role) || role === "accountant";
}

export type CustomerType = "company" | "individual";

/** ลูกค้า 1 รายที่นักบัญชีดูแล (โชว์ในรายการที่กางออก) */
export type TeamCustomer = {
  code: string | null;
  name: string;
};

/** นักบัญชี 1 คนในทีม */
export type TeamMemberNode = {
  employeeId: string;
  /** ชื่อแสดงผล (first_name + (nickname) ถ้ามี) */
  name: string;
  /** true = หัวหน้าทีม */
  isLead: boolean;
  /** จำนวนลูกค้าที่ดูแลอยู่ตอนนี้ */
  customerCount: number;
  /** รายชื่อลูกค้าที่ดูแล (code + name) */
  customers: TeamCustomer[];
};

/** ทีม 1 ทีม */
export type TeamNode = {
  teamId: string;
  name: string;
  /** ประเภทลูกค้าที่ทีมนี้รับดูแล (บริษัท/บุคคลธรรมดา) — null = ไม่ระบุ */
  handlesCustomerType: CustomerType | null;
  /** ชื่อหัวหน้าทีม — null = ยังไม่มีหัวหน้า */
  leaderName: string | null;
  /** จำนวนลูกค้ารวมของทั้งทีม (นับ distinct customer) */
  totalCustomers: number;
  members: TeamMemberNode[];
};

// ---------------------------------------------------------------------
// แถวดิบจาก DB (เท่าที่หน้าใช้)
// ---------------------------------------------------------------------
type TeamRow = {
  id: string;
  name: string;
  handles_customer_type: string | null;
  lead_employee_id: string | null;
};

type MemberRow = {
  team_id: string;
  employee_id: string;
  role_in_team: string | null;
  employees: { first_name?: string | null; nickname?: string | null; deleted_at?: string | null } | null;
};

type AssignmentRow = {
  employee_id: string;
  customer_id: string;
  customers: { customer_code?: string | null; name?: string | null; deleted_at?: string | null } | null;
};

/** อ่าน relation แบบ to-one ที่ PostgREST อาจคืนเป็น object หรือ array */
function readOne<T>(rel: unknown): T | null {
  if (Array.isArray(rel)) return (rel[0] as T) ?? null;
  return (rel as T) ?? null;
}

/** วันที่วันนี้ YYYY-MM-DD (ใช้กรอง active assignment) */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** ชื่อแสดงผลของนักบัญชี: "ชื่อจริง (ชื่อเล่น)" ถ้ามีชื่อเล่น */
function displayName(first: string | null | undefined, nick: string | null | undefined): string {
  const f = (first ?? "").trim();
  const n = (nick ?? "").trim();
  if (f && n) return `${f} (${n})`;
  return f || n || "ไม่ระบุชื่อ";
}

/** แปลงค่า handles_customer_type ให้เป็น type ที่รู้จัก (อื่น = null) */
function normalizeCustomerType(v: string | null | undefined): CustomerType | null {
  return v === "company" || v === "individual" ? v : null;
}

/** ลำดับการจัดเรียงทีมตามประเภท (บริษัทก่อน → บุคคลธรรมดา → ไม่ระบุ) */
const TYPE_ORDER: Record<string, number> = { company: 0, individual: 1 };

// ---------------------------------------------------------------------
// assemble (ฟังก์ชันบริสุทธิ์ — ไม่แตะ DB)
// ---------------------------------------------------------------------
/**
 * ประกอบผังทีมจากแถวดิบ 3 ชุด (teams + team_members + customer_assignments)
 *   - นับ/ลิสต์ลูกค้าต่อนักบัญชี (dedup ตาม customer_id, ข้ามลูกค้าที่ถูกปิดใช้งาน)
 *   - หัวหน้าทีม = role_in_team 'lead' หรือ employee ตรงกับ teams.lead_employee_id
 *   - เรียง: หัวหน้าอยู่บนสุด → ลูกค้ามาก→น้อย → ชื่อ; ทีมเรียงตามประเภทแล้วชื่อ
 */
export function assembleTeamStructure(
  teams: TeamRow[],
  members: MemberRow[],
  assignments: AssignmentRow[]
): TeamNode[] {
  // 1) ลูกค้าต่อนักบัญชี — dedup ตาม customer_id, ข้ามลูกค้าที่ถูกปิดใช้งาน
  const seenByEmployee = new Map<string, Set<string>>(); // employeeId → set(customerId)
  const customersByEmployee = new Map<string, TeamCustomer[]>();
  for (const a of assignments) {
    const cust = readOne<{ customer_code?: string | null; name?: string | null; deleted_at?: string | null }>(
      a.customers
    );
    if (cust?.deleted_at) continue; // ลูกค้าปิดใช้งาน → ไม่นับ
    const empId = a.employee_id;
    if (!empId || !a.customer_id) continue;

    let seen = seenByEmployee.get(empId);
    if (!seen) {
      seen = new Set();
      seenByEmployee.set(empId, seen);
      customersByEmployee.set(empId, []);
    }
    if (seen.has(a.customer_id)) continue; // กันนับซ้ำ
    seen.add(a.customer_id);
    customersByEmployee.get(empId)!.push({
      code: cust?.customer_code ?? null,
      name: (cust?.name ?? "").trim() || "ไม่ระบุชื่อลูกค้า",
    });
  }

  // 2) สมาชิกต่อทีม
  const membersByTeam = new Map<string, MemberRow[]>();
  for (const m of members) {
    if (!m.team_id || !m.employee_id) continue;
    const list = membersByTeam.get(m.team_id) ?? [];
    list.push(m);
    membersByTeam.set(m.team_id, list);
  }

  // 3) ประกอบต่อทีม
  const nodes: TeamNode[] = teams.map((t) => {
    const rawMembers = membersByTeam.get(t.id) ?? [];
    const teamCustomerIds = new Set<string>();

    const memberNodes: TeamMemberNode[] = rawMembers.map((m) => {
      const emp = readOne<{ first_name?: string | null; nickname?: string | null }>(m.employees);
      const custs = customersByEmployee.get(m.employee_id) ?? [];
      // สะสม customer id ระดับทีมเพื่อ count distinct (จาก set ต่อ employee)
      for (const cid of seenByEmployee.get(m.employee_id) ?? []) teamCustomerIds.add(cid);
      const isLead = m.role_in_team === "lead" || m.employee_id === t.lead_employee_id;
      // เรียงลูกค้าตามชื่อให้ผลคงที่
      const customers = [...custs].sort((a, b) => a.name.localeCompare(b.name, "th"));
      return {
        employeeId: m.employee_id,
        name: displayName(emp?.first_name, emp?.nickname),
        isLead,
        customerCount: customers.length,
        customers,
      };
    });

    // เรียงสมาชิก: หัวหน้าก่อน → ลูกค้ามาก→น้อย → ชื่อ
    memberNodes.sort((a, b) => {
      if (a.isLead !== b.isLead) return a.isLead ? -1 : 1;
      if (a.customerCount !== b.customerCount) return b.customerCount - a.customerCount;
      return a.name.localeCompare(b.name, "th");
    });

    const leader = memberNodes.find((m) => m.isLead) ?? null;

    return {
      teamId: t.id,
      name: t.name,
      handlesCustomerType: normalizeCustomerType(t.handles_customer_type),
      leaderName: leader?.name ?? null,
      totalCustomers: teamCustomerIds.size,
      members: memberNodes,
    };
  });

  // เรียงทีม: ประเภท (บริษัท→บุคคล→ไม่ระบุ) แล้วชื่อ
  nodes.sort((a, b) => {
    const ra = TYPE_ORDER[a.handlesCustomerType ?? ""] ?? 2;
    const rb = TYPE_ORDER[b.handlesCustomerType ?? ""] ?? 2;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, "th");
  });

  return nodes;
}

// ---------------------------------------------------------------------
// DB: ประกอบผังทีมตามขอบเขตของผู้ใช้
// ---------------------------------------------------------------------
/**
 * ดึง + ประกอบผังทีมตามสิทธิ์ของ viewer
 *   - tenantId มาจาก session (guard) เท่านั้น
 *   - privileged → ทุกทีม; accountant → เฉพาะทีมที่ตัวเองสังกัด; อื่น → []
 */
export async function getTeamStructure(db: DB, tenantId: string, viewer: Viewer): Promise<TeamNode[]> {
  const role = viewer.role;

  // ★ allow-list / default-deny
  if (!canSeeTeamStructure(role)) return [];

  // ขอบเขตทีมที่มองเห็นได้ (null = ทุกทีม)
  let allowedTeamIds: string[] | null = null;
  if (!isTeamPrivileged(role)) {
    // accountant — เห็นเฉพาะทีมที่ตัวเองสังกัด (ต้องมี employeeId)
    if (!viewer.employeeId) return [];
    const { data: myTeams, error: myErr } = await db
      .from("team_members")
      .select("team_id")
      .eq("tenant_id", tenantId)
      .eq("employee_id", viewer.employeeId)
      .is("valid_to", null)
      .is("deleted_at", null)
      .limit(TEAM_LIMIT);
    if (myErr) throw new Error(myErr.message);
    allowedTeamIds = [...new Set((myTeams ?? []).map((r) => (r as { team_id: string }).team_id).filter(Boolean))];
    if (allowedTeamIds.length === 0) return [];
  }

  // 1) ทีม (tenant + soft-delete + ขอบเขต)
  let teamsQuery = db
    .from("teams")
    .select("id, name, handles_customer_type, lead_employee_id")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .limit(TEAM_LIMIT);
  if (allowedTeamIds) teamsQuery = teamsQuery.in("id", allowedTeamIds);
  const { data: teamData, error: teamErr } = await teamsQuery;
  if (teamErr) throw new Error(teamErr.message);
  const teams = (teamData ?? []) as TeamRow[];
  if (teams.length === 0) return [];
  const teamIds = teams.map((t) => t.id);

  // 2) สมาชิกทีมปัจจุบัน + ชื่อพนักงาน (valid_to null, deleted_at null)
  const { data: memberData, error: memErr } = await db
    .from("team_members")
    .select("team_id, employee_id, role_in_team, employees(first_name, nickname, deleted_at)")
    .eq("tenant_id", tenantId)
    .in("team_id", teamIds)
    .is("valid_to", null)
    .is("deleted_at", null)
    .limit(TEAM_LIMIT);
  if (memErr) throw new Error(memErr.message);
  const members = (memberData ?? []) as unknown as MemberRow[];

  // 3) ลูกค้าที่ดูแลปัจจุบันของสมาชิกเหล่านี้
  const employeeIds = [...new Set(members.map((m) => m.employee_id).filter(Boolean))];
  let assignments: AssignmentRow[] = [];
  if (employeeIds.length > 0) {
    const { data: assignData, error: assignErr } = await db
      .from("customer_assignments")
      .select("employee_id, customer_id, customers(customer_code, name, deleted_at)")
      .eq("tenant_id", tenantId)
      .in("employee_id", employeeIds)
      .is("valid_to", null)
      .is("deleted_at", null)
      .lte("valid_from", todayISO())
      .limit(TEAM_LIMIT);
    if (assignErr) throw new Error(assignErr.message);
    assignments = (assignData ?? []) as unknown as AssignmentRow[];
  }

  return assembleTeamStructure(teams, members, assignments);
}
