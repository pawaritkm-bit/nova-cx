import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listRuns, getRunWithLines } from "@/lib/accounting/payroll";
import { listActiveFilingReminders, countPendingFilingUnits } from "@/lib/accounting/payroll-filing-reminders";
import PayrollRunPanel from "./PayrollRunPanel";
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
 * /chat-audit/accounting/payroll — "รอบเงินเดือน" (เฟส 9 ส่วน AD/AE)
 *   เลือกลูกค้า → รายการรอบเงินเดือน (ปี/เดือน/สถานะ/สถานะยื่น) + สร้างรอบใหม่ → เลือกรอบ → ตารางบรรทัด
 *   ต่อพนักงาน (คำนวณภาษี/ประกันสังคม, สร้าง JE, บันทึกสถานะยื่น ภ.ง.ด.1/สปส.1-10)
 */
export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; runId?: string }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-accounting" role={null} authed={false} title="รอบเงินเดือน" subtitle="คำนวณภาษีหัก ณ ที่จ่าย + ประกันสังคม + สร้างรายการบัญชี">
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

  const runs = validCustomerId ? await listRuns(service, access.tenantId, validCustomerId) : [];

  const rawRunId = (sp.runId ?? "").trim();
  const validRunId = UUID_RE.test(rawRunId) && runs.some((r) => r.id === rawRunId) ? rawRunId : "";
  const detail = validCustomerId && validRunId ? await getRunWithLines(service, access.tenantId, validCustomerId, validRunId) : null;

  const pendingReminders = validCustomerId
    ? await listActiveFilingReminders(service, access.tenantId, validCustomerId)
    : [];
  const pendingReminderCount = countPendingFilingUnits(pendingReminders);

  return (
    <ChatAuditFrame
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="รอบเงินเดือน"
      subtitle="คำนวณภาษีหัก ณ ที่จ่าย (ภ.ง.ด.1) + เงินสมทบประกันสังคม + สร้างรายการบัญชีรวมยอดต่อรอบ"
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
            <>
              <Link href={`/chat-audit/accounting/payroll-employees?customerId=${validCustomerId}`} className="btn btn-ghost">
                ทะเบียนพนักงาน/ตั้งค่าบัญชี
              </Link>
              <Link href={`/chat-audit/accounting/payroll/filing?customerId=${validCustomerId}`} className="btn btn-ghost">
                สรุปการยื่นรายเดือน
              </Link>
              <Link href={`/chat-audit/accounting/payroll/wht-cert?customerId=${validCustomerId}`} className="btn btn-ghost">
                พิมพ์หนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ)
              </Link>
            </>
          ) : null}
          <Link href="/chat-audit/accounting" className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
        </div>

        {customers.length === 0 ? (
          <div className="card">
            <p className="empty">ยังไม่มีลูกค้าในความดูแลของคุณ</p>
          </div>
        ) : !validCustomerId ? (
          <div className="card">
            <p className="empty">เลือกลูกค้าด้านบนเพื่อจัดการรอบเงินเดือน</p>
          </div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            {pendingReminderCount > 0 ? (
              <div className="card acc-review-warn" style={{ marginBottom: 12 }} role="alert">
                <span className="acc-review-warn-icon" aria-hidden="true">⚠️</span>
                <div className="acc-review-warn-body">
                  {pendingReminderCount} หน่วยยื่นใกล้/เกินกำหนด (ภ.ง.ด.1/สปส.1-10){" "}
                  <Link href={`/chat-audit/accounting/payroll/filing?customerId=${validCustomerId}`}>
                    ไปหน้าสรุปการยื่นรายเดือน →
                  </Link>
                </div>
              </div>
            ) : null}
            <PayrollRunPanel
              customerId={validCustomerId}
              runs={runs}
              detail={detail}
            />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
