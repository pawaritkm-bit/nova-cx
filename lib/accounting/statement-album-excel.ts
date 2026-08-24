/**
 * statement-album-excel.ts — Excel "รายละเอียดเงินเข้า/ออก" ของลูกค้า 1 ราย (ตามแบบฟอร์มต้นฉบับ)
 *   ชีต: ประวัติลูกค้า (KYC กรอกมือ) · รายละเอียดเงินเข้า (matrix เดือน×ธนาคาร) · รายละเอียดเงินออก · ลดหย่อน
 *   matrix: แถว = ม.ค.–มิ.ย. / กลางปี / ก.ค.–ธ.ค. / สิ้นปี · คอลัมน์ = [ธนาคาร: ยอด, ครั้ง] + รวม
 *   ★ pure (ไม่ log เนื้อ/ยอด — PDPA) · เก็บข้อมูลดิบในชีตซ่อน _data (ไม่มี sidecar)
 */
import ExcelJS from "exceljs";
import type { StatementTxn } from "@/lib/accounting/statement-analyze";
import type { AlbumStore, AlbumProfile } from "@/lib/accounting/statement-album";
import { emptyAlbum } from "@/lib/accounting/statement-album";

const PROFILE_SHEET = "_profile";
const PROFILE_KEYS = ["name", "idNo", "address", "dob", "cardIssue", "cardExpiry", "laserCode"] as const;

const DATA_SHEET = "_data";
const DATA_HEADER = ["bank", "date", "description", "counterparty", "account_no", "direction", "amount"] as const;
const TH_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const VAT_THRESHOLD = 1_800_000;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function amtOf(t: StatementTxn): number {
  return typeof t.amount === "number" ? Math.abs(t.amount) : 0;
}

// ---------- aggregation helpers (pure, exported for tests) ----------

export type MonthAgg = { key: string; label: string; count: number; amount: number };
const TH_MONTHS_FULL = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

/** รวมรายเดือน (เฉพาะทิศทาง) เรียงเก่า→ใหม่ (คีย์ YYYY-MM) */
export function monthlyAgg(txns: StatementTxn[], dir: "in" | "out"): MonthAgg[] {
  const map = new Map<string, { count: number; amount: number }>();
  for (const t of txns) {
    if (t.direction !== dir) continue;
    const m = /^(\d{4})-(\d{2})/.exec(t.date || "");
    if (!m) continue;
    const key = `${m[1]}-${m[2]}`;
    const cur = map.get(key) ?? { count: 0, amount: 0 };
    cur.count++;
    cur.amount = round2(cur.amount + amtOf(t));
    map.set(key, cur);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, v]) => {
    const [y, mo] = key.split("-");
    return { key, label: `${TH_MONTHS_FULL[parseInt(mo, 10) - 1] ?? mo} ${y}`, count: v.count, amount: v.amount };
  });
}

export type PartyAgg = { party: string; count: number; amount: number };
function partyKey(t: StatementTxn): string {
  return (t.counterparty_name || "").trim() || (t.counterparty_account_no || "").trim() || "ไม่ระบุ";
}
export function partyAgg(txns: StatementTxn[], dir: "in" | "out", minCount = 2): { groups: PartyAgg[]; others: PartyAgg | null } {
  const map = new Map<string, { count: number; amount: number }>();
  for (const t of txns) {
    if (t.direction !== dir) continue;
    const k = partyKey(t);
    const cur = map.get(k) ?? { count: 0, amount: 0 };
    cur.count++;
    cur.amount = round2(cur.amount + amtOf(t));
    map.set(k, cur);
  }
  const all = [...map.entries()].map(([party, v]) => ({ party, ...v }));
  const groups = all.filter((g) => g.count >= minCount).sort((a, b) => b.amount - a.amount);
  const rest = all.filter((g) => g.count < minCount);
  const others = rest.length
    ? { party: `อื่นๆ (< ${minCount} ครั้ง, ${rest.length} ราย)`, count: rest.reduce((a, g) => a + g.count, 0), amount: round2(rest.reduce((a, g) => a + g.amount, 0)) }
    : null;
  return { groups, others };
}

