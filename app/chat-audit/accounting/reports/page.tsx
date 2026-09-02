import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { Fragment } from "react";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope, type AccountingAccess } from "@/lib/accounting/access";
import { listEntries } from "@/lib/accounting/queries";
import { listOpeningBalances } from "@/lib/accounting/opening-balance";
import { buildStatements } from "@/lib/accounting/statements";
import { buildLedgerStatements } from "@/lib/accounting/ledger-statement";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { filterEntriesForReport, periodLabel, validMonth } from "@/lib/accounting/report-filter";
import ReportsTabs from "./ReportsTabs";
import { loadCombinedJournalLines, flattenCombinedJournalLines } from "@/lib/accounting/statement-inputs";
import { buildPndReport, buildPp30Report } from "@/lib/accounting/rd-export";
import { formatMoney } from "@/lib/accounting/calc";
import { monthKeyOf, thaiMonthLabel } from "@/lib/accounting/monthly";
import type { Statements } from "@/lib/accounting/statements";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TabKey = "journal" | "ledger" | "trial" | "income" | "balance";
const TABS: { key: TabKey; label: string }[] = [
  { key: "journal", label: "สมุดรายวัน" },
  { key: "ledger", label: "บัญชีแยกประเภท" },
  { key: "trial", label: "งบทดลอง" },
  { key: "income", label: "งบกำไรขาดทุน" },
  { key: "balance", label: "งบแสดงฐานะการเงิน" },
];

/** ป้ายชื่อลูกค้า (มีรหัส → "N023 · ชื่อ") */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ลูกค้า";
}

/** วันที่แบบไทย วว/ดด/ปปปป (พ.ศ.) — YYYY-MM-DD → 01/07/2569 (สอดคล้อง formatDateBE) */
function formatDate(iso: string | null): string {
  if (!iso) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) return `${m[3]}/${m[2]}/${Number(m[1]) + 543}`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear() + 543}`;
}

/** ยอดคงเหลือ (debit-positive) → ป้ายพร้อมฝั่ง (Dr/Cr) */
function balanceLabel(bal: number): string {
  if (Math.abs(bal) < 0.005) return "0.00";
  return `${formatMoney(Math.abs(bal))} ${bal > 0 ? "Dr" : "Cr"}`;
}

/** วันที่แบบ พ.ศ. dd/mm/yyyy (ตามรูปแบบ statement สำนักงาน) — parse ตรงกัน TZ ไม่เพี้ยน */
function formatDateBE(iso: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) return `${m[3]}/${m[2]}/${Number(m[1]) + 543}`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear() + 543}`;
}

