import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import AccountingUploadTabs from "../AccountingUploadTabs";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";
import "./statement.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ป้ายชื่อลูกค้า (มีรหัส → "N023 · ชื่อ") */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ลูกค้า";
}

/** รายชื่อลูกค้าในสโคปของผู้เรียก (id + label) — สำหรับ dropdown */
async function fetchScopedCustomers(
  service: SupabaseClient,
  access: AccountingAccess
): Promise<{ id: string; label: string }[]> {
  let q = service
    .from("customers")
    .select("id, customer_code, name")
    .eq("tenant_id", access.tenantId)
    .is("deleted_at", null)
    .order("customer_code", { ascending: true, nullsFirst: false })
    .limit(5000);
  if (access.allowedCustomerIds !== null) {
    const ids = [...access.allowedCustomerIds];
    if (ids.length === 0) return [];
    q = q.in("id", ids);
  }
  const { data } = await q;
  const rows = (data ?? []) as { id: string; customer_code: string | null; name: string | null }[];
  return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

/**
 * /chat-audit/accounting/statement — "AI แยกสเตทเมนต์ ขาเข้า-ขาออก" (Phase 1)
 *   เลือกลูกค้า (ในสโคป) → อัปไฟล์สเตทเมนต์ → AI แยกธุรกรรม + สรุปรายเดือน + คนโอนซ้ำ
 *
 * ★ guard + scope เดียวกับหน้าบัญชี (resolveAccountingAccess) — นักบัญชีเห็นเฉพาะลูกค้าตัวเอง
 * ★ tenantId จาก session · ไม่ log ชื่อ/ตัวเลข
 */
export default async function StatementPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-accounting" role={null} authed={false} title="แยกสเตทเมนต์" subtitle="ขาเข้า-ขาออก">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting");

  const navRole = access.navRole;
  const staffOnly = access.mode === "accountant" || access.mode === "lead";

  const customers = await fetchScopedCustomers(service, access);

  // ลูกค้าที่เลือก (validate uuid + ต้องอยู่ในสโคป)
  const rawCustomer = (sp.customerId ?? "").trim();
  const validCustomerId =
    UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";
  const selectedLabel = customers.find((c) => c.id === validCustomerId)?.label ?? "";

  return (
    <ChatAuditFrame
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="AI แยกสเตทเมนต์ + รายงานแพลตฟอร์ม"
      subtitle="สเตทเมนต์ธนาคาร: แยกเงินเข้า/ออก + คนโอนซ้ำ · รายงานแพลตฟอร์ม: แยกยอดขาย/ค่าธรรมเนียม ให้เหลือกำไรจริง"
    >
      <div className="dash-views">
        <div className="card acc-review-head">
          {/* เลือกลูกค้า (form GET — คงสโคป server-side) */}
          <form method="get" className="acc-opening-cust">
            <label>
              ลูกค้า:{" "}
              <select name="customerId" defaultValue={validCustomerId}>
                <option value="">— เลือกลูกค้า —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn">เปิด</button>
          </form>
          <span className="acc-toolbar-spacer" />
          <Link href="/chat-audit/accounting" className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
        </div>

        {customers.length === 0 ? (
          <div className="card">
            <p className="empty">ยังไม่มีลูกค้าในความดูแลของคุณ</p>
          </div>
        ) : !validCustomerId ? (
          <div className="card">
            <p className="empty">เลือกลูกค้าด้านบนเพื่ออัปสเตทเมนต์/รายงานแพลตฟอร์มและแยกรายการ</p>
          </div>
        ) : (
          <div className="card">
            <AccountingUploadTabs customerId={validCustomerId} customerLabel={selectedLabel} />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
