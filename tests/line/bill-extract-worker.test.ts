import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * bill-extract-worker — สร้าง draft จากบิลที่เก็บแล้ว
 *   ตรวจ: dedup (มี entry แล้วข้าม), PDF → draft ว่าง, รูป → สกัด+เติม line, จับคู่ลูกค้า
 *   mock extractBillData เพื่อไม่ยิง API
 */

// mock ตัวสกัด AI (ตั้งค่าผลต่อเทสต์)
const extractMock = vi.fn();
vi.mock("@/lib/ai/bill-extract", () => ({
  extractBillData: (...a: unknown[]) => extractMock(...a),
}));

import {
  processBillExtraction,
  selectExtractionCandidates,
  decideEntrySide,
  redecideExistingEntries,
  backfillEntryAccounts,
  reExtractIncompleteEntries,
  isEmptyReextractable,
  resolveLineWht,
  buildEntryLineRows,
  round2,
  normalizeName,
  nameSimilarity,
  digitsOnly,
} from "@/lib/line/bill-extract-worker";

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

  it("PDF (attachment_type=file) → draft ว่าง (unspecified) ไม่เรียก AI, line amount=0 ai_filled=false", async () => {
    const { db, inserts } = makeWorkerDb({
      attachments: [
        { id: "att-pdf", tenant_id: "t1", attachment_type: "file", doc_kind: "purchase", drive_file_id: "t1/doc.pdf", chat_message_id: null },
      ],
    });
    const res = await processBillExtraction(db, { limit: 10 });
    expect(res.created).toBe(1);
    expect(res.blank).toBe(1);
    expect(extractMock).not.toHaveBeenCalled();

    const entryIns = inserts.find((i) => i.table === "bill_entries")!;
    expect(entryIns.rows[0].entry_type).toBe("unspecified");

    const lineIns = inserts.find((i) => i.table === "bill_entry_lines")!;
    expect(lineIns.rows[0].amount).toBe(0);
    expect(lineIns.rows[0].ai_filled).toBe(false);
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
