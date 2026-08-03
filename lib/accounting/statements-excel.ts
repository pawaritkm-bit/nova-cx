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
  for (const a of s.ledger.accounts) {
    const head = ws.addRow([`${a.code} · ${a.name}`, `หมวด: ${a.category}`]);
    head.font = { bold: true };
    const cols = ws.addRow(["วันที่", "เลขที่", "เดบิต", "เครดิต", "คงเหลือ"]);
    styleHeaderRow(cols);
    ws.addRow(["ยอดยกมา", "", "", "", a.opening]);
    for (const t of a.txns) {
      ws.addRow([t.date ?? "", t.docNo ?? "", t.debit || null, t.credit || null, t.balance]);
    }
    const foot = ws.addRow(["รวม", "", a.totalDebit, a.totalCredit, a.balance]);
    foot.font = { bold: true };
    ws.addRow([]);
  }
  ws.columns.forEach((c, i) => (c.width = [16, 14, 16, 16, 16][i] ?? 14));
  moneyCols(ws, [3, 4, 5]);
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
