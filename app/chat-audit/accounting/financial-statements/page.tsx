import Link from "next/link";
import { listScopedCustomers } from "@/lib/accounting/customer-options";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope, type AccountingAccess } from "@/lib/accounting/access";
import { listEntries } from "@/lib/accounting/queries";
import { listOpeningBalances } from "@/lib/accounting/opening-balance";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { filterEntriesForReport, periodLabel, validMonth } from "@/lib/accounting/report-filter";
import { loadCombinedJournalLines } from "@/lib/accounting/statement-inputs";
import { buildFormalStatements, type FormalStatements } from "@/lib/accounting/formal-statements";
import {
  resolveComparePeriod,
  quarterRangeOf,
  type ComparePeriodMode,
  type PeriodRange,
} from "@/lib/accounting/comparative-period";
import { mergeCompareLines, sumCompareLines, type CompareLine } from "@/lib/accounting/statement-compare";
import type { IncomeStatement, BalanceSheet } from "@/lib/accounting/financial-statements";
import { aggregateCashFlowLines, type CashFlowStatement } from "@/lib/accounting/cash-flow";
import { formatMoney } from "@/lib/accounting/calc";
import { monthKeyOf, thaiMonthLabel } from "@/lib/accounting/monthly";
import { CLOSE_MARK, type EquityChangeStatement } from "@/lib/accounting/equity-change";
import { listManualEntries } from "@/lib/accounting/manual-journal";
import ClosePeriodCard from "./ClosePeriodCard";
import ChatAuditFrame from "../../_Frame";
import "../../chat-admin.css";
import "../../bills/bills.css";
import "../accounting.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TabKey = "income" | "balance" | "cashflow" | "equity";
const TABS: { key: TabKey; label: string }[] = [
  { key: "income", label: "งบกำไรขาดทุน" },
  { key: "balance", label: "งบแสดงฐานะการเงิน" },
  { key: "cashflow", label: "กระแสเงินสด" },
  { key: "equity", label: "เปลี่ยนแปลงส่วนผู้ถือหุ้น" },
];

const COMPARE_MODE_OPTIONS: { value: ComparePeriodMode; label: string }[] = [
  { value: "none", label: "ไม่เทียบ" },
  { value: "prev_period", label: "งวดก่อนหน้า" },
  { value: "prev_year", label: "ปีก่อน (งวดเดียวกัน)" },
  { value: "custom", label: "กำหนดเอง" },
];

/** ป้ายชื่อลูกค้า (มีรหัส → "N023 · ชื่อ") — mirror reports/page.tsx */
function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ลูกค้า";
}

