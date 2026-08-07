/**
 * สโคป "หัวหน้าทีม ↔ ทีมของตัวเอง" สำหรับหน้าลงบันทึกบัญชี
 *
 * หัวหน้า (lead) = teams.lead_employee_id ของทีมใดทีมหนึ่ง (accounting)
 *   - ลูกทีม = สมาชิกทุกทีมที่ตัวเองเป็นหัวหน้า (team_members ที่ยัง active) + ตัวหัวหน้าเอง
 *   - ลูกค้าที่ทีมดูแล = union ของ chat_groups.responsible_employee_id ของสมาชิกทุกคน
 *
 * ★ ทุก query scope ด้วย tenantId (จาก session เท่านั้น) — ไม่เชื่อ client
 * ★ ส่วนรวม/dedupe แยกเป็น pure → unit test ได้แน่นอน
 * ★ PDPA: ไม่ log ชื่อ/รหัสลูกค้า/นักบัญชี
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountantCard } from "@/lib/accounting/accountant-scope";

type DB = SupabaseClient;

/** ประเภททีมของบัญชี (จำกัดหัวหน้าให้เป็นหัวหน้า "ทีมบัญชี" เท่านั้น) */
export const ACCOUNTING_TEAM_TYPE = "accounting";

/**
 * รวม employee ids ของลูกทีม + ตัวหัวหน้าเอง (pure, unique)
 *   - leadEmployeeId มาก่อนเสมอ (มีตัวหัวหน้าอยู่ในทีมแน่นอน)
 *   - กรอง null/ว่าง ทิ้ง
 */
export function mergeTeamMemberIds(
  leadEmployeeId: string,
  memberIds: (string | null | undefined)[]
): string[] {
  const out = new Set<string>();
  if (leadEmployeeId) out.add(leadEmployeeId);
  for (const id of memberIds) {
    if (id) out.add(id);
  }
  return [...out];
}

/** dedupe customer_id (ตัด null/ว่าง) — pure */
export function dedupeCustomerIds(ids: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    if (id) out.add(id);
  }
  return [...out];
}

/**
 * employee ids ของลูกทีมทั้งหมด (สมาชิกทุกทีมที่ lead เป็นหัวหน้า) + ตัวหัวหน้าเอง
 *   - รองรับหัวหน้าหลายทีม (union)
 *   - นับเฉพาะสมาชิกที่ยังอยู่ในทีม (valid_to is null) และยังไม่ถูกลบ
 *   - ไม่พบทีมเลย → คืน [leadEmployeeId] (อย่างน้อยเห็นของตัวเอง)
 */
export async function teamMemberIdsForLead(
  db: DB,
  tenantId: string,
  leadEmployeeId: string
): Promise<string[]> {
  const { data: teamData } = await db
    .from("teams")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("lead_employee_id", leadEmployeeId)
    .is("deleted_at", null);
  const teamIds = [
    ...new Set(
      ((teamData ?? []) as { id: string }[]).map((t) => t.id).filter((x): x is string => !!x)
    ),
  ];
  if (teamIds.length === 0) return [leadEmployeeId];

  const { data: memberData } = await db
    .from("team_members")
    .select("employee_id")
    .eq("tenant_id", tenantId)
    .in("team_id", teamIds)
    .is("valid_to", null)
    .is("deleted_at", null);
  const memberIds = ((memberData ?? []) as { employee_id: string | null }[]).map(
    (m) => m.employee_id
  );
  return mergeTeamMemberIds(leadEmployeeId, memberIds);
}

/**
 * customer_id ทั้งหมดที่ทีมของหัวหน้าดูแล (union ของสมาชิกทุกคน + ตัวหัวหน้า)
 *   ใช้เป็น allowedCustomerIds ของ mode=lead → guard แก้/ยืนยัน/export ให้เฉพาะทีมตัวเอง
 */
