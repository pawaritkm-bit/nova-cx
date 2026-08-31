import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCombinedJournalLines, flattenCombinedJournalLines } from "@/lib/accounting/statement-inputs";
import { toJournalLines as toManualJournalLines } from "@/lib/accounting/manual-journal";
import { toJournalLines as toPaymentJournalLines } from "@/lib/accounting/bill-payments";
import { toJournalLines as toNoteJournalLines } from "@/lib/accounting/credit-debit-notes";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { TEST_CHART } from "./fixtures/chart";
import type { BillEntry } from "@/lib/accounting/queries";

/**
 * statement-inputs.ts — เฟส 4 ส่วน M2 (docs/06-accounting-features-roadmap.md, หมวด 0.13)
 *   เน้น: loadCombinedJournalLines ต้องให้ผลลัพธ์เหมือนกับที่ reports/page.tsx คำนวณ inline เดิมทุกกรณี
 *   (manual JE + bill_payments + CN/DN ผสมกัน + กรองงวด) — mock DB pattern เดียวกับ bill-payments.test.ts
 */

const chartByCode = buildChartByCode(TEST_CHART);

function mkEntry(p: Partial<BillEntry> & { id: string }): BillEntry {
  return {
    id: p.id,
    tenantId: p.tenantId ?? "t1",
    attachmentId: null,
    customerId: p.customerId ?? "c1",
    customerName: null,
    attachmentObjectPath: null,
    uploadPath: null,
    uploadName: null,
    uploadMime: null,
    entryType: p.entryType ?? "sale",
    docDate: p.docDate ?? "2026-07-01",
    docNo: p.docNo ?? "INV-001",
    counterpartyName: p.counterpartyName ?? "ลูกค้า A",
    counterpartyTaxId: null,
    sellerName: null,
    sellerTaxId: null,
    buyerName: null,
    buyerTaxId: null,
    whtForm: null,
    paymentMethod: p.paymentMethod ?? "credit",
    paymentBankAccountId: null,
    paymentBankAccountCode: null,
    dueDate: null,
    status: p.status ?? "confirmed",
    source: "ai",
    aiConfidence: null,
    notes: null,
    createdAt: "2026-07-01T00:00:00Z",
    confirmedAt: null,
    inputTaxMonth: null,
    lines: p.lines ?? [],
  };
}

type Row = Record<string, unknown>;

/** fake in-memory DB — มีตารางที่ loadCombinedJournalLines ต้องใช้ครบ (manual JE/bill_payments/CN-DN) */
function makeFakeDb(seed: {
  manualHeads?: Row[];
  manualLines?: Row[];
  payments?: Row[];
  bankAccounts?: Record<string, Row>;
  notes?: Row[];
  noteLines?: Row[];
}): SupabaseClient {
  const manualHeads = seed.manualHeads ?? [];
  const manualLines = seed.manualLines ?? [];
  const payments = seed.payments ?? [];
  const bankAccounts = seed.bankAccounts ?? {};
  const notes = seed.notes ?? [];
  const noteLines = seed.noteLines ?? [];

  type Filter = { col: string; op: "eq" | "is" | "in"; val: unknown };
  function matchRow(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
      if (f.op === "eq") return row[f.col] === f.val;
      if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
      if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
      return row[f.col] === f.val;
    });
  }

  function qb(table: string) {
    const filters: Filter[] = [];
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
    api.order = () => api;
    api.limit = () => api;
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = [];
      if (table === "manual_journal_entries") data = manualHeads.filter((r) => matchRow(r, filters));
      else if (table === "manual_journal_entry_lines") data = manualLines.filter((r) => matchRow(r, filters));
      else if (table === "bill_payments") data = payments.filter((r) => matchRow(r, filters));
      else if (table === "customer_bank_accounts") {
        const idsFilter = filters.find((f) => f.col === "id" && f.op === "in");
        const ids = (idsFilter?.val as string[]) ?? [];
        data = ids.map((id) => bankAccounts[id] ?? { id, account_code: null });
      } else if (table === "credit_debit_notes") data = notes.filter((r) => matchRow(r, filters));
      else if (table === "credit_debit_note_lines") data = noteLines.filter((r) => matchRow(r, filters));
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }
  return { from: (t: string) => qb(t) } as unknown as SupabaseClient;
}

