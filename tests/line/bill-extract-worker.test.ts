import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * bill-extract-worker — สร้าง draft จากบิลที่เก็บแล้ว
 *   ตรวจ: dedup (มี entry แล้วข้าม), PDF → draft ว่าง, รูป → สกัด+เติม line, จับคู่ลูกค้า
 *   mock extractBillData เพื่อไม่ยิง API
 */

// mock ตัวสกัด AI (ตั้งค่าผลต่อเทสต์)
//   extractMock       = extractBillData (รูปบิลไลน์)
//   extractBillsMock  = extractBillsData (PDF/ไฟล์เอกสาร) — default คืน [] (อ่านไม่ได้ → draft ว่าง)
const extractMock = vi.fn();
const extractBillsMock = vi.fn((..._args: unknown[]) => [] as unknown[]);
vi.mock("@/lib/ai/bill-extract", () => ({
  extractBillData: (...a: unknown[]) => extractMock(...a),
  extractBillsData: (...a: unknown[]) => extractBillsMock(...a),
}));

import {
  processBillExtraction,
  selectExtractionCandidates,
  decideEntrySide,
  redecideExistingEntries,
  backfillEntryAccounts,
  reExtractIncompleteEntries,
  collectTargetEntries,
  isEmptyReextractable,
  resolveLineWht,
  buildEntryLineRows,
  round2,
  normalizeName,
  nameSimilarity,
  digitsOnly,
} from "@/lib/line/bill-extract-worker";
import { TEST_CHART } from "@/tests/accounting/fixtures/chart";

/** แถว chart_of_accounts จำลอง (schema DB จริง: code/name/category/is_bank) — mock listChartOfAccounts */
const CHART_ROWS = TEST_CHART.map((a) => ({
  code: a.code,
  name: a.name,
  category: a.category,
  is_bank: !!a.bank,
}));

/** เก็บ insert เพื่อ assert */
type Captured = { table: string; rows: Record<string, unknown>[] };

/** สร้าง mock DB ที่คืน canned data ต่อ (table+context) + เก็บ insert */
function makeWorkerDb(opts: {
  attachments: Record<string, unknown>[];
  existingEntries?: { attachment_id: string }[];
  chatGroupCustomer?: string | null;
  customerName?: string | null;
  customerTaxId?: string | null;
  downloadOk?: boolean;
}): { db: SupabaseClient; inserts: Captured[] } {
  const inserts: Captured[] = [];
  let entrySeq = 0;

  function qb(table: string) {
    const state: { selectCols: string; mode: "select" | "insert"; rows: Record<string, unknown>[] } = {
      selectCols: "",
      mode: "select",
      rows: [],
    };
    const api: Record<string, unknown> = {};
    const chain = () => api;
    api.select = (cols: string) => {
      state.selectCols = cols;
      return api;
    };
    api.eq = chain;
    api.in = chain;
    api.is = chain;
    api.not = chain;
    api.order = chain;
    api.limit = chain;
    api.insert = (rows: Record<string, unknown> | Record<string, unknown>[]) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      state.mode = "insert";
      state.rows = arr;
      inserts.push({ table, rows: arr });
      return api;
    };
    api.maybeSingle = () => Promise.resolve(resolveSingle());
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve(resolveList()).then(onF);

    function resolveSingle(): { data: unknown; error: unknown } {
      if (state.mode === "insert" && table === "bill_entries") {
        return { data: { id: `entry-${++entrySeq}` }, error: null };
      }
      if (table === "chat_messages") return { data: { chat_group_id: "g1" }, error: null };
      if (table === "chat_groups") return { data: { customer_id: opts.chatGroupCustomer ?? null }, error: null };
      if (table === "customers")
        return {
          data: { name: opts.customerName ?? null, business_name: null, tax_id: opts.customerTaxId ?? null },
          error: null,
        };
      return { data: null, error: null };
    }
    function resolveList(): { data: unknown; error: unknown } {
      if (table === "message_attachments") return { data: opts.attachments, error: null };
      if (table === "bill_entries") return { data: opts.existingEntries ?? [], error: null };
      // ★ chart_of_accounts — mock listChartOfAccounts (A6: worker โหลดผังต่อ tenant มาเติม account_name)
      if (table === "chart_of_accounts") return { data: CHART_ROWS, error: null };
      return { data: [], error: null };
    }
    return api;
  }

  const db = {
    from: (table: string) => qb(table),
    storage: {
      from: () => ({
        download: async () =>
          opts.downloadOk === false
            ? { data: null, error: { message: "nope" } }
            : { data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, error: null },
      }),
    },
  };
  return { db: db as unknown as SupabaseClient, inserts };
}

beforeEach(() => {
  extractMock.mockReset();
  extractBillsMock.mockReset();
  extractBillsMock.mockReturnValue([]); // default: PDF อ่านไม่ได้ → draft ว่าง
});

