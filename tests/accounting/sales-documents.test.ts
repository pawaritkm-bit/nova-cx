import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * sales-documents.ts — เฟส 3 ส่วน K (K3-K5, K10, docs/06-accounting-features-roadmap.md)
 *   เน้น: lineTotal (reuse summarizeEntry) · validateLineInput/validateDocumentInput ทุก branch ·
 *   data layer (mock DB, pattern เดียวกับ credit-debit-notes.test.ts) · listBillingCandidates
 *   (mock listEntries/listBillPaymentsForEntries) · issueDocument เรียกซ้อนพร้อมกัน (Promise.all)
 *   ได้เลขไม่ซ้ำ · voidDocument เฉพาะจาก issued
 *
 * ★★★ ยืนยันด้วยโค้ด review (0.11, K3 DoD): sales-documents.ts ไม่ import จาก
 *   journal.ts/ledger.ts/statements.ts/journal-books.ts/payment.ts เลยแม้แต่บรรทัดเดียว
 */

const { listEntriesMock, listBillPaymentsForEntriesMock, listNotesForEntriesMock } = vi.hoisted(() => ({
  listEntriesMock: vi.fn(),
  listBillPaymentsForEntriesMock: vi.fn(),
  listNotesForEntriesMock: vi.fn(),
}));

vi.mock("@/lib/accounting/queries", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/queries")>();
  return { ...actual, listEntries: listEntriesMock };
});

vi.mock("@/lib/accounting/bill-payments", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/bill-payments")>();
  return { ...actual, listBillPaymentsForEntries: listBillPaymentsForEntriesMock };
});

// เฟส 3 ส่วน J (0.6): mock เฉพาะ listNotesForEntries (data layer) — netAdjustmentByEntry/noteSignedAdjustment
//   เป็น pure function ปล่อยให้รันจริง (ไม่มีสูตรคู่ขนาน)
vi.mock("@/lib/accounting/credit-debit-notes", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/credit-debit-notes")>();
  return { ...actual, listNotesForEntries: listNotesForEntriesMock };
});

import {
  lineTotal,
  validateLineInput,
  validateDocumentInput,
  getDocumentScope,
  listSalesDocuments,
  getSalesDocument,
  listBillingCandidates,
  createDraftDocument,
  updateDraftDocument,
  softDeleteDraft,
  softDeleteDocument,
  issueDocument,
  voidDocument,
  type SalesDocumentInput,
} from "@/lib/accounting/sales-documents";

// ---------------------------------------------------------------------
// lineTotal — reuse summarizeEntry (ไม่มีสูตรคู่ขนาน)
// ---------------------------------------------------------------------
describe("lineTotal", () => {
  it("= Σ(amount + vatAmount) ของทุกบรรทัด", () => {
    expect(
      lineTotal([
        { amount: 1000, vatAmount: 70 },
        { amount: 500, vatAmount: 35 },
      ])
    ).toBe(1605);
  });

  it("array ว่าง → 0", () => {
    expect(lineTotal([])).toBe(0);
  });
});

