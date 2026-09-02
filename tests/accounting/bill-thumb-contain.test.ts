import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression — บั๊กที่ผู้ใช้เจอ 2026-09-02 ("บิลเข้าแล้วแต่รูปเห็นแค่ครึ่งเดียว"):
 * Supabase render endpoint เมื่อส่ง width อย่างเดียว = โหมด cover → ครอปข้างรูป
 * (สลิปแนวตั้ง 990×1237 ที่ width=360 เหลือแถบกลาง 360×1237 — ทดสอบจริงกับ production)
 * ทุก URL ที่เรียก render/image ต้องระบุ resize=contain เสมอ
 */
describe("bill-thumb: render ต้องใช้ resize=contain (กันครอปรูป)", () => {
  it("ทุกการเรียก render/image ใน repo มี resize=contain", () => {
    const s = readFileSync(
      join(__dirname, "..", "..", "app/api/accounting/bill-thumb/route.ts"),
      "utf8"
    );
    const calls = s.match(/render\/image[^`"']*/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toContain("resize=contain");
  });

  it("createSignedUrl แบบ transform (หน้าตรวจ/แก้) ต้องมี resize: contain ด้วย", () => {
    const s = readFileSync(
      join(__dirname, "..", "..", "app/chat-audit/accounting/page.tsx"),
      "utf8"
    );
    const transforms = s.match(/transform:\s*\{[^}]*\}/g) ?? [];
    expect(transforms.length).toBeGreaterThan(0);
    for (const t of transforms) expect(t).toMatch(/resize:\s*"contain"/);
  });

  it("thumbnail ลิสต์หน้าตรวจ/ยืนยัน ใช้ bill-thumb (รูปย่อ) ไม่ใช่ signed URL รูปเต็ม", () => {
    const s = readFileSync(
      join(__dirname, "..", "..", "app/chat-audit/accounting/page.tsx"),
      "utf8"
    );
    expect(s).toMatch(/acc-thumb[\s\S]{0,600}bill-thumb\?entry=/);
  });
});
