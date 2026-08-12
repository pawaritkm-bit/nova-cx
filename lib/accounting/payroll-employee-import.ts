/**
 * นำเข้าทะเบียนพนักงานเป็นชุด (Excel/CSV) — wishlist ข้อ 2
 *
 * ★ ต่างจาก statement-parse.ts (แปลงไฟล์เป็น "ข้อความ" ให้ AI อ่านเดารูปแบบเอง) — ไฟล์นำเข้าพนักงานมี
 *   คอลัมน์คงที่รู้ล่วงหน้า (ไม่ต้องเดา/ไม่ต้องใช้ AI) จึง parse ตรงเป็นแถว/คอลัมน์แบบ deterministic ได้เลย
 *   เร็วกว่า ไม่มีค่าใช้จ่าย AI ไม่มีความเสี่ยงอ่านผิด
 * ★ pure-ish: parse* รับ Buffer → คืนแถวดิบ (ไม่แตะ DB) — ผู้เรียก (server action) เป็นคนวน
 *   `validatePayrollEmployeeInput`/`upsertEmployee` ต่อแถวเอง (ไม่เขียน validate ซ้ำที่นี่)
 * ★ PDPA: ไม่ log เนื้อไฟล์/ชื่อ/เลขบัตร
 */
import ExcelJS from "exceljs";
import type { PayrollEmployeeInput } from "@/lib/accounting/payroll-employees";

/** เพดานจำนวนแถวต่อไฟล์ (กันไฟล์ผิดปกติทำให้ import ค้าง/มีค่าใช้จ่าย DB สูงเกินควร) */
// ★ 2026-08-12 (พบจาก independent review) — ลดจาก 2000 เหลือ 1000 (ยังเกินพอสำหรับจำนวนพนักงานของ
//   ลูกค้าจริง) เพื่อคุม worst-case wall-clock ของ bulkImportEmployeesAction ให้อยู่ในเพดาน maxDuration
//   ของ page (60s, ดู page.tsx) แน่นอน — ที่ concurrency 10 (actions.ts) 1000 แถว ≈ 100 รอบ ไม่เกิน ~20s จริง
export const MAX_IMPORT_ROWS = 1000;

/** หัวคอลัมน์ที่รองรับ (ไทย, ยืดหยุ่นเรื่องช่องว่าง/ตัวพิมพ์) → คีย์ภายใน */
const HEADER_ALIASES: Record<string, keyof RawEmployeeRow> = {
  "รหัสพนักงาน": "employeeCode",
  "ชื่อ-นามสกุล": "fullName",
  "ชื่อนามสกุล": "fullName",
  "ชื่อพนักงาน": "fullName",
  "ชื่อ": "fullName",
  "เลขบัตรประชาชน": "idCardNo",
  "เลขประจำตัวประชาชน": "idCardNo",
  "เลขพาสปอร์ต": "passportNo",
  "เลข passport": "passportNo",
  "passport": "passportNo",
  "ตำแหน่ง": "position",
  "เงินเดือน": "baseSalary",
  "เงินเดือนฐาน": "baseSalary",
  "วันที่เริ่มงาน": "startDate",
  "วันเริ่มงาน": "startDate",
  "วันที่ลาออก": "resignDate",
};

/** 1 แถวดิบจากไฟล์ (ค่าเป็น string ล้วน ก่อน validate/แปลงชนิด) */
export type RawEmployeeRow = {
  employeeCode: string;
  fullName: string;
  idCardNo: string;
  passportNo: string;
  position: string;
  baseSalary: string;
  startDate: string;
  resignDate: string;
};

/** ผลแปลงไฟล์ → แถวดิบ + meta (จำนวนแถวทั้งหมด/ที่ตัดทิ้งถ้าเกินเพดาน) */
export type ParsedEmployeeRows = {
  rows: RawEmployeeRow[];
  /** ★ 2026-08-12 (แก้บั๊ก, พบจาก independent review) — เลขแถวจริงในไฟล์ต้นฉบับของ rows[i] แต่ละตัว
   *   (นับรวมหัวคอลัมน์เป็นแถวที่ 1) — เก็บไว้ก่อนกรองแถวว่างทิ้ง ไม่ใช่คำนวณจาก index ของ array ที่กรอง
   *   แล้ว (ถ้ามีแถวว่างคั่นในไฟล์ เลขแถวที่โชว์ผู้ใช้จะเลื่อนผิดจากไฟล์จริงถ้าคำนวณจาก index เฉย ๆ) */
  sourceRowNumbers: number[];
  totalRows: number;
  truncated: boolean;
};

function emptyRawRow(): RawEmployeeRow {
  return { employeeCode: "", fullName: "", idCardNo: "", passportNo: "", position: "", baseSalary: "", startDate: "", resignDate: "" };
}

