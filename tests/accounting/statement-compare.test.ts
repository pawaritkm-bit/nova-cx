import { describe, it, expect } from "vitest";
import { mergeCompareLines, sumCompareLines } from "@/lib/accounting/statement-compare";
import type { StatementLine } from "@/lib/accounting/financial-statements";

/**
 * statement-compare.ts — เฟส 4 ส่วน N (การประกอบแถวเทียบงวดของงบกำไรขาดทุน/งบแสดงฐานะการเงิน)
 *   ★ ใช้ร่วมกันทั้งจอ (N1)/หน้าพิมพ์ (N2)/Excel export (N3) — ต้องทดสอบให้ครอบทุก edge case
 */

const cur: StatementLine[] = [
  { code: "4010", name: "รายได้ขาย", amount: 10000 },
  { code: "5010", name: "ต้นทุนขาย", amount: 4000 },
];

describe("mergeCompareLines", () => {
  it("ไม่มีโหมดเทียบ (compare=null) → ทุกแถว compare เป็น null เสมอ", () => {
    const rows = mergeCompareLines(cur, null);
    expect(rows).toEqual([
      { code: "4010", name: "รายได้ขาย", current: 10000, compare: null },
      { code: "5010", name: "ต้นทุนขาย", current: 4000, compare: null },
    ]);
  });

  it("รหัสตรงกันทั้ง 2 ฝั่ง → รวมเป็นแถวเดียว เรียงตามลำดับงวดปัจจุบัน", () => {
    const compare: StatementLine[] = [
      { code: "4010", name: "รายได้ขาย", amount: 8000 },
      { code: "5010", name: "ต้นทุนขาย", amount: 3500 },
    ];
    const rows = mergeCompareLines(cur, compare);
    expect(rows).toEqual([
      { code: "4010", name: "รายได้ขาย", current: 10000, compare: 8000 },
      { code: "5010", name: "ต้นทุนขาย", current: 4000, compare: 3500 },
    ]);
  });

  it("รหัสมีเฉพาะงวดปัจจุบัน (งวดเทียบไม่มีบัญชีนี้) → compare = 0 (ไม่ใช่ null เพราะมีโหมดเทียบจริง)", () => {
    const compare: StatementLine[] = [{ code: "4010", name: "รายได้ขาย", amount: 8000 }];
    const rows = mergeCompareLines(cur, compare);
    expect(rows.find((r) => r.code === "5010")).toEqual({
      code: "5010",
      name: "ต้นทุนขาย",
      current: 4000,
      compare: 0,
    });
  });

  it("รหัสมีเฉพาะงวดเทียบ (tenant เพิ่ม/ลบผังบัญชีเอง — ไม่มีในงวดปัจจุบัน) → ต่อท้ายแถว current = 0", () => {
    const compare: StatementLine[] = [
      { code: "4010", name: "รายได้ขาย", amount: 8000 },
      { code: "5010", name: "ต้นทุนขาย", amount: 3500 },
      { code: "4020", name: "รายได้อื่น (ปีก่อนมี ปีนี้ไม่มี)", amount: 500 },
    ];
    const rows = mergeCompareLines(cur, compare);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({
      code: "4020",
      name: "รายได้อื่น (ปีก่อนมี ปีนี้ไม่มี)",
      current: 0,
      compare: 500,
    });
  });

  it("ทั้งสองฝั่งว่างเปล่า → คืน array ว่าง", () => {
    expect(mergeCompareLines([], null)).toEqual([]);
    expect(mergeCompareLines([], [])).toEqual([]);
  });
});

describe("sumCompareLines", () => {
  it("ไม่มีโหมดเทียบ → compare รวม = null", () => {
    const rows = mergeCompareLines(cur, null);
    expect(sumCompareLines(rows)).toEqual({ current: 14000, compare: null });
  });

  it("มีโหมดเทียบ → รวมทั้ง current และ compare", () => {
    const compare: StatementLine[] = [
      { code: "4010", name: "รายได้ขาย", amount: 8000 },
      { code: "5010", name: "ต้นทุนขาย", amount: 3500 },
    ];
    const rows = mergeCompareLines(cur, compare);
    expect(sumCompareLines(rows)).toEqual({ current: 14000, compare: 11500 });
  });
});
