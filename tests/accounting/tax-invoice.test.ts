import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * tax-invoice.ts — ใบกำกับภาษี (เต็มรูป/อย่างย่อ) wishlist backlog
 *   เน้น: eligibility (isTaxInvoiceEligible) · buildTaxInvoiceLinesFromBill (derive unitPrice=amount/quantity) ·
 *   validateIssueInput (บังคับผู้ซื้อเฉพาะเต็มรูป) · taxInvoiceGrandTotal/taxInvoiceVatSummary (reuse summarizeEntry) ·
 *   data layer (mock DB, pattern เดียวกับ sales-documents.test.ts) · issueTaxInvoice เรียกซ้อนพร้อมกัน (Promise.all)
 *   ได้เลขไม่ซ้ำ · ตัวนับแยกอิสระต่อลูกค้า (ต่างจาก sales_document_counters) · voidTaxInvoice เฉพาะจาก issued
 *
 * ★★★ ยืนยันด้วยโค้ด review: tax-invoice.ts ไม่ import จาก
 *   journal.ts/ledger.ts/statements.ts/journal-books.ts/payment.ts เลยแม้แต่บรรทัดเดียว
 */

import {
  isTaxInvoiceEligible,
  buildTaxInvoiceLinesFromBill,
  validateIssueInput,
  taxInvoiceGrandTotal,
  taxInvoiceVatSummary,
  getTaxInvoiceScope,
  getTaxInvoice,
  listTaxInvoices,
  listTaxInvoicesForEntries,
  issueTaxInvoice,
  voidTaxInvoice,
  type TaxInvoiceIssueInput,
} from "@/lib/accounting/tax-invoice";

// ---------------------------------------------------------------------
// isTaxInvoiceEligible
// ---------------------------------------------------------------------
describe("isTaxInvoiceEligible", () => {
  it("บิลขายที่ยืนยันแล้ว → true", () => {
    expect(isTaxInvoiceEligible({ entryType: "sale", status: "confirmed" })).toBe(true);
  });
  it("บิลซื้อ (แม้ยืนยันแล้ว) → false", () => {
    expect(isTaxInvoiceEligible({ entryType: "purchase", status: "confirmed" })).toBe(false);
  });
  it("บิลขายที่ยังไม่ยืนยัน (draft/unspecified) → false", () => {
    expect(isTaxInvoiceEligible({ entryType: "sale", status: "draft" })).toBe(false);
  });
});

