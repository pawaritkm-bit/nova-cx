import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listEntries, type EntryType } from "@/lib/accounting/queries";
import { isCreditEligibleForPayment, billNetTotal, billOutstanding, listBillPaymentsForEntries } from "@/lib/accounting/bill-payments";
import { listNotesForEntries, netAdjustmentByEntry } from "@/lib/accounting/credit-debit-notes";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import CreditDebitNotesPanel, { type NoteBillRow } from "./CreditDebitNotesPanel";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ป้ายชื่อลูกค้า (มีรหัส → "N023 · ชื่อ") */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ลูกค้า";
}

/**
 * รายชื่อลูกค้าในสโคปของผู้เรียก (id + label) — สำหรับ dropdown เลือกลูกค้า
 *   - admin/lead (allowedCustomerIds=null): ทุกลูกค้าใน tenant
 *   - accountant: เฉพาะลูกค้าที่ตัวเองดูแล
 */
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
 * /chat-audit/accounting/credit-debit-notes — "ใบลดหนี้/ใบเพิ่มหนี้" (เฟส 3 ส่วน J)
 *   เลือกลูกค้า (ในสโคป) → list บิลเชื่อ (payment_method='credit', confirmed) ของลูกค้ารายนั้น
 *   → สร้าง/แก้/ยืนยัน/ยกเลิก CN/DN ต่อบิล
 *
 * ★ guard + scope เดียวกับหน้า payments (resolveAccountingAccess) — นักบัญชีเห็นเฉพาะลูกค้าตัวเอง
 * ★ ออกได้เฉพาะบิลเชื่อที่ยืนยันแล้วเท่านั้น (0.3) — บิลเงินสด/เช็ค/โอน ไม่โผล่ในหน้านี้
 */
export default async function CreditDebitNotesPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; entryId?: string }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-accounting" role={null} authed={false} title="ใบลดหนี้/ใบเพิ่มหนี้" subtitle="แยกจากบิล (บิลเชื่อ)">
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
  const rawEntryId = (sp.entryId ?? "").trim();
  const initialOpenEntryId = UUID_RE.test(rawEntryId) ? rawEntryId : undefined;

  let bills: NoteBillRow[] = [];
  let chart: Awaited<ReturnType<typeof listChartOfAccounts>> = [];
  let loadError = false;
  if (validCustomerId) {
    try {
      const { entries } = await listEntries(service, access.tenantId, { customerId: validCustomerId });
      const eligible = entries.filter(isCreditEligibleForPayment);
      const [paymentsByEntry, notesByEntry, chartData] = await Promise.all([
        listBillPaymentsForEntries(service, access.tenantId, eligible.map((e) => e.id)),
        listNotesForEntries(service, access.tenantId, eligible.map((e) => e.id)),
        listChartOfAccounts(service, access.tenantId),
      ]);
      chart = chartData;
      const netAdjByEntry = netAdjustmentByEntry(notesByEntry);
      bills = eligible
        .map((e) => {
          const payments = paymentsByEntry.get(e.id) ?? [];
          return {
            entryId: e.id,
            entryType: e.entryType as Extract<EntryType, "sale" | "purchase">,
            docNo: e.docNo,
            docDate: e.docDate,
            counterpartyName: e.counterpartyName,
            netTotal: billNetTotal(e),
            outstanding: billOutstanding(e, payments, netAdjByEntry.get(e.id) ?? 0),
            notes: notesByEntry.get(e.id) ?? [],
            // เฟส 10 ส่วน AA (0.10) — สกุลเงิน/อัตราแลกเปลี่ยนของบิลต้นทาง (null = บิล THB ปกติ)
            currency: e.currency ?? null,
            fxRate: e.fxRate ?? null,
          };
        })
        .sort((a, b) => (b.docDate ?? "").localeCompare(a.docDate ?? ""));
    } catch {
      loadError = true;
    }
  }

  return (
    <ChatAuditFrame
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="ใบลดหนี้/ใบเพิ่มหนี้"
      subtitle="เฉพาะบิลเชื่อ (ลูกหนี้/เจ้าหนี้) ที่ยืนยันแล้ว"
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
        ) : !validCustomerId ? (
          <div className="card">
            <p className="empty">เลือกลูกค้าด้านบนเพื่อออกใบลดหนี้/เพิ่มหนี้</p>
          </div>
        ) : loadError ? (
          <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจการตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ migration</div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            <div className="card acc-review-warn" style={{ marginBottom: 12 }}>
              <span className="acc-review-warn-icon" aria-hidden="true">⚠️</span>
              <div className="acc-review-warn-body">
                ไม่กระทบยอดหัก ณ ที่จ่ายเดิมของบิลต้นฉบับ — หากต้องปรับ WHT ให้ใช้ “ลงบันทึกบัญชีเอง” (Manual JE) แยกต่างหาก
              </div>
            </div>
            <CreditDebitNotesPanel
              customerId={validCustomerId}
              bills={bills}
              chart={chart}
              initialOpenEntryId={initialOpenEntryId}
            />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
