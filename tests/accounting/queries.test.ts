import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  lineNet,
  round2,
  summarizeEntry,
  summarizeEntries,
  monthRange,
  monthBounds,
  dateRange,
  effectiveTaxMonth,
  listEntries,
  type BillEntry,
  type BillEntryLine,
  type FlowAccountSyncInfo,
} from "@/lib/accounting/queries";

describe("effectiveTaxMonth — เดือนที่ใช้ภาษีซื้อ", () => {
  it("มี inputTaxMonth ถูกรูปแบบ → ใช้ค่านั้น (ยกเดือน)", () => {
    expect(effectiveTaxMonth({ inputTaxMonth: "2026-07", docDate: "2026-06-15" })).toBe("2026-07");
  });
  it("ไม่มี inputTaxMonth → ใช้เดือนของ doc_date (พฤติกรรมเดิม)", () => {
    expect(effectiveTaxMonth({ inputTaxMonth: null, docDate: "2026-06-15" })).toBe("2026-06");
    expect(effectiveTaxMonth({ docDate: "2026-06-01" })).toBe("2026-06");
  });
  it("inputTaxMonth ผิดรูป → fallback doc_date", () => {
    expect(effectiveTaxMonth({ inputTaxMonth: "bad", docDate: "2026-06-15" })).toBe("2026-06");
    expect(effectiveTaxMonth({ inputTaxMonth: "2026-13", docDate: "2026-06-15" })).toBe("2026-06");
  });
  it("ไม่มีทั้งคู่ → null (บิลไม่ลงวันที่)", () => {
    expect(effectiveTaxMonth({ inputTaxMonth: null, docDate: null })).toBeNull();
  });
});

/**
 * accounting/queries — คำนวณสรุป (pure) + monthRange
 */

function line(p: Partial<BillEntryLine>): BillEntryLine {
  return {
    id: p.id ?? "l1",
    entryId: p.entryId ?? "e1",
    lineNo: p.lineNo ?? 1,
    vatType: p.vatType ?? "vat",
    description: p.description ?? null,
    accountCode: p.accountCode ?? null,
    accountName: p.accountName ?? null,
    amount: p.amount ?? 0,
    vatAmount: p.vatAmount ?? 0,
    whtRate: p.whtRate ?? 0,
    whtAmount: p.whtAmount ?? 0,
    aiFilled: p.aiFilled ?? false,
    aiLowConfidence: p.aiLowConfidence ?? false,
  };
}

function entry(p: Partial<BillEntry>): BillEntry {
  return {
    id: p.id ?? "e1",
    tenantId: p.tenantId ?? "t1",
    attachmentId: p.attachmentId ?? null,
    customerId: p.customerId ?? null,
    customerName: p.customerName ?? null,
    attachmentObjectPath: p.attachmentObjectPath ?? null,
    uploadPath: p.uploadPath ?? null,
    uploadName: p.uploadName ?? null,
    uploadMime: p.uploadMime ?? null,
    entryType: p.entryType ?? "purchase",
    docDate: p.docDate ?? null,
    docNo: p.docNo ?? null,
    counterpartyName: p.counterpartyName ?? null,
    counterpartyTaxId: p.counterpartyTaxId ?? null,
    sellerName: p.sellerName ?? null,
    sellerTaxId: p.sellerTaxId ?? null,
    buyerName: p.buyerName ?? null,
    buyerTaxId: p.buyerTaxId ?? null,
    whtForm: p.whtForm ?? null,
    paymentMethod: null,
    paymentBankAccountId: null,
    paymentBankAccountCode: null,
    dueDate: p.dueDate ?? null,
    status: p.status ?? "draft",
    source: p.source ?? "ai",
    aiConfidence: p.aiConfidence ?? null,
    notes: p.notes ?? null,
    inputTaxMonth: p.inputTaxMonth ?? null,
    flowaccountSync:
      p.flowaccountSync ??
      ({
        status: "not_synced",
        docType: null,
        docId: null,
        docNo: null,
        syncedAt: null,
        lastError: null,
        needsResync: false,
      } as FlowAccountSyncInfo),
    createdAt: p.createdAt ?? "2026-07-01T00:00:00Z",
    confirmedAt: p.confirmedAt ?? null,
    lines: p.lines ?? [],
  };
}

describe("lineNet — มูลค่า + VAT - หัก ณ ที่จ่าย", () => {
  it("คำนวณถูกต้อง", () => {
    expect(lineNet({ amount: 100, vatAmount: 7, whtAmount: 3 })).toBe(104);
  });
  it("ปัดทศนิยม 2 ตำแหน่ง", () => {
    expect(lineNet({ amount: 100.005, vatAmount: 0, whtAmount: 0 })).toBe(100.01);
  });
});