// ---------------------------------------------------------------------
// buildTaxInvoiceLinesFromBill
// ---------------------------------------------------------------------
describe("buildTaxInvoiceLinesFromBill", () => {
  it("ข้ามบรรทัดที่ amount=0 — derive unitPrice=amount/quantity", () => {
    const lines = buildTaxInvoiceLinesFromBill([
      { id: "l1", description: "สินค้า A", quantity: 2, amount: 200, vatType: "vat", vatAmount: 14, unit: "ชิ้น" },
      { id: "l2", description: "ของแถม", quantity: 1, amount: 0, vatType: "vat", vatAmount: 0, unit: null },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      lineNo: 1,
      description: "สินค้า A",
      quantity: 2,
      unit: "ชิ้น",
      unitPrice: 100,
      amount: 200,
      vatAmount: 14,
      sourceBillEntryLineId: "l1",
    });
  });

  it("quantity null/0 → default เป็น 1 (unitPrice = amount เต็ม)", () => {
    const lines = buildTaxInvoiceLinesFromBill([
      { id: "l1", description: "บริการ", quantity: null, amount: 500, vatType: "vat", vatAmount: 35, unit: null },
      { id: "l2", description: "บริการ 2", quantity: 0, amount: 300, vatType: "novat", vatAmount: 0, unit: null },
    ]);
    expect(lines[0].quantity).toBe(1);
    expect(lines[0].unitPrice).toBe(500);
    expect(lines[1].quantity).toBe(1);
    expect(lines[1].unitPrice).toBe(300);
  });

  it("ทุกบรรทัด amount=0 → คืน array ว่าง", () => {
    expect(
      buildTaxInvoiceLinesFromBill([{ id: "l1", description: null, quantity: 1, amount: 0, vatType: "vat", vatAmount: 0, unit: null }])
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// validateIssueInput
// ---------------------------------------------------------------------
function baseIssueInput(p: Partial<TaxInvoiceIssueInput> = {}): TaxInvoiceIssueInput {
  return { formType: "full", docDate: "2026-08-01", buyerName: "บริษัท เอบีซี", buyerTaxId: "1234567890123", ...p };
}

describe("validateIssueInput", () => {
  it("เต็มรูป + ผู้ซื้อครบ → ผ่าน", () => {
    const res = validateIssueInput(baseIssueInput());
    expect(res.ok).toBe(true);
  });

  it("★ เต็มรูป ขาดชื่อ/เลขผู้เสียภาษีผู้ซื้อ → ปฏิเสธ", () => {
    expect(validateIssueInput(baseIssueInput({ buyerName: undefined })).ok).toBe(false);
    expect(validateIssueInput(baseIssueInput({ buyerTaxId: undefined })).ok).toBe(false);
  });

  it("★ อย่างย่อ ไม่ต้องระบุผู้ซื้อ → ผ่าน (ไม่บังคับตามกฎหมาย)", () => {
    const res = validateIssueInput(baseIssueInput({ formType: "abbreviated", buyerName: undefined, buyerTaxId: undefined }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.buyerName).toBeNull();
      expect(res.value.buyerTaxId).toBeNull();
    }
  });

  it("formType ไม่ถูกต้อง/ว่าง → ปฏิเสธ", () => {
    expect(validateIssueInput(baseIssueInput({ formType: "invoice" })).ok).toBe(false);
    expect(validateIssueInput(baseIssueInput({ formType: undefined })).ok).toBe(false);
  });

  it("docDate ผิดรูปแบบ/ว่าง → ปฏิเสธ", () => {
    expect(validateIssueInput(baseIssueInput({ docDate: "01/08/2026" })).ok).toBe(false);
    expect(validateIssueInput(baseIssueInput({ docDate: "" })).ok).toBe(false);
  });

  it("buyer fields เกินความยาว → ตัดตามเพดาน ไม่ปฏิเสธ", () => {
    const res = validateIssueInput(
      baseIssueInput({ buyerName: "x".repeat(500), buyerAddress: "y".repeat(500), buyerBranch: "z".repeat(100) })
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.buyerName?.length).toBeLessThanOrEqual(200);
      expect(res.value.buyerAddress?.length).toBeLessThanOrEqual(300);
      expect(res.value.buyerBranch?.length).toBeLessThanOrEqual(50);
    }
  });
});

// ---------------------------------------------------------------------
// taxInvoiceGrandTotal / taxInvoiceVatSummary
// ---------------------------------------------------------------------
describe("taxInvoiceGrandTotal", () => {
  it("= Σ(amount + vatAmount)", () => {
    expect(
      taxInvoiceGrandTotal([
        { amount: 1000, vatAmount: 70 },
        { amount: 500, vatAmount: 0 },
      ])
    ).toBe(1570);
  });
});

describe("taxInvoiceVatSummary", () => {
  it("แยกฐานภาษี (vat) / ฐานยกเว้นภาษี (novat) / VAT รวม ถูกต้อง", () => {
    const res = taxInvoiceVatSummary([
      { amount: 1000, vatAmount: 70, vatType: "vat" },
      { amount: 300, vatAmount: 0, vatType: "novat" },
    ]);
    expect(res).toEqual({ baseVat: 1000, baseExempt: 300, totalVat: 70 });
  });
});

// ---------------------------------------------------------------------
// data layer (mock DB — pattern เดียวกับ sales-documents.test.ts)
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "is" | "in" | "neq"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "eq") return row[f.col] === f.val;
    if (f.op === "neq") return row[f.col] !== f.val;
    if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
    if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
    return row[f.col] === f.val;
  });
}

