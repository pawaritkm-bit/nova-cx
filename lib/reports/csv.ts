/**
 * ตัวสร้าง CSV (บริสุทธิ์ — unit test ได้ทันที)
 *   - escape ตาม RFC 4180 (คลุมด้วย " เมื่อมี , " \n)
 *   - ใส่ UTF-8 BOM ให้ Excel เปิดภาษาไทยไม่เพี้ยน (NFR-04)
 */

export type CsvColumn<T> = {
  /** หัวคอลัมน์ (ไทยได้) */
  header: string;
  /** ดึงค่าออกจาก row */
  value: (row: T) => string | number | boolean | null | undefined;
};

const BOM = "﻿";

/** escape ค่าเดียวตาม RFC 4180 */
export function escapeCsvValue(
  raw: string | number | boolean | null | undefined
): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** สร้างสตริง CSV จาก rows + คำนิยามคอลัมน์ (มี BOM นำหน้า) */
export function buildCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const headerLine = columns.map((c) => escapeCsvValue(c.header)).join(",");
  const dataLines = rows.map((row) =>
    columns.map((c) => escapeCsvValue(c.value(row))).join(",")
  );
  return BOM + [headerLine, ...dataLines].join("\r\n");
}
