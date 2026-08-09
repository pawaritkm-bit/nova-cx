import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeFakeDb, type Capture, type Resolver } from "../helpers/fake-supabase";

/**
 * เฟส 3 ส่วน J (Credit/Debit Note) + K (Quotation/PO/Billing Note) — integration test แบบ end-to-end
 * ในระดับ unit (ไม่มี browser/live server) จำลอง 17 ขั้นตอน manual test ใน
 * docs/06-accounting-features-roadmap.md หมวด "## 4) แนวทางการทดสอบ" (ท้ายไฟล์ เฟส 3)
 *
 * ต่างจาก credit-debit-notes.test.ts/sales-documents.test.ts (unit ต่อฟังก์ชัน) — ไฟล์นี้ผูกหลาย
 * data-layer function ของไฟล์เดียวกัน (credit-debit-notes.ts + bill-payments.ts + aging.ts + sales-documents.ts)
 * เข้าด้วยกันผ่าน "DB" จำลองใบเดียวที่มีหลายตาราง เพื่อพิสูจน์ flow เต็ม ไม่ใช่แค่ฟังก์ชันเดี่ยว ๆ
 */

// ---------------------------------------------------------------------
// DB จำลองหลายตาราง (ใช้ร่วมกันทั้งไฟล์ต่อ 1 test — สร้างใหม่ทุก it() ผ่าน makeMultiTableDb())
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "is" | "in"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "eq") return row[f.col] === f.val;
    if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
    if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
    return row[f.col] === f.val;
  });
}

