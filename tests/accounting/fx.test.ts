import { describe, it, expect } from "vitest";
import { realizedFxGainLoss, suggestFxGainLossEntryInput } from "@/lib/accounting/fx";
import { isBalanced } from "@/lib/accounting/manual-journal";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { TEST_CHART } from "./fixtures/chart";

/**
 * fx.ts — เฟส 10 ส่วน AA (docs/06-accounting-features-roadmap.md, 0.5/0.8) — จุดสำคัญที่สุดของส่วน AA
 *   เน้น: realizedFxGainLoss ทุกทิศทาง (T90) + suggestFxGainLossEntryInput สมดุลเสมอ
 */

const chartByCode = buildChartByCode(TEST_CHART);

describe("realizedFxGainLoss", () => {
  it("ขาย (ลด AR) + บาทอ่อนตัวลง (settleRate > invoiceRate) → กำไร (บวก)", () => {
    // ขาย USD 100 ที่อัตราออกบิล 35.0 → settle 36.0 → รับบาทมากกว่าที่ตั้งไว้ 100 บาท
    expect(realizedFxGainLoss("sale", 100, 35.0, 36.0)).toBe(100);
  });

  it("ขาย + บาทแข็งขึ้น (settleRate < invoiceRate) → ขาดทุน (ลบ)", () => {
    expect(realizedFxGainLoss("sale", 100, 36.0, 35.0)).toBe(-100);
  });

  it("ซื้อ (ลด AP) + บาทอ่อนตัวลง (settleRate > invoiceRate) → ขาดทุน (ลบ, ทิศตรงข้ามกับขาย)", () => {
    // ซื้อ USD 100 ที่อัตราออกบิล 35.0 → settle 36.0 → ต้องจ่ายบาทมากกว่าที่ตั้งไว้ → ขาดทุน
    expect(realizedFxGainLoss("purchase", 100, 35.0, 36.0)).toBe(-100);
  });

  it("ซื้อ + บาทแข็งขึ้น (settleRate < invoiceRate) → กำไร (บวก)", () => {
    expect(realizedFxGainLoss("purchase", 100, 36.0, 35.0)).toBe(100);
  });

  it("★ อัตราเท่ากันเป๊ะ (ไม่ว่าฝั่งใด) → 0 เสมอ (ไม่มีกำไร/ขาดทุน)", () => {
    expect(realizedFxGainLoss("sale", 100, 35.0, 35.0)).toBe(0);
    expect(realizedFxGainLoss("purchase", 500, 35.5, 35.5)).toBe(0);
  });

  it("ปัดทศนิยม 2 ตำแหน่งถูกต้อง", () => {
    expect(realizedFxGainLoss("sale", 33.333, 35.0, 35.1)).toBe(3.33);
  });
});