function makeFakeDb(): {
  db: SupabaseClient;
  bills: Row[];
  billLines: Row[];
  invoices: Row[];
  invoiceLines: Row[];
} {
  const bills: Row[] = [];
  const billLines: Row[] = [];
  const invoices: Row[] = [];
  const invoiceLines: Row[] = [];
  const counters = new Map<string, number>();
  let nextInvoiceId = 1;
  let nextLineId = 1;

  function tableOf(name: string): Row[] {
    if (name === "bill_entries") return bills;
    if (name === "bill_entry_lines") return billLines;
    if (name === "tax_invoices") return invoices;
    if (name === "tax_invoice_lines") return invoiceLines;
    return [];
  }

  function qb(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "update" = "select";
    let payload: unknown = {};
    let orderCol: string | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      filters.push({ col: c, op: "eq", val: v });
      return api;
    };
    api.neq = (c: string, v: unknown) => {
      filters.push({ col: c, op: "neq", val: v });
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
    api.order = (c: string) => {
      orderCol = c;
      return api;
    };
    api.limit = () => api;
    api.update = (p: unknown) => {
      mode = "update";
      payload = p;
      return api;
    };
    api.maybeSingle = () => {
      const rows = tableOf(table);
      if (mode === "update" && table === "tax_invoices") {
        const row = rows.find((r) => matchRow(r, filters));
        if (!row) return Promise.resolve({ data: null, error: null });
        Object.assign(row, payload as Row);
        return Promise.resolve({ data: { id: row.id }, error: null });
      }
      const row = rows.find((r) => matchRow(r, filters));
      return Promise.resolve({ data: row ? { ...row } : null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let rows = tableOf(table).filter((r) => matchRow(r, filters));
      if (orderCol) rows = [...rows].sort((a, b) => Number(a[orderCol as string]) - Number(b[orderCol as string]));
      const data = rows.map((r) => ({ ...r }));
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }

  // จำลอง RPC issue_tax_invoice() — เช็คซ้ำ + increment counter (ต่อ tenant+customer+form+year) + insert หัว+บรรทัด
  //   ทั้งหมดใน "ครั้งเดียว" ที่เรียก rpc() (mirror atomic ของ SQL จริงใน migration 0110)
  function rpc(fn: string, params: Record<string, unknown>) {
    if (fn !== "issue_tax_invoice") {
      return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
    }
    const already = invoices.find(
      (r) =>
        r.tenant_id === params.p_tenant_id &&
        r.source_bill_entry_id === params.p_source_bill_entry_id &&
        r.status !== "void" &&
        !r.deleted_at
    );
    if (already) {
      return Promise.resolve({ data: null, error: { message: "already_issued_for_this_bill" } });
    }

    const key = `${params.p_tenant_id}|${params.p_customer_id}|${params.p_form_type}|${params.p_be_year}`;
    const seq = (counters.get(key) ?? 0) + 1;
    counters.set(key, seq);
    const docNo = `${params.p_prefix}-${params.p_be_year}-${String(seq).padStart(5, "0")}`;

    const id = `ti${nextInvoiceId++}`;
    invoices.push({
      id,
      tenant_id: params.p_tenant_id,
      customer_id: params.p_customer_id,
      source_bill_entry_id: params.p_source_bill_entry_id,
      form_type: params.p_form_type,
      doc_no: docNo,
      doc_date: params.p_doc_date,
      buyer_name: params.p_buyer_name,
      buyer_tax_id: params.p_buyer_tax_id,
      buyer_address: params.p_buyer_address,
      buyer_branch: params.p_buyer_branch,
      seller_branch: params.p_seller_branch,
      status: "issued",
      void_reason: null,
      voided_at: null,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      deleted_at: null,
    });
    for (const l of params.p_lines as Row[]) {
      invoiceLines.push({
        id: `til${nextLineId++}`,
        tax_invoice_id: id,
        tenant_id: params.p_tenant_id,
        line_no: l.line_no,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unit_price: l.unit_price,
        amount: l.amount,
        vat_type: l.vat_type,
        vat_amount: l.vat_amount,
        source_bill_entry_line_id: l.source_bill_entry_line_id,
      });
    }
    return Promise.resolve({ data: { id, doc_no: docNo }, error: null });
  }

  return { db: { from: (t: string) => qb(t), rpc } as unknown as SupabaseClient, bills, billLines, invoices, invoiceLines };
}

function seedEligibleBill(
  bills: Row[],
  billLines: Row[],
  opts: { id: string; tenantId: string; customerId: string }
) {
  bills.push({
    id: opts.id,
    tenant_id: opts.tenantId,
    customer_id: opts.customerId,
    entry_type: "sale",
    status: "confirmed",
    deleted_at: null,
  });
  billLines.push({
    id: `${opts.id}-l1`,
    tenant_id: opts.tenantId,
    entry_id: opts.id,
    line_no: 1,
    description: "สินค้า A",
    quantity: 2,
    amount: 200,
    vat_type: "vat",
    vat_amount: 14,
  });
}

const validIssueInput: TaxInvoiceIssueInput = {
  formType: "full",
  docDate: "2026-08-01",
  buyerName: "บริษัท ทดสอบ จำกัด",
  buyerTaxId: "1234567890123",
};

describe("issueTaxInvoice", () => {
  it("บิลขายที่ยืนยันแล้ว → ออกสำเร็จ ได้เลขที่ตามรูปแบบ {PREFIX}-{beYear}-{seq:05d}", async () => {
    const { db, bills, billLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });

    const res = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.docNo).toMatch(/^TX-\d{4}-\d{5}$/);
  });

  it("★ ลูกค้าไม่ตรงกับบิล → ปฏิเสธ ไม่เรียก RPC", async () => {
    const { db, bills, billLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });

    const res = await issueTaxInvoice(db, "t1", "c2", "b1", validIssueInput);
    expect(res.ok).toBe(false);
  });

  it("★ บิลซื้อ (ไม่ eligible) → ปฏิเสธ", async () => {
    const { db, bills, billLines } = makeFakeDb();
    bills.push({ id: "b1", tenant_id: "t1", customer_id: "c1", entry_type: "purchase", status: "confirmed", deleted_at: null });
    billLines.push({ id: "b1-l1", tenant_id: "t1", entry_id: "b1", line_no: 1, description: "x", quantity: 1, amount: 100, vat_type: "vat", vat_amount: 7 });

    const res = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    expect(res.ok).toBe(false);
  });

  it("★ บิลไม่มีบรรทัดที่มียอดเงินเลย → ปฏิเสธ", async () => {
    const { db, bills, billLines } = makeFakeDb();
    bills.push({ id: "b1", tenant_id: "t1", customer_id: "c1", entry_type: "sale", status: "confirmed", deleted_at: null });
    billLines.push({ id: "b1-l1", tenant_id: "t1", entry_id: "b1", line_no: 1, description: "x", quantity: 1, amount: 0, vat_type: "vat", vat_amount: 0 });

    const res = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    expect(res.ok).toBe(false);
  });

  it("★ ออกซ้ำจากบิลเดิม (ยังไม่ void) → ปฏิเสธ ไม่เผาเลขซ้ำ", async () => {
    const { db, bills, billLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });

    const first = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    expect(first.ok).toBe(true);
    const second = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    expect(second.ok).toBe(false);
  });

  it("★ เรียกซ้อนพร้อมกัน (Promise.all) กับบิลคนละใบ ลูกค้าเดียวกัน → ได้เลขไม่ซ้ำกันเสมอ", async () => {
    const { db, bills, billLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });
    seedEligibleBill(bills, billLines, { id: "b2", tenantId: "t1", customerId: "c1" });

    const [res1, res2] = await Promise.all([
      issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput),
      issueTaxInvoice(db, "t1", "c1", "b2", validIssueInput),
    ]);
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    if (res1.ok && res2.ok) {
      expect(res1.docNo).not.toBe(res2.docNo);
      const seqs = [res1.docNo, res2.docNo].map((n) => n.split("-")[2]).sort();
      expect(seqs).toEqual(["00001", "00002"]);
    }
  });

  it("★★★ ตัวนับแยกอิสระต่อลูกค้า (ต่างจาก sales_document_counters) — สองลูกค้า ฟอร์ม/ปีเดียวกัน เริ่มที่ 00001 ทั้งคู่", async () => {
    const { db, bills, billLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });
    seedEligibleBill(bills, billLines, { id: "b2", tenantId: "t1", customerId: "c2" });

    const res1 = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    const res2 = await issueTaxInvoice(db, "t1", "c2", "b2", validIssueInput);
    expect(res1.ok && res2.ok).toBe(true);
    if (res1.ok && res2.ok) {
      expect(res1.docNo).toMatch(/-00001$/);
      expect(res2.docNo).toMatch(/-00001$/); // ลูกค้า c2 ไม่ต่อจาก c1 — ตัวนับแยกกันคนละชุด
    }
  });

  it("แยกชุดเลขที่ตาม form_type (เต็มรูป TX / อย่างย่อ TA คนละชุด)", async () => {
    const { db, bills, billLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });
    seedEligibleBill(bills, billLines, { id: "b2", tenantId: "t1", customerId: "c1" });

    const full = await issueTaxInvoice(db, "t1", "c1", "b1", { ...validIssueInput, formType: "full" });
    const abbr = await issueTaxInvoice(db, "t1", "c1", "b2", {
      formType: "abbreviated",
      docDate: "2026-08-01",
    });
    expect(full.ok && abbr.ok).toBe(true);
    if (full.ok && abbr.ok) {
      expect(full.docNo).toMatch(/^TX-\d{4}-00001$/);
      expect(abbr.docNo).toMatch(/^TA-\d{4}-00001$/);
    }
  });

  it("บรรทัดที่บันทึกจริง = สำเนา ณ เวลาออกเอกสาร (unitPrice derive จาก amount/quantity)", async () => {
    const { db, bills, billLines, invoiceLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });

    const res = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const lines = invoiceLines.filter((l) => l.tax_invoice_id === res.id);
      expect(lines).toHaveLength(1);
      expect(lines[0].unit_price).toBe(100); // 200 / 2
      expect(lines[0].amount).toBe(200);
    }
  });
});