describe("selectExtractionCandidates — subtract-done กันคิวค้าง", () => {
  const att = (id: string) => ({
    id,
    tenant_id: "t1",
    attachment_type: "image",
    doc_kind: "purchase",
    drive_file_id: `t1/${id}.jpg`,
    chat_message_id: null,
  });

  it("ตัดใบที่มี entry แล้วออก → คืนเฉพาะใบที่ยังไม่ทำ", async () => {
    const { db } = makeWorkerDb({
      attachments: [att("a1"), att("a2"), att("a3"), att("a4")],
      existingEntries: [{ attachment_id: "a1" }, { attachment_id: "a2" }],
    });
    const rows = await selectExtractionCandidates(db, 10);
    expect(rows.map((r) => r.id)).toEqual(["a3", "a4"]);
  });

  it("★ done เต็มชุดแรก แต่ยังมีใบใหม่ท้าย ๆ → ต้องโผล่ (ไม่ค้าง 0)", async () => {
    // จำลองบั๊กเดิม: a1..a3 ทำแล้ว (เคยเป็น 50 ใบแรก) แต่ a4,a5 ยังไม่ทำ
    const { db } = makeWorkerDb({
      attachments: [att("a1"), att("a2"), att("a3"), att("a4"), att("a5")],
      existingEntries: [{ attachment_id: "a1" }, { attachment_id: "a2" }, { attachment_id: "a3" }],
    });
    const rows = await selectExtractionCandidates(db, 10);
    expect(rows.map((r) => r.id)).toEqual(["a4", "a5"]);
  });

  it("slice ตาม limit (เอาเก่าสุดก่อน)", async () => {
    const { db } = makeWorkerDb({
      attachments: [att("a1"), att("a2"), att("a3"), att("a4")],
      existingEntries: [],
    });
    const rows = await selectExtractionCandidates(db, 2);
    expect(rows.map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  it("ทุกใบ done → คืน [] (ไม่มีอะไรให้ทำ)", async () => {
    const { db } = makeWorkerDb({
      attachments: [att("a1"), att("a2")],
      existingEntries: [{ attachment_id: "a1" }, { attachment_id: "a2" }],
    });
    expect(await selectExtractionCandidates(db, 10)).toEqual([]);
  });
});

describe("processBillExtraction", () => {
  it("รูปที่สกัดได้ + ลูกค้าเรา=ผู้ซื้อ → entry_type=purchase, counterparty=ผู้ขาย", async () => {
    extractMock.mockResolvedValue({
      doc_date: "2026-07-15",
      doc_no: "INV-1",
      seller_name: "ร้านวัสดุ เอบีซี",
      seller_tax_id: "0105500000009",
      buyer_name: "บริษัท ลูกค้าเรา จำกัด",
      buyer_tax_id: null,
      lines: [{ vat_type: "vat", description: "ของ", amount: 100, vat_amount: 7 }],
      overall_confidence: 0.9,
    });
    const { db, inserts } = makeWorkerDb({
      attachments: [
        {
          id: "att-1",
          tenant_id: "t1",
          attachment_type: "image",
          doc_kind: "purchase",
          drive_file_id: "t1/bill.jpg",
          chat_message_id: "m1",
        },
      ],
      chatGroupCustomer: "cust-1",
      customerName: "ลูกค้าเรา",
    });

    const res = await processBillExtraction(db, { limit: 10 });
    expect(res.created).toBe(1);
    expect(res.extracted).toBe(1);

    const entryIns = inserts.find((i) => i.table === "bill_entries")!;
    expect(entryIns.rows[0].attachment_id).toBe("att-1");
    expect(entryIns.rows[0].customer_id).toBe("cust-1");
    expect(entryIns.rows[0].entry_type).toBe("purchase");
    expect(entryIns.rows[0].counterparty_name).toBe("ร้านวัสดุ เอบีซี");
    // เก็บ seller/buyer ที่ AI อ่านทั้งคู่
    expect(entryIns.rows[0].seller_name).toBe("ร้านวัสดุ เอบีซี");
    expect(entryIns.rows[0].buyer_name).toBe("บริษัท ลูกค้าเรา จำกัด");

    const lineIns = inserts.find((i) => i.table === "bill_entry_lines")!;
    expect(lineIns.rows[0].amount).toBe(100);
    expect(lineIns.rows[0].ai_filled).toBe(true);
  });

  it("★ AI แนะนำบัญชี → เขียน account_code + account_name (จากผัง) + ai_filled", async () => {
    extractMock.mockResolvedValue({
      doc_date: "2026-07-15",
      doc_no: "F-1",
      seller_name: "ปั๊มน้ำมัน",
      seller_tax_id: null,
      buyer_name: "ลูกค้าเรา",
      buyer_tax_id: null,
      lines: [{ vat_type: "vat", description: "น้ำมัน", amount: 500, vat_amount: 35, account_code: "5340" }],
      overall_confidence: 0.9,
    });
    const { db, inserts } = makeWorkerDb({
      attachments: [
        { id: "att-f", tenant_id: "t1", attachment_type: "image", doc_kind: "purchase", drive_file_id: "t1/f.jpg", chat_message_id: null },
      ],
    });
    await processBillExtraction(db, { limit: 10 });
    const lineIns = inserts.find((i) => i.table === "bill_entry_lines")!;
    expect(lineIns.rows[0].account_code).toBe("5340");
    // ชื่อบัญชีมาจากผังกลางเสมอ (ไม่เชื่อชื่อจากโมเดล)
    expect(lineIns.rows[0].account_name).toBe("ค่าน้ำมัน");
    expect(lineIns.rows[0].ai_filled).toBe(true);
  });

  it("AI ไม่แนะนำบัญชี (account_code null) → account_code/account_name = null", async () => {
    extractMock.mockResolvedValue({
      doc_date: null,
      doc_no: "N-1",
      seller_name: "ร้าน",
      seller_tax_id: null,
      buyer_name: null,
      buyer_tax_id: null,
      lines: [{ vat_type: "vat", description: null, amount: 80, vat_amount: 0, account_code: null }],
      overall_confidence: 0.85,
    });
    const { db, inserts } = makeWorkerDb({
      attachments: [
        { id: "att-n", tenant_id: "t1", attachment_type: "image", doc_kind: "purchase", drive_file_id: "t1/n.jpg", chat_message_id: null },
      ],
    });
    await processBillExtraction(db, { limit: 10 });
    const lineIns = inserts.find((i) => i.table === "bill_entry_lines")!;
    expect(lineIns.rows[0].account_code).toBeNull();
    expect(lineIns.rows[0].account_name).toBeNull();
    // ai_filled ยัง true เพราะ AI เติม amount
    expect(lineIns.rows[0].ai_filled).toBe(true);
  });

  it("ลูกค้าเรา=ผู้ขาย → entry_type=sale, counterparty=ผู้ซื้อ", async () => {
    extractMock.mockResolvedValue({
      doc_date: null,
      doc_no: "S-1",
      seller_name: "บริษัท ลูกค้าเรา จำกัด",
      seller_tax_id: null,
      buyer_name: "ลูกค้าปลายทาง",
      buyer_tax_id: "0994000000001",
      lines: [{ vat_type: "vat", description: null, amount: 500, vat_amount: 35 }],
      overall_confidence: 0.8,
    });
    const { db, inserts } = makeWorkerDb({
      attachments: [
        { id: "att-9", tenant_id: "t1", attachment_type: "image", doc_kind: "sale", drive_file_id: "t1/s.jpg", chat_message_id: "m1" },
      ],
      chatGroupCustomer: "cust-1",
      customerName: "ลูกค้าเรา",
    });
    await processBillExtraction(db, { limit: 10 });
    const entryIns = inserts.find((i) => i.table === "bill_entries")!;
    expect(entryIns.rows[0].entry_type).toBe("sale");
    expect(entryIns.rows[0].counterparty_name).toBe("ลูกค้าปลายทาง");
    expect(entryIns.rows[0].counterparty_tax_id).toBe("0994000000001");
  });

  it("ไม่มีข้อมูลลูกค้า → entry_type=unspecified (ไม่เดา) แต่เก็บ seller/buyer", async () => {
    extractMock.mockResolvedValue({
      doc_date: null,
      doc_no: "X-1",
      seller_name: "ร้าน ก",
      seller_tax_id: null,
      buyer_name: "ร้าน ข",
      buyer_tax_id: null,
      lines: [{ vat_type: "vat", description: null, amount: 10, vat_amount: 0 }],
      overall_confidence: 0.7,
    });
    const { db, inserts } = makeWorkerDb({
      attachments: [
        { id: "att-u", tenant_id: "t1", attachment_type: "image", doc_kind: "purchase", drive_file_id: "t1/u.jpg", chat_message_id: null },
      ],
    });
    await processBillExtraction(db, { limit: 10 });
    const entryIns = inserts.find((i) => i.table === "bill_entries")!;
    expect(entryIns.rows[0].entry_type).toBe("unspecified");
    expect(entryIns.rows[0].counterparty_name).toBeNull();
    expect(entryIns.rows[0].seller_name).toBe("ร้าน ก");
    expect(entryIns.rows[0].buyer_name).toBe("ร้าน ข");
  });

  it("dedup — attachment ที่มี entry แล้ว → ข้าม ไม่สร้างซ้ำ", async () => {
    const { db, inserts } = makeWorkerDb({
      attachments: [
        { id: "att-1", tenant_id: "t1", attachment_type: "image", doc_kind: "sale", drive_file_id: "t1/a.jpg", chat_message_id: null },
      ],
      existingEntries: [{ attachment_id: "att-1" }],
    });
    const res = await processBillExtraction(db, { limit: 10 });
    expect(res.scanned).toBe(0);
    expect(res.created).toBe(0);
    expect(inserts.length).toBe(0);
    expect(extractMock).not.toHaveBeenCalled();
  });

  it("PDF (attachment_type=file) → ใช้ extractBillsData (ไม่ใช่ extractBillData); อ่านไม่ได้ → draft ว่าง", async () => {
    const { db, inserts } = makeWorkerDb({
      attachments: [
        { id: "att-pdf", tenant_id: "t1", attachment_type: "file", doc_kind: "file", drive_file_id: "t1/doc.pdf", chat_message_id: null },
      ],
    });
    const res = await processBillExtraction(db, { limit: 10 });
    expect(res.created).toBe(1);
    expect(res.blank).toBe(1);
    // ★ PDF ใช้ extractBillsData (gpt-5-mini อ่าน PDF) — ไม่เรียก extractBillData (บิลรูป)
    expect(extractBillsMock).toHaveBeenCalledTimes(1);
    expect(extractMock).not.toHaveBeenCalled();

    const entryIns = inserts.find((i) => i.table === "bill_entries")!;
    expect(entryIns.rows[0].entry_type).toBe("unspecified");

    const lineIns = inserts.find((i) => i.table === "bill_entry_lines")!;
    expect(lineIns.rows[0].amount).toBe(0);
    expect(lineIns.rows[0].ai_filled).toBe(false);
  });

  it("ไฟล์เอกสาร (attachment_type=file, .xlsx) อ่านไม่ได้ → draft ว่างพร้อมไฟล์แนบ ไม่เรียก AI", async () => {
    const { db, inserts } = makeWorkerDb({
      attachments: [
        { id: "att-xlsx", tenant_id: "t1", attachment_type: "file", doc_kind: "file", drive_file_id: "t1/report.xlsx", chat_message_id: null },
      ],
    });
    const res = await processBillExtraction(db, { limit: 10 });
    expect(res.created).toBe(1);
    expect(res.blank).toBe(1);
    // Excel/doc อ่านไม่ได้ → ไม่เรียก AI ทั้งสองตัว
    expect(extractBillsMock).not.toHaveBeenCalled();
    expect(extractMock).not.toHaveBeenCalled();
    const entryIns = inserts.find((i) => i.table === "bill_entries")!;
    expect(entryIns.rows[0].entry_type).toBe("unspecified");
  });

  it("PDF ที่ AI อ่านได้ → เติมหัว/บรรทัดจากบิลแรกของ extractBillsData", async () => {
    extractBillsMock.mockReturnValue([
      {
        doc_date: "2026-06-01",
        doc_no: "INV-PDF-1",
        seller_name: "ร้านค้า A",
        seller_tax_id: null,
        buyer_name: null,
        buyer_tax_id: null,
        lines: [
          { vat_type: "vat", description: "ค่าบริการ", amount: 1000, vat_amount: 70, account_code: null, wht_rate: null, wht_amount: null, low_confidence: false },
        ],
        overall_confidence: 0.9,
      },
    ]);
    const { db, inserts } = makeWorkerDb({
      attachments: [
        { id: "att-pdf2", tenant_id: "t1", attachment_type: "file", doc_kind: "file", drive_file_id: "t1/bill.pdf", chat_message_id: null },
      ],
    });
    const res = await processBillExtraction(db, { limit: 10 });
    expect(res.created).toBe(1);
    expect(res.extracted).toBe(1);
    expect(extractBillsMock).toHaveBeenCalledTimes(1);
    const entryIns = inserts.find((i) => i.table === "bill_entries")!;
    expect(entryIns.rows[0].doc_no).toBe("INV-PDF-1");
    const lineIns = inserts.find((i) => i.table === "bill_entry_lines")!;
    expect(lineIns.rows[0].amount).toBe(1000);
  });

  it("AI คืน null (ไม่มี key/สกัดไม่ได้) → draft ว่าง unspecified", async () => {
    extractMock.mockResolvedValue(null);
    const { db, inserts } = makeWorkerDb({
      attachments: [
        { id: "att-2", tenant_id: "t1", attachment_type: "image", doc_kind: "sale", drive_file_id: "t1/s.jpg", chat_message_id: null },
      ],
    });
    await processBillExtraction(db, { limit: 10 });
    const entryIns = inserts.find((i) => i.table === "bill_entries")!;
    expect(entryIns.rows[0].entry_type).toBe("unspecified");
    expect(entryIns.rows[0].doc_date).toBeNull();
  });

  it("ดาวน์โหลดไฟล์ไม่ได้ → ข้าม ไม่สร้าง entry", async () => {
    const { db, inserts } = makeWorkerDb({
      attachments: [
        { id: "att-3", tenant_id: "t1", attachment_type: "image", doc_kind: "cash", drive_file_id: "t1/x.jpg", chat_message_id: null },
      ],
      downloadOk: false,
    });
    const res = await processBillExtraction(db, { limit: 10 });
    expect(res.scanned).toBe(1);
    expect(res.created).toBe(0);
    expect(inserts.length).toBe(0);
  });
});

describe("decideEntrySide — ตัดสินซื้อ/ขายจากลูกค้าเรา (pure)", () => {
  const seller = { name: "ร้านวัสดุ เอบีซี จำกัด", taxId: "0105500000009" };
  const buyer = { name: "บริษัท ลูกค้าเรา จำกัด", taxId: "0994000000001" };
  const cust = (p: Partial<{ name: string; businessName: string; taxId: string }>) => ({
    name: p.name ?? null,
    businessName: p.businessName ?? null,
    taxId: p.taxId ?? null,
  });

  describe("ชั้น 1 — เลขภาษี (definitive)", () => {
    it("tax_id ลูกค้า = ผู้ขาย → sale (counterparty = ผู้ซื้อ)", () => {
      const d = decideEntrySide(cust({ name: "ชื่อเพี้ยนไม่ตรง", taxId: "0105500000009" }), seller, buyer);
      expect(d.entryType).toBe("sale");
      expect(d.counterpartyName).toBe(buyer.name);
    });

    it("tax_id ลูกค้า = ผู้ซื้อ → purchase (แม้ชื่อ AI อ่านเพี้ยน)", () => {
      const d = decideEntrySide(cust({ name: "ยูนิไวส์", taxId: "0994000000001" }), seller, buyer);
      expect(d.entryType).toBe("purchase");
      expect(d.counterpartyName).toBe(seller.name);
      expect(d.counterpartyTaxId).toBe(seller.taxId);
    });

    it("tax_id มี dash/ช่องว่าง → strip แล้วยัง match", () => {
      const d = decideEntrySide(cust({ taxId: "0-9940-00000-00-1" }), seller, buyer);
      expect(d.entryType).toBe("purchase");
    });

    it("tax_id ไม่ตรงฝั่งไหน → ตกไปช่องชื่อ (unspecified ถ้าชื่อก็ไม่ตรง)", () => {
      const d = decideEntrySide(cust({ name: "คนละชื่อเลย", taxId: "1111111111111" }), seller, buyer);
      expect(d.entryType).toBe("unspecified");
    });
  });

  describe("ชั้น 2 — fuzzy ชื่อไทย (fallback)", () => {
    it("ลูกค้าเรา = ผู้ซื้อ (ชื่อตรงหลัง normalize) → purchase", () => {
      const d = decideEntrySide(cust({ name: "ลูกค้าเรา" }), seller, buyer);
      expect(d.entryType).toBe("purchase");
      expect(d.counterpartyName).toBe(seller.name);
    });

    it("ลูกค้าเรา = ผู้ขาย (substring) → sale", () => {
      const d = decideEntrySide(cust({ name: "เอบีซี" }), seller, buyer);
      expect(d.entryType).toBe("sale");
      expect(d.counterpartyName).toBe(buyer.name);
    });

    it("★ AI อ่านชื่อเพี้ยน 1-2 ตัว แต่ยังใกล้พอ → จับได้ (Levenshtein/Dice)", () => {
      // ผู้ขายจริง "ยูนิเวิร์ส เทรดดิ้ง", AI อ่านชื่อลูกค้าเป็น seller เพี้ยนเล็กน้อย
      const s = { name: "บริษัท ยูนิเวิร์ส จำกัด", taxId: null };
      const b = { name: "ร้านทั่วไป", taxId: null };
      const d = decideEntrySide(cust({ name: "ยูนิเวิรส์" }), s, b); // สลับ/ตกอักขระ
      expect(d.entryType).toBe("sale");
    });

    it("match ทั้ง 2 ฝั่งพอกัน (กำกวม) → unspecified ไม่เดา", () => {
      const s = { name: "บริษัท เอ จำกัด", taxId: null };
      const b = { name: "บริษัท เอ จำกัด", taxId: null };
      expect(decideEntrySide(cust({ name: "เอ" }), s, b).entryType).toBe("unspecified");
    });

    it("ไม่มีข้อมูลลูกค้า → unspecified", () => {
      expect(decideEntrySide(cust({}), seller, buyer).entryType).toBe("unspecified");
    });

    it("ชื่อลูกค้าไม่ใกล้ฝั่งไหน → unspecified", () => {
      expect(decideEntrySide(cust({ name: "องค์กรอื่นสิ้นดี" }), seller, buyer).entryType).toBe("unspecified");
    });

    it("ใช้ business_name จับได้ถ้า name ไม่ตรง", () => {
      const d = decideEntrySide(cust({ name: "ชื่อเล่น", businessName: "ลูกค้าเรา" }), seller, buyer);
      expect(d.entryType).toBe("purchase");
    });
  });
});

describe("normalizeName / nameSimilarity / digitsOnly (pure)", () => {
  it("normalizeName ตัดคำนำหน้านิติบุคคล + ช่องว่าง", () => {
    expect(normalizeName("บริษัท เอ บี ซี จำกัด")).toBe("เอบีซี");
    expect(normalizeName("ห้างหุ้นส่วนจำกัด ก ข ค")).toBe("กขค");
    expect(normalizeName("  ABC Co., Ltd.  ")).toBe("abc");
  });

  it("nameSimilarity: เหมือนเป๊ะ = 1, substring สูง, เพี้ยนเล็กน้อยยังสูง, คนละเรื่องต่ำ", () => {
    expect(nameSimilarity("ยูนิเวิร์ส", "ยูนิเวิร์ส")).toBe(1);
    expect(nameSimilarity("ยูนิเวิร์ส", "บริษัท ยูนิเวิร์ส เทรดดิ้ง จำกัด")).toBeGreaterThanOrEqual(0.6);
    expect(nameSimilarity("ยูนิเวิรส์", "ยูนิเวิร์ส")).toBeGreaterThanOrEqual(0.6);
    expect(nameSimilarity("แมวเหมียว", "สุนัขน้อย")).toBeLessThan(0.6);
  });

  it("ชื่อสั้น (<3 หลัง normalize) → 0", () => {
    expect(nameSimilarity("ก", "กขคง")).toBe(0);
  });

  it("digitsOnly เหลือแต่ตัวเลข", () => {
    expect(digitsOnly("0-9940 00000.00-1")).toBe("0994000000001");
    expect(digitsOnly(null)).toBe("");
  });
});

/** mock DB เฉพาะ redecideExistingEntries: list ต่อ table + เก็บ update */
function makeRedecideDb(opts: {
  entries: Record<string, unknown>[];
  customers: Record<string, unknown>[];
}): {
  db: SupabaseClient;
  updates: { payload: Record<string, unknown>; filters: Record<string, unknown> }[];
  selects: { table: string; filters: Record<string, unknown> }[];
} {
  const updates: { payload: Record<string, unknown>; filters: Record<string, unknown> }[] = [];
  const selects: { table: string; filters: Record<string, unknown> }[] = [];
  function qb(table: string) {
    const filters: Record<string, unknown> = {};
    let mode: "select" | "update" = "select";
    let payload: Record<string, unknown> = {};
    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      filters[c] = v;
      return api;
    };
    api.is = () => api;
    api.in = () => api;
    api.not = () => api;
    api.limit = () => api;
    api.update = (p: Record<string, unknown>) => {
      mode = "update";
      payload = p;
      return api;
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      if (mode === "update") {
        updates.push({ payload, filters: { ...filters } });
        return Promise.resolve({ data: null, error: null }).then(onF);
      }
      selects.push({ table, filters: { ...filters } });
      // จำลอง scope customer_id: ถ้ามี filter → คืนเฉพาะ entry ของลูกค้านั้น
      let rows = table === "bill_entries" ? opts.entries : table === "customers" ? opts.customers : [];
      if (table === "bill_entries" && filters.customer_id) {
        rows = rows.filter((r) => (r as { customer_id?: unknown }).customer_id === filters.customer_id);
      }
      return Promise.resolve({ data: rows, error: null }).then(onF);
    };
    return api;
  }
  return { db: { from: (t: string) => qb(t) } as unknown as SupabaseClient, updates, selects };
}

describe("redecideExistingEntries — ตัดสินฝั่งใหม่ให้ entry เดิม (ไม่เรียก AI)", () => {
  it("entry unspecified + ลูกค้าเพิ่งมี tax_id ตรงผู้ซื้อ → อัปเดตเป็น purchase", async () => {
    const { db, updates } = makeRedecideDb({
      entries: [
        {
          id: "e1",
          customer_id: "c1",
          seller_name: "ร้านวัสดุ เอบีซี",
          seller_tax_id: "0105500000009",
          buyer_name: "ยูนิไวส์ (อ่านเพี้ยน)",
          buyer_tax_id: "0994000000001",
        },
      ],
      customers: [{ id: "c1", name: "ยูนิเวิร์ส", business_name: null, tax_id: "0994000000001" }],
    });
    const res = await redecideExistingEntries(db, "t1", { limit: 50 });
    expect(res.scanned).toBe(1);
    expect(res.updated).toBe(1);
    expect(updates[0].payload.entry_type).toBe("purchase");
    expect(updates[0].payload.counterparty_name).toBe("ร้านวัสดุ เอบีซี");
    expect(updates[0].filters.tenant_id).toBe("t1");
    expect(updates[0].filters.entry_type).toBe("unspecified"); // guard race
  });

  it("ยังตัดสินไม่ได้ (ชื่อ/เลขไม่ตรง) → ไม่อัปเดต คง unspecified", async () => {
    const { db, updates } = makeRedecideDb({
      entries: [
        {
          id: "e2",
          customer_id: "c2",
          seller_name: "ร้าน ก",
          seller_tax_id: null,
          buyer_name: "ร้าน ข",
          buyer_tax_id: null,
        },
      ],
      customers: [{ id: "c2", name: "องค์กรคนละเรื่อง", business_name: null, tax_id: null }],
    });
    const res = await redecideExistingEntries(db, "t1", { limit: 50 });
    expect(res.updated).toBe(0);
    expect(updates.length).toBe(0);
  });

  it("entry ไม่มีชื่อ/เลขคู่ค้าเลย → ข้าม (ตัดสินไม่ได้)", async () => {
    const { db } = makeRedecideDb({
      entries: [
        { id: "e3", customer_id: "c3", seller_name: null, seller_tax_id: null, buyer_name: null, buyer_tax_id: null },
      ],
      customers: [{ id: "c3", name: "ลูกค้าเรา", business_name: null, tax_id: "0994000000001" }],
    });
    const res = await redecideExistingEntries(db, "t1", { limit: 50 });
    expect(res.scanned).toBe(0);
    expect(res.updated).toBe(0);
  });

  it("★ scope customerId → ส่ง filter customer_id + แตะเฉพาะ entry ของลูกค้ารายนั้น", async () => {
    const { db, updates, selects } = makeRedecideDb({
      entries: [
        // ลูกค้า c1 (รายที่นักบัญชีเพิ่งกรอกเลขภาษี) — ต้องถูก re-decide
        {
          id: "e1",
          customer_id: "c1",
          seller_name: "ร้านวัสดุ เอบีซี",
          seller_tax_id: "0105500000009",
          buyer_name: "อ่านเพี้ยน",
          buyer_tax_id: "0994000000001",
        },
        // ลูกค้า c2 (คนอื่น) — ต้องไม่ถูกแตะ เพราะ scope customerId=c1
        {
          id: "e2",
          customer_id: "c2",
          seller_name: "ร้านอื่น",
          seller_tax_id: "0105500000009",
          buyer_name: "ลูกค้าสอง",
          buyer_tax_id: "0994000000001",
        },
      ],
      customers: [{ id: "c1", name: "ยูนิเวิร์ส", business_name: null, tax_id: "0994000000001" }],
    });
    const res = await redecideExistingEntries(db, "t1", { customerId: "c1" });
    // select bill_entries ต้องมี filter customer_id=c1 (scope ลูกค้าเดียว)
    const entrySelect = selects.find((s) => s.table === "bill_entries")!;
    expect(entrySelect.filters.customer_id).toBe("c1");
    // อัปเดตเฉพาะ e1 ของ c1 (e2 ไม่ถูกดึงมาเพราะ scope)
    expect(res.updated).toBe(1);
    expect(updates.length).toBe(1);
    expect(updates[0].filters.id).toBe("e1");
    expect(updates[0].payload.entry_type).toBe("purchase");
  });
});

/** mock DB สำหรับ backfillEntryAccounts: list ต่อ table + storage + เก็บ update ของ bill_entry_lines */
function makeBackfillDb(opts: {
  entries: Record<string, unknown>[];
  nullLines: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
  downloadOk?: boolean;
}): { db: SupabaseClient; updates: { id: unknown; payload: Record<string, unknown> }[] } {
  const updates: { id: unknown; payload: Record<string, unknown> }[] = [];
  function qb(table: string) {
    const filters: Record<string, unknown> = {};
    let mode: "select" | "update" = "select";
    let payload: Record<string, unknown> = {};
    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      filters[c] = v;
      return api;
    };
    api.is = () => api;
    api.in = () => api;
    api.not = () => api;
    api.order = () => api;
    api.limit = () => api;
    api.update = (p: Record<string, unknown>) => {
      mode = "update";
      payload = p;
      return api;
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      if (mode === "update") {
        updates.push({ id: filters.id, payload });
        return Promise.resolve({ data: null, error: null }).then(onF);
      }
      let data: unknown[] = [];
      if (table === "bill_entries") data = opts.entries;
      else if (table === "bill_entry_lines") data = opts.nullLines;
      else if (table === "message_attachments") data = opts.attachments;
      // ★ chart_of_accounts — mock listChartOfAccounts (A6: backfill โหลดผังต่อ tenant มาเติม account_name)
      else if (table === "chart_of_accounts") data = CHART_ROWS;
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }
  const db = {
    from: (t: string) => qb(t),
    storage: {
      from: () => ({
        download: async () =>
          opts.downloadOk === false
            ? { data: null, error: { message: "nope" } }
            : { data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, error: null },
      }),
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

describe("backfillEntryAccounts — เติมบัญชีบิลเดิม (ยิง AI เอาเฉพาะ account_code)", () => {
  it("บรรทัดที่ account_code ว่าง + AI แนะนำได้ → update account_code/name + ai_filled", async () => {
    extractMock.mockResolvedValue({
      doc_date: null,
      doc_no: null,
      seller_name: null,
      seller_tax_id: null,
      buyer_name: null,
      buyer_tax_id: null,
      lines: [{ vat_type: "vat", description: null, amount: 100, vat_amount: 7, account_code: "5340" }],
      overall_confidence: 0.9,
    });
    const { db, updates } = makeBackfillDb({
      entries: [{ id: "e1", tenant_id: "t1", attachment_id: "att1" }],
      nullLines: [{ id: "lx", entry_id: "e1", line_no: 1 }],
      attachments: [{ id: "att1", drive_file_id: "t1/bill.jpg" }],
    });
    const res = await backfillEntryAccounts(db, { limit: 10 });
    expect(res.scanned).toBe(1);
    expect(res.entriesFilled).toBe(1);
    expect(res.linesFilled).toBe(1);
    expect(updates.length).toBe(1);
    expect(updates[0].id).toBe("lx");
    expect(updates[0].payload.account_code).toBe("5340");
    expect(updates[0].payload.account_name).toBe("ค่าน้ำมัน");
    expect(updates[0].payload.ai_filled).toBe(true);
  });

  it("AI ไม่แนะนำบัญชี (account_code null) → ไม่ update", async () => {
    extractMock.mockResolvedValue({
      doc_date: null, doc_no: null, seller_name: null, seller_tax_id: null, buyer_name: null, buyer_tax_id: null,
      lines: [{ vat_type: "vat", description: null, amount: 100, vat_amount: 7, account_code: null }],
      overall_confidence: 0.9,
    });
    const { db, updates } = makeBackfillDb({
      entries: [{ id: "e1", tenant_id: "t1", attachment_id: "att1" }],
      nullLines: [{ id: "lx", entry_id: "e1", line_no: 1 }],
      attachments: [{ id: "att1", drive_file_id: "t1/bill.jpg" }],
    });
    const res = await backfillEntryAccounts(db, { limit: 10 });
    expect(res.linesFilled).toBe(0);
    expect(updates.length).toBe(0);
  });

  it("entry ไม่มีบรรทัดที่ account_code ว่าง → ข้าม (ไม่ยิง AI)", async () => {
    const { db, updates } = makeBackfillDb({
      entries: [{ id: "e1", tenant_id: "t1", attachment_id: "att1" }],
      nullLines: [], // ทุกบรรทัดมีบัญชีแล้ว
      attachments: [{ id: "att1", drive_file_id: "t1/bill.jpg" }],
    });
    const res = await backfillEntryAccounts(db, { limit: 10 });
    expect(res.scanned).toBe(0);
    expect(extractMock).not.toHaveBeenCalled();
    expect(updates.length).toBe(0);
  });

  it("ไฟล์ PDF → ข้าม (vision อ่านไม่ได้) ไม่ยิง AI", async () => {
    const { db, updates } = makeBackfillDb({
      entries: [{ id: "e1", tenant_id: "t1", attachment_id: "att1" }],
      nullLines: [{ id: "lx", entry_id: "e1", line_no: 1 }],
      attachments: [{ id: "att1", drive_file_id: "t1/doc.pdf" }],
    });
    const res = await backfillEntryAccounts(db, { limit: 10 });
    expect(res.scanned).toBe(0);
    expect(extractMock).not.toHaveBeenCalled();
    expect(updates.length).toBe(0);
  });

  it("ไม่มี entry เลย → คืนศูนย์", async () => {
    const { db } = makeBackfillDb({ entries: [], nullLines: [], attachments: [] });
    const res = await backfillEntryAccounts(db, { limit: 10 });
    expect(res).toEqual({ scanned: 0, entriesFilled: 0, linesFilled: 0 });
  });
});

// ---- collectTargetEntries: ไล่หน้า cursor pagination (core ของ fix คิวค้าง) ----

/** fake fetchPage บน array (เรียง created_at asc) — ใช้ cursor .gt("created_at") จำลอง */
function pagedFetch(all: { id: string; created_at: string }[]) {
  const sorted = [...all].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const cursors: (string | null)[] = [];
  return {
    cursors,
    fetchPage: async (cursor: string | null, pageSize: number) => {
      cursors.push(cursor);
      const rows = cursor == null ? sorted : sorted.filter((r) => r.created_at > cursor);
      return rows.slice(0, pageSize);
    },
  };
}

describe("collectTargetEntries — ไล่หน้าจนได้เป้าหมายครบ limit (bounded)", () => {
  it("★ เป้าหมายอยู่หน้า 2 (ไม่ใช่หน้าแรก) → ต้องไล่ไปเจอ (ไม่ค้าง 0)", async () => {
    // 4 ใบ, หน้าละ 2 → เป้าหมาย id="X" อยู่ใบที่ 4 (หน้า 2)
    const all = [
      { id: "a", created_at: "001" },
      { id: "b", created_at: "002" },
      { id: "c", created_at: "003" },
      { id: "X", created_at: "004" },
    ];
    const { fetchPage, cursors } = pagedFetch(all);
    const targets = await collectTargetEntries({
      limit: 10,
      pageSize: 2,
      fetchPage,
      filterTargets: async (page) => page.filter((e) => e.id === "X"),
    });
    expect(targets.map((t) => t.id)).toEqual(["X"]);
    // ต้องไล่ถึงหน้า 2 (cursor = created_at ใบสุดท้ายหน้าแรก = "002")
    expect(cursors[0]).toBeNull();
    expect(cursors[1]).toBe("002");
  });

  it("หยุดเมื่อได้ครบ limit (ไม่ไล่ต่อ)", async () => {
    const all = Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, created_at: String(i).padStart(3, "0") }));
    const { fetchPage, cursors } = pagedFetch(all);
    const targets = await collectTargetEntries({
      limit: 2,
      pageSize: 5,
      fetchPage,
      filterTargets: async (page) => page, // ทุกใบเป็นเป้าหมาย
    });
    expect(targets.length).toBe(2); // ตัดที่ limit
    expect(cursors).toEqual([null]); // เจอครบในหน้าแรก ไม่ดึงหน้า 2
  });

  it("หยุดเมื่อหมดกอง (หน้าไม่เต็ม) → คืนเท่าที่เจอ", async () => {
    const all = [
      { id: "a", created_at: "001" },
      { id: "b", created_at: "002" },
    ];
    const { fetchPage } = pagedFetch(all);
    const targets = await collectTargetEntries({
      limit: 10,
      pageSize: 5, // หน้าเดียวไม่เต็ม
      fetchPage,
      filterTargets: async (page) => page.filter((e) => e.id === "b"),
    });
    expect(targets.map((t) => t.id)).toEqual(["b"]);
  });

  it("★ maxPages จำกัดจำนวนหน้า (bounded กันวนไม่จบ)", async () => {
    // 100 ใบ ไม่มีเป้าหมายเลย, หน้าละ 10 → maxPages=3 = ดึงแค่ 3 หน้า แล้วเลิก
    const all = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, created_at: String(i).padStart(3, "0") }));
    const { fetchPage, cursors } = pagedFetch(all);
    const targets = await collectTargetEntries({
      limit: 10,
      pageSize: 10,
      maxPages: 3,
      fetchPage,
      filterTargets: async () => [],
    });
    expect(targets).toEqual([]);
    expect(cursors.length).toBe(3); // ไม่เกิน maxPages
  });
});