function makeMultiTableDb() {
  const tables: Record<string, Row[]> = {
    bill_entries: [],
    bill_entry_lines: [],
    credit_debit_notes: [],
    credit_debit_note_lines: [],
    bill_payments: [],
    customer_bank_accounts: [],
    sales_documents: [],
    sales_document_lines: [],
  };
  const seqCounters = { note: 1, note_line: 1, payment: 1, doc: 1, doc_line: 1 };
  const docNoCounters = new Map<string, number>(); // ใช้จำลอง sales_document_counters (RPC)

  function nextId(table: string): string {
    const key =
      table === "credit_debit_notes"
        ? "note"
        : table === "credit_debit_note_lines"
          ? "note_line"
          : table === "bill_payments"
            ? "payment"
            : table === "sales_documents"
              ? "doc"
              : "doc_line";
    const n = seqCounters[key as keyof typeof seqCounters]++;
    return `${key}-${n}`;
  }

  function qb(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: unknown = {};
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
    api.insert = (p: unknown) => {
      mode = "insert";
      payload = p;
      return api;
    };
    api.update = (p: unknown) => {
      mode = "update";
      payload = p;
      return api;
    };
    api.delete = () => {
      mode = "delete";
      return api;
    };
    api.maybeSingle = () => {
      // ★ ต้อง mirror ตรรกะ Supabase จริง: .update(...).eq(...).select().maybeSingle() ใช้เป็น TOCTOU
      //   atomic guard ในโค้ดจริงหลายจุด (updateDraftNote/updateDraftDocument/softDeleteDraft) — ต้อง
      //   apply payload ก่อนเช็คว่ามีแถวไหน "ยังแมตช์ filter เดิม" ได้ผลลัพธ์จริง ไม่ใช่แค่ select เฉย ๆ
      if (mode === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        let firstId = "";
        for (const r of rows as Row[]) {
          const id = nextId(table);
          if (!firstId) firstId = id;
          tables[table].push({ id, deleted_at: null, ...(r as Row) });
        }
        return Promise.resolve({ data: { id: firstId }, error: null });
      }
      if (mode === "update") {
        const matched = (tables[table] ?? []).filter((r) => matchRow(r, filters));
        for (const row of matched) Object.assign(row, payload as Row);
        return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
      }
      if (mode === "delete") {
        const matched = (tables[table] ?? []).filter((r) => matchRow(r, filters));
        tables[table] = (tables[table] ?? []).filter((r) => !matchRow(r, filters));
        return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
      }
      const row = tables[table]?.find((r) => matchRow(r, filters));
      return Promise.resolve({ data: row ? { ...row } : null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = [];
      if (mode === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const r of rows as Row[]) {
          const id = nextId(table);
          tables[table].push({ id, deleted_at: null, ...(r as Row) });
        }
        data = null;
      } else if (mode === "update") {
        for (const row of tables[table] ?? []) if (matchRow(row, filters)) Object.assign(row, payload as Row);
        data = null;
      } else if (mode === "delete") {
        tables[table] = (tables[table] ?? []).filter((r) => !matchRow(r, filters));
        data = null;
      } else {
        data = (tables[table] ?? []).filter((r) => matchRow(r, filters));
      }
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }

  // จำลอง RPC issue_sales_document (mirror ตรรกะ SQL จริงใน migration 0070, 0.12) — atomic ต่อ
  // (tenant_id, document_type, be_year) เท่านั้น (คนละชุดกับ document_type อื่น)
  function rpc(fn: string, params: Record<string, unknown>) {
    if (fn !== "issue_sales_document") {
      return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
    }
    const p = params as { p_tenant_id: string; p_document_id: string; p_document_type: string; p_be_year: number; p_prefix: string };
    const row = tables.sales_documents.find(
      (r) => r.id === p.p_document_id && r.tenant_id === p.p_tenant_id && r.status === "draft" && !r.deleted_at
    );
    if (!row) return Promise.resolve({ data: null, error: { message: "sales_document not found or not draft" } });
    const key = `${p.p_tenant_id}|${p.p_document_type}|${p.p_be_year}`;
    const seq = (docNoCounters.get(key) ?? 0) + 1;
    docNoCounters.set(key, seq);
    const docNo = `${p.p_prefix}-${p.p_be_year}-${String(seq).padStart(4, "0")}`;
    row.doc_no = docNo;
    row.status = "issued";
    row.issued_at = "2026-08-08T00:00:00Z";
    return Promise.resolve({ data: { id: row.id, doc_no: docNo }, error: null });
  }

  return { db: { from: (t: string) => qb(t), rpc } as unknown as SupabaseClient, tables };
}

function seedBillEntry(
  tables: Record<string, Row[]>,
  id: string,
  p: { customerId: string; entryType: "sale" | "purchase"; lines: { amount: number; vat_amount: number; wht_amount: number }[] }
) {
  tables.bill_entries.push({
    id,
    tenant_id: "t1",
    customer_id: p.customerId,
    entry_type: p.entryType,
    payment_method: "credit",
    status: "confirmed",
    deleted_at: null,
  });
  for (const l of p.lines) {
    tables.bill_entry_lines.push({ tenant_id: "t1", entry_id: id, ...l });
  }
}

// ---------------------------------------------------------------------
// import lib functions ที่ต้องผูกเข้าด้วยกัน
// ---------------------------------------------------------------------
import {
  createDraftNote,
  confirmNote,
  softDeleteNote,
  listNotesForEntries,
  netAdjustmentByEntry,
  toJournalPosting as noteToJournalPosting,
} from "@/lib/accounting/credit-debit-notes";
import {
  billOutstanding,
  billNetTotal,
  recordBillPayment,
  listBillPaymentsForEntries,
} from "@/lib/accounting/bill-payments";
import { buildAgingReport } from "@/lib/accounting/aging";
import type { BillEntry } from "@/lib/accounting/queries";
import {
  createDraftDocument,
  getSalesDocument,
  issueDocument,
  lineTotal,
  updateDraftDocument,
  softDeleteDraft,
} from "@/lib/accounting/sales-documents";
import { updateDraftNote } from "@/lib/accounting/credit-debit-notes";

function agingEntry(p: {
  id: string;
  entryType: "sale" | "purchase";
  counterpartyName: string;
  lines: { amount: number; vatAmount: number; whtAmount: number }[];
}): BillEntry {
  return {
    id: p.id,
    tenantId: "t1",
    entryType: p.entryType,
    docNo: `INV-${p.id}`,
    docDate: "2026-07-01",
    dueDate: "2026-08-01",
    customerId: "c1",
    counterpartyName: p.counterpartyName,
    counterpartyTaxId: null,
    paymentMethod: "credit",
    status: "confirmed",
    lines: p.lines.map((l, i) => ({
      id: `${p.id}-l${i}`,
      accountCode: p.entryType === "sale" ? "4010" : "5010",
      accountName: p.entryType === "sale" ? "ขายสินค้า" : "ซื้อสินค้า",
      amount: l.amount,
      vatAmount: l.vatAmount,
      whtAmount: l.whtAmount,
      whtRate: null,
      description: null,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ===========================================================================
// ส่วน J — ขั้นตอน 3-10 ของแผนทดสอบ (บิลขายเชื่อ + CN, บิลซื้อเชื่อ + DN, overpay, void)
// ===========================================================================
describe("เฟส 3 ส่วน J — flow เต็ม: บิลขายเชื่อ → CN → payments/aging/journal → รับเงินส่วนที่เหลือ → overpay ถูกปฏิเสธ", () => {
  it("ขั้นตอน 3-7: CN บนบิลขายเชื่อ ลดยอดค้างถูกต้องทุกจุด แล้วรับเงินส่วนที่เหลือจนครบ + ปฏิเสธ overpay", async () => {
    const { db, tables } = makeMultiTableDb();
    seedBillEntry(tables, "sale-1", {
      customerId: "c1",
      entryType: "sale",
      lines: [{ amount: 1000, vat_amount: 70, wht_amount: 0 }], // net = 1070
    });

    // ขั้นตอน 3: สร้าง CN (draft) → ยืนยัน
    const created = await createDraftNote(db, "t1", "sale-1", {
      docType: "credit_note",
      docDate: "2026-07-15",
      docNo: "CN-001",
      reason: "สินค้าชำรุดบางส่วน",
      lines: [{ accountCode: "4010", amount: 300, vatAmount: 0 }],
    });
    expect(created.ok).toBe(true);
    const noteId = created.ok ? created.id : "";
    const confirmed = await confirmNote(db, "t1", noteId);
    expect(confirmed.ok).toBe(true);

    // ยืนยันแล้วแก้ไขไม่ได้อีก (ข้อ 3 ท้ายประโยค)
    const { updateDraftNote } = await import("@/lib/accounting/credit-debit-notes");
    const editAttempt = await updateDraftNote(db, "t1", noteId, {
      docType: "credit_note",
      docDate: "2026-07-15",
      reason: "แก้",
      lines: [{ accountCode: "4010", amount: 999, vatAmount: 0 }],
    });
    expect(editAttempt.ok).toBe(false);

    // ขั้นตอน 4: /payments — ยอดค้างชำระต้องลดลงตามยอด CN ทันที (ก่อนบันทึกรับเงินใด ๆ)
    let notesByEntry = await listNotesForEntries(db, "t1", ["sale-1"]);
    let netAdj = netAdjustmentByEntry(notesByEntry).get("sale-1") ?? 0;
    expect(netAdj).toBe(-300);
    const entryInfo = { lines: [{ amount: 1000, vatAmount: 70, whtAmount: 0 }] };
    expect(billOutstanding(entryInfo, [], netAdj)).toBe(770); // 1070 - 300

    // ขั้นตอน 5: /ar-ap-aging — ยอดค้าง/bucket ตรงกับข้อ 4
    const entry = agingEntry({
      id: "sale-1",
      entryType: "sale",
      counterpartyName: "บริษัท ลูกค้า จำกัด",
      lines: [{ amount: 1000, vatAmount: 70, whtAmount: 0 }],
    });
    const aging = buildAgingReport([entry], new Map(), "2026-07-20", netAdjustmentByEntry(notesByEntry));
    expect(aging.ar[0].total).toBe(770);

    // ขั้นตอน 6: journal — CN เข้าเล่ม "ขาย" (ไม่ใช่รับเงิน) ยอดสมดุล
    const notes = notesByEntry.get("sale-1") ?? [];
    const posting = noteToJournalPosting(
      notes[0],
      { entryType: "sale", docNo: "INV-sale-1", customerId: "c1", counterpartyName: "บริษัท ลูกค้า จำกัด" },
      {}
    );
    expect(posting.book).toBe("sale");
    expect(posting.totalDebit).toBe(posting.totalCredit);
    expect(posting.totalDebit).toBe(300); // ใบลดหนี้ไม่มี VAT ในเคสนี้

    // ขั้นตอน 7: รับเงินส่วนที่เหลือ (770) จนครบ → บิลหลุดจากรายงาน · เกินยอดที่เหลือจริงต้องถูกปฏิเสธก่อน
    const overpay = await recordBillPayment(db, "t1", "sale-1", { payDate: "2026-07-25", amount: 771, method: "cash" });
    expect(overpay.ok).toBe(false);

    const ok = await recordBillPayment(db, "t1", "sale-1", { payDate: "2026-07-25", amount: 770, method: "cash" });
    expect(ok.ok).toBe(true);

    const paymentsByEntry = await listBillPaymentsForEntries(db, "t1", ["sale-1"]);
    notesByEntry = await listNotesForEntries(db, "t1", ["sale-1"]);
    netAdj = netAdjustmentByEntry(notesByEntry).get("sale-1") ?? 0;
    expect(billOutstanding(entryInfo, paymentsByEntry.get("sale-1") ?? [], netAdj)).toBe(0);

    const agingAfterFull = buildAgingReport([entry], paymentsByEntry, "2026-07-26", netAdjustmentByEntry(notesByEntry));
    expect(agingAfterFull.ar).toHaveLength(0); // บิลจ่ายครบแล้วหลุดออกจากรายงาน (ข้อ 7)
  });

  it("ขั้นตอน 8: DN บนบิลซื้อเชื่อ → AP เพิ่มขึ้นถูกต้อง (netAdjustment เป็นบวก)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedBillEntry(tables, "purchase-1", {
      customerId: "c1",
      entryType: "purchase",
      lines: [{ amount: 2000, vat_amount: 140, wht_amount: 0 }], // net = 2140
    });

    const created = await createDraftNote(db, "t1", "purchase-1", {
      docType: "debit_note",
      docDate: "2026-07-16",
      docNo: "DN-001",
      reason: "ค่าขนส่งเพิ่มเติม",
      lines: [{ accountCode: "5010", amount: 500, vatAmount: 35 }],
    });
    expect(created.ok).toBe(true);
    const noteId = created.ok ? created.id : "";
    await confirmNote(db, "t1", noteId);

    const notesByEntry = await listNotesForEntries(db, "t1", ["purchase-1"]);
    const netAdj = netAdjustmentByEntry(notesByEntry).get("purchase-1") ?? 0;
    expect(netAdj).toBe(535); // debit_note = บวก (เพิ่มยอดเจ้าหนี้)

    const entryInfo = { lines: [{ amount: 2000, vatAmount: 140, whtAmount: 0 }] };
    expect(billNetTotal(entryInfo)).toBe(2140);
    expect(billOutstanding(entryInfo, [], netAdj)).toBe(2675); // AP เพิ่มขึ้นตามยอด DN

    // posting ของ DN ต้องเข้าเล่ม "ซื้อ" และสมดุล
    const notes = notesByEntry.get("purchase-1") ?? [];
    const posting = noteToJournalPosting(
      notes[0],
      { entryType: "purchase", docNo: "PO-purchase-1", customerId: "c1", counterpartyName: "ผู้ขาย เอ" },
      {}
    );
    expect(posting.book).toBe("purchase");
    expect(posting.totalDebit).toBe(posting.totalCredit);
  });

  it("ขั้นตอน 9: void CN/DN ที่ confirmed แล้ว → ยอดค้างชำระ/รายงานทุกจุดกลับมาเหมือนก่อนมี CN/DN นั้น", async () => {
    const { db, tables } = makeMultiTableDb();
    seedBillEntry(tables, "sale-2", {
      customerId: "c1",
      entryType: "sale",
      lines: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }],
    });
    const entryInfo = { lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] };
    const originalOutstanding = billOutstanding(entryInfo, []);
    expect(originalOutstanding).toBe(1000);

    const created = await createDraftNote(db, "t1", "sale-2", {
      docType: "credit_note",
      docDate: "2026-07-15",
      reason: "คืนสินค้า",
      lines: [{ accountCode: "4010", amount: 400, vatAmount: 0 }],
    });
    const noteId = created.ok ? created.id : "";
    await confirmNote(db, "t1", noteId);

    let notesByEntry = await listNotesForEntries(db, "t1", ["sale-2"]);
    expect(billOutstanding(entryInfo, [], netAdjustmentByEntry(notesByEntry).get("sale-2") ?? 0)).toBe(600);

    // void — ยกเลิก CN ที่ confirmed แล้ว
    const voided = await softDeleteNote(db, "t1", noteId);
    expect(voided.ok).toBe(true);

    notesByEntry = await listNotesForEntries(db, "t1", ["sale-2"]);
    const afterVoidAdj = netAdjustmentByEntry(notesByEntry).get("sale-2") ?? 0;
    expect(afterVoidAdj).toBe(0);
    expect(billOutstanding(entryInfo, [], afterVoidAdj)).toBe(originalOutstanding); // กลับมาเหมือนเดิมเป๊ะ

    // regression ข้อ 10: บิลที่ไม่มี CN/DN เลย ต้องเหมือนก่อนแก้เฟส 3 เป๊ะ (default 0)
    expect(billOutstanding(entryInfo, [])).toBe(billOutstanding(entryInfo, [], 0));
  });

  // -----------------------------------------------------------------
  // Edge case เพิ่มเติม (นอกแผน 17 ข้อ) — QA เจาะเอง
  // -----------------------------------------------------------------
  it("★ edge: บิลเดียวมี CN+DN ผสมกันหลายใบพร้อมกัน แล้วรับเงินตามยอดสุทธิจริง (ไม่ใช่แค่ผลรวม pure function)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedBillEntry(tables, "sale-3", {
      customerId: "c1",
      entryType: "sale",
      lines: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }], // net = 1000
    });

    const cn = await createDraftNote(db, "t1", "sale-3", {
      docType: "credit_note",
      docDate: "2026-07-10",
      reason: "ลดราคา",
      lines: [{ accountCode: "4010", amount: 500, vatAmount: 0 }],
    });
    const dn = await createDraftNote(db, "t1", "sale-3", {
      docType: "debit_note",
      docDate: "2026-07-11",
      reason: "ค่าใช้จ่ายเพิ่ม",
      lines: [{ accountCode: "4010", amount: 200, vatAmount: 0 }],
    });
    expect(cn.ok && dn.ok).toBe(true);
    await confirmNote(db, "t1", cn.ok ? cn.id : "");
    await confirmNote(db, "t1", dn.ok ? dn.id : "");

    // net = 1000 - 500(CN) + 200(DN) = 700
    const notesByEntry = await listNotesForEntries(db, "t1", ["sale-3"]);
    const netAdj = netAdjustmentByEntry(notesByEntry).get("sale-3") ?? 0;
    expect(netAdj).toBe(-300);

    const reject = await recordBillPayment(db, "t1", "sale-3", { payDate: "2026-07-20", amount: 750, method: "cash" });
    expect(reject.ok).toBe(false);

    const ok = await recordBillPayment(db, "t1", "sale-3", { payDate: "2026-07-20", amount: 700, method: "cash" });
    expect(ok.ok).toBe(true);

    const payments = await listBillPaymentsForEntries(db, "t1", ["sale-3"]);
    expect(billOutstanding({ lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] }, payments.get("sale-3") ?? [], netAdj)).toBe(0);
  });

  it("★ edge: CN เกินยอดเต็มของบิล → ยอดค้างชำระติดลบ — ต้องหลุดออกจากรายงาน AR (ไม่โชว์หนี้ติดลบ) ไม่ throw", async () => {
    const entry = agingEntry({
      id: "sale-4",
      entryType: "sale",
      counterpartyName: "บริษัท เกินยอด จำกัด",
      lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }],
    });
    // CN = 1500 > net 1000 → netAdjustment = -1500 → outstanding = -500 (ติดลบ)
    const report = buildAgingReport([entry], new Map(), "2026-08-01", new Map([["sale-4", -1500]]));
    expect(report.ar).toHaveLength(0);
    expect(report.ap).toHaveLength(0);
    // billOutstanding เองไม่ floor ที่ 0 (คำนวณตรงไปตรงมา) — แต่ caller (aging/validatePaymentInput) กรอง/ปฏิเสธเอง
    expect(billOutstanding({ lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] }, [], -1500)).toBe(-500);
  });

  it("★ edge: บิลที่ CN ทำให้ยอดค้างติดลบ → validatePaymentInput ปฏิเสธการรับเงินใด ๆ เพิ่มเติม (แม้จำนวนน้อยมาก)", async () => {
    const { validatePaymentInput } = await import("@/lib/accounting/bill-payments");
    const entryInfo = { entryType: "sale" as const, paymentMethod: "credit" as const, status: "confirmed" as const, lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] };
    const r = validatePaymentInput({ payDate: "2026-08-01", amount: 1, method: "cash" }, entryInfo, [], -1500);
    expect(r.ok).toBe(false);
  });

  it("★ edge: cross-tenant isolation — CN/DN ของ tenant อื่นต้องมองไม่เห็น/เขียนไม่ได้แม้ entry_id ตรงกัน", async () => {
    const { db, tables } = makeMultiTableDb();
    seedBillEntry(tables, "sale-5", {
      customerId: "c1",
      entryType: "sale",
      lines: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }],
    });

    // tenant "t2" ไม่มีสิทธิ์เห็นบิลของ t1 เลย แม้ entry_id จะตรงกัน (สโคปกรองด้วย tenant_id เสมอ)
    const { getNoteEntryScope } = await import("@/lib/accounting/credit-debit-notes");
    const scopeWrongTenant = await getNoteEntryScope(db, "t2", "sale-5");
    expect(scopeWrongTenant).toBeNull();

    const createdWrongTenant = await createDraftNote(db, "t2", "sale-5", {
      docType: "credit_note",
      docDate: "2026-08-01",
      reason: "พยายามข้าม tenant",
      lines: [{ accountCode: "4010", amount: 100, vatAmount: 0 }],
    });
    expect(createdWrongTenant.ok).toBe(false);
    expect(tables.credit_debit_notes).toHaveLength(0);

    // tenant ที่ถูกต้อง (t1) ยังทำงานได้ปกติ
    const createdRightTenant = await createDraftNote(db, "t1", "sale-5", {
      docType: "credit_note",
      docDate: "2026-08-01",
      reason: "ปกติ",
      lines: [{ accountCode: "4010", amount: 100, vatAmount: 0 }],
    });
    expect(createdRightTenant.ok).toBe(true);
  });

  it("★ edge: ยืนยัน (confirm) CN/DN ที่ยืนยันไปแล้วซ้ำ → idempotent (ok:true ไม่ throw ไม่สร้างซ้ำ)", async () => {
    const { db, tables } = makeMultiTableDb();
    seedBillEntry(tables, "sale-6", {
      customerId: "c1",
      entryType: "sale",
      lines: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }],
    });
    const created = await createDraftNote(db, "t1", "sale-6", {
      docType: "credit_note",
      docDate: "2026-08-01",
      reason: "ทดสอบ idempotent",
      lines: [{ accountCode: "4010", amount: 100, vatAmount: 0 }],
    });
    const id = created.ok ? created.id : "";
    const first = await confirmNote(db, "t1", id);
    const second = await confirmNote(db, "t1", id);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(tables.credit_debit_notes.filter((n) => n.id === id)).toHaveLength(1);
  });

  it("★ edge: validateNoteInput/validateDocumentInput ไม่พังกับ input สุดขั้ว (Infinity/NaN/ตัวเลขมหาศาล/สตริงแปลก)", async () => {
    const { validateNoteInput } = await import("@/lib/accounting/credit-debit-notes");
    const entryInfo = { entryType: "sale" as const, paymentMethod: "credit" as const, status: "confirmed" as const, lines: [{ amount: 1000, vatAmount: 0, whtAmount: 0 }] };

    const infinityCase = validateNoteInput(
      { docType: "credit_note", docDate: "2026-08-01", reason: "x", lines: [{ accountCode: "4010", amount: Infinity, vatAmount: 0 }] },
      entryInfo
    );
    // Infinity ไม่ผ่าน Number.isFinite → asAmount คืน 0 → amount ไม่มากกว่า 0 → ปฏิเสธ (ไม่ throw, ไม่หลุดเป็น Infinity ใน DB)
    expect(infinityCase.ok).toBe(false);

    const nanCase = validateNoteInput(
      { docType: "credit_note", docDate: "2026-08-01", reason: "x", lines: [{ accountCode: "4010", amount: NaN, vatAmount: 0 }] },
      entryInfo
    );
    expect(nanCase.ok).toBe(false);

    const hugeCase = validateNoteInput(
      { docType: "credit_note", docDate: "2026-08-01", reason: "x", lines: [{ accountCode: "4010", amount: 1e21, vatAmount: 0 }] },
      entryInfo
    );
    // ★ พบช่องโหว่ validate: ตัวเลขมหาศาลไม่ถูกปฏิเสธ/ครอบเพดานเลย (ไม่มี MAX_AMOUNT guard ในโค้ดปัจจุบัน
    //   ต่างจาก sales-documents.ts ที่มี PRICE_MAX=1_000_000_000) — ผ่านเข้าไปตรง ๆ จนเกิด floating-point
    //   precision drift (round2 คูณ 100 แล้วปัดเศษกับเลขระดับ 1e21 ทำให้ค่าที่ได้ไม่ตรงเป๊ะกับที่กรอกเข้ามา)
    expect(hugeCase.ok).toBe(true);
    if (hugeCase.ok) {
      expect(hugeCase.value.lines[0].amount).toBeGreaterThan(1e20); // ยังคงเป็นตัวเลขมหาศาลผ่านไปได้ ไม่ถูกปฏิเสธ
      expect(hugeCase.value.lines[0].amount).not.toBe(1e21); // precision drift จริงจาก round2()
    }

    const scriptInjection = validateNoteInput(
      { docType: "credit_note", docDate: "2026-08-01", reason: "<script>alert(1)</script>", lines: [{ accountCode: "4010", amount: 100, vatAmount: 0 }] },
      entryInfo
    );
    // ไม่ sanitize/escape HTML ที่ชั้นนี้ (เก็บตรง ๆ เป็น text — ต้อง escape ตอน render ฝั่ง UI แทน) — ไม่ throw อย่างน้อย
    expect(scriptInjection.ok).toBe(true);
    if (scriptInjection.ok) expect(scriptInjection.value.reason).toContain("<script>");
  });
});

