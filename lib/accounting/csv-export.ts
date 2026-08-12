/**
 * แปลง rows → ข้อความ CSV (pure, ไม่แตะ DOM/network — ทดสอบได้)
 *   ใช้กับปุ่ม "ดาวน์โหลด CSV" ของหน้าอ่านสเตทเมนต์/รายงานแพลตฟอร์ม (Phase 1 — ข้อมูลอยู่ใน
 *   client state เท่านั้น ไม่ได้ persist ลง DB จึงต้อง export จากสิ่งที่แสดงบนจอตรง ๆ)
 *
 * ★ quote field ที่มี comma/quote/newline (RFC 4180-ish) · prepend UTF-8 BOM ให้ Excel
 *   เปิดภาษาไทยไม่เพี้ยน (Excel ต้องมี BOM ถึงจะเดา UTF-8 ถูกสำหรับไฟล์ CSV)
 */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  function esc(v: string | number | null): string {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const lines = [header, ...rows].map((r) => r.map(esc).join(","));
  return "﻿" + lines.join("\r\n");
}
