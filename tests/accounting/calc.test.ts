import { describe, it, expect } from "vitest";
import {
  parseAmountInput,
  calcVat,
  calcWht,
  calcNet,
  formatMoney,
  round2,
  VAT_RATE,
} from "@/lib/accounting/calc";

/**
 * accounting/calc — ตัวช่วยคำนวณ/ฟอร์แมตฝั่ง client (auto-คำนวณ EntryEditor)
 *   robust: ต้อง parse comma / เลขไทย / ช่องว่าง / ค่าพัง ได้ทั้งหมด
 */

describe("parseAmountInput — robust ตัวเลขจาก input ผู้ใช้", () => {
  it("ตัด comma หลักพัน", () => {
    expect(parseAmountInput("1,234.56")).toBe(1234.56);
    expect(parseAmountInput("1,000,000")).toBe(1000000);
  });
  it("เลขไทย ๐-๙ → อารบิก", () => {
    expect(parseAmountInput("๑๒๓")).toBe(123);
    expect(parseAmountInput("๑,๒๓๔.๕๐")).toBe(1234.5);
  });
  it("ช่องว่าง/สัญลักษณ์แปลกปลอม (บาท ฿) ถูกตัดทิ้ง", () => {
    expect(parseAmountInput("  1 234 บาท ")).toBe(1234);
    expect(parseAmountInput("฿2,500.00")).toBe(2500);
  });
  it("ค่าว่าง / null / undefined / ขยะ → 0", () => {
    expect(parseAmountInput("")).toBe(0);
    expect(parseAmountInput(null)).toBe(0);
    expect(parseAmountInput(undefined)).toBe(0);
    expect(parseAmountInput("abc")).toBe(0);
    expect(parseAmountInput(".")).toBe(0);
  });
  it("จุดทศนิยมเกิน → ใช้จุดแรก", () => {
    expect(parseAmountInput("1.2.3")).toBe(1.23);
  });
  it("รับ number ตรง ๆ (NaN/Infinity → 0)", () => {
    expect(parseAmountInput(42.5)).toBe(42.5);
    expect(parseAmountInput(NaN)).toBe(0);
    expect(parseAmountInput(Infinity)).toBe(0);
  });
  it("ค่าติดลบนำหน้า", () => {
    expect(parseAmountInput("-50")).toBe(-50);
  });
});

describe("calcVat — VAT 7% ตามประเภท", () => {
  it("vat → 7%", () => {
    expect(VAT_RATE).toBe(7);
    expect(calcVat(1000, "vat")).toBe(70);
    expect(calcVat(107, "vat")).toBe(7.49);
  });
  it("novat → 0", () => {
    expect(calcVat(1000, "novat")).toBe(0);
  });
});

describe("calcWht — หัก ณ ที่จ่าย = amount * rate/100", () => {
  it("rate ปกติ", () => {
    expect(calcWht(1000, 3)).toBe(30);
    expect(calcWht(1000, 5)).toBe(50);
  });
  it("rate ≤ 0 → 0", () => {
    expect(calcWht(1000, 0)).toBe(0);
    expect(calcWht(1000, -1)).toBe(0);
  });
  it("ปัด 2 ตำแหน่ง", () => {
    expect(calcWht(333.33, 3)).toBe(10); // 9.9999 → 10
  });
});

describe("calcNet — มูลค่า + VAT − หัก", () => {
  it("คำนวณถูก + ปัด 2", () => {
    expect(calcNet(1000, 70, 30)).toBe(1040);
    expect(calcNet(100.005, 0, 0)).toBe(100.01);
  });
});

describe("formatMoney — คั่นหลักพัน + ทศนิยม 2 เสมอ", () => {
  it("format ปกติ", () => {
    expect(formatMoney(1234.5)).toBe("1,234.50");
    expect(formatMoney(0)).toBe("0.00");
    expect(formatMoney(1000000)).toBe("1,000,000.00");
  });
  it("ค่าพัง → 0.00", () => {
    expect(formatMoney(NaN)).toBe("0.00");
  });
});

describe("round2", () => {
  it("กัน floating error", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(NaN)).toBe(0);
  });
});