export function totalsOf(txns: StatementTxn[], dir: "in" | "out"): { count: number; amount: number } {
  let count = 0;
  let amount = 0;
  for (const t of txns) if (t.direction === dir) { count++; amount += amtOf(t); }
  return { count, amount: round2(amount) };
}

/** ยอด+ครั้ง ต่อเดือน(1-12) ของธนาคารหนึ่ง เฉพาะทิศทาง (รวมข้ามปีตามเลขเดือน) */
function monthMap(txns: StatementTxn[], dir: "in" | "out"): Map<number, { amount: number; count: number }> {
  const m = new Map<number, { amount: number; count: number }>();
  for (const t of txns) {
    if (t.direction !== dir) continue;
    const mm = /^\d{4}-(\d{2})/.exec(t.date || "");
    if (!mm) continue;
    const mo = parseInt(mm[1], 10);
    const cur = m.get(mo) ?? { amount: 0, count: 0 };
    cur.amount = round2(cur.amount + amtOf(t));
    cur.count++;
    m.set(mo, cur);
  }
  return m;
}

// ---------- tax comparison block (personal vs corporate) ----------

/** สูตรภาษีเงินได้บุคคลธรรมดา (ขั้นบันได 0–35%) อ้างเซลล์เงินได้สุทธิ N */
function personalTaxFormula(N: string): string {
  return `ROUND(0.05*MAX(0,MIN(${N},300000)-150000)+0.1*MAX(0,MIN(${N},500000)-300000)+0.15*MAX(0,MIN(${N},750000)-500000)+0.2*MAX(0,MIN(${N},1000000)-750000)+0.25*MAX(0,MIN(${N},2000000)-1000000)+0.3*MAX(0,MIN(${N},5000000)-2000000)+0.35*MAX(0,${N}-5000000),2)`;
}
/** สูตรภาษีนิติบุคคล SME (0% ≤3แสน · 15% 3แสน–3ล้าน · 20% >3ล้าน) อ้างเซลล์กำไรสุทธิ M */
function corporateTaxFormula(M: string): string {
  return `ROUND(0.15*MAX(0,MIN(${M},3000000)-300000)+0.2*MAX(0,${M}-3000000),2)`;
}

/**
 * เขียนบล็อก "เทียบภาษี บุคคลธรรมดา vs นิติบุคคล" (ขวาของตารางเงินเข้า) พร้อมสูตร Excel
 *   นักบัญชีกรอก: อัตราเหมา% / ค่าใช้จ่ายจริง / ค่าลดหย่อนแต่ละช่อง → กำไร/ภาษี คำนวณเอง
 *   ★ อัตราเหมาตาม RD: 40(8) ซื้อมาขาย/รับเหมา = 60% · 40(6) วิชาชีพ 30% (แพทย์/โรคศิลปะ 60%) — ปรับที่ช่อง %
 */