// ===========================================================================
// ส่วน K — ขั้นตอน 11-17 ของแผนทดสอบ (QT/PO เลขแยกชุด, billing_note snapshot, สโคป)
// ===========================================================================
describe("เฟส 3 ส่วน K — flow เต็ม: QT/PO/BN เลขที่แยกชุดกัน + billing_note ไม่ sync ย้อนหลัง", () => {
  it("ขั้นตอน 11-13: สร้าง QT และ PO พร้อมกัน → ออกเอกสารพร้อมกัน → เลขที่แยกชุด ไม่ปนกัน", async () => {
    const { db } = makeMultiTableDb();
    const qt = await createDraftDocument(db, "t1", "c1", {
      documentType: "quotation",
      docDate: "2026-08-01",
      counterpartyName: "บริษัท ลูกค้า จำกัด",
      lines: [{ description: "สินค้า A", amount: 1000, vatAmount: 70 }],
    });
    const po = await createDraftDocument(db, "t1", "c1", {
      documentType: "purchase_order",
      docDate: "2026-08-01",
      counterpartyName: "บริษัท ซัพพลายเออร์ จำกัด",
      lines: [{ description: "วัตถุดิบ B", amount: 500, vatAmount: 35 }],
    });
    expect(qt.ok && po.ok).toBe(true);

    // ★ ออกเอกสารพร้อมกัน (Promise.all) — จำลอง race — ต้องได้เลขแยกชุด QT/PO ไม่ชนกัน
    const [resQt, resPo] = await Promise.all([
      issueDocument(db, "t1", qt.ok ? qt.id : "", "quotation"),
      issueDocument(db, "t1", po.ok ? po.id : "", "purchase_order"),
    ]);
    expect(resQt.ok && resPo.ok).toBe(true);
    if (resQt.ok && resPo.ok) {
      expect(resQt.docNo).toMatch(/^QT-\d{4}-0001$/);
      expect(resPo.docNo).toMatch(/^PO-\d{4}-0001$/); // ไม่ใช่ PO-...-0002 (คนละชุด ไม่ต่อเนื่องจาก QT)
    }

    // ออก QT ใบที่สอง → ต้องเป็น 0002 (ต่อจาก QT เดิม ไม่ถูก PO แซง/รบกวน)
    const qt2 = await createDraftDocument(db, "t1", "c1", {
      documentType: "quotation",
      docDate: "2026-08-02",
      lines: [{ amount: 200, vatAmount: 14 }],
    });
    const resQt2 = await issueDocument(db, "t1", qt2.ok ? qt2.id : "", "quotation");
    expect(resQt2.ok).toBe(true);
    if (resQt2.ok) expect(resQt2.docNo).toMatch(/^QT-\d{4}-0002$/);
  });

  it("ขั้นตอน 14-15: billing_note prefill จากบิลค้างชำระ → snapshot คงที่ ไม่ sync ย้อนหลังแม้บิลต้นทางถูกแก้", async () => {
    const { db, tables } = makeMultiTableDb();
    // จำลองว่าตอนสร้าง billing_note ผู้ใช้ดึงยอดค้างชำระจากบิลต้นทางมา prefill (700 บาท ณ ตอนนั้น)
    const sourceBillEntryId = "11111111-1111-1111-1111-111111111111";
    const created = await createDraftDocument(db, "t1", "c1", {
      documentType: "billing_note",
      docDate: "2026-08-01",
      counterpartyName: "บริษัท ลูกค้า จำกัด",
      lines: [
        {
          description: "ตามใบแจ้งหนี้ INV-100",
          sourceBillEntryId,
          amount: 700,
          vatAmount: 0,
        },
      ],
    });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.id : "";
    const issued = await issueDocument(db, "t1", id, "billing_note");
    expect(issued.ok).toBe(true);
    if (issued.ok) expect(issued.docNo).toMatch(/^BN-\d{4}-0001$/);

    const before = await getSalesDocument(db, "t1", id);
    expect(before?.lines[0].amount).toBe(700);
    expect(lineTotal(before?.lines ?? [])).toBe(700);

    // ★ บิลต้นทางถูกแก้ยอดทีหลัง (จำลองแก้บิล INV-100 ยอดใหม่กลายเป็น 900) —
    //   sales_document_lines ไม่ join บิลต้นทางเลย จึงไม่มีทางเห็นการเปลี่ยนแปลงนี้ (0.14 by design)
    const billRow = tables.bill_entries.find((r) => r.id === sourceBillEntryId);
    if (billRow) billRow.customer_id = "changed-to-prove-no-join"; // เผื่อมีการ join ในอนาคตจะจับได้ทันที

    const after = await getSalesDocument(db, "t1", id);
    expect(after?.lines[0].amount).toBe(700); // ยังเป็นค่าเดิมเป๊ะ ไม่ sync ตามบิลต้นทาง
    expect(after?.lines[0].sourceBillEntryId).toBe(sourceBillEntryId);
  });

  // -----------------------------------------------------------------
  // Edge case เพิ่มเติม (นอกแผน 17 ข้อ) — QA เจาะเอง
  // -----------------------------------------------------------------
  it("★ edge: sales_document ที่ไม่มี lines เลย (แถวหัวมีแต่ไม่มีบรรทัด — เช่นบรรทัดถูกลบนอก flow ปกติ) → ไม่ throw คืน lines:[] ", async () => {
    const { db, tables } = makeMultiTableDb();
    // แทรกแถวหัวตรง ๆ โดยไม่ผ่าน createDraftDocument (จำลองข้อมูลผิดปกติ/legacy)
    tables.sales_documents.push({
      id: "doc-orphan",
      tenant_id: "t1",
      customer_id: "c1",
      document_type: "quotation",
      doc_no: null,
      doc_date: "2026-08-01",
      valid_until: null,
      counterparty_name: null,
      counterparty_tax_id: null,
      counterparty_address: null,
      notes: null,
      status: "draft",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      issued_at: null,
      deleted_at: null,
    });
    const doc = await getSalesDocument(db, "t1", "doc-orphan");
    expect(doc).not.toBeNull();
    expect(doc?.lines).toEqual([]);
    expect(lineTotal(doc?.lines ?? [])).toBe(0); // ไม่ throw ไม่ NaN
  });

  it("★ edge: product_id ในบรรทัดอ้างถึงสินค้าที่ถูกลบไปแล้ว (products ไม่มี join ใน sales-documents.ts) → getSalesDocument ยังคืนค่าปกติ ไม่พัง", async () => {
    const { db } = makeMultiTableDb();
    const deletedProductId = "22222222-2222-2222-2222-222222222222";
    const created = await createDraftDocument(db, "t1", "c1", {
      documentType: "quotation",
      docDate: "2026-08-01",
      lines: [{ description: "สินค้าที่ถูกลบภายหลัง", productId: deletedProductId, amount: 300, vatAmount: 21 }],
    });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.id : "";

    // ไม่มี products table ในสคีมาที่ sales-documents.ts อ่านเลย (0.11 — ไม่ join engine/master data อื่น)
    // จำลอง "สินค้าถูกลบ" คือไม่มีอะไรให้ join สำเร็จ — พิสูจน์ว่าโค้ดไม่พังเพราะไม่ได้พึ่ง join นี้อยู่แล้ว
    const doc = await getSalesDocument(db, "t1", id);
    expect(doc?.lines[0].productId).toBe(deletedProductId); // ยังเก็บ id ไว้ตรง ๆ (snapshot, ไม่ throw ไม่ null ทิ้ง)
    expect(doc?.lines[0].amount).toBe(300); // ยอดเงินไม่กระทบ (ไม่ได้อ้างอิงราคาจาก products ตอนอ่าน)
  });

  it("★ พบช่องโหว่ validate: `amount` (แหล่งความจริงของยอด) ไม่มีเพดานสูงสุด — PRICE_MAX (1,000,000,000) ผูกไว้เฉพาะ unitPrice เท่านั้น ไม่ได้คุม amount", async () => {
    const { validateLineInput } = await import("@/lib/accounting/sales-documents");
    const v = validateLineInput({ amount: 1e15, unitPrice: 100 });
    expect(v).not.toBeNull();
    // amount 1 พันล้านล้านบาท ผ่าน validate ได้ตรง ๆ ทั้งที่ unitPrice ถูกจำกัดไว้ที่ 1,000,000,000 (PRICE_MAX)
    expect(v?.amount).toBe(1e15);
    expect(v!.amount).toBeGreaterThan(1_000_000_000); // เกิน PRICE_MAX ที่ตั้งใจใช้คุม unitPrice ไปมาก แต่ amount ไม่ถูกคุมด้วยเพดานเดียวกันเลย
  });
});