describe("voidTaxInvoice", () => {
  it("★ ยกเลิกได้เฉพาะจาก status='issued' เท่านั้น — void แล้วยกเลิกซ้ำไม่ได้", async () => {
    const { db, bills, billLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });
    const issued = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    const id = issued.ok ? issued.id : "";

    const ok = await voidTaxInvoice(db, "t1", id, "ออกผิด");
    expect(ok.ok).toBe(true);

    const again = await voidTaxInvoice(db, "t1", id, "ลองอีกครั้ง");
    expect(again.ok).toBe(false);
  });

  it("★ void แล้วออกใบใหม่จากบิลเดิมได้ — เลขที่ใหม่ไม่ใช่เลขเดิม", async () => {
    const { db, bills, billLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });
    const first = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    const firstId = first.ok ? first.id : "";
    await voidTaxInvoice(db, "t1", firstId, "ออกผิด");

    const second = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.docNo).not.toBe(first.docNo);
  });

  it("ไม่พบใบกำกับภาษี → ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    const res = await voidTaxInvoice(db, "t1", "missing", null);
    expect(res.ok).toBe(false);
  });
});

describe("getTaxInvoiceScope / getTaxInvoice / listTaxInvoices / listTaxInvoicesForEntries", () => {
  it("getTaxInvoiceScope คืนสโคป+สถานะถูกต้อง", async () => {
    const { db, bills, billLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });
    const issued = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    const id = issued.ok ? issued.id : "";

    const scope = await getTaxInvoiceScope(db, "t1", id);
    expect(scope).toEqual({ customerId: "c1", status: "issued" });
  });

  it("getTaxInvoice คืนหัว+บรรทัดครบ", async () => {
    const { db, bills, billLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });
    const issued = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    const id = issued.ok ? issued.id : "";

    const inv = await getTaxInvoice(db, "t1", id);
    expect(inv?.id).toBe(id);
    expect(inv?.lines).toHaveLength(1);
    expect(inv?.docNo).toBe(issued.ok ? issued.docNo : "");
  });

  it("listTaxInvoices กรองตามลูกค้าถูกต้อง", async () => {
    const { db, bills, billLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });
    seedEligibleBill(bills, billLines, { id: "b2", tenantId: "t1", customerId: "c2" });
    await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    await issueTaxInvoice(db, "t1", "c2", "b2", validIssueInput);

    const c1Invoices = await listTaxInvoices(db, "t1", "c1");
    expect(c1Invoices).toHaveLength(1);
    expect(c1Invoices[0].customerId).toBe("c1");
  });

  it("listTaxInvoicesForEntries map บิล → ใบกำกับภาษีที่ยัง 'ไม่ยกเลิก' เท่านั้น", async () => {
    const { db, bills, billLines } = makeFakeDb();
    seedEligibleBill(bills, billLines, { id: "b1", tenantId: "t1", customerId: "c1" });
    seedEligibleBill(bills, billLines, { id: "b2", tenantId: "t1", customerId: "c1" });
    const issued1 = await issueTaxInvoice(db, "t1", "c1", "b1", validIssueInput);
    const issued2 = await issueTaxInvoice(db, "t1", "c1", "b2", validIssueInput);
    if (issued2.ok) await voidTaxInvoice(db, "t1", issued2.id, "ผิด");

    const map = await listTaxInvoicesForEntries(db, "t1", ["b1", "b2"]);
    expect(map.has("b1")).toBe(true);
    expect(map.has("b2")).toBe(false); // b2 ถูก void แล้ว — ไม่ควรติดมา
    expect(map.get("b1")?.docNo).toBe(issued1.ok ? issued1.docNo : "");
  });

  it("entryIds ว่าง → คืน map ว่างทันที (ไม่ query)", async () => {
    const { db } = makeFakeDb();
    const map = await listTaxInvoicesForEntries(db, "t1", []);
    expect(map.size).toBe(0);
  });
});
