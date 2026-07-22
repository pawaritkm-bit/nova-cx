/**
 * Admin workload — "ผังภาระงานแบบทีม" (หัวหน้าทีม → นักบัญชีในทีม → ลูกค้าที่ดูแล)
 *
 * แสดงในแท็บ "ภาระงาน" ของหน้า /admin แบบการ์ดต่อทีม:
 *   - แต่ละทีม: ชื่อ + ประเภทลูกค้าที่รับดูแล (บริษัท/บุคคลธรรมดา) + จำนวนลูกค้ารวมของทีม
 *   - หัวหน้าทีม (👑) อยู่แถวบนสุด (จาก teams.lead_employee_id)
 *   - นักบัญชีในทีมเรียงต่อมา แต่ละคนกางดูรายชื่อลูกค้า (customer_code + name) ได้
 *   - นักบัญชีที่ไม่สังกัดทีม → กลุ่ม "ไม่สังกัดทีม" ท้ายสุด
 *
 * แหล่งข้อมูล "ลูกค้าที่นักบัญชีดูแล" = chat_groups linkage (แหล่งเดียวกับหน้ามอบหมาย/ตรวจแชต):
 *   - responsible_employee_id = พนักงานคนนั้น  (กลุ่มมีนักบัญชีผู้ดูแล)
 *   - customer_id is not null                   (กลุ่มจับคู่ลูกค้าแล้ว)
 *   - group_kind in ('group','room')            (กลุ่มจริง ไม่ใช่บทสนทนา 1-1)
 *   - deleted_at is null (กลุ่มยังใช้งานอยู่) + tenant_id ตรง session
 *   และลูกค้าต้องยังไม่ถูกปิดใช้งาน (customers.deleted_at null)
 *   ★ นับ distinct customer ต่อคน/ต่อทีม (ลูกค้าเดียวหลายกลุ่ม → นับครั้งเดียว)
 *
 * ทีม/หัวหน้า/สมาชิก: teams (lead_employee_id, handles_customer_type) +
 *   team_members (valid_to null, deleted_at null, role_in_team)
 *
 * ★ assembleTeamWorkload เป็นฟังก์ชันบริสุทธิ์ (ไม่แตะ DB) → unit test ได้แน่นอน
 * ★ ทุก query กรอง tenant_id "จาก session" เสมอ — ไม่นับข้าม tenant
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

/** เพดานแถวต่อ query (กันดึงเยอะเกินจนหน้าอืด) */
const WORKLOAD_LIMIT = 5000;

/** ประเภทลูกค้าที่ทีมรับดูแล */
export type CustomerType = "company" | "individual";

/** ลูกค้า 1 รายที่นักบัญชีดูแล (โชว์ในรายการที่กางออก) */
export type WorkloadCustomer = {
  customer_id: string;
  /** รหัสลูกค้า (customer_code) — null = ยังไม่มีรหัส */
  code: string | null;
  name: string;
};

/** ภาระงานของนักบัญชี 1 คน (ใช้ทั้งในทีมและกลุ่มไม่สังกัดทีม) */
export type WorkloadMember = {
  employee_id: string;
  /** ชื่อแสดงผล: "ชื่อจริง (ชื่อเล่น)" ถ้ามีชื่อเล่น */
  name: string;
  /** true = หัวหน้าทีม */
  is_lead: boolean;
  /** จำนวนลูกค้าที่ดูแลอยู่ตอนนี้ (distinct) */
  total: number;
  company: number;
  individual: number;
  unspecified: number;
  /** รายชื่อลูกค้าที่ดูแล (เรียงตามชื่อ) */
  customers: WorkloadCustomer[];
};

/** ทีม 1 ทีม พร้อมสมาชิกและยอดรวม */
export type WorkloadTeam = {
  team_id: string;
  name: string;
  /** ประเภทลูกค้าที่ทีมนี้รับดูแล — null = ไม่ระบุ */
  handles_customer_type: CustomerType | null;
  /** ชื่อหัวหน้าทีม — null = ยังไม่มีหัวหน้า */
  lead_name: string | null;
  /** จำนวนลูกค้ารวมของทั้งทีม (distinct) */
  total: number;
  company: number;
  individual: number;
  unspecified: number;
  members: WorkloadMember[];
};

