/**
 * statement-summary-csv.ts — สร้าง "สรุปสเตทเมนต์" 3 ส่วนในไฟล์ CSV เดียว
 *   (port logic จาก NOVA Sales: monthly-inflow + sender-inflow — ให้ output เหมือนกันเป๊ะ)
 *
 * 3 ส่วน (ตามตัวอย่างที่ลูกค้าต้องการ):
 *   1) เงินเข้าแยกรายเดือน   — เดือน (ไทย พ.ศ.), ยอดเข้ารวม, จำนวนรายการ + แถวรวมทุกเดือน
 *   2) เงินเข้าแยกตามผู้โอน   — ผู้โอน (จับกลุ่มด้วยเลขบัญชี/รายละเอียด), จำนวนครั้ง, ยอดรวม (เรียงมาก→น้อย)
 *   3) รายการทั้งหมด         — วันที่, ธนาคาร, คำอธิบาย, ทิศทาง(เข้า/ออก), จำนวน
 *
 * มติทีม (เหมือน NOVA Sales): โค้ดจัดกลุ่ม+รวมยอดเท่านั้น (parser เป็นคนอ่านรายการมาให้)
 * ★ ตัวเลข: ไม่มีลูกน้ำคั่นพัน + ตัดศูนย์ท้ายทศนิยม (15300, 72912.5, 262.13) — ตรงฟอร์แมตตัวอย่าง
 */
import type { StatementTxn } from "@/lib/accounting/statement-analyze";

function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** ฟอร์แมตเลขแบบตัวอย่าง: ไม่มี comma, ตัด 0 ท้าย (72912.50→72912.5, 15300.00→15300) */
function num(x: number): string {
  return String(round2(x));
}

const TH_MON_ABBR = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** 'YYYY-MM' → 'ก.ค. 2569' (พ.ศ. = ค.ศ.+543) */
function monthLabel(key: string): string {
  const [ys, ms] = key.split("-");
  const y = Number(ys), m = Number(ms);
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isFinite(y)) return key;
  return `${TH_MON_ABBR[m - 1]} ${y + 543}`;
}

function monthKey(iso: string | null): string | null {
  if (typeof iso !== "string" || iso.length < 7) return null;
  const k = iso.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(k) ? k : null;
}

// ---- ผู้โอน (sender grouping) — port จาก NOVA Sales sender-inflow.ts ----
const UNNAMED_LABEL = "ไม่ระบุชื่อ";
const UNNAMED_KEY = " __unnamed__";
const GENERIC_WORDS =
  /transfer|deposit|payment|interest|received|withdraw|\bin\b|\bout\b|\bfrom\b|\bto\b|\btr\b|\bfr\b|bank|prompt\s?pay|msisdn|natid|โอนเงิน|เงินโอน|รับโอน|รับเงินโอน|พร้อมเพย์|ดอกเบี้ย|โบนัส|ค่าธรรมเนียม|ฝากเงิน|ถอนเงิน|โอนออก|โอนเข้า|เข้าบัญชี/gi;

/** ตัด "เลขอ้างอิงธุรกรรม" ที่ไม่ซ้ำกันออก เพื่อให้จ่ายร้านเดียวกันรวมเป็นกองเดียว
 *   เช่น "ชำระ Ref X4KGD SHOPEEPAY" / "Ref XRRX4 SHOPEEPAY" → รวมเป็น "ชำระ SHOPEEPAY" กองเดียว
 *   (Ref code = X + ตัวอักษร/เลขคละ 4-8 ตัว · ตัดเฉพาะเมื่อขึ้นต้นด้วย ref/รหัสอ้างอิง) */
