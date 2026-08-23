import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listFilingPeriods, getFilingPeriodDetail } from "@/lib/accounting/payroll-monthly-filing";
import FilingPeriodPanel from "./FilingPeriodPanel";
import ChatAuditFrame from "../../../_Frame";
import "../../../chat-admin.css";
import "../../../bills/bills.css";
import "../../accounting.css";

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
 * /chat-audit/accounting/payroll/filing — "สรุปการยื่นภาษี/ประกันสังคมรายเดือน" (เฟส 9b กลุ่ม BC, T139)
 *   เลือกลูกค้า → รายการหน่วยยื่นรายเดือน (payroll_monthly_filings) → เลือกเดือน → เห็นทุกรอบจ่ายที่รวมอยู่
 *   ในเดือนนั้น + ยอดรวม PIT/SSO ข้ามรอบ + ปุ่มยื่นแล้ว 1 ชุด/เดือน (แทนต่อรอบเหมือนเดิม)
 *
 * ★ สำหรับลูกค้า pay_frequency='monthly' (ส่วนใหญ่/ทุกรายก่อนเฟสนี้) หน่วยยื่นแต่ละเดือนมีแค่ 1 รอบเสมอ —
 *   หน้านี้ทำงานเหมือนหน้ารอบเงินเดือนเดิมทุกประการจากมุมมอง UX (1 รอบ = 1 เดือนเป๊ะ)
 */
export default async function PayrollFilingPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; periodId?: string }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-accounting" role={null} authed={false} title="สรุปการยื่นรายเดือน" subtitle="ภ.ง.ด.1 / สปส.1-10 รวมทุกรอบจ่ายของเดือนนั้น">
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

  const rawCustomer = (sp.customerId ?? "").trim();
  const validCustomerId =
    UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";
  const selectedLabel = customers.find((c) => c.id === validCustomerId)?.label ?? "";

  const periods = validCustomerId ? await listFilingPeriods(service, access.tenantId, validCustomerId) : [];

  const rawPeriodId = (sp.periodId ?? "").trim();
  const validPeriodId = UUID_RE.test(rawPeriodId) && periods.some((p) => p.id === rawPeriodId) ? rawPeriodId : "";
  const detail =
    validCustomerId && validPeriodId ? await getFilingPeriodDetail(service, access.tenantId, validCustomerId, validPeriodId) : null;

  return (
    <ChatAuditFrame
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="สรุปการยื่นรายเดือน"
      subtitle="ภ.ง.ด.1 / สปส.1-10 รวมทุกรอบจ่ายของเดือนนั้น — บันทึกว่ายื่นแล้ว 1 ชุดต่อเดือน"
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
          {validCustomerId ? (
            <Link href={`/chat-audit/accounting/payroll?customerId=${validCustomerId}`} className="btn btn-ghost">
              ← กลับไปรอบเงินเดือน
            </Link>
          ) : (
            <Link href="/chat-audit/accounting/payroll" className="btn btn-ghost">← กลับไปรอบเงินเดือน</Link>
          )}
        </div>

        {customers.length === 0 ? (
          <div className="card">
            <p className="empty">ยังไม่มีลูกค้าในความดูแลของคุณ</p>
          </div>
        ) : !validCustomerId ? (
          <div className="card">
            <p className="empty">เลือกลูกค้าด้านบนเพื่อดูสรุปการยื่นรายเดือน</p>
          </div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            <FilingPeriodPanel customerId={validCustomerId} periods={periods} detail={detail} />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