describe("loadCombinedJournalLines", () => {
  const entries: BillEntry[] = [
    mkEntry({ id: "s1", entryType: "sale", paymentMethod: "credit", docNo: "INV-001", docDate: "2026-07-05" }),
    mkEntry({ id: "p1", entryType: "purchase", paymentMethod: "credit", docNo: "PO-001", docDate: "2026-07-10", counterpartyName: "ผู้ขาย B" }),
  ];

  const manualHeadRow: Row = {
    id: "je1",
    tenant_id: "t1",
    customer_id: "c1",
    doc_type: "JV",
    doc_date: "2026-07-15",
    doc_no: "JV-001",
    memo: "ปรับปรุงค่าเสื่อม",
    status: "confirmed",
    created_at: "2026-07-15T00:00:00Z",
    confirmed_at: "2026-07-15T00:00:00Z",
  };
  const manualLineRows: Row[] = [
    { id: "l1", entry_id: "je1", tenant_id: "t1", line_no: 1, account_code: "5370", account_name: "ค่าเสื่อมราคา-อาคาร", description: null, debit: 500, credit: 0 },
    { id: "l2", entry_id: "je1", tenant_id: "t1", line_no: 2, account_code: "1615.1", account_name: "ค่าเสื่อมสะสม-อาคาร", description: null, debit: 0, credit: 500 },
  ];

  const paymentRow: Row = {
    id: "bp1",
    tenant_id: "t1",
    entry_id: "s1",
    customer_id: "c1",
    pay_date: "2026-07-20",
    amount: 1000,
    method: "cash",
    bank_account_id: null,
    notes: null,
    created_at: "2026-07-20T00:00:00Z",
    deleted_at: null,
  };

  const noteRow: Row = {
    id: "cn1",
    tenant_id: "t1",
    entry_id: "s1",
    customer_id: "c1",
    doc_type: "credit_note",
    doc_date: "2026-07-22",
    doc_no: "CN-001",
    reason: "สินค้าชำรุด",
    status: "confirmed",
    created_at: "2026-07-22T00:00:00Z",
    confirmed_at: "2026-07-22T00:00:00Z",
  };
  const noteLineRow: Row = {
    id: "nl1",
    note_id: "cn1",
    tenant_id: "t1",
    line_no: 1,
    description: null,
    account_code: "4010",
    account_name: "ขายสินค้า",
    amount: 100,
    vat_amount: 7,
  };

  it("โหลด + แปลง manual JE + bill_payments + CN/DN ครบ 3 แหล่ง ตรงกับ mapper เดิมทุกจุด", async () => {
    const db = makeFakeDb({
      manualHeads: [manualHeadRow],
      manualLines: manualLineRows,
      payments: [paymentRow],
      notes: [noteRow],
      noteLines: [noteLineRow],
    });

    const result = await loadCombinedJournalLines(
      db,
      "t1",
      entries,
      { from: "2026-07", to: "2026-07", includeDraft: true },
      chartByCode
    );

    // ---- ผลลัพธ์ต้องตรงกับ mapper เดิมเป๊ะ (คำนวณมือ/เรียกฟังก์ชันเดิมตรง ๆ เทียบ) ----
    const expectedManual = toManualJournalLines({
      id: "je1",
      tenantId: "t1",
      customerId: "c1",
      docType: "JV",
      docDate: "2026-07-15",
      docNo: "JV-001",
      memo: "ปรับปรุงค่าเสื่อม",
      status: "confirmed",
      createdAt: "2026-07-15T00:00:00Z",
      confirmedAt: "2026-07-15T00:00:00Z",
      lines: [
        { id: "l1", lineNo: 1, accountCode: "5370", accountName: "ค่าเสื่อมราคา-อาคาร", description: null, debit: 500, credit: 0 },
        { id: "l2", lineNo: 2, accountCode: "1615.1", accountName: "ค่าเสื่อมสะสม-อาคาร", description: null, debit: 0, credit: 500 },
      ],
    });
    expect(result.manualJournalLines).toEqual(expectedManual);

    const saleEntry = entries[0];
    const expectedPayment = toPaymentJournalLines(
      { payDate: "2026-07-20", amount: 1000, method: "cash", bankAccountCode: null },
      saleEntry,
      chartByCode
    );
    expect(result.paymentJournalLines).toEqual(expectedPayment);

    const expectedNote = toNoteJournalLines(
      {
        id: "cn1",
        docType: "credit_note",
        docDate: "2026-07-22",
        docNo: "CN-001",
        lines: [{ lineNo: 1, description: null, accountCode: "4010", accountName: "ขายสินค้า", amount: 100, vatAmount: 7 }],
      },
      { entryType: "sale", docNo: saleEntry.docNo, customerId: saleEntry.customerId, counterpartyName: saleEntry.counterpartyName },
      chartByCode
    );
    expect(result.noteJournalLines).toEqual(expectedNote);
  });

  it("กรองงวด — manual JE/payment/note นอกช่วง from-to ถูกตัดออก", async () => {
    const db = makeFakeDb({
      manualHeads: [manualHeadRow], // doc_date 2026-07-15
      manualLines: manualLineRows,
      payments: [paymentRow], // pay_date 2026-07-20
      notes: [noteRow], // doc_date 2026-07-22
      noteLines: [noteLineRow],
    });
    const result = await loadCombinedJournalLines(
      db,
      "t1",
      entries,
      { from: "2026-08", to: "2026-08", includeDraft: true },
      chartByCode
    );
    expect(result.manualJournalLines).toHaveLength(0);
    expect(result.paymentJournalLines).toHaveLength(0);
    expect(result.noteJournalLines).toHaveLength(0);
  });

  it("includeDraft=false ตัด manual JE draft ออก (bill_payments ไม่มีสถานะ draft/confirmed จึงไม่ตัด)", async () => {
    const draftManual: Row = { ...manualHeadRow, id: "je2", status: "draft" };
    const draftLines: Row[] = [
      { id: "dl1", entry_id: "je2", tenant_id: "t1", line_no: 1, account_code: "5370", account_name: "x", description: null, debit: 200, credit: 0 },
      { id: "dl2", entry_id: "je2", tenant_id: "t1", line_no: 2, account_code: "1615.1", account_name: "y", description: null, debit: 0, credit: 200 },
    ];
    const db = makeFakeDb({
      manualHeads: [manualHeadRow, draftManual],
      manualLines: [...manualLineRows, ...draftLines],
      payments: [paymentRow],
    });
    const result = await loadCombinedJournalLines(
      db,
      "t1",
      entries,
      { from: "2026-07", to: "2026-07", includeDraft: false },
      chartByCode
    );
    // เฉพาะ manual JE confirmed (je1) เท่านั้น — je2 (draft) ถูกตัด
    expect(result.manualJournalLines.every((l) => l.entryId === "je1")).toBe(true);
    // payment ยังอยู่ครบ (ไม่มีสถานะ draft/confirmed)
    expect(result.paymentJournalLines.length).toBeGreaterThan(0);
  });

  it("CN/DN status='draft' ถูกตัดออกเสมอ แม้ includeDraft=true (ต่างจาก manual JE — ตาม filterCreditDebitNotesForReport เดิม)", async () => {
    const draftNote: Row = { ...noteRow, id: "cn2", status: "draft" };
    const db = makeFakeDb({ notes: [draftNote], noteLines: [{ ...noteLineRow, note_id: "cn2" }] });
    const result = await loadCombinedJournalLines(
      db,
      "t1",
      entries,
      { from: "2026-07", to: "2026-07", includeDraft: true },
      chartByCode
    );
    expect(result.noteJournalLines).toHaveLength(0);
  });

  it("entries ว่างเปล่า → derive customerId ไม่ได้ → ไม่โหลด manual JE เลย (ข้อจำกัดของ signature ตามที่ล็อกไว้)", async () => {
    const db = makeFakeDb({ manualHeads: [manualHeadRow], manualLines: manualLineRows });
    const result = await loadCombinedJournalLines(
      db,
      "t1",
      [],
      { from: "2026-07", to: "2026-07", includeDraft: true },
      chartByCode
    );
    expect(result.manualJournalLines).toHaveLength(0);
    expect(result.paymentJournalLines).toHaveLength(0);
    expect(result.noteJournalLines).toHaveLength(0);
  });
});

describe("flattenCombinedJournalLines", () => {
  it("รวม 3 แหล่งตามลำดับ manual → payment → note", () => {
    const manual = [{ entryId: "m" }] as never[];
    const payment = [{ entryId: "p" }] as never[];
    const note = [{ entryId: "n" }] as never[];
    const flat = flattenCombinedJournalLines({
      manualJournalLines: manual,
      paymentJournalLines: payment,
      noteJournalLines: note,
    });
    expect(flat.map((l: { entryId: string }) => l.entryId)).toEqual(["m", "p", "n"]);
  });
});
