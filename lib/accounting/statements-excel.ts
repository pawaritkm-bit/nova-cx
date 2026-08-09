/**
 * Excel export งบการเงิน (exceljs) — สร้างไฟล์ .xlsx จริง
 *   1 ไฟล์ = หลายชีท: สมุดรายวัน · บัญชีแยกประเภท · งบทดลอง · งบกำไรขาดทุน · งบแสดงฐานะการเงิน
 *   (+ ชีท "รายการตกหล่น" ถ้ามี) · เลือก export เฉพาะรายงานเดียวได้ผ่าน `report`
 *
 * ★ pure: รับ Statements + header → คืน Buffer (ไม่แตะ DB/network)
 * ★ หน้าตาแนวงบบัญชีไทย: หัวบริษัท/งวด, คอลัมน์เดบิต/เครดิต, format ตัวเลขทศนิยม 2
 * ★ PDPA: ผู้เรียก (route) เป็นคน gate สิทธิ์ + สั่งดาวน์โหลด — ที่นี่ไม่ log
 */
import ExcelJS from "exceljs";
import type { Statements, ReportKey } from "@/lib/accounting/statements";
import { buildLedgerStatements } from "@/lib/accounting/ledger-statement";
import type { FormalStatements } from "@/lib/accounting/formal-statements";
import type { IncomeStatement, BalanceSheet } from "@/lib/accounting/financial-statements";
import type { SkippedEntry } from "@/lib/accounting/journal";
import { mergeCompareLines, sumCompareLines } from "@/lib/accounting/statement-compare";
import { aggregateCashFlowLines, type CashFlowStatement } from "@/lib/accounting/cash-flow";

/** วันที่แบบ พ.ศ. dd/mm/yyyy สำหรับชีทบัญชีแยกประเภท (parse ตรง TZ ไม่เพี้ยน) */
function dateBE(iso: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) return `${m[3]}/${m[2]}/${Number(m[1]) + 543}`;
  return iso;
}

const NUMBER_FMT = "#,##0.00";

export type StatementsHeader = {
  /** ป้ายกิจการ/ลูกค้า (เช่น "N023 · บริษัท ...") */
  entityLabel: string;
  /** ป้ายงวด (เช่น "ก.ค. 2569" หรือ "ทุกงวด") */
  periodLabel: string;
};

/** ใส่แถวหัวเรื่อง (ชื่อรายงาน + กิจการ + งวด) ที่ด้านบนชีท — คืน index แถวถัดไปที่ว่าง */
function writeTitle(ws: ExcelJS.Worksheet, title: string, h: StatementsHeader): number {
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([h.entityLabel]);
  ws.addRow([`งวด: ${h.periodLabel}`]);
  ws.addRow([]);
  return ws.rowCount + 1;
}

/** จัด format ตัวเลข + สไตล์หัวตารางในช่วง column ที่กำหนด */
function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.alignment = { vertical: "middle", horizontal: "center" };
}

/** ทำคอลัมน์เงิน (ตาม index 1-based) ให้ format ทศนิยม 2 */
function moneyCols(ws: ExcelJS.Worksheet, cols: number[]): void {
  for (const c of cols) ws.getColumn(c).numFmt = NUMBER_FMT;
}

function sheetJournal(wb: ExcelJS.Workbook, s: Statements, h: StatementsHeader): void {
  const ws = wb.addWorksheet("สมุดรายวัน");
  writeTitle(ws, "สมุดรายวันทั่วไป (Journal)", h);
  const header = ws.addRow(["วันที่", "เลขที่", "รหัสบัญชี", "ชื่อบัญชี", "เดบิต", "เครดิต"]);
  styleHeaderRow(header);
  for (const l of s.journal.lines) {
    ws.addRow([l.date ?? "", l.docNo ?? "", l.accountCode, l.accountName, l.debit || null, l.credit || null]);
  }
  const total = ws.addRow(["", "", "", "รวมทั้งสิ้น", s.journal.totalDebit, s.journal.totalCredit]);
  total.font = { bold: true };
  ws.columns.forEach((c, i) => (c.width = [12, 14, 12, 30, 16, 16][i] ?? 14));
  moneyCols(ws, [5, 6]);
}

