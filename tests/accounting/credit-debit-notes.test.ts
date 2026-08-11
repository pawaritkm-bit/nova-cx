import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isEligibleForNote,
  noteLineTotal,
  noteNetTotal,
  noteSignedAdjustment,
  validateNoteInput,
  toJournalLines,
  toJournalPosting,
  getNoteEntryScope,
  listNotes,
  listNotesForEntries,
  netAdjustmentByEntry,
  createDraftNote,
  updateDraftNote,
  confirmNote,
  softDeleteNote,
  type NoteInput,
  type CreditDebitNote,
  type NoteJournalEntry,
} from "@/lib/accounting/credit-debit-notes";
import type { PaymentEntryInfo } from "@/lib/accounting/bill-payments";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { TEST_CHART } from "./fixtures/chart";

/**
 * credit-debit-notes.ts — เฟส 3 ส่วน J (docs/06-accounting-features-roadmap.md)
 *   เน้น: noteSignedAdjustment (0.5) · validateNoteInput (0.3/0.4) · toJournalLines/toJournalPosting
 *   สมดุลครบ 4 กรณีตามตาราง 0.5 · data layer (mock DB)
 */

const chartByCode = buildChartByCode(TEST_CHART);

function entryInfo(p: Partial<PaymentEntryInfo> = {}): PaymentEntryInfo {
  return {
    entryType: p.entryType ?? "sale",
    paymentMethod: "paymentMethod" in p ? p.paymentMethod! : "credit",
    status: p.status ?? "confirmed",
    lines: p.lines ?? [{ amount: 1000, vatAmount: 70, whtAmount: 0 }],
    // เฟส 10 ส่วน AA (0.10) — undefined เมื่อไม่ส่ง (backward-compat กับเทสต์เดิมทั้งหมดก่อนเฟสนี้)
    currency: p.currency,
    fxRate: p.fxRate,
  };
}

