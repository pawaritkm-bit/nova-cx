/**
 * read-table.ts — อ่าน Excel/CSV เป็นตาราง 2 มิติ + เลือกชีต/แถวหัวตารางอัตโนมัติ
 *   (port จาก NOVA Sales tabular-read.ts · CSV ใช้ parser ในตัวแทน papaparse)
 * ★ server-only · ไม่ log เนื้อไฟล์ · exceljs ใช้เฉพาะผลลัพธ์ (ไม่รัน macro)
 */
import ExcelJS from "exceljs";

export class SafeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeParseError";
  }
}

const HEADER_SCAN_ROWS = 15;

function normalizeCell(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function scoreHeaderRow(row: unknown[], keywords: string[]): number {
  if (!row || row.length === 0) return 0;
  const cells = row.map(normalizeCell).filter((c) => c !== "");
  if (cells.length === 0) return 0;
  let matched = 0;
  for (const kw of keywords) {
    if (cells.some((c) => c === kw || c.includes(kw))) matched += 1;
  }
  return matched;
}

export function detectHeaderRow(table: unknown[][], keywords: string[]): { headerIndex: number; score: number } {
  const limit = Math.min(table.length, HEADER_SCAN_ROWS);
  let bestIndex = 0, bestScore = 0;
  for (let i = 0; i < limit; i += 1) {
    const score = scoreHeaderRow(table[i], keywords);
    if (score > bestScore) { bestScore = score; bestIndex = i; }
  }
  return { headerIndex: bestIndex, score: bestScore };
}

export function selectDataTable(
  sheets: unknown[][][],
  keywords: string[],
  priorityNames: string[] = [],
  sheetNames: string[] = [],
): { headers: string[]; rows: unknown[][] } {
  if (sheets.length === 0) return { headers: [], rows: [] };
  const normalizedPriority = priorityNames.map((n) => n.toLowerCase());
  let best = { sheetIndex: 0, headerIndex: 0, score: -1, priority: false };
  sheets.forEach((table, sheetIndex) => {
    const { headerIndex, score } = detectHeaderRow(table, keywords);
    const name = (sheetNames[sheetIndex] ?? "").toLowerCase();
    const isPriority = normalizedPriority.some((p) => name.includes(p));
    const better = score > best.score || (score === best.score && isPriority && !best.priority);
    if (better) best = { sheetIndex, headerIndex, score, priority: isPriority };
  });
  const chosen = sheets[best.sheetIndex] ?? [];
  const headerIndex = best.score > 0 ? best.headerIndex : 0;
  const headerRow = chosen[headerIndex] ?? [];
  const headers = headerRow.map((cell) => String(cell ?? ""));
  const rows = chosen.slice(headerIndex + 1);
  return { headers, rows };
}

/** CSV parser ในตัว (รองรับ quoted field + "" escape) → ตาราง 2 มิติ */
function parseCsv(content: string): unknown[][] {
  const text = content.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

function cellToRaw(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value;
  const obj = value as unknown as Record<string, unknown>;
  if ("result" in obj) return cellToRaw(obj.result as ExcelJS.CellValue);
  if ("text" in obj) return cellToRaw(obj.text as ExcelJS.CellValue);
  if ("richText" in obj && Array.isArray(obj.richText)) {
    return (obj.richText as Array<{ text?: string }>).map((r) => r.text ?? "").join("");
  }
  return null;
}

function readSheet(sheet: ExcelJS.Worksheet): unknown[][] {
  const table: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as ExcelJS.CellValue[];
    table.push(values.slice(1).map((cell) => cellToRaw(cell)));
  });
  return table;
}

async function parseExcelSheets(buffer: ArrayBuffer): Promise<{ tables: unknown[][][]; names: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return {
    tables: wb.worksheets.map((s) => readSheet(s)),
    names: wb.worksheets.map((s) => s.name ?? ""),
  };
}

/** อ่านไฟล์ Excel/CSV + เลือกชีต/แถวหัวตาราง → headers/rows */
export async function readAndSelectTable(
  file: { ext: string; buffer: ArrayBuffer },
  keywords: string[],
  priorityNames: string[] = [],
): Promise<{ headers: string[]; rows: unknown[][] }> {
  if (file.ext === "csv") {
    const table = parseCsv(new TextDecoder("utf-8").decode(new Uint8Array(file.buffer)));
    return selectDataTable([table], keywords, priorityNames, ["csv"]);
  }
  const { tables, names } = await parseExcelSheets(file.buffer);
  return selectDataTable(tables, keywords, priorityNames, names);
}