function sheetLedger(wb: ExcelJS.Workbook, s: Statements, h: StatementsHeader): void {
  const ws = wb.addWorksheet("บัญชีแยกประเภท");
  writeTitle(ws, "บัญชีแยกประเภท (Ledger)", h);
  // แยก 1 บัญชี = 1 ชุด (section): หัว → B/F → รายการ → C/F → รวม Dr/Cr → เว้นบรรทัด
  for (const a of buildLedgerStatements(s.ledger)) {
    const head = ws.addRow([`${a.code} · ${a.name}`, `หมวด: ${a.category}`]);
    head.font = { bold: true };
    const cols = ws.addRow(["วันที่", "รายการ", "คำอธิบาย", "เดบิต", "เครดิต", "คงเหลือ"]);
    styleHeaderRow(cols);
    for (const r of a.rows) {
      if (r.kind === "txn") {
        ws.addRow([dateBE(r.date), r.docNo ?? "", r.description ?? "", r.debit || null, r.credit || null, r.balance]);
      } else {
        // B/F ยอดยกมา · C/F ยอดยกไป
        const bf = ws.addRow([r.kind === "bf" ? "B/F" : "C/F", r.label, "", null, null, r.balance]);
        bf.font = { bold: true };
      }
    }
    const foot = ws.addRow([
      `รวม · Dr = ${a.totals.debitCount} · Cr = ${a.totals.creditCount}`,
      "",
      "",
      a.totals.debitAmount,
      a.totals.creditAmount,
      a.closing,
    ]);
    foot.font = { bold: true };
    ws.addRow([]);
  }
  ws.columns.forEach((c, i) => (c.width = [14, 16, 24, 16, 16, 16][i] ?? 14));
  moneyCols(ws, [4, 5, 6]);
}

function sheetTrial(wb: ExcelJS.Workbook, s: Statements, h: StatementsHeader): void {
  const ws = wb.addWorksheet("งบทดลอง");
  writeTitle(ws, "งบทดลอง (Trial Balance)", h);
  const header = ws.addRow([
    "รหัสบัญชี",
    "ชื่อบัญชี",
    "หมวด",
    "ยอดยกมา",
    "เดบิต",
    "เครดิต",
    "ยอดเดบิต",
    "ยอดเครดิต",
  ]);
  styleHeaderRow(header);
  const tb = s.trialBalance;
  for (const g of tb.groups) {
    const gh = ws.addRow([g.category]);
    gh.font = { bold: true };
    for (const r of g.rows) {
      ws.addRow([
        r.code,
        r.name,
        r.category,
        r.opening || null,
        r.debit || null,
        r.credit || null,
        r.balance >= 0 ? r.balance : null,
        r.balance < 0 ? -r.balance : null,
      ]);
    }
  }
  const total = ws.addRow([
    "",
    "รวมทั้งสิ้น",
    "",
    tb.totalOpening,
    tb.totalDebit,
    tb.totalCredit,
    tb.totalBalanceDebit,
    tb.totalBalanceCredit,
  ]);
  total.font = { bold: true };
  ws.columns.forEach((c, i) => (c.width = [12, 28, 14, 14, 14, 14, 14, 14][i] ?? 14));
  moneyCols(ws, [4, 5, 6, 7, 8]);
}

function sheetIncome(wb: ExcelJS.Workbook, s: Statements, h: StatementsHeader): void {
  const ws = wb.addWorksheet("งบกำไรขาดทุน");
  writeTitle(ws, "งบกำไรขาดทุน (Income Statement)", h);
  const inc = s.incomeStatement;
  const header = ws.addRow(["รหัสบัญชี", "รายการ", "จำนวนเงิน"]);
  styleHeaderRow(header);

  ws.addRow(["", "รายได้", ""]).font = { bold: true };
  for (const l of inc.revenues) ws.addRow([l.code, l.name, l.amount]);
  ws.addRow(["", "รวมรายได้", inc.totalRevenue]).font = { bold: true };

  ws.addRow(["", "ค่าใช้จ่าย", ""]).font = { bold: true };
  for (const l of inc.expenses) ws.addRow([l.code, l.name, l.amount]);
  ws.addRow(["", "รวมค่าใช้จ่าย", inc.totalExpense]).font = { bold: true };

  const net = ws.addRow(["", "กำไร(ขาดทุน)สุทธิ", inc.netProfit]);
  net.font = { bold: true };
  ws.columns.forEach((c, i) => (c.width = [12, 34, 18][i] ?? 14));
  moneyCols(ws, [3]);
}

