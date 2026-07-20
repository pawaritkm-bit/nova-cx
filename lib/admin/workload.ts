/**
 * Admin workload — สรุป "นักบัญชีแต่ละคนดูแลลูกค้ากี่ราย"
 *
 * แหล่งข้อมูล: customer_assignments (customer → employee, effective-dated)
 *   นับเฉพาะ "ผู้ดูแลปัจจุบัน" (นิยามเดียวกับ listCurrentAssignments / หน้ามอบหมาย):
 *     - valid_to เป็น null  → ยังดูแลอยู่ (แอปปิดการดูแลด้วยการ set valid_to = วันนี้
 *       ผ่าน endAssignment/cascade ดังนั้น "null = active, มีค่า = สิ้นสุดแล้ว")
 *     - valid_from ≤ วันนี้  → เริ่มมีผลแล้ว (ไม่นับรายการที่กำหนดล่วงหน้าในอนาคต)
 *     - deleted_at เป็น null
 *   และลูกค้าต้องยังไม่ถูกปิดใช้งาน (customers.deleted_at null)
 *   → ทำให้ตัวเลขภาระงานตรงกับ "ผู้ดูแลปัจจุบัน" ที่แสดงในแท็บมอบหมายเสมอ
 *
 * สรุปต่อพนักงาน: จำนวนรวม + แยกตามประเภทลูกค้า (นิติบุคคล/บุคคลธรรมดา/ไม่ระบุ)
 * scope ด้วย tenantId (จาก session) เสมอ — ไม่นับข้าม tenant
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

/** วันที่วันนี้ YYYY-MM-DD (ใช้กรอง active assignment) */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** สรุปภาระงานของนักบัญชี 1 คน */
export type WorkloadRow = {
  employee_id: string;
  employee_name: string | null;
  employee_nickname: string | null;
  /** ชื่อทีม (จาก team_id ของ assignment ล่าสุดที่พบ) — null = ไม่ระบุทีม */
  team_name: string | null;
  /** จำนวนลูกค้าที่ดูแลอยู่ตอนนี้ (รวมทุกประเภท) */
  total: number;
  /** แยกย่อยตามประเภทลูกค้า */
  company: number;
  individual: number;
  unspecified: number;
};

/** โครงแถวดิบจาก join (assignment + employee + team + customer) */
type RawAssignment = {
  employee_id: string;
  team_id: string | null;
  employees: { first_name?: string; nickname?: string | null } | null;
  teams: { name?: string | null } | null;
  customers: { customer_type?: string | null; deleted_at?: string | null } | null;
};

/**
 * ดึงสรุปภาระงานนักบัญชี (group by employee, เรียงจำนวนมาก→น้อย)
 *   - query เดียว: assignment ที่ active + enrich ชื่อพนักงาน/ทีม/ประเภทลูกค้า
 *   - aggregate ฝั่งแอป (นับรวม + แยกประเภท) — กันลูกค้าที่ถูกปิดใช้งานออก
 */
export async function getAccountantWorkload(
  db: DB,
  tenantId: string
): Promise<WorkloadRow[]> {
  const today = todayISO();

  const { data, error } = await db
    .from("customer_assignments")
    .select(
      "employee_id, team_id, employees(first_name, nickname), teams(name), customers(customer_type, deleted_at)"
    )
    .eq("tenant_id", tenantId) // ★ scope tenant จาก session เสมอ
    .is("valid_to", null) // ผู้ดูแลปัจจุบัน (ยังไม่สิ้นสุด)
    .is("deleted_at", null)
    .lte("valid_from", today); // เริ่มมีผลแล้ว (ไม่ใช่กำหนดในอนาคต)
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as RawAssignment[];

  // group by employee_id → สะสมจำนวนรวม + แยกประเภท
  const byEmployee = new Map<string, WorkloadRow>();

  for (const r of rows) {
    // ข้ามลูกค้าที่ถูกปิดใช้งาน (soft-deleted) — ไม่นับเป็นภาระงาน
    if (r.customers?.deleted_at) continue;

    let acc = byEmployee.get(r.employee_id);
    if (!acc) {
      acc = {
        employee_id: r.employee_id,
        employee_name: r.employees?.first_name ?? null,
        employee_nickname: r.employees?.nickname ?? null,
        team_name: r.teams?.name ?? null,
        total: 0,
        company: 0,
        individual: 0,
        unspecified: 0,
      };
      byEmployee.set(r.employee_id, acc);
    }

    // เติมชื่อทีมถ้าแถวก่อนหน้ายังไม่มี (assignment บางแถวอาจไม่ผูกทีม)
    if (!acc.team_name && r.teams?.name) acc.team_name = r.teams.name;

    acc.total += 1;
    const type = r.customers?.customer_type ?? null;
    if (type === "company") acc.company += 1;
    else if (type === "individual") acc.individual += 1;
    else acc.unspecified += 1;
  }

  // เรียงมาก→น้อย (เท่ากันเรียงตามชื่อให้ผลคงที่)
  return Array.from(byEmployee.values()).sort(
    (a, b) =>
      b.total - a.total ||
      (a.employee_name ?? "").localeCompare(b.employee_name ?? "", "th")
  );
}
