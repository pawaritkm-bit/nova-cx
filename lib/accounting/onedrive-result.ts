/**
 * onedrive-result.ts — เซฟ "ผลลัพธ์ที่ AI แกะได้" (ตาราง) กลับ OneDrive โฟลเดอร์เดียวกับไฟล์ต้นฉบับ
 *   เป็น CSV (UTF-8 + BOM ให้ Excel เปิดภาษาไทยไม่เพี้ยน) — นักบัญชีเปิดต่อ/นำเข้าโปรแกรมบัญชีได้เลย
 * ★ best-effort: ล้มเหลว → คืน false (ไม่ throw)
 * ★ AI แกะรายการดิบ — ไฟล์นี้แค่แปลงเป็น CSV (ไม่รวมยอดเพิ่ม; ผลรวมทำที่ analyze เดิม)
 */
import { uploadOneDriveFile } from "@/lib/storage/onedrive";

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** headers = [{key, label}] · rows = object[] → CSV string */
function toCsv(headers: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  const head = headers.map((h) => csvCell(h.label)).join(",");
  const body = rows
    .map((r) => headers.map((h) => csvCell(r[h.key])).join(","))
    .join("\r\n");
  return head + "\r\n" + body;
}

/**
 * เซฟ "CSV ที่ประกอบเป็นสตริงแล้ว" (เช่น สรุปหลายส่วนในไฟล์เดียว) ขึ้น OneDrive
 *   @returns true ถ้าสำเร็จ
 */
export async function saveRawCsvToOneDrive(params: {
  folderParts: string[];
  fileName: string;
  csv: string;
}): Promise<boolean> {
  try {
    if (!params.csv.trim()) return false;
    const data = Buffer.from("﻿" + params.csv, "utf8"); // BOM กัน Excel อ่านไทยเพี้ยน
    const saved = await uploadOneDriveFile({
      folderParts: params.folderParts,
      fileName: params.fileName,
      mime: "text/csv",
      data,
    });
    return saved !== null;
  } catch {
    console.warn("[onedrive-result] save raw failed");
    return false;
  }
}

/**
 * เซฟผลลัพธ์เป็น CSV ขึ้น OneDrive โฟลเดอร์ [folderParts]/fileName
 *   @returns true ถ้าสำเร็จ
 */
export async function saveResultCsvToOneDrive(params: {
  folderParts: string[];
  fileName: string;
  headers: { key: string; label: string }[];
  rows: Record<string, unknown>[];
}): Promise<boolean> {
  try {
    if (params.rows.length === 0) return false;
    const csv = toCsv(params.headers, params.rows);
    const data = Buffer.from("﻿" + csv, "utf8"); // BOM กัน Excel อ่านไทยเพี้ยน
    const saved = await uploadOneDriveFile({
      folderParts: params.folderParts,
      fileName: params.fileName,
      mime: "text/csv",
      data,
    });
    return saved !== null;
  } catch {
    console.warn("[onedrive-result] save failed");
    return false;
  }
}
