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
  const paymentBase = { payDate: "2026-08-01", currency: "USD", docNo: "INV-001" };

  it("★ realized > 0 (กำไร, ขาย) → คืน ManualEntryInput ที่ isBalanced() ผ่านเสมอ + docType='JV'", () => {
    const input = suggestFxGainLossEntryInput(
      { ...paymentBase, fxAmount: 100, fxRate: 36.0 },
      { entryType: "sale", fxRate: 35.0 },
      "4025",
      chartByCode
    );
    expect(input).not.toBeNull();
    expect(input!.docType).toBe("JV");
    const lines = input!.lines as { debit: number; credit: number }[];
    expect(lines).toHaveLength(2);
    expect(isBalanced(lines)).toBe(true);
    // กำไร → เครดิตบัญชี FX (รายได้เพิ่ม), เดบิต AR ตรงข้าม
    const fxLine = (input!.lines as { accountCode: string; credit: number; debit: number }[]).find(
      (l) => l.accountCode === "4025"
    )!;
    expect(fxLine.credit).toBe(100);
    expect(fxLine.debit).toBe(0);
    const arLine = (input!.lines as { accountCode: string; credit: number; debit: number }[]).find(
      (l) => l.accountCode === "1140"
    )!;
    expect(arLine.debit).toBe(100);
  });

  it("★ realized < 0 (ขาดทุน, ขาย) → เดบิตบัญชี FX + เครดิต AR ตรงข้าม สมดุลเสมอ", () => {
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
    const arLine = lines.find((l) => l.accountCode === "1140")!;
    expect(arLine.credit).toBe(100);
  });

  it("บิลซื้อ (AP) — ใช้บัญชี 2010 แทน 1140 + สมดุลเสมอ", () => {
    const input = suggestFxGainLossEntryInput(
      { ...paymentBase, fxAmount: 100, fxRate: 34.0 },
      { entryType: "purchase", fxRate: 35.0 },
      "4025",
      chartByCode
    );
    expect(input).not.toBeNull();
    const lines = input!.lines as { debit: number; credit: number; accountCode: string }[];
    expect(isBalanced(lines)).toBe(true);
    expect(lines.some((l) => l.accountCode === "2010")).toBe(true);
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

  it("ยอด/ทิศทางถูกต้องกับตัวเลขจริง (เคสใหญ่กว่า, ซื้อ+กำไร)", () => {
    // ซื้อ CNY 1000 ออกบิลที่ 5.0 (=5000 บาท) → settle 4.8 (=4800 บาท) → จ่ายน้อยกว่าที่ตั้งไว้ 200 บาท = กำไร
    const input = suggestFxGainLossEntryInput(
      { payDate: "2026-08-05", currency: "CNY", fxAmount: 1000, fxRate: 4.8 },
      { entryType: "purchase", fxRate: 5.0 },
      "4025",
      chartByCode
    );
    expect(input).not.toBeNull();
    const lines = input!.lines as { debit: number; credit: number; accountCode: string }[];
    const fxLine = lines.find((l) => l.accountCode === "4025")!;
    expect(fxLine.credit).toBe(200);
    const apLine = lines.find((l) => l.accountCode === "2010")!;
    expect(apLine.debit).toBe(200);
  });
});
