import { describe, it, expect } from "vitest";
import {
  resolveDocType,
  buildSalesDocumentPayload,
  resolvePurchaseDocType,
  buildPurchaseDocumentPayload,
  type MapperLineInput,
} from "@/lib/integrations/flowaccount-mapper";

/**
 * flowaccount-mapper.ts — pure mapper (ไม่แตะ DB/network)
 *   ครอบ: resolveDocType ทุก payment method + buildSalesDocumentPayload mapping ปกติ/reject ทุกกรณี
 */
describe("resolveDocType — วิธีจ่าย/รับเงิน → ชนิดเอกสาร", () => {
  it("credit → tax_invoice", () => {
    expect(resolveDocType("credit")).toBe("tax_invoice");
  });
  it("null (ยังไม่ระบุ) → tax_invoice (ถือเป็นเชื่อ ตาม convention journal.ts)", () => {
    expect(resolveDocType(null)).toBe("tax_invoice");
  });
  it("cash/transfer/cheque → cash_sale", () => {
    expect(resolveDocType("cash")).toBe("cash_sale");
    expect(resolveDocType("transfer")).toBe("cash_sale");
    expect(resolveDocType("cheque")).toBe("cash_sale");
  });
});

describe("buildSalesDocumentPayload", () => {
  const line = (p: Partial<MapperLineInput> = {}): MapperLineInput => ({
    description: p.description ?? "ค่าบริการ",
    amount: p.amount ?? 100,
    vatAmount: p.vatAmount ?? 7,
    vatType: p.vatType ?? "vat",
  });

  const customer = { name: "บริษัท ทดสอบ จำกัด", taxId: "0994000000001", address: "123 ถนนทดสอบ" };
  const entry = { docNo: "INV-1", docDate: "2026-07-01", paymentMethod: "credit" as const };

  it("mapping ปกติ (เชื่อ) → tax_invoice, ยอดรวมถูกต้อง", () => {
    const res = buildSalesDocumentPayload(entry, [line({ amount: 100, vatAmount: 7 })], customer);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.docType).toBe("tax_invoice");
    expect(res.body.contactTaxId).toBe("0994000000001");
    expect(res.body.subTotal).toBe(100);
    expect(res.body.vatAmount).toBe(7);
    expect(res.body.grandTotal).toBe(107);
    expect(res.body.isVat).toBe(true);
    expect(res.body.creditType).toBe(1);
    expect(res.body.documentShowWithholdingTax).toBe(false);
    expect(res.body.publishedOn).toBe("2026-07-01");
    const items = res.body.items as unknown[];
    expect(items).toHaveLength(1);
  });

  it("mapping ปกติ (รับเงินแล้ว/โอน) → cash_sale, creditType 3", () => {
    const res = buildSalesDocumentPayload(
      { ...entry, paymentMethod: "transfer" },
      [line({ amount: 200, vatAmount: 14 })],
      customer
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.docType).toBe("cash_sale");
    expect(res.body.creditType).toBe(3);
    expect(res.body.creditDays).toBe(0);
  });

  it("ผสม VAT/ไม่มี VAT ในใบเดียว → รวมยอดถูก, isVat=true ถ้ามี VAT รวม > 0", () => {
    const res = buildSalesDocumentPayload(
      entry,
      [line({ amount: 100, vatAmount: 7, vatType: "vat" }), line({ amount: 50, vatAmount: 0, vatType: "novat" })],
      customer
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.subTotal).toBe(150);
    expect(res.body.vatAmount).toBe(7);
    expect(res.body.grandTotal).toBe(157);
    expect(res.body.isVat).toBe(true);
    const items = res.body.items as unknown[];
    expect(items).toHaveLength(2);
  });

  it("ไม่มีเลขภาษีลูกค้า → reject missing_customer_tax_id", () => {
    const res = buildSalesDocumentPayload(entry, [line()], { ...customer, taxId: null });
    expect(res).toEqual({ ok: false, reason: "missing_customer_tax_id" });
  });

  it("เลขภาษีลูกค้าไม่ครบ 13 หลัก → reject missing_customer_tax_id", () => {
    const res = buildSalesDocumentPayload(entry, [line()], { ...customer, taxId: "12345" });
    expect(res).toEqual({ ok: false, reason: "missing_customer_tax_id" });
  });

  it("ไม่มี line ที่มีมูลค่า > 0 → reject no_value_lines", () => {
    const res = buildSalesDocumentPayload(
      entry,
      [line({ amount: 0, vatAmount: 0 })],
      customer
    );
    expect(res).toEqual({ ok: false, reason: "no_value_lines" });
  });

  it("ไม่มี line เลย → reject no_value_lines", () => {
    const res = buildSalesDocumentPayload(entry, [], customer);
    expect(res).toEqual({ ok: false, reason: "no_value_lines" });
  });

  it("ไม่มีวันที่บิล (docDate null) → reject missing_doc_date", () => {
    const res = buildSalesDocumentPayload({ ...entry, docDate: null }, [line()], customer);
    expect(res).toEqual({ ok: false, reason: "missing_doc_date" });
  });

  it("ฟังก์ชัน pure — เรียกซ้ำด้วย input เดิม ได้ผลเดิมเสมอ ไม่มี side effect", () => {
    const res1 = buildSalesDocumentPayload(entry, [line()], customer);
    const res2 = buildSalesDocumentPayload(entry, [line()], customer);
    expect(res1).toEqual(res2);
  });
});

