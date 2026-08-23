/**
 * ดึงรายชื่อลูกค้าในสโคป (สำหรับ dropdown เลือกลูกค้าในหน้าฟีเจอร์บัญชี)
 *   ★★ แก้บั๊ก PostgREST 1000-row cap: `.limit(5000)` เดิมได้จริงแค่ 1000 แถว →
 *      สำนักงานที่มีลูกค้า > 1000 ราย จะเลือกลูกค้าที่เกิน 1000 ไม่ได้เลย (หายจาก dropdown)
 *   → paginate ด้วย .range() ทีละ 1000 จนครบ (cap 20000 กันวนไม่จบ) · โหมด allowed (นักบัญชี/หัวหน้า)
 *     ใช้ chunkIds กัน .in() ยาว/เกิน 1000
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountingAccess } from "@/lib/accounting/access";
import { chunkIds } from "@/lib/accounting/id-chunk";

export type ScopedCustomerRow = { id: string; customer_code: string | null; name: string | null };

const PAGE = 1000;
const SCAN_CAP = 20000;

export async function listScopedCustomers(
  service: SupabaseClient,
  access: AccountingAccess
): Promise<ScopedCustomerRow[]> {
  // นักบัญชี/หัวหน้า: จำกัดเฉพาะลูกค้าที่ดูแล (allowedCustomerIds) — chunk .in() กันยาว/เกิน cap
  if (access.allowedCustomerIds !== null) {
    const ids = [...access.allowedCustomerIds];
    if (ids.length === 0) return [];
    const out: ScopedCustomerRow[] = [];
    const chunks = await Promise.all(
      chunkIds(ids).map((c) =>
        service
          .from("customers")
          .select("id, customer_code, name")
          .eq("tenant_id", access.tenantId)
          .is("deleted_at", null)
          .in("id", c)
      )
    );
    for (const { data } of chunks) out.push(...((data ?? []) as ScopedCustomerRow[]));
    out.sort((a, b) => (a.customer_code ?? "￿").localeCompare(b.customer_code ?? "￿"));
    return out;
  }

  // admin/ทั้งสำนักงาน: ดึงทั้ง tenant — paginate จนครบ (กัน cap 1000)
  const out: ScopedCustomerRow[] = [];
  for (let from = 0; from < SCAN_CAP; from += PAGE) {
    const { data } = await service
      .from("customers")
      .select("id, customer_code, name")
      .eq("tenant_id", access.tenantId)
      .is("deleted_at", null)
      .order("customer_code", { ascending: true, nullsFirst: false })
      .range(from, from + PAGE - 1);
    const rows = (data ?? []) as ScopedCustomerRow[];
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}
