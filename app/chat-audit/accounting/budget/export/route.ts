import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries } from "@/lib/accounting/queries";
import { listOpeningBalances } from "@/lib/accounting/opening-balance";
import { buildStatements } from "@/lib/accounting/statements";
import { filterEntriesForReport, periodLabel, validMonth } from "@/lib/accounting/report-filter";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { loadCombinedJournalLines, flattenCombinedJournalLines } from "@/lib/accounting/statement-inputs";
import { listBudgetYear, buildBudgetComparison, YEAR_MIN, YEAR_MAX, type BudgetComparisonRow } from "@/lib/accounting/budget";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_FMT = "#,##0.00";

function diffPercentText(v: number | null): string {
  return v === null ? "N/A" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** สร้าง workbook เดียว: ตารางเทียบงบ/จริง/ผลต่าง/% ของงวดที่เลือก (mirror statements-excel.ts pattern) */
function buildBudgetWorkbook(
  rows: BudgetComparisonRow[],
  header: { entityLabel: string; periodLabel: string; yearLabel: string }
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("เทียบงบประมาณ");
  ws.addRow(["ตารางเทียบงบประมาณ (Budget vs Actual)"]).font = { bold: true, size: 14 };
  ws.addRow([header.entityLabel]);
  ws.addRow([`ปีงบประมาณ ${header.yearLabel} · งวด: ${header.periodLabel}`]);
  ws.addRow([]);
  const headRow = ws.addRow(["รหัสบัญชี", "ชื่อบัญชี", "หมวด", "งบประมาณ", "จริง", "ผลต่าง (จริง−งบ)", "% ผลต่าง"]);
  headRow.font = { bold: true };
  headRow.alignment = { vertical: "middle", horizontal: "center" };

  let totalBudget = 0;
  let totalActual = 0;
  for (const r of rows) {
    ws.addRow([r.accountCode, r.accountName, r.category, r.budget, r.actual, r.diff, diffPercentText(r.diffPercent)]);
    totalBudget += r.budget;
    totalActual += r.actual;
  }
  const total = ws.addRow(["", "", "รวมทั้งสิ้น", totalBudget, totalActual, totalActual - totalBudget, ""]);
  total.font = { bold: true };

  ws.columns.forEach((c, i) => (c.width = [14, 28, 16, 16, 16, 18, 12][i] ?? 14));
  [4, 5, 6].forEach((col) => (ws.getColumn(col).numFmt = NUMBER_FMT));

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/**
 * GET /chat-audit/accounting/budget/export?customerId=<uuid>&year=<int>&from=YYYY-MM&to=YYYY-MM&draft=1
 *   Export ตารางเทียบงบ/จริง/ผลต่าง/% ของลูกค้า 1 ราย เป็นไฟล์ .xlsx (T47)
 *
 * สิทธิ์ (default deny): resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 * ★ tenantId จาก session (ไม่เชื่อ client) · ไม่ log เนื้อบิล/ชื่อลูกค้า
 * ★ ใช้ pipeline เดิมทั้งชุด (listEntries + filterEntriesForReport + loadCombinedJournalLines +
 *   buildStatements=buildLedger+buildTrialBalance) เหมือนหน้าจอเป๊ะ — ไม่มีสูตรคำนวณคู่ขนาน (0.10)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId") ?? "";
  const from = validMonth(url.searchParams.get("from"));
  const to = validMonth(url.searchParams.get("to"));
  const includeDraft = url.searchParams.get("draft") !== "0";
  const rawYear = Number(url.searchParams.get("year"));

  if (!getSupabaseEnv()) {
    return NextResponse.json({ error: "db_unavailable", message: "ยังไม่ได้ตั้งค่าฐานข้อมูล" }, { status: 503 });
  }
  if (!UUID_RE.test(customerId)) {
    return NextResponse.json({ error: "invalid_params", message: "ต้องระบุลูกค้า" }, { status: 400 });
  }
  if (!Number.isInteger(rawYear) || rawYear < YEAR_MIN || rawYear > YEAR_MAX) {
    return NextResponse.json({ error: "invalid_params", message: "ปีไม่ถูกต้อง" }, { status: 400 });
  }

  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const access = await resolveAccountingAccess(authed, service);
    if (!access) {
      return NextResponse.json({ error: "forbidden", message: "ไม่มีสิทธิ์ออกรายงาน" }, { status: 403 });
    }
    if (!customerInScope(access, customerId)) {
      return NextResponse.json(
        { error: "forbidden", message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" },
        { status: 403 }
      );
    }

    const { entries } = await listEntries(service, access.tenantId, { customerId });
    const period = { from, to, includeDraft };
    const filtered = filterEntriesForReport(entries, period);
    const opening = await listOpeningBalances(service, access.tenantId, customerId);
    const chart = await listChartOfAccounts(service, access.tenantId);
    const chartByCode = buildChartByCode(chart);

    const combined = await loadCombinedJournalLines(service, access.tenantId, entries, period, chartByCode);
    const statements = buildStatements(filtered, opening, chartByCode, flattenCombinedJournalLines(combined));

    const budgetRows = await listBudgetYear(service, access.tenantId, customerId, rawYear);
    const comparisonRows = buildBudgetComparison(budgetRows, statements.trialBalance.rows, chart, { from, to });

    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name")
      .eq("id", customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    const c = (cust as { customer_code: string | null; name: string | null } | null) ?? null;
    const entityLabel = [c?.customer_code, c?.name].filter(Boolean).join(" · ") || "กิจการ";
    const pLabel = periodLabel(from, to);

    const xlsx = await buildBudgetWorkbook(comparisonRows, {
      entityLabel,
      periodLabel: pLabel,
      yearLabel: String(rawYear + 543),
    });

    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const filename = `งบประมาณ${codePart}-${rawYear + 543}.xlsx`;
    const asciiFallback = `budget${codePart}.xlsx`;

    return new NextResponse(xlsx as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": XLSX_CONTENT_TYPE,
        "content-disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "server_error", message: "ออกรายงานไม่สำเร็จ" }, { status: 500 });
  }
}