function writeTaxBlock(ws: ExcelJS.Worksheet, startRow: number, c0: number, incomeAddr: string): void {
  const L = (n: number) => ws.getColumn(n).letter;
  const A = (row: number, n: number) => `${L(n)}${row}`;
  const cLbl = c0;
  const cVal = c0 + 1;
  ws.getColumn(cLbl).width = 26;
  ws.getColumn(cVal).width = 16;
  const label = (row: number, text: string, bold = false) => { const cc = ws.getCell(row, cLbl); cc.value = text; if (bold) cc.font = { bold: true }; };
  const money = (row: number, v: number | { formula: string }) => { const cc = ws.getCell(row, cVal); cc.value = v as ExcelJS.CellValue; cc.numFmt = "#,##0.00"; };

  let y = startRow;
  // ===== บุคคลธรรมดา =====
  label(y, "เทียบภาษี — บุคคลธรรมดา", true); y++;
  label(y, "รายได้ทั้งปี"); money(y, { formula: incomeAddr }); const incR = A(y, cVal); y++;
  label(y, "อัตราหักเหมา % (กรอก)"); ws.getCell(y, cVal).value = 0.6; ws.getCell(y, cVal).numFmt = "0%"; const rateR = A(y, cVal); y++;
  label(y, "ค่าใช้จ่าย (เหมา)"); money(y, { formula: `${incR}*${rateR}` }); const expLumpR = A(y, cVal); y++;
  label(y, "ค่าใช้จ่ายตามจริง (กรอกถ้าใช้)"); ws.getCell(y, cVal).numFmt = "#,##0.00"; const expActR = A(y, cVal); y++;
  label(y, "กำไร (รายได้−ค่าใช้จ่าย)"); money(y, { formula: `${incR}-IF(${expActR}>0,${expActR},${expLumpR})` }); const profitR = A(y, cVal); y++;
  label(y, "หักลดหย่อน", true); y++;
  const dedStart = y;
  const deds: [string, number][] = [
    ["ส่วนตัว", 60000], ["คู่สมรส (ไม่มีรายได้)", 0], ["บุตร", 0], ["อุปการะบิดา/มารดา", 0],
    ["ประกันสังคม", 0], ["เบี้ยประกันชีวิต", 0], ["เบี้ยประกันสุขภาพ", 0], ["ดอกเบี้ยผ่อนบ้าน", 0], ["เงินบริจาค", 0],
  ];
  for (const [name, def] of deds) { label(y, `  ${name}`); ws.getCell(y, cVal).value = def; ws.getCell(y, cVal).numFmt = "#,##0.00"; y++; }
  const dedEnd = y - 1;
  label(y, "รวมลดหย่อน", true); money(y, { formula: `SUM(${L(cVal)}${dedStart}:${L(cVal)}${dedEnd})` }); const dedR = A(y, cVal); y++;
  label(y, "เงินได้สุทธิ (คำนวณภาษี)", true); money(y, { formula: `MAX(0,${profitR}-${dedR})` }); const netR = A(y, cVal); y++;
  label(y, "ภาษีบุคคลธรรมดา", true); money(y, { formula: personalTaxFormula(netR) }); const persTaxR = A(y, cVal);
  ws.getCell(y, cVal).font = { bold: true }; y += 2;

  // ===== นิติบุคคล =====
  label(y, "เทียบภาษี — นิติบุคคล (SME)", true); y++;
  label(y, "กำไรสุทธิ (ปรับได้)"); money(y, { formula: profitR }); const corpNetR = A(y, cVal); y++;
  label(y, "ภาษีนิติบุคคล (0/15/20%)", true); money(y, { formula: corporateTaxFormula(corpNetR) }); const corpTaxR = A(y, cVal);
  ws.getCell(y, cVal).font = { bold: true }; y += 2;

  // ===== เปรียบเทียบ =====
  label(y, "ส่วนต่างภาษี (บุคคล − นิติ)", true); money(y, { formula: `${persTaxR}-${corpTaxR}` });
  ws.getCell(y, cVal).font = { bold: true }; y++;
  label(y, "* กรอกช่องเหมา%/ค่าใช้จ่ายจริง/ลดหย่อน แล้วภาษีคำนวณอัตโนมัติ");
}

// ---------- workbook ----------

