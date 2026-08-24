/**
 * statement-cleanup.ts — parse "ไฟล์สรุปสเตทเมนต์เก่า" (CSV) กลับเป็นธุรกรรม เพื่อรวมเป็น Excel เดียว
 *   ใช้ครั้งเดียวโดย admin route (backfill) — ลบไฟล์เก่าหลังรวมสำเร็จ
 *   ★ logic pure (ทดสอบได้) — I/O OneDrive อยู่ที่ route
 *
 * รูปแบบไฟล์เก่า 3 ชนิด:
 *   - "<เวลา>-ผลอ่าน-statement.csv" (รูป v0) : ตารางแบน วันที่/รายละเอียด/คู่ค้า/ทิศทาง(in/out)/จำนวนเงิน · ไม่มีชื่อแบงก์
 *   - "สเตทเมนต์รวม <date>.csv" (รูป v1)       : ตารางแบนเหมือนกัน · ไม่มีชื่อแบงก์
 *   - "<ชื่อ> - สรุป.csv" (PDF deterministic)  : หลายเซกชัน · เซกชัน "รายการทั้งหมด" มีคอลัมน์ "ธนาคาร"
 */
import type { StatementTxn } from "@/lib/accounting/statement-analyze";

export type OldSummaryKind = "det" | "image" | "albumV1";

/**
 * จำแนกว่าไฟล์เป็น "ไฟล์สรุปเก่า" ที่ควรลบ+รวมใหม่ไหม — คืน kind หรือ null (ไม่ใช่ไฟล์สรุปเก่า)
 *   ★ กันชนไฟล์ที่ต้องเก็บ: ไฟล์รวมใหม่ (สรุปสเตทเมนต์.xlsx), วิเคราะห์รายรับ (prospect), ยอดขาย (platform), ไฟล์ต้นฉบับ
 */
export function classifyOldSummaryFile(name: string): OldSummaryKind | null {
  const n = name.replace(/^﻿/, "").trim();
  // เก็บไว้ (ไม่ใช่ของเก่า / คนละฟีเจอร์)
  if (/สรุปสเตทเมนต์\.xlsx$/i.test(n)) return null; // ไฟล์รวมใหม่
  if (/วิเคราะห์รายรับ/i.test(n)) return null; // prospect income (คนละฟีเจอร์)
  if (/ยอดขาย\.csv$/i.test(n)) return null; // platform report
  // ไฟล์สรุปเก่า (ลบ+รวมใหม่)
  if (/-ผลอ่าน-statement\.csv$/i.test(n)) return "image";
  if (/^สเตทเมนต์รวม .+\.csv$/i.test(n)) return "albumV1";
  if (/ - สรุป\.csv$/i.test(n)) return "det";
  return null;
}

/** parse CSV → grid ของ cell (รองรับ quote " ", escape "" , คั่นด้วย , และขึ้นบรรทัด \r\n/\n) */
export function parseCsvGrid(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(cell); cell = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** เลขไทย/ลูกน้ำ → number · null ถ้าไม่ใช่เลข */
function toNum(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number(v.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function toDir(v: string | undefined): "in" | "out" | null {
  const t = (v ?? "").trim().toLowerCase();
  if (t === "in" || t === "เข้า") return "in";
  if (t === "out" || t === "ออก") return "out";
  return null;
}

function mkTxn(o: Partial<StatementTxn>): StatementTxn {
  return {
    date: o.date ?? null,
    description: o.description ?? null,
    counterparty_name: o.counterparty_name ?? null,
    counterparty_account_no: o.counterparty_account_no ?? null,
    direction: o.direction ?? null,
    amount: o.amount ?? null,
  };
}

/** parse ตารางแบน (รูป v0/v1) : header วันที่/รายละเอียด/คู่ค้า/ทิศทาง(in/out)/จำนวนเงิน */
export function parseFlatStatementCsv(text: string): StatementTxn[] {
  const grid = parseCsvGrid(text);
  if (grid.length < 2) return [];
  // หา header row ที่มี "วันที่" (ข้ามบรรทัดจุดประสงค์ที่อาจอยู่ข้างบน)
  let h = grid.findIndex((r) => r.some((c) => c.trim() === "วันที่"));
  if (h < 0) return [];
  const header = grid[h].map((c) => c.trim());
  const col = (labelIncludes: string) => header.findIndex((c) => c.includes(labelIncludes));
  const iDate = col("วันที่"), iDesc = col("รายละเอียด"), iParty = col("คู่ค้า"), iDir = col("ทิศทาง"), iAmt = col("จำนวน");
  const out: StatementTxn[] = [];
  for (let r = h + 1; r < grid.length; r++) {
    const cells = grid[r];
    if (!cells || cells.every((c) => c.trim() === "")) continue;
    const date = iDate >= 0 ? cells[iDate]?.trim() || null : null;
    const amount = iAmt >= 0 ? toNum(cells[iAmt]) : null;
    const direction = iDir >= 0 ? toDir(cells[iDir]) : null;
    if (!date && amount == null) continue;
    out.push(mkTxn({
      date,
      description: iDesc >= 0 ? cells[iDesc]?.trim() || null : null,
      counterparty_name: iParty >= 0 ? cells[iParty]?.trim() || null : null,
      direction,
      amount,
    }));
  }
  return out;
}

/** parse "<ชื่อ> - สรุป.csv" (det) : เอาเซกชัน "รายการทั้งหมด" (วันที่/ธนาคาร/คำอธิบาย/ทิศทาง/จำนวน) */
export function parseDeterministicSummaryCsv(text: string): { bank: string | null; txns: StatementTxn[] } {
  const grid = parseCsvGrid(text);
  // หา header ของเซกชันรายการทั้งหมด (มีทั้ง "วันที่" และ "ธนาคาร")
  const h = grid.findIndex((r) => r.some((c) => c.trim() === "วันที่") && r.some((c) => c.trim() === "ธนาคาร"));
  if (h < 0) return { bank: null, txns: [] };
  const header = grid[h].map((c) => c.trim());
  const iDate = header.indexOf("วันที่");
  const iBank = header.indexOf("ธนาคาร");
  const iDesc = header.findIndex((c) => c.includes("คำอธิบาย") || c.includes("รายละเอียด"));
  const iDir = header.findIndex((c) => c.includes("ทิศทาง"));
  const iAmt = header.findIndex((c) => c.includes("จำนวน"));
  const txns: StatementTxn[] = [];
  let bank: string | null = null;
  for (let r = h + 1; r < grid.length; r++) {
    const cells = grid[r];
    if (!cells || cells.every((c) => c.trim() === "")) break; // จบเซกชันที่บรรทัดว่าง
    const date = iDate >= 0 ? cells[iDate]?.trim() || null : null;
    const amount = iAmt >= 0 ? toNum(cells[iAmt]) : null;
    if (!date && amount == null) continue;
    if (!bank && iBank >= 0 && cells[iBank]?.trim()) bank = cells[iBank].trim();
    txns.push(mkTxn({
      date,
      description: iDesc >= 0 ? cells[iDesc]?.trim() || null : null,
      direction: iDir >= 0 ? toDir(cells[iDir]) : null,
      amount,
    }));
  }
  return { bank, txns };
}

/** parse ไฟล์สรุปเก่าตาม kind → { bank, txns } (bank=null สำหรับรูป) */
export function parseOldSummary(kind: OldSummaryKind, text: string): { bank: string | null; txns: StatementTxn[] } {
  if (kind === "det") return parseDeterministicSummaryCsv(text);
  return { bank: null, txns: parseFlatStatementCsv(text) };
}