describe("round2", () => {
  it("ปัด 2 ตำแหน่ง กัน floating error", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe("summarizeEntry — รวมทุก line ของ entry", () => {
  it("รวม amount/vat/wht/net", () => {
    const s = summarizeEntry([
      line({ amount: 100, vatAmount: 7, whtAmount: 3 }),
      line({ amount: 50, vatAmount: 0, whtAmount: 0, vatType: "novat" }),
    ]);
    expect(s.amount).toBe(150);
    expect(s.vat).toBe(7);
    expect(s.wht).toBe(3);
    expect(s.net).toBe(154); // 150 + 7 - 3
  });
});

describe("summarizeEntries — แยกประเภท purchase/sale", () => {
  it("แยกยอด + นับจำนวนถูก", () => {
    const entries = [
      entry({ entryType: "purchase", lines: [line({ amount: 100, vatAmount: 7 })] }),
      entry({ entryType: "purchase", lines: [line({ amount: 200, vatAmount: 14, whtAmount: 6 })] }),
      entry({ entryType: "sale", lines: [line({ amount: 1000, vatAmount: 70 })] }),
    ];
    const s = summarizeEntries(entries);
    expect(s.purchase.count).toBe(2);
    expect(s.purchase.amount).toBe(300);
    expect(s.purchase.vat).toBe(21);
    expect(s.purchase.wht).toBe(6);
    expect(s.purchase.net).toBe(315); // 300 + 21 - 6
    expect(s.sale.count).toBe(1);
    expect(s.sale.amount).toBe(1000);
    expect(s.sale.net).toBe(1070);
  });

  it("ไม่มี entry → ยอด 0 ทุกช่อง", () => {
    const s = summarizeEntries([]);
    expect(s.purchase.count).toBe(0);
    expect(s.sale.amount).toBe(0);
  });

  it("entry 'unspecified' (รอระบุ) → ไม่ถูกนับในสรุปซื้อ/ขาย", () => {
    const s = summarizeEntries([
      entry({ entryType: "unspecified", lines: [line({ amount: 999, vatAmount: 70 })] }),
      entry({ entryType: "purchase", lines: [line({ amount: 100, vatAmount: 7 })] }),
    ]);
    expect(s.purchase.count).toBe(1);
    expect(s.purchase.amount).toBe(100);
    expect(s.sale.count).toBe(0);
  });
});

describe("monthRange — ช่วงวันของเดือน", () => {
  it("เดือนปกติ", () => {
    expect(monthRange("2026-07")).toEqual({ start: "2026-07-01", end: "2026-08-01" });
  });
  it("เดือน ธ.ค. → ข้ามปี", () => {
    expect(monthRange("2026-12")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
  });
  it("รูปแบบผิด / เดือนเกิน → null", () => {
    expect(monthRange("2026-13")).toBeNull();
    expect(monthRange("bad")).toBeNull();
    expect(monthRange(undefined)).toBeNull();
  });
});

describe("monthBounds — วันแรก/วันสุดท้ายของเดือน", () => {
  it("เดือน 31 วัน", () => {
    expect(monthBounds("2026-07")).toEqual({ first: "2026-07-01", last: "2026-07-31" });
  });
  it("เดือน 30 วัน (มิ.ย.)", () => {
    expect(monthBounds("2026-06")).toEqual({ first: "2026-06-01", last: "2026-06-30" });
  });
  it("ก.พ. ปีปกติ = 28, ปีอธิกสุรทิน = 29", () => {
    expect(monthBounds("2026-02")).toEqual({ first: "2026-02-01", last: "2026-02-28" });
    expect(monthBounds("2028-02")).toEqual({ first: "2028-02-01", last: "2028-02-29" });
  });
  it("ธ.ค. → 31", () => {
    expect(monthBounds("2026-12")).toEqual({ first: "2026-12-01", last: "2026-12-31" });
  });
  it("รูปแบบผิด → null", () => {
    expect(monthBounds("2026-13")).toBeNull();
    expect(monthBounds("bad")).toBeNull();
    expect(monthBounds(undefined)).toBeNull();
  });
});

describe("dateRange — ช่วงวันที่ inclusive (from/to)", () => {
  it("ครบทั้งคู่", () => {
    expect(dateRange("2026-06-01", "2026-06-30")).toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });
  it("from > to → สลับให้", () => {
    expect(dateRange("2026-06-30", "2026-06-01")).toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });
  it("มีข้างเดียว → เปิดปลายอีกข้าง", () => {
    expect(dateRange("2026-06-15", undefined)).toEqual({ start: "2026-06-15", end: null });
    expect(dateRange(undefined, "2026-06-15")).toEqual({ start: null, end: "2026-06-15" });
  });
  it("รูปแบบผิดทั้งคู่ / ไม่ส่ง → null", () => {
    expect(dateRange(undefined, undefined)).toBeNull();
    expect(dateRange("bad", "2026-13-40")).toBeNull();
  });
  it("ตัดค่าพังข้างเดียว (เก็บเฉพาะที่ถูก)", () => {
    expect(dateRange("2026-06-01", "bad")).toEqual({ start: "2026-06-01", end: null });
  });
});

/**
 * listEntries — flowaccountSync (T7)
 *   mock db: bill_entries ถูก query 3 รอบตามลำดับจริงใน queries.ts
 *     (1) list หลัก (2) input_tax_month best-effort (3) flowaccount best-effort
 *   ★ ทดสอบ: mapping คอลัมน์ถูกต้อง + fallback ถ้าคอลัมน์ยังไม่ apply migration (ไม่ทำ list พัง)
 */
type RawEntryRow = Record<string, unknown>;

function rawEntryRow(p: Partial<RawEntryRow> = {}): RawEntryRow {
  return {
    id: "e1",
    tenant_id: "t1",
    attachment_id: null,
    customer_id: null,
    upload_path: null,
    upload_name: null,
    upload_mime: null,
    entry_type: "sale",
    doc_date: "2026-07-01",
    doc_no: "INV-1",
    counterparty_name: null,
    counterparty_tax_id: null,
    seller_name: null,
    seller_tax_id: null,
    buyer_name: null,
    buyer_tax_id: null,
    wht_form: null,
    payment_method: null,
    payment_bank_account_id: null,
    status: "confirmed",
    source: "manual",
    ai_confidence: null,
    notes: null,
    created_at: "2026-07-01T00:00:00Z",
    confirmed_at: null,
    ...p,
  };
}

function makeListEntriesDb(spec: {
  entries: RawEntryRow[];
  flowaccount?: Record<string, unknown>[] | "error";
  inputTaxMonth?: Record<string, unknown>[] | "error";
  /** แถวดิบ stock sync (เฟส 8 ส่วน Y, 0.9 — คอลัมน์ bill_entries 4) — ไม่ส่ง = [] (ยังไม่มีข้อมูล) */
  stockSync?: Record<string, unknown>[] | "error";
  /** แถวดิบ bill_entry_lines (เฟส 1 ส่วน B: ทดสอบ mapping product_id) — ไม่ส่ง = [] (ไม่มี line) */
  lines?: Record<string, unknown>[];
}): SupabaseClient {
  const callCount: Record<string, number> = {};
  function qb(table: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = () => api;
    api.is = () => api;
    api.in = () => api;
    api.order = () => api;
    api.limit = () => api;
    api.then = (onFulfilled: (v: { data: unknown; error: unknown }) => unknown) => {
      const idx = (callCount[table] = (callCount[table] ?? 0) + 1);
      let result: { data: unknown; error: unknown } = { data: [], error: null };
      if (table === "bill_entries") {
        if (idx === 1) result = { data: spec.entries, error: null };
        else if (idx === 2) {
          result =
            spec.inputTaxMonth === "error"
              ? { data: null, error: { code: "42703" } }
              : { data: spec.inputTaxMonth ?? [], error: null };
        } else if (idx === 3) {
          result =
            spec.flowaccount === "error"
              ? { data: null, error: { code: "42703" } }
              : { data: spec.flowaccount ?? [], error: null };
        } else if (idx === 4) {
          result =
            spec.stockSync === "error"
              ? { data: null, error: { code: "42703" } }
              : { data: spec.stockSync ?? [], error: null };
        }
      } else if (table === "bill_entry_lines") {
        result = { data: spec.lines ?? [], error: null };
      }
      return Promise.resolve(result).then(onFulfilled);
    };
    return api;
  }
  return { from: (t: string) => qb(t) } as unknown as SupabaseClient;
}

describe("listEntries — flowaccountSync (T7)", () => {
  it("คอลัมน์มีข้อมูล → map flowaccountSync ถูกต้องครบ", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      flowaccount: [
        {
          id: "e1",
          flowaccount_sync_status: "synced",
          flowaccount_doc_type: "tax_invoice",
          flowaccount_doc_id: "12345",
          flowaccount_doc_no: "IV-0001",
          flowaccount_synced_at: "2026-07-02T10:00:00Z",
          flowaccount_last_error: null,
          flowaccount_needs_resync: true,
        },
      ],
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.flowaccountSync).toEqual({
      status: "synced",
      docType: "tax_invoice",
      docId: "12345",
      docNo: "IV-0001",
      syncedAt: "2026-07-02T10:00:00Z",
      lastError: null,
      needsResync: true,
    });
  });

  it("ไม่มีแถวสถานะ (entry ยังไม่มีข้อมูล sync) → default not_synced", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      flowaccount: [],
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.flowaccountSync).toEqual({
      status: "not_synced",
      docType: null,
      docId: null,
      docNo: null,
      syncedAt: null,
      lastError: null,
      needsResync: false,
    });
  });

  it("คอลัมน์ยังไม่ apply migration (select error) → ไม่ทำ list พัง, flowaccountSync = default", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" }), rawEntryRow({ id: "e2" })],
      flowaccount: "error",
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries).toHaveLength(2);
    for (const e of res.entries) {
      expect(e.flowaccountSync.status).toBe("not_synced");
      expect(e.flowaccountSync.docId).toBeNull();
    }
  });

  it("สถานะ failed + มี lastError → map ตรง", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      flowaccount: [
        {
          id: "e1",
          flowaccount_sync_status: "failed",
          flowaccount_doc_type: null,
          flowaccount_doc_id: null,
          flowaccount_doc_no: null,
          flowaccount_synced_at: null,
          flowaccount_last_error: "เชื่อมต่อ FlowAccount หมดเวลา",
          flowaccount_needs_resync: false,
        },
      ],
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.flowaccountSync.status).toBe("failed");
    expect(res.entries[0]!.flowaccountSync.lastError).toBe("เชื่อมต่อ FlowAccount หมดเวลา");
  });
});

