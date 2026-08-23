import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listEntries, type EntryType } from "@/lib/accounting/queries";
import { listCustomerBankAccounts, type CustomerBankAccount } from "@/lib/accounting/bank-accounts";
import {
  isCreditEligibleForPayment,
  billNetTotal,
  billOutstanding,
  listBillPaymentsForEntries,
} from "@/lib/accounting/bill-payments";
import { listInstallmentsForEntries } from "@/lib/accounting/bill-installments";
import { listNotesForEntries, netAdjustmentByEntry } from "@/lib/accounting/credit-debit-notes";
import { ageBucket, type AgingBucketKey } from "@/lib/accounting/aging";
import { EPSILON } from "@/lib/accounting/statement-config";
import PaymentsPanel, { type PaymentBillRow } from "./PaymentsPanel";
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

/** วันนี้เวลาไทย → "YYYY-MM-DD" (ใช้ตั้งกลุ่มอายุหนี้ + default วันที่รับ/จ่ายเงิน) */
function todayThai(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
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
  const rows = await listScopedCustomers(service, access);
  return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

/**
 * /chat-audit/accounting/payments — "บันทึกรับ/จ่ายเงิน" (แยกจากบิล — เฟส 2 ส่วน E/F)
 *   เลือกลูกค้า (ในสโคป) → list บิลเชื่อ (payment_method='credit', confirmed) ที่ยังค้างชำระของลูกค้ารายนั้น
 *   → บันทึก/ยกเลิกการรับ-จ่ายเงินต่อบิล
 *
 * ★ guard + scope เดียวกับหน้า accounting/opening (resolveAccountingAccess) — นักบัญชีเห็นเฉพาะลูกค้าตัวเอง
 * ★ tenantId จาก session · ไม่ log ชื่อ/ตัวเลข
 * ★ บิล cash/transfer/cheque ไม่โผล่ในหน้านี้เลย (จ่ายเงินเสร็จสิ้นตอนยืนยันบิลแล้ว — 0.1)
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="รับ/จ่ายเงิน" subtitle="แยกจากบิล (บิลเชื่อ)">
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

  let bills: PaymentBillRow[] = [];
  let bankAccounts: CustomerBankAccount[] = [];
  let loadError = false;
  if (validCustomerId) {
    try {
      const { entries } = await listEntries(service, access.tenantId, { customerId: validCustomerId });
      const eligible = entries.filter(isCreditEligibleForPayment);
      const paymentsByEntry = await listBillPaymentsForEntries(
        service,
        access.tenantId,
        eligible.map((e) => e.id)
      );
      // เฟส 3 ส่วน J (0.6): CN/DN "confirmed" ของบิลที่แสดง → ปรับยอดค้างชำระทันที (ก่อนบันทึกรับเงินใด ๆ)
      const notesByEntry = await listNotesForEntries(
        service,
        access.tenantId,
        eligible.map((e) => e.id)
      );
      const netAdjByEntry = netAdjustmentByEntry(notesByEntry);
      const asOfDate = todayThai();
      // ★ wishlist ข้อ 7 — แผนงวดผ่อนชำระ (schedule อ้างอิงเท่านั้น ไม่กระทบ outstanding/AR-AP)
      const installmentsByEntry = await listInstallmentsForEntries(
        service,
        access.tenantId,
        eligible.map((e) => e.id)
      );
      bills = eligible
        .map((e) => {
          const payments = paymentsByEntry.get(e.id) ?? [];
          return {
            entryId: e.id,
            entryType: e.entryType as Extract<EntryType, "sale" | "purchase">,
            docNo: e.docNo,
            docDate: e.docDate,
            dueDate: e.dueDate,
            counterpartyName: e.counterpartyName,
            netTotal: billNetTotal(e),
            outstanding: billOutstanding(e, payments, netAdjByEntry.get(e.id) ?? 0),
            bucket: ageBucket(e.dueDate, asOfDate) as AgingBucketKey,
            payments,
            installments: installmentsByEntry.get(e.id) ?? [],
            // ★ wishlist ข้อ 7 — บิลนี้มี CN/DN ที่ confirmed แล้วปรับยอดอยู่ไหม (ใช้เตือนใน UI เท่านั้น —
            //   แผนงวดชำระคำนวณจาก billNetTotal เดิมตอนตั้งแผน ไม่รู้จัก CN/DN ที่มาทีหลัง สถานะต่องวดอาจ
            //   ไม่ตรงกับยอดคงค้างจริงถ้ามีการปรับยอดหลังตั้งแผน — ดู PaymentsPanel.tsx)
            hasNoteAdjustment: Math.abs(netAdjByEntry.get(e.id) ?? 0) > EPSILON,
            // เฟส 10 ส่วน AA — สกุลเงิน/อัตราแลกเปลี่ยนตอนออกบิล (null = บิล THB ปกติ, ไม่โชว์ช่อง fx เลย)
            currency: e.currency ?? null,
            fxRate: e.fxRate ?? null,
          };
        })
        .filter((b) => b.outstanding > EPSILON)
        .sort((a, b) => (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99"));
      bankAccounts = await listCustomerBankAccounts(service, access.tenantId, validCustomerId);
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
      title="รับ/จ่ายเงิน"
      subtitle="แยกจากบิล — เฉพาะบิลเชื่อ (ลูกหนี้/เจ้าหนี้) ที่ยังค้างชำระ"
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
          <Link href="/chat-audit/accounting/ar-ap-aging" className="btn btn-ghost">
            ดูรายงานลูกหนี้/เจ้าหนี้ค้างชำระ →
          </Link>
          <Link href="/chat-audit/accounting" className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
        </div>

        {customers.length === 0 ? (
          <div className="card">
            <p className="empty">ยังไม่มีลูกค้าในความดูแลของคุณ</p>
          </div>
        ) : !validCustomerId ? (
          <div className="card">
            <p className="empty">เลือกลูกค้าด้านบนเพื่อบันทึกรับ/จ่ายเงิน</p>
          </div>
        ) : loadError ? (
          <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจการตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ migration</div>
        ) : (
          <div className="card">
            <div className="acc-opening-cust-label">{selectedLabel}</div>
            <PaymentsPanel customerId={validCustomerId} bills={bills} bankAccounts={bankAccounts} />
          </div>
        )}
      </div>
    </ChatAuditFrame>
  );
}
