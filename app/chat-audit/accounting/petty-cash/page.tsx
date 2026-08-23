import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { getOrCreateDefaultFund, listVouchers } from "@/lib/accounting/petty-cash";
import PettyCashPanel from "./PettyCashPanel";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ลูกค้า";
}

async function fetchScopedCustomers(
  service: SupabaseClient,
  access: AccountingAccess
): Promise<{ id: string; label: string }[]> {
  const rows = await listScopedCustomers(service, access);
  return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

/**
 * /chat-audit/accounting/petty-cash — "เงินสดย่อย" (wishlist ข้อ 3, ระบบ imprest)
 *   เลือกลูกค้า (ในสโคป) → ตั้งค่ากองทุน (ยอดคงที่ + บัญชีเงินสดย่อย/ต้นทาง) + บันทึกใบเบิกทีละใบ
 *   → เคลียร์รวมเป็น manual JE ดราฟต์เมื่อพร้อม (นักบัญชีไปยืนยันเองที่หน้าลงบันทึกบัญชีเอง)
 */
export default async function PettyCashPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="เงินสดย่อย" subtitle="กองทุนเงินสดย่อยแบบ imprest">
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
  const chart = await listChartOfAccounts(service, access.tenantId);
  const chartByCode = buildChartByCode(chart);

  const rawCustomer = (sp.customerId ?? "").trim();
  const validCustomerId =
    UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";
  const selectedLabel = customers.find((c) => c.id === validCustomerId)?.label ?? "";

  const fund = validCustomerId ? await getOrCreateDefaultFund(service, access.tenantId, validCustomerId) : null;
  const vouchers = fund ? await listVouchers(service, access.tenantId, validCustomerId, fund.id, chartByCode) : [];

  return (
    <ChatAuditFrame bare={embed}
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="เงินสดย่อย"
      subtitle="ตั้งกองทุนเงินสดย่อยคงที่ (imprest) + บันทึกใบเบิก + เคลียร์รวมเป็นสมุดรายวันดราฟต์"
    >
      <div className="dash-views">
        <div className="card acc-review-head">
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
        ) : !validCustomerId || !fund ? (
          <div className="card">
            <p className="empty">เลือกลูกค้าด้านบนเพื่อจัดการเงินสดย่อย</p>
          </div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            <PettyCashPanel customerId={validCustomerId} fund={fund} vouchers={vouchers} chart={chart} />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