export async function customerIdsForLead(
  db: DB,
  tenantId: string,
  leadEmployeeId: string
): Promise<string[]> {
  const memberIds = await teamMemberIdsForLead(db, tenantId, leadEmployeeId);
  if (memberIds.length === 0) return [];

  const { data } = await db
    .from("chat_groups")
    .select("customer_id")
    .eq("tenant_id", tenantId)
    .in("responsible_employee_id", memberIds)
    .is("deleted_at", null);
  return dedupeCustomerIds(
    ((data ?? []) as { customer_id: string | null }[]).map((r) => r.customer_id)
  );
}

/** การ์ดนักบัญชีในทีม (หน้าแรกของหัวหน้า) — เพิ่มสถานะรอตรวจจากการ์ดปกติ */
export type TeamAccountantCard = AccountantCard & {
  /** บิลที่ยืนยันแล้ว */
  confirmedCount: number;
  /** บิลที่ยังเป็นร่าง (ยังไม่ยืนยัน) แต่ระบุประเภทซื้อ/ขายแล้ว */
  draftCount: number;
  /** บิลที่ยังไม่ระบุประเภท ซื้อ/ขาย (รอระบุ) */
  unspecifiedCount: number;
  /** รอตรวจรวม = ร่าง + รอระบุ (เท่ากับบิลที่ยังไม่ยืนยัน) */
  pendingCount: number;
  /** เป็นตัวหัวหน้าเอง (ไว้ป้าย "ของฉันเอง") */
  isSelf: boolean;
};

/** entry แบบย่อสำหรับนับสถานะการ์ดทีม */
type EntryStatusRow = { customer_id: string | null; status: string; entry_type: string };

/**
 * จัดหมวดบิล 1 ใบ (mutually-exclusive — 1 ใบอยู่หมวดเดียว)
 *   confirmed > unspecified (รอระบุ) > draft (ร่าง)
 */
function classifyEntry(status: string, entryType: string): "confirmed" | "unspecified" | "draft" {
  if (status === "confirmed") return "confirmed";
  if (entryType !== "purchase" && entryType !== "sale") return "unspecified";
  return "draft";
}

/**
 * รวมการ์ดนักบัญชีในทีม (pure) จากวัตถุดิบที่ดึงมาแล้ว
 *   - memberIds: employee ids ของทีม (รวมหัวหน้า) — คนที่ไม่มีลูกค้าก็ยังโชว์การ์ด (0)
 *   - leadEmployeeId: ตัวหัวหน้า (ติดป้าย isSelf)
 *   - groups: chat_groups (customer_id + responsible_employee_id) เฉพาะของทีม
 *   - names: employeeId → ชื่อแสดง
 *   - entries: บิลของลูกค้าในทีม (customer_id + status + entry_type)
 *   เรียงคนที่ค้างตรวจมากสุดขึ้นก่อน แล้วจำนวนลูกค้า แล้วชื่อ
 */