/** โครงผังภาระงานทั้งหมด: ทีม + กลุ่มนักบัญชีที่ไม่สังกัดทีม */
export type TeamWorkload = {
  teams: WorkloadTeam[];
  /** นักบัญชีที่มีลูกค้าดูแลแต่ไม่สังกัดทีมใด */
  unassigned: WorkloadMember[];
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
  employees: EmployeeName | EmployeeName[] | null;
};

/** แถวจับคู่ "กลุ่ม → ลูกค้า + นักบัญชีผู้ดูแล" จาก chat_groups */
type GroupLinkRow = {
  responsible_employee_id: string;
  customer_id: string;
  responsible: EmployeeName | EmployeeName[] | null;
  customers:
    | { customer_code?: string | null; name?: string | null; customer_type?: string | null; deleted_at?: string | null }
    | { customer_code?: string | null; name?: string | null; customer_type?: string | null; deleted_at?: string | null }[]
    | null;
};

type EmployeeName = { first_name?: string | null; nickname?: string | null };

/** อ่าน relation แบบ to-one ที่ PostgREST อาจคืนเป็น object หรือ array */
function readOne<T>(rel: unknown): T | null {
  if (Array.isArray(rel)) return (rel[0] as T) ?? null;
  return (rel as T) ?? null;
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

/** ลูกค้า 1 รายในบัญชีสะสมต่อพนักงาน (เก็บ type ไว้คิดยอดแยกประเภทระดับทีม) */
type CustomerAgg = { code: string | null; name: string; type: CustomerType | null };

/** บัญชีสะสมต่อพนักงาน: ชื่อ (จาก linkage) + ลูกค้า distinct */
type EmployeeAgg = {
  name: string | null;
  customers: Map<string, CustomerAgg>;
};

/** สร้าง node ภาระงานของพนักงาน 1 คนจากบัญชีสะสม (นับ + แยกประเภท + เรียงลูกค้า) */
function buildMemberNode(
  employeeId: string,
  name: string,
  isLead: boolean,
  agg: EmployeeAgg | undefined
): WorkloadMember {
  let company = 0;
  let individual = 0;
  let unspecified = 0;
  const customers: WorkloadCustomer[] = [];
  if (agg) {
    for (const [customerId, c] of agg.customers) {
      customers.push({ customer_id: customerId, code: c.code, name: c.name });
      if (c.type === "company") company += 1;
      else if (c.type === "individual") individual += 1;
      else unspecified += 1;
    }
  }
  // เรียงลูกค้าตามชื่อให้ผลคงที่
  customers.sort((a, b) => a.name.localeCompare(b.name, "th"));
  return {
    employee_id: employeeId,
    name,
    is_lead: isLead,
    total: customers.length,
    company,
    individual,
    unspecified,
    customers,
  };
}

// ---------------------------------------------------------------------
// assemble (ฟังก์ชันบริสุทธิ์ — ไม่แตะ DB)
// ---------------------------------------------------------------------
/**
 * ประกอบผังภาระงานจากแถวดิบ (teams + team_members + chat_groups linkage + ชื่อหัวหน้า)
 *   - นับ/ลิสต์ลูกค้าต่อนักบัญชี จากกลุ่มที่ดูแล (dedup ตาม customer_id) ข้ามลูกค้าปิดใช้งาน
 *   - หัวหน้าทีม = employee ตรง teams.lead_employee_id หรือ role_in_team 'lead'
 *   - หัวหน้าที่ไม่อยู่ใน team_members ก็ยังแสดงบนสุด (ใช้ชื่อจาก leadNames)
 *   - นักบัญชีที่มีลูกค้าแต่ไม่สังกัดทีมใด → กลุ่ม unassigned
 */
export function assembleTeamWorkload(
  teams: TeamRow[],
  members: MemberRow[],
  groupLinks: GroupLinkRow[],
  leadNames: Map<string, EmployeeName> = new Map()
): TeamWorkload {
  // 1) ลูกค้าต่อนักบัญชี — จากกลุ่มที่ดูแล, dedup ตาม customer_id, ข้ามลูกค้าปิดใช้งาน
  const byEmployee = new Map<string, EmployeeAgg>();
  for (const link of groupLinks) {
    const empId = link.responsible_employee_id;
    if (!empId || !link.customer_id) continue;
    const cust = readOne<{
      customer_code?: string | null;
      name?: string | null;
      customer_type?: string | null;
      deleted_at?: string | null;
    }>(link.customers);
    if (cust?.deleted_at) continue; // ลูกค้าปิดใช้งาน → ไม่นับ

    let agg = byEmployee.get(empId);
    if (!agg) {
      const emp = readOne<EmployeeName>(link.responsible);
      agg = { name: displayName(emp?.first_name, emp?.nickname), customers: new Map() };
      byEmployee.set(empId, agg);
    }
    if (agg.customers.has(link.customer_id)) continue; // ลูกค้าเดียวหลายกลุ่ม → นับครั้งเดียว
    agg.customers.set(link.customer_id, {
      code: cust?.customer_code ?? null,
      name: (cust?.name ?? "").trim() || "ไม่ระบุชื่อลูกค้า",
      type: normalizeCustomerType(cust?.customer_type),
    });
  }

  // 2) สมาชิกต่อทีม + เซตของพนักงานที่สังกัดทีมใดทีมหนึ่ง
  const membersByTeam = new Map<string, MemberRow[]>();
  const assignedEmployeeIds = new Set<string>();
  for (const m of members) {
    if (!m.team_id || !m.employee_id) continue;
    const list = membersByTeam.get(m.team_id) ?? [];
    list.push(m);
    membersByTeam.set(m.team_id, list);
    assignedEmployeeIds.add(m.employee_id);
  }

  // 3) ประกอบต่อทีม
  const teamNodes: WorkloadTeam[] = teams.map((t) => {
    const rawMembers = membersByTeam.get(t.id) ?? [];
    const memberIds = new Set(rawMembers.map((m) => m.employee_id));

    const memberNodes: WorkloadMember[] = rawMembers.map((m) => {
      const emp = readOne<EmployeeName>(m.employees);
      const isLead = m.employee_id === t.lead_employee_id || m.role_in_team === "lead";
      const agg = byEmployee.get(m.employee_id);
      const name = agg?.name ?? displayName(emp?.first_name, emp?.nickname);
      // ★ ชื่อจาก team_members embed แม่นกว่า (มาจากตาราง employees ตรง ๆ) — ใช้ก่อน
      const preferName = displayName(emp?.first_name, emp?.nickname);
      return buildMemberNode(
        m.employee_id,
        preferName !== "ไม่ระบุชื่อ" ? preferName : name,
        isLead,
        agg
      );
    });

    // หัวหน้าทีมที่ไม่อยู่ใน team_members → เพิ่มเป็น node บนสุด (ใช้ชื่อจาก leadNames/linkage)
    if (t.lead_employee_id && !memberIds.has(t.lead_employee_id)) {
      const leadId = t.lead_employee_id;
      const agg = byEmployee.get(leadId);
      const leadEmp = leadNames.get(leadId);
      const name =
        (leadEmp && displayName(leadEmp.first_name, leadEmp.nickname)) ||
        agg?.name ||
        "ไม่ระบุชื่อ";
      memberNodes.push(buildMemberNode(leadId, name, true, agg));
    }

    // เรียงสมาชิก: หัวหน้าก่อน → ลูกค้ามาก→น้อย → ชื่อ
    memberNodes.sort((a, b) => {
      if (a.is_lead !== b.is_lead) return a.is_lead ? -1 : 1;
      if (a.total !== b.total) return b.total - a.total;
      return a.name.localeCompare(b.name, "th");
    });

    // ยอดรวมทีม (distinct ทั้งทีม) + แยกประเภท — union customer จากทุกสมาชิก
    const teamCustomers = new Map<string, CustomerType | null>();
    for (const node of memberNodes) {
      const agg = byEmployee.get(node.employee_id);
      if (!agg) continue;
      for (const [customerId, c] of agg.customers) {
        if (!teamCustomers.has(customerId)) teamCustomers.set(customerId, c.type);
      }
    }
    let company = 0;
    let individual = 0;
    let unspecified = 0;
    for (const type of teamCustomers.values()) {
      if (type === "company") company += 1;
      else if (type === "individual") individual += 1;
      else unspecified += 1;
    }

    const lead = memberNodes.find((m) => m.is_lead) ?? null;

    return {
      team_id: t.id,
      name: t.name,
      handles_customer_type: normalizeCustomerType(t.handles_customer_type),
      lead_name: lead?.name ?? null,
      total: teamCustomers.size,
      company,
      individual,
      unspecified,
      members: memberNodes,
    };
  });

  // เรียงทีม: ประเภท (บริษัท→บุคคล→ไม่ระบุ) แล้วชื่อ
  teamNodes.sort((a, b) => {
    const ra = TYPE_ORDER[a.handles_customer_type ?? ""] ?? 2;
    const rb = TYPE_ORDER[b.handles_customer_type ?? ""] ?? 2;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, "th");
  });

  // 4) นักบัญชีที่ไม่สังกัดทีม (มีลูกค้าดูแลแต่ไม่อยู่ใน team_members)
  const unassigned: WorkloadMember[] = [];
  for (const [empId, agg] of byEmployee) {
    if (assignedEmployeeIds.has(empId)) continue;
    unassigned.push(buildMemberNode(empId, agg.name ?? "ไม่ระบุชื่อ", false, agg));
  }
  unassigned.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "th"));

  return { teams: teamNodes, unassigned };
}

