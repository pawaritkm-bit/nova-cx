import { describe, it, expect } from "vitest";
import { csvBufferToRows, excelBufferToRows, MAX_TOTAL_ROWS, MAX_CHUNKS } from "@/lib/accounting/statement-parse";
import ExcelJS from "exceljs";

/**
 * เทสต์ `statement-parse.ts` (แก้บั๊ก A, 2026-08-12) — แบ่งไฟล์ Excel/CSV เป็นชุด (chunk) ก่อนส่ง AI
 *   แทนที่จะแปลงทั้งไฟล์เป็นข้อความก้อนเดียวแล้วตัดทิ้งเงียบ ๆ เหมือนโค้ดเดิม
 */

describe("csvBufferToRows — แบ่งไฟล์เป็นชุด", () => {
  it("ไฟล์เล็ก → chunk เดียว, ไม่ตัดข้อมูล (truncated=false)", () => {
    const csv = "date,amount\n2026-07-01,100\n2026-07-02,200\n";
    const buf = Buffer.from(csv, "utf-8");
    const r = csvBufferToRows(buf);
    expect(r.chunks.length).toBe(1);
    expect(r.totalRows).toBe(3); // header + 2 แถวข้อมูล (ไม่ parse โครงสร้าง แค่นับบรรทัดที่ไม่ว่าง)
    expect(r.includedRows).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it("ไฟล์ที่มีแถวเยอะกว่า CHUNK_ROW_TARGET (700) → แบ่งเป็นหลายชุด แต่ไม่ตัดข้อมูล (ยังไม่ถึง MAX_TOTAL_ROWS)", () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `2026-07-01,${i}`).join("\n");
    const buf = Buffer.from(lines, "utf-8");
    const r = csvBufferToRows(buf);
    expect(r.totalRows).toBe(1500);
    expect(r.includedRows).toBe(1500);
    expect(r.truncated).toBe(false);
    expect(r.chunks.length).toBeGreaterThan(1); // ต้องแบ่งมากกว่า 1 ชุดแน่นอน (1500 > 700)
    // รวมจำนวนบรรทัดทุกชุดกลับมาต้องได้เท่าของเดิม
    const totalLinesInChunks = r.chunks.reduce((sum, c) => sum + c.split("\n").length, 0);
    expect(totalLinesInChunks).toBe(1500);
  });

  it("ไฟล์ใหญ่เกิน MAX_TOTAL_ROWS → truncated=true, includedRows < totalRows (แก้บั๊ก D — ไม่ตัดเงียบ มี meta บอก)", () => {
    const rowCount = MAX_TOTAL_ROWS + 500;
    const lines = Array.from({ length: rowCount }, (_, i) => `row-${i}`).join("\n");
    const buf = Buffer.from(lines, "utf-8");
    const r = csvBufferToRows(buf);
    expect(r.totalRows).toBe(rowCount);
    expect(r.truncated).toBe(true);
    expect(r.includedRows).toBeLessThan(r.totalRows);
    expect(r.includedRows).toBeLessThanOrEqual(MAX_TOTAL_ROWS);
  });

  it("จำนวนชุดไม่เกิน MAX_CHUNKS ไม่ว่าไฟล์จะใหญ่แค่ไหน", () => {
    const rowCount = MAX_TOTAL_ROWS; // เต็มเพดานพอดี
    const lines = Array.from({ length: rowCount }, (_, i) => `row-${i}`).join("\n");
    const buf = Buffer.from(lines, "utf-8");
    const r = csvBufferToRows(buf);
    expect(r.chunks.length).toBeLessThanOrEqual(MAX_CHUNKS);
  });

  it("ตัด BOM + ข้ามบรรทัดว่าง", () => {
    const csv = "﻿date,amount\n\n2026-07-01,100\n   \n";
    const buf = Buffer.from(csv, "utf-8");
    const r = csvBufferToRows(buf);
    expect(r.totalRows).toBe(2); // header + 1 แถวข้อมูล (บรรทัดว่าง/เว้นวรรคล้วนถูกข้าม)
    expect(r.chunks[0]).not.toMatch(/^﻿/);
  });

  it("บรรทัดยาวผิดปกติ → ตัดชุดให้พอดี CHUNK_CHAR_BUDGET แม้ยังไม่ครบ CHUNK_ROW_TARGET แถว", () => {
    const longLine = "x".repeat(30_000);
    const lines = [longLine, longLine, "short"].join("\n"); // 2 แถวยาว (รวม ~60,000 ตัวอักษร) เกิน budget ต่อชุด
    const buf = Buffer.from(lines, "utf-8");
    const r = csvBufferToRows(buf);
    expect(r.chunks.length).toBeGreaterThan(1);
    expect(r.truncated).toBe(false);
  });
});

describe("excelBufferToRows — แบ่งไฟล์ Excel เป็นชุด", () => {
  async function buildWorkbookBuffer(rows: number): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Sheet1");
    for (let i = 0; i < rows; i++) {
      sheet.addRow([`2026-07-0${(i % 9) + 1}`, i, `รายการที่ ${i}`]);
    }
    const arrayBuffer = await wb.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer as ArrayBuffer);
  }

  it("ไฟล์เล็ก → chunk เดียว ไม่ตัดข้อมูล", async () => {
    const buf = await buildWorkbookBuffer(10);
    const r = await excelBufferToRows(buf);
    expect(r.chunks.length).toBe(1);
    expect(r.truncated).toBe(false);
    // +1 เพราะมีบรรทัดหัวชีท "# ชีท: Sheet1"
    expect(r.totalRows).toBe(11);
  });

  it("ไฟล์ที่มีหลายแถว (มากกว่า CHUNK_ROW_TARGET) → แบ่งหลายชุด ไม่ตัดข้อมูล", async () => {
    const buf = await buildWorkbookBuffer(1000);
    const r = await excelBufferToRows(buf);
    expect(r.truncated).toBe(false);
    expect(r.chunks.length).toBeGreaterThan(1);
  });
});