describe("listEntries — stockSync (เฟส 8 ส่วน Y, 0.9, migration 0078)", () => {
  it("ยังไม่เคยบันทึกสต็อก → default syncedAt=null, needsResync=false", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      stockSync: [],
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.stockSync).toEqual({ syncedAt: null, needsResync: false });
  });

  it("บันทึกสต็อกแล้ว บิลไม่ถูกแก้ไขซ้ำ (updated_at = stock_synced_at) → needsResync=false", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      stockSync: [{ id: "e1", stock_synced_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" }],
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.stockSync).toEqual({ syncedAt: "2026-08-01T00:00:00Z", needsResync: false });
  });

  it("บันทึกสต็อกแล้ว แต่บิลถูกแก้ไขทีหลัง (updated_at ใหม่กว่า stock_synced_at) → needsResync=true", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      stockSync: [{ id: "e1", stock_synced_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-05T00:00:00Z" }],
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.stockSync).toEqual({ syncedAt: "2026-08-01T00:00:00Z", needsResync: true });
  });

  it("คอลัมน์ยังไม่ apply migration (select error) → ไม่ทำ list พัง, stockSync = default", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" }), rawEntryRow({ id: "e2" })],
      stockSync: "error",
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries).toHaveLength(2);
    for (const e of res.entries) {
      expect(e.stockSync).toEqual({ syncedAt: null, needsResync: false });
    }
  });
});

