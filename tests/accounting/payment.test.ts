import { describe, it, expect } from "vitest";
import {
  suggestPaymentMethod,
  contraAccountFor,
  asPaymentMethod,
  paymentMethodLabel,
  PAYMENT_METHOD_LABELS,
} from "@/lib/accounting/payment";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { TEST_CHART } from "@/tests/accounting/fixtures/chart";

/**
 * เทสต์ helper pure ของ "วิธีจ่าย/รับเงิน → บัญชีคู่ (เครดิต)":
 *   1) suggestPaymentMethod: เดาจาก doc_kind (เงินสด/สลิป/ใบกำกับ)
 *   2) contraAccountFor: คำนวณบัญชีคู่ (เงินสด=1010 · โอน=บัญชีธนาคาร · เชื่อ=2010/1140) — รับ chartByCode
 */

const TEST_CHART_BY_CODE = buildChartByCode(TEST_CHART);

describe("payment — suggestPaymentMethod (เดาจาก doc_kind)", () => {
  it("เงินสด/เขียนมือ → cash", () => {
    expect(suggestPaymentMethod("cash")).toBe("cash");
    expect(suggestPaymentMethod("handwritten")).toBe("cash");
    expect(suggestPaymentMethod("CASH")).toBe("cash"); // case-insensitive
    expect(suggestPaymentMethod("  cash  ")).toBe("cash"); // trim
  });

  it("สลิปโอน → transfer", () => {
    expect(suggestPaymentMethod("slip")).toBe("transfer");
  });

  it("ใบกำกับซื้อ/ขาย → credit", () => {
    expect(suggestPaymentMethod("purchase")).toBe("credit");
    expect(suggestPaymentMethod("sale")).toBe("credit");
  });

  it("อื่น ๆ / ว่าง / null → null (ให้คนเลือก)", () => {
    expect(suggestPaymentMethod("other")).toBeNull();
    expect(suggestPaymentMethod("")).toBeNull();
    expect(suggestPaymentMethod(null)).toBeNull();
    expect(suggestPaymentMethod(undefined)).toBeNull();
  });
});

describe("payment — contraAccountFor (บัญชีคู่เครดิต)", () => {
  it("เงินสด → 1010 เงินสด", () => {
    expect(contraAccountFor(TEST_CHART_BY_CODE, "cash", "purchase")).toEqual({ code: "1010", name: "เงินสด" });
    expect(contraAccountFor(TEST_CHART_BY_CODE, "cash", "sale")).toEqual({ code: "1010", name: "เงินสด" });
  });

  it("เช็ค + ขาย → 1155 เช็ครับล่วงหน้า", () => {
    expect(contraAccountFor(TEST_CHART_BY_CODE, "cheque", "sale")).toEqual({ code: "1155", name: "เช็ครับล่วงหน้า" });
  });

  it("เช็ค + ซื้อ → 2220 เช็คสั่งจ่ายล่วงหน้า", () => {
    expect(contraAccountFor(TEST_CHART_BY_CODE, "cheque", "purchase")).toEqual({
      code: "2220",
      name: "เช็คสั่งจ่ายล่วงหน้า",
    });
  });

  it("เช็ค + รอระบุ → null (ยังตัดสินฝั่งไม่ได้)", () => {
    expect(contraAccountFor(TEST_CHART_BY_CODE, "cheque", "unspecified")).toBeNull();
  });

  it("โอน + ผูกบัญชีธนาคารเดิม → รหัสบัญชีนั้น", () => {
    const r = contraAccountFor(TEST_CHART_BY_CODE, "transfer", "purchase", "1025");
    expect(r?.code).toBe("1025");
    expect(r?.name).toContain("เงินฝากธนาคาร");
  });

  it("โอน + ไม่มีบัญชีผูก → default 1020 เงินฝากธนาคาร", () => {
    const r = contraAccountFor(TEST_CHART_BY_CODE, "transfer", "sale", null);
    expect(r?.code).toBe("1020");
    expect(r?.name).toContain("เงินฝากธนาคาร");
  });

  it("เชื่อ + ซื้อ → 2010 เจ้าหนี้การค้า", () => {
    expect(contraAccountFor(TEST_CHART_BY_CODE, "credit", "purchase")).toEqual({
      code: "2010",
      name: "เจ้าหนี้การค้า",
    });
  });

  it("เชื่อ + ขาย → 1140 ลูกหนี้การค้า", () => {
    expect(contraAccountFor(TEST_CHART_BY_CODE, "credit", "sale")).toEqual({ code: "1140", name: "ลูกหนี้การค้า" });
  });

  it("เชื่อ + รอระบุ → null (ยังตัดสินฝั่งไม่ได้)", () => {
    expect(contraAccountFor(TEST_CHART_BY_CODE, "credit", "unspecified")).toBeNull();
  });

  it("ไม่ระบุวิธีจ่าย → null", () => {
    expect(contraAccountFor(TEST_CHART_BY_CODE, null, "purchase")).toBeNull();
  });
});

describe("payment — asPaymentMethod (validate จาก client)", () => {
  it("รับเฉพาะค่าที่ถูกต้อง (รวม cheque)", () => {
    expect(asPaymentMethod("cash")).toBe("cash");
    expect(asPaymentMethod("cheque")).toBe("cheque");
    expect(asPaymentMethod("transfer")).toBe("transfer");
    expect(asPaymentMethod("credit")).toBe("credit");
    expect(asPaymentMethod("evil")).toBeNull();
    expect(asPaymentMethod("")).toBeNull();
    expect(asPaymentMethod(null)).toBeNull();
    expect(asPaymentMethod(123)).toBeNull();
  });

  it("มีป้ายไทยกลาง ๆ ครบทุกวิธี", () => {
    expect(PAYMENT_METHOD_LABELS.cash).toBe("เงินสด");
    expect(PAYMENT_METHOD_LABELS.cheque).toBe("เช็ค");
    expect(PAYMENT_METHOD_LABELS.transfer).toBe("เงินโอน");
    expect(PAYMENT_METHOD_LABELS.credit).toBe("ลูกหนี้/เจ้าหนี้");
  });
});

describe("payment — paymentMethodLabel (ป้ายตามฝั่งบิล)", () => {
  it("cash/cheque/transfer คงที่ทุกฝั่ง", () => {
    expect(paymentMethodLabel("cash", "sale")).toBe("เงินสด");
    expect(paymentMethodLabel("cheque", "purchase")).toBe("เช็ค");
    expect(paymentMethodLabel("transfer", "sale")).toBe("เงินโอน");
  });

  it("credit → ขาย=ลูกหนี้ · ซื้อ=เจ้าหนี้ · รอระบุ=ลูกหนี้/เจ้าหนี้", () => {
    expect(paymentMethodLabel("credit", "sale")).toBe("ลูกหนี้");
    expect(paymentMethodLabel("credit", "purchase")).toBe("เจ้าหนี้");
    expect(paymentMethodLabel("credit", "unspecified")).toBe("ลูกหนี้/เจ้าหนี้");
  });
});