// ---- pagination จริงผ่าน db mock: เป้าหมายอยู่หน้า 2 (>PAGE_SIZE 200) ต้องเจอ ----

type Rec = Record<string, unknown>;

/** mock db รองรับ .gt("created_at") + .limit() (paginate bill_entries) สำหรับ reextract/backfill */
function makePaginatedDb(opts: {
  entries: Rec[]; // {id,tenant_id,attachment_id,customer_id?,created_at}
  linesByEntry: Record<string, (Rec & { id: string })[]>; // line เต็มของแต่ละ entry
  attachments: Record<string, { drive_file_id: string | null; doc_kind?: string | null }>;
  customers?: Record<string, { name: string | null; business_name: string | null; tax_id: string | null }>;
  downloadOk?: boolean;
}): { db: SupabaseClient; inserts: Captured[]; updates: Rec[]; deletes: { ids: unknown }[] } {
  const inserts: Captured[] = [];
  const updates: Rec[] = [];
  const deletes: { ids: unknown }[] = [];
  const sorted = [...opts.entries].sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at))
  );

  function qb(table: string) {
    let gtVal: string | null = null;
    let limitVal = Infinity;
    let inCol: string | null = null;
    let inVals: unknown[] = [];
    const eqFilters: Rec = {};
    const isNullCols: string[] = [];
    let mode: "select" | "update" | "insert" | "delete" = "select";
    let payload: Rec = {};
    const api: Rec = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      eqFilters[c] = v;
      return api;
    };
    api.gt = (_c: string, v: string) => {
      gtVal = v;
      return api;
    };
    api.in = (c: string, v: unknown[]) => {
      inCol = c;
      inVals = v;
      return api;
    };
    api.is = (c: string) => {
      isNullCols.push(c);
      return api;
    };
    api.not = () => api;
    api.order = () => api;
    api.limit = (n: number) => {
      limitVal = n;
      return api;
    };
    api.update = (p: Rec) => {
      mode = "update";
      payload = p;
      return api;
    };
    api.insert = (rows: Rec | Rec[]) => {
      mode = "insert";
      const arr = Array.isArray(rows) ? rows : [rows];
      inserts.push({ table, rows: arr });
      return api;
    };
    api.delete = () => {
      mode = "delete";
      return api;
    };
    api.maybeSingle = () => Promise.resolve(resolveSingle());
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve(resolveList()).then(onF);

    function currentEntries(): Rec[] {
      let rows = gtVal == null ? sorted : sorted.filter((r) => String(r.created_at) > gtVal!);
      // ★ จำลอง .is("reextract_attempted_at", null) ของ reextract — ข้ามใบที่ mark แล้ว
      if (isNullCols.includes("reextract_attempted_at")) {
        rows = rows.filter((r) => r.reextract_attempted_at == null);
      }
      return rows.slice(0, limitVal);
    }
    function resolveSingle(): { data: unknown; error: unknown } {
      if (mode === "update") {
        updates.push({ table, payload, filters: { ...eqFilters } });
        return { data: { id: eqFilters.id ?? "row" }, error: null }; // guarded update สำเร็จ
      }
      return { data: null, error: null };
    }
    function resolveList(): { data: unknown; error: unknown } {
      if (mode === "update") {
        updates.push({ table, payload, filters: { ...eqFilters } });
        return { data: null, error: null };
      }
      if (mode === "delete") {
        deletes.push({ ids: inVals });
        return { data: null, error: null };
      }
      if (table === "bill_entries") return { data: currentEntries(), error: null };
      if (table === "bill_entry_lines") {
        const ids =
          inCol === "entry_id" ? (inVals as string[]) : eqFilters.entry_id != null ? [eqFilters.entry_id as string] : [];
        let rows: Rec[] = [];
        for (const id of ids) for (const l of opts.linesByEntry[id] ?? []) rows.push({ entry_id: id, ...l });
        if (isNullCols.includes("account_code")) rows = rows.filter((r) => r.account_code == null);
        return { data: rows, error: null };
      }
      if (table === "message_attachments") {
        const ids = inCol === "id" ? (inVals as string[]) : [];
        return {
          data: ids.map((id) => {
            const a = opts.attachments[id];
            return { id, drive_file_id: a?.drive_file_id ?? null, doc_kind: a?.doc_kind ?? null };
          }),
          error: null,
        };
      }
      if (table === "customers") {
        const ids = inCol === "id" ? (inVals as string[]) : [];
        return {
          data: ids.filter((id) => opts.customers?.[id]).map((id) => ({ id, ...opts.customers![id] })),
          error: null,
        };
      }
      return { data: [], error: null };
    }
    return api;
  }

  const db = {
    from: (t: string) => qb(t),
    storage: {
      from: () => ({
        download: async () =>
          opts.downloadOk === false
            ? { data: null, error: { message: "nope" } }
            : { data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, error: null },
      }),
    },
  };
  return { db: db as unknown as SupabaseClient, inserts, updates, deletes };
}

