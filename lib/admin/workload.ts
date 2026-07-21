/**
 * Admin workload — สรุป "นักบัญชีแต่ละคนดูแลลูกค้ากี่ราย"
 *
 * แหล่งข้อมูล: chat_groups linkage (การจับคู่กลุ่มในหน้าตรวจแชต) — แหล่งเดียวกับหน้ามอบหมาย
 *   นิยาม "นักบัญชีดูแลลูกค้าคนไหน" = ลูกค้าของกลุ่มที่นักบัญชีคนนั้นเป็นผู้ดูแล:
 *     - responsible_employee_id = พนักงานคนนั้น (กลุ่มมีนักบัญชีผู้ดูแล)
 *     - customer_id is not null                  (กลุ่มจับคู่ลูกค้าแล้ว)
 *     - group_kind in ('group','room')           (กลุ่มจริง ไม่ใช่บทสนทนา 1-1)
 *     - deleted_at is null (กลุ่มยังใช้งานอยู่) + tenant_id ตรง session
 *   และลูกค้าต้องยังไม่ถูกปิดใช้งาน (customers.deleted_at null)
 *   ★ ไม่ใช้ customer_assignments แล้ว — ยึด chat_groups เป็นแหล่งเดียวกับที่จับคู่ในหน้าตรวจแชต
 *
 * นับ distinct customer ต่อพนักงาน (ลูกค้าเดียวหลายกลุ่ม/ผูกซ้ำ → นับครั้งเดียว)
 * สรุปต่อพนักงาน: จำนวนรวม + แยกตามประเภทลูกค้า (นิติบุคคล/บุคคลธรรมดา/ไม่ระบุ)
 * scope ด้วย tenantId (จาก session) เสมอ — ไม่นับข้าม tenant
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

/** เพดานแถวต่อ query (กันดึงเยอะเกินจนหน้าอืด) */
const WORKLOAD_LIMIT = 5000;

/** สรุปภาระงานของนักบัญชี 1 คน */
export type WorkloadRow = {
  employee_id: string;
  employee_name: string | null;
  employee_nickname: string | null;
  /** ชื่อทีมปัจจุบันของนักบัญชี (จาก team_members ที่ยัง active) — null = ไม่ระบุทีม */
  team_name: string | null;
  /** จำนวนลูกค้าที่ดูแลอยู่ตอนนี้ (รวมทุกประเภท, distinct) */
  total: number;
  /** แยกย่อยตามประเภทลูกค้า */
  company: number;
  individual: number;
  unspecified: number;
};

/** อ่าน relation แบบ to-one ที่ PostgREST อาจคืนเป็น object หรือ array */
function readOne<T>(rel: unknown): T | null {
  if (Array.isArray(rel)) return (rel[0] as T) ?? null;
  return (rel as T) ?? null;
}

/** โครงแถวดิบจาก chat_groups (linkage กลุ่ม → ลูกค้า + นักบัญชีผู้ดูแล) */
type RawGroupLink = {
  responsible_employee_id: string;
  customer_id: string;
  responsible: { first_name?: string; nickname?: string | null } | null;
  customers: { customer_type?: string | null; deleted_at?: string | null } | null;
};

/**
 * ดึงสรุปภาระงานนักบัญชี (group by employee, เรียงจำนวนมาก→น้อย)
 *   - นับ distinct customer จากกลุ่มที่นักบัญชีเป็นผู้ดูแล (chat_groups linkage)
 *   - enrich ชื่อพนักงาน (จาก embed) + ชื่อทีมปัจจุบัน (query team_members แยก)
 *   - aggregate ฝั่งแอป (นับรวม + แยกประเภท) — กันลูกค้าที่ถูกปิดใช้งานออก
 */
export async function getAccountantWorkload(
  db: DB,
  tenantId: string
): Promise<WorkloadRow[]> {
  const { data, error } = await db
    .from("chat_groups")
    .select(
      "responsible_employee_id, customer_id, responsible:employees!responsible_employee_id(first_name, nickname), customers(customer_type, deleted_at)"
    )
    .eq("tenant_id", tenantId) // ★ scope tenant จาก session เสมอ
    .not("responsible_employee_id", "is", null) // กลุ่มมีนักบัญชีผู้ดูแล
    .not("customer_id", "is", null) // กลุ่มจับคู่ลูกค้าแล้ว
    .in("group_kind", ["group", "room"]) // กลุ่มจริง (ไม่ใช่ 1-1)
    .is("deleted_at", null)
    .limit(WORKLOAD_LIMIT);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as RawGroupLink[];

  // group by employee_id → สะสม distinct customer + แยกประเภท
  const byEmployee = new Map<string, WorkloadRow>();
  const seenByEmployee = new Map<string, Set<string>>(); // employeeId → set(customerId)

  for (const r of rows) {
    const empId = r.responsible_employee_id;
    if (!empId || !r.customer_id) continue;

    const cust = readOne<{ customer_type?: string | null; deleted_at?: string | null }>(r.customers);
    // ข้ามลูกค้าที่ถูกปิดใช้งาน (soft-deleted) — ไม่นับเป็นภาระงาน
    if (cust?.deleted_at) continue;

    let seen = seenByEmployee.get(empId);
    let acc = byEmployee.get(empId);
    if (!acc || !seen) {
      const emp = readOne<{ first_name?: string; nickname?: string | null }>(r.responsible);
      acc = {
        employee_id: empId,
        employee_name: emp?.first_name ?? null,
        employee_nickname: emp?.nickname ?? null,
        team_name: null, // เติมภายหลังจาก team_members
        total: 0,
        company: 0,
        individual: 0,
        unspecified: 0,
      };
      byEmployee.set(empId, acc);
      seen = new Set();
      seenByEmployee.set(empId, seen);
    }

    // ลูกค้าเดียวหลายกลุ่ม → นับครั้งเดียว (distinct)
    if (seen.has(r.customer_id)) continue;
    seen.add(r.customer_id);

    acc.total += 1;
    const type = cust?.customer_type ?? null;
    if (type === "company") acc.company += 1;
    else if (type === "individual") acc.individual += 1;
    else acc.unspecified += 1;
  }

  // เติมชื่อทีมปัจจุบันของแต่ละนักบัญชี (team_members ที่ยัง active) — best-effort
  const employeeIds = [...byEmployee.keys()];
  if (employeeIds.length > 0) {
    const { data: tmData, error: tmErr } = await db
      .from("team_members")
      .select("employee_id, teams(name)")
      .eq("tenant_id", tenantId)
      .in("employee_id", employeeIds)
      .is("valid_to", null)
      .is("deleted_at", null)
      .limit(WORKLOAD_LIMIT);
    if (tmErr) throw new Error(tmErr.message);
    for (const m of (tmData ?? []) as unknown as {
      employee_id: string;
      teams: { name?: string | null } | { name?: string | null }[] | null;
    }[]) {
      const acc = byEmployee.get(m.employee_id);
      if (!acc || acc.team_name) continue; // เติมทีมแรกที่พบเท่านั้น
      const team = readOne<{ name?: string | null }>(m.teams);
      if (team?.name) acc.team_name = team.name;
    }
  }

  // เรียงมาก→น้อย (เท่ากันเรียงตามชื่อให้ผลคงที่)
  return Array.from(byEmployee.values()).sort(
    (a, b) =>
      b.total - a.total ||
      (a.employee_name ?? "").localeCompare(b.employee_name ?? "", "th")
  );
}
