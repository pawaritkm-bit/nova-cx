import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  asBillPaymentMethod,
  billNetTotal,
  billOutstanding,
  isCreditEligibleForPayment,
  validatePaymentInput,
  toJournalLines,
  toJournalPosting,
  getBillPaymentScope,
  getPaymentScope,
  listBillPayments,
  listBillPaymentsForEntries,
  recordBillPayment,
  voidBillPayment,
  type BillPaymentInput,
  type PaymentEntryInfo,
  type PaymentJournalEntry,
} from "@/lib/accounting/bill-payments";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { TEST_CHART } from "./fixtures/chart";

/**
 * bill-payments.ts — เฟส 2 ส่วน E (docs/06-accounting-features-roadmap.md)
 *   เน้น: ยอดเต็ม/ยอดค้างชำระ (0.3) · validate (overpay/method/eligible, 0.1/0.2/0.8) ·
 *   mapper (toJournalLines/toJournalPosting, 0.4/0.5) · data layer (mock DB)
 */

const chartByCode = buildChartByCode(TEST_CHART);

function entryInfo(p: Partial<PaymentEntryInfo> = {}): PaymentEntryInfo {
  return {
    entryType: p.entryType ?? "sale",
    // ★ ใช้ "in" เช็ค (ไม่ใช้ ??) — paymentMethod:null เป็นค่าที่ตั้งใจส่งมาทดสอบ ต้องไม่ถูก ?? บังคับเป็น default
    paymentMethod: "paymentMethod" in p ? p.paymentMethod! : "credit",
    status: p.status ?? "confirmed",
    lines: p.lines ?? [{ amount: 1000, vatAmount: 70, whtAmount: 0 }],
    // เฟส 10 ส่วน AA — undefined เมื่อไม่ส่ง (backward-compat เป๊ะกับเทสต์เดิมทั้งหมดก่อนเฟสนี้)
    currency: p.currency,
    fxRate: p.fxRate,
  };
}

// ---------------------------------------------------------------------
// billNetTotal / billOutstanding (0.3 — reuse summarizeEntry)
// ---------------------------------------------------------------------
describe("billNetTotal", () => {
  it("= amount + vat - wht รวมทุกบรรทัด", () => {
    const e = entryInfo({ lines: [{ amount: 1000, vatAmount: 70, whtAmount: 30 }] });
    expect(billNetTotal(e)).toBe(1040);
  });
  it("หลายบรรทัด → รวมทุกบรรทัด", () => {
    const e = entryInfo({
      lines: [
        { amount: 1000, vatAmount: 70, whtAmount: 0 },
        { amount: 500, vatAmount: 0, whtAmount: 0 },
      ],
    });
    expect(billNetTotal(e)).toBe(1570);
  });
});

describe("billOutstanding", () => {
  const e = entryInfo({ lines: [{ amount: 1000, vatAmount: 40, whtAmount: 0 }] }); // net = 1040
  it("ยังไม่จ่ายเลย → เต็มยอด", () => {
    expect(billOutstanding(e, [])).toBe(1040);
  });
  it("จ่ายบางส่วน → ลดลงตามยอดที่จ่ายจริง", () => {
    expect(billOutstanding(e, [{ amount: 400, payDate: "2026-08-01" }])).toBe(640);
  });
  it("จ่ายครบพอดี → 0", () => {
    expect(billOutstanding(e, [{ amount: 1040, payDate: "2026-08-01" }])).toBe(0);
  });
  it("หลายงวดสะสม → รวมทุกงวด", () => {
    expect(
      billOutstanding(e, [
        { amount: 400, payDate: "2026-08-01" },
        { amount: 300, payDate: "2026-08-05" },
      ])
    ).toBe(340);
  });

  // -----------------------------------------------------------------
  // netAdjustment (เฟส 3 ส่วน J, 0.6) — CN ลด/DN เพิ่ม/ผสมกันหลายใบ/default 0 = พฤติกรรมเดิม
  // -----------------------------------------------------------------
  it("★ ไม่ระบุ netAdjustment → default 0 = พฤติกรรมเดิมเป๊ะ (backward-compat)", () => {
    expect(billOutstanding(e, [])).toBe(billOutstanding(e, [], 0));
  });

  it("มี CN (netAdjustment ติดลบ) → ยอดค้างชำระลดลงตามยอด CN", () => {
    expect(billOutstanding(e, [], -200)).toBe(840);
  });

  it("มี DN (netAdjustment เป็นบวก) → ยอดค้างชำระเพิ่มขึ้นตามยอด DN", () => {
    expect(billOutstanding(e, [], 150)).toBe(1190);
  });

  it("ผสม CN+DN หลายใบ + จ่ายบางส่วน → คำนวณรวมถูกต้อง", () => {
    // net=1040, netAdjustment = -300(CN) + 100(DN) = -200 → เต็มยอดใหม่ 840 − จ่าย 400 = 440
    expect(billOutstanding(e, [{ amount: 400, payDate: "2026-08-01" }], -200)).toBe(440);
  });

  // -----------------------------------------------------------------
  // asOfDate (เฟส 10b, 0.5) — ช่องโหว่ #2: ไม่ส่ง = พฤติกรรมเดิม 100% (regression บังคับ) · ส่งมา = กรอง
  //   payments ที่ payDate > asOfDate ออกก่อนคำนวณ
  // -----------------------------------------------------------------
  describe("asOfDate (0.5)", () => {
    const payments = [
      { amount: 400, payDate: "2026-08-01" },
      { amount: 300, payDate: "2026-08-15" },
    ];

    it("★ ไม่ส่ง asOfDate → ผลลัพธ์เหมือนก่อนแก้เป๊ะ (regression บังคับ — นับ payment ทุกแถวไม่กรอง)", () => {
      expect(billOutstanding(e, payments)).toBe(340);
      expect(billOutstanding(e, payments)).toBe(billOutstanding(e, payments, 0, undefined));
    });

    it("asOfDate อยู่ก่อน payment งวดที่ 2 → ไม่นับงวดที่ 2 (เหมือนยังไม่เกิดขึ้นจริง ณ วันนั้น)", () => {
      expect(billOutstanding(e, payments, 0, "2026-08-10")).toBe(640); // หัก payment วันที่ 08-01 อย่างเดียว
    });

    it("asOfDate ตรงกับวันที่ payment เป๊ะ (เท่ากัน) → นับ payment วันนั้นด้วย (<=, inclusive)", () => {
      expect(billOutstanding(e, payments, 0, "2026-08-01")).toBe(640);
      expect(billOutstanding(e, payments, 0, "2026-08-15")).toBe(340);
    });

    it("asOfDate ก่อน payment ทุกแถว → ไม่หักอะไรเลย (เต็มยอด)", () => {
      expect(billOutstanding(e, payments, 0, "2026-07-01")).toBe(1040);
    });

    it("asOfDate หลัง payment ทุกแถว → เหมือนไม่กรอง (ผลลัพธ์เท่ากับไม่ส่ง asOfDate)", () => {
      expect(billOutstanding(e, payments, 0, "2026-12-31")).toBe(billOutstanding(e, payments));
    });
  });
});

