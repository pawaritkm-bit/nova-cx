/**
 * statement-album-excel.ts — Excel "สรุปสเตทเมนต์" ของลูกค้า 1 ราย (ตามแบบฟอร์มต้นฉบับ)
 *   ชีต "รวมทุกธนาคาร" (บวกขาเข้า/ขาออกทุกแบงก์ + รายเดือนรวม) + 1 ชีต/ธนาคาร
 *   แต่ละชีตแบงก์: [1] เงินเข้ารายเดือน [2] กองคนโอนเข้า(≥2ครั้ง) [3] เงินออกรายเดือน [4] กองคนโอนออก(≥2ครั้ง)
 *   ★ pure (ไม่ log เนื้อ/ยอด — PDPA) · เก็บข้อมูลดิบในชีตซ่อน _data (ไม่มี sidecar)
 */
import ExcelJS from "exceljs";
import type { StatementTxn } from "@/lib/accounting/statement-analyze";
import type { AlbumStore } from "@/lib/accounting/statement-album";
import { emptyAlbum } from "@/lib/accounting/statement-album";

const DATA_SHEET = "_data";
const DATA_HEADER = ["bank", "date", "description", "counterparty", "account_no", "direction", "amount"] as const;

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function amt(t: StatementTxn): number {
  return typeof t.amount === "number" ? Math.abs(t.amount) : 0;
}

// ---------- aggregation helpers (pure, exported for tests) ----------

export type MonthAgg = { key: string; label: string; count: number; amount: number };

/** รวมรายเดือน (เฉพาะทิศทางที่ระบุ) — เรียงเดือนเก่า→ใหม่ · label = "<เดือนไทย> <ค.ศ.>" */
export function monthlyAgg(txns: StatementTxn[], dir: "in" | "out"): MonthAgg[] {
  const map = new Map<string, { count: number; amount: number }>();
  for (const t of txns) {
    if (t.direction !== dir) continue;
    const m = /^(\d{4})-(\d{2})/.exec(t.date || "");
    if (!m) continue;
    const key = `${m[1]}-${m[2]}`;
    const cur = map.get(key) ?? { count: 0, amount: 0 };
    cur.count++;
    cur.amount = round2(cur.amount + amt(t));
    map.set(key, cur);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, v]) => {
      const [y, mo] = key.split("-");
      return { key, label: `${TH_MONTHS[parseInt(mo, 10) - 1] ?? mo} ${y}`, count: v.count, amount: v.amount };
    });
}

export type PartyAgg = { party: string; count: number; amount: number };

/** ป้ายคู่ค้า: ชื่อ > เลขบัญชี/อ้างอิง > "ไม่ระบุ" */
function partyKey(t: StatementTxn): string {
  return (t.counterparty_name || "").trim() || (t.counterparty_account_no || "").trim() || "ไม่ระบุ";
}

/**
 * จับ "กอง" คู่ค้าที่ทำรายการซ้ำ ≥ minCount ครั้ง เรียงยอดมาก→น้อย
 *   + แถวรวม "อื่นๆ (< minCount ครั้ง)" ให้ยอดกระทบเต็ม (ถ้ามี)
 */
