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
import { chunkIds } from "@/lib/accounting/id-chunk";

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

/**
 * นักบัญชีคนนี้เป็นผู้ดูแล "กลุ่มรวมหลายบริษัท" (route_by_slip) อย่างน้อย 1 กลุ่มไหม
 *
 * ★ 2026-09-03 ผู้ใช้: "ย้ายบิลไปบริษัทอื่น เปิดสิทธิให้แค่พี่สวยคนเดียว บริษัทอื่นที่ผูก
 *   1 บริษัทต่อ 1 กลุ่มอยู่แล้วย้ายไม่ได้" — เงื่อนไขเชิงโครงสร้าง ไม่ hardcode ตัวบุคคล:
 *   สิทธิ์ย้ายบิล = เป็นผู้ดูแลกลุ่ม route_by_slip (AI แยกบิลเข้าหลายบริษัท จึงมีโอกาสแยกผิด)
 *   นักบัญชีกลุ่มปกติ (1 กลุ่ม 1 บริษัท) บิลไม่มีทางลงผิดบริษัท → ไม่ต้องมีปุ่มย้าย
 */
export async function hasRouteBySlipGroup(
  db: DB,
  tenantId: string,
  employeeId: string
): Promise<boolean> {
  const { data } = await db
    .from("chat_groups")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("responsible_employee_id", employeeId)
    .eq("route_by_slip", true)
    .is("deleted_at", null)
    .limit(1);
  return ((data ?? []) as { id: string }[]).length > 0;
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

// ---------------------------------------------------------------------
// ★ admin: reassign ผู้ดูแลลูกค้า (ต้องมีรายชื่อนักบัญชี + ผู้ดูแลปัจจุบันต่อลูกค้า)
// ---------------------------------------------------------------------

/** นักบัญชี 1 คนสำหรับ dropdown เปลี่ยนผู้ดูแล */
export type AccountantOption = { employeeId: string; name: string };

/**
 * รายชื่อ "นักบัญชี" ทั้ง tenant สำหรับ dropdown เปลี่ยนผู้ดูแล (admin)
 *   = employees ที่ employee_type='accountant' + active + ยังไม่ลบ (source of truth เดียวกับ guard login)
 *   เรียงตามชื่อ (ไทย) · คืน [] ถ้าไม่มี
 */
export async function listAccountantEmployees(
  db: DB,
  tenantId: string
): Promise<AccountantOption[]> {
  const { data } = await db
    .from("employees")
    .select("id, first_name, nickname")
    .eq("tenant_id", tenantId)
    .eq("employee_type", "accountant")
    .eq("is_active", true)
    .is("deleted_at", null);
  const opts: AccountantOption[] = [];
  for (const e of (data ?? []) as RawEmployee[]) {
    const name = e.nickname?.trim() || e.first_name?.trim();
    if (name) opts.push({ employeeId: e.id, name });
  }
  opts.sort((a, b) => a.name.localeCompare(b.name, "th"));
  return opts;
}

/**
 * ผู้ดูแลปัจจุบันของแต่ละลูกค้า (จาก chat_groups.responsible_employee_id)
 *   คืน Map<customerId, employeeId|null>:
 *     - employeeId เดียว (ทุกกลุ่มของลูกค้าชี้คนเดียวกัน) → คืน id นั้น
 *     - ไม่มีกลุ่ม / กลุ่มไม่มีผู้ดูแล / ผู้ดูแลปนกันหลายคน → null (แสดง "ยังไม่กำหนด/ปนกัน")
 *   ★ scope tenant เสมอ · pure หลังดึง (แต่รวม query ให้)
 */
export async function mapCustomersToAccountant(
  db: DB,
  tenantId: string,
  customerIds: string[]
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const ids = [...new Set(customerIds.filter((x) => !!x))];
  if (ids.length === 0) return result;

  // ★ ตัดก้อน (chunkIds) กัน .in() ยาวเกิน limit ของ PostgREST เมื่อลูกค้าในสโคปเยอะ (admin "ทั้งสำนักงาน")
  const chunks = await Promise.all(
    chunkIds(ids).map((chunk) =>
      db
        .from("chat_groups")
        .select("customer_id, responsible_employee_id")
        .eq("tenant_id", tenantId)
        .in("customer_id", chunk)
        .is("deleted_at", null)
    )
  );
  const data = chunks.flatMap((r) => r.data ?? []);

  // customerId → set(employeeId ที่ไม่ null)
  const empByCust = new Map<string, Set<string>>();
  for (const r of (data ?? []) as RawGroup[]) {
    if (!r.customer_id || !r.responsible_employee_id) continue;
    const set = empByCust.get(r.customer_id) ?? new Set<string>();
    set.add(r.responsible_employee_id);
    empByCust.set(r.customer_id, set);
  }
  for (const cid of ids) {
    const set = empByCust.get(cid);
    result.set(cid, set && set.size === 1 ? [...set][0] : null);
  }
  return result;
}

/**
 * เปลี่ยนผู้ดูแล (reassign) ลูกค้า 1 ราย → นักบัญชีคนใหม่
 *   อัปเดต responsible_employee_id ของ "ทุกกลุ่มไลน์ของลูกค้ารายนี้" (source of truth ของสโคป)
 *   คืนจำนวนกลุ่มที่อัปเดต (0 = ลูกค้ายังไม่มีกลุ่มไลน์ผูก → กำหนดผู้ดูแลไม่ได้)
 *   ★ ผู้เรียกต้อง guard admin + tenant + ยืนยัน employee เป็นนักบัญชีใน tenant มาก่อนแล้ว
 */
export async function reassignCustomerAccountant(
  db: DB,
  tenantId: string,
  customerId: string,
  employeeId: string
): Promise<{ ok: boolean; updated: number }> {
  const { data, error } = await db
    .from("chat_groups")
    .update({ responsible_employee_id: employeeId })
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .select("id");
  if (error) return { ok: false, updated: 0 };
  return { ok: true, updated: (data ?? []).length };
}