describe("suggestFxGainLossEntryInput", () => {
  // ★ QC เฟส 10 (fix): บัญชีคู่ต้องเป็นเงินสด/ธนาคารจริงของงวดนั้น (contraAccountFor) ไม่ใช่ AR (1140)/AP (2010)
  //   ที่ toJournalLines() ตัดด้วย invoice rate จนเคลียร์เป็น 0 ไปแล้ว — เทสต์นี้ล็อกพฤติกรรมที่ถูกต้องแทน
  const paymentBase = { payDate: "2026-08-01", currency: "USD", docNo: "INV-001", method: "cash" as const };

  it("★ realized > 0 (กำไร, ขาย, รับเงินสด) → คืน ManualEntryInput ที่ isBalanced() ผ่านเสมอ + docType='JV'", () => {
    // ขาย USD 100 invoice rate 35 (AR ตั้งไว้ 3,500) → รับเงินจริงที่ settlement rate 36 (เงินสดเข้าจริง 3,600)
    // → ส่วนต่าง 100 บาทเป็นกำไร → Dr เงินสด 100 / Cr FX gain 100 (ไม่แตะ AR ที่เคลียร์เป็น 0 ไปแล้ว)
    const input = suggestFxGainLossEntryInput(
      { ...paymentBase, fxAmount: 100, fxRate: 36.0 },
      { entryType: "sale", fxRate: 35.0 },
      "4025",
      chartByCode
    );
    expect(input).not.toBeNull();
    expect(input!.docType).toBe("JV");
    const lines = input!.lines as { debit: number; credit: number; accountCode: string }[];
    expect(lines).toHaveLength(2);
    expect(isBalanced(lines)).toBe(true);
    // กำไร → เครดิตบัญชี FX (รายได้เพิ่ม), เดบิตบัญชีเงินสด (1010, วิธีรับเงิน='cash') ตรงข้าม — ไม่ใช่ AR (1140)
    const fxLine = lines.find((l) => l.accountCode === "4025")!;
    expect(fxLine.credit).toBe(100);
    expect(fxLine.debit).toBe(0);
    expect(lines.some((l) => l.accountCode === "1140")).toBe(false);
    const cashLine = lines.find((l) => l.accountCode === "1010")!;
    expect(cashLine).toBeDefined();
    expect(cashLine.debit).toBe(100);
    expect(cashLine.credit).toBe(0);
  });

  it("★ realized < 0 (ขาดทุน, ขาย) → เดบิตบัญชี FX + เครดิตบัญชีเงินสด/ธนาคาร ตรงข้าม สมดุลเสมอ", () => {
    const input = suggestFxGainLossEntryInput(
      { ...paymentBase, fxAmount: 100, fxRate: 34.0 },
      { entryType: "sale", fxRate: 35.0 },
      "4025",
      chartByCode
    );
    expect(input).not.toBeNull();
    const lines = input!.lines as { debit: number; credit: number; accountCode: string }[];
    expect(isBalanced(lines)).toBe(true);
    const fxLine = lines.find((l) => l.accountCode === "4025")!;
    expect(fxLine.debit).toBe(100);
    expect(lines.some((l) => l.accountCode === "1140")).toBe(false);
    const cashLine = lines.find((l) => l.accountCode === "1010")!;
    expect(cashLine.credit).toBe(100);
  });

  it("บิลซื้อ (จ่ายเงินสด) — ปรับบัญชีเงินสด (1010) ไม่ใช่ AP (2010) + สมดุลเสมอ", () => {
    const input = suggestFxGainLossEntryInput(
      { ...paymentBase, fxAmount: 100, fxRate: 34.0 },
      { entryType: "purchase", fxRate: 35.0 },
      "4025",
      chartByCode
    );
    expect(input).not.toBeNull();
    const lines = input!.lines as { debit: number; credit: number; accountCode: string }[];
    expect(isBalanced(lines)).toBe(true);
    expect(lines.some((l) => l.accountCode === "1010")).toBe(true);
    expect(lines.some((l) => l.accountCode === "2010")).toBe(false);
    expect(lines.some((l) => l.accountCode === "4025")).toBe(true);
  });

  it("★ realized = 0 (อัตราเท่ากันเป๊ะ) → คืน null (ไม่สร้าง JV เปล่า, ตาม T90)", () => {
    const input = suggestFxGainLossEntryInput(
      { ...paymentBase, fxAmount: 100, fxRate: 35.0 },
      { entryType: "sale", fxRate: 35.0 },
      "4025",
      chartByCode
    );
    expect(input).toBeNull();
  });

  it("ยอด/ทิศทางถูกต้องกับตัวเลขจริง (เคสใหญ่กว่า, ซื้อ+กำไร, จ่ายเงินสด)", () => {
    // ซื้อ CNY 1000 ออกบิลที่ 5.0 (=5000 บาท) → settle 4.8 (=4800 บาท) → จ่ายน้อยกว่าที่ตั้งไว้ 200 บาท = กำไร
    // → Dr เงินสด/ธนาคาร 200 / Cr FX gain 200 (ไม่แตะ AP ที่เคลียร์เป็น 0 ไปแล้ว)
    const input = suggestFxGainLossEntryInput(
      { payDate: "2026-08-05", currency: "CNY", fxAmount: 1000, fxRate: 4.8, method: "cash" },
      { entryType: "purchase", fxRate: 5.0 },
      "4025",
      chartByCode
    );
    expect(input).not.toBeNull();
    const lines = input!.lines as { debit: number; credit: number; accountCode: string }[];
    const fxLine = lines.find((l) => l.accountCode === "4025")!;
    expect(fxLine.credit).toBe(200);
    expect(lines.some((l) => l.accountCode === "2010")).toBe(false);
    const cashLine = lines.find((l) => l.accountCode === "1010")!;
    expect(cashLine.debit).toBe(200);
  });

  it("รับเงินโอน (transfer) + มีบัญชีเงินฝากผูกไว้ → บัญชีคู่ = บัญชีเงินฝากนั้น (ไม่ใช่ default 1020)", () => {
    const input = suggestFxGainLossEntryInput(
      { ...paymentBase, method: "transfer", bankAccountCode: "1025", fxAmount: 100, fxRate: 36.0 },
      { entryType: "sale", fxRate: 35.0 },
      "4025",
      chartByCode
    );
    expect(input).not.toBeNull();
    const lines = input!.lines as { debit: number; credit: number; accountCode: string }[];
    expect(isBalanced(lines)).toBe(true);
    const bankLine = lines.find((l) => l.accountCode === "1025")!;
    expect(bankLine).toBeDefined();
    expect(bankLine.debit).toBe(100);
  });

  it("รับเงินโอน (transfer) ไม่ผูกบัญชีเงินฝาก → fallback บัญชีเงินฝากธนาคาร default (1020)", () => {
    const input = suggestFxGainLossEntryInput(
      { ...paymentBase, method: "transfer", bankAccountCode: null, fxAmount: 100, fxRate: 36.0 },
      { entryType: "sale", fxRate: 35.0 },
      "4025",
      chartByCode
    );
    expect(input).not.toBeNull();
    const lines = input!.lines as { debit: number; credit: number; accountCode: string }[];
    const bankLine = lines.find((l) => l.accountCode === "1020")!;
    expect(bankLine).toBeDefined();
    expect(bankLine.debit).toBe(100);
  });
});
