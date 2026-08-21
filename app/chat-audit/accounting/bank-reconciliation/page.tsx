import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { listCustomerBankAccounts, bankAccountDisplayName, type CustomerBankAccount } from "@/lib/accounting/bank-accounts";
import {
  listBookLines,
  listStatementLines,
  listBatches,
  suggestMatches,
  buildReconciliationSummary,
  type BookLine,
  type BankStatementLine,
  type SuggestedMatch,
  type ImportBatch,
} from "@/lib/accounting/bank-reconciliation";
import BankReconciliationPanel from "./BankReconciliationPanel";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_OPTION_LABELS = [
  "01 - ม.ค.", "02 - ก.พ.", "03 - มี.ค.", "04 - เม.ย.", "05 - พ.ค.", "06 - มิ.ย.",
  "07 - ก.ค.", "08 - ส.ค.", "09 - ก.ย.", "10 - ต.ค.", "11 - พ.ย.", "12 - ธ.ค.",
];

/** ป้ายชื่อลูกค้า (มีรหัส → "N023 · ชื่อ") */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ลูกค้า";
}

/** รายชื่อลูกค้าในสโคป (สำหรับ dropdown) — เหมือนหน้าอื่นในเฟส 6 */
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
 * /chat-audit/accounting/bank-reconciliation — "กระทบยอดธนาคาร" (เฟส 6 ส่วน T)
 *   เลือกลูกค้า (ในสโคป) → เลือกบัญชีเงินฝาก (customer_bank_accounts ของลูกค้านั้น) → เลือกงวด (เดือน)
 *   → เทียบฝั่งบัญชี (book) กับ statement ธนาคาร (นำเข้า CSV/กรอกมือ) — ทำทีละ 1 บัญชี ต่อ 1 งวด (0.19)
 *
 * ★ guard + scope เดียวกับหน้าอื่น (resolveAccountingAccess) — นักบัญชีเห็นเฉพาะลูกค้าตัวเอง
 * ★ ฝั่ง book = pipeline เดิมทั้งชุด (listBookLines wrap buildJournalEntries+loadCombinedJournalLines) —
 *   ไม่มีสูตร/แหล่งข้อมูลคู่ขนานใหม่ (0.14)
 */
