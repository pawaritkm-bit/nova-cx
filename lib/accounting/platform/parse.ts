/**
 * parse.ts — อ่านรายงานแพลตฟอร์ม (Shopee/TikTok/Lazada/CSV) ด้วยโค้ดจริง → 4 ตัวเลข + รายเดือน
 *   (port logic จาก NOVA Sales parse-file.ts ให้ output ตรงกัน)
 * ★ server-only · ไม่ log เนื้อไฟล์/ตัวเลข
 */
import {
  SALES_SHEET_PRIORITY_NAMES,
  isShopeeDetailedReport,
  isTikTokReport,
  mapColumns,
  mapShopeeColumns,
  mapShopeeDateColumns,
  mapTikTokColumns,
  mapTikTokDateColumns,
  parseMonthKey,
  salesHeaderKeywords,
  type DateColumnSpec,
  type MultiColumnMapping,
} from "./column-mapping";
import { readAndSelectTable, SafeParseError } from "./read-table";
import {
  EXTRACTED_FIELDS,
  FIGURE_SOURCE,
  PLATFORM,
  PLATFORM_LABELS,
  UNKNOWN_MONTH_KEY,
  type ExtractedFigures,
  type FigureField,
  type FileExtraction,
  type MonthlyPlatformFigures,
  type Platform,
} from "./types";

const MAX_ROWS = 200_000;

export function parseNumeric(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text === "") return null;
  const isNegative = /^\(.*\)$/.test(text);
  if (isNegative) text = text.slice(1, -1);
  const cleaned = text.replace(/[,\s฿$]/g, "").replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return isNegative ? -Math.abs(value) : value;
}

function sumColumn(rows: unknown[][], columnIndex: number, useAbsolute: boolean): number {
  if (columnIndex < 0) return 0;
  let total = 0;
  for (const row of rows) {
    const v = parseNumeric(row[columnIndex]);
    if (v === null) continue;
    total += useAbsolute ? Math.abs(v) : v;
  }
  return total;
}

function sumColumns(rows: unknown[][], indices: number[], useAbsolute: boolean): number {
  if (indices.length === 0) return 0;
  let total = 0;
  for (const row of rows) for (const idx of indices) {
    const v = parseNumeric(row[idx]);
    if (v !== null) total += v;
  }
  return useAbsolute ? Math.abs(total) : total;
}

function sumRowColumns(row: unknown[], indices: number[]): number {
  let total = 0;
  for (const idx of indices) {
    const v = parseNumeric(row[idx]);
    if (v !== null) total += v;
  }
  return total;
}

function monthKeyForRow(row: unknown[], dateCols: DateColumnSpec): string {
  if (dateCols.paidIndex >= 0) {
    const paid = parseMonthKey(row[dateCols.paidIndex]);
    if (paid !== null) return paid;
  }
  if (dateCols.orderedIndex >= 0) {
    const ordered = parseMonthKey(row[dateCols.orderedIndex]);
    if (ordered !== null) return ordered;
  }
  return UNKNOWN_MONTH_KEY;
}

function sortMonthly(a: MonthlyPlatformFigures, b: MonthlyPlatformFigures): number {
  if (a.month === UNKNOWN_MONTH_KEY) return b.month === UNKNOWN_MONTH_KEY ? 0 : 1;
  if (b.month === UNKNOWN_MONTH_KEY) return -1;
  return a.month.localeCompare(b.month);
}

function groupMonthly(dataRows: unknown[][], cols: MultiColumnMapping, dateCols: DateColumnSpec): MonthlyPlatformFigures[] {
  const byMonth = new Map<string, { grossSales: number; platformFee: number; shippingFee: number; discount: number }>();
  for (const row of dataRows) {
    const key = monthKeyForRow(row, dateCols);
    const acc = byMonth.get(key) ?? { grossSales: 0, platformFee: 0, shippingFee: 0, discount: 0 };
    acc.grossSales += sumRowColumns(row, cols.grossSales.indices);
    acc.platformFee += sumRowColumns(row, cols.platformFee.indices);
    acc.shippingFee += sumRowColumns(row, cols.shippingFee.indices);
    acc.discount += sumRowColumns(row, cols.discount.indices);
    byMonth.set(key, acc);
  }
  return Array.from(byMonth.entries())
    .map(([month, acc]) => ({
      month,
      grossSales: acc.grossSales,
      platformFee: Math.abs(acc.platformFee),
      shippingFee: Math.abs(acc.shippingFee),
      discount: Math.abs(acc.discount),
    }))
    .sort(sortMonthly);
}

function extractShopeeDetailed(headers: string[], dataRows: unknown[][]): { figures: ExtractedFigures; missingFields: FigureField[] } {
  const cols = mapShopeeColumns(headers);
  const dateCols = mapShopeeDateColumns(headers);
  const missingFields = EXTRACTED_FIELDS.map((f) => f.key).filter((key) => cols[key].indices.length === 0);
  const figures: ExtractedFigures = {
    grossSales: sumColumns(dataRows, cols.grossSales.indices, false),
    platformFee: sumColumns(dataRows, cols.platformFee.indices, true),
    shippingFee: sumColumns(dataRows, cols.shippingFee.indices, true),
    discount: sumColumns(dataRows, cols.discount.indices, true),
    monthly: groupMonthly(dataRows, cols, dateCols),
  };
  return { figures, missingFields };
}