// ===========================================================================
// ★★★ พบระหว่างทดสอบ (2026-08-08): TOCTOU atomic guard (.update(...).select("id").maybeSingle())
// ที่เพิ่งเพิ่มเข้า updateDraftNote/updateDraftDocument/softDeleteDraft ทำให้
//   tests/accounting/credit-debit-notes-actions.test.ts, tests/accounting/sales-documents-actions.test.ts,
//   tests/accounting/sales-documents.test.ts (3 ไฟล์, 5 เคส) แดงอยู่ตอนนี้ — เพราะ resolver/fake-db เดิม
//   ของ 3 ไฟล์นั้นยังไม่รองรับ terminal "maybeSingle" หลัง .update()/.delete() (คืน data:null เสมอ)
// ชุดเทสต์นี้พิสูจน์ว่า "ตรรกะจริง" ของฟังก์ชันทั้ง 3 ตัวถูกต้อง เมื่อจำลอง DB ให้ apply payload ก่อนคืนผล
// (เหมือน Supabase UPDATE...RETURNING จริง) — สรุปว่าต้นเหตุคือ mock ในไฟล์เทสต์เดิมล้าสมัย ไม่ใช่บั๊กจริง
// ===========================================================================
describe("ยืนยันแยกส่วน: TOCTOU atomic guard (update...select().maybeSingle()) ทำงานถูกต้องเมื่อจำลอง DB ให้ apply payload จริง", () => {
  it("updateDraftNote (credit-debit-notes.ts) — แก้ draft สำเร็จเมื่อ DB จำลอง apply update ก่อนคืนผล", async () => {
    const { db, tables } = makeMultiTableDb();
    seedBillEntry(tables, "sale-toctou-1", { customerId: "c1", entryType: "sale", lines: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }] });
    const created = await createDraftNote(db, "t1", "sale-toctou-1", {
      docType: "credit_note",
      docDate: "2026-08-01",
      reason: "เดิม",
      lines: [{ accountCode: "4010", amount: 100, vatAmount: 0 }],
    });
    const id = created.ok ? created.id : "";
    const updated = await updateDraftNote(db, "t1", id, {
      docType: "credit_note",
      docDate: "2026-08-01",
      reason: "แก้ไขแล้ว",
      lines: [{ accountCode: "4010", amount: 250, vatAmount: 0 }],
    });
    expect(updated.ok).toBe(true); // ★ ถ้า false แปลว่า production logic เองมีปัญหาจริง (ไม่ใช่แค่ mock)
    expect(tables.credit_debit_notes.find((n) => n.id === id)?.reason).toBe("แก้ไขแล้ว");
  });

  it("updateDraftDocument (sales-documents.ts) — แก้ draft สำเร็จเมื่อ DB จำลอง apply update ก่อนคืนผล", async () => {
    const { db } = makeMultiTableDb();
    const created = await createDraftDocument(db, "t1", "c1", {
      documentType: "quotation",
      docDate: "2026-08-01",
      lines: [{ amount: 100, vatAmount: 7 }],
    });
    const id = created.ok ? created.id : "";
    const updated = await updateDraftDocument(db, "t1", id, {
      documentType: "quotation",
      docDate: "2026-08-02",
      counterpartyName: "ลูกค้าใหม่",
      lines: [{ amount: 999, vatAmount: 0 }],
    });
    expect(updated.ok).toBe(true);
    const doc = await getSalesDocument(db, "t1", id);
    expect(doc?.counterpartyName).toBe("ลูกค้าใหม่");
  });

  it("softDeleteDraft (sales-documents.ts) — ลบ draft สำเร็จเมื่อ DB จำลอง apply update ก่อนคืนผล", async () => {
    const { db, tables } = makeMultiTableDb();
    const created = await createDraftDocument(db, "t1", "c1", {
      documentType: "quotation",
      docDate: "2026-08-01",
      lines: [{ amount: 100, vatAmount: 7 }],
    });
    const id = created.ok ? created.id : "";
    const deleted = await softDeleteDraft(db, "t1", id);
    expect(deleted.ok).toBe(true);
    expect(tables.sales_documents.find((d) => d.id === id)?.deleted_at).toBeTruthy();
  });
});