export function partyAgg(txns: StatementTxn[], dir: "in" | "out", minCount = 2): { groups: PartyAgg[]; others: PartyAgg | null } {
  const map = new Map<string, { count: number; amount: number }>();
  for (const t of txns) {
    if (t.direction !== dir) continue;
    const k = partyKey(t);
    const cur = map.get(k) ?? { count: 0, amount: 0 };
    cur.count++;
    cur.amount = round2(cur.amount + amt(t));
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
  for (const t of txns) if (t.direction === dir) { count++; amount += amt(t); }
  return { count, amount: round2(amount) };
}

function periodOf(txns: StatementTxn[]): string {
  const dates = txns.map((t) => t.date).filter((d): d is string => !!d).sort();
  if (dates.length === 0) return "–";
  return dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`;
}

function safeSheetName(name: string, used: Set<string>): string {
  const base = (name || "ธนาคาร").replace(/[\\/?*[\]:]+/g, " ").trim().slice(0, 28) || "ธนาคาร";
  let n = base;
  let i = 2;
  while (used.has(n)) n = `${base} ${i++}`.slice(0, 31);
  used.add(n);
  return n;
}

// ---------- workbook ----------

export async function buildStatementAlbumWorkbook(input: {
  customerName: string;
  banks: Record<string, StatementTxn[]>;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  const bankLabels = Object.keys(input.banks).sort((a, b) => a.localeCompare(b, "th"));
  const allTxns = bankLabels.flatMap((b) => input.banks[b] ?? []);

  // ===== ชีต "รวมทุกธนาคาร" =====
  const s = wb.addWorksheet("รวมทุกธนาคาร");
  s.columns = [{ width: 28 }, { width: 14 }, { width: 16 }, { width: 14 }, { width: 16 }];
  const bold = (row: number, col: number) => { s.getCell(row, col).font = { bold: true }; };
  s.getCell(1, 1).value = `สรุปสเตทเมนต์ (ทุกธนาคาร) — ${input.customerName}`;
  bold(1, 1); s.getCell(1, 1).font = { bold: true, size: 14 };

  let r = 3;
  ["ธนาคาร", "เงินเข้า (ครั้ง)", "เงินเข้า (บาท)", "เงินออก (ครั้ง)", "เงินออก (บาท)"].forEach((h, i) => { s.getCell(r, i + 1).value = h; bold(r, i + 1); });
  r++;
  let tInC = 0, tInA = 0, tOutC = 0, tOutA = 0;
  for (const label of bankLabels) {
    const inn = totalsOf(input.banks[label] ?? [], "in");
    const out = totalsOf(input.banks[label] ?? [], "out");
    s.getCell(r, 1).value = label;
    s.getCell(r, 2).value = inn.count; s.getCell(r, 3).value = inn.amount;
    s.getCell(r, 4).value = out.count; s.getCell(r, 5).value = out.amount;
    tInC += inn.count; tInA += inn.amount; tOutC += out.count; tOutA += out.amount;
    r++;
  }
  s.getCell(r, 1).value = "รวมทุกธนาคาร"; bold(r, 1);
  s.getCell(r, 2).value = tInC; s.getCell(r, 3).value = round2(tInA);
  s.getCell(r, 4).value = tOutC; s.getCell(r, 5).value = round2(tOutA);
  for (let c = 2; c <= 5; c++) bold(r, c);

  // รายเดือนรวม (ทุกแบงก์บวกกัน)
  r += 3;
  s.getCell(r, 1).value = "รายเดือนรวมทุกธนาคาร"; bold(r, 1); r++;
  ["เดือน", "เงินเข้า (ครั้ง)", "เงินเข้า (บาท)", "เงินออก (ครั้ง)", "เงินออก (บาท)"].forEach((h, i) => { s.getCell(r, i + 1).value = h; bold(r, i + 1); });
  r++;
  const inMonths = monthlyAgg(allTxns, "in");
  const outMonths = monthlyAgg(allTxns, "out");
  const monthKeys = [...new Set([...inMonths, ...outMonths].map((m) => m.key))].sort();
  const inByKey = new Map(inMonths.map((m) => [m.key, m]));
  const outByKey = new Map(outMonths.map((m) => [m.key, m]));
  for (const k of monthKeys) {
    const im = inByKey.get(k);
    const om = outByKey.get(k);
    s.getCell(r, 1).value = (im ?? om)!.label;
    s.getCell(r, 2).value = im?.count ?? 0; s.getCell(r, 3).value = im?.amount ?? 0;
    s.getCell(r, 4).value = om?.count ?? 0; s.getCell(r, 5).value = om?.amount ?? 0;
    r++;
  }

  // ===== 1 ชีต/ธนาคาร =====
  const used = new Set<string>();
  for (const label of bankLabels) {
    const txns = input.banks[label] ?? [];
    const ws = wb.addWorksheet(safeSheetName(label, used));
    ws.columns = [{ width: 44 }, { width: 16 }, { width: 18 }];
    const B = (row: number, col: number) => { ws.getCell(row, col).font = { bold: true }; };
    let y = 1;
    ws.getCell(y, 1).value = `สรุปสเตทเมนต์ — ${label}`; ws.getCell(y, 1).font = { bold: true, size: 13 }; y += 2;

    // หัว
    const inT = totalsOf(txns, "in");
    const outT = totalsOf(txns, "out");
    ws.getCell(y, 1).value = "ช่วงเวลา"; B(y, 1); ws.getCell(y, 2).value = periodOf(txns); y++;
    ws.getCell(y, 1).value = "รวมเงินเข้า"; B(y, 1); ws.getCell(y, 2).value = inT.count; ws.getCell(y, 3).value = inT.amount; y++;
    ws.getCell(y, 1).value = "รวมเงินออก"; B(y, 1); ws.getCell(y, 2).value = outT.count; ws.getCell(y, 3).value = outT.amount; y += 2;

    // [1] เงินเข้าแยกรายเดือน
    y = section(ws, y, "[1] เงินเข้าแยกรายเดือน", ["เดือน", "จำนวนรายการ", "เงินเข้า (บาท)"], monthlyAgg(txns, "in").map((m) => [m.label, m.count, m.amount]), ["รวม", inT.count, inT.amount]);
    // [2] กองคนโอนเข้า
    const pin = partyAgg(txns, "in");
    y = section(ws, y, "[2] กองคนโอนเข้า (≥2 ครั้ง) เรียงมาก→น้อย", ["ผู้โอน/เลขอ้างอิง", "จำนวนครั้ง", "ยอดรวม (บาท)"],
      [...pin.groups.map((g) => [g.party, g.count, g.amount] as (string | number)[]), ...(pin.others ? [[pin.others.party, pin.others.count, pin.others.amount] as (string | number)[]] : [])]);
    // [3] เงินออกแยกรายเดือน
    y = section(ws, y, "[3] เงินออกแยกรายเดือน", ["เดือน", "จำนวนรายการ", "เงินออก (บาท)"], monthlyAgg(txns, "out").map((m) => [m.label, m.count, m.amount]), ["รวม", outT.count, outT.amount]);
    // [4] กองคนโอนออก
    const pout = partyAgg(txns, "out");
    y = section(ws, y, "[4] กองคนโอนออก (≥2 ครั้ง) เรียงมาก→น้อย", ["ผู้รับ/เลขอ้างอิง", "จำนวนครั้ง", "ยอดรวม (บาท)"],
      [...pout.groups.map((g) => [g.party, g.count, g.amount] as (string | number)[]), ...(pout.others ? [[pout.others.party, pout.others.count, pout.others.amount] as (string | number)[]] : [])]);
  }

  // ===== _data ซ่อน =====
  const d = wb.addWorksheet(DATA_SHEET, { state: "veryHidden" });
  d.addRow(DATA_HEADER as unknown as string[]);
  for (const label of bankLabels) {
    for (const t of input.banks[label] ?? []) {
      d.addRow([label, t.date ?? "", t.description ?? "", t.counterparty_name ?? "", t.counterparty_account_no ?? "", t.direction ?? "", typeof t.amount === "number" ? t.amount : ""]);
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/** เขียน 1 เซกชัน (หัวข้อ + header + rows + แถวรวม option) → คืนเลข row ถัดไป (เว้น 1 บรรทัด) */
function section(ws: ExcelJS.Worksheet, startRow: number, title: string, header: string[], rows: (string | number)[][], totalRow?: (string | number)[]): number {
  let y = startRow;
  ws.getCell(y, 1).value = title; ws.getCell(y, 1).font = { bold: true }; y++;
  header.forEach((h, i) => { ws.getCell(y, i + 1).value = h; ws.getCell(y, i + 1).font = { bold: true }; }); y++;
  for (const row of rows) { row.forEach((v, i) => { ws.getCell(y, i + 1).value = v; }); y++; }
  if (totalRow) { totalRow.forEach((v, i) => { ws.getCell(y, i + 1).value = v; ws.getCell(y, i + 1).font = { bold: true }; }); y++; }
  return y + 1;
}

/** อ่านกอง AlbumStore กลับจากชีตซ่อน _data · ไม่มี/พัง → กองว่าง */
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
    // map header → column index (รองรับทั้งเลย์เอาต์เก่า 6 คอลัมน์ และใหม่ 7 คอลัมน์ที่มี account_no)
    const idx: Record<string, number> = {};
    const headerRow = d.getRow(1);
    headerRow.eachCell({ includeEmpty: false }, (c, ci) => { const k = str(c.value); if (k) idx[k] = ci; });
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
    return { v: 2, banks };
  } catch {
    return emptyAlbum();
  }
}