function extractTikTokDetailed(headers: string[], dataRows: unknown[][]): { figures: ExtractedFigures; missingFields: FigureField[] } {
  const cols = mapTikTokColumns(headers);
  const dateCols = mapTikTokDateColumns(headers);
  const missingFields = EXTRACTED_FIELDS.map((f) => f.key).filter((key) => cols[key].indices.length === 0);
  const figures: ExtractedFigures = {
    grossSales: sumColumns(dataRows, cols.grossSales.indices, false),
    platformFee: sumColumns(dataRows, cols.platformFee.indices, true),
    shippingFee: sumColumns(dataRows, cols.shippingFee.indices, true),
    discount: sumColumns(dataRows, cols.discount.indices, true),
    monthly: groupMonthly(dataRows, cols, dateCols),
  };
  return { figures, missingFields };
}

function extractFromTable(headers: string[], dataRows: unknown[][], platform: Platform): { figures: ExtractedFigures; missingFields: FigureField[] } {
  if (isShopeeDetailedReport(headers)) return extractShopeeDetailed(headers, dataRows);
  if (isTikTokReport(headers)) return extractTikTokDetailed(headers, dataRows);
  const columns = mapColumns(headers, platform);
  const missingFields = EXTRACTED_FIELDS.map((f) => f.key).filter((key) => columns[key] < 0);
  const figures: ExtractedFigures = {
    grossSales: sumColumn(dataRows, columns.grossSales, false),
    platformFee: sumColumn(dataRows, columns.platformFee, true),
    shippingFee: sumColumn(dataRows, columns.shippingFee, true),
    discount: sumColumn(dataRows, columns.discount, true),
  };
  return { figures, missingFields };
}

/** เดาแพลตฟอร์มจากชื่อไฟล์ (shopee_/tiktok_/lazada_...) — เดาไม่ได้ → shopee (auto-detect header จัดการเอง) */
export function detectPlatformFromName(name: string | null | undefined): Platform {
  const n = (name || "").toLowerCase();
  if (n.includes("shopee")) return PLATFORM.SHOPEE;
  if (n.includes("tiktok")) return PLATFORM.TIKTOK;
  if (n.includes("lazada")) return PLATFORM.LAZADA;
  if (n.includes("lineman") || n.includes("line man")) return PLATFORM.LINE_MAN;
  if (n.includes("grab")) return PLATFORM.GRAB;
  if (n.includes("foodstory")) return PLATFORM.FOOD_STORY;
  return PLATFORM.SHOPEE;
}

/** อ่านไฟล์รายงานแพลตฟอร์ม → FileExtraction (โยน SafeParseError ถ้าอ่านตารางไม่ได้) */
export async function parsePlatformFile(
  file: { name: string; ext: string; buffer: ArrayBuffer },
  platform: Platform,
): Promise<FileExtraction> {
  const { headers, rows } = await readAndSelectTable(file, salesHeaderKeywords(platform), SALES_SHEET_PRIORITY_NAMES);
  if (headers.length === 0) throw new SafeParseError("ไม่พบตารางข้อมูลในไฟล์รายงานยอดขาย");
  if (rows.length > MAX_ROWS) throw new Error(`ไฟล์เกินเพดาน ${MAX_ROWS} แถว`);
  const { figures, missingFields } = extractFromTable(headers, rows, platform);
  return {
    fileName: file.name,
    platform,
    source: FIGURE_SOURCE.CODE_PARSE,
    figures,
    missingFields,
    note: `อ่าน ${rows.length} แถวจากไฟล์`,
  };
}

/** ฟอร์แมตเลข: ไม่มี comma, ตัด 0 ท้าย */
function num(x: number): string {
  return String(Math.round((x + Number.EPSILON) * 100) / 100);
}

/**
 * สร้าง CSV สรุปรายงานแพลตฟอร์ม (ตรง output NOVA Sales: 4 ตัวเลข + แยกรายเดือน)
 */
export function buildPlatformSummaryCsv(ext: FileExtraction): string {
  const f = ext.figures;
  const lines: string[] = [];
  lines.push(`สรุปรายงานแพลตฟอร์ม (${PLATFORM_LABELS[ext.platform]})`);
  lines.push("รายการ,จำนวน(บาท)");
  lines.push(`ยอดขายรวม,${num(f.grossSales)}`);
  lines.push(`ค่าธรรมเนียม/GP,${num(f.platformFee)}`);
  lines.push(`ค่าขนส่ง,${num(f.shippingFee)}`);
  lines.push(`ส่วนลด,${num(f.discount)}`);
  if (f.monthly && f.monthly.length > 0) {
    lines.push("");
    lines.push("ยอดขายแยกรายเดือน");
    lines.push("เดือน,ยอดขายรวม,ค่าธรรมเนียม/GP,ค่าขนส่ง,ส่วนลด");
    for (const m of f.monthly) {
      lines.push(`${m.month},${num(m.grossSales)},${num(m.platformFee)},${num(m.shippingFee)},${num(m.discount)}`);
    }
  }
  return lines.join("\r\n");
}