// ---------------------------------------------------------------------
// validateLineInput
// ---------------------------------------------------------------------
describe("validateLineInput", () => {
  it("amount > 0 + ครบ field → ผ่าน", () => {
    const v = validateLineInput({
      description: "สินค้า A",
      productId: "11111111-1111-1111-1111-111111111111",
      sourceBillEntryId: "22222222-2222-2222-2222-222222222222",
      quantity: 2,
      unit: "ชิ้น",
      unitPrice: 100,
      amount: 200,
      vatAmount: 14,
    });
    expect(v).toEqual({
      description: "สินค้า A",
      productId: "11111111-1111-1111-1111-111111111111",
      sourceBillEntryId: "22222222-2222-2222-2222-222222222222",
      quantity: 2,
      unit: "ชิ้น",
      unitPrice: 100,
      amount: 200,
      vatAmount: 14,
    });
  });

  it("amount = 0 → ปฏิเสธ (null)", () => {
    expect(validateLineInput({ amount: 0 })).toBeNull();
  });

  it("amount ติดลบ → ปฏิเสธ (null)", () => {
    expect(validateLineInput({ amount: -50 })).toBeNull();
  });

  it("amount ไม่ใช่ตัวเลข → ปฏิเสธ (null)", () => {
    expect(validateLineInput({ amount: "abc" })).toBeNull();
  });

  it("quantity ไม่ระบุ/ผิด/ติดลบ → default เป็น 1 (ไม่ปฏิเสธทั้งบรรทัด)", () => {
    expect(validateLineInput({ amount: 100 })?.quantity).toBe(1);
    expect(validateLineInput({ amount: 100, quantity: -5 })?.quantity).toBe(1);
    expect(validateLineInput({ amount: 100, quantity: "x" })?.quantity).toBe(1);
  });

  it("unitPrice ไม่ระบุ/ติดลบ → default เป็น 0", () => {
    expect(validateLineInput({ amount: 100 })?.unitPrice).toBe(0);
    expect(validateLineInput({ amount: 100, unitPrice: -10 })?.unitPrice).toBe(0);
  });

  it("vatAmount ไม่ระบุ → 0 (ไม่บังคับต้องมากกว่า 0)", () => {
    expect(validateLineInput({ amount: 100 })?.vatAmount).toBe(0);
  });

  it("productId/sourceBillEntryId ไม่ใช่ uuid → null (ไม่พัง ไม่ปฏิเสธทั้งบรรทัด)", () => {
    const v = validateLineInput({ amount: 100, productId: "not-a-uuid", sourceBillEntryId: "also-bad" });
    expect(v?.productId).toBeNull();
    expect(v?.sourceBillEntryId).toBeNull();
  });

  it("description/unit เกินความยาว → ตัดตามเพดาน (ไม่พัง)", () => {
    const v = validateLineInput({ amount: 100, description: "x".repeat(500), unit: "y".repeat(100) });
    expect(v?.description?.length).toBeLessThanOrEqual(200);
    expect(v?.unit?.length).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------
// validateDocumentInput
// ---------------------------------------------------------------------
function baseInput(p: Partial<SalesDocumentInput> = {}): SalesDocumentInput {
  return {
    documentType: "quotation",
    docDate: "2026-08-01",
    lines: [{ amount: 1000, vatAmount: 70 }],
    ...p,
  };
}

describe("validateDocumentInput", () => {
  it("input ครบถ้วนถูกต้อง (quotation) → ผ่าน", () => {
    const res = validateDocumentInput(baseInput({ validUntil: "2026-09-01", counterpartyName: "บริษัท เอบีซี" }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.documentType).toBe("quotation");
      expect(res.value.validUntil).toBe("2026-09-01");
      expect(res.value.lines).toHaveLength(1);
    }
  });

  it("documentType ไม่ถูกต้อง/ว่าง → ปฏิเสธ", () => {
    expect(validateDocumentInput(baseInput({ documentType: "invoice" })).ok).toBe(false);
    expect(validateDocumentInput(baseInput({ documentType: undefined })).ok).toBe(false);
  });

  it("docDate ผิดรูปแบบ/ว่าง → ปฏิเสธ", () => {
    expect(validateDocumentInput(baseInput({ docDate: "01/08/2026" })).ok).toBe(false);
    expect(validateDocumentInput(baseInput({ docDate: "" })).ok).toBe(false);
  });

  it("★ valid_until ใช้ได้เฉพาะ quotation — ประเภทอื่นบังคับ null เสมอ (0.10, เพิกเฉยไม่ปฏิเสธ)", () => {
    const resPo = validateDocumentInput(
      baseInput({ documentType: "purchase_order", validUntil: "2026-09-01" })
    );
    expect(resPo.ok).toBe(true);
    if (resPo.ok) expect(resPo.value.validUntil).toBeNull();

    const resBn = validateDocumentInput(baseInput({ documentType: "billing_note", validUntil: "2026-09-01" }));
    expect(resBn.ok).toBe(true);
    if (resBn.ok) expect(resBn.value.validUntil).toBeNull();
  });

  it("lines ว่าง → ปฏิเสธ", () => {
    expect(validateDocumentInput(baseInput({ lines: [] })).ok).toBe(false);
  });

  it("lines ไม่ใช่ array → ปฏิเสธ", () => {
    // @ts-expect-error ทดสอบ input ผิดชนิดจากภายนอก (ไม่เชื่อ client)
    expect(validateDocumentInput(baseInput({ lines: "x" })).ok).toBe(false);
  });

  it("lines เกินเพดาน (>200) → ปฏิเสธ", () => {
    const lines = Array.from({ length: 201 }, () => ({ amount: 10 }));
    expect(validateDocumentInput(baseInput({ lines })).ok).toBe(false);
  });

  it("บรรทัดใด amount ไม่มากกว่า 0 → ปฏิเสธทั้งใบ ระบุบรรทัดที่ผิด", () => {
    const res = validateDocumentInput(
      baseInput({ lines: [{ amount: 100 }, { amount: 0 }] })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("บรรทัดที่ 2");
  });

  it("★ source_bill_entry_id ต่อบรรทัด ใช้ได้เฉพาะ billing_note — ประเภทอื่นบังคับ null (0.10/0.14)", () => {
    const uuid = "33333333-3333-3333-3333-333333333333";
    const resQt = validateDocumentInput(
      baseInput({ documentType: "quotation", lines: [{ amount: 100, sourceBillEntryId: uuid }] })
    );
    expect(resQt.ok).toBe(true);
    if (resQt.ok) expect(resQt.value.lines[0].sourceBillEntryId).toBeNull();

    const resBn = validateDocumentInput(
      baseInput({ documentType: "billing_note", lines: [{ amount: 100, sourceBillEntryId: uuid }] })
    );
    expect(resBn.ok).toBe(true);
    if (resBn.ok) expect(resBn.value.lines[0].sourceBillEntryId).toBe(uuid);
  });

  it("counterparty/notes เกินความยาว → ตัดตามเพดาน ไม่ปฏิเสธ", () => {
    const res = validateDocumentInput(
      baseInput({ counterpartyName: "x".repeat(500), notes: "y".repeat(1000) })
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.counterpartyName?.length).toBeLessThanOrEqual(200);
      expect(res.value.notes?.length).toBeLessThanOrEqual(500);
    }
  });
});

// ---------------------------------------------------------------------
// data layer (mock DB — pattern เดียวกับ credit-debit-notes.test.ts)
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

function makeFakeDb(): {
  db: SupabaseClient;
  docs: Row[];
  lines: Row[];
  counters: Map<string, number>;
} {
  const docs: Row[] = [];
  const lines: Row[] = [];
  const counters = new Map<string, number>();
  let nextDocId = 1;
  let nextLineId = 1;

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
      if (mode === "insert" && table === "sales_documents") {
        const id = `d${nextDocId++}`;
        const row: Row = {
          id,
          deleted_at: null,
          doc_no: null,
          issued_at: null,
          status: "draft",
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-01T00:00:00Z",
          ...(payload as Row),
        };
        docs.push(row);
        return Promise.resolve({ data: { id }, error: null });
      }
      // ★ updateDraftDocument/softDeleteDraft กำกับ .eq("status","draft") เข้าคำสั่งเขียนจริงเอง แล้วเช็ค
      //   ผลด้วย .select("id").maybeSingle() (TOCTOU guard) — ต้องประยุกต์ payload จริงตรงนี้ (ไม่ใช่แค่ที่
      //   .then() เหมือนเดิม) แล้วคืน null ถ้าไม่มีแถวไหนตรง filters เลย (จำลอง 0 rows affected)
      if (mode === "update" && table === "sales_documents") {
        const row = docs.find((r) => matchRow(r, filters));
        if (!row) return Promise.resolve({ data: null, error: null });
        Object.assign(row, payload as Row);
        return Promise.resolve({ data: { id: row.id }, error: null });
      }
      if (table === "sales_documents") {
        const row = docs.find((r) => matchRow(r, filters));
        return Promise.resolve({ data: row ? { ...row } : null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = [];
      if (mode === "insert" && table === "sales_document_lines") {
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const r of rows as Row[]) {
          const id = `l${nextLineId++}`;
          lines.push({ id, ...r });
        }
        data = null;
      } else if (mode === "update" && table === "sales_documents") {
        for (const row of docs) if (matchRow(row, filters)) Object.assign(row, payload as Row);
        data = null;
      } else if (mode === "delete" && table === "sales_documents") {
        for (let i = docs.length - 1; i >= 0; i--) if (matchRow(docs[i], filters)) docs.splice(i, 1);
        data = null;
      } else if (mode === "delete" && table === "sales_document_lines") {
        for (let i = lines.length - 1; i >= 0; i--) if (matchRow(lines[i], filters)) lines.splice(i, 1);
        data = null;
      } else if (table === "sales_documents") {
        data = docs.filter((r) => matchRow(r, filters));
      } else if (table === "sales_document_lines") {
        data = lines.filter((r) => matchRow(r, filters));
      }
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }

  // จำลอง RPC issue_sales_document() — increment counter (in-memory) + ล็อกแถวเป็น issued
  //   เฉพาะแถวที่ยัง 'draft' เท่านั้น (mirror ตรรกะ SQL จริงใน migration 0070)
  function rpc(fn: string, params: Record<string, unknown>) {
    if (fn !== "issue_sales_document") {
      return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
    }
    const key = `${params.p_tenant_id}|${params.p_document_type}|${params.p_be_year}`;
    const seq = (counters.get(key) ?? 0) + 1;
    counters.set(key, seq);
    const docNo = `${params.p_prefix}-${params.p_be_year}-${String(seq).padStart(4, "0")}`;

    const row = docs.find(
      (r) =>
        r.id === params.p_document_id &&
        r.tenant_id === params.p_tenant_id &&
        r.document_type === params.p_document_type &&
        r.status === "draft" &&
        !r.deleted_at
    );
    if (!row) {
      return Promise.resolve({ data: null, error: { message: "sales_document not found or not draft" } });
    }
    row.doc_no = docNo;
    row.status = "issued";
    row.issued_at = "2026-08-08T00:00:00Z";
    return Promise.resolve({ data: { id: row.id, doc_no: docNo }, error: null });
  }

  return { db: { from: (t: string) => qb(t), rpc } as unknown as SupabaseClient, docs, lines, counters };
}

const validDocInput: SalesDocumentInput = {
  documentType: "quotation",
  docDate: "2026-08-01",
  counterpartyName: "บริษัท ทดสอบ จำกัด",
  lines: [{ description: "สินค้า A", quantity: 2, unitPrice: 100, amount: 200, vatAmount: 14 }],
};

describe("createDraftDocument", () => {
  it("input ถูกต้อง → สร้าง draft สำเร็จ พร้อมบรรทัด (doc_no ยังเป็น null)", async () => {
    const { db, docs, lines } = makeFakeDb();
    const res = await createDraftDocument(db, "t1", "c1", validDocInput);
    expect(res.ok).toBe(true);
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("draft");
    expect(docs[0].doc_no).toBeNull();
    expect(docs[0].customer_id).toBe("c1");
    expect(lines).toHaveLength(1);
  });

  it("input ไม่ผ่าน validate → ปฏิเสธ ไม่ insert", async () => {
    const { db, docs } = makeFakeDb();
    const res = await createDraftDocument(db, "t1", "c1", { ...validDocInput, lines: [] });
    expect(res.ok).toBe(false);
    expect(docs).toHaveLength(0);
  });
});

describe("updateDraftDocument / softDeleteDraft", () => {
  it("draft แก้ไขได้ — บรรทัดถูกแทนที่ทั้งชุด", async () => {
    const { db, lines } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";

    const updated = await updateDraftDocument(db, "t1", id, {
      ...validDocInput,
      lines: [{ amount: 999, vatAmount: 0 }],
    });
    expect(updated.ok).toBe(true);
    const linesOfDoc = lines.filter((l) => l.document_id === id);
    expect(linesOfDoc).toHaveLength(1);
    expect(linesOfDoc[0].amount).toBe(999);
  });

  it("★ issued แล้วแก้ไขไม่ได้ (0.16) — ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";
    const issued = await issueDocument(db, "t1", id, "quotation");
    expect(issued.ok).toBe(true);

    const updated = await updateDraftDocument(db, "t1", id, validDocInput);
    expect(updated.ok).toBe(false);
  });

  it("ไม่พบเอกสาร → ปฏิเสธทุกฟังก์ชัน", async () => {
    const { db } = makeFakeDb();
    expect((await updateDraftDocument(db, "t1", "missing", validDocInput)).ok).toBe(false);
    expect((await softDeleteDraft(db, "t1", "missing")).ok).toBe(false);
    expect((await voidDocument(db, "t1", "missing")).ok).toBe(false);
  });

  it("softDeleteDraft — ลบได้เฉพาะ draft เท่านั้น ไม่เสียเลข (ยังไม่มีเลข)", async () => {
    const { db, docs } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";
    const deleted = await softDeleteDraft(db, "t1", id);
    expect(deleted.ok).toBe(true);
    expect(docs.find((d) => d.id === id)?.deleted_at).toBeTruthy();
  });

  it("★ ลบเอกสารที่ issued แล้วไม่ได้ (ต้องใช้ voidDocument แทน)", async () => {
    const { db } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";
    await issueDocument(db, "t1", id, "quotation");
    const deleted = await softDeleteDraft(db, "t1", id);
    expect(deleted.ok).toBe(false);
  });

  // ★ 2026-09-03 ผู้ใช้: "ตั้งให้ใบวางบิลที่ออกแล้วสามารถกดลบได้" — softDeleteDocument ลบได้ทุกสถานะ
  it("softDeleteDocument — ลบเอกสารที่ issued แล้วได้ (soft delete, เลขที่ไม่ถูกนำกลับมาใช้)", async () => {
    const { db, docs } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";
    const issued = await issueDocument(db, "t1", id, "quotation");
    expect(issued.ok).toBe(true);
    const deleted = await softDeleteDocument(db, "t1", id);
    expect(deleted.ok).toBe(true);
    expect(docs.find((d) => d.id === id)?.deleted_at).toBeTruthy();
  });

  it("softDeleteDocument — ลบ draft ได้เหมือนกัน · เอกสารที่ไม่มี/ลบไปแล้ว → ปฏิเสธ", async () => {
    const { db, docs } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";
    expect((await softDeleteDocument(db, "t1", id)).ok).toBe(true);
    expect(docs.find((d) => d.id === id)?.deleted_at).toBeTruthy();
    // ลบซ้ำ = ไม่พบแล้ว (deleted_at กรองใน getDocumentScope)
    expect((await softDeleteDocument(db, "t1", id)).ok).toBe(false);
    expect((await softDeleteDocument(db, "t1", "missing")).ok).toBe(false);
  });

  // ---------------------------------------------------------------------
  // ★★★ TOCTOU race guard — updateDraftDocument/softDeleteDraft เช็ค status='draft' ผ่าน getDocumentScope()
  //   (SELECT แยก) ก่อน แล้วค่อยเขียนจริง — ถ้า issueDocument() แทรกเข้ามาพอดีระหว่างช่วงนั้น คำสั่งเขียนจริง
  //   ต้องกำกับ .eq("status","draft") เองด้วยแล้วปฏิเสธ ไม่ใช่เขียนทับเงียบ ๆ จำลอง race จริงด้วย Promise.all
  //   (เหมือน "เรียกซ้อนพร้อมกัน" ของ issueDocument ข้างบน — ไม่ใช่แค่ mock ผลลัพธ์)
  // ---------------------------------------------------------------------
  it("★ TOCTOU race: issueDocument() แทรกเข้ามาพอดีระหว่าง updateDraftDocument() เช็คสถานะกับเขียนจริง → ปฏิเสธ ไม่ใช่เขียนทับสำเร็จ", async () => {
    const { db, docs } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";

    const [updateRes, issueRes] = await Promise.all([
      updateDraftDocument(db, "t1", id, { ...validDocInput, notes: "แก้ระหว่าง race" }),
      issueDocument(db, "t1", id, "quotation"),
    ]);

    expect(issueRes.ok).toBe(true);
    expect(updateRes.ok).toBe(false); // ต้องถูกปฏิเสธ — ไม่ใช่เขียนทับเอกสารที่ออกเลขไปแล้ว
    const doc = docs.find((d) => d.id === id);
    expect(doc?.status).toBe("issued");
    expect(doc?.notes).not.toBe("แก้ระหว่าง race"); // ค่าจาก update ที่แพ้ race ต้องไม่ถูกเขียนทับเข้าไป
  });

  it("★ TOCTOU race: issueDocument() แทรกเข้ามาพอดีระหว่าง softDeleteDraft() เช็คสถานะกับลบจริง → ปฏิเสธ ไม่ใช่ลบทับสำเร็จ", async () => {
    const { db, docs } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";

    const [deleteRes, issueRes] = await Promise.all([
      softDeleteDraft(db, "t1", id),
      issueDocument(db, "t1", id, "quotation"),
    ]);

    expect(issueRes.ok).toBe(true);
    expect(deleteRes.ok).toBe(false); // ต้องถูกปฏิเสธ — ไม่ใช่ลบทับเอกสารที่ออกเลขไปแล้ว
    const doc = docs.find((d) => d.id === id);
    expect(doc?.status).toBe("issued");
    expect(doc?.deleted_at).toBeNull();
  });
});

describe("getDocumentScope / getSalesDocument / listSalesDocuments", () => {
  it("getDocumentScope คืนสโคป+สถานะ+ประเภทถูกต้อง", async () => {
    const { db } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";
    const scope = await getDocumentScope(db, "t1", id);
    expect(scope).toEqual({ customerId: "c1", status: "draft", documentType: "quotation" });
  });

  it("getSalesDocument คืนหัว+บรรทัดครบ", async () => {
    const { db } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";
    const doc = await getSalesDocument(db, "t1", id);
    expect(doc?.id).toBe(id);
    expect(doc?.lines).toHaveLength(1);
  });

  it("listSalesDocuments กรองตามลูกค้า + ประเภทได้ถูกต้อง", async () => {
    const { db } = makeFakeDb();
    await createDraftDocument(db, "t1", "c1", validDocInput);
    await createDraftDocument(db, "t1", "c1", { ...validDocInput, documentType: "purchase_order" });
    await createDraftDocument(db, "t1", "c2", validDocInput); // ลูกค้าอื่น

    const all = await listSalesDocuments(db, "t1", "c1");
    expect(all).toHaveLength(2);

    const onlyQt = await listSalesDocuments(db, "t1", "c1", "quotation");
    expect(onlyQt).toHaveLength(1);
    expect(onlyQt[0].documentType).toBe("quotation");
  });
});

describe("issueDocument", () => {
  it("draft → issued ได้เลขที่ตามรูปแบบ {PREFIX}-{beYear}-{seq:04d}", async () => {
    const { db } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";
    const res = await issueDocument(db, "t1", id, "quotation");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.docNo).toMatch(/^QT-\d{4}-0001$/);
  });

  it("★ เรียกซ้อนพร้อมกัน (Promise.all) กับเอกสารคนละใบ ประเภทเดียวกัน → ได้เลขไม่ซ้ำกันเสมอ", async () => {
    const { db } = makeFakeDb();
    const a = await createDraftDocument(db, "t1", "c1", validDocInput);
    const b = await createDraftDocument(db, "t1", "c1", validDocInput);
    const idA = a.ok ? a.id : "";
    const idB = b.ok ? b.id : "";

    const [resA, resB] = await Promise.all([
      issueDocument(db, "t1", idA, "quotation"),
      issueDocument(db, "t1", idB, "quotation"),
    ]);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    if (resA.ok && resB.ok) {
      expect(resA.docNo).not.toBe(resB.docNo);
      const seqs = [resA.docNo, resB.docNo].map((n) => n.split("-")[2]).sort();
      expect(seqs).toEqual(["0001", "0002"]);
    }
  });

  it("★ ออกเอกสารซ้ำ (ใบเดิมที่ issued แล้ว) → ปฏิเสธ ไม่เผาเลขซ้ำ", async () => {
    const { db } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";
    const first = await issueDocument(db, "t1", id, "quotation");
    expect(first.ok).toBe(true);
    const second = await issueDocument(db, "t1", id, "quotation");
    expect(second.ok).toBe(false);
  });

  it("เลขที่แยกชุดตาม document_type (QT/PO/BN คนละชุดกัน เริ่มที่ 0001 ทุกประเภท)", async () => {
    const { db } = makeFakeDb();
    const qt = await createDraftDocument(db, "t1", "c1", validDocInput);
    const po = await createDraftDocument(db, "t1", "c1", { ...validDocInput, documentType: "purchase_order" });
    const bn = await createDraftDocument(db, "t1", "c1", { ...validDocInput, documentType: "billing_note" });

    const resQt = await issueDocument(db, "t1", qt.ok ? qt.id : "", "quotation");
    const resPo = await issueDocument(db, "t1", po.ok ? po.id : "", "purchase_order");
    const resBn = await issueDocument(db, "t1", bn.ok ? bn.id : "", "billing_note");
    expect(resQt.ok && resPo.ok && resBn.ok).toBe(true);
    if (resQt.ok && resPo.ok && resBn.ok) {
      expect(resQt.docNo).toMatch(/^QT-\d{4}-0001$/);
      expect(resPo.docNo).toMatch(/^PO-\d{4}-0001$/);
      expect(resBn.docNo).toMatch(/^BN-\d{4}-0001$/);
    }
  });
});

describe("voidDocument", () => {
  it("★ ยกเลิกได้เฉพาะจาก status='issued' เท่านั้น", async () => {
    const { db } = makeFakeDb();
    const created = await createDraftDocument(db, "t1", "c1", validDocInput);
    const id = created.ok ? created.id : "";

    // ยังเป็น draft → ยกเลิกไม่ได้
    const rejectDraft = await voidDocument(db, "t1", id);
    expect(rejectDraft.ok).toBe(false);

    await issueDocument(db, "t1", id, "quotation");
    const ok = await voidDocument(db, "t1", id);
    expect(ok.ok).toBe(true);

    // void แล้ว ยกเลิกซ้ำไม่ได้ (ไม่มีทางย้อนกลับ)
    const rejectAgain = await voidDocument(db, "t1", id);
    expect(rejectAgain.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------
// listBillingCandidates (0.14) — reuse isCreditEligibleForPayment + billOutstanding
// ---------------------------------------------------------------------
describe("listBillingCandidates", () => {
  beforeEach(() => {
    listEntriesMock.mockReset();
    listBillPaymentsForEntriesMock.mockReset();
    listNotesForEntriesMock.mockReset();
    listNotesForEntriesMock.mockResolvedValue(new Map()); // default: ไม่มี CN/DN เลย (ไม่กระทบ outstanding)
  });

  it("กรองเฉพาะบิลเชื่อ confirmed + outstanding > 0", async () => {
    listEntriesMock.mockResolvedValue({
      entries: [
        {
          id: "e1",
          entryType: "sale",
          paymentMethod: "credit",
          status: "confirmed",
          docNo: "INV-001",
          docDate: "2026-07-01",
          counterpartyName: "ลูกค้า A",
          lines: [{ amount: 1000, vatAmount: 70, whtAmount: 0 }],
        },
        {
          // ไม่ eligible (cash) — ต้องไม่ติดมา
          id: "e2",
          entryType: "sale",
          paymentMethod: "cash",
          status: "confirmed",
          docNo: "INV-002",
          docDate: "2026-07-02",
          counterpartyName: "ลูกค้า B",
          lines: [{ amount: 500, vatAmount: 35, whtAmount: 0 }],
        },
        {
          // eligible แต่จ่ายครบแล้ว (outstanding=0) — ต้องไม่ติดมา
          id: "e3",
          entryType: "purchase",
          paymentMethod: "credit",
          status: "confirmed",
          docNo: "INV-003",
          docDate: "2026-07-03",
          counterpartyName: "ผู้ขาย C",
          lines: [{ amount: 300, vatAmount: 21, whtAmount: 0 }],
        },
      ],
      summary: {},
    });
    listBillPaymentsForEntriesMock.mockResolvedValue(
      new Map([
        ["e1", []],
        ["e3", [{ amount: 321 }]],
      ])
    );

    const result = await listBillingCandidates({} as never, "t1", "c1");
    expect(result).toHaveLength(1);
    expect(result[0].entryId).toBe("e1");
    expect(result[0].outstanding).toBe(1070);
  });

  it("ไม่มีบิลเชื่อเลย → คืน array ว่าง (ไม่เรียก listBillPaymentsForEntries)", async () => {
    listEntriesMock.mockResolvedValue({ entries: [], summary: {} });
    const result = await listBillingCandidates({} as never, "t1", "c1");
    expect(result).toEqual([]);
    expect(listBillPaymentsForEntriesMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // ★★★ บั๊กที่แก้: ลืม thread netAdjustment (CN/DN confirmed) เข้า billOutstanding()
  //   ทำให้บิลที่มี Credit Note ยืนยันแล้วคำนวณ outstanding เกินจริง (ใบวางบิลเรียกเก็บเงินเกิน)
  // -------------------------------------------------------------------
  it("★ บิลมี Credit Note confirmed แล้ว → outstanding ต้องหัก CN ออก (ไม่ใช่ยอดเต็มของบิล, 0.6)", async () => {
    listEntriesMock.mockResolvedValue({
      entries: [
        {
          id: "e1",
          entryType: "sale",
          paymentMethod: "credit",
          status: "confirmed",
          docNo: "INV-010",
          docDate: "2026-07-01",
          counterpartyName: "ลูกค้า A",
          lines: [{ amount: 1000, vatAmount: 70, whtAmount: 0 }], // ยอดเต็ม 1070
        },
      ],
      summary: {},
    });
    listBillPaymentsForEntriesMock.mockResolvedValue(new Map([["e1", []]]));
    // CN confirmed ลดยอด 300 บาท (amount 280 + vat 20)
    listNotesForEntriesMock.mockResolvedValue(
      new Map([
        [
          "e1",
          [
            {
              id: "n1",
              tenantId: "t1",
              entryId: "e1",
              customerId: "c1",
              docType: "credit_note",
              docDate: "2026-07-05",
              docNo: null,
              reason: "สินค้าเสียหาย",
              status: "confirmed",
              createdAt: "2026-07-05T00:00:00Z",
              confirmedAt: "2026-07-05T00:00:00Z",
              lines: [
                { lineNo: 1, description: null, accountCode: "4000", accountName: null, amount: 280, vatAmount: 20 },
              ],
            },
          ],
        ],
      ])
    );

    const result = await listBillingCandidates({} as never, "t1", "c1");
    expect(result).toHaveLength(1);
    expect(result[0].netTotal).toBe(1070); // ยอดเต็มไม่ถูกกระทบ (สำเนา ณ เวลาบันทึกบิลเดิม)
    expect(result[0].outstanding).toBe(770); // 1070 - 300 (CN) = 770 — ไม่ใช่ 1070 เต็ม
  });

  it("★ CN ยังเป็น draft (ยังไม่ยืนยัน) → ไม่กระทบ outstanding เลย (0.5)", async () => {
    listEntriesMock.mockResolvedValue({
      entries: [
        {
          id: "e1",
          entryType: "sale",
          paymentMethod: "credit",
          status: "confirmed",
          docNo: "INV-011",
          docDate: "2026-07-01",
          counterpartyName: "ลูกค้า A",
          lines: [{ amount: 1000, vatAmount: 70, whtAmount: 0 }],
        },
      ],
      summary: {},
    });
    listBillPaymentsForEntriesMock.mockResolvedValue(new Map([["e1", []]]));
    listNotesForEntriesMock.mockResolvedValue(
      new Map([
        [
          "e1",
          [
            {
              id: "n1",
              tenantId: "t1",
              entryId: "e1",
              customerId: "c1",
              docType: "credit_note",
              docDate: "2026-07-05",
              docNo: null,
              reason: "ร่างไว้ก่อน",
              status: "draft",
              createdAt: "2026-07-05T00:00:00Z",
              confirmedAt: null,
              lines: [
                { lineNo: 1, description: null, accountCode: "4000", accountName: null, amount: 280, vatAmount: 20 },
              ],
            },
          ],
        ],
      ])
    );

    const result = await listBillingCandidates({} as never, "t1", "c1");
    expect(result[0].outstanding).toBe(1070); // draft ยังไม่กระทบยอด
  });
});
