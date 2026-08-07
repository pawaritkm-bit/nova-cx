/**
 * แปลงไฟล์สเตทเมนต์ Excel/CSV → ข้อความตาราง (TSV-ish) เพื่อป้อนให้ AI อ่าน
 *   OpenAI vision อ่าน xlsx/csv ตรง ๆ ไม่ได้ → ต้อง flatten เป็นข้อความก่อน (แล้วส่งเป็น text prompt)
 *
 * ★ pure-ish: รับ Buffer → คืน string (exceljs อ่านใน memory ไม่แตะ network)
 * ★ cap จำนวนแถว/ความยาว กัน prompt ใหญ่เกิน (สเตทเมนต์ยาวมากก็ยังส่งไหว)
 * ★ PDPA: ไม่ log เนื้อไฟล์
 */
import ExcelJS from "exceljs";

/** cap แถวที่ป้อนให้ AI (สเตทเมนต์รายเดือนปกติ < 1000 แถว) */
const MAX_ROWS = 4000;
/** cap ความยาวข้อความรวม (อักขระ) กัน prompt ระเบิด */
const MAX_CHARS = 200_000;

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

/** ยุบข้อความให้อยู่ในเพดาน (ตัดท้าย + หมายเหตุ) */
function clampText(s: string): string {
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n…(ตัดเนื้อหาส่วนเกิน)` : s;
}

/**
 * แปลง Excel (.xlsx/.xls) buffer → ข้อความตาราง (คั่นด้วย tab, ขึ้นบรรทัดใหม่ต่อแถว)
 *   ทุกชีทต่อกัน (มี header ชื่อชีท) · ข้ามแถวว่างล้วน · cap แถว/ความยาว
 */
export async function excelBufferToText(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const parts: string[] = [];
  let rowBudget = MAX_ROWS;

  wb.eachSheet((sheet) => {
    if (rowBudget <= 0) return;
    const lines: string[] = [];
    sheet.eachRow((row) => {
      if (rowBudget <= 0) return;
      const values = Array.isArray(row.values) ? row.values.slice(1) : []; // index 0 ว่างเสมอ
      const cells = values.map((c) => cellToText(c).replace(/[\t\r\n]+/g, " ").trim());
      if (cells.every((c) => c === "")) return; // ข้ามแถวว่าง
      lines.push(cells.join("\t"));
      rowBudget -= 1;
    });
    if (lines.length > 0) {
      parts.push(`# ชีท: ${sheet.name}\n${lines.join("\n")}`);
    }
  });

  return clampText(parts.join("\n\n"));
}

/**
 * แปลง CSV buffer → ข้อความ (decode utf-8, cap แถว/ความยาว)
 *   ★ ไม่ parse โครงสร้าง CSV (ปล่อยให้ AI อ่านตาราง) — แค่ decode + ตัดขนาด
 */
export function csvBufferToText(buf: Buffer): string {
  const raw = buf.toString("utf-8").replace(/^﻿/, ""); // ตัด BOM
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  return clampText(lines.slice(0, MAX_ROWS).join("\n"));
}