function sheetBalance(wb: ExcelJS.Workbook, s: Statements, h: StatementsHeader): void {
  const ws = wb.addWorksheet("งบแสดงฐานะการเงิน");
  writeTitle(ws, "งบแสดงฐานะการเงิน (Balance Sheet)", h);
  const bs = s.balanceSheet;
  const header = ws.addRow(["รหัสบัญชี", "รายการ", "จำนวนเงิน"]);
  styleHeaderRow(header);

  ws.addRow(["", "สินทรัพย์", ""]).font = { bold: true };
  for (const l of bs.assets) ws.addRow([l.code, l.name, l.amount]);
  ws.addRow(["", "รวมสินทรัพย์", bs.totalAssets]).font = { bold: true };

  ws.addRow(["", "หนี้สิน", ""]).font = { bold: true };
  for (const l of bs.liabilities) ws.addRow([l.code, l.name, l.amount]);
  ws.addRow(["", "รวมหนี้สิน", bs.totalLiabilities]).font = { bold: true };

  ws.addRow(["", "ส่วนของผู้ถือหุ้น", ""]).font = { bold: true };
  for (const l of bs.equity) ws.addRow([l.code, l.name, l.amount]);
  ws.addRow(["", "กำไร(ขาดทุน)สุทธิของงวด", bs.netProfit]);
  ws.addRow(["", "รวมส่วนของผู้ถือหุ้น", bs.totalEquityWithProfit]).font = { bold: true };

  const foot = ws.addRow(["", "รวมหนี้สินและส่วนของผู้ถือหุ้น", bs.totalLiabilities + bs.totalEquityWithProfit]);
  foot.font = { bold: true };
  if (!bs.balanced) {
    ws.addRow([]);
    ws.addRow(["", `⚠️ งบไม่สมดุล — ผลต่าง ${bs.difference.toFixed(2)} (ตรวจยอดยกมา/บิลที่ตกหล่น)`]).font = {
      color: { argb: "FFCC0000" },
    };
  }
  ws.columns.forEach((c, i) => (c.width = [12, 34, 18][i] ?? 14));
  moneyCols(ws, [3]);
}

function sheetSkipped(wb: ExcelJS.Workbook, s: Statements): void {
  if (s.journal.skipped.length === 0) return;
  const ws = wb.addWorksheet("รายการตกหล่น");
  ws.addRow(["รายการที่ยังไม่เข้าระบบงบ (ต้องแก้ก่อนงบจะครบ)"]).font = { bold: true, size: 13 };
  ws.addRow([]);
  const header = ws.addRow(["วันที่", "เลขที่", "ประเภท", "เหตุผล"]);
  styleHeaderRow(header);
  for (const sk of s.journal.skipped) {
    const typeLabel = sk.entryType === "purchase" ? "ซื้อ" : sk.entryType === "sale" ? "ขาย" : "รอระบุ";
    ws.addRow([sk.date ?? "", sk.docNo ?? "", typeLabel, sk.reason]);
  }
  ws.columns.forEach((c, i) => (c.width = [12, 16, 10, 40][i] ?? 14));
}

/**
 * สร้าง workbook งบการเงิน
 *   @param report 'all' = ทุกงบ · หรือเลือกงบเดียว (journal/ledger/trial/income/balance)
 *   @returns Buffer ของไฟล์ .xlsx
 */