/** รายชื่อลูกค้าในสโคป (สำหรับ dropdown) — เหมือนหน้า opening */
async function fetchScopedCustomers(
  service: SupabaseClient,
  access: AccountingAccess
): Promise<{ id: string; label: string }[]> {
  const rows = await listScopedCustomers(service, access);
  return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

// ---------- report sections (server render) ----------

/** สมุดรายวัน — จัดกลุ่มต่อบิล (แสดงวันที่/เลขที่เฉพาะบรรทัดแรกของบิล) */
function JournalView({ s }: { s: Statements }) {
  const { lines } = s.journal;
  if (lines.length === 0) return <p className="empty">ยังไม่มีรายการที่ลงบัญชีได้ (ดูรายการตกหล่นด้านบน)</p>;
  let prev = "";
  return (
    <div className="table-wrap">
      <table className="dlv-table acc-table">
        <thead>
          <tr>
            <th>วันที่</th>
            <th>เลขที่</th>
            <th>รหัสบัญชี</th>
            <th>ชื่อบัญชี</th>
            <th className="num">เดบิต</th>
            <th className="num">เครดิต</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const firstOfEntry = l.entryId !== prev;
            prev = l.entryId;
            return (
              <tr key={`${l.entryId}-${i}`} className={firstOfEntry ? "acc-jrow-sep" : ""}>
                <td>{firstOfEntry ? formatDate(l.date) : ""}</td>
                <td>{firstOfEntry ? l.docNo || "—" : ""}</td>
                <td className="mono">{l.accountCode}</td>
                <td className={l.side === "credit" ? "acc-jr-credit" : ""}>{l.accountName}</td>
                <td className="num">{l.debit ? formatMoney(l.debit) : ""}</td>
                <td className="num">{l.credit ? formatMoney(l.credit) : ""}</td>
              </tr>
            );
          })}
          <tr className="acc-total">
            <td colSpan={4} className="strong">รวมทั้งสิ้น</td>
            <td className="num strong">{formatMoney(s.journal.totalDebit)}</td>
            <td className="num strong">{formatMoney(s.journal.totalCredit)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * บัญชีแยกประเภท — แยก "1 บัญชี = 1 ชุด" ตามรูปแบบมาตรฐานสำนักงาน
 *   แต่ละบัญชี: หัว(รหัส·ชื่อ) → B/F ยอดยกมา → รายการ(วันที่ พ.ศ. · เลขที่ · คำอธิบาย · เดบิต · เครดิต · คงเหลือ) → C/F ยอดยกไป → รวม Dr/Cr
 *   บัญชีที่ไม่มีเคลื่อนไหวแต่มียอดยกมา → โชว์แค่ B/F=C/F
 */
function LedgerView({ s }: { s: Statements }) {
  const statements = buildLedgerStatements(s.ledger);
  if (statements.length === 0) return <p className="empty">ยังไม่มีบัญชีที่มีความเคลื่อนไหว</p>;
  return (
    <div className="acc-ledger">
      {statements.map((a) => (
        <div key={a.code} className="acc-ledger-acct">
          <div className="acc-ledger-head">
            <span className="mono strong">{a.code}</span> {a.name}
            <span className="muted"> · {a.category} · ด้านปกติ {a.normalSide === "debit" ? "เดบิต" : "เครดิต"}</span>
          </div>
          <div className="table-wrap">
            <table className="dlv-table acc-table acc-ledger-table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>รายการ</th>
                  <th>คำอธิบาย</th>
                  <th className="num">เดบิต</th>
                  <th className="num">เครดิต</th>
                  <th className="num">คงเหลือ</th>
                </tr>
              </thead>
              <tbody>
                {a.rows.map((r, i) =>
                  r.kind === "txn" ? (
                    <tr key={`${r.entryId}-${i}`}>
                      <td>{formatDateBE(r.date)}</td>
                      <td>{r.docNo || "—"}</td>
                      <td>{r.description || ""}</td>
                      <td className="num">{r.debit ? formatMoney(r.debit) : ""}</td>
                      <td className="num">{r.credit ? formatMoney(r.credit) : ""}</td>
                      <td className="num">{balanceLabel(r.balance)}</td>
                    </tr>
                  ) : (
                    <tr key={r.kind} className="acc-ledger-bf">
                      <td className="strong">{r.kind === "bf" ? "B/F" : "C/F"}</td>
                      <td colSpan={4}>{r.label}</td>
                      <td className="num strong">{balanceLabel(r.balance)}</td>
                    </tr>
                  )
                )}
                <tr className="acc-total">
                  <td colSpan={3} className="strong">
                    รวม · Dr = {a.totals.debitCount.toLocaleString("th-TH")} · Cr = {a.totals.creditCount.toLocaleString("th-TH")}
                  </td>
                  <td className="num strong">{formatMoney(a.totals.debitAmount)}</td>
                  <td className="num strong">{formatMoney(a.totals.creditAmount)}</td>
                  <td className="num strong">{balanceLabel(a.closing)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/** งบทดลอง — จัดกลุ่มหมวด + รวมท้าย */
function TrialView({ s }: { s: Statements }) {
  const tb = s.trialBalance;
  if (tb.rows.length === 0) return <p className="empty">ยังไม่มีข้อมูลสำหรับงบทดลอง</p>;
  return (
    <>
      <div className="table-wrap">
        <table className="dlv-table acc-table">
          <thead>
            <tr>
              <th>รหัส</th>
              <th>ชื่อบัญชี</th>
              <th className="num">ยอดยกมา</th>
              <th className="num">เดบิต</th>
              <th className="num">เครดิต</th>
              <th className="num">ยอดเดบิต</th>
              <th className="num">ยอดเครดิต</th>
            </tr>
          </thead>
          <tbody>
            {tb.groups.map((g) => (
              <Fragment key={g.digit}>
                <tr className="acc-jrow-sep">
                  <td colSpan={7} className="strong">{g.category}</td>
                </tr>
                {g.rows.map((r) => (
                  <tr key={r.code}>
                    <td className="mono">{r.code}</td>
                    <td>{r.name}</td>
                    <td className="num">{r.opening ? formatMoney(r.opening) : ""}</td>
                    <td className="num">{r.debit ? formatMoney(r.debit) : ""}</td>
                    <td className="num">{r.credit ? formatMoney(r.credit) : ""}</td>
                    <td className="num">{r.balance > 0 ? formatMoney(r.balance) : ""}</td>
                    <td className="num">{r.balance < 0 ? formatMoney(-r.balance) : ""}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
            <tr className="acc-total">
              <td colSpan={2} className="strong">รวมทั้งสิ้น</td>
              <td className="num strong">{formatMoney(tb.totalOpening)}</td>
              <td className="num strong">{formatMoney(tb.totalDebit)}</td>
              <td className="num strong">{formatMoney(tb.totalCredit)}</td>
              <td className="num strong">{formatMoney(tb.totalBalanceDebit)}</td>
              <td className="num strong">{formatMoney(tb.totalBalanceCredit)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {!tb.balanced ? (
        <div className="card acc-review-warn" style={{ marginTop: 12 }}>
          <span className="acc-review-warn-icon" aria-hidden="true">⚠️</span>
          <div className="acc-review-warn-body">
            ยอดปลายงวดฝั่งเดบิต ({formatMoney(tb.totalBalanceDebit)}) ไม่เท่ากับฝั่งเครดิต ({formatMoney(tb.totalBalanceCredit)}) —
            มักเกิดจาก “ยอดยกมา” ยังไม่สมดุล ควรตรวจก่อนใช้งบ
          </div>
        </div>
      ) : null}
    </>
  );
}

/** งบกำไรขาดทุน */
function IncomeView({ s }: { s: Statements }) {
  const inc = s.incomeStatement;
  return (
    <div className="table-wrap">
      <table className="dlv-table acc-table">
        <tbody>
          <tr className="acc-jrow-sep"><td className="strong" colSpan={2}>รายได้</td></tr>
          {inc.revenues.map((l) => (
            <tr key={l.code}><td className="mono">{l.code} · {l.name}</td><td className="num">{formatMoney(l.amount)}</td></tr>
          ))}
          <tr className="acc-total"><td className="strong">รวมรายได้</td><td className="num strong">{formatMoney(inc.totalRevenue)}</td></tr>

          <tr className="acc-jrow-sep"><td className="strong" colSpan={2}>ค่าใช้จ่าย</td></tr>
          {inc.expenses.map((l) => (
            <tr key={l.code}><td className="mono">{l.code} · {l.name}</td><td className="num">{formatMoney(l.amount)}</td></tr>
          ))}
          <tr className="acc-total"><td className="strong">รวมค่าใช้จ่าย</td><td className="num strong">{formatMoney(inc.totalExpense)}</td></tr>

          <tr className="acc-total">
            <td className="strong">กำไร(ขาดทุน)สุทธิ</td>
            <td className={`num strong ${inc.netProfit < 0 ? "v-red" : "v-green"}`}>{formatMoney(inc.netProfit)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** งบแสดงฐานะการเงิน */
function BalanceView({ s }: { s: Statements }) {
  const bs = s.balanceSheet;
  return (
    <>
      <div className="table-wrap">
        <table className="dlv-table acc-table">
          <tbody>
            <tr className="acc-jrow-sep"><td className="strong" colSpan={2}>สินทรัพย์</td></tr>
            {bs.assets.map((l) => (
              <tr key={l.code}><td className="mono">{l.code} · {l.name}</td><td className="num">{formatMoney(l.amount)}</td></tr>
            ))}
            <tr className="acc-total"><td className="strong">รวมสินทรัพย์</td><td className="num strong">{formatMoney(bs.totalAssets)}</td></tr>

            <tr className="acc-jrow-sep"><td className="strong" colSpan={2}>หนี้สิน</td></tr>
            {bs.liabilities.map((l) => (
              <tr key={l.code}><td className="mono">{l.code} · {l.name}</td><td className="num">{formatMoney(l.amount)}</td></tr>
            ))}
            <tr className="acc-total"><td className="strong">รวมหนี้สิน</td><td className="num strong">{formatMoney(bs.totalLiabilities)}</td></tr>

            <tr className="acc-jrow-sep"><td className="strong" colSpan={2}>ส่วนของผู้ถือหุ้น</td></tr>
            {bs.equity.map((l) => (
              <tr key={l.code}><td className="mono">{l.code} · {l.name}</td><td className="num">{formatMoney(l.amount)}</td></tr>
            ))}
            <tr><td>กำไร(ขาดทุน)สุทธิของงวด</td><td className="num">{formatMoney(bs.netProfit)}</td></tr>
            <tr className="acc-total"><td className="strong">รวมส่วนของผู้ถือหุ้น</td><td className="num strong">{formatMoney(bs.totalEquityWithProfit)}</td></tr>

            <tr className="acc-total">
              <td className="strong">รวมหนี้สินและส่วนของผู้ถือหุ้น</td>
              <td className="num strong">{formatMoney(bs.totalLiabilities + bs.totalEquityWithProfit)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {bs.balanced ? (
        <div className="card" style={{ marginTop: 12, color: "#16794c" }}>
          ✓ งบสมดุล — สินทรัพย์ = หนี้สิน + ส่วนของผู้ถือหุ้น
        </div>
      ) : (
        <div className="card acc-review-warn" style={{ marginTop: 12 }}>
          <span className="acc-review-warn-icon" aria-hidden="true">⚠️</span>
          <div className="acc-review-warn-body">
            งบยังไม่สมดุล — ผลต่าง {formatMoney(bs.difference)} บาท. ตรวจ “ยอดยกมา” และ “รายการตกหล่น” ให้ครบก่อน
          </div>
        </div>
      )}
    </>
  );
}

/** ประกอบ query string (คงบริบท customer/from/to/draft/tab) */
function buildQuery(p: {
  customerId?: string;
  from?: string;
  to?: string;
  draft?: boolean;
  tab?: TabKey;
}): string {
  const sp = new URLSearchParams();
  if (p.customerId) sp.set("customerId", p.customerId);
  if (p.from) sp.set("from", p.from);
  if (p.to) sp.set("to", p.to);
  if (p.draft === false) sp.set("draft", "0");
  if (p.tab) sp.set("tab", p.tab);
  const str = sp.toString();
  return str ? `?${str}` : "";
}

/**
 * /chat-audit/accounting/reports — "งบการเงิน" (สมุดรายวัน/แยกประเภท/งบทดลอง/กำไรขาดทุน/ฐานะการเงิน)
 *   เลือกลูกค้า (ในสโคป) + ช่วงงวด + รวมร่างหรือไม่ → ออกงบ 5 รายงาน + Export Excel + เตือนรายการตกหล่น
 *
 * ★ guard + scope เดียวกับหน้า accounting (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง) · tenantId จาก session
 */
export default async function AccountingReportsPage({
  searchParams,
}: {
  searchParams: Promise<{
    customerId?: string;
    from?: string;
    to?: string;
    draft?: string;
    tab?: string;
  }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="งบการเงิน" subtitle="รายงานบัญชี">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting/reports");

  const navRole = access.navRole;
  const staffOnly = access.mode === "accountant" || access.mode === "lead";

  const customers = await fetchScopedCustomers(service, access);

  // ---- validate param ----
  const rawCustomer = (sp.customerId ?? "").trim();
  const customerId =
    UUID_RE.test(rawCustomer) &&
    customers.some((c) => c.id === rawCustomer) &&
    customerInScope(access, rawCustomer)
      ? rawCustomer
      : "";
  const from = validMonth(sp.from);
  const to = validMonth(sp.to);
  const includeDraft = sp.draft !== "0"; // default: รวม draft
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key ?? "journal") as TabKey;
  const selectedLabel = customers.find((c) => c.id === customerId)?.label ?? "";

  // ---- โหลด + คำนวณงบ (เมื่อเลือกลูกค้าแล้ว) ----
  let statements: Statements | null = null;
  let monthOptions: string[] = [];
  let draftCount = 0;
  let loadError = false;
  // สรุปจำนวน record + เตือน สำหรับกลุ่มปุ่ม "ยื่นสรรพากร (RD Prep)"
  let rdSummary: {
    pnd3: number;
    pnd53: number;
    pp30Sale: number;
    pp30Purchase: number;
    whtUnspecified: number; // มี wht แต่ยังไม่ระบุแบบ (pnd3/53)
    whtMissingTaxId: number; // แบบตรงแต่ไม่มีเลขภาษี → ยื่นไม่ได้
    pp30MissingTaxId: number; // ใบกำกับในรายงาน VAT ที่ยังไม่มีเลขภาษี
  } | null = null;
  if (customerId) {
    try {
      const { entries } = await listEntries(service, access.tenantId, { customerId });
      monthOptions = [...new Set(entries.map(monthKeyOf).filter((m): m is string => !!m))].sort((a, b) =>
        b.localeCompare(a)
      );
      const filtered = filterEntriesForReport(entries, { from, to, includeDraft });
      draftCount = filtered.filter((e) => e.status !== "confirmed").length;
      const opening = await listOpeningBalances(service, access.tenantId, customerId);
      const chart = await listChartOfAccounts(service, access.tenantId);
      const chartByCode = buildChartByCode(chart);

      // เฟส 1-3 (C/E-F/J, 0.13): manual JE + bill_payments (confirmed) + CN/DN (confirmed) ของลูกค้ารายนี้
      // — กรองงวด/สถานะเหมือนบิล แล้ว concat เข้า ledger/trial-balance/งบ (ไม่กระทบ journal.lines/skipped
      // ของบิลเดิม — ดู statements.ts) สกัดเป็น loadCombinedJournalLines() จุดเดียว (0.13 — เดิมโค้ดซ้ำ
      // 4 จุด: ที่นี่/export route/journal-books ทั้งสองไฟล์)
      const combined = await loadCombinedJournalLines(
        service,
        access.tenantId,
        entries,
        { from, to, includeDraft },
        chartByCode
      );

      statements = buildStatements(filtered, opening, chartByCode, flattenCombinedJournalLines(combined));

      const pnd3 = buildPndReport(filtered, "pnd3");
      const pnd53 = buildPndReport(filtered, "pnd53");
      const pp30Sale = buildPp30Report(filtered, "sale");
      const pp30Purchase = buildPp30Report(filtered, "purchase");
      rdSummary = {
        pnd3: pnd3.totals.count,
        pnd53: pnd53.totals.count,
        pp30Sale: pp30Sale.totals.count,
        pp30Purchase: pp30Purchase.totals.count,
        // unspecifiedForm เหมือนกันทั้ง pnd3/pnd53 (คำนวณจาก wht_form=null) — เอาชุดเดียว
        whtUnspecified: pnd3.issues.unspecifiedForm.length,
        whtMissingTaxId: pnd3.issues.missingTaxId.length + pnd53.issues.missingTaxId.length,
        pp30MissingTaxId: pp30Sale.warnings.missingTaxId + pp30Purchase.warnings.missingTaxId,
      };
    } catch {
      loadError = true;
    }
  }

  const exportBase = "/chat-audit/accounting/reports/export";
  const exportQuery = (report: string) => {
    const q = new URLSearchParams();
    q.set("customerId", customerId);
    q.set("report", report);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    if (!includeDraft) q.set("draft", "0");
    return `${exportBase}?${q.toString()}`;
  };

  // ยื่นสรรพากร (RD Prep): เลือกแบบ + รูปแบบไฟล์ (txt/xlsx)
  const rdExportBase = "/chat-audit/accounting/reports/rd-export";
  const rdQuery = (rdForm: string, fmt: "txt" | "xlsx", withHeader?: boolean) => {
    const q = new URLSearchParams();
    q.set("customerId", customerId);
    q.set("form", rdForm);
    q.set("fmt", fmt);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    if (!includeDraft) q.set("draft", "0");
    if (withHeader) q.set("header", "1");
    return `${rdExportBase}?${q.toString()}`;
  };
  const RD_ITEMS: { form: string; label: string; count: number }[] = rdSummary
    ? [
        { form: "pnd3", label: "ภ.ง.ด.3", count: rdSummary.pnd3 },
        { form: "pnd53", label: "ภ.ง.ด.53", count: rdSummary.pnd53 },
        { form: "pp30-sale", label: "ภ.พ.30 ภาษีขาย", count: rdSummary.pp30Sale },
        { form: "pp30-purchase", label: "ภ.พ.30 ภาษีซื้อ", count: rdSummary.pp30Purchase },
      ]
    : [];

  return (
    <ChatAuditFrame bare={embed}
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="งบการเงิน"
      subtitle="ปิดวงจรบัญชี — สมุดรายวัน · แยกประเภท · งบทดลอง · กำไรขาดทุน · ฐานะการเงิน"
    >
      <div className="dash-views">
        {/* ---- toolbar: เลือกลูกค้า + งวด + รวมร่าง ---- */}
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
              ตั้งแต่:{" "}
              <select name="from" defaultValue={from}>
                <option value="">— ต้น —</option>
                {monthOptions.map((m) => (
                  <option key={m} value={m}>{thaiMonthLabel(m)}</option>
                ))}
              </select>
            </label>
            <label>
              ถึง:{" "}
              <select name="to" defaultValue={to}>
                <option value="">— ล่าสุด —</option>
                {monthOptions.map((m) => (
                  <option key={m} value={m}>{thaiMonthLabel(m)}</option>
                ))}
              </select>
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" name="draft" value="0" defaultChecked={!includeDraft} />
              เฉพาะที่ยืนยันแล้ว
            </label>
            {tab !== "journal" ? <input type="hidden" name="tab" value={tab} /> : null}
            <button type="submit" className="btn">แสดงงบ</button>
          </form>
          <span className="acc-toolbar-spacer" />
          <Link href="/chat-audit/accounting" className="btn btn-ghost">← กลับไปลงบันทึกบัญชี</Link>
        </div>

        {!customerId ? (
          <div className="card">
            <p className="empty">
              {customers.length === 0 ? "ยังไม่มีลูกค้าในความดูแลของคุณ" : "เลือกลูกค้าด้านบนเพื่อออกงบการเงิน"}
            </p>
          </div>
        ) : loadError ? (
          <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ apply migration ครบ</div>
        ) : statements ? (
          <>
            {/* ---- แถบกิจการ + งวด ---- */}
            <div className="card acc-scopebar">
              <span className="acc-scope-label">{selectedLabel}</span>
              <span className="muted">งวด: {periodLabel(from, to)} · {includeDraft ? "รวมร่าง+ยืนยันแล้ว" : "เฉพาะยืนยันแล้ว"}</span>
            </div>

            {/* ---- เตือน: รายการตกหล่น + ร่าง ---- */}
            {statements.journal.skipped.length > 0 || (includeDraft && draftCount > 0) ? (
              <div className="card acc-review-warn">
                <span className="acc-review-warn-icon" aria-hidden="true">⚠️</span>
                <div className="acc-review-warn-body">
                  <div className="acc-review-warn-title">ตรวจก่อนใช้งบ</div>
                  <ul className="acc-review-warn-list">
                    {statements.journal.skipped.length > 0 ? (
                      <li>
                        มี <strong>{statements.journal.skipped.length.toLocaleString("th-TH")}</strong> บิลที่
                        <strong>ยังไม่เข้างบ</strong> (ตกหล่น) — ดูรายละเอียด/เหตุผลด้านล่าง
                        {/* ★ 2026-09-02 ผู้ใช้: ปุ่มลิงก์ไปหน้าบิลที่ยังไม่ปิด */}
                        <a
                          className="btn btn-ghost"
                          style={{ marginLeft: 8 }}
                          href={`/chat-audit/accounting?edit=${statements.journal.skipped[0].entryId}`}
                          target="_blank"
                          rel="noopener"
                        >
                          แก้บิลที่ตกหล่น ↗
                        </a>
                      </li>
                    ) : null}
                    {includeDraft && draftCount > 0 ? (
                      <li>
                        รวมบิล <strong>ร่าง {draftCount.toLocaleString("th-TH")}</strong> ใบในงบนี้ (ติ๊ก “เฉพาะที่ยืนยันแล้ว” เพื่อตัดออก)
                        <a
                          className="btn btn-ghost"
                          style={{ marginLeft: 8 }}
                          href={`/chat-audit/accounting?open=${customerId}`}
                          target="_blank"
                          rel="noopener"
                        >
                          ไปหน้าตรวจ/ยืนยันบิล ↗
                        </a>
                      </li>
                    ) : null}
                  </ul>
                </div>
              </div>
            ) : null}

            {/* ---- รายการตกหล่น (รายละเอียด) ---- */}
            {statements.journal.skipped.length > 0 ? (
              <details className="card">
                <summary className="strong" style={{ cursor: "pointer" }}>
                  รายการที่ตกหล่น {statements.journal.skipped.length.toLocaleString("th-TH")} บิล (ยังไม่เข้างบ)
                </summary>
                <div className="table-wrap" style={{ marginTop: 10 }}>
                  <table className="dlv-table acc-table">
                    <thead>
                      <tr><th>วันที่</th><th>เลขที่</th><th>ประเภท</th><th>เหตุผลที่ตกหล่น</th><th>แก้ไข</th></tr>
                    </thead>
                    <tbody>
                      {statements.journal.skipped.map((sk, i) => (
                        <tr key={`${sk.entryId}-${i}`}>
                          <td>{formatDate(sk.date)}</td>
                          <td>{sk.docNo || "—"}</td>
                          <td>{sk.entryType === "purchase" ? "ซื้อ" : sk.entryType === "sale" ? "ขาย" : "รอระบุ"}</td>
                          <td>{sk.reason}</td>
                          <td>
                            {/* ★ 2026-09-02 ผู้ใช้: ลิงก์ตรงไปหน้าตรวจ/แก้บิลใบนั้น — แก้เสร็จกลับมาริเฟรชงบ */}
                            <a className="btn btn-ghost" href={`/chat-audit/accounting?edit=${sk.entryId}`} target="_blank" rel="noopener">
                              แก้บิล ↗
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}

            {/* ---- แท็บรายงาน + ปุ่ม Export ----
                 ★ 2026-09-02 ผู้ใช้: กดแท็บช้า — เดิม Link โหลดหน้าใหม่ (ดึงบิล+คำนวณงบใหม่ทุกคลิก)
                 แก้: render ทั้ง 5 รายงานรอบเดียว (statements คำนวณครบอยู่แล้ว) → สลับฝั่ง client ทันที */}
            <div className="card">
              <ReportsTabs
                tabs={TABS}
                initial={tab}
                exportHrefs={TABS.map((t) => exportQuery(t.key))}
                allHref={exportQuery("all")}
              >
                <JournalView s={statements} />
                <LedgerView s={statements} />
                <TrialView s={statements} />
                <IncomeView s={statements} />
                <BalanceView s={statements} />
              </ReportsTabs>
            </div>

            {/* ---- ยื่นสรรพากร (RD Prep) ---- */}
            <div className="card">
              <div className="strong" style={{ fontSize: 15, marginBottom: 4 }}>
                ยื่นสรรพากร (RD Prep)
              </div>
              <p className="muted" style={{ marginTop: 0, marginBottom: 12 }}>
                ไฟล์สำหรับนำเข้าโปรแกรม RD Prep — .txt (คั่นด้วย |) และ Excel (ไว้ตรวจ)
                RD Prep ให้จับคู่คอลัมน์เองตอน import ครั้งแรก (แล้วจำ mapping ไว้ใช้ครั้งถัดไป)
                — ถ้ายังไม่เคยตั้งค่า mapping มาก่อน ใช้ตัว &quot;มีหัวคอลัมน์&quot; จะช่วยให้จับคู่ง่ายขึ้น
              </p>

              <div className="table-wrap">
                <table className="dlv-table acc-table">
                  <thead>
                    <tr>
                      <th>แบบ</th>
                      <th className="num">จำนวน record</th>
                      <th>ดาวน์โหลด</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RD_ITEMS.map((it) => (
                      <tr key={it.form}>
                        <td className="strong">{it.label}</td>
                        <td className="num">{it.count.toLocaleString("th-TH")}</td>
                        <td style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <a
                            href={rdQuery(it.form, "txt")}
                            className={`btn btn-sm${it.count === 0 ? " btn-ghost" : ""}`}
                          >
                            ⬇ .txt
                          </a>
                          <a
                            href={rdQuery(it.form, "txt", true)}
                            className="btn btn-sm btn-ghost"
                            title="เติมบรรทัดแรกเป็นชื่อคอลัมน์ — ช่วยตอน setup จับคู่คอลัมน์ครั้งแรกใน RD Prep"
                          >
                            ⬇ .txt (มีหัวคอลัมน์)
                          </a>
                          <a
                            href={rdQuery(it.form, "xlsx")}
                            className={`btn btn-sm btn-ghost`}
                          >
                            ⬇ Excel
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* เตือนบิลที่ยื่นไม่ได้/ต้องแก้ก่อน */}
              {rdSummary &&
              (rdSummary.whtUnspecified > 0 ||
                rdSummary.whtMissingTaxId > 0 ||
                rdSummary.pp30MissingTaxId > 0) ? (
                <div className="card acc-review-warn" style={{ marginTop: 12 }}>
                  <span className="acc-review-warn-icon" aria-hidden="true">⚠️</span>
                  <div className="acc-review-warn-body">
                    <div className="acc-review-warn-title">ตรวจก่อนยื่น</div>
                    <ul className="acc-review-warn-list">
                      {rdSummary.whtUnspecified > 0 ? (
                        <li>
                          มี <strong>{rdSummary.whtUnspecified.toLocaleString("th-TH")}</strong> บิลหัก ณ ที่จ่ายที่
                          <strong>ยังไม่ระบุแบบ</strong> (ภ.ง.ด.3 หรือ 53) — ระบุก่อนถึงจะเข้าไฟล์ยื่น
                        </li>
                      ) : null}
                      {rdSummary.whtMissingTaxId > 0 ? (
                        <li>
                          มี <strong>{rdSummary.whtMissingTaxId.toLocaleString("th-TH")}</strong> บิลหัก ณ ที่จ่ายที่
                          <strong>ไม่มีเลขผู้เสียภาษี</strong> — ยื่นไม่ได้ (ตัดออกจากไฟล์) ต้องเติมเลขภาษีก่อน
                        </li>
                      ) : null}
                      {rdSummary.pp30MissingTaxId > 0 ? (
                        <li>
                          รายงานภาษีขาย/ซื้อมี <strong>{rdSummary.pp30MissingTaxId.toLocaleString("th-TH")}</strong> ใบกำกับที่
                          <strong>ยังไม่มีเลขผู้เสียภาษี</strong> (ยังอยู่ในไฟล์ แต่ควรเติมก่อนยื่น)
                        </li>
                      ) : null}
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </ChatAuditFrame>
  );
}