export async function buildStatementAlbumWorkbook(input: {
  customerName: string;
  banks: Record<string, StatementTxn[]>;
  profile?: AlbumProfile;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  const bankLabels = Object.keys(input.banks).sort((a, b) => a.localeCompare(b, "th"));
  const pf = input.profile ?? {};

  // ===== ชีต 1: ประวัติลูกค้า (KYC — เติมจากบัตร ปชช. อัตโนมัติ ช่องที่ว่างกรอกมือ) =====
  const p = wb.addWorksheet("ประวัติลูกค้า");
  p.columns = [{ width: 22 }, { width: 34 }, { width: 4 }, { width: 22 }, { width: 34 }];
  const lbl = (row: number, text: string, val: string | null | undefined, col = 1) => {
    p.getCell(row, col).value = text; p.getCell(row, col).font = { bold: true };
    if (val) p.getCell(row, col + 1).value = val;
  };
  p.getCell(1, 1).value = `ประวัติลูกค้า — ${input.customerName}`;
  p.getCell(1, 1).font = { bold: true, size: 14 };
  lbl(3, "ผู้เสียภาษี", pf.name); lbl(3, "เลขบัตร (เลขภาษี)", pf.idNo, 4);
  lbl(4, "ที่อยู่", pf.address); lbl(4, "เลขหลังบัตร", pf.laserCode, 4);
  lbl(5, "เกิดวันที่", pf.dob); lbl(5, "รหัสยื่นสรรพากร", pf.idNo, 4);
  lbl(6, "วันออกบัตร", pf.cardIssue); lbl(6, "บัตรหมดอายุ", pf.cardExpiry, 4);
  lbl(7, "หมายเหตุ", null);

  // ===== ชีต matrix เงินเข้า/ออก =====
  const buildMatrix = (dir: "in" | "out", sheetName: string, amtHead: string) => {
    const ws = wb.addWorksheet(sheetName);
    ws.getCell(1, 1).value = `${sheetName}คุณ${input.customerName}`;
    ws.getCell(1, 1).font = { bold: true, size: 14 };
    const maps = bankLabels.map((b) => monthMap(input.banks[b] ?? [], dir));

    // header (แถว 3): เดือน | [ธนาคาร, ครั้ง]... | รวม(บาท)
    const H = 3;
    ws.getCell(H, 1).value = "เดือน";
    const cols: { amt: number; cnt: number }[] = [];
    let c = 2;
    bankLabels.forEach((b) => { ws.getCell(H, c).value = b; ws.getCell(H, c + 1).value = "ครั้ง"; cols.push({ amt: c, cnt: c + 1 }); c += 2; });
    const totalCol = c;
    ws.getCell(H, totalCol).value = `รวม${amtHead}(บาท)`;
    ws.getRow(H).font = { bold: true };
    ws.getColumn(1).width = 12;
    cols.forEach((cc) => { ws.getColumn(cc.amt).width = 18; ws.getColumn(cc.cnt).width = 7; });
    ws.getColumn(totalCol).width = 18;

    const bankYear = bankLabels.map(() => ({ amount: 0, count: 0 }));
    const bankHalf = bankLabels.map(() => ({ amount: 0, count: 0 }));
    let grand = 0;

    const writeMonthRow = (row: number, mo: number) => {
      ws.getCell(row, 1).value = TH_SHORT[mo - 1];
      let rowTotal = 0;
      bankLabels.forEach((_, bi) => {
        const cell = maps[bi].get(mo);
        if (cell && cell.amount > 0) {
          ws.getCell(row, cols[bi].amt).value = cell.amount;
          ws.getCell(row, cols[bi].amt).numFmt = "#,##0.00";
          ws.getCell(row, cols[bi].cnt).value = cell.count;
          rowTotal = round2(rowTotal + cell.amount);
          bankYear[bi].amount = round2(bankYear[bi].amount + cell.amount);
          bankYear[bi].count += cell.count;
          if (mo <= 6) { bankHalf[bi].amount = round2(bankHalf[bi].amount + cell.amount); bankHalf[bi].count += cell.count; }
        }
      });
      if (rowTotal > 0) { ws.getCell(row, totalCol).value = rowTotal; ws.getCell(row, totalCol).numFmt = "#,##0.00"; grand = round2(grand + rowTotal); }
    };
    const writeSumRow = (row: number, label: string, per: { amount: number; count: number }[]) => {
      ws.getCell(row, 1).value = label; ws.getCell(row, 1).font = { bold: true };
      let tot = 0;
      bankLabels.forEach((_, bi) => {
        ws.getCell(row, cols[bi].amt).value = per[bi].amount; ws.getCell(row, cols[bi].amt).numFmt = "#,##0.00"; ws.getCell(row, cols[bi].amt).font = { bold: true };
        ws.getCell(row, cols[bi].cnt).value = per[bi].count; ws.getCell(row, cols[bi].cnt).font = { bold: true };
        tot = round2(tot + per[bi].amount);
      });
      ws.getCell(row, totalCol).value = tot; ws.getCell(row, totalCol).numFmt = "#,##0.00"; ws.getCell(row, totalCol).font = { bold: true };
    };

    let r = H + 1;
    for (let mo = 1; mo <= 6; mo++) writeMonthRow(r++, mo);
    writeSumRow(r++, "กลางปี", bankHalf.map((x) => ({ ...x })));
    for (let mo = 7; mo <= 12; mo++) writeMonthRow(r++, mo);
    const yearRow = r;
    writeSumRow(r++, "สิ้นปี", bankYear);

    // เตือน 1.8 ล้าน (เฉพาะเงินเข้า)
    if (dir === "in") {
      r += 1;
      const cCell = ws.getCell(r, 1);
      cCell.value = grand > VAT_THRESHOLD
        ? `⚠ เงินเข้ารวม ${grand.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท — เกิน 1,800,000 → ต้องจด VAT / ควรพิจารณาตั้งนิติบุคคล`
        : `เงินเข้ารวม ${grand.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท (ยังไม่ถึงเกณฑ์จด VAT 1.8 ล้าน)`;
      cCell.font = { bold: true, color: grand > VAT_THRESHOLD ? { argb: "FFB91C1C" } : undefined };
      // ★ บล็อกเทียบภาษี (บุคคลธรรมดา vs นิติบุคคล) — สูตรรันเมื่อนักบัญชีกรอกช่องมือ · income = ยอดสิ้นปีรวม
      const incomeAddr = `${ws.getColumn(totalCol).letter}${yearRow}`;
      writeTaxBlock(ws, H, totalCol + 2, incomeAddr);
    }
  };
  buildMatrix("in", "รายละเอียดเงินเข้า", "เงินเข้า");

  // ===== ชีต "กองผู้โอน" — แยกกองผู้โอนเข้า "ต่อธนาคาร" (จำนวนครั้ง + ยอดรวม) =====
  const g = wb.addWorksheet("กองผู้โอน");
  g.columns = [{ width: 46 }, { width: 14 }, { width: 18 }];
  let gy = 1;
  g.getCell(gy, 1).value = `กองผู้โอน (เงินเข้า) — ${input.customerName}`; g.getCell(gy, 1).font = { bold: true, size: 14 }; gy += 2;
  for (const label of bankLabels) {
    const txns = input.banks[label] ?? [];
    const { groups, others } = partyAgg(txns, "in");
    if (groups.length === 0 && !others) continue;
    g.getCell(gy, 1).value = `🏦 ${label}`; g.getCell(gy, 1).font = { bold: true }; gy++;
    ["ผู้โอน/บัญชี", "จำนวนครั้ง", "ยอดรวม (บาท)"].forEach((h, i) => { g.getCell(gy, i + 1).value = h; g.getCell(gy, i + 1).font = { bold: true }; }); gy++;
    for (const gr of groups) {
      g.getCell(gy, 1).value = gr.party; g.getCell(gy, 2).value = gr.count;
      g.getCell(gy, 3).value = gr.amount; g.getCell(gy, 3).numFmt = "#,##0.00"; gy++;
    }
    if (others) { g.getCell(gy, 1).value = others.party; g.getCell(gy, 2).value = others.count; g.getCell(gy, 3).value = others.amount; g.getCell(gy, 3).numFmt = "#,##0.00"; gy++; }
    const t = totalsOf(txns, "in");
    g.getCell(gy, 1).value = "รวม"; g.getCell(gy, 1).font = { bold: true };
    g.getCell(gy, 2).value = t.count; g.getCell(gy, 2).font = { bold: true };
    g.getCell(gy, 3).value = t.amount; g.getCell(gy, 3).numFmt = "#,##0.00"; g.getCell(gy, 3).font = { bold: true };
    gy += 2;
  }

  // ===== ชีต ลดหย่อน (เว้นไว้กรอกมือ) =====
  const ded = wb.addWorksheet("ลดหย่อน");
  ded.getCell(1, 1).value = "ลดหย่อน (กรอกมือ)";
  ded.getCell(1, 1).font = { bold: true, size: 14 };

  // ===== _profile ซ่อน (เก็บ KYC ไว้รีเจน) =====
  const pr = wb.addWorksheet(PROFILE_SHEET, { state: "veryHidden" });
  for (const k of PROFILE_KEYS) pr.addRow([k, pf[k] ?? ""]);

  // ===== _data ซ่อน (เก็บข้อมูลดิบไว้รีเจน — ไม่มี sidecar) =====
  const d = wb.addWorksheet(DATA_SHEET, { state: "veryHidden" });
  d.addRow(DATA_HEADER as unknown as string[]);
  for (const label of bankLabels) {
    for (const t of input.banks[label] ?? []) {
      d.addRow([label, t.date ?? "", t.description ?? "", t.counterparty_name ?? "", t.counterparty_account_no ?? "", t.direction ?? "", typeof t.amount === "number" ? t.amount : ""]);
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** อ่านกอง AlbumStore กลับจากชีตซ่อน _data · map ตาม header (รองรับเลย์เอาต์เก่า 6 คอลัมน์) · ไม่มี/พัง → ว่าง */
export async function readAlbumFromWorkbook(buf: Buffer | null): Promise<AlbumStore> {
  if (!buf) return emptyAlbum();
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const d = wb.getWorksheet(DATA_SHEET);
    if (!d) return emptyAlbum();
    const banks: Record<string, StatementTxn[]> = {};
    const str = (v: unknown): string | null => {
      if (v == null) return null;
      const s = String(typeof v === "object" && "text" in (v as object) ? (v as { text: unknown }).text : v).trim();
      return s || null;
    };
    const idx: Record<string, number> = {};
    d.getRow(1).eachCell({ includeEmpty: false }, (cc, ci) => { const k = str(cc.value); if (k) idx[k] = ci; });
    const col = (name: string) => idx[name] ?? 0;
    d.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const cell = (i: number) => (i > 0 ? row.getCell(i).value : null);
      const bank = str(cell(col("bank"))) || "";
      if (!bank) return;
      const dirRaw = str(cell(col("direction")));
      const direction = dirRaw === "in" ? "in" : dirRaw === "out" ? "out" : null;
      const amtRaw = cell(col("amount"));
      const amount = typeof amtRaw === "number" ? amtRaw : amtRaw != null && amtRaw !== "" ? Number(String(amtRaw).replace(/,/g, "")) : null;
      (banks[bank] ??= []).push({
        date: str(cell(col("date"))),
        description: str(cell(col("description"))),
        counterparty_name: str(cell(col("counterparty"))),
        counterparty_account_no: str(cell(col("account_no"))),
        direction,
        amount: Number.isFinite(amount as number) ? (amount as number) : null,
      });
    });
    // อ่านโปรไฟล์ KYC (ถ้ามีชีต _profile)
    let profile: AlbumProfile | undefined;
    const pr = wb.getWorksheet(PROFILE_SHEET);
    if (pr) {
      const prof: AlbumProfile = {};
      pr.eachRow((row) => {
        const k = str(row.getCell(1).value);
        const v = str(row.getCell(2).value);
        if (k && v && (PROFILE_KEYS as readonly string[]).includes(k)) (prof as Record<string, string>)[k] = v;
      });
      if (Object.keys(prof).length) profile = prof;
    }
    return { v: 2, banks, profile };
  } catch {
    return emptyAlbum();
  }
}