function stripTxnRef(s: string): string {
  return s
    .replace(/\b(ref(?:erence)?(?:\s*(?:no|number))?|รหัสอ้างอิง|เลขที่อ้างอิง)\.?\s*[:#]?\s*[a-z0-9]{3,}/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function analyzeSender(description: string): { key: string; unnamed: boolean } {
  const raw = stripTxnRef((description ?? "").replace(/\s+/g, " ").trim());
  if (!raw) return { key: "", unnamed: true };
  const nameCore = raw
    .toLowerCase()
    .replace(GENERIC_WORDS, " ")
    .replace(/[0-9]+/g, " ")
    .replace(/[^\p{L}]+/gu, "");
  if (nameCore.length >= 2) {
    const nameKey = raw.toLowerCase().replace(/\d{4,}/g, " ").replace(/[\s\-_.,/#*:;()[\]"']+/g, " ").trim();
    return { key: "name:" + nameKey, unnamed: false };
  }
  return { key: "ref:" + raw.toLowerCase(), unnamed: false };
}

type SenderRow = { name: string; count: number; total: number };
function buildPartyFlow(txns: StatementTxn[], dir: "in" | "out"): SenderRow[] {
  const byKey = new Map<string, { name: string; count: number; total: number }>();
  for (const t of txns) {
    if (t.direction !== dir || t.amount == null) continue;
    const { key, unnamed } = analyzeSender(t.description ?? "");
    const groupKey = unnamed ? UNNAMED_KEY : key;
    const display = unnamed ? UNNAMED_LABEL : stripTxnRef((t.description ?? "").replace(/\s+/g, " ").trim());
    const b = byKey.get(groupKey) ?? { name: display, count: 0, total: 0 };
    b.total += t.amount;
    b.count += 1;
    byKey.set(groupKey, b);
  }
  return Array.from(byKey.values())
    .map((b) => ({ name: b.name, count: b.count, total: round2(b.total) }))
    .sort((a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name, "th"));
}

type MonthRow = { key: string; label: string; total: number; count: number };
function buildMonthlyFlow(txns: StatementTxn[], dir: "in" | "out"): MonthRow[] {
  const byMonth = new Map<string, { total: number; count: number }>();
  for (const t of txns) {
    if (t.direction !== dir || t.amount == null) continue;
    const k = monthKey(t.date);
    if (k === null) continue;
    const b = byMonth.get(k) ?? { total: 0, count: 0 };
    b.total += t.amount;
    b.count += 1;
    byMonth.set(k, b);
  }
  return Array.from(byMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => ({ key: k, label: monthLabel(k), total: round2(v.total), count: v.count }));
}

/** escape 1 cell ตามมาตรฐาน CSV */
function cell(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function row(cells: (string | number)[]): string {
  return cells.map(cell).join(",");
}

/**
 * สร้างข้อความ CSV สรุป 3 ส่วน (ยังไม่เติม BOM — ผู้เรียกเติมตอนเขียนไฟล์)
 *   @param txns  รายการธุรกรรมทั้งหมด (เข้า/ออก)
 *   @param bankLabel ชื่อธนาคารไทยมาตรฐาน (คอลัมน์ "ธนาคาร" ในส่วนรายการทั้งหมด)
 */
export function buildStatementSummaryCsv(txns: StatementTxn[], bankLabel: string): string {
  const lines: string[] = [];

  /** ส่วน "แยกรายเดือน" (เข้า/ออก) + แถวรวม */
  const pushMonthly = (title: string, amtCol: string, dir: "in" | "out") => {
    const months = buildMonthlyFlow(txns, dir);
    lines.push(title);
    lines.push(row(["เดือน", amtCol, "จำนวนรายการ"]));
    let tot = 0, cnt = 0;
    for (const m of months) { lines.push(row([m.label, num(m.total), m.count])); tot += m.total; cnt += m.count; }
    lines.push(row(["รวมทุกเดือน", num(round2(tot)), cnt]));
    lines.push("");
  };
  /** ส่วน "แยกตามคู่ค้า" (ผู้โอน/ผู้รับ) */
  const pushParty = (title: string, partyCol: string, dir: "in" | "out") => {
    lines.push(title);
    lines.push(row([partyCol, "จำนวนครั้ง", "ยอดรวม(บาท)"]));
    for (const s of buildPartyFlow(txns, dir)) lines.push(row([s.name, s.count, num(s.total)]));
    lines.push("");
  };

  // เงินเข้า (รายเดือน + ผู้โอน) — ★ คงรูปแบบเดิมที่ลูกค้าอนุมัติไว้
  pushMonthly("เงินเข้าแยกรายเดือน", "เงินเข้ารวม(บาท)", "in");
  pushParty("เงินเข้าแยกตามผู้โอน", "ผู้โอน", "in");
  // เงินออก (รายเดือน + ผู้รับ) — ★ เพิ่มใหม่: สเตทเมนต์ที่มีแต่รายจ่ายจะไม่ว่างเปล่าอีกต่อไป
  pushMonthly("เงินออกแยกรายเดือน", "เงินออกรวม(บาท)", "out");
  pushParty("เงินออกแยกตามผู้รับ", "ผู้รับ", "out");

  // รายการทั้งหมด (เรียงวันที่เก่า→ใหม่)
  lines.push("รายการทั้งหมด");
  lines.push(row(["วันที่", "ธนาคาร", "คำอธิบาย", "ทิศทาง", "จำนวน(บาท)"]));
  const sorted = [...txns].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const t of sorted) {
    if (t.amount == null) continue;
    lines.push(row([t.date ?? "", bankLabel, t.description ?? "", t.direction === "in" ? "เข้า" : "ออก", num(t.amount)]));
  }

  return lines.join("\r\n");
}
