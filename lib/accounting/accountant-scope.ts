/**
 * สโคป "นักบัญชี ↔ ลูกค้าที่ดูแล" สำหรับหน้าลงบันทึกบัญชี
 *
 * ความสัมพันธ์: chat_groups.responsible_employee_id (นักบัญชีผู้ดูแลกลุ่ม)
 *   + chat_groups.customer_id (1 กลุ่ม 1 ลูกค้า) → นักบัญชีดูแลลูกค้าคนไหนบ้าง
 *
 * ★ ทุก query scope ด้วย tenantId (มาจาก session เท่านั้น) — ไม่เชื่อ client
 * ★ ส่วนรวมยอด (aggregate) เป็น pure → unit test ได้แน่นอน
 * ★ PDPA: ไม่ log ชื่อ/รหัสลูกค้า/นักบัญชี
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

/** การ์ดนักบัญชี 1 คน (หน้าแรกของ admin/lead) */
export type AccountantCard = {
  employeeId: string;
  name: string;
  /** จำนวนลูกค้าที่ดูแล */
  customerCount: number;
  /** จำนวนบิล/รายการบัญชีของลูกค้าที่ดูแล */
  billCount: number;
};

type RawGroup = { customer_id: string | null; responsible_employee_id: string | null };
type RawEmployee = { id: string; first_name: string | null; nickname: string | null };

/**
 * customer_id ที่นักบัญชีคนนี้ดูแล (unique) — จาก chat_groups
 *   คืน [] ถ้าไม่ดูแลใครเลย
 */
export async function customerIdsForAccountant(
  db: DB,
  tenantId: string,
  employeeId: string
): Promise<string[]> {
  const { data } = await db
    .from("chat_groups")
    .select("customer_id")
    .eq("tenant_id", tenantId)
    .eq("responsible_employee_id", employeeId)
    .is("deleted_at", null);
  const ids = new Set<string>();
  for (const r of (data ?? []) as { customer_id: string | null }[]) {
    if (r.customer_id) ids.add(r.customer_id);
  }
  return [...ids];
}

/** ชื่อพนักงานสำหรับหัวข้อ (ชื่อเล่นก่อน ชื่อจริง) — คืน null ถ้าไม่พบ */
export async function getEmployeeName(
  db: DB,
  tenantId: string,
  employeeId: string
): Promise<string | null> {
  const { data } = await db
    .from("employees")
    .select("first_name, nickname")
    .eq("id", employeeId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  const row = (data ?? null) as { first_name: string | null; nickname: string | null } | null;
  if (!row) return null;
  return row.nickname?.trim() || row.first_name?.trim() || null;
}

/**
 * รวมข้อมูลการ์ดนักบัญชี (pure) จากวัตถุดิบที่ดึงมาแล้ว
 *   - groups: กลุ่มทั้งหมดของ tenant (customer_id + responsible_employee_id)
 *   - employeeNames: id → ชื่อแสดง
 *   - entryCustomerIds: customer_id ของทุก entry (นับบิลต่อลูกค้า)
 *   เรียงตามจำนวนลูกค้ามาก→น้อย แล้วชื่อ
 */
export function aggregateAccountantCards(
  groups: RawGroup[],
  employeeNames: Map<string, string>,
  entryCustomerIds: (string | null)[]
): AccountantCard[] {
  // นับบิลต่อ customer
  const billByCustomer = new Map<string, number>();
  for (const cid of entryCustomerIds) {
    if (!cid) continue;
    billByCustomer.set(cid, (billByCustomer.get(cid) ?? 0) + 1);
  }

  // employeeId → set(customerId)
  const custByEmp = new Map<string, Set<string>>();
  for (const g of groups) {
    const emp = g.responsible_employee_id;
    if (!emp || !g.customer_id) continue;
    const set = custByEmp.get(emp) ?? new Set<string>();
    set.add(g.customer_id);
    custByEmp.set(emp, set);
  }

  const cards: AccountantCard[] = [];
  for (const [employeeId, custSet] of custByEmp.entries()) {
    let billCount = 0;
    for (const cid of custSet) billCount += billByCustomer.get(cid) ?? 0;
    cards.push({
      employeeId,
      name: employeeNames.get(employeeId) ?? "นักบัญชี",
      customerCount: custSet.size,
      billCount,
    });
  }

  cards.sort((a, b) => {
    if (b.customerCount !== a.customerCount) return b.customerCount - a.customerCount;
    return a.name.localeCompare(b.name, "th");
  });
  return cards;
}

/** จำกัดจำนวน entry ที่ดึงมานับบิล (นับพอประมาณ — ไม่ต้องเป๊ะระดับพัน) */
const ENTRY_COUNT_LIMIT = 20000;

/**
 * รายการนักบัญชี (การ์ด) พร้อมนับลูกค้า/บิล สำหรับหน้าแรกของ admin/lead
 *   ดึง groups + employees + customer_id ของ entries ทั้ง tenant แล้ว aggregate (pure)
 */
export async function listAccountantsWithCounts(
  db: DB,
  tenantId: string
): Promise<AccountantCard[]> {
  const { data: groupData } = await db
    .from("chat_groups")
    .select("customer_id, responsible_employee_id")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  const groups = (groupData ?? []) as RawGroup[];

  const empIds = [
    ...new Set(
      groups
        .map((g) => g.responsible_employee_id)
        .filter((x): x is string => !!x)
    ),
  ];
  if (empIds.length === 0) return [];

  const { data: empData } = await db
    .from("employees")
    .select("id, first_name, nickname")
    .eq("tenant_id", tenantId)
    .in("id", empIds);
  const names = new Map<string, string>();
  for (const e of (empData ?? []) as RawEmployee[]) {
    const n = e.nickname?.trim() || e.first_name?.trim();
    if (n) names.set(e.id, n);
  }

  const { data: entryData } = await db
    .from("bill_entries")
    .select("customer_id")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .limit(ENTRY_COUNT_LIMIT);
  const entryCustomerIds = ((entryData ?? []) as { customer_id: string | null }[]).map(
    (r) => r.customer_id
  );

  return aggregateAccountantCards(groups, names, entryCustomerIds);
}
