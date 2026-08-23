import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listEntries } from "@/lib/accounting/queries";
import { billNetTotal } from "@/lib/accounting/bill-payments";
import {
  isTaxInvoiceEligible,
  listTaxInvoicesForEntries,
  listTaxInvoices,
  TAX_INVOICE_FORM_LABELS,
} from "@/lib/accounting/tax-invoice";
import TaxInvoicesPanel, { type EligibleBillRow } from "./TaxInvoicesPanel";
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

/** รายชื่อลูกค้าในสโคปของผู้เรียก (id + label) — mirror หน้าอื่น (payments/sales-documents) */
async function fetchScopedCustomers(
  service: SupabaseClient,
  access: AccountingAccess
): Promise<{ id: string; label: string }[]> {
  const rows = await listScopedCustomers(service, access);
  return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

/**
 * /chat-audit/accounting/tax-invoices — "ใบกำกับภาษี" (เต็มรูป/อย่างย่อ)
 *   เลือกลูกค้า (ในสโคป) → list บิลขายที่ยืนยันแล้วของลูกค้ารายนั้น → ออกใบกำกับภาษีจากบิล (แสดงบิลที่
 *   ออกไปแล้วให้เห็นด้วยว่าเลขที่อะไร) → ดู/พิมพ์/ยกเลิกใบกำกับภาษีที่ออกไปแล้ว
 *
 * ★ guard + scope เดียวกับหน้าอื่น (resolveAccountingAccess) — นักบัญชีเห็นเฉพาะลูกค้าตัวเอง
 * ★ ออกได้เฉพาะบิลขาย (entry_type='sale') ที่ยืนยันแล้ว (status='confirmed') — ดู isTaxInvoiceEligible
 * ★ ไม่กระทบบัญชีแยกประเภท/งบการเงินเลย — แค่แสดงยอด/VAT ที่ลงบัญชีไปแล้วตอนยืนยันบิล
 */
export default async function TaxInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="ใบกำกับภาษี" subtitle="เต็มรูป/อย่างย่อ — ออกจากบิลขายที่ยืนยันแล้ว">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting/tax-invoices");

  const navRole = access.navRole;
  const staffOnly = access.mode === "accountant" || access.mode === "lead";

  const customers = await fetchScopedCustomers(service, access);

  const rawCustomer = (sp.customerId ?? "").trim();
  const validCustomerId =
    UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";
  const selectedLabel = customers.find((c) => c.id === validCustomerId)?.label ?? "";

  let eligibleBills: EligibleBillRow[] = [];
  let issuedCount = 0;
  let loadError = false;
  if (validCustomerId) {
    try {
      const { entries } = await listEntries(service, access.tenantId, {
        customerId: validCustomerId,
        entryType: "sale",
        status: "confirmed",
      });
      const eligible = entries.filter((e) => isTaxInvoiceEligible({ entryType: e.entryType, status: e.status }));
      const invoiceByEntry = await listTaxInvoicesForEntries(service, access.tenantId, eligible.map((e) => e.id));
      const issued = await listTaxInvoices(service, access.tenantId, validCustomerId);
      issuedCount = issued.filter((i) => i.status === "issued").length;

      eligibleBills = eligible.map((e) => {
        const invoice = invoiceByEntry.get(e.id);
        return {
          entryId: e.id,
          docNo: e.docNo,
          docDate: e.docDate,
          counterpartyName: e.counterpartyName,
          counterpartyTaxId: e.counterpartyTaxId,
          netTotal: billNetTotal(e),
          issuedInvoiceId: invoice?.id ?? null,
          issuedDocNo: invoice?.docNo ?? null,
          issuedFormLabel: invoice ? TAX_INVOICE_FORM_LABELS[invoice.formType] : null,
        };
      });
    } catch {
      loadError = true;
    }
  }

  return (
    <ChatAuditFrame bare={embed}
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="ใบกำกับภาษี"
      subtitle="เต็มรูป/อย่างย่อ — ออกจากบิลขายที่ยืนยันแล้ว (ไม่กระทบบัญชีแยกประเภท/งบการเงิน)"
    >
      <div className="dash-views">
        <div className="card acc-review-head">
          <form method="get" className="acc-opening-cust">
            <label>
              ลูกค้า:{" "}
              <select name="customerId" defaultValue={validCustomerId}>
                <option value="">— เลือกลูกค้า —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn">เปิด</button>
          </form>
          <span className="acc-toolbar-spacer" />
          <Link href="/chat-audit/accounting" className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
        </div>

        {customers.length === 0 ? (
          <div className="card"><p className="empty">ยังไม่มีลูกค้าในความดูแลของคุณ</p></div>
        ) : !validCustomerId ? (
          <div className="card"><p className="empty">เลือกลูกค้าด้านบนเพื่อออกใบกำกับภาษี</p></div>
        ) : loadError ? (
          <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ apply migration ครบ</div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel} · ออกแล้ว {issuedCount} ใบ</div>
            <TaxInvoicesPanel customerId={validCustomerId} bills={eligibleBills} />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
