/**
 * แปลงไฟล์สเตทเมนต์ Excel/CSV → ชุดข้อความตาราง (TSV-ish) เพื่อป้อนให้ AI อ่านทีละชุด
 *   OpenAI vision อ่าน xlsx/csv ตรง ๆ ไม่ได้ → ต้อง flatten เป็นข้อความก่อน (แล้วส่งเป็น text prompt)
 *
 * ★★★ 2026-08-12 (แก้บั๊ก A) — เดิมแปลงทั้งไฟล์เป็นข้อความก้อนเดียวแล้วตัดทิ้งเงียบ ๆ ที่ 4,000 แถว/
 *   200,000 ตัวอักษร ก่อนส่งเข้า AI ครั้งเดียวจบ (ไม่มี chunk) — ไฟล์ใหญ่จริง (เช่นรายงานแพลตฟอร์มขายที่มี
 *   หลายพันแถว) จะโดนตัดข้อมูลหายไปเงียบ ๆ ตั้งแต่ขั้นนี้ และต่อให้ผ่านขั้นนี้มา AI ตอบ JSON ยาวขนาดนั้นไม่ทัน
 *   (token หมดกลางคัน) ก็ parse ไม่ผ่านอยู่ดี — ตอนนี้เปลี่ยนมาแบ่งเป็น "ชุด" (chunk) แล้วส่งให้
 *   `statement-extract.ts::extractStatementFromTextChunks` ยิง AI หลายชุดแทน (ดูคอมเมนต์ที่นั่น)
 *
 * ★ pure-ish: รับ Buffer → คืนชุดข้อความ (exceljs อ่านใน memory ไม่แตะ network)
 * ★ ยังมีเพดานรวมทั้งไฟล์อยู่ (กันไฟล์ผิดปกติ/ใหญ่จนควบคุมเวลา-ค่าใช้จ่ายไม่ได้) แต่สูงกว่าเดิมมาก และ
 *   ★ ต้องคืนค่า meta ให้ผู้ใช้เห็นว่าถูกตัดจริงไหม (ไม่ใช่เงียบเหมือนเดิม)
 * ★ PDPA: ไม่ log เนื้อไฟล์
 */
import ExcelJS from "exceljs";

/** เพดานจำนวนแถวรวมทั้งไฟล์ (กันไฟล์ใหญ่ผิดปกติหลุดมือทั้งระบบ) — สูงกว่าเพดานเดิม (4,000) ถึง 10 เท่า */
export const MAX_TOTAL_ROWS = 40_000;
/** จำนวนแถวเป้าหมายต่อชุดที่ส่ง AI (กัน request เดียวยาวเกิน token/เวลา) */
const CHUNK_ROW_TARGET = 700;
/** อักขระต่อชุด (เผื่อบางแถวยาวผิดปกติ ก็ยังตัดชุดให้พอดีได้ ไม่รอให้ครบ CHUNK_ROW_TARGET) */
const CHUNK_CHAR_BUDGET = 45_000;
/** จำนวนชุดสูงสุดต่อไฟล์ (24×700 ≈ 16,800 แถว เป็นเพดานจริงถ้าแถวสั้น — คุมค่าใช้จ่าย/เวลารวมของ 1 คำขอ) */
export const MAX_CHUNKS = 24;

/** ผลการแปลงไฟล์ → ชุดข้อความ พร้อม meta ว่าตัดข้อมูลทิ้งไปหรือไม่ (แก้บั๊ก D — ไม่ตัดเงียบอีกต่อไป) */
export type ParsedStatementRows = {
  /** แต่ละชุดคือหลายแถวรวมกัน (คั่นบรรทัด) พร้อมส่งเข้า AI ทีละก้อน */
  chunks: string[];
  /** จำนวนแถวทั้งหมดที่มีในไฟล์ (หลังข้ามแถวว่าง) */
  totalRows: number;
  /** จำนวนแถวที่ถูกนำไปประมวลผลจริง (น้อยกว่า totalRows ถ้าเกินเพดาน) */
  includedRows: number;
  /** true = มีแถวถูกตัดทิ้งเพราะไฟล์ใหญ่เกินเพดาน (MAX_TOTAL_ROWS หรือ MAX_CHUNKS) */
  truncated: boolean;
};

