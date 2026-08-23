import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { Fragment } from "react";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, type AccountingAccess } from "@/lib/accounting/access";
import { listEntries } from "@/lib/accounting/queries";
import { listOpeningBalances } from "@/lib/accounting/opening-balance";
import { buildStatements } from "@/lib/accounting/statements";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { loadCombinedJournalLines, flattenCombinedJournalLines } from "@/lib/accounting/statement-inputs";
import { filterEntriesForReport } from "@/lib/accounting/report-filter";
import { listBudgetYear, buildBudgetComparison, YEAR_MIN, YEAR_MAX, type BudgetComparisonRow } from "@/lib/accounting/budget";
import { formatMoney } from "@/lib/accounting/calc";
import BudgetPanel from "./BudgetPanel";
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

/** รายชื่อลูกค้าในสโคป (สำหรับ dropdown) — เหมือนหน้า opening/reports/recurring-journal */
async function fetchScopedCustomers(
  service: SupabaseClient,
  access: AccountingAccess
): Promise<{ id: string; label: string }[]> {
  const rows = await listScopedCustomers(service, access);
  return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

/** ป้ายเปอร์เซ็นต์ผลต่าง — null = ยังไม่ตั้งงบ (กันหารด้วยศูนย์ — 0.11/T45) */
function diffPercentLabel(v: number | null): string {
  if (v === null) return "N/A";
  return `${v > 0 ? "+" : ""}${v.toLocaleString("th-TH", { maximumFractionDigits: 1 })}%`;
}

/** ตารางเทียบงบ/จริง/ผลต่าง/% จัดกลุ่มตามหมวด (mirror TrialView ของ reports/page.tsx) */
function ComparisonView({ rows }: { rows: BudgetComparisonRow[] }) {
  if (rows.length === 0) {
    return <p className="empty">ยังไม่มีข้อมูลให้เทียบ (ยังไม่ได้ตั้งงบ/ยังไม่มีรายการจริงในงวดนี้)</p>;
  }
  const groups = new Map<string, BudgetComparisonRow[]>();
  for (const r of rows) {
    const arr = groups.get(r.category) ?? [];
    arr.push(r);
    groups.set(r.category, arr);
  }
  let totalBudget = 0;
  let totalActual = 0;
  for (const r of rows) {
    totalBudget += r.budget;
    totalActual += r.actual;
  }
  return (
    <div className="table-wrap">
      <table className="dlv-table acc-table">
        <thead>
          <tr>
            <th>รหัส</th>
            <th>ชื่อบัญชี</th>
            <th className="num">งบประมาณ</th>
            <th className="num">จริง</th>
            <th className="num">ผลต่าง (จริง−งบ)</th>
            <th className="num">% ผลต่าง</th>
          </tr>
        </thead>
        <tbody>
          {[...groups.entries()].map(([category, groupRows]) => (
            <Fragment key={category}>
              <tr className="acc-jrow-sep">
                <td colSpan={6} className="strong">{category}</td>
              </tr>
              {groupRows.map((r) => (
                <tr key={r.accountCode}>
                  <td className="mono">{r.accountCode}</td>
                  <td>{r.accountName}</td>
                  <td className="num">{formatMoney(r.budget)}</td>
                  <td className="num">{formatMoney(r.actual)}</td>
                  <td className={`num ${r.diff > 0 ? "acc-budget-diff-pos" : r.diff < 0 ? "acc-budget-diff-neg" : ""}`}>
                    {formatMoney(r.diff)}
                  </td>
                  <td className="num">{diffPercentLabel(r.diffPercent)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
          <tr className="acc-total">
            <td colSpan={2} className="strong">รวมทั้งสิ้น</td>
            <td className="num strong">{formatMoney(totalBudget)}</td>
            <td className="num strong">{formatMoney(totalActual)}</td>
            <td className="num strong">{formatMoney(totalActual - totalBudget)}</td>
            <td className="num strong"></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * /chat-audit/accounting/budget — "งบประมาณ" (เฟส 6 ส่วน S)
 *   เลือกลูกค้า (ในสโคป) + ปี → ตั้งงบต่อรหัสบัญชี/เดือน (BudgetPanel) + ตารางเทียบงบ/จริง/ผลต่าง/%
 *   ของงวดที่เลือก (เดือน/ไตรมาส/ปี — เลือกช่วงได้เหมือนหน้างบการเงิน)
 *
 * ★ guard + scope เดียวกับหน้าอื่น (resolveAccountingAccess) — นักบัญชีเห็นเฉพาะลูกค้าตัวเอง
 * ★ ยอดจริง = อ่านจาก pipeline เดิมทั้งชุด (listEntries → filterEntriesForReport →
 *   loadCombinedJournalLines → buildStatements(=buildLedger+buildTrialBalance)) ไม่มีสูตรคำนวณคู่ขนาน (0.10)
 */
export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; year?: string; from?: string; to?: string; draft?: string }>;
}) {
  const sp = await searchParams;
  const embed = (sp as { embed?: string }).embed === "1"; // ฝังในโต๊ะทำงาน (iframe) → ซ่อน nav

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame bare={embed} active="chat-accounting" role={null} authed={false} title="งบประมาณ" subtitle="ตั้งงบต่อรหัสบัญชี/เดือน/ปี เทียบกับยอดจริง">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting/budget");

  const navRole = access.navRole;
  const staffOnly = access.mode === "accountant" || access.mode === "lead";

  const customers = await fetchScopedCustomers(service, access);
  const chart = await listChartOfAccounts(service, access.tenantId);

  const rawCustomer = (sp.customerId ?? "").trim();
  const customerId =
    UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";
  const selectedLabel = customers.find((c) => c.id === customerId)?.label ?? "";

  const nowCe = new Date().getUTCFullYear();
  const rawYear = Number(sp.year);
  const year = Number.isInteger(rawYear) && rawYear >= YEAR_MIN && rawYear <= YEAR_MAX ? rawYear : nowCe;
  const yearOptions = [year - 1, year, year + 1].filter((y) => y >= YEAR_MIN && y <= YEAR_MAX);

  // งวดเทียบงบ vs จริง — ค่าเริ่มต้น = ทั้งปีที่เลือก (ม.ค.-ธ.ค.) เลือกช่วงย่อยได้ (เดือนเดียว/ไตรมาส)
  const yStr = String(year).padStart(4, "0");
  const monthOptions = MONTH_OPTION_LABELS.map((label, idx) => ({
    value: `${yStr}-${String(idx + 1).padStart(2, "0")}`,
    label,
  }));
  const rawFrom = (sp.from ?? "").trim();
  const rawTo = (sp.to ?? "").trim();
  const from = monthOptions.some((m) => m.value === rawFrom) ? rawFrom : `${yStr}-01`;
  const to = monthOptions.some((m) => m.value === rawTo) ? rawTo : `${yStr}-12`;
  const includeDraft = sp.draft !== "0";

  let budgetRows: Awaited<ReturnType<typeof listBudgetYear>> = [];
  let comparisonRows: BudgetComparisonRow[] = [];
  let loadError = false;
  if (customerId) {
    try {
      budgetRows = await listBudgetYear(service, access.tenantId, customerId, year);

      const { entries } = await listEntries(service, access.tenantId, { customerId });
      const chartByCode = buildChartByCode(chart);
      const period = { from, to, includeDraft };
      const filteredEntries = filterEntriesForReport(entries, period);
      const opening = await listOpeningBalances(service, access.tenantId, customerId);
      const combined = await loadCombinedJournalLines(service, access.tenantId, entries, period, chartByCode);
      const statements = buildStatements(filteredEntries, opening, chartByCode, flattenCombinedJournalLines(combined));

      comparisonRows = buildBudgetComparison(budgetRows, statements.trialBalance.rows, chart, { from, to });
    } catch {
      loadError = true;
    }
  }

  const exportQuery = () => {
    const q = new URLSearchParams();
    q.set("customerId", customerId);
    q.set("year", String(year));
    q.set("from", from);
    q.set("to", to);
    if (!includeDraft) q.set("draft", "0");
    return `/chat-audit/accounting/budget/export?${q.toString()}`;
  };

  return (
    <ChatAuditFrame bare={embed}
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      title="งบประมาณ"
      subtitle="ตั้งงบต่อรหัสบัญชี/เดือน/ปี เทียบกับยอดเคลื่อนไหวจริงจากงบทดลอง"
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
              ปี:{" "}
              <select name="year" defaultValue={String(year)}>
                {yearOptions.map((y) => (
                  <option key={y} value={y}>{y + 543}</option>
                ))}
              </select>
            </label>
            <label>
              ตั้งแต่:{" "}
              <select name="from" defaultValue={from}>
                {monthOptions.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </label>
            <label>
              ถึง:{" "}
              <select name="to" defaultValue={to}>
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
          <div className="card"><p className="empty">เลือกลูกค้าด้านบนเพื่อตั้งงบประมาณ</p></div>
        ) : loadError ? (
          <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ apply migration ครบ</div>
        ) : (
          <>
            <div className="card acc-scopebar">
              <span className="acc-scope-label">{selectedLabel}</span>
              <span className="muted">ปีงบประมาณ {year + 543}</span>
            </div>

            <div className="card">
              <div className="strong" style={{ fontSize: 15, marginBottom: 8 }}>ตั้งงบประมาณ</div>
              <BudgetPanel customerId={customerId} year={year} chart={chart} budgetRows={budgetRows} />
            </div>

            <div className="card">
              <div className="acc-je-form-head" style={{ marginBottom: 10 }}>
                <span className="strong">ตารางเทียบงบ/จริง/ผลต่าง/%</span>
                <a href={exportQuery()} className="btn">⬇ Export Excel</a>
              </div>
              <ComparisonView rows={comparisonRows} />
            </div>
          </>
        )}
      </div>
    </ChatAuditFrame>
  );
}