export default async function BankReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; bankAccountId?: string; month?: string; draft?: string; embed?: string }>;
}) {
  const sp = await searchParams;
  const embed = sp.embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อนเมนู แสดงเฉพาะเนื้อหา

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-accounting" role={null} authed={false} title="กระทบยอดธนาคาร" subtitle="เทียบยอดบัญชีเงินฝากกับ statement ธนาคารจริง">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting/bank-reconciliation");

  const navRole = access.navRole;
  const staffOnly = access.mode === "accountant" || access.mode === "lead";

  const customers = await fetchScopedCustomers(service, access);

  const rawCustomer = (sp.customerId ?? "").trim();
  const customerId = UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";
  const selectedCustomerLabel = customers.find((c) => c.id === customerId)?.label ?? "";

  // งวด (เดือนเดียว — 0.19) ค่าเริ่มต้น = เดือนปัจจุบัน
  const now = new Date();
  const defaultMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const rawMonth = (sp.month ?? "").trim();
  const month = /^\d{4}-\d{2}$/.test(rawMonth) ? rawMonth : defaultMonth;
  const monthOptions = (() => {
    const [y] = month.split("-");
    return MONTH_OPTION_LABELS.map((label, idx) => ({ value: `${y}-${String(idx + 1).padStart(2, "0")}`, label }));
  })();
  const includeDraft = sp.draft !== "0";

  let bankAccounts: CustomerBankAccount[] = [];
  let loadError = false;
  if (customerId) {
    try {
      bankAccounts = await listCustomerBankAccounts(service, access.tenantId, customerId);
    } catch {
      loadError = true;
    }
  }

  const rawBankAccountId = (sp.bankAccountId ?? "").trim();
  const bankAccountId =
    UUID_RE.test(rawBankAccountId) && bankAccounts.some((b) => b.id === rawBankAccountId) ? rawBankAccountId : "";
  const selectedBankAccount = bankAccounts.find((b) => b.id === bankAccountId) ?? null;

  let bookLines: BookLine[] = [];
  let statementLines: BankStatementLine[] = [];
  let suggestions: SuggestedMatch[] = [];
  let summary: ReturnType<typeof buildReconciliationSummary> | null = null;
  let batches: ImportBatch[] = [];

  if (customerId && selectedBankAccount) {
    try {
      const chart = await listChartOfAccounts(service, access.tenantId);
      const chartByCode = buildChartByCode(chart);
      const period = { from: month, to: month, includeDraft };

      bookLines = await listBookLines(service, access.tenantId, customerId, selectedBankAccount.accountCode, period, chartByCode);
      statementLines = await listStatementLines(service, access.tenantId, customerId, bankAccountId, period);
      batches = await listBatches(service, access.tenantId, customerId, bankAccountId);
      suggestions = suggestMatches(bookLines, statementLines);
      summary = buildReconciliationSummary(bookLines, statementLines);
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
      bare={embed}
      title="กระทบยอดธนาคาร"
      subtitle="เทียบยอดบัญชีเงินฝากในระบบกับ statement ธนาคารจริง (นำเข้า CSV หรือกรอกมือ)"
    >
      <div className="dash-views">
        <div className="card acc-review-head">
          <form method="get" className="acc-opening-cust" style={{ gap: 10, flexWrap: "wrap" }}>
            <label>
              ลูกค้า:{" "}
              <select name="customerId" defaultValue={customerId}>
                <option value="">— เลือกลูกค้า —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </label>
            <label>
              บัญชีเงินฝาก:{" "}
              <select name="bankAccountId" defaultValue={bankAccountId}>
                <option value="">— เลือกบัญชี —</option>
                {bankAccounts.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.accountCode} · {bankAccountDisplayName(b)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              งวด:{" "}
              <select name="month" defaultValue={month}>
                {monthOptions.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" name="draft" value="0" defaultChecked={!includeDraft} />
              เฉพาะที่ยืนยันแล้ว
            </label>
            <button type="submit" className="btn">แสดง</button>
          </form>
          <span className="acc-toolbar-spacer" />
          <Link href="/chat-audit/accounting" className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
        </div>

        {customers.length === 0 ? (
          <div className="card"><p className="empty">ยังไม่มีลูกค้าในความดูแลของคุณ</p></div>
        ) : !customerId ? (
          <div className="card"><p className="empty">เลือกลูกค้าด้านบนเพื่อกระทบยอดธนาคาร</p></div>
        ) : bankAccounts.length === 0 ? (
          <div className="card">
            <p className="empty">ลูกค้ารายนี้ยังไม่มีบัญชีเงินฝาก — เพิ่มบัญชีเงินฝากของลูกค้าก่อน (ผังบัญชีที่หน้า &ldquo;รับ/จ่ายเงิน&rdquo; หรือ &ldquo;ยอดยกมา&rdquo;)</p>
          </div>
        ) : !bankAccountId ? (
          <div className="card"><p className="empty">เลือกบัญชีเงินฝากด้านบนเพื่อกระทบยอด</p></div>
        ) : loadError ? (
          <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ apply migration ครบ</div>
        ) : (
          <>
            <div className="card acc-scopebar">
              <span className="acc-scope-label">{selectedCustomerLabel}</span>
              <span className="muted">
                {selectedBankAccount!.accountCode} · {bankAccountDisplayName(selectedBankAccount!)} · งวด {month}
              </span>
            </div>

            <BankReconciliationPanel
              customerId={customerId}
              bankAccountId={bankAccountId}
              accountCode={selectedBankAccount!.accountCode}
              month={month}
              includeDraft={includeDraft}
              bookLines={bookLines}
              statementLines={statementLines}
              suggestions={suggestions}
              summary={summary!}
              batches={batches}
            />
          </>
        )}
      </div>
    </ChatAuditFrame>
  );
}