/** รายชื่อลูกค้าในสโคป (สำหรับ dropdown) — mirror reports/page.tsx::fetchScopedCustomers */
async function fetchScopedCustomers(
  service: SupabaseClient,
  access: AccountingAccess
): Promise<{ id: string; label: string }[]> {
  const rows = await listScopedCustomers(service, access);
  return rows
    .filter((c) => c.customer_type === "company")
    .map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

/** แปลง ComparePeriodMode ดิบจาก query string → type ที่ถูกต้อง (fallback 'none') */
function asCompareMode(v: string | undefined): ComparePeriodMode {
  return v === "prev_period" || v === "prev_year" || v === "custom" ? v : "none";
}

/** ประกอบ query string (คงบริบทของหน้านี้ทั้งหมด) — ใช้กับลิงก์แท็บ/export/print */
function buildQuery(p: {
  customerId?: string;
  from?: string;
  to?: string;
  includeDraft?: boolean;
  compareMode?: ComparePeriodMode;
  compareFrom?: string;
  compareTo?: string;
  tab?: TabKey;
}): string {
  const sp = new URLSearchParams();
  if (p.customerId) sp.set("customerId", p.customerId);
  if (p.from) sp.set("from", p.from);
  if (p.to) sp.set("to", p.to);
  if (p.includeDraft) sp.set("draft", "1");
  if (p.compareMode && p.compareMode !== "none") sp.set("compareMode", p.compareMode);
  if (p.compareMode === "custom" && p.compareFrom) sp.set("compareFrom", p.compareFrom);
  if (p.compareMode === "custom" && p.compareTo) sp.set("compareTo", p.compareTo);
  if (p.tab) sp.set("tab", p.tab);
  const str = sp.toString();
  return str ? `?${str}` : "";
}

/** แถวเทียบงวด (ทั่วไป) — ใช้ทั้งงบกำไรขาดทุน/งบแสดงฐานะการเงิน */
function CompareRows({ rows, showCompare }: { rows: CompareLine[]; showCompare: boolean }) {
  return (
    <>
      {rows.map((r) => (
        <tr key={r.code}>
          <td className="mono">{r.code} · {r.name}</td>
          <td className="num">{formatMoney(r.current)}</td>
          {showCompare ? <td className="num muted">{formatMoney(r.compare ?? 0)}</td> : null}
        </tr>
      ))}
    </>
  );
}

/** งบกำไรขาดทุน (มี/ไม่มีคอลัมน์เทียบงวด) */
function IncomeCompareView({
  current,
  compare,
  currentLabel,
  compareLabel,
}: {
  current: IncomeStatement;
  compare: IncomeStatement | null;
  currentLabel: string;
  compareLabel: string | null;
}) {
  const showCompare = compare !== null;
  const revenueRows = mergeCompareLines(current.revenues, compare?.revenues ?? null);
  const expenseRows = mergeCompareLines(current.expenses, compare?.expenses ?? null);
  const revenueTotal = sumCompareLines(revenueRows);
  const expenseTotal = sumCompareLines(expenseRows);
  const netCompare = showCompare ? (revenueTotal.compare ?? 0) - (expenseTotal.compare ?? 0) : null;

  return (
    <div className="table-wrap">
      <table className="dlv-table acc-table">
        <thead>
          <tr>
            <th>รายการ</th>
            <th className="num">{currentLabel}</th>
            {showCompare ? <th className="num muted">{compareLabel}</th> : null}
          </tr>
        </thead>
        <tbody>
          <tr className="acc-jrow-sep"><td className="strong" colSpan={showCompare ? 3 : 2}>รายได้</td></tr>
          <CompareRows rows={revenueRows} showCompare={showCompare} />
          <tr className="acc-total">
            <td className="strong">รวมรายได้</td>
            <td className="num strong">{formatMoney(revenueTotal.current)}</td>
            {showCompare ? <td className="num strong muted">{formatMoney(revenueTotal.compare ?? 0)}</td> : null}
          </tr>

          <tr className="acc-jrow-sep"><td className="strong" colSpan={showCompare ? 3 : 2}>ค่าใช้จ่าย</td></tr>
          <CompareRows rows={expenseRows} showCompare={showCompare} />
          <tr className="acc-total">
            <td className="strong">รวมค่าใช้จ่าย</td>
            <td className="num strong">{formatMoney(expenseTotal.current)}</td>
            {showCompare ? <td className="num strong muted">{formatMoney(expenseTotal.compare ?? 0)}</td> : null}
          </tr>

          <tr className="acc-total">
            <td className="strong">กำไร(ขาดทุน)สุทธิ</td>
            <td className={`num strong ${current.netProfit < 0 ? "v-red" : "v-green"}`}>{formatMoney(current.netProfit)}</td>
            {showCompare ? (
              <td className={`num strong muted ${(netCompare ?? 0) < 0 ? "v-red" : "v-green"}`}>{formatMoney(netCompare ?? 0)}</td>
            ) : null}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** งบแสดงฐานะการเงิน (มี/ไม่มีคอลัมน์เทียบ ณ อีกจุดเวลาหนึ่ง) */
function BalanceCompareView({
  current,
  compare,
  currentLabel,
  compareLabel,
}: {
  current: BalanceSheet;
  compare: BalanceSheet | null;
  currentLabel: string;
  compareLabel: string | null;
}) {
  const showCompare = compare !== null;
  const assetRows = mergeCompareLines(current.assets, compare?.assets ?? null);
  const liabilityRows = mergeCompareLines(current.liabilities, compare?.liabilities ?? null);
  const equityRows = mergeCompareLines(current.equity, compare?.equity ?? null);
  const assetTotal = sumCompareLines(assetRows);
  const liabilityTotal = sumCompareLines(liabilityRows);
  const equityTotal = sumCompareLines(equityRows);
  const equityWithProfitCompare = showCompare ? (equityTotal.compare ?? 0) + (compare?.netProfit ?? 0) : null;
  const liabEquityCompare = showCompare ? (liabilityTotal.compare ?? 0) + (equityWithProfitCompare ?? 0) : null;

  return (
    <>
      <div className="table-wrap">
        <table className="dlv-table acc-table">
          <thead>
            <tr>
              <th>รายการ</th>
              <th className="num">{currentLabel}</th>
              {showCompare ? <th className="num muted">{compareLabel}</th> : null}
            </tr>
          </thead>
          <tbody>
            <tr className="acc-jrow-sep"><td className="strong" colSpan={showCompare ? 3 : 2}>สินทรัพย์</td></tr>
            <CompareRows rows={assetRows} showCompare={showCompare} />
            <tr className="acc-total">
              <td className="strong">รวมสินทรัพย์</td>
              <td className="num strong">{formatMoney(assetTotal.current)}</td>
              {showCompare ? <td className="num strong muted">{formatMoney(assetTotal.compare ?? 0)}</td> : null}
            </tr>

            <tr className="acc-jrow-sep"><td className="strong" colSpan={showCompare ? 3 : 2}>หนี้สิน</td></tr>
            <CompareRows rows={liabilityRows} showCompare={showCompare} />
            <tr className="acc-total">
              <td className="strong">รวมหนี้สิน</td>
              <td className="num strong">{formatMoney(liabilityTotal.current)}</td>
              {showCompare ? <td className="num strong muted">{formatMoney(liabilityTotal.compare ?? 0)}</td> : null}
            </tr>

            <tr className="acc-jrow-sep"><td className="strong" colSpan={showCompare ? 3 : 2}>ส่วนของผู้ถือหุ้น</td></tr>
            <CompareRows rows={equityRows} showCompare={showCompare} />
            <tr>
              <td>กำไร(ขาดทุน)สุทธิของงวด</td>
              <td className="num">{formatMoney(current.netProfit)}</td>
              {showCompare ? <td className="num muted">{formatMoney(compare?.netProfit ?? 0)}</td> : null}
            </tr>
            <tr className="acc-total">
              <td className="strong">รวมส่วนของผู้ถือหุ้น</td>
              <td className="num strong">{formatMoney(current.totalEquityWithProfit)}</td>
              {showCompare ? <td className="num strong muted">{formatMoney(equityWithProfitCompare ?? 0)}</td> : null}
            </tr>

            <tr className="acc-total">
              <td className="strong">รวมหนี้สินและส่วนของผู้ถือหุ้น</td>
              <td className="num strong">{formatMoney(current.totalLiabilities + current.totalEquityWithProfit)}</td>
              {showCompare ? <td className="num strong muted">{formatMoney(liabEquityCompare ?? 0)}</td> : null}
            </tr>
          </tbody>
        </table>
      </div>
      {current.balanced ? (
        <div className="card" style={{ marginTop: 12, color: "#16794c" }}>
          ✓ งบสมดุล — สินทรัพย์ = หนี้สิน + ส่วนของผู้ถือหุ้น
        </div>
      ) : (
        <div className="card acc-review-warn" style={{ marginTop: 12 }}>
          <span className="acc-review-warn-icon" aria-hidden="true">⚠️</span>
          <div className="acc-review-warn-body">
            งบยังไม่สมดุล — ผลต่าง {formatMoney(current.difference)} บาท. ตรวจ “ยอดยกมา” และ “รายการตกหล่น” ให้ครบก่อน
          </div>
        </div>
      )}
    </>
  );
}

/** งบกระแสเงินสด (มี/ไม่มีคอลัมน์เทียบงวด) — เฟส 4 ส่วน O4 */
function CashFlowCompareView({
  current,
  compare,
  currentLabel,
  compareLabel,
}: {
  current: CashFlowStatement;
  compare: CashFlowStatement | null;
  currentLabel: string;
  compareLabel: string | null;
}) {
  const showCompare = compare !== null;
  const operatingRows = mergeCompareLines(
    aggregateCashFlowLines(current.operating),
    compare ? aggregateCashFlowLines(compare.operating) : null
  );
  const investingRows = mergeCompareLines(
    aggregateCashFlowLines(current.investing),
    compare ? aggregateCashFlowLines(compare.investing) : null
  );
  const financingRows = mergeCompareLines(
    aggregateCashFlowLines(current.financing),
    compare ? aggregateCashFlowLines(compare.financing) : null
  );
  const operatingTotal = sumCompareLines(operatingRows);
  const investingTotal = sumCompareLines(investingRows);
  const financingTotal = sumCompareLines(financingRows);

  return (
    <>
      <div className="table-wrap">
        <table className="dlv-table acc-table">
          <thead>
            <tr>
              <th>รายการ</th>
              <th className="num">{currentLabel}</th>
              {showCompare ? <th className="num muted">{compareLabel}</th> : null}
            </tr>
          </thead>
          <tbody>
            <tr className="acc-jrow-sep"><td className="strong" colSpan={showCompare ? 3 : 2}>กิจกรรมดำเนินงาน</td></tr>
            <CompareRows rows={operatingRows} showCompare={showCompare} />
            <tr className="acc-total">
              <td className="strong">รวมกิจกรรมดำเนินงาน</td>
              <td className="num strong">{formatMoney(operatingTotal.current)}</td>
              {showCompare ? <td className="num strong muted">{formatMoney(operatingTotal.compare ?? 0)}</td> : null}
            </tr>

            <tr className="acc-jrow-sep"><td className="strong" colSpan={showCompare ? 3 : 2}>กิจกรรมลงทุน</td></tr>
            <CompareRows rows={investingRows} showCompare={showCompare} />
            <tr className="acc-total">
              <td className="strong">รวมกิจกรรมลงทุน</td>
              <td className="num strong">{formatMoney(investingTotal.current)}</td>
              {showCompare ? <td className="num strong muted">{formatMoney(investingTotal.compare ?? 0)}</td> : null}
            </tr>

            <tr className="acc-jrow-sep"><td className="strong" colSpan={showCompare ? 3 : 2}>กิจกรรมจัดหาเงิน</td></tr>
            <CompareRows rows={financingRows} showCompare={showCompare} />
            <tr className="acc-total">
              <td className="strong">รวมกิจกรรมจัดหาเงิน</td>
              <td className="num strong">{formatMoney(financingTotal.current)}</td>
              {showCompare ? <td className="num strong muted">{formatMoney(financingTotal.compare ?? 0)}</td> : null}
            </tr>

            <tr className="acc-total">
              <td className="strong">เงินสดเพิ่มขึ้น(ลดลง)สุทธิ</td>
              <td className="num strong">{formatMoney(current.netChange)}</td>
              {showCompare ? <td className="num strong muted">{formatMoney(compare?.netChange ?? 0)}</td> : null}
            </tr>
            <tr>
              <td>เงินสดต้นงวด</td>
              <td className="num">{formatMoney(current.openingCash)}</td>
              {showCompare ? <td className="num muted">{formatMoney(compare?.openingCash ?? 0)}</td> : null}
            </tr>
            <tr className="acc-total">
              <td className="strong">เงินสดปลายงวด</td>
              <td className="num strong">{formatMoney(current.closingCash)}</td>
              {showCompare ? <td className="num strong muted">{formatMoney(compare?.closingCash ?? 0)}</td> : null}
            </tr>
          </tbody>
        </table>
      </div>
      {current.reconciled ? (
        <div className="card" style={{ marginTop: 12, color: "#16794c" }}>
          ✓ งบกระแสเงินสดสมดุล — เงินสดปลายงวดตรงกับผลรวมเงินสด+เทียบเท่าจริง
        </div>
      ) : (
        <div className="card acc-review-warn" style={{ marginTop: 12 }}>
          <span className="acc-review-warn-icon" aria-hidden="true">⚠️</span>
          <div className="acc-review-warn-body">
            งบกระแสเงินสดยังไม่สมดุล (reconciled=false) — ตรวจการจัดหมวดรายการเงินสด
          </div>
        </div>
      )}
    </>
  );
}

/**
 * /chat-audit/accounting/financial-statements — "งบการเงินฉบับทางการ" (เฟส 4 ส่วน N)
 *   งบกำไรขาดทุน + งบแสดงฐานะการเงิน แบบเทียบงวด/ไตรมาส/ปีก่อนได้ — ต่างจาก `/reports` เดิม (0.1):
 *     - default "เฉพาะที่ยืนยันแล้ว" (0.10 — ต่างจาก /reports ที่ default รวม draft)
 *     - งบแสดงฐานะการเงินถูกต้องเสมอแม้ตั้ง `from` (0.3 — ผ่าน buildFormalStatements)
 *     - เทียบงวดได้ (0.4) ผ่าน resolveComparePeriod/quarterRangeOf
 *
 * ★ guard + scope เดียวกับหน้า `/reports` เดิมทุกประการ (0.11) — ไม่มี write path ใหม่เลย (อ่าน+คำนวณ+แสดงผล)
 */
export default async function FinancialStatementsPage({
  searchParams,
}: {
  searchParams: Promise<{
    customerId?: string;
    from?: string;
    to?: string;
    draft?: string;
    compareMode?: string;
    compareFrom?: string;
    compareTo?: string;
    qyear?: string;
    quarter?: string;
    tab?: string;
    embed?: string;
  }>;
}) {
  const sp = await searchParams;
  const embed = sp.embed === "1"; // ฝังในโต๊ะทำงาน (แท็บปิดเดือน) → ซ่อนเมนู

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-accounting" role={null} authed={false} title="งบการเงินฉบับทางการ" subtitle="งบกำไรขาดทุน/ฐานะการเงิน">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting/financial-statements");

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

  // ปุ่มลัดไตรมาส (0.4 — quarterRangeOf ตั้งงวดปัจจุบันเป็นไตรมาสปฏิทิน ไม่ใช่โหมดเทียบ) — override from/to
  const qYearRaw = Number(sp.qyear);
  const nowCe = new Date().getUTCFullYear();
  const qYear = Number.isFinite(qYearRaw) && qYearRaw > 1900 && qYearRaw < 3000 ? qYearRaw : nowCe;
  const quarterParam = sp.quarter;
  const quarterShortcut =
    quarterParam === "1" || quarterParam === "2" || quarterParam === "3" || quarterParam === "4"
      ? quarterRangeOf(qYear, Number(quarterParam) as 1 | 2 | 3 | 4)
      : null;

  const from = quarterShortcut ? quarterShortcut.from : validMonth(sp.from);
  const to = quarterShortcut ? quarterShortcut.to : validMonth(sp.to);
  const includeDraft = sp.draft === "1"; // default (0.10): เฉพาะที่ยืนยันแล้ว
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key ?? "income") as TabKey;
  const selectedLabel = customers.find((c) => c.id === customerId)?.label ?? "";

  // ---- โหมดเทียบงวด (0.4) ----
  const compareMode = asCompareMode(sp.compareMode);
  const currentRange: PeriodRange = { from, to };
  const comparePeriod =
    compareMode === "none"
      ? null
      : resolveComparePeriod(currentRange, compareMode, { from: sp.compareFrom, to: sp.compareTo });

  // ---- โหลด + คำนวณงบ (เมื่อเลือกลูกค้าแล้ว) ----
  let formal: FormalStatements | null = null;
  let compareFormal: FormalStatements | null = null;
  let monthOptions: string[] = [];
  let draftCount = 0;
  let loadError = false;
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

      const period = { from, to, includeDraft };
      // ★ 0.3 (แก้บั๊กรอบตรวจโค้ด) — โหลด combinedLines 2 ชุด: flow (period จริง) + cumulative (ตัด from
      //   ทิ้ง {from:"", to}) ให้ buildFormalStatements ใช้ balanceSheet/openingCash แบบสะสมจริงตั้งแต่ต้น
      const cumulativePeriod = { ...period, from: "" };
      const [combined, cumulativeCombined] = await Promise.all([
        loadCombinedJournalLines(service, access.tenantId, entries, period, chartByCode),
        loadCombinedJournalLines(service, access.tenantId, entries, cumulativePeriod, chartByCode),
      ]);
      formal = buildFormalStatements(entries, combined, cumulativeCombined, opening, chartByCode, period, chart);

      if (comparePeriod) {
        const comparePeriodFull = { from: comparePeriod.from, to: comparePeriod.to, includeDraft };
        const compareCumulativePeriod = { ...comparePeriodFull, from: "" };
        const [compareCombined, compareCumulativeCombined] = await Promise.all([
          loadCombinedJournalLines(service, access.tenantId, entries, comparePeriodFull, chartByCode),
          loadCombinedJournalLines(service, access.tenantId, entries, compareCumulativePeriod, chartByCode),
        ]);
        compareFormal = buildFormalStatements(
          entries,
          compareCombined,
          compareCumulativeCombined,
          opening,
          chartByCode,
          comparePeriodFull,
          chart
        );
      }
    } catch {
      loadError = true;
    }
  }

  // ★ 2026-09-02 (ขั้น 8) — งวดที่ปิดบัญชีแล้ว (จาก JE ปิดที่ยังอยู่) สำหรับการ์ดปิดงวด
  let closedMonths: string[] = [];
  if (customerId) {
    try {
      const manual = await listManualEntries(service, access.tenantId, customerId);
      closedMonths = manual
        .map((e) => {
          const m = (e.memo ?? "").match(/⚙close\|(\d{4}-\d{2})/);
          return m ? m[1] : null;
        })
        .filter((m): m is string => !!m);
      void CLOSE_MARK; // คีย์เดียวกับ close-actions (อ้างอิงให้ import ไม่หลุด)
    } catch {
      // best-effort — การ์ดยังใช้งานปิดงวดได้
    }
  }

  const currentPeriodLabel = periodLabel(from, to);
  const comparePeriodLabel = comparePeriod ? periodLabel(comparePeriod.from, comparePeriod.to) : null;

  const exportHref = customerId
    ? `/chat-audit/accounting/financial-statements/export${buildQuery({
        customerId,
        from,
        to,
        includeDraft,
        compareMode,
        compareFrom: sp.compareFrom,
        compareTo: sp.compareTo,
      })}`
    : "";
  const printHref = customerId
    ? `/chat-audit/accounting/financial-statements/print${buildQuery({
        customerId,
        from,
        to,
        includeDraft,
        compareMode,
        compareFrom: sp.compareFrom,
        compareTo: sp.compareTo,
      })}`
    : "";

  return (
    <ChatAuditFrame
      active="chat-accounting"
      role={navRole}
      authed
      staffOnly={staffOnly}
      bare={embed}
      title="งบการเงินฉบับทางการ"
      subtitle="งบกำไรขาดทุน · งบแสดงฐานะการเงิน — เทียบงวด/ไตรมาส/ปีก่อนได้ พิมพ์/export เป็นทางการ"
    >
      <div className="dash-views">
        {/* ---- toolbar: เลือกลูกค้า + งวด + ปุ่มลัดไตรมาส + โหมดเทียบ + เฉพาะยืนยันแล้ว ---- */}
        <div className="card acc-review-head" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
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

            {/* ปุ่มลัดไตรมาส (0.4) — เลือกปี ค.ศ. แล้วกด Q1-Q4 เพื่อตั้ง from/to เป็นไตรมาสนั้นทันที */}
            <label>
              ปุ่มลัดไตรมาส — ปี (ค.ศ.):{" "}
              <input
                type="number"
                name="qyear"
                defaultValue={qYear}
                style={{ width: 80 }}
                aria-label="ปี ค.ศ. สำหรับปุ่มลัดไตรมาส"
              />
            </label>
            <button type="submit" name="quarter" value="1" className="btn btn-ghost btn-sm">Q1</button>
            <button type="submit" name="quarter" value="2" className="btn btn-ghost btn-sm">Q2</button>
            <button type="submit" name="quarter" value="3" className="btn btn-ghost btn-sm">Q3</button>
            <button type="submit" name="quarter" value="4" className="btn btn-ghost btn-sm">Q4</button>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" name="draft" value="1" defaultChecked={includeDraft} />
              รวมรายการร่างด้วย
            </label>
            {tab !== "income" ? <input type="hidden" name="tab" value={tab} /> : null}
            <button type="submit" className="btn">แสดงงบ</button>
          </form>

          {/* ---- โหมดเทียบงวด (0.4) — ฟอร์มแยก คงค่างวดปัจจุบันไว้ผ่าน hidden field ---- */}
          <form method="get" className="acc-opening-cust" style={{ gap: 10, flexWrap: "wrap" }}>
            <input type="hidden" name="customerId" value={customerId} />
            <input type="hidden" name="from" value={from} />
            <input type="hidden" name="to" value={to} />
            {includeDraft ? <input type="hidden" name="draft" value="1" /> : null}
            {tab !== "income" ? <input type="hidden" name="tab" value={tab} /> : null}
            <label>
              เทียบงวด:{" "}
              <select name="compareMode" defaultValue={compareMode}>
                {COMPARE_MODE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label>
              จากงวด (กำหนดเอง):{" "}
              <select name="compareFrom" defaultValue={sp.compareFrom ?? ""}>
                <option value="">—</option>
                {monthOptions.map((m) => (
                  <option key={m} value={m}>{thaiMonthLabel(m)}</option>
                ))}
              </select>
            </label>
            <label>
              ถึงงวด (กำหนดเอง):{" "}
              <select name="compareTo" defaultValue={sp.compareTo ?? ""}>
                <option value="">—</option>
                {monthOptions.map((m) => (
                  <option key={m} value={m}>{thaiMonthLabel(m)}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn btn-ghost">ตั้งค่าเทียบงวด</button>
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
        ) : formal ? (
          <>
            {/* ---- แถบกิจการ + งวด ---- */}
            <div className="card acc-scopebar">
              <span className="acc-scope-label">{selectedLabel}</span>
              <span className="muted">
                งวด: {currentPeriodLabel} · {includeDraft ? "รวมร่าง+ยืนยันแล้ว" : "เฉพาะยืนยันแล้ว"}
                {comparePeriodLabel ? ` · เทียบกับ: ${comparePeriodLabel}` : ""}
              </span>
            </div>

            {compareMode !== "none" && !comparePeriod ? (
              <div className="card acc-review-warn">
                <span className="acc-review-warn-icon" aria-hidden="true">⚠️</span>
                <div className="acc-review-warn-body">
                  ไม่สามารถคำนวณงวดเทียบได้ — ต้องเลือกงวด “ตั้งแต่” และ “ถึง” ของงวดปัจจุบันให้ชัดเจนก่อน
                  (หรือกรอกงวดกำหนดเองให้ครบทั้งสองช่อง)
                </div>
              </div>
            ) : null}

            {/* ---- เตือน: รายการตกหล่น + ร่าง ---- */}
            {formal.flow.journal.skipped.length > 0 || (includeDraft && draftCount > 0) ? (
              <div className="card acc-review-warn">
                <span className="acc-review-warn-icon" aria-hidden="true">⚠️</span>
                <div className="acc-review-warn-body">
                  <div className="acc-review-warn-title">ตรวจก่อนใช้งบ</div>
                  <ul className="acc-review-warn-list">
                    {formal.flow.journal.skipped.length > 0 ? (
                      <li>
                        มี <strong>{formal.flow.journal.skipped.length.toLocaleString("th-TH")}</strong> บิลที่
                        <strong>ยังไม่เข้างบ</strong> (ตกหล่น) — ดูรายละเอียดที่หน้า “งบการเงิน” เดิม
                      </li>
                    ) : null}
                    {includeDraft && draftCount > 0 ? (
                      <li>
                        รวมบิล <strong>ร่าง {draftCount.toLocaleString("th-TH")}</strong> ใบในงบนี้ (เลิกติ๊ก “รวมรายการร่างด้วย” เพื่อตัดออก)
                      </li>
                    ) : null}
                  </ul>
                </div>
              </div>
            ) : null}

            {/* ---- แท็บรายงาน + ปุ่ม Export/พิมพ์ ---- */}
            <div className="card">
              <div className="acc-subtabs" style={{ marginBottom: 14 }}>
                {TABS.map((t) => (
                  <Link
                    key={t.key}
                    href={`/chat-audit/accounting/financial-statements${buildQuery({
                      customerId,
                      from,
                      to,
                      includeDraft,
                      compareMode,
                      compareFrom: sp.compareFrom,
                      compareTo: sp.compareTo,
                      tab: t.key,
                    })}`}
                    scroll={false}
                    className={`acc-subtab${tab === t.key ? " active" : ""}`}
                    aria-current={tab === t.key ? "page" : undefined}
                  >
                    {t.label}
                  </Link>
                ))}
                <span className="acc-toolbar-spacer" />
                <a href={printHref} className="btn btn-ghost" target="_blank" rel="noopener">🖨 พิมพ์</a>
                <a href={exportHref} className="btn">⬇ Export (Excel)</a>
              </div>

              {tab === "income" ? (
                <IncomeCompareView
                  current={formal.flow.incomeStatement}
                  compare={compareFormal?.flow.incomeStatement ?? null}
                  currentLabel={currentPeriodLabel}
                  compareLabel={comparePeriodLabel}
                />
              ) : null}
              {tab === "balance" ? (
                <BalanceCompareView
                  current={formal.balanceSheet}
                  compare={compareFormal?.balanceSheet ?? null}
                  currentLabel={currentPeriodLabel}
                  compareLabel={comparePeriodLabel}
                />
              ) : null}
              {tab === "cashflow" ? (
                <CashFlowCompareView
                  current={formal.cashFlow}
                  compare={compareFormal?.cashFlow ?? null}
                  currentLabel={currentPeriodLabel}
                  compareLabel={comparePeriodLabel}
                />
              ) : null}
              {tab === "equity" ? <EquityChangeView eq={formal.equityChange} /> : null}
            </div>

            {/* ---- ปิดบัญชีสิ้นงวด (★ 2026-09-02 ขั้น 8 ครบ) ---- */}
            <ClosePeriodCard
              customerId={customerId}
              defaultMonth={to || monthOptions[0] || ""}
              closedMonths={closedMonths}
            />
          </>
        ) : null}
      </div>
    </ChatAuditFrame>
  );
}


/** งบการเปลี่ยนแปลงส่วนของผู้ถือหุ้น (บนจอ) — ★ 2026-09-02 (ขั้น 8 ครบ) */
function EquityChangeView({ eq }: { eq: EquityChangeStatement }) {
  return (
    <div className="table-wrap">
      <table className="dlv-table acc-table">
        <thead>
          <tr>
            <th>รายการ</th>
            <th className="num">ยอดต้นงวด</th>
            <th className="num">เปลี่ยนแปลงระหว่างงวด</th>
            <th className="num">ยอดปลายงวด</th>
          </tr>
        </thead>
        <tbody>
          {eq.rows.map((r) => (
            <tr key={r.code}>
              <td>{r.code} · {r.name}</td>
              <td className="num">{formatMoney(r.opening)}</td>
              <td className="num">{formatMoney(r.change)}</td>
              <td className="num">{formatMoney(r.closing)}</td>
            </tr>
          ))}
          <tr>
            <td>{eq.unclosedProfit.name}</td>
            <td className="num">{formatMoney(eq.unclosedProfit.opening)}</td>
            <td className="num">{formatMoney(eq.unclosedProfit.change)}</td>
            <td className="num">{formatMoney(eq.unclosedProfit.closing)}</td>
          </tr>
          <tr className="acc-total">
            <td className="strong">รวมส่วนของผู้ถือหุ้น</td>
            <td className="num strong">{formatMoney(eq.openingTotal)}</td>
            <td className="num strong">{formatMoney(eq.changeTotal)}</td>
            <td className="num strong">{formatMoney(eq.closingTotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
