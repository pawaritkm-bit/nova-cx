import { describe, it, expect } from "vitest";
import {
  isValidNonBankCode,
  NONBANK_ACCOUNT_CODES,
  categoryDigitOf,
  searchChartNonBankGrouped,
  BANK_ACCOUNT_CODES,
} from "@/lib/accounting/chart-of-accounts";

/**
 * chart-of-accounts — validate รหัสบัญชีที่ AI แนะนำ + ค้นแบบจัดกลุ่มตามหมวด
 */

describe("isValidNonBankCode / NONBANK_ACCOUNT_CODES", () => {
  it("รหัส non-bank ในผัง → true", () => {
    expect(isValidNonBankCode("5340")).toBe(true);
    expect(isValidNonBankCode("5010")).toBe(true);
    expect(isValidNonBankCode("4010")).toBe(true);
  });

  it("★ รหัสหมวดเงินฝากธนาคาร (bank) → false (ห้าม AI เลือก)", () => {
    for (const code of BANK_ACCOUNT_CODES) {
      expect(isValidNonBankCode(code)).toBe(false);
      expect(NONBANK_ACCOUNT_CODES.has(code)).toBe(false);
    }
  });

  it("รหัสนอกผัง / ว่าง / null → false", () => {
    expect(isValidNonBankCode("9999")).toBe(false);
    expect(isValidNonBankCode("")).toBe(false);
    expect(isValidNonBankCode(null)).toBe(false);
    expect(isValidNonBankCode(undefined)).toBe(false);
  });

  it("trim ช่องว่างก่อนตรวจ", () => {
    expect(isValidNonBankCode(" 5340 ")).toBe(true);
  });
});

describe("categoryDigitOf", () => {
  it("คืนเลขหลักแรก 1..6", () => {
    expect(categoryDigitOf("1010")).toBe("1");
    expect(categoryDigitOf("5340")).toBe("5");
    expect(categoryDigitOf("6000")).toBe("6");
    expect(categoryDigitOf("1615.1")).toBe("1");
  });
  it("ไม่ขึ้นต้นด้วย 1..6 → '6' (อื่น ๆ)", () => {
    expect(categoryDigitOf("X10")).toBe("6");
    expect(categoryDigitOf("")).toBe("6");
  });
});

describe("searchChartNonBankGrouped — จัดกลุ่มตามหมวด + digit-filter", () => {
  it("★ พิมพ์เลขหลักเดียว (5) → เด้งเฉพาะหมวด 5 ทั้งหมด (code ขึ้นต้นด้วย 5)", () => {
    const groups = searchChartNonBankGrouped("5");
    expect(groups.length).toBe(1);
    expect(groups[0].digit).toBe("5");
    expect(groups[0].category).toBe("ค่าใช้จ่าย");
    // ทุกตัวขึ้นต้นด้วย 5
    expect(groups[0].accounts.every((a) => a.code.startsWith("5"))).toBe(true);
    // ต้องมีค่าน้ำมัน 5340 อยู่ในหมวดนี้
    expect(groups[0].accounts.some((a) => a.code === "5340")).toBe(true);
  });

  it("★ พิมพ์เลข 1 → หมวดสินทรัพย์ และมีบัญชีเงินฝากธนาคาร (bank) รวมอยู่ด้วย", () => {
    const groups = searchChartNonBankGrouped("1");
    expect(groups.length).toBe(1);
    expect(groups[0].digit).toBe("1");
    // เงินฝากธนาคาร (bank:true) เป็นตัวเลือกปกติในหมวด 1 แล้ว
    for (const code of BANK_ACCOUNT_CODES) {
      expect(groups[0].accounts.some((a) => a.code === code)).toBe(true);
    }
  });

  it("ค้นด้วยชื่อ (substring) → กระจายได้หลายหมวด เรียง 1→6", () => {
    const groups = searchChartNonBankGrouped("ภาษี");
    expect(groups.length).toBeGreaterThan(0);
    // เรียงตามเลขหมวดจากน้อยไปมาก
    const digits = groups.map((g) => Number(g.digit));
    expect(digits).toEqual([...digits].sort((a, b) => a - b));
  });

  it("ค้นด้วยรหัสหลายหลัก (534) → substring ไม่ใช่ digit-filter", () => {
    const groups = searchChartNonBankGrouped("534");
    const all = groups.flatMap((g) => g.accounts);
    expect(all.every((a) => a.code.includes("534"))).toBe(true);
    expect(all.some((a) => a.code === "5340")).toBe(true);
  });

  it("ว่าง → คืนทุกหมวดที่มีบัญชี (รวมบัญชีเงินฝากธนาคารในหมวด 1)", () => {
    const groups = searchChartNonBankGrouped("");
    expect(groups.length).toBeGreaterThanOrEqual(5);
    // รวมแล้วต้องมี bank code (เงินฝากธนาคารเป็นตัวเลือกปกติ)
    const all = groups.flatMap((g) => g.accounts);
    for (const code of BANK_ACCOUNT_CODES) {
      expect(all.some((a) => a.code === code)).toBe(true);
    }
  });

  it("ค้นไม่เจอ → คืน [] (ไม่มีกลุ่ม)", () => {
    expect(searchChartNonBankGrouped("zzzไม่มีจริง")).toEqual([]);
  });

  it("เลข 7–9 (ไม่ใช่ 1–6) → ถือเป็น substring ไม่ใช่ digit-filter", () => {
    // '7' ไม่เข้าเงื่อนไข digit-filter → ค้น substring: ทุกผลต้องมี '7' ในรหัส/ชื่อ
    const all = searchChartNonBankGrouped("7").flatMap((g) => g.accounts);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((a) => a.code.includes("7") || a.name.includes("7"))).toBe(true);
    // และไม่มีทั้งหมวดที่ code ไม่มี 7 (เช่น 5010) หลุดมา
    expect(all.some((a) => a.code === "5010")).toBe(false);
  });
});