/** สร้าง entry เติมกอง (non-target) ให้ล้น 1 หน้า (PAGE_SIZE=200) */
function filler(n: number, mk: (i: number) => Rec): Rec[] {
  return Array.from({ length: n }, (_, i) => mk(i));
}

describe("backfillEntryAccounts — เจอเป้าหมายที่อยู่หน้า 2 (>200 ใบ) ไม่ค้าง", () => {
  it("★ target มีบรรทัด account_code ว่าง อยู่ใบที่ 210 → เติมได้ (ไล่ข้ามหน้าแรกที่เติมหมดแล้ว)", async () => {
    extractMock.mockResolvedValue({
      doc_date: null, doc_no: null, seller_name: null, seller_tax_id: null, buyer_name: null, buyer_tax_id: null,
      lines: [{ vat_type: "vat", description: null, amount: 100, vat_amount: 7, account_code: "5340" }],
      overall_confidence: 0.9,
    });
    // 210 ใบแรก = "เติมแล้ว" (ไม่มีบรรทัด account_code ว่าง), ใบที่ 210 = target
    const entries: Rec[] = filler(210, (i) => ({
      id: `done-${i}`, tenant_id: "t1", attachment_id: `att-${i}`, created_at: String(i).padStart(4, "0"),
    }));
    entries.push({ id: "target", tenant_id: "t1", attachment_id: "att-target", created_at: "9999" });
    const linesByEntry: Record<string, (Rec & { id: string })[]> = {
      target: [{ id: "L1", line_no: 1, amount: 0, vat_amount: 0, account_code: null, description: null }],
    };
    const attachments = { "att-target": { drive_file_id: "t1/bill.jpg", doc_kind: "purchase" } };
    const { db, updates } = makePaginatedDb({ entries, linesByEntry, attachments });

    const res = await backfillEntryAccounts(db, { limit: 5 });
    expect(res.scanned).toBe(1); // เจอ target หน้า 2 แล้วยิง AI 1 ใบ
    expect(res.linesFilled).toBe(1);
    const upd = updates.find((u) => (u.filters as Rec).id === "L1")!;
    expect(upd).toBeTruthy();
    expect((upd.payload as Rec).account_code).toBe("5340");
  });
});