export function aggregateTeamCards(input: {
  memberIds: string[];
  leadEmployeeId: string;
  groups: { customer_id: string | null; responsible_employee_id: string | null }[];
  names: Map<string, string>;
  entries: EntryStatusRow[];
}): TeamAccountantCard[] {
  const { memberIds, leadEmployeeId, groups, names, entries } = input;
  const memberSet = new Set(memberIds);

  // customer_id → employee ที่ดูแล (เฉพาะสมาชิกในทีม)
  const empByCustomer = new Map<string, string>();
  // employeeId → set(customerId)
  const custByEmp = new Map<string, Set<string>>();
  for (const g of groups) {
    const emp = g.responsible_employee_id;
    if (!emp || !g.customer_id || !memberSet.has(emp)) continue;
    empByCustomer.set(g.customer_id, emp);
    const set = custByEmp.get(emp) ?? new Set<string>();
    set.add(g.customer_id);
    custByEmp.set(emp, set);
  }

  // นับสถานะบิลต่อ employee (ผ่าน customer → employee)
  type Counts = { bill: number; confirmed: number; draft: number; unspecified: number };
  const countsByEmp = new Map<string, Counts>();
  const ensure = (emp: string): Counts => {
    let c = countsByEmp.get(emp);
    if (!c) {
      c = { bill: 0, confirmed: 0, draft: 0, unspecified: 0 };
      countsByEmp.set(emp, c);
    }
    return c;
  };
  for (const e of entries) {
    if (!e.customer_id) continue;
    const emp = empByCustomer.get(e.customer_id);
    if (!emp) continue; // ลูกค้าไม่ได้อยู่ในทีม (กันเผื่อ)
    const c = ensure(emp);
    c.bill += 1;
    const kind = classifyEntry(e.status, e.entry_type);
    c[kind] += 1;
  }

  // สร้างการ์ดทุกสมาชิก (รวมคนที่ยังไม่มีลูกค้า = 0)
  const cards: TeamAccountantCard[] = memberIds.map((employeeId) => {
    const custSet = custByEmp.get(employeeId);
    const c = countsByEmp.get(employeeId);
    const confirmedCount = c?.confirmed ?? 0;
    const draftCount = c?.draft ?? 0;
    const unspecifiedCount = c?.unspecified ?? 0;
    return {
      employeeId,
      name: names.get(employeeId) ?? "นักบัญชี",
      customerCount: custSet?.size ?? 0,
      billCount: c?.bill ?? 0,
      confirmedCount,
      draftCount,
      unspecifiedCount,
      pendingCount: draftCount + unspecifiedCount,
      isSelf: employeeId === leadEmployeeId,
    };
  });

  cards.sort((a, b) => {
    if (b.pendingCount !== a.pendingCount) return b.pendingCount - a.pendingCount;
    if (b.customerCount !== a.customerCount) return b.customerCount - a.customerCount;
    return a.name.localeCompare(b.name, "th");
  });
  return cards;
}

/** จำกัดจำนวน entry ที่ดึงมานับ (พอประมาณ — ทีมเดียวไม่ใหญ่มาก) */
const ENTRY_COUNT_LIMIT = 20000;

/**
 * รายการการ์ดนักบัญชีในทีมของหัวหน้า (พร้อมนับลูกค้า/บิล/สถานะรอตรวจ)
 *   ดึง สมาชิกทีม → ชื่อ + chat_groups + bill_entries (เฉพาะลูกค้าในทีม) แล้ว aggregate (pure)
 */
export async function listTeamAccountantCards(
  db: DB,
  tenantId: string,
  leadEmployeeId: string
): Promise<TeamAccountantCard[]> {
  const memberIds = await teamMemberIdsForLead(db, tenantId, leadEmployeeId);
  if (memberIds.length === 0) return [];

  // ชื่อสมาชิก
  const { data: empData } = await db
    .from("employees")
    .select("id, first_name, nickname")
    .eq("tenant_id", tenantId)
    .in("id", memberIds);
  const names = new Map<string, string>();
  for (const e of (empData ?? []) as {
    id: string;
    first_name: string | null;
    nickname: string | null;
  }[]) {
    const n = e.nickname?.trim() || e.first_name?.trim();
    if (n) names.set(e.id, n);
  }

  // กลุ่มลูกค้าที่ทีมดูแล
  const { data: groupData } = await db
    .from("chat_groups")
    .select("customer_id, responsible_employee_id")
    .eq("tenant_id", tenantId)
    .in("responsible_employee_id", memberIds)
    .is("deleted_at", null);
  const groups = (groupData ?? []) as {
    customer_id: string | null;
    responsible_employee_id: string | null;
  }[];

  // บิลของลูกค้าในทีมเท่านั้น (scope ด้วย customer_id)
  const teamCustomerIds = dedupeCustomerIds(groups.map((g) => g.customer_id));
  let entries: EntryStatusRow[] = [];
  if (teamCustomerIds.length > 0) {
    const { data: entryData } = await db
      .from("bill_entries")
      .select("customer_id, status, entry_type")
      .eq("tenant_id", tenantId)
      .in("customer_id", teamCustomerIds)
      .is("deleted_at", null)
      .limit(ENTRY_COUNT_LIMIT);
    entries = ((entryData ?? []) as EntryStatusRow[]).map((e) => ({
      customer_id: e.customer_id,
      status: e.status,
      entry_type: e.entry_type,
    }));
  }

  return aggregateTeamCards({ memberIds, leadEmployeeId, groups, names, entries });
}