describe("listEntries — dueDate mapping (เฟส 2 ส่วน E, migration 0067)", () => {
  it("มีค่า due_date → map เป็น dueDate ตรง ๆ", async () => {
    const db = makeListEntriesDb({ entries: [rawEntryRow({ id: "e1", due_date: "2026-08-31" })] });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.dueDate).toBe("2026-08-31");
  });

  it("ไม่มี due_date (บิลเก่าก่อนเฟสนี้ — ไม่ backfill) → dueDate เป็น null", async () => {
    const db = makeListEntriesDb({ entries: [rawEntryRow({ id: "e1", due_date: null })] });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.dueDate).toBeNull();
  });
});

describe("listEntries — lines mapping product_id (เฟส 1 ส่วน B, docs/06 หมวด B)", () => {
  function rawLineRow(p: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      id: "l1",
      entry_id: "e1",
      line_no: 1,
      vat_type: "vat",
      description: "ค่าสินค้า",
      account_code: "4010",
      account_name: "ขายสินค้า",
      product_id: null,
      amount: 1000,
      vat_amount: 70,
      wht_rate: 0,
      wht_amount: 0,
      ai_filled: false,
      ai_low_confidence: false,
      ...p,
    };
  }

  it("line ผูกสินค้า (product_id มีค่า) → map เป็น productId ตรง ๆ", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      lines: [rawLineRow({ product_id: "prod-1" })],
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.lines[0]!.productId).toBe("prod-1");
  });

  it("line ไม่ผูกสินค้า (product_id เป็น null) → productId เป็น null", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      lines: [rawLineRow({ product_id: null })],
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.lines[0]!.productId).toBeNull();
  });

  it("★ ไม่กระทบฟิลด์อื่นของ line (amount/account_code/description ยังตรงเหมือนเดิม)", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      lines: [rawLineRow({ product_id: "prod-2", amount: 2500, account_code: "5300" })],
    });
    const res = await listEntries(db, "t1", {});
    const line = res.entries[0]!.lines[0]!;
    expect(line.productId).toBe("prod-2");
    expect(line.amount).toBe(2500);
    expect(line.accountCode).toBe("5300");
    expect(line.description).toBe("ค่าสินค้า");
  });
});
