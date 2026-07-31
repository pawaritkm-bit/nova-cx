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

import { processBillExtraction, decideEntrySide } from "@/lib/line/bill-extract-worker";

/** เก็บ insert เพื่อ assert */
type Captured = { table: string; rows: Record<string, unknown>[] };

/** สร้าง mock DB ที่คืน canned data ต่อ (table+context) + เก็บ insert */
function makeWorkerDb(opts: {
  attachments: Record<string, unknown>[];
  existingEntries?: { attachment_id: string }[];
  chatGroupCustomer?: string | null;
  customerName?: string | null;
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
        return { data: { name: opts.customerName ?? null, business_name: null }, error: null };
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

  it("ลูกค้าเรา = ผู้ซื้อ → purchase, counterparty = ผู้ขาย", () => {
    const d = decideEntrySide(["ลูกค้าเรา"], seller, buyer);
    expect(d.entryType).toBe("purchase");
    expect(d.counterpartyName).toBe(seller.name);
    expect(d.counterpartyTaxId).toBe(seller.taxId);
  });

  it("ลูกค้าเรา = ผู้ขาย → sale, counterparty = ผู้ซื้อ", () => {
    const d = decideEntrySide(["เอบีซี"], seller, buyer);
    expect(d.entryType).toBe("sale");
    expect(d.counterpartyName).toBe(buyer.name);
  });

  it("ไม่มีชื่อลูกค้า → unspecified", () => {
    expect(decideEntrySide([], seller, buyer).entryType).toBe("unspecified");
  });

  it("ชื่อลูกค้าไม่ match ฝั่งไหนเลย → unspecified", () => {
    expect(decideEntrySide(["บริษัท อื่น"], seller, buyer).entryType).toBe("unspecified");
  });

  it("match ทั้ง 2 ฝั่ง (กำกวม) → unspecified ไม่เดา", () => {
    const d = decideEntrySide(["จำกัด"], seller, buyer); // 'จำกัด' ถูกตัดทิ้ง → ไม่ match
    expect(d.entryType).toBe("unspecified");
  });

  it("ชื่อสั้นเกินไป (<3) → ไม่ match", () => {
    expect(decideEntrySide(["ก"], seller, buyer).entryType).toBe("unspecified");
  });
});