/** cell value ของ exceljs → string อ่านง่าย (รองรับ date/number/formula/rich text) */
function cellToText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) {
    // เก็บเป็น YYYY-MM-DD (ตัดเวลา) — exceljs คืน Date เป็น UTC ของค่าที่เห็นในเซลล์
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // formula cell → เอาผลลัพธ์ · rich text → รวม text · hyperlink → text
    if ("result" in o) return cellToText(o.result);
    if ("text" in o) return String(o.text ?? "");
    if (Array.isArray((o as { richText?: unknown }).richText)) {
      return (o as { richText: { text?: string }[] }).richText.map((r) => r.text ?? "").join("");
    }
    return "";
  }
  return String(v);
}

/**
 * แบ่ง lines → ชุด (chunk) ตามเพดานแถว/อักขระต่อชุด + เพดานรวม/จำนวนชุดสูงสุด
 *   คืน meta บอกว่าตัดข้อมูลทิ้งไปเท่าไหร่ (ไม่ตัดเงียบเหมือนโค้ดเดิม)
 */
function chunkLines(lines: string[]): ParsedStatementRows {
  const totalRows = lines.length;
  const capped = lines.slice(0, MAX_TOTAL_ROWS);
  const chunks: string[] = [];
  let cur: string[] = [];
  let curChars = 0;
  let includedRows = 0;

  for (const line of capped) {
    if (chunks.length >= MAX_CHUNKS) break;
    const lineChars = line.length + 1;
    if (cur.length >= CHUNK_ROW_TARGET || (cur.length > 0 && curChars + lineChars > CHUNK_CHAR_BUDGET)) {
      chunks.push(cur.join("\n"));
      includedRows += cur.length;
      cur = [];
      curChars = 0;
      if (chunks.length >= MAX_CHUNKS) break;
    }
    cur.push(line);
    curChars += lineChars;
  }
  if (cur.length > 0 && chunks.length < MAX_CHUNKS) {
    chunks.push(cur.join("\n"));
    includedRows += cur.length;
  }

  return { chunks, totalRows, includedRows, truncated: includedRows < totalRows };
}

/**
 * แปลง Excel (.xlsx/.xls) buffer → ชุดข้อความตาราง (คั่นด้วย tab ต่อเซลล์, ขึ้นบรรทัดใหม่ต่อแถว)
 *   ทุกชีทต่อกัน (มี header ชื่อชีท) · ข้ามแถวว่างล้วน · แบ่งเป็นชุดตามเพดาน
 */
export async function excelBufferToRows(buf: Buffer): Promise<ParsedStatementRows> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const lines: string[] = [];

  wb.eachSheet((sheet) => {
    const sheetLines: string[] = [];
    sheet.eachRow((row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : []; // index 0 ว่างเสมอ
      const cells = values.map((c) => cellToText(c).replace(/[\t\r\n]+/g, " ").trim());
      if (cells.every((c) => c === "")) return; // ข้ามแถวว่าง
      sheetLines.push(cells.join("\t"));
    });
    if (sheetLines.length > 0) {
      lines.push(`# ชีท: ${sheet.name}`, ...sheetLines);
    }
  });

  return chunkLines(lines);
}

/**
 * แปลง CSV buffer → ชุดข้อความ (decode utf-8, แบ่งเป็นชุดตามเพดาน)
 *   ★ ไม่ parse โครงสร้าง CSV (ปล่อยให้ AI อ่านตาราง) — แค่ decode + แบ่งบรรทัด
 */
export function csvBufferToRows(buf: Buffer): ParsedStatementRows {
  const raw = buf.toString("utf-8").replace(/^﻿/, ""); // ตัด BOM
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  return chunkLines(lines);
}
