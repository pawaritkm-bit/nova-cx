import { describe, it, expect } from "vitest";
import {
  resolveDocType,
  buildSalesDocumentPayload,
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