describe("reExtractIncompleteEntries — เจอ entry ว่างที่อยู่หน้า 2 (>200 ใบ) ไม่ค้าง", () => {
  it("★ entry ว่างจริงอยู่ใบที่ 210 → สกัดใหม่ + อัปเดตในที่เดิม (ไล่ข้ามใบที่เติมแล้ว)", async () => {
    extractMock.mockResolvedValue({
      doc_date: "2026-07-20", doc_no: "INV-9", seller_name: "ร้าน ก", seller_tax_id: null,
      buyer_name: "ลูกค้าเรา", buyer_tax_id: null,
      lines: [{ vat_type: "vat", description: "ของ", amount: 300, vat_amount: 21, account_code: null }],
      overall_confidence: 0.8,
    });
    // 210 ใบแรก "มีข้อมูลแล้ว" (ไม่ว่าง), ใบที่ 210 = ว่างจริง
    const entries: Rec[] = filler(210, (i) => ({
      id: `filled-${i}`, tenant_id: "t1", attachment_id: `att-${i}`, customer_id: null, created_at: String(i).padStart(4, "0"),
    }));
    entries.push({ id: "empty1", tenant_id: "t1", attachment_id: "att-empty", customer_id: null, created_at: "9999" });
    const emptyLine = { id: "EL1", line_no: 1, amount: 0, vat_amount: 0, account_code: null, description: null };
    const linesByEntry: Record<string, (Rec & { id: string })[]> = {
      // ใบเติมแล้ว: มี amount → isEmptyReextractable=false
      ...Object.fromEntries(
        Array.from({ length: 210 }, (_, i) => [
          `filled-${i}`,
          [{ id: `f${i}`, line_no: 1, amount: 100, vat_amount: 7, account_code: "5340", description: "x" }],
        ])
      ),
      empty1: [emptyLine], // ว่างจริง (ทั้ง fresh re-read ด้วย)
    };
    const attachments = { "att-empty": { drive_file_id: "t1/bill.jpg", doc_kind: "purchase" } };
    const { db, updates, inserts, deletes } = makePaginatedDb({ entries, linesByEntry, attachments });

    const res = await reExtractIncompleteEntries(db, { limit: 5 });
    expect(res.scanned).toBe(1);
    expect(res.updated).toBe(1); // สกัดได้ข้อมูล → updated
    // อัปเดตหัว entry ในที่เดิม (guard source/status) + ลบ line ว่างเก่า + insert line ใหม่
    expect(updates.find((u) => (u.filters as Rec).id === "empty1")).toBeTruthy();
    expect(deletes.some((d) => Array.isArray(d.ids) && (d.ids as unknown[]).includes("EL1"))).toBe(true);
    expect(inserts.some((i) => i.table === "bill_entry_lines")).toBe(true);
  });
});