/**
 * เฟส 5 ส่วน Q (docs/06-accounting-features-roadmap.md, T27) — พารามิเตอร์ `maps` ใหม่ (optional)
 *   ★ regression-critical: ไม่ส่ง maps / ส่ง {} ต้องได้ผลลัพธ์เหมือนก่อนเฟสนี้เป๊ะ 100% (byte-ต่อ-byte
 *     ของ sellChartOfAccountCode/items[].id) — เทียบตรงกับพฤติกรรมเดิมของ M1/M2 (ค่า "" และ 0 เสมอ)
 */
describe("buildSalesDocumentPayload — maps (เฟส 5 ส่วน Q, T27)", () => {
  const customer = { name: "บริษัท ทดสอบ จำกัด", taxId: "0994000000001", address: "123 ถนนทดสอบ" };
  const entry = { docNo: "INV-1", docDate: "2026-07-01", paymentMethod: "credit" as const };

  const lineWithCodes = (p: Partial<MapperLineInput> = {}): MapperLineInput => ({
    description: p.description ?? "ค่าบริการ",
    amount: p.amount ?? 100,
    vatAmount: p.vatAmount ?? 7,
    vatType: p.vatType ?? "vat",
    accountCode: p.accountCode ?? "4010",
    productId: p.productId ?? "prod-1",
  });

  it('ไม่ส่ง maps เลย → sellChartOfAccountCode/items[].id เหมือนก่อนเฟสนี้เป๊ะ ("" และ 0)', () => {
    const res = buildSalesDocumentPayload(entry, [lineWithCodes()], customer);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.sellChartOfAccountCode).toBe("");
    expect(items[0]!.id).toBe(0);
    expect(items[0]!.buyChartOfAccountCode).toBe("");
  });

  it("ส่ง maps={} (ว่างเปล่า) → ผลลัพธ์เหมือนไม่ส่ง maps เป๊ะ (regression บังคับ)", () => {
    const resNoMaps = buildSalesDocumentPayload(entry, [lineWithCodes()], customer);
    const resEmptyMaps = buildSalesDocumentPayload(entry, [lineWithCodes()], customer, {});
    expect(resEmptyMaps).toEqual(resNoMaps);
  });

  it("เทียบ byte-ต่อ-byte กับ M1/M2 เดิม (ไม่มี accountCode/productId บนบรรทัดเลยด้วยซ้ำ) → เหมือนเดิมทุกฟิลด์", () => {
    // เคสนี้จำลอง MapperLineInput แบบเดิมก่อนเฟสนี้ (ไม่มี accountCode/productId เลย — undefined)
    const legacyLine: MapperLineInput = { description: "ค่าบริการ", amount: 100, vatAmount: 7, vatType: "vat" };
    const res = buildSalesDocumentPayload(entry, [legacyLine], customer);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      id: 0,
      type: 1,
      name: "ค่าบริการ",
      description: "ค่าบริการ",
      quantity: 1,
      unitName: "รายการ",
      pricePerUnit: 100,
      total: 100,
      sellChartOfAccountCode: "",
      buyChartOfAccountCode: "",
    });
  });

  it("มี mapping ตรง accountCode/productId ของบรรทัด → เติม sellChartOfAccountCode/items[].id ถูกต้อง", () => {
    const res = buildSalesDocumentPayload(entry, [lineWithCodes()], customer, {
      accountMap: { "4010": "SALE-01" },
      productMap: { "prod-1": "555" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items[0]!.sellChartOfAccountCode).toBe("SALE-01");
    expect(items[0]!.id).toBe(555);
    // buyChartOfAccountCode ยังว่างเสมอ (mapping ฝั่งขายไม่แตะ — เป็นของ mapper บิลซื้อในอนาคต)
    expect(items[0]!.buyChartOfAccountCode).toBe("");
  });

  it("มี mapping แต่ตรงแค่บางบรรทัด (ไม่ใช่ทุกบรรทัด) → เติมเฉพาะบรรทัดที่ map เจอ บรรทัดอื่นยังว่างเหมือนเดิม", () => {
    const res = buildSalesDocumentPayload(
      entry,
      [
        lineWithCodes({ accountCode: "4010", productId: "prod-1", amount: 100, vatAmount: 7 }),
        lineWithCodes({ accountCode: "5010", productId: "prod-2", amount: 50, vatAmount: 0, vatType: "novat" }),
      ],
      customer,
      { accountMap: { "4010": "SALE-01" }, productMap: { "prod-1": "555" } }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    // บรรทัดแรก: map เจอทั้งบัญชี+สินค้า
    expect(items[0]!.sellChartOfAccountCode).toBe("SALE-01");
    expect(items[0]!.id).toBe(555);
    // บรรทัดที่สอง: ไม่มี mapping ตรง (5010/prod-2 ไม่อยู่ใน maps) → ยังว่าง/0 เหมือนเดิม
    expect(items[1]!.sellChartOfAccountCode).toBe("");
    expect(items[1]!.id).toBe(0);
  });

  it("บรรทัดไม่มี accountCode/productId (null) แม้มี maps ที่ไม่ว่าง → ยังว่าง/0 เหมือนเดิม (ไม่ throw)", () => {
    const lineWithoutCodes: MapperLineInput = {
      description: "ค่าบริการ",
      amount: 100,
      vatAmount: 7,
      vatType: "vat",
      accountCode: null,
      productId: null,
    };
    const res = buildSalesDocumentPayload(entry, [lineWithoutCodes], customer, {
      accountMap: { "4010": "SALE-01" },
      productMap: { "prod-1": "555" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items[0]!.sellChartOfAccountCode).toBe("");
    expect(items[0]!.id).toBe(0);
  });

  it("flowaccount_product_id ที่ map ไว้ไม่ใช่ตัวเลข (parse ไม่ได้) → id fallback เป็น 0 ไม่ throw", () => {
    const res = buildSalesDocumentPayload(entry, [lineWithCodes()], customer, {
      productMap: { "prod-1": "not-a-number" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items[0]!.id).toBe(0);
  });
});

/**
 * เฟส 5 ส่วน P (docs/06-accounting-features-roadmap.md, T32) — บิลซื้อ/ค่าใช้จ่าย
 *   ★★ decision 0.6 (สำคัญที่สุด) ★★ — contact ของเอกสารต้องมาจาก "ผู้ขาย/vendor" (entry.counterpartyName/
 *   counterpartyTaxId) ไม่ใช่ "ลูกค้า NOVA-CX" (customers) — ตั้งชื่อ fixture ต่างกันชัดเจน
 *   (บริษัท ผู้ขาย ทดสอบ จำกัด ≠ บริษัท ลูกค้า ทดสอบ จำกัด) กันสลับผิดฝั่งโดยไม่ตั้งใจ
 */
describe("resolvePurchaseDocType — วิธีจ่าย → ชนิดเอกสารซื้อ", () => {
  it("credit → purchase_bill (ค้างจ่าย)", () => {
    expect(resolvePurchaseDocType("credit")).toBe("purchase_bill");
  });
  it("null (ยังไม่ระบุ) → purchase_bill (ถือเป็นเชื่อ)", () => {
    expect(resolvePurchaseDocType(null)).toBe("purchase_bill");
  });
  it("cash/transfer/cheque → cash_expense (จ่ายแล้ว)", () => {
    expect(resolvePurchaseDocType("cash")).toBe("cash_expense");
    expect(resolvePurchaseDocType("transfer")).toBe("cash_expense");
    expect(resolvePurchaseDocType("cheque")).toBe("cash_expense");
  });
});

describe("buildPurchaseDocumentPayload", () => {
  const line = (p: Partial<MapperLineInput> = {}): MapperLineInput => ({
    description: p.description ?? "ค่าซื้อวัสดุ",
    amount: p.amount ?? 100,
    vatAmount: p.vatAmount ?? 7,
    vatType: p.vatType ?? "vat",
  });

  // ★ ตั้งใจตั้งชื่อ "ผู้ขาย" ให้ต่างจาก "ลูกค้า" ในเทสต์ฝั่งขายชัดเจน (กันสลับผิด decision 0.6)
  const vendorFixture = { name: "บริษัท ผู้ขาย ทดสอบ จำกัด", taxId: "0994111111111" };
  // ลูกค้า NOVA-CX (เจ้าของ FlowAccount instance/credential) — ต้อง "ไม่" ถูกใช้เป็น contact ของบิลซื้อ
  const novaCustomerFixture = { name: "บริษัท ลูกค้า ทดสอบ จำกัด", taxId: "0994222222222", address: "ที่อยู่ลูกค้า" };
  const entry = { docNo: "PB-1", docDate: "2026-07-01", paymentMethod: "credit" as const };

  it("mapping ปกติ (เชื่อ) → purchase_bill, contact = ผู้ขาย (ไม่ใช่ลูกค้า)", () => {
    const res = buildPurchaseDocumentPayload(entry, [line({ amount: 100, vatAmount: 7 })], vendorFixture);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.docType).toBe("purchase_bill");
    expect(res.body.contactTaxId).toBe("0994111111111");
    expect(res.body.contactName).toBe("บริษัท ผู้ขาย ทดสอบ จำกัด");
    // ★ ยืนยันตรงๆ ว่าไม่ได้หลุดไปใช้ข้อมูลลูกค้า NOVA-CX
    expect(res.body.contactTaxId).not.toBe(novaCustomerFixture.taxId);
    expect(res.body.contactName).not.toBe(novaCustomerFixture.name);
    expect(res.body.subTotal).toBe(100);
    expect(res.body.vatAmount).toBe(7);
    expect(res.body.grandTotal).toBe(107);
    expect(res.body.isVat).toBe(true);
    expect(res.body.creditType).toBe(1);
    expect(res.body.documentShowWithholdingTax).toBe(false);
    expect(res.body.publishedOn).toBe("2026-07-01");
  });

  it("ไม่มีคอลัมน์ที่อยู่ผู้ขาย (decision 0.15) → contactAddress เป็นค่าว่างเสมอ", () => {
    const res = buildPurchaseDocumentPayload(entry, [line()], vendorFixture);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.contactAddress).toBe("");
  });

  it("มี mapping ผังบัญชี → เติม buyChartOfAccountCode (ไม่ใช่ sellChartOfAccountCode)", () => {
    const lineWithCode: MapperLineInput = {
      description: "ค่าซื้อวัสดุ",
      amount: 100,
      vatAmount: 7,
      vatType: "vat",
      accountCode: "5010",
      productId: "prod-buy-1",
    };
    const res = buildPurchaseDocumentPayload(entry, [lineWithCode], vendorFixture, {
      accountMap: { "5010": "BUY-01" },
      productMap: { "prod-buy-1": "777" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items[0]!.buyChartOfAccountCode).toBe("BUY-01");
    expect(items[0]!.id).toBe(777);
    expect(items[0]!.sellChartOfAccountCode).toBe(""); // ★ ต้องว่างเสมอฝั่งซื้อ
  });

  it("mapping ปกติ (จ่ายแล้ว/โอน) → cash_expense, creditType 3", () => {
    const res = buildPurchaseDocumentPayload(
      { ...entry, paymentMethod: "transfer" },
      [line({ amount: 200, vatAmount: 14 })],
      vendorFixture
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.docType).toBe("cash_expense");
    expect(res.body.creditType).toBe(3);
    expect(res.body.creditDays).toBe(0);
  });

  it("ไม่มีเลขภาษีผู้ขาย → reject missing_vendor_tax_id", () => {
    const res = buildPurchaseDocumentPayload(entry, [line()], { ...vendorFixture, taxId: null });
    expect(res).toEqual({ ok: false, reason: "missing_vendor_tax_id" });
  });

  it("เลขภาษีผู้ขายไม่ครบ 13 หลัก → reject missing_vendor_tax_id", () => {
    const res = buildPurchaseDocumentPayload(entry, [line()], { ...vendorFixture, taxId: "12345" });
    expect(res).toEqual({ ok: false, reason: "missing_vendor_tax_id" });
  });

  it("ไม่มี line ที่มีมูลค่า > 0 → reject no_value_lines", () => {
    const res = buildPurchaseDocumentPayload(entry, [line({ amount: 0, vatAmount: 0 })], vendorFixture);
    expect(res).toEqual({ ok: false, reason: "no_value_lines" });
  });

  it("ไม่มี line เลย → reject no_value_lines", () => {
    const res = buildPurchaseDocumentPayload(entry, [], vendorFixture);
    expect(res).toEqual({ ok: false, reason: "no_value_lines" });
  });

  it("ไม่มีวันที่บิล (docDate null) → reject missing_doc_date", () => {
    const res = buildPurchaseDocumentPayload({ ...entry, docDate: null }, [line()], vendorFixture);
    expect(res).toEqual({ ok: false, reason: "missing_doc_date" });
  });

  it("ไม่ส่งข้อมูล WHT (decision 0.14) — ทุก field WHT เป็นค่าปิด/0", () => {
    const res = buildPurchaseDocumentPayload(entry, [line()], vendorFixture);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.documentShowWithholdingTax).toBe(false);
    expect(res.body.documentWithholdingTaxPercentage).toBe(0);
    expect(res.body.documentWithholdingTaxAmount).toBe(0);
  });

  it("ฟังก์ชัน pure — เรียกซ้ำด้วย input เดิม ได้ผลเดิมเสมอ ไม่มี side effect", () => {
    const res1 = buildPurchaseDocumentPayload(entry, [line()], vendorFixture);
    const res2 = buildPurchaseDocumentPayload(entry, [line()], vendorFixture);
    expect(res1).toEqual(res2);
  });
});