// ---------------------------------------------------------------------
// isEligibleForNote — re-export ตรงจาก isCreditEligibleForPayment (0.3)
// ---------------------------------------------------------------------
describe("isEligibleForNote", () => {
  it("ขาย/ซื้อ + credit + confirmed → true", () => {
    expect(isEligibleForNote(entryInfo({ entryType: "sale" }))).toBe(true);
    expect(isEligibleForNote(entryInfo({ entryType: "purchase" }))).toBe(true);
  });
  it("ไม่ credit หรือยังไม่ confirmed → false", () => {
    expect(isEligibleForNote(entryInfo({ paymentMethod: "cash" }))).toBe(false);
    expect(isEligibleForNote(entryInfo({ status: "draft" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------
// noteLineTotal / noteNetTotal / noteSignedAdjustment (0.5)
// ---------------------------------------------------------------------
function mkNote(p: Partial<CreditDebitNote> = {}): CreditDebitNote {
  return {
    id: p.id ?? "n1",
    tenantId: "t1",
    entryId: p.entryId ?? "e1",
    customerId: "c1",
    docType: p.docType ?? "credit_note",
    docDate: p.docDate ?? "2026-08-01",
    docNo: p.docNo ?? null,
    reason: p.reason ?? "สินค้าชำรุด",
    status: p.status ?? "confirmed",
    createdAt: "2026-08-01T00:00:00Z",
    confirmedAt: null,
    lines: p.lines ?? [{ lineNo: 1, description: null, accountCode: "4010", accountName: "ขายสินค้า", amount: 1000, vatAmount: 70 }],
  };
}

describe("noteLineTotal / noteNetTotal", () => {
  it("= amount + vatAmount รวมทุกบรรทัด", () => {
    expect(noteLineTotal([{ amount: 1000, vatAmount: 70 }])).toBe(1070);
    expect(noteLineTotal([{ amount: 1000, vatAmount: 70 }, { amount: 500, vatAmount: 0 }])).toBe(1570);
  });
  it("noteNetTotal ใช้ note.lines", () => {
    expect(noteNetTotal(mkNote())).toBe(1070);
  });
});

describe("noteSignedAdjustment", () => {
  it("credit_note confirmed → ลบ (ลดยอดค้าง)", () => {
    expect(noteSignedAdjustment(mkNote({ docType: "credit_note", status: "confirmed" }))).toBe(-1070);
  });
  it("debit_note confirmed → บวก (เพิ่มยอดค้าง)", () => {
    expect(noteSignedAdjustment(mkNote({ docType: "debit_note", status: "confirmed" }))).toBe(1070);
  });
  it("draft (ยังไม่ยืนยัน) → 0 เสมอ ไม่ว่าประเภทไหน", () => {
    expect(noteSignedAdjustment(mkNote({ docType: "credit_note", status: "draft" }))).toBe(0);
    expect(noteSignedAdjustment(mkNote({ docType: "debit_note", status: "draft" }))).toBe(0);
  });
});

// ---------------------------------------------------------------------
// validateNoteInput (0.3/0.4)
// ---------------------------------------------------------------------
describe("validateNoteInput", () => {
  const validInput: NoteInput = {
    docType: "credit_note",
    docDate: "2026-08-01",
    docNo: "CN-001",
    reason: "สินค้าชำรุด",
    lines: [{ accountCode: "4010", amount: 1000, vatAmount: 70 }],
  };

  it("input ถูกต้อง → ok:true", () => {
    const r = validateNoteInput(validInput, entryInfo());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.docType).toBe("credit_note");
      expect(r.value.lines).toHaveLength(1);
    }
  });

  it("★ entry ไม่ eligible (ไม่ใช่บิลเชื่อ/ยังไม่ confirmed) → ปฏิเสธเสมอ (0.3)", () => {
    expect(validateNoteInput(validInput, entryInfo({ paymentMethod: "cash" })).ok).toBe(false);
    expect(validateNoteInput(validInput, entryInfo({ status: "draft" })).ok).toBe(false);
    expect(validateNoteInput(validInput, entryInfo({ entryType: "unspecified" })).ok).toBe(false);
  });

  it("doc_type ผิดรูป → ปฏิเสธ", () => {
    expect(validateNoteInput({ ...validInput, docType: "invalid" }, entryInfo()).ok).toBe(false);
  });

  it("doc_date ผิดรูป → ปฏิเสธ", () => {
    expect(validateNoteInput({ ...validInput, docDate: "1/8/2026" }, entryInfo()).ok).toBe(false);
  });

  it("★ reason ว่าง → ปฏิเสธเสมอ (ฟอร์ม RD บังคับระบุเหตุผล)", () => {
    expect(validateNoteInput({ ...validInput, reason: "" }, entryInfo()).ok).toBe(false);
    expect(validateNoteInput({ ...validInput, reason: "   " }, entryInfo()).ok).toBe(false);
  });

  it("lines ว่าง → ปฏิเสธ", () => {
    expect(validateNoteInput({ ...validInput, lines: [] }, entryInfo()).ok).toBe(false);
  });

  it("บรรทัดไม่มี account_code → ปฏิเสธ", () => {
    const r = validateNoteInput({ ...validInput, lines: [{ accountCode: "", amount: 100 }] }, entryInfo());
    expect(r.ok).toBe(false);
  });

  it("บรรทัด amount ≤ 0 → ปฏิเสธ", () => {
    expect(validateNoteInput({ ...validInput, lines: [{ accountCode: "4010", amount: 0 }] }, entryInfo()).ok).toBe(false);
    expect(validateNoteInput({ ...validInput, lines: [{ accountCode: "4010", amount: -100 }] }, entryInfo()).ok).toBe(false);
  });

  it("docNo ว่าง → null (free text, ไม่บังคับ)", () => {
    const r = validateNoteInput({ ...validInput, docNo: "" }, entryInfo());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.docNo).toBeNull();
  });
});

// ---------------------------------------------------------------------
// validateNoteInput — บิลต้นทาง FX (เฟส 10 ส่วน AA, 0.10) — amount derive จาก fxAmount × entry.fxRate
// ---------------------------------------------------------------------
describe("validateNoteInput — บิลต้นทาง FX (0.10)", () => {
  const fxEntry = () => entryInfo({ currency: "USD", fxRate: 35.0 });

  it("★ amount derive จาก fxAmount × entry.fxRate (ของบิลต้นฉบับ) เสมอ — ไม่สนวันที่ของ CN/DN เลย (เทสต์บังคับ)", () => {
    const input: NoteInput = {
      docType: "credit_note",
      docDate: "2099-01-01", // ★ ตั้งใจให้ต่างจากวันบิลต้นทางมาก ๆ — ต้องไม่ถูกใช้คำนวณ amount
      docNo: "CN-001",
      reason: "สินค้าชำรุด",
      lines: [{ accountCode: "4010", amount: undefined, fxAmount: 50 }],
    };
    const r = validateNoteInput(input, fxEntry());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lines[0].amount).toBe(1750); // 50 × 35.0
      expect(r.value.lines[0].fxAmount).toBe(50);
    }
  });

  it("บิลต้นทาง FX + fxAmount ≤ 0 หรือไม่ระบุ → ปฏิเสธ", () => {
    const input: NoteInput = {
      docType: "credit_note",
      docDate: "2026-08-01",
      reason: "x",
      lines: [{ accountCode: "4010", amount: undefined }],
    };
    expect(validateNoteInput(input, fxEntry()).ok).toBe(false);
    expect(
      validateNoteInput({ ...input, lines: [{ accountCode: "4010", amount: undefined, fxAmount: -10 }] }, fxEntry()).ok
    ).toBe(false);
  });

  it("บิลต้นทาง THB ปกติ (currency=undefined) → ยัง derive จาก amount ตรง ๆ เหมือนเดิมทุกประการ (regression บังคับ)", () => {
    const input: NoteInput = {
      docType: "credit_note",
      docDate: "2026-08-01",
      reason: "x",
      lines: [{ accountCode: "4010", amount: 1000, fxAmount: 999 }], // fxAmount ต้องถูกเมิน (ไม่ใช่บิล FX)
    };
    const r = validateNoteInput(input, entryInfo());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lines[0].amount).toBe(1000);
      expect(r.value.lines[0].fxAmount).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------
// toJournalLines / toJournalPosting — ครบ 4 กรณีตามตาราง 0.5
// ---------------------------------------------------------------------
function mkNoteJournalEntry(p: Partial<NoteJournalEntry> = {}): NoteJournalEntry {
  return {
    entryType: p.entryType ?? "sale",
    docNo: p.docNo ?? "INV-001",
    customerId: p.customerId ?? "c1",
    counterpartyName: p.counterpartyName ?? "บริษัท ลูกค้า จำกัด",
  };
}

function sumSide(lines: ReturnType<typeof toJournalLines>, side: "debit" | "credit"): number {
  return lines.reduce((s, l) => s + (side === "debit" ? l.debit : l.credit), 0);
}

describe("toJournalLines — ตาราง 0.5 ครบ 4 กรณี", () => {
  it("credit_note × sale: Dr 4010=1000, Dr OUTPUT_VAT(2900)=70 · Cr AR(1140)=1070 — สมดุล", () => {
    const note = mkNote({ docType: "credit_note" });
    const lines = toJournalLines(note, mkNoteJournalEntry({ entryType: "sale" }), chartByCode);
    expect(sumSide(lines, "debit")).toBe(1070);
    expect(sumSide(lines, "credit")).toBe(1070);
    expect(lines.find((l) => l.accountCode === "4010")).toMatchObject({ debit: 1000, side: "debit" });
    expect(lines.find((l) => l.accountCode === "2900")).toMatchObject({ debit: 70, side: "debit" });
    expect(lines.find((l) => l.accountCode === "1140")).toMatchObject({ credit: 1070, side: "credit" });
  });

  it("debit_note × sale: Dr AR(1140)=1070 · Cr 4010=1000, Cr OUTPUT_VAT(2900)=70 — สมดุล", () => {
    const note = mkNote({ docType: "debit_note" });
    const lines = toJournalLines(note, mkNoteJournalEntry({ entryType: "sale" }), chartByCode);
    expect(sumSide(lines, "debit")).toBe(1070);
    expect(sumSide(lines, "credit")).toBe(1070);
    expect(lines.find((l) => l.accountCode === "1140")).toMatchObject({ debit: 1070, side: "debit" });
    expect(lines.find((l) => l.accountCode === "4010")).toMatchObject({ credit: 1000, side: "credit" });
    expect(lines.find((l) => l.accountCode === "2900")).toMatchObject({ credit: 70, side: "credit" });
  });

  it("credit_note × purchase: Dr AP(2010)=1070 · Cr 5010=1000, Cr INPUT_VAT(1154)=70 — สมดุล", () => {
    const note = mkNote({
      docType: "credit_note",
      lines: [{ lineNo: 1, description: null, accountCode: "5010", accountName: "ซื้อสินค้า", amount: 1000, vatAmount: 70 }],
    });
    const lines = toJournalLines(note, mkNoteJournalEntry({ entryType: "purchase" }), chartByCode);
    expect(sumSide(lines, "debit")).toBe(1070);
    expect(sumSide(lines, "credit")).toBe(1070);
    expect(lines.find((l) => l.accountCode === "2010")).toMatchObject({ debit: 1070, side: "debit" });
    expect(lines.find((l) => l.accountCode === "5010")).toMatchObject({ credit: 1000, side: "credit" });
    expect(lines.find((l) => l.accountCode === "1154")).toMatchObject({ credit: 70, side: "credit" });
  });

  it("debit_note × purchase: Dr 5010=1000, Dr INPUT_VAT(1154)=70 · Cr AP(2010)=1070 — สมดุล", () => {
    const note = mkNote({
      docType: "debit_note",
      lines: [{ lineNo: 1, description: null, accountCode: "5010", accountName: "ซื้อสินค้า", amount: 1000, vatAmount: 70 }],
    });
    const lines = toJournalLines(note, mkNoteJournalEntry({ entryType: "purchase" }), chartByCode);
    expect(sumSide(lines, "debit")).toBe(1070);
    expect(sumSide(lines, "credit")).toBe(1070);
    expect(lines.find((l) => l.accountCode === "5010")).toMatchObject({ debit: 1000, side: "debit" });
    expect(lines.find((l) => l.accountCode === "1154")).toMatchObject({ debit: 70, side: "debit" });
    expect(lines.find((l) => l.accountCode === "2010")).toMatchObject({ credit: 1070, side: "credit" });
  });

  it("entryType ไม่ใช่ sale/purchase → [] (defensive)", () => {
    const lines = toJournalLines(mkNote(), mkNoteJournalEntry({ entryType: "unspecified" as never }), chartByCode);
    expect(lines).toEqual([]);
  });

  it("ยอดรวมเป็น 0 → []", () => {
    const note = mkNote({ lines: [{ lineNo: 1, description: null, accountCode: "4010", accountName: null, amount: 0, vatAmount: 0 }] });
    const lines = toJournalLines(note, mkNoteJournalEntry(), chartByCode);
    expect(lines).toEqual([]);
  });
});

describe("toJournalPosting", () => {
  it("ฝั่งขาย → book='sale' (ไม่ใช่ receipt — CN/DN ไม่ใช่เงินเข้า-ออกจริง, 0.7)", () => {
    const p = toJournalPosting(mkNote(), mkNoteJournalEntry({ entryType: "sale" }), chartByCode);
    expect(p.book).toBe("sale");
    expect(p.totalDebit).toBe(p.totalCredit);
  });

  it("ฝั่งซื้อ → book='purchase'", () => {
    const note = mkNote({
      docType: "credit_note",
      lines: [{ lineNo: 1, description: null, accountCode: "5010", accountName: null, amount: 1000, vatAmount: 70 }],
    });
    const p = toJournalPosting(note, mkNoteJournalEntry({ entryType: "purchase" }), chartByCode);
    expect(p.book).toBe("purchase");
  });

  it("description มีเหตุผลของใบ", () => {
    const p = toJournalPosting(mkNote({ reason: "คืนสินค้าบางส่วน" }), mkNoteJournalEntry(), chartByCode);
    expect(p.description).toContain("คืนสินค้าบางส่วน");
  });
});

// ---------------------------------------------------------------------
// data layer (mock DB — pattern เดียวกับ bill-payments.test.ts)
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

function makeFakeDb(seed: {
  billEntries?: Record<string, Row>;
  billEntryLines?: Record<string, Row[]>;
}): { db: SupabaseClient; notes: Row[]; noteLines: Row[] } {
  const billEntries = seed.billEntries ?? {};
  const billEntryLines = seed.billEntryLines ?? {};
  const notes: Row[] = [];
  const noteLines: Row[] = [];
  let nextNoteId = 1;
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
      if (mode === "insert" && table === "credit_debit_notes") {
        const id = `n${nextNoteId++}`;
        const row: Row = { id, deleted_at: null, confirmed_at: null, ...(payload as Row) };
        notes.push(row);
        return Promise.resolve({ data: { id }, error: null });
      }
      if (table === "bill_entries") {
        const idFilter = filters.find((f) => f.col === "id");
        const row = idFilter ? billEntries[idFilter.val as string] : undefined;
        return Promise.resolve({ data: row ?? null, error: null });
      }
      // ★ updateDraftNote กำกับ .eq("status","draft") เข้าคำสั่งเขียนจริงเอง แล้วเช็คผลด้วย
      //   .select("id").maybeSingle() (TOCTOU guard) — ต้องประยุกต์ payload จริงตรงนี้ (ไม่ใช่แค่ที่ .then()
      //   เหมือนเดิม) แล้วคืน null ถ้าไม่มีแถวไหนตรง filters เลย (จำลอง 0 rows affected)
      if (mode === "update" && table === "credit_debit_notes") {
        const row = notes.find((r) => matchRow(r, filters));
        if (!row) return Promise.resolve({ data: null, error: null });
        Object.assign(row, payload as Row);
        return Promise.resolve({ data: { id: row.id }, error: null });
      }
      if (table === "credit_debit_notes") {
        const row = notes.find((r) => matchRow(r, filters));
        return Promise.resolve({ data: row ? { ...row } : null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = [];
      if (mode === "insert" && table === "credit_debit_note_lines") {
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const r of rows as Row[]) {
          const id = `nl${nextLineId++}`;
          noteLines.push({ id, ...r });
        }
        data = null;
      } else if (mode === "update" && table === "credit_debit_notes") {
        for (const row of notes) {
          if (matchRow(row, filters)) Object.assign(row, payload as Row);
        }
        data = null;
      } else if (mode === "delete" && table === "credit_debit_notes") {
        for (let i = notes.length - 1; i >= 0; i--) {
          if (matchRow(notes[i], filters)) notes.splice(i, 1);
        }
        data = null;
      } else if (mode === "delete" && table === "credit_debit_note_lines") {
        for (let i = noteLines.length - 1; i >= 0; i--) {
          if (matchRow(noteLines[i], filters)) noteLines.splice(i, 1);
        }
        data = null;
      } else if (table === "bill_entry_lines") {
        const entryFilter = filters.find((f) => f.col === "entry_id");
        data = entryFilter ? billEntryLines[entryFilter.val as string] ?? [] : [];
      } else if (table === "credit_debit_notes") {
        data = notes.filter((r) => matchRow(r, filters));
      } else if (table === "credit_debit_note_lines") {
        data = noteLines.filter((r) => matchRow(r, filters));
      }
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }
  return { db: { from: (t: string) => qb(t) } as unknown as SupabaseClient, notes, noteLines };
}

function seedSaleEntry() {
  return {
    billEntries: {
      e1: { customer_id: "c1", entry_type: "sale", payment_method: "credit", status: "confirmed" },
    },
    billEntryLines: {
      e1: [{ amount: 1000, vat_amount: 70, wht_amount: 0 }],
    },
  };
}

const validNoteInput: NoteInput = {
  docType: "credit_note",
  docDate: "2026-08-01",
  docNo: "CN-001",
  reason: "สินค้าชำรุด",
  lines: [{ accountCode: "4010", amount: 500, vatAmount: 35 }],
};

describe("getNoteEntryScope", () => {
  it("re-export ตรงจาก getBillPaymentScope — โหลดสโคปได้ถูกต้อง", async () => {
    const { db } = makeFakeDb(seedSaleEntry());
    const scope = await getNoteEntryScope(db, "t1", "e1");
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
});

describe("createDraftNote", () => {
  it("ไม่พบบิล → ปฏิเสธ", async () => {
    const { db, notes } = makeFakeDb({});
    const res = await createDraftNote(db, "t1", "missing", validNoteInput);
    expect(res.ok).toBe(false);
    expect(notes).toHaveLength(0);
  });

  it("บิลไม่ eligible (ไม่ใช่ credit) → ปฏิเสธ ไม่ insert", async () => {
    const { db, notes } = makeFakeDb({
      billEntries: { e1: { customer_id: "c1", entry_type: "sale", payment_method: "cash", status: "confirmed" } },
      billEntryLines: { e1: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }] },
    });
    const res = await createDraftNote(db, "t1", "e1", validNoteInput);
    expect(res.ok).toBe(false);
    expect(notes).toHaveLength(0);
  });

  it("input ถูกต้อง → สร้าง draft สำเร็จ พร้อมบรรทัด", async () => {
    const { db, notes, noteLines } = makeFakeDb(seedSaleEntry());
    const res = await createDraftNote(db, "t1", "e1", validNoteInput);
    expect(res.ok).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0].status).toBe("draft");
    expect(notes[0].customer_id).toBe("c1"); // สำเนาจาก scope
    expect(noteLines).toHaveLength(1);
  });

  it("reason ว่าง → ปฏิเสธ ไม่ insert", async () => {
    const { db, notes } = makeFakeDb(seedSaleEntry());
    const res = await createDraftNote(db, "t1", "e1", { ...validNoteInput, reason: "" });
    expect(res.ok).toBe(false);
    expect(notes).toHaveLength(0);
  });
});

describe("updateDraftNote / confirmNote / softDeleteNote", () => {
  it("draft แก้ไขได้ — บรรทัดถูกแทนที่ทั้งชุด", async () => {
    const { db, noteLines } = makeFakeDb(seedSaleEntry());
    const created = await createDraftNote(db, "t1", "e1", validNoteInput);
    expect(created.ok).toBe(true);
    const id = created.ok ? created.id : "";

    const updated = await updateDraftNote(db, "t1", id, {
      ...validNoteInput,
      reason: "แก้ไขเหตุผลใหม่",
      lines: [{ accountCode: "4010", amount: 200, vatAmount: 14 }],
    });
    expect(updated.ok).toBe(true);
    const linesOfNote = noteLines.filter((l) => l.note_id === id);
    expect(linesOfNote).toHaveLength(1);
    expect(linesOfNote[0].amount).toBe(200);
  });

  it("★ confirmed แล้วแก้ไขไม่ได้ (0.4) — ปฏิเสธ", async () => {
    const { db } = makeFakeDb(seedSaleEntry());
    const created = await createDraftNote(db, "t1", "e1", validNoteInput);
    const id = created.ok ? created.id : "";
    const confirmed = await confirmNote(db, "t1", id);
    expect(confirmed.ok).toBe(true);

    const updated = await updateDraftNote(db, "t1", id, validNoteInput);
    expect(updated.ok).toBe(false);
  });

  it("confirmNote แล้ว → เข้า netAdjustmentByEntry ถูกต้อง · softDeleteNote แล้ว → หลุดออกจากผลรวม", async () => {
    const { db } = makeFakeDb(seedSaleEntry());
    const created = await createDraftNote(db, "t1", "e1", validNoteInput); // 500+35=535 credit_note
    const id = created.ok ? created.id : "";

    // ก่อนยืนยัน (draft) → ไม่กระทบยอด
    let notesByEntry = await listNotesForEntries(db, "t1", ["e1"]);
    expect(netAdjustmentByEntry(notesByEntry).get("e1")).toBe(0);

    await confirmNote(db, "t1", id);
    notesByEntry = await listNotesForEntries(db, "t1", ["e1"]);
    expect(netAdjustmentByEntry(notesByEntry).get("e1")).toBe(-535);

    const voided = await softDeleteNote(db, "t1", id);
    expect(voided.ok).toBe(true);
    const afterVoid = await listNotes(db, "t1", "e1");
    expect(afterVoid).toHaveLength(0);
  });

  it("ยืนยันรายการที่ไม่มีบรรทัด → ปฏิเสธ", async () => {
    const { db } = makeFakeDb(seedSaleEntry());
    const created = await createDraftNote(db, "t1", "e1", validNoteInput);
    const id = created.ok ? created.id : "";
    await db.from("credit_debit_note_lines").delete().eq("note_id", id).eq("tenant_id", "t1");
    const res = await confirmNote(db, "t1", id);
    expect(res.ok).toBe(false);
  });

  it("ไม่พบรายการ → ปฏิเสธทุกฟังก์ชัน", async () => {
    const { db } = makeFakeDb(seedSaleEntry());
    expect((await updateDraftNote(db, "t1", "missing", validNoteInput)).ok).toBe(false);
    expect((await confirmNote(db, "t1", "missing")).ok).toBe(false);
    expect((await softDeleteNote(db, "t1", "missing")).ok).toBe(false);
  });
});

describe("listNotes / listNotesForEntries / netAdjustmentByEntry", () => {
  it("ผสม credit_note + debit_note หลายใบ → หักลบกันถูกต้อง", async () => {
    const { db } = makeFakeDb(seedSaleEntry());
    const cn = await createDraftNote(db, "t1", "e1", { ...validNoteInput, docType: "credit_note", lines: [{ accountCode: "4010", amount: 500, vatAmount: 0 }] });
    const dn = await createDraftNote(db, "t1", "e1", { ...validNoteInput, docType: "debit_note", lines: [{ accountCode: "4010", amount: 200, vatAmount: 0 }] });
    expect(cn.ok && dn.ok).toBe(true);
    if (cn.ok) await confirmNote(db, "t1", cn.id);
    if (dn.ok) await confirmNote(db, "t1", dn.id);

    const notesByEntry = await listNotesForEntries(db, "t1", ["e1"]);
    expect(notesByEntry.get("e1")).toHaveLength(2);
    // -500 (credit_note) + 200 (debit_note) = -300
    expect(netAdjustmentByEntry(notesByEntry).get("e1")).toBe(-300);
  });

  it("entryIds ว่าง → Map ว่าง (ไม่ query)", async () => {
    const { db } = makeFakeDb({});
    const map = await listNotesForEntries(db, "t1", []);
    expect(map.size).toBe(0);
  });

  it(
    "entryIds เกิน chunk limit (300 ตัว) → ตัดเป็นก้อนแล้วรวมผลครบ ไม่ตกหล่น (regression ของบั๊ก .in() " +
      "ยาวเกิน limit ของ PostgREST — ดู commit 7ab9f91, เจอครั้งแรกใน listEntries())",
    async () => {
      const entryIds = Array.from({ length: 300 }, (_, i) => `e${i}`);
      // mock ที่จำลอง PostgREST ปฏิเสธถ้า .in() ยาวเกิน 150 ตัว — ทั้ง query หัว (credit_debit_notes,
      // .in("entry_id")) และ query บรรทัด (credit_debit_note_lines, .in("note_id")) ต้องตัดก้อนเอง
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function qb(table: string): any {
        let inCol: string | null = null;
        let inIds: string[] | null = null;
        const api: any = {};
        api.select = () => api;
        api.eq = () => api;
        api.is = () => api;
        api.order = () => api;
        api.limit = () => api;
        api.in = (c: string, v: string[]) => {
          inCol = c;
          inIds = v;
          return api;
        };
        api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
          if (!inIds || inIds.length > 150) {
            return Promise.resolve({ data: null, error: { message: "Bad Request" } }).then(onF);
          }
          let rows: unknown[] = [];
          if (table === "credit_debit_notes" && inCol === "entry_id") {
            rows = inIds.map((id) => ({
              id: `n-${id}`,
              tenant_id: "t1",
              entry_id: id,
              doc_type: "credit_note",
              doc_no: null,
              doc_date: "2026-08-01",
              status: "confirmed",
              reason: null,
              created_at: "2026-08-01T00:00:00Z",
              confirmed_at: "2026-08-01T00:00:00Z",
            }));
          } else if (table === "credit_debit_note_lines" && inCol === "note_id") {
            rows = inIds.map((id) => ({
              id: `l-${id}`,
              note_id: id,
              line_no: 1,
              description: null,
              account_code: "4010",
              account_name: null,
              amount: 100,
              vat_amount: 0,
            }));
          }
          return Promise.resolve({ data: rows, error: null }).then(onF);
        };
        return api;
      }
      const db = { from: (t: string) => qb(t) } as unknown as SupabaseClient;
      const map = await listNotesForEntries(db, "t1", entryIds);
      expect(map.size).toBe(300);
      for (const id of entryIds) {
        expect(map.get(id)).toHaveLength(1);
        expect(map.get(id)![0]!.lines).toHaveLength(1);
      }
    }
  );
});
