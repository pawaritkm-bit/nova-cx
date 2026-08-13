import { describe, it, expect } from "vitest";
import { splitRuns, FONT_THAI, FONT_LATIN } from "@/lib/pdf/thai-text";

/**
 * เทสต์ lib/pdf/thai-text.ts::splitRuns (wishlist ข้อ 6 — สลิปเงินเดือน PDF)
 *   ★ ปัญหาที่แก้: @fontsource/sarabun แจก subset ฟอนต์แยกไทย/ละติน — ต้องตัด run ให้ถูกฟอนต์
 *   ก่อนวาด มิฉะนั้นตัวเลข/วรรคตอนหายไปเป็นช่องว่างเงียบ ๆ (verified ด้วย prototype นอกโค้ดจริงมาก่อน)
 */

function fonts(text: string): string[] {
  return splitRuns(text).map((r) => r.font);
}

function texts(text: string): string[] {
  return splitRuns(text).map((r) => r.text);
}

describe("splitRuns", () => {
  it("string ว่าง → array ว่าง", () => {
    expect(splitRuns("")).toEqual([]);
  });

  it("อักษรไทยล้วน → run เดียว ฟอนต์ไทย", () => {
    const runs = splitRuns("นายทดสอบ");
    expect(runs).toHaveLength(1);
    expect(runs[0].font).toBe(FONT_THAI);
    expect(runs[0].text).toBe("นายทดสอบ");
  });

  it("ตัวเลข/อังกฤษล้วน → run เดียว ฟอนต์ละติน", () => {
    const runs = splitRuns("12,345.50");
    expect(runs).toHaveLength(1);
    expect(runs[0].font).toBe(FONT_LATIN);
  });

  it("ผสมไทย+ตัวเลข+วรรคตอน → ตัด run สลับฟอนต์ถูกต้อง ต่อกันได้ครบทุกตัวอักษร", () => {
    const text = "เงินเดือน/ค่าจ้าง: 12,345.50 บาท";
    const runs = splitRuns(text);
    expect(runs.map((r) => r.text).join("")).toBe(text);
    expect(fonts(text)).toContain(FONT_THAI);
    expect(fonts(text)).toContain(FONT_LATIN);
  });

  it("มี em-dash และวงเล็บ (ป้ายประกันสังคมนายจ้าง) → ไม่หายไปจาก run ไหนเลย", () => {
    const text = "ประกันสังคม (ส่วนนายจ้าง — นายจ้างสมทบให้ ไม่หักจากพนักงาน): 500.00 บาท";
    expect(texts(text).join("")).toBe(text);
  });

  it("ตัวเลขบาทแสดงเป็น 0.00 ก็ยังตัด run ได้ครบ (edge case เงินเดือน 0)", () => {
    const text = "เงินเดือน/ค่าจ้าง: 0.00 บาท";
    expect(texts(text).join("")).toBe(text);
  });
});