/** normalize หัวคอลัมน์ (trim + ตัวพิมพ์เล็ก) เทียบกับ HEADER_ALIASES */
function resolveHeaderKey(raw: string): keyof RawEmployeeRow | null {
  const norm = raw.trim().toLowerCase();
  for (const [alias, key] of Object.entries(HEADER_ALIASES)) {
    if (alias.toLowerCase() === norm) return key;
  }
  return null;
}

/** แปลงแถว 2 มิติ (header row + data rows เป็น string[][]) → RawEmployeeRow[] ตาม header ที่จับคู่ได้ */
function rowsFromTable(table: string[][]): ParsedEmployeeRows {
  if (table.length === 0) return { rows: [], sourceRowNumbers: [], totalRows: 0, truncated: false };
  const header = table[0];
  const keyByCol = header.map((h) => resolveHeaderKey(h));

  // ★ ผูกเลขแถวจริง (idx ในไฟล์ + 2 — แถว 1 คือหัวคอลัมน์) ไว้ก่อนกรองแถวว่างทิ้ง
  const dataRows = table
    .slice(1)
    .map((r, idx) => ({ r, sourceRowNumber: idx + 2 }))
    .filter(({ r }) => r.some((c) => c.trim() !== ""));
  const totalRows = dataRows.length;
  const capped = dataRows.slice(0, MAX_IMPORT_ROWS);

  const rows: RawEmployeeRow[] = capped.map(({ r }) => {
    const row = emptyRawRow();
    for (let i = 0; i < keyByCol.length; i++) {
      const key = keyByCol[i];
      if (key) row[key] = (r[i] ?? "").trim();
    }
    return row;
  });
  const sourceRowNumbers = capped.map(({ sourceRowNumber }) => sourceRowNumber);

  return { rows, sourceRowNumbers, totalRows, truncated: capped.length < totalRows };
}

/** cell value ของ exceljs → string (รองรับ date/number/formula/rich text — เหมือน statement-parse.ts) */
function cellToText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return cellToText(o.result);
    if ("text" in o) return String(o.text ?? "");
    if (Array.isArray((o as { richText?: unknown }).richText)) {
      return (o as { richText: { text?: string }[] }).richText.map((r) => r.text ?? "").join("");
    }
    return "";
  }
  return String(v);
}

/** แปลง Excel (.xlsx เท่านั้น — ExcelJS's xlsx.load ไม่รองรับ .xls รุ่นเก่า) buffer → แถวดิบ (อ่านชีทแรก) */
export async function excelBufferToEmployeeRows(buf: Buffer): Promise<ParsedEmployeeRows> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { rows: [], sourceRowNumbers: [], totalRows: 0, truncated: false };

  const table: string[][] = [];
  sheet.eachRow((row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    table.push(values.map((c) => cellToText(c)));
  });
  return rowsFromTable(table);
}

/** แยก 1 บรรทัด CSV เป็นคอลัมน์ (รองรับ quote ครอบ field ที่มี comma/quote — RFC 4180-ish) */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** แปลง CSV buffer → แถวดิบ */
export function csvBufferToEmployeeRows(buf: Buffer): ParsedEmployeeRows {
  const raw = buf.toString("utf-8").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  return rowsFromTable(lines.map(splitCsvLine));
}

/** แปลงแถวดิบ 1 แถว → PayrollEmployeeInput (ยังไม่ validate — validatePayrollEmployeeInput ทำต่อ) */
export function rawRowToEmployeeInput(row: RawEmployeeRow): PayrollEmployeeInput {
  return {
    employeeCode: row.employeeCode || undefined,
    fullName: row.fullName,
    idCardNo: row.idCardNo || undefined,
    passportNo: row.passportNo || undefined,
    position: row.position || undefined,
    baseSalary: row.baseSalary.replace(/,/g, "").trim(),
    startDate: row.startDate || undefined,
    resignDate: row.resignDate || undefined,
  };
}

/** สร้างไฟล์เทมเพลต .xlsx (หัวคอลัมน์ + 1 แถวตัวอย่าง) ให้ดาวน์โหลดก่อนนำเข้าจริง */
export async function buildEmployeeImportTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  wb.created = new Date();
  const ws = wb.addWorksheet("พนักงาน");
  const headers = ["รหัสพนักงาน", "ชื่อ-นามสกุล", "เลขบัตรประชาชน", "เลขพาสปอร์ต", "ตำแหน่ง", "เงินเดือน", "วันที่เริ่มงาน", "วันที่ลาออก"];
  ws.addRow(headers).font = { bold: true };
  ws.addRow(["EMP001", "สมชาย ใจดี", "1234567890123", "", "พนักงานบัญชี", "20000", "2026-01-01", ""]);
  ws.columns = headers.map((h) => ({ width: Math.max(h.length + 4, 14) }));
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