describe("reExtractIncompleteEntries — mark attempted กันวนบิลเดิม (0052)", () => {
  /** entry ว่างจริง 1 บรรทัด (amount=0, ไม่มีบัญชี/รายละเอียด) */
  const emptyLine = (id: string) => ({
    id, line_no: 1, amount: 0, vat_amount: 0, account_code: null, description: null,
  });

  it("★ ข้าม entry ที่ reextract_attempted_at != null (ไม่วนซ้ำใบเดิมที่ลองแล้ว)", async () => {
    // AI อ่านไม่ออก → คืน bill ว่าง (stillEmpty) ทุกครั้ง
    extractMock.mockResolvedValue({
      doc_date: null, doc_no: null, seller_name: null, seller_tax_id: null, buyer_name: null, buyer_tax_id: null,
      lines: [{ vat_type: "vat", description: null, amount: null, vat_amount: null, account_code: null }],
      overall_confidence: 0.3,
    });
    const entries: Rec[] = [
      // ใบ A: ลองแล้ว (attempted) — ต้องถูกข้าม ไม่หยิบมาสกัดซ้ำ
      { id: "attempted", tenant_id: "t1", attachment_id: "att-a", customer_id: null, created_at: "001", reextract_attempted_at: "2026-08-01T00:00:00Z" },
      // ใบ B: ยังไม่ลอง — ต้องถูกหยิบ
      { id: "fresh", tenant_id: "t1", attachment_id: "att-b", customer_id: null, created_at: "002", reextract_attempted_at: null },
    ];
    const linesByEntry: Record<string, (Rec & { id: string })[]> = {
      attempted: [emptyLine("LA")],
      fresh: [emptyLine("LB")],
    };
    const attachments = {
      "att-a": { drive_file_id: "t1/a.jpg", doc_kind: "purchase" },
      "att-b": { drive_file_id: "t1/b.jpg", doc_kind: "purchase" },
    };
    const { db, updates } = makePaginatedDb({ entries, linesByEntry, attachments });

    const res = await reExtractIncompleteEntries(db, { limit: 5 });
    // หยิบเฉพาะ fresh (attempted ถูกกรองออกตั้งแต่ selection)
    expect(res.scanned).toBe(1);
    // mark attempted ยิงให้ fresh (ไม่ยิงให้ attempted)
    const markFresh = updates.find(
      (u) => (u.filters as Rec).id === "fresh" && (u.payload as Rec).reextract_attempted_at != null
    );
    expect(markFresh).toBeTruthy();
    expect(updates.some((u) => (u.filters as Rec).id === "attempted")).toBe(false);
  });

  it("★ mark attempted หลังประมวลผลทั้ง updated และ stillEmpty", async () => {
    // ใบแรก (created 001) สกัดได้ข้อมูล → updated · ใบสอง (002) สกัดว่าง → stillEmpty
    extractMock
      .mockResolvedValueOnce({
        doc_date: "2026-07-20", doc_no: "INV-1", seller_name: "ร้าน ก", seller_tax_id: null,
        buyer_name: "ลูกค้า", buyer_tax_id: null,
        lines: [{ vat_type: "vat", description: "ของ", amount: 300, vat_amount: 21, account_code: null }],
        overall_confidence: 0.8,
      })
      .mockResolvedValueOnce({
        doc_date: null, doc_no: null, seller_name: null, seller_tax_id: null, buyer_name: null, buyer_tax_id: null,
        lines: [{ vat_type: "vat", description: null, amount: null, vat_amount: null, account_code: null }],
        overall_confidence: 0.2,
      });
    const entries: Rec[] = [
      { id: "e-upd", tenant_id: "t1", attachment_id: "att-1", customer_id: null, created_at: "001", reextract_attempted_at: null },
      { id: "e-still", tenant_id: "t1", attachment_id: "att-2", customer_id: null, created_at: "002", reextract_attempted_at: null },
    ];
    const linesByEntry: Record<string, (Rec & { id: string })[]> = {
      "e-upd": [emptyLine("L1")],
      "e-still": [emptyLine("L2")],
    };
    const attachments = {
      "att-1": { drive_file_id: "t1/1.jpg", doc_kind: "purchase" },
      "att-2": { drive_file_id: "t1/2.jpg", doc_kind: "purchase" },
    };
    const { db, updates } = makePaginatedDb({ entries, linesByEntry, attachments });

    const res = await reExtractIncompleteEntries(db, { limit: 5 });
    expect(res.updated).toBe(1);
    expect(res.stillEmpty).toBe(1);
    // ทั้งสองใบต้องถูก mark attempted (ไม่ว่า updated หรือ stillEmpty)
    const marked = (id: string) =>
      updates.some((u) => (u.filters as Rec).id === id && (u.payload as Rec).reextract_attempted_at != null);
    expect(marked("e-upd")).toBe(true);
    expect(marked("e-still")).toBe(true);
    // mark เขียนแบบ guard ai+draft (กันแตะที่คนยืนยันแล้ว)
    const markUpd = updates.find(
      (u) => (u.filters as Rec).id === "e-upd" && (u.payload as Rec).reextract_attempted_at != null
    )!;
    expect((markUpd.filters as Rec).source).toBe("ai");
    expect((markUpd.filters as Rec).status).toBe("draft");
  });

  it("★ backfillEntryAccounts ไม่ถูกกระทบ — ยังหยิบ entry ที่ reextract mark แล้ว", async () => {
    // entry นี้ reextract เคย mark ไว้ (reextract_attempted_at != null) แต่ backfill ต้องยังเติมบัญชีได้
    extractMock.mockResolvedValue({
      doc_date: null, doc_no: null, seller_name: null, seller_tax_id: null, buyer_name: null, buyer_tax_id: null,
      lines: [{ vat_type: "vat", description: null, amount: 100, vat_amount: 7, account_code: "5340" }],
      overall_confidence: 0.9,
    });
    const entries: Rec[] = [
      { id: "e1", tenant_id: "t1", attachment_id: "att1", created_at: "001", reextract_attempted_at: "2026-08-01T00:00:00Z" },
    ];
    const linesByEntry: Record<string, (Rec & { id: string })[]> = {
      e1: [{ id: "L1", line_no: 1, amount: 100, vat_amount: 7, account_code: null, description: "x" }],
    };
    const attachments = { att1: { drive_file_id: "t1/bill.jpg", doc_kind: "purchase" } };
    const { db, updates } = makePaginatedDb({ entries, linesByEntry, attachments });

    const res = await backfillEntryAccounts(db, { limit: 5 });
    // backfill ไม่กรอง reextract_attempted_at → ยังเจอ + เติมบัญชีได้
    expect(res.linesFilled).toBe(1);
    expect(updates.find((u) => (u.filters as Rec).id === "L1")).toBeTruthy();
  });
});