// ===========================================================================
// ขั้นตอน 17 — นักบัญชีนอกสโคป เข้าถึงไม่ได้ทั้ง credit-debit-notes และ sales-documents
// ===========================================================================
describe("เฟส 3 ขั้นตอน 17 — นักบัญชีนอกสโคป เข้าถึงไม่ได้ทั้ง 2 ฟีเจอร์ (ทดสอบผ่าน action จริง)", () => {
  const { requireAccountingAccessMock } = vi.hoisted(() => ({
    requireAccountingAccessMock: vi.fn(),
  }));

  let currentDb: ReturnType<typeof makeFakeDb>["db"];
  let currentCapture: Capture;

  vi.mock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => ({ __authed: true })),
    createServiceRoleClient: vi.fn(() => currentDb),
  }));
  vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
  vi.mock("@/lib/accounting/access", async (importActual) => {
    const actual = await importActual<typeof import("@/lib/accounting/access")>();
    return { ...actual, requireAccountingAccess: (...args: unknown[]) => requireAccountingAccessMock(...args) };
  });

  const CUSTOMER_MINE = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const ENTRY_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

  function accountantCtx(allowed: string[]) {
    return {
      tenantId: "tenant-1",
      mode: "accountant" as const,
      employeeId: "emp-1",
      name: "นักบัญชี",
      allowedCustomerIds: new Set(allowed),
      navRole: "accountant" as const,
    };
  }

  function makeResolver(): Resolver {
    return ({ table, op, terminal }) => {
      // บิลต้นทาง/เอกสารเป็นของ "ลูกค้าอื่น" เสมอ (ไม่ใช่ลูกค้าที่นักบัญชีคนนี้ดูแล)
      if (table === "bill_entries" && op === "select" && terminal === "maybeSingle") {
        return { data: { customer_id: CUSTOMER_OTHER, entry_type: "sale", payment_method: "credit", status: "confirmed" }, error: null };
      }
      if (table === "sales_documents" && op === "select" && terminal === "maybeSingle") {
        return { data: { customer_id: CUSTOMER_OTHER, status: "draft", document_type: "quotation" }, error: null };
      }
      // getNoteScope(id) โหลด note head (entry_id/status) ก่อน แล้วค่อย derive scope จาก bill_entries จริง —
      // ให้ entry_id ตรงกับกรณี bill_entries ด้านบน (ทดสอบเส้นทาง "นอกสโคป" จริง ไม่ใช่แค่ "ไม่พบ")
      if (table === "credit_debit_notes" && op === "select" && terminal === "maybeSingle") {
        return { data: { entry_id: ENTRY_ID, status: "draft" }, error: null };
      }
      return { data: null, error: null };
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_MINE])); // ดูแลเฉพาะ CUSTOMER_MINE
    const { db, capture } = makeFakeDb(makeResolver());
    currentDb = db;
    currentCapture = capture;
  });

  it("credit-debit-notes: นักบัญชีนอกสโคป → upsert/confirm/void ถูกปฏิเสธหมด ไม่แตะ DB", async () => {
    const { upsertNoteAction, confirmNoteAction, voidNoteAction } = await import(
      "@/app/chat-audit/accounting/credit-debit-notes/actions"
    );
    const validInput = {
      entryId: ENTRY_ID,
      docType: "credit_note",
      docDate: "2026-08-01",
      reason: "ทดสอบสโคป",
      lines: [{ accountCode: "4010", amount: 100, vatAmount: 0 }],
    };
    const upsert = await upsertNoteAction(validInput);
    expect(upsert.ok).toBe(false);
    // ★ confirmNoteAction/voidNoteAction รับแค่ id เดียว (derive entryId จาก note จริงภายใน getNoteScope —
    //   แก้ IDOR: ก่อนหน้านี้เคยรับ entryId แยกจาก client ซึ่งอาจไม่ตรงกับ note ตัวจริงที่ id ระบุ)
    const confirm = await confirmNoteAction("11111111-1111-1111-1111-111111111111");
    expect(confirm.ok).toBe(false);
    const voidRes = await voidNoteAction("11111111-1111-1111-1111-111111111111");
    expect(voidRes.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "credit_debit_notes")).toBeUndefined();
    expect(currentCapture.updates.find((u) => u.table === "credit_debit_notes")).toBeUndefined();
  });

  it("sales-documents: นักบัญชีนอกสโคป → update/delete/issue/void ถูกปฏิเสธหมด ไม่แตะ DB (create ก็ถูกปฏิเสธถ้าระบุ customerId อื่น)", async () => {
    const { createDraftAction, updateDraftAction, deleteDraftAction, issueDocumentAction, voidDocumentAction } = await import(
      "@/app/chat-audit/accounting/sales-documents/actions"
    );
    const DOC_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const validInput = {
      documentType: "quotation",
      docDate: "2026-08-01",
      lines: [{ amount: 100, vatAmount: 7 }],
    };

    const created = await createDraftAction(CUSTOMER_OTHER, validInput);
    expect(created.ok).toBe(false);
    const updated = await updateDraftAction(DOC_ID, validInput);
    expect(updated.ok).toBe(false);
    const deleted = await deleteDraftAction(DOC_ID);
    expect(deleted.ok).toBe(false);
    const issued = await issueDocumentAction(DOC_ID);
    expect(issued.ok).toBe(false);
    const voided = await voidDocumentAction(DOC_ID);
    expect(voided.ok).toBe(false);

    expect(currentCapture.inserts.find((i) => i.table === "sales_documents")).toBeUndefined();
    expect(currentCapture.updates.find((u) => u.table === "sales_documents")).toBeUndefined();
    expect(currentCapture.rpcs ?? []).toHaveLength(0);
  });
});
