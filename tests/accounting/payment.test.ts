import { describe, it, expect } from "vitest";
import {
  suggestPaymentMethod,
  contraAccountFor,
  asPaymentMethod,
  PAYMENT_METHOD_LABELS,
} from "@/lib/accounting/payment";

/**
 * เทสต์ helper pure ของ "วิธีจ่าย/รับเงิน → บัญชีคู่ (เครดิต)":
 *   1) suggestPaymentMethod: เดาจาก doc_kind (เงินสด/สลิป/ใบกำกับ)
 *   2) contraAccountFor: คำนวณบัญชีคู่ (เงินสด=1010 · โอน=บัญชีธนาคาร · เชื่อ=2010/1140)
 */

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
    expect(contraAccountFor("cash", "purchase")).toEqual({ code: "1010", name: "เงินสด" });
    expect(contraAccountFor("cash", "sale")).toEqual({ code: "1010", name: "เงินสด" });
  });

  it("โอน + เลือกบัญชีธนาคาร → รหัสบัญชีธนาคารนั้น", () => {
    const r = contraAccountFor("transfer", "purchase", "1020");
    expect(r?.code).toBe("1020");
    expect(r?.name).toContain("เงินฝากธนาคาร");
  });

  it("โอน + ยังไม่เลือกบัญชี → code ว่าง (รอเลือก)", () => {
    const r = contraAccountFor("transfer", "sale", null);
    expect(r?.code).toBe("");
    expect(r?.name).toContain("ยังไม่เลือก");
  });

  it("เชื่อ + ซื้อ → 2010 เจ้าหนี้การค้า", () => {
    expect(contraAccountFor("credit", "purchase")).toEqual({ code: "2010", name: "เจ้าหนี้การค้า" });
  });

  it("เชื่อ + ขาย → 1140 ลูกหนี้การค้า", () => {
    expect(contraAccountFor("credit", "sale")).toEqual({ code: "1140", name: "ลูกหนี้การค้า" });
  });

  it("เชื่อ + รอระบุ → null (ยังตัดสินฝั่งไม่ได้)", () => {
    expect(contraAccountFor("credit", "unspecified")).toBeNull();
  });

  it("ไม่ระบุวิธีจ่าย → null", () => {
    expect(contraAccountFor(null, "purchase")).toBeNull();
  });
});

describe("payment — asPaymentMethod (validate จาก client)", () => {
  it("รับเฉพาะค่าที่ถูกต้อง", () => {
    expect(asPaymentMethod("cash")).toBe("cash");
    expect(asPaymentMethod("transfer")).toBe("transfer");
    expect(asPaymentMethod("credit")).toBe("credit");
    expect(asPaymentMethod("evil")).toBeNull();
    expect(asPaymentMethod("")).toBeNull();
    expect(asPaymentMethod(null)).toBeNull();
    expect(asPaymentMethod(123)).toBeNull();
  });

  it("มีป้ายไทยครบทุกวิธี", () => {
    expect(PAYMENT_METHOD_LABELS.cash).toBe("เงินสด");
    expect(PAYMENT_METHOD_LABELS.transfer).toBe("โอน");
    expect(PAYMENT_METHOD_LABELS.credit).toBe("เชื่อ");
  });
});