// ---------------------------------------------------------------------
// DB: ดึง + ประกอบผังภาระงานทั้งสำนักงาน (scope tenant จาก session)
// ---------------------------------------------------------------------
/**
 * ดึงผังภาระงานแบบทีมของทั้ง tenant
 *   - หน้า /admin guard ไว้แล้ว (admin/executive) → แสดงทุกทีมใน tenant
 *   - tenantId มาจาก session เท่านั้น
 */
export async function getTeamWorkload(db: DB, tenantId: string): Promise<TeamWorkload> {
  // 1) ทีมทั้งหมดใน tenant (ยังไม่ถูกลบ)
  const { data: teamData, error: teamErr } = await db
    .from("teams")
    .select("id, name, handles_customer_type, lead_employee_id")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .limit(WORKLOAD_LIMIT);
  if (teamErr) throw new Error(teamErr.message);
  const teams = (teamData ?? []) as TeamRow[];
  const teamIds = teams.map((t) => t.id);

  // 2) สมาชิกทีมปัจจุบัน + ชื่อพนักงาน (valid_to null, deleted_at null)
  let members: MemberRow[] = [];
  if (teamIds.length > 0) {
    const { data: memberData, error: memErr } = await db
      .from("team_members")
      .select("team_id, employee_id, role_in_team, employees(first_name, nickname)")
      .eq("tenant_id", tenantId)
      .in("team_id", teamIds)
      .is("valid_to", null)
      .is("deleted_at", null)
      .limit(WORKLOAD_LIMIT);
    if (memErr) throw new Error(memErr.message);
    members = (memberData ?? []) as unknown as MemberRow[];
  }

  // 3) ลูกค้าที่ดูแล — จากกลุ่มทั้ง tenant (รวมนักบัญชีที่ไม่สังกัดทีมด้วย)
  const { data: linkData, error: linkErr } = await db
    .from("chat_groups")
    .select(
      "responsible_employee_id, customer_id, responsible:employees!responsible_employee_id(first_name, nickname), customers(customer_code, name, customer_type, deleted_at)"
    )
    .eq("tenant_id", tenantId)
    .not("responsible_employee_id", "is", null)
    .not("customer_id", "is", null)
    .in("group_kind", ["group", "room"])
    .is("deleted_at", null)
    .limit(WORKLOAD_LIMIT);
  if (linkErr) throw new Error(linkErr.message);
  const groupLinks = (linkData ?? []) as unknown as GroupLinkRow[];

  // 4) ชื่อหัวหน้าทีม (เผื่อหัวหน้าไม่อยู่ใน team_members) — best-effort
  const leadIds = [...new Set(teams.map((t) => t.lead_employee_id).filter(Boolean) as string[])];
  const leadNames = new Map<string, EmployeeName>();
  if (leadIds.length > 0) {
    const { data: leadData, error: leadErr } = await db
      .from("employees")
      .select("id, first_name, nickname")
      .eq("tenant_id", tenantId)
      .in("id", leadIds)
      .limit(WORKLOAD_LIMIT);
    if (leadErr) throw new Error(leadErr.message);
    for (const e of (leadData ?? []) as { id: string; first_name?: string | null; nickname?: string | null }[]) {
      leadNames.set(e.id, { first_name: e.first_name ?? null, nickname: e.nickname ?? null });
    }
  }

  return assembleTeamWorkload(teams, members, groupLinks, leadNames);
}