// ---------------------------------------------------------------------
// isCreditEligibleForPayment (0.1)
// ---------------------------------------------------------------------
describe("isCreditEligibleForPayment", () => {
  it("ขาย + credit + confirmed → true", () => {
    expect(isCreditEligibleForPayment(entryInfo({ entryType: "sale" }))).toBe(true);
  });
  it("ซื้อ + credit + confirmed → true", () => {
    expect(isCreditEligibleForPayment(entryInfo({ entryType: "purchase" }))).toBe(true);
  });
  it("unspecified → false", () => {
    expect(isCreditEligibleForPayment(entryInfo({ entryType: "unspecified" }))).toBe(false);
  });
  it("payment_method ไม่ใช่ credit → false", () => {
    expect(isCreditEligibleForPayment(entryInfo({ paymentMethod: "cash" }))).toBe(false);
    expect(isCreditEligibleForPayment(entryInfo({ paymentMethod: null }))).toBe(false);
  });
  it("ยังไม่ confirmed (draft) → false", () => {
    expect(isCreditEligibleForPayment(entryInfo({ status: "draft" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------
// asBillPaymentMethod
// ---------------------------------------------------------------------
describe("asBillPaymentMethod", () => {
  it("cash/cheque/transfer → ผ่าน", () => {
    expect(asBillPaymentMethod("cash")).toBe("cash");
    expect(asBillPaymentMethod("cheque")).toBe("cheque");
    expect(asBillPaymentMethod("transfer")).toBe("transfer");
  });
  it("★ credit ต้องถูกปฏิเสธเสมอ (0.2 — การชำระจริงไม่มีทาง 'เชื่อ' ต่อการเชื่อได้อีก)", () => {
    expect(asBillPaymentMethod("credit")).toBeNull();
  });
  it("ค่าอื่นที่ไม่รู้จัก → null", () => {
    expect(asBillPaymentMethod("bitcoin")).toBeNull();
    expect(asBillPaymentMethod(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// validatePaymentInput — FX (เฟส 10 ส่วน AA, 0.8) — บิลต้นทาง FX (entry.currency ไม่ null)
// ---------------------------------------------------------------------
describe("validatePaymentInput — FX (0.8)", () => {
  const fxEntry = () =>
    entryInfo({ lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }], currency: "USD", fxRate: 35.0 });

  it("★ derive amount จาก fxAmount × entry.fxRate (อัตราบิล) ไม่ใช่อัตรา settlement (เทสต์บังคับ)", () => {
    const r = validatePaymentInput(
      { payDate: "2026-08-01", amount: 999999, method: "cash", fxAmount: 20, fxRate: 36.0 },
      fxEntry(),
      []
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 20 × 35.0 (invoice rate) = 700 — ★ ไม่ใช่ 20 × 36.0 = 720 (settlement rate)
      expect(r.value.amount).toBe(700);
      expect(r.value.currency).toBe("USD");
      expect(r.value.fxRate).toBe(36.0);
      expect(r.value.fxAmount).toBe(20);
    }
  });

  it("ไม่ระบุ fxAmount หรือ ≤0 → ปฏิเสธ", () => {
    const r1 = validatePaymentInput({ payDate: "2026-08-01", amount: 0, method: "cash", fxRate: 36 }, fxEntry(), []);
    expect(r1.ok).toBe(false);
    const r2 = validatePaymentInput(
      { payDate: "2026-08-01", amount: 0, method: "cash", fxAmount: -5, fxRate: 36 },
      fxEntry(),
      []
    );
    expect(r2.ok).toBe(false);
  });

  it("fxRate settlement ผิดรูป (≤0/เกิน 100000/ไม่ใช่ตัวเลข) → ปฏิเสธ (hard-block, 0.11)", () => {
    const r1 = validatePaymentInput(
      { payDate: "2026-08-01", amount: 0, method: "cash", fxAmount: 20, fxRate: 0 },
      fxEntry(),
      []
    );
    expect(r1.ok).toBe(false);
    const r2 = validatePaymentInput(
      { payDate: "2026-08-01", amount: 0, method: "cash", fxAmount: 20, fxRate: 200000 },
      fxEntry(),
      []
    );
    expect(r2.ok).toBe(false);
  });

  it("ยอดที่ derive แล้วเกินยอดค้างชำระ → ปฏิเสธเหมือนบิล THB ปกติ (0.8)", () => {
    // entry net = 1000 (USD 1000 fxRate เดิม แต่บรรทัดคำนวณจาก amount ปกติของ pure lines — ยอดเต็ม = 1000)
    const r = validatePaymentInput(
      { payDate: "2026-08-01", amount: 0, method: "cash", fxAmount: 100, fxRate: 36.0 },
      fxEntry(),
      []
    );
    // 100 × 35.0 = 3500 > 1000 (ยอดเต็ม) → เกิน
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("เกิน");
  });

  it("บิล THB ปกติ (currency=undefined) ยังใช้ input.amount ตรง ๆ เหมือนเดิมทุกประการ (regression บังคับ)", () => {
    const r = validatePaymentInput(
      { payDate: "2026-08-01", amount: 400, method: "cash" },
      entryInfo({ lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] }),
      []
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.amount).toBe(400);
      expect(r.value.currency).toBeNull();
      expect(r.value.fxRate).toBeNull();
      expect(r.value.fxAmount).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------
// validatePaymentInput (pure)
// ---------------------------------------------------------------------
describe("validatePaymentInput", () => {
  const validInput: BillPaymentInput = { payDate: "2026-08-01", amount: 400, method: "cash" };

  it("input ถูกต้อง + ไม่เกินยอดค้าง → ok:true", () => {
    const r = validatePaymentInput(validInput, entryInfo(), []);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.amount).toBe(400);
      expect(r.value.method).toBe("cash");
    }
  });

  it("★ entry ไม่ eligible (ไม่ใช่ credit) → ปฏิเสธเสมอ (เทสต์บังคับ 0.1)", () => {
    const r = validatePaymentInput(validInput, entryInfo({ paymentMethod: "cash" }), []);
    expect(r.ok).toBe(false);
  });

  it("entry ยังไม่ confirmed → ปฏิเสธ", () => {
    const r = validatePaymentInput(validInput, entryInfo({ status: "draft" }), []);
    expect(r.ok).toBe(false);
  });

  it("★ method='credit' → ปฏิเสธเสมอ แม้ entry จะ eligible ก็ตาม (0.2)", () => {
    const r = validatePaymentInput({ ...validInput, method: "credit" }, entryInfo(), []);
    expect(r.ok).toBe(false);
  });

  it("method ไม่รู้จัก → ปฏิเสธ", () => {
    const r = validatePaymentInput({ ...validInput, method: "bitcoin" }, entryInfo(), []);
    expect(r.ok).toBe(false);
  });

  it("วันที่รับ/จ่ายเงินผิดรูปแบบ → ปฏิเสธ", () => {
    const r = validatePaymentInput({ ...validInput, payDate: "1/8/2026" }, entryInfo(), []);
    expect(r.ok).toBe(false);
  });

  it("จำนวนเงินเป็น 0 หรือติดลบ → ปฏิเสธ", () => {
    expect(validatePaymentInput({ ...validInput, amount: 0 }, entryInfo(), []).ok).toBe(false);
    expect(validatePaymentInput({ ...validInput, amount: -100 }, entryInfo(), []).ok).toBe(false);
  });

  it("★ จำนวนเงินเกินยอดค้างชำระ → ปฏิเสธเสมอ (เทสต์บังคับ 0.8)", () => {
    const e = entryInfo({ lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] }); // net=1000
    const r = validatePaymentInput({ ...validInput, amount: 1000.01 }, e, [{ amount: 500, payDate: "2026-08-01" }]);
    // ค้างชำระ = 1000-500 = 500 → ขอ 1000.01 เกิน
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("เกิน");
  });

  it("จำนวนเงินเท่ากับยอดค้างพอดี → ผ่าน (ไม่ใช่ overpay)", () => {
    const e = entryInfo({ lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] });
    const r = validatePaymentInput({ ...validInput, amount: 500 }, e, [{ amount: 500, payDate: "2026-08-01" }]);
    expect(r.ok).toBe(true);
  });

  it("transfer + bankAccountId → เก็บ bankAccountId · ไม่ใช่ transfer → ล้างเป็น null เสมอ", () => {
    const r1 = validatePaymentInput({ ...validInput, method: "transfer", bankAccountId: "bank-1" }, entryInfo(), []);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.bankAccountId).toBe("bank-1");

    const r2 = validatePaymentInput({ ...validInput, method: "cash", bankAccountId: "bank-1" }, entryInfo(), []);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.bankAccountId).toBeNull();
  });

  it("notes ถูก clamp/trim", () => {
    const r = validatePaymentInput({ ...validInput, notes: "  รับเงินงวดที่ 1  " }, entryInfo(), []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.notes).toBe("รับเงินงวดที่ 1");
  });

  // -----------------------------------------------------------------
  // netAdjustment (เฟส 3 ส่วน J, 0.6) — ปฏิเสธ overpay ที่คำนวณรวม netAdjustment แล้วถูกต้อง
  // -----------------------------------------------------------------
  it("★ ไม่ระบุ netAdjustment → default 0 (backward-compat)", () => {
    const e = entryInfo({ lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] });
    const r = validatePaymentInput({ ...validInput, amount: 1000 }, e, []);
    expect(r.ok).toBe(true);
  });

  it("★ มี CN ลดยอดค้าง → ยอดที่เคยผ่านตอนไม่มี CN กลับเป็น overpay (ปฏิเสธ)", () => {
    const e = entryInfo({ lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] }); // net=1000
    const r = validatePaymentInput({ ...validInput, amount: 1000 }, e, [], -300); // ค้างจริง = 700
    expect(r.ok).toBe(false);
  });

  it("มี DN เพิ่มยอดค้าง → รับเงินได้มากกว่ายอดเต็มเดิม (ยังไม่เกินยอดค้างจริง)", () => {
    const e = entryInfo({ lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] }); // net=1000
    const r = validatePaymentInput({ ...validInput, amount: 1200 }, e, [], 300); // ค้างจริง = 1300
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------
// toJournalLines / toJournalPosting (0.4/0.5, reuse contraAccountFor)
// ---------------------------------------------------------------------
function mkPaymentEntry(p: Partial<PaymentJournalEntry> = {}): PaymentJournalEntry {
  return {
    id: "e1",
    entryType: p.entryType ?? "sale",
    docNo: p.docNo ?? "INV-001",
    customerId: p.customerId ?? "c1",
    counterpartyName: p.counterpartyName ?? "บริษัท ลูกค้า จำกัด",
  };
}

describe("toJournalLines", () => {
  it("บิลขาย (sale) + cash → Dr เงินสด(1010) / Cr ลูกหนี้การค้า(1140) สมดุล", () => {
    const lines = toJournalLines(
      { payDate: "2026-08-01", amount: 400, method: "cash", bankAccountCode: null },
      mkPaymentEntry({ entryType: "sale" }),
      chartByCode
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountCode: "1010", debit: 400, credit: 0, side: "debit" });
    expect(lines[1]).toMatchObject({ accountCode: "1140", debit: 0, credit: 400, side: "credit" });
    const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
    expect(totalDebit).toBe(totalCredit);
  });

  it("บิลซื้อ (purchase) + cash → Dr เจ้าหนี้การค้า(2010) / Cr เงินสด(1010) สมดุล", () => {
    const lines = toJournalLines(
      { payDate: "2026-08-01", amount: 600, method: "cash", bankAccountCode: null },
      mkPaymentEntry({ entryType: "purchase" }),
      chartByCode
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountCode: "2010", debit: 600, credit: 0, side: "debit" });
    expect(lines[1]).toMatchObject({ accountCode: "1010", debit: 0, credit: 600, side: "credit" });
  });

  it("โอนเข้าบัญชีเฉพาะ (bankAccountCode) → ใช้รหัสบัญชีนั้นเป็นบัญชีคู่", () => {
    const lines = toJournalLines(
      { payDate: "2026-08-01", amount: 1000, method: "transfer", bankAccountCode: "1025" },
      mkPaymentEntry({ entryType: "sale" }),
      chartByCode
    );
    expect(lines.some((l) => l.accountCode === "1025")).toBe(true);
  });

  it("โอนไม่ระบุบัญชี → default 1020", () => {
    const lines = toJournalLines(
      { payDate: "2026-08-01", amount: 1000, method: "transfer", bankAccountCode: null },
      mkPaymentEntry({ entryType: "purchase" }),
      chartByCode
    );
    expect(lines.some((l) => l.accountCode === "1020")).toBe(true);
  });

  it("เช็ค + ขาย → เช็ครับล่วงหน้า(1155) · เช็ค + ซื้อ → เช็คสั่งจ่ายล่วงหน้า(2220)", () => {
    const saleLines = toJournalLines(
      { payDate: "2026-08-01", amount: 200, method: "cheque", bankAccountCode: null },
      mkPaymentEntry({ entryType: "sale" }),
      chartByCode
    );
    expect(saleLines.some((l) => l.accountCode === "1155")).toBe(true);
    const purchaseLines = toJournalLines(
      { payDate: "2026-08-01", amount: 200, method: "cheque", bankAccountCode: null },
      mkPaymentEntry({ entryType: "purchase" }),
      chartByCode
    );
    expect(purchaseLines.some((l) => l.accountCode === "2220")).toBe(true);
  });

  it("entryType ไม่ใช่ sale/purchase → [] (defensive)", () => {
    const lines = toJournalLines(
      { payDate: "2026-08-01", amount: 100, method: "cash", bankAccountCode: null },
      mkPaymentEntry({ entryType: "unspecified" }),
      chartByCode
    );
    expect(lines).toEqual([]);
  });

  it("จำนวนเงินเป็น 0 → []", () => {
    const lines = toJournalLines(
      { payDate: "2026-08-01", amount: 0, method: "cash", bankAccountCode: null },
      mkPaymentEntry(),
      chartByCode
    );
    expect(lines).toEqual([]);
  });

  it("★ เฟส 10 (0.8) — payment.amount ที่ derive จาก fx (ไม่ใช่ integer กลม ๆ) → ยังคืนแค่ 2 บรรทัดเดิม สมดุลเป๊ะ ไม่มีขา FX เพิ่ม (toJournalLines ไม่รู้จัก/ไม่แก้เลยแม้แต่บรรทัดเดียว)", () => {
    const lines = toJournalLines(
      { payDate: "2026-08-01", amount: 3500, method: "cash", bankAccountCode: null }, // 100 USD × 35.0 invoice rate
      mkPaymentEntry({ entryType: "sale" }),
      chartByCode
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountCode: "1010", debit: 3500, credit: 0 });
    expect(lines[1]).toMatchObject({ accountCode: "1140", debit: 0, credit: 3500 });
  });
});

describe("toJournalPosting", () => {
  it("บิลขาย → book='receipt' (เล่มรับเงิน)", () => {
    const p = toJournalPosting(
      { payDate: "2026-08-01", amount: 400, method: "cash", bankAccountCode: null, notes: null },
      mkPaymentEntry({ entryType: "sale" }),
      chartByCode
    );
    expect(p.book).toBe("receipt");
    expect(p.totalDebit).toBe(400);
    expect(p.totalCredit).toBe(400);
  });

  it("บิลซื้อ → book='payment' (เล่มจ่ายเงิน)", () => {
    const p = toJournalPosting(
      { payDate: "2026-08-01", amount: 400, method: "cash", bankAccountCode: null, notes: null },
      mkPaymentEntry({ entryType: "purchase" }),
      chartByCode
    );
    expect(p.book).toBe("payment");
  });

  it("description: มี notes → ใช้ notes · ไม่มี → fallback เป็นชื่อคู่ค้า", () => {
    const withNotes = toJournalPosting(
      { payDate: "2026-08-01", amount: 100, method: "cash", bankAccountCode: null, notes: "รับเงินงวดที่ 1" },
      mkPaymentEntry(),
      chartByCode
    );
    expect(withNotes.description).toBe("รับเงินงวดที่ 1");

    const withoutNotes = toJournalPosting(
      { payDate: "2026-08-01", amount: 100, method: "cash", bankAccountCode: null, notes: null },
      mkPaymentEntry({ counterpartyName: "ร้าน ก" }),
      chartByCode
    );
    expect(withoutNotes.description).toBe("ร้าน ก");
  });
});

// ---------------------------------------------------------------------
// data layer (mock DB — pattern เดียวกับ manual-journal.test.ts)
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;

/** fake in-memory DB — จำลอง bill_entries/bill_entry_lines/bill_payments/customer_bank_accounts
 *  ให้พอสำหรับทดสอบ flow เต็ม (record → void → outstanding กลับมาเดิม) */
function makeFakeDb(seed: {
  entries?: Record<string, Row>;
  lines?: Record<string, Row[]>;
  bankAccounts?: Record<string, Row>;
  payments?: Row[];
  /** เฟส 3 ส่วน J (0.6) — CN/DN ที่ recordBillPayment ต้อง re-fetch ก่อน insert เสมอ (read-only ในเทสต์นี้) */
  creditDebitNotes?: Row[];
  creditDebitNoteLines?: Row[];
}): { db: SupabaseClient; payments: Row[] } {
  const entries = seed.entries ?? {};
  const lines = seed.lines ?? {};
  const bankAccounts = seed.bankAccounts ?? {};
  const payments: Row[] = [...(seed.payments ?? [])];
  const creditDebitNotes: Row[] = seed.creditDebitNotes ?? [];
  const creditDebitNoteLines: Row[] = seed.creditDebitNoteLines ?? [];
  let nextId = 1;

  type Filter = { col: string; op: "eq" | "is" | "in" | "lte"; val: unknown };

  function matchRow(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
      if (f.op === "eq") return row[f.col] === f.val;
      if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
      // ★ เฟส 10b (0.5) — .lte("pay_date", asOfDate) กรอง payments ที่วันที่เกิดจริง ณ ตอนตั้งรายงาน
      if (f.op === "lte") return (row[f.col] as string) <= (f.val as string);
      // op === "is"
      if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
      return row[f.col] === f.val;
    });
  }

  function qb(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      filters.push({ col: c, op: "eq", val: v });
      return api;
    };
    api.is = (c: string, v: unknown) => {
      filters.push({ col: c, op: "is", val: v });
      return api;
    };
    api.in = (c: string, v: unknown[]) => {
      filters.push({ col: c, op: "in", val: v });
      return api;
    };
    api.lte = (c: string, v: unknown) => {
      filters.push({ col: c, op: "lte", val: v });
      return api;
    };
    api.order = () => api;
    api.limit = () => api;
    api.insert = (p: Row) => {
      mode = "insert";
      payload = p;
      return api;
    };
    api.update = (p: Row) => {
      mode = "update";
      payload = p;
      return api;
    };
    api.maybeSingle = () => {
      if (mode === "insert") {
        const id = `bp${nextId++}`;
        const row: Row = { id, deleted_at: null, ...payload };
        if (table === "bill_payments") payments.push(row);
        return Promise.resolve({ data: { id }, error: null });
      }
      if (table === "bill_entries") {
        const idFilter = filters.find((f) => f.col === "id");
        const row = idFilter ? entries[idFilter.val as string] : undefined;
        return Promise.resolve({ data: row ?? null, error: null });
      }
      if (table === "bill_payments") {
        // ★ คืนทั้งแถว (ไม่ใช่แค่ id) — getPaymentScope ต้องอ่าน entry_id ด้วย (ดู bill-payments.ts)
        const row = payments.find((r) => matchRow(r, filters));
        return Promise.resolve({ data: row ? { ...row } : null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = [];
      if (mode === "update" && table === "bill_payments") {
        for (const row of payments) {
          if (matchRow(row, filters)) Object.assign(row, payload);
        }
        data = null;
      } else if (table === "bill_entry_lines") {
        const entryFilter = filters.find((f) => f.col === "entry_id");
        data = entryFilter ? lines[entryFilter.val as string] ?? [] : [];
      } else if (table === "bill_payments") {
        data = payments.filter((r) => matchRow(r, filters));
      } else if (table === "customer_bank_accounts") {
        const idsFilter = filters.find((f) => f.col === "id" && f.op === "in");
        const ids = (idsFilter?.val as string[]) ?? [];
        data = ids.map((id) => bankAccounts[id] ?? { id, account_code: null });
      } else if (table === "credit_debit_notes") {
        data = creditDebitNotes.filter((r) => matchRow(r, filters));
      } else if (table === "credit_debit_note_lines") {
        data = creditDebitNoteLines.filter((r) => matchRow(r, filters));
      }
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }
  return { db: { from: (t: string) => qb(t) } as unknown as SupabaseClient, payments };
}

describe("getBillPaymentScope", () => {
  it("พบบิล → map entryType/paymentMethod/status ถูกต้อง", async () => {
    const { db } = makeFakeDb({
      entries: { e1: { customer_id: "c1", entry_type: "sale", payment_method: "credit", status: "confirmed" } },
    });
    const scope = await getBillPaymentScope(db, "t1", "e1");
    expect(scope).toEqual({
      customerId: "c1",
      entryType: "sale",
      paymentMethod: "credit",
      status: "confirmed",
      docNo: null,
      currency: null,
      fxRate: null,
    });
  });

  it("ไม่พบบิล → null", async () => {
    const { db } = makeFakeDb({ entries: {} });
    const scope = await getBillPaymentScope(db, "t1", "missing");
    expect(scope).toBeNull();
  });
});

describe("getPaymentScope", () => {
  it("derive customerId/entryId จาก payment id ตรง ๆ (อ่านสดผ่านบิลต้นทางจริง)", async () => {
    const { db } = makeFakeDb({
      entries: { e1: { customer_id: "c1", entry_type: "sale", payment_method: "credit", status: "confirmed" } },
      payments: [
        { id: "p1", tenant_id: "t1", entry_id: "e1", customer_id: "c1", pay_date: "2026-08-01", amount: 400, method: "cash", bank_account_id: null, notes: null, created_at: "2026-08-01T00:00:00Z", deleted_at: null },
      ],
    });
    const scope = await getPaymentScope(db, "t1", "p1");
    expect(scope).toEqual({ customerId: "c1", entryId: "e1" });
  });

  it("ไม่พบ payment → null", async () => {
    const { db } = makeFakeDb({ payments: [] });
    const scope = await getPaymentScope(db, "t1", "missing");
    expect(scope).toBeNull();
  });

  it("payment ถูกยกเลิกไปแล้ว (deleted_at) → null", async () => {
    const { db } = makeFakeDb({
      payments: [
        { id: "p1", tenant_id: "t1", entry_id: "e1", customer_id: "c1", pay_date: "2026-08-01", amount: 400, method: "cash", bank_account_id: null, notes: null, created_at: "2026-08-01T00:00:00Z", deleted_at: "2026-08-02T00:00:00Z" },
      ],
    });
    const scope = await getPaymentScope(db, "t1", "p1");
    expect(scope).toBeNull();
  });

  it(
    "★★★ IDOR — payment ผูกกับ entry ของลูกค้าจริง (c2) ไม่ใช่ลูกค้าอื่น (c1) แม้ payment แถวอื่นจะผูกกับ " +
      "entry ของ c1 ก็ตาม (derive จาก payment id ที่ระบุเท่านั้น ไม่ปนกับ payment/entry อื่น)",
    async () => {
      const { db } = makeFakeDb({
        entries: {
          e1: { customer_id: "c1", entry_type: "sale", payment_method: "credit", status: "confirmed" },
          e2: { customer_id: "c2", entry_type: "sale", payment_method: "credit", status: "confirmed" },
        },
        payments: [
          { id: "p1", tenant_id: "t1", entry_id: "e1", customer_id: "c1", pay_date: "2026-08-01", amount: 100, method: "cash", bank_account_id: null, notes: null, created_at: "2026-08-01T00:00:00Z", deleted_at: null },
          { id: "p2", tenant_id: "t1", entry_id: "e2", customer_id: "c2", pay_date: "2026-08-01", amount: 200, method: "cash", bank_account_id: null, notes: null, created_at: "2026-08-01T00:00:00Z", deleted_at: null },
        ],
      });
      const scope = await getPaymentScope(db, "t1", "p2");
      expect(scope).toEqual({ customerId: "c2", entryId: "e2" });
    }
  );
});

describe("listBillPayments / listBillPaymentsForEntries", () => {
  it("join bankAccountCode จาก customer_bank_accounts ถูกต้อง", async () => {
    const { db } = makeFakeDb({
      payments: [
        {
          id: "p1",
          tenant_id: "t1",
          entry_id: "e1",
          customer_id: "c1",
          pay_date: "2026-08-01",
          amount: 500,
          method: "transfer",
          bank_account_id: "bank-1",
          notes: null,
          created_at: "2026-08-01T00:00:00Z",
          deleted_at: null,
        },
      ],
      bankAccounts: { "bank-1": { id: "bank-1", account_code: "1025" } },
    });
    const rows = await listBillPayments(db, "t1", "e1");
    expect(rows).toHaveLength(1);
    expect(rows[0].bankAccountCode).toBe("1025");
    expect(rows[0].amount).toBe(500);
  });

  it("listBillPaymentsForEntries → group ตาม entryId", async () => {
    const { db } = makeFakeDb({
      payments: [
        { id: "p1", tenant_id: "t1", entry_id: "e1", customer_id: "c1", pay_date: "2026-08-01", amount: 100, method: "cash", bank_account_id: null, notes: null, created_at: "2026-08-01T00:00:00Z", deleted_at: null },
        { id: "p2", tenant_id: "t1", entry_id: "e2", customer_id: "c1", pay_date: "2026-08-02", amount: 200, method: "cash", bank_account_id: null, notes: null, created_at: "2026-08-02T00:00:00Z", deleted_at: null },
        { id: "p3", tenant_id: "t1", entry_id: "e1", customer_id: "c1", pay_date: "2026-08-03", amount: 300, method: "cash", bank_account_id: null, notes: null, created_at: "2026-08-03T00:00:00Z", deleted_at: null },
      ],
    });
    const map = await listBillPaymentsForEntries(db, "t1", ["e1", "e2"]);
    expect(map.get("e1")).toHaveLength(2);
    expect(map.get("e2")).toHaveLength(1);
  });

  // -----------------------------------------------------------------
  // asOfDate (เฟส 10b, 0.5) — filter query จริง (.lte("pay_date", asOfDate)) ไม่ส่ง = query เดิมทุกประการ
  // -----------------------------------------------------------------
  describe("asOfDate (0.5)", () => {
    function seedTwoPayments() {
      return makeFakeDb({
        payments: [
          { id: "p1", tenant_id: "t1", entry_id: "e1", customer_id: "c1", pay_date: "2026-08-01", amount: 100, method: "cash", bank_account_id: null, notes: null, created_at: "2026-08-01T00:00:00Z", deleted_at: null },
          { id: "p2", tenant_id: "t1", entry_id: "e1", customer_id: "c1", pay_date: "2026-08-15", amount: 200, method: "cash", bank_account_id: null, notes: null, created_at: "2026-08-15T00:00:00Z", deleted_at: null },
        ],
      });
    }

    it("listBillPayments ★ ไม่ส่ง asOfDate → ผลลัพธ์เหมือนก่อนแก้เป๊ะ (regression บังคับ)", async () => {
      const { db } = seedTwoPayments();
      const rows = await listBillPayments(db, "t1", "e1");
      expect(rows).toHaveLength(2);
    });

    it("listBillPayments ส่ง asOfDate ตัดก่อนวันที่ payment งวดที่ 2 → เห็นแค่งวดแรก", async () => {
      const { db } = seedTwoPayments();
      const rows = await listBillPayments(db, "t1", "e1", "2026-08-10");
      expect(rows).toHaveLength(1);
      expect(rows[0].payDate).toBe("2026-08-01");
    });

    it("listBillPayments ส่ง asOfDate ตรงกับวันที่ payment เป๊ะ → นับรวม (<=, inclusive)", async () => {
      const { db } = seedTwoPayments();
      const rows = await listBillPayments(db, "t1", "e1", "2026-08-01");
      expect(rows).toHaveLength(1);
    });

    it("listBillPaymentsForEntries ★ ไม่ส่ง asOfDate → ผลลัพธ์เหมือนก่อนแก้เป๊ะ (regression บังคับ)", async () => {
      const { db } = seedTwoPayments();
      const map = await listBillPaymentsForEntries(db, "t1", ["e1"]);
      expect(map.get("e1")).toHaveLength(2);
    });

    it("listBillPaymentsForEntries ส่ง asOfDate → กรองก่อนคืนผล (ไม่ใช่กรองหลัง fetch)", async () => {
      const { db } = seedTwoPayments();
      const map = await listBillPaymentsForEntries(db, "t1", ["e1"], "2026-08-10");
      expect(map.get("e1")).toHaveLength(1);
      expect(map.get("e1")?.[0].payDate).toBe("2026-08-01");
    });
  });

  it("entryIds ว่าง → Map ว่าง (ไม่ query)", async () => {
    const { db } = makeFakeDb({});
    const map = await listBillPaymentsForEntries(db, "t1", []);
    expect(map.size).toBe(0);
  });

  it(
    "entryIds เกิน chunk limit (300 ตัว) → ตัดเป็นก้อนแล้วรวมผลครบ ไม่ตกหล่น (regression ของบั๊ก .in() " +
      "ยาวเกิน limit ของ PostgREST — ดู commit 7ab9f91, เจอครั้งแรกใน listEntries())",
    async () => {
      const entryIds = Array.from({ length: 300 }, (_, i) => `e${i}`);
      // mock ที่จำลอง PostgREST ปฏิเสธถ้า .in() ยาวเกิน 150 ตัว — พิสูจน์ว่า listBillPaymentsForEntries
      // ต้องตัดก้อนเอง ไม่ใช่ยัด entryIds ทั้งหมดลง .in() เดียว
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function qb(): any {
        let inIds: string[] | null = null;
        const api: any = {};
        api.select = () => api;
        api.eq = () => api;
        api.is = () => api;
        api.order = () => api;
        api.limit = () => api;
        api.in = (_c: string, v: string[]) => {
          inIds = v;
          return api;
        };
        api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
          if (!inIds || inIds.length > 150) {
            return Promise.resolve({ data: null, error: { message: "Bad Request" } }).then(onF);
          }
          const rows = inIds.map((id) => ({
            id: `p-${id}`,
            tenant_id: "t1",
            entry_id: id,
            customer_id: "c1",
            pay_date: "2026-08-01",
            amount: 100,
            method: "cash",
            bank_account_id: null,
            notes: null,
            created_at: "2026-08-01T00:00:00Z",
            deleted_at: null,
          }));
          return Promise.resolve({ data: rows, error: null }).then(onF);
        };
        return api;
      }
      const db = { from: () => qb() } as unknown as SupabaseClient;
      const map = await listBillPaymentsForEntries(db, "t1", entryIds);
      expect(map.size).toBe(300);
      for (const id of entryIds) {
        expect(map.get(id)).toHaveLength(1);
      }
    }
  );
});

describe("recordBillPayment", () => {
  function seedSaleEntry(net: { amount: number; vat: number; wht: number } = { amount: 1000, vat: 0, wht: 0 }) {
    return {
      entries: {
        e1: { customer_id: "c1", entry_type: "sale", payment_method: "credit", status: "confirmed" },
      },
      lines: {
        e1: [{ amount: net.amount, vat_amount: net.vat, wht_amount: net.wht }],
      },
    };
  }

  it("ไม่พบบิล → ปฏิเสธ", async () => {
    const { db } = makeFakeDb({ entries: {} });
    const res = await recordBillPayment(db, "t1", "missing", { payDate: "2026-08-01", amount: 100, method: "cash" });
    expect(res.ok).toBe(false);
  });

  it("★ บิล FX (currency ตั้งไว้) — insert สำเร็จ + amount derive จาก fxAmount×entry.fxRate (อัตราบิล) + เก็บ currency/fx_rate(settlement)/fx_amount (เทสต์บังคับ 0.8)", async () => {
    const { db, payments } = makeFakeDb({
      entries: {
        e1: {
          customer_id: "c1",
          entry_type: "sale",
          payment_method: "credit",
          status: "confirmed",
          currency: "USD",
          fx_rate: 35.0,
        },
      },
      lines: { e1: [{ amount: 3500, vat_amount: 0, wht_amount: 0 }] }, // net=3500 (=100×35.0)
    });
    const res = await recordBillPayment(db, "t1", "e1", {
      payDate: "2026-08-01",
      amount: 999999, // ★ ต้องถูกละเลย — server ต้อง derive จาก fxAmount×invoiceFxRate เท่านั้น
      method: "cash",
      fxAmount: 100,
      fxRate: 36.0, // settlement rate (ต่างจาก invoice rate 35.0)
    });
    expect(res.ok).toBe(true);
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(3500); // 100 × 35.0 (invoice rate) ไม่ใช่ 100 × 36.0
    expect(payments[0].currency).toBe("USD");
    expect(payments[0].fx_rate).toBe(36.0); // settlement rate ของงวดนี้ เก็บแยกจาก entry.fx_rate
    expect(payments[0].fx_amount).toBe(100);
  });

  it("บิลไม่ eligible (ไม่ใช่ credit) → ปฏิเสธ ไม่ insert", async () => {
    const { db, payments } = makeFakeDb({
      entries: { e1: { customer_id: "c1", entry_type: "sale", payment_method: "cash", status: "confirmed" } },
      lines: { e1: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }] },
    });
    const res = await recordBillPayment(db, "t1", "e1", { payDate: "2026-08-01", amount: 100, method: "cash" });
    expect(res.ok).toBe(false);
    expect(payments).toHaveLength(0);
  });

  it("amount ≤ ยอดค้างชำระ → insert สำเร็จ", async () => {
    const { db, payments } = makeFakeDb(seedSaleEntry());
    const res = await recordBillPayment(db, "t1", "e1", { payDate: "2026-08-01", amount: 400, method: "cash" });
    expect(res.ok).toBe(true);
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(400);
    expect(payments[0].customer_id).toBe("c1"); // สำเนาจาก scope
  });

  it("★ amount เกินยอดค้างชำระ (คำนวณจาก DB จริง) → ปฏิเสธ ไม่ insert (เทสต์บังคับ 0.8)", async () => {
    const seed = seedSaleEntry();
    const { db, payments } = makeFakeDb({
      ...seed,
      payments: [
        { id: "p0", tenant_id: "t1", entry_id: "e1", customer_id: "c1", pay_date: "2026-07-01", amount: 700, method: "cash", bank_account_id: null, notes: null, created_at: "2026-07-01T00:00:00Z", deleted_at: null },
      ],
    });
    // ยอดเต็ม 1000 - จ่ายไปแล้ว 700 = ค้าง 300 → ขอจ่ายอีก 400 (เกิน)
    const res = await recordBillPayment(db, "t1", "e1", { payDate: "2026-08-01", amount: 400, method: "cash" });
    expect(res.ok).toBe(false);
    expect(payments).toHaveLength(1); // ไม่มี insert เพิ่ม
  });

  // -----------------------------------------------------------------
  // เฟส 3 ส่วน J (0.6) — re-fetch confirmed CN/DN จาก DB ก่อน insert เสมอ
  // -----------------------------------------------------------------
  it("★ มี CN confirmed แล้วของบิลนี้ → ยอดค้างชำระลดลงตามยอด CN (re-fetch จาก DB จริง)", async () => {
    const seed = seedSaleEntry(); // net = 1000
    const { db, payments } = makeFakeDb({
      ...seed,
      creditDebitNotes: [
        {
          id: "n1", tenant_id: "t1", entry_id: "e1", customer_id: "c1", doc_type: "credit_note",
          doc_date: "2026-07-01", doc_no: null, reason: "สินค้าชำรุด", status: "confirmed",
          created_at: "2026-07-01T00:00:00Z", confirmed_at: "2026-07-01T00:00:00Z", deleted_at: null,
        },
      ],
      creditDebitNoteLines: [
        { id: "nl1", note_id: "n1", tenant_id: "t1", line_no: 1, description: null, account_code: "4010", account_name: null, amount: 300, vat_amount: 0 },
      ],
    });
    // ยอดค้างจริง = 1000 - 300(CN) = 700 → ขอ 800 ต้องเกิน
    const overpay = await recordBillPayment(db, "t1", "e1", { payDate: "2026-08-01", amount: 800, method: "cash" });
    expect(overpay.ok).toBe(false);
    expect(payments).toHaveLength(0);

    // ขอเท่ายอดค้างจริงพอดี (700) ต้องผ่าน
    const ok = await recordBillPayment(db, "t1", "e1", { payDate: "2026-08-01", amount: 700, method: "cash" });
    expect(ok.ok).toBe(true);
    expect(payments).toHaveLength(1);
  });

  it("มี CN แต่ยัง draft (ไม่ confirmed) → ไม่กระทบยอดค้างชำระ", async () => {
    const seed = seedSaleEntry(); // net = 1000
    const { db } = makeFakeDb({
      ...seed,
      creditDebitNotes: [
        {
          id: "n1", tenant_id: "t1", entry_id: "e1", customer_id: "c1", doc_type: "credit_note",
          doc_date: "2026-07-01", doc_no: null, reason: "ร่าง", status: "draft",
          created_at: "2026-07-01T00:00:00Z", confirmed_at: null, deleted_at: null,
        },
      ],
      creditDebitNoteLines: [
        { id: "nl1", note_id: "n1", tenant_id: "t1", line_no: 1, description: null, account_code: "4010", account_name: null, amount: 300, vat_amount: 0 },
      ],
    });
    // draft CN ไม่กระทบ → ยอดค้างยังเต็ม 1000
    const res = await recordBillPayment(db, "t1", "e1", { payDate: "2026-08-01", amount: 1000, method: "cash" });
    expect(res.ok).toBe(true);
  });
});

describe("voidBillPayment", () => {
  it("ไม่พบรายการ (หรือถูกยกเลิกไปแล้ว) → ปฏิเสธ", async () => {
    const { db } = makeFakeDb({ payments: [] });
    const res = await voidBillPayment(db, "t1", "missing");
    expect(res.ok).toBe(false);
  });

  it("★ รับเงินบางส่วน → void → ยอดค้างชำระกลับมาเท่าเดิม (payment ที่ deleted_at ไม่ถูกนับ) — เทสต์บังคับ", async () => {
    const { db, payments } = makeFakeDb({
      entries: { e1: { customer_id: "c1", entry_type: "sale", payment_method: "credit", status: "confirmed" } },
      lines: { e1: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }] },
    });

    // 1) บันทึกรับเงินบางส่วน
    const rec = await recordBillPayment(db, "t1", "e1", { payDate: "2026-08-01", amount: 400, method: "cash" });
    expect(rec.ok).toBe(true);
    const paymentId = rec.ok ? rec.id : "";

    const before = await listBillPayments(db, "t1", "e1");
    const outstandingBefore = billOutstanding({ lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] }, before);
    expect(outstandingBefore).toBe(600);

    // 2) ยกเลิก (void) รายการที่เพิ่งบันทึก
    const voided = await voidBillPayment(db, "t1", paymentId);
    expect(voided.ok).toBe(true);

    // 3) ยอดค้างชำระต้องกลับมาเหมือนไม่เคยชำระ
    const after = await listBillPayments(db, "t1", "e1");
    expect(after).toHaveLength(0); // payment ที่ deleted_at ไม่ถูกนับ/ไม่แสดงในรายการอีก
    const outstandingAfter = billOutstanding({ lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] }, after);
    expect(outstandingAfter).toBe(1000);

    // 4) รับเงินใหม่ได้เต็มยอดอีกครั้ง (พิสูจน์ว่ายอดค้างชำระกลับมาเต็มจริง ไม่ใช่ค้างเศษ)
    const rec2 = await recordBillPayment(db, "t1", "e1", { payDate: "2026-08-05", amount: 1000, method: "cash" });
    expect(rec2.ok).toBe(true);
    expect(payments.filter((p) => p.deleted_at === null)).toHaveLength(1);
  });

  it("void แล้ว void ซ้ำ → ปฏิเสธ (ไม่พบรายการที่ยังไม่ยกเลิก)", async () => {
    const { db } = makeFakeDb({
      payments: [
        { id: "p1", tenant_id: "t1", entry_id: "e1", customer_id: "c1", pay_date: "2026-08-01", amount: 400, method: "cash", bank_account_id: null, notes: null, created_at: "2026-08-01T00:00:00Z", deleted_at: null },
      ],
    });
    const first = await voidBillPayment(db, "t1", "p1");
    expect(first.ok).toBe(true);
    const second = await voidBillPayment(db, "t1", "p1");
    expect(second.ok).toBe(false);
  });
});