export async function buildStatementsWorkbook(
  statements: Statements,
  header: StatementsHeader,
  report: ReportKey = "all"
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  wb.created = new Date();

  const want = (k: ReportKey) => report === "all" || report === k;
  if (want("journal")) sheetJournal(wb, statements, header);
  if (want("ledger")) sheetLedger(wb, statements, header);
  if (want("trial")) sheetTrial(wb, statements, header);
  if (want("income")) sheetIncome(wb, statements, header);
  if (want("balance")) sheetBalance(wb, statements, header);
  // ชีทตกหล่น: ใส่เฉพาะตอน export ทั้งไฟล์ (ให้เห็นภาพรวมว่าทำไมงบไม่ครบ)
  if (report === "all") sheetSkipped(wb, statements);

  // กันชีทว่าง (เผื่อ report ไม่ตรงอะไรเลย)
  if (wb.worksheets.length === 0) wb.addWorksheet("งบการเงิน");

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/* ============================================================================================
 * เฟส 4 ส่วน N3 (docs/06-accounting-features-roadmap.md, N3) — งบการเงินฉบับทางการ เทียบงวด (.xlsx)
 *   ★ เพิ่มฟังก์ชันใหม่ทั้งหมดข้างล่างนี้ — ไม่แก้โค้ดเดิมด้านบนแม้แต่บรรทัดเดียว (คนละ route/คนละ workbook)
 *   ★ ใช้ mergeCompareLines/sumCompareLines เดียวกับที่จอ (N1) และหน้าพิมพ์ (N2) ใช้ — กันตัวเลขเพี้ยนกัน
 *     ระหว่าง 3 จุด (0.13 spirit)
 * ============================================================================================ */

/** ป้ายงวด 1 ชุด (ปัจจุบัน หรือ งวดเทียบ) คู่กับ statement ของงวดนั้น */
type LabeledIncome = { label: string; statement: IncomeStatement };
type LabeledBalance = { label: string; statement: BalanceSheet };
type LabeledCashFlow = { label: string; statement: CashFlowStatement };

/** ชีท "งบกำไรขาดทุน" — เทียบงวดได้ (compare=null = ไม่เทียบ แสดงคอลัมน์เดียว) */
export function sheetIncomeComparative(
  wb: ExcelJS.Workbook,
  current: LabeledIncome,
  compare: LabeledIncome | null,
  h: StatementsHeader
): void {
  const ws = wb.addWorksheet("งบกำไรขาดทุน");
  writeTitle(ws, "งบกำไรขาดทุน (Income Statement)", h);
  const cols = compare ? ["รหัสบัญชี", "รายการ", current.label, compare.label] : ["รหัสบัญชี", "รายการ", current.label];
  styleHeaderRow(ws.addRow(cols));

  const writeSection = (
    title: string,
    curLines: IncomeStatement["revenues"],
    cmpLines: IncomeStatement["revenues"] | null
  ) => {
    ws.addRow(["", title]).font = { bold: true };
    const rows = mergeCompareLines(curLines, cmpLines);
    for (const r of rows) {
      ws.addRow(compare ? [r.code, r.name, r.current, r.compare ?? 0] : [r.code, r.name, r.current]);
    }
    const totals = sumCompareLines(rows);
    const totalRow = ws.addRow(
      compare ? ["", `รวม${title}`, totals.current, totals.compare ?? 0] : ["", `รวม${title}`, totals.current]
    );
    totalRow.font = { bold: true };
    return totals;
  };

  const revTotal = writeSection("รายได้", current.statement.revenues, compare?.statement.revenues ?? null);
  const expTotal = writeSection("ค่าใช้จ่าย", current.statement.expenses, compare?.statement.expenses ?? null);

  const netCompare = compare ? (revTotal.compare ?? 0) - (expTotal.compare ?? 0) : null;
  const netRow = ws.addRow(
    compare
      ? ["", "กำไร(ขาดทุน)สุทธิ", current.statement.netProfit, netCompare ?? 0]
      : ["", "กำไร(ขาดทุน)สุทธิ", current.statement.netProfit]
  );
  netRow.font = { bold: true };

  const widths = compare ? [12, 34, 18, 18] : [12, 34, 18];
  ws.columns.forEach((c, i) => (c.width = widths[i] ?? 14));
  moneyCols(ws, compare ? [3, 4] : [3]);
}

/** ชีท "งบแสดงฐานะการเงิน" — เทียบ ณ จุดเวลาอีกจุดหนึ่งได้ (compare=null = ไม่เทียบ) */
export function sheetBalanceComparative(
  wb: ExcelJS.Workbook,
  current: LabeledBalance,
  compare: LabeledBalance | null,
  h: StatementsHeader
): void {
  const ws = wb.addWorksheet("งบแสดงฐานะการเงิน");
  writeTitle(ws, "งบแสดงฐานะการเงิน (Balance Sheet)", h);
  const cols = compare ? ["รหัสบัญชี", "รายการ", current.label, compare.label] : ["รหัสบัญชี", "รายการ", current.label];
  styleHeaderRow(ws.addRow(cols));

  const writeSection = (
    title: string,
    curLines: BalanceSheet["assets"],
    cmpLines: BalanceSheet["assets"] | null
  ) => {
    ws.addRow(["", title]).font = { bold: true };
    const rows = mergeCompareLines(curLines, cmpLines);
    for (const r of rows) {
      ws.addRow(compare ? [r.code, r.name, r.current, r.compare ?? 0] : [r.code, r.name, r.current]);
    }
    const totals = sumCompareLines(rows);
    const totalRow = ws.addRow(
      compare ? ["", `รวม${title}`, totals.current, totals.compare ?? 0] : ["", `รวม${title}`, totals.current]
    );
    totalRow.font = { bold: true };
    return totals;
  };

  const assetTotal = writeSection("สินทรัพย์", current.statement.assets, compare?.statement.assets ?? null);
  const liabilityTotal = writeSection("หนี้สิน", current.statement.liabilities, compare?.statement.liabilities ?? null);
  const equityTotal = writeSection("ส่วนของผู้ถือหุ้น", current.statement.equity, compare?.statement.equity ?? null);

  ws.addRow(
    compare
      ? ["", "กำไร(ขาดทุน)สุทธิของงวด", current.statement.netProfit, compare.statement.netProfit]
      : ["", "กำไร(ขาดทุน)สุทธิของงวด", current.statement.netProfit]
  );

  const equityWithProfitCompare = compare ? (equityTotal.compare ?? 0) + compare.statement.netProfit : null;
  const equityRow = ws.addRow(
    compare
      ? ["", "รวมส่วนของผู้ถือหุ้น", current.statement.totalEquityWithProfit, equityWithProfitCompare ?? 0]
      : ["", "รวมส่วนของผู้ถือหุ้น", current.statement.totalEquityWithProfit]
  );
  equityRow.font = { bold: true };

  const liabEquityCompare = compare ? (liabilityTotal.compare ?? 0) + (equityWithProfitCompare ?? 0) : null;
  const footRow = ws.addRow(
    compare
      ? [
          "",
          "รวมหนี้สินและส่วนของผู้ถือหุ้น",
          current.statement.totalLiabilities + current.statement.totalEquityWithProfit,
          liabEquityCompare ?? 0,
        ]
      : ["", "รวมหนี้สินและส่วนของผู้ถือหุ้น", current.statement.totalLiabilities + current.statement.totalEquityWithProfit]
  );
  footRow.font = { bold: true };

  if (!current.statement.balanced) {
    ws.addRow([]);
    ws.addRow(["", `⚠️ งบไม่สมดุล — ผลต่าง ${current.statement.difference.toFixed(2)} (ตรวจยอดยกมา/บิลที่ตกหล่น)`]).font = {
      color: { argb: "FFCC0000" },
    };
  }

  const widths = compare ? [12, 34, 18, 18] : [12, 34, 18];
  ws.columns.forEach((c, i) => (c.width = widths[i] ?? 14));
  moneyCols(ws, compare ? [3, 4] : [3]);
}

/**
 * ชีท "งบกระแสเงินสด" (เฟส 4 ส่วน O4, direct method) — เทียบงวดได้ (compare=null = ไม่เทียบ)
 *   ★ รวม CashFlowLine[] เป็น StatementLine[] ต่อรหัสบัญชีผ่าน aggregateCashFlowLines ก่อนใช้
 *   mergeCompareLines/sumCompareLines เดิม (0.13 spirit — ใช้ตัวรวมเดียวกับงบอื่น)
 */
export function sheetCashFlow(
  wb: ExcelJS.Workbook,
  current: LabeledCashFlow,
  compare: LabeledCashFlow | null,
  h: StatementsHeader
): void {
  const ws = wb.addWorksheet("งบกระแสเงินสด");
  writeTitle(ws, "งบกระแสเงินสด (Cash Flow Statement)", h);
  const cols = compare ? ["รหัสบัญชี", "รายการ", current.label, compare.label] : ["รหัสบัญชี", "รายการ", current.label];
  styleHeaderRow(ws.addRow(cols));

  const writeSection = (title: string, curLines: ReturnType<typeof aggregateCashFlowLines>, cmpLines: ReturnType<typeof aggregateCashFlowLines> | null) => {
    ws.addRow(["", title]).font = { bold: true };
    const rows = mergeCompareLines(curLines, cmpLines);
    for (const r of rows) {
      ws.addRow(compare ? [r.code, r.name, r.current, r.compare ?? 0] : [r.code, r.name, r.current]);
    }
    const totalRow = ws.addRow(
      compare ? ["", `รวม${title}`, sumCompareLines(rows).current, sumCompareLines(rows).compare ?? 0] : ["", `รวม${title}`, sumCompareLines(rows).current]
    );
    totalRow.font = { bold: true };
  };

  writeSection(
    "กิจกรรมดำเนินงาน",
    aggregateCashFlowLines(current.statement.operating),
    compare ? aggregateCashFlowLines(compare.statement.operating) : null
  );
  writeSection(
    "กิจกรรมลงทุน",
    aggregateCashFlowLines(current.statement.investing),
    compare ? aggregateCashFlowLines(compare.statement.investing) : null
  );
  writeSection(
    "กิจกรรมจัดหาเงิน",
    aggregateCashFlowLines(current.statement.financing),
    compare ? aggregateCashFlowLines(compare.statement.financing) : null
  );

  const netRow = ws.addRow(
    compare
      ? ["", "เงินสดเพิ่มขึ้น(ลดลง)สุทธิ", current.statement.netChange, compare.statement.netChange]
      : ["", "เงินสดเพิ่มขึ้น(ลดลง)สุทธิ", current.statement.netChange]
  );
  netRow.font = { bold: true };
  ws.addRow(
    compare
      ? ["", "เงินสดต้นงวด", current.statement.openingCash, compare.statement.openingCash]
      : ["", "เงินสดต้นงวด", current.statement.openingCash]
  );
  const closingRow = ws.addRow(
    compare
      ? ["", "เงินสดปลายงวด", current.statement.closingCash, compare.statement.closingCash]
      : ["", "เงินสดปลายงวด", current.statement.closingCash]
  );
  closingRow.font = { bold: true };

  if (!current.statement.reconciled) {
    ws.addRow([]);
    ws.addRow(["", "⚠️ งบกระแสเงินสดยังไม่สมดุล (reconciled=false) — ตรวจการจัดหมวดรายการ"]).font = {
      color: { argb: "FFCC0000" },
    };
  }

  const widths = compare ? [12, 34, 18, 18] : [12, 34, 18];
  ws.columns.forEach((c, i) => (c.width = widths[i] ?? 14));
  moneyCols(ws, compare ? [3, 4] : [3]);
}

/** ชีท "รายการตกหล่น" ของงวดปัจจุบัน (mirror sheetSkipped เดิม แต่รับ SkippedEntry[] ตรง ๆ ไม่ต้องมี Statements เต็ม) */
function sheetSkippedFromJournal(wb: ExcelJS.Workbook, skipped: SkippedEntry[]): void {
  if (skipped.length === 0) return;
  const ws = wb.addWorksheet("รายการตกหล่น");
  ws.addRow(["รายการที่ยังไม่เข้าระบบงบ (ต้องแก้ก่อนงบจะครบ)"]).font = { bold: true, size: 13 };
  ws.addRow([]);
  const header = ws.addRow(["วันที่", "เลขที่", "ประเภท", "เหตุผล"]);
  styleHeaderRow(header);
  for (const sk of skipped) {
    const typeLabel = sk.entryType === "purchase" ? "ซื้อ" : sk.entryType === "sale" ? "ขาย" : "รอระบุ";
    ws.addRow([sk.date ?? "", sk.docNo ?? "", typeLabel, sk.reason]);
  }
  ws.columns.forEach((c, i) => (c.width = [12, 16, 10, 40][i] ?? 14));
}

/**
 * สร้าง workbook งบการเงินฉบับทางการ (N3) — งบกำไรขาดทุน + งบแสดงฐานะการเงิน เทียบงวดได้
 *   ★ ไฟล์แยกจาก buildStatementsWorkbook() เดิม (คนละ route: financial-statements/export)
 *   @param formal งบของงวดปัจจุบัน (จาก buildFormalStatements())
 *   @param header ป้ายกิจการ (ไม่รวมงวด — งวดใส่แยกต่อคอลัมน์ผ่าน compare.currentLabel/compareLabel)
 *   @param currentLabel ป้ายงวดปัจจุบัน (เช่น "ก.ค. 2569")
 *   @param compare งวดเทียบ (ถ้ามี) — null = ไม่เทียบ (export คอลัมน์เดียว)
 */
export async function buildFormalStatementsWorkbook(
  formal: FormalStatements,
  header: StatementsHeader,
  currentLabel: string,
  compare: { formal: FormalStatements; label: string } | null = null
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  wb.created = new Date();

  const compareIncome: LabeledIncome | null = compare
    ? { label: compare.label, statement: compare.formal.flow.incomeStatement }
    : null;
  const compareBalance: LabeledBalance | null = compare
    ? { label: compare.label, statement: compare.formal.balanceSheet }
    : null;
  const compareCashFlow: LabeledCashFlow | null = compare
    ? { label: compare.label, statement: compare.formal.cashFlow }
    : null;

  sheetIncomeComparative(wb, { label: currentLabel, statement: formal.flow.incomeStatement }, compareIncome, header);
  sheetBalanceComparative(wb, { label: currentLabel, statement: formal.balanceSheet }, compareBalance, header);
  sheetCashFlow(wb, { label: currentLabel, statement: formal.cashFlow }, compareCashFlow, header);
  sheetSkippedFromJournal(wb, formal.flow.journal.skipped);

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
