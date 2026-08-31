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
    // เฟส 10 ส่วน Z — optional-safe (undefined = ไม่กระทบ fixture เดิมจำนวนมากที่ยังไม่รู้จักฟิลด์นี้)
    currency: p.currency,
    fxRate: p.fxRate,
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
 * listEntries — best-effort columns (input_tax_month / stockSync / fx)
 *   mock db: route ผลลัพธ์ตาม select string (ไม่นับลำดับ call)
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
  inputTaxMonth?: Record<string, unknown>[] | "error";
  /** แถวดิบ stock sync (เฟส 8 ส่วน Y, 0.9 — คอลัมน์ bill_entries 4) — ไม่ส่ง = [] (ยังไม่มีข้อมูล) */
  stockSync?: Record<string, unknown>[] | "error";
  /** แถวดิบ currency/fx_rate (เฟส 10 ส่วน Z, migration 0085) — ไม่ส่ง = [] (บิล THB ปกติทั้งหมด) */
  fx?: Record<string, unknown>[] | "error";
  /** แถวดิบ bill_entry_lines (เฟส 1 ส่วน B: ทดสอบ mapping product_id) — ไม่ส่ง = [] (ไม่มี line) */
  lines?: Record<string, unknown>[];
}): SupabaseClient {
  // ★ route ตาม select string (ไม่นับลำดับ call) — queries.ts เพิ่ม best-effort query ใหม่ได้
  //   โดยไม่ทำ mock นี้เหลื่อม (เคยพังเมื่อเพิ่ม side_guessed แทรกกลางลำดับ)
  const pick = (v: Record<string, unknown>[] | "error" | undefined): { data: unknown; error: unknown } =>
    v === "error" ? { data: null, error: { code: "42703" } } : { data: v ?? [], error: null };
  function qb(table: string) {
    let cols = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = (c?: string) => {
      cols = c ?? "";
      return api;
    };
    api.eq = () => api;
    api.is = () => api;
    api.in = () => api;
    api.order = () => api;
    api.limit = () => api;
    api.then = (onFulfilled: (v: { data: unknown; error: unknown }) => unknown) => {
      let result: { data: unknown; error: unknown } = { data: [], error: null };
      if (table === "bill_entries") {
        if (cols.includes("input_tax_month")) result = pick(spec.inputTaxMonth);
        else if (cols.includes("stock_synced_at")) result = pick(spec.stockSync);
        else if (cols.includes("currency")) result = pick(spec.fx);
        else if (cols.includes("side_guessed") || cols.includes("counterparty_address")) result = pick(undefined);
        else result = { data: spec.entries, error: null }; // list หลัก
      } else if (table === "bill_entry_lines") {
        result = { data: spec.lines ?? [], error: null };
      }
      return Promise.resolve(result).then(onFulfilled);
    };
    return api;
  }
  return { from: (t: string) => qb(t) } as unknown as SupabaseClient;
}

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

  it("updated_at ห่างจาก stock_synced_at แค่ไม่กี่ร้อย ms (clock skew ระหว่าง JS Date.now() กับ DB now() ตอน commit — พบจริงตอน sync) → needsResync=false (ไม่ใช่แก้จริง)", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      stockSync: [
        { id: "e1", stock_synced_at: "2026-08-10T07:03:58.034Z", updated_at: "2026-08-10T07:03:58.147Z" },
      ],
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.stockSync!.needsResync).toBe(false);
  });
});

/**
 * listEntries — chunkIds regression (พบจริงระหว่าง manual UI test เฟส 8, 2026-08-10)
 *   บั๊กจริง: tenant ที่มีบิลสะสมมาก (เช่นมุมมอง "ทั้งสำนักงาน") → entryIds ยาวหลักร้อย/พัน →
 *   .in("entry_id", entryIds) ตัวเดียวสร้าง URL ยาวเกิน limit ของ PostgREST → 400 Bad Request เงียบ ๆ
 *   (ไม่ throw — แค่ error ใน response) → ทุกยอดเงิน/VAT/quantity/productId หายไปทั้งหน้า (แสดง 0.00 หมด)
 *   แม้ข้อมูลจริงใน DB ถูกต้อง 100% — แก้โดยตัด entryIds เป็นก้อน (chunkIds) แล้วรวมผลลัพธ์
 *   ★ mock นี้ต่างจาก makeListEntriesDb ข้างบน — จำลอง .in() ให้กรองจริงตาม id ที่ส่งมา (ไม่ใช่แค่นับ call
 *     ลำดับ) เพื่อพิสูจน์ว่า "แบ่งก้อนแล้วรวมผลถูกต้องครบ ไม่ตกหล่น ไม่ซ้ำ" จริง ๆ
 */
describe("listEntries — chunkIds (กัน .in() ยาวเกิน limit เมื่อ entryIds เยอะ)", () => {
  function makeChunkTestDb(entryCount: number): SupabaseClient {
    const ids = Array.from({ length: entryCount }, (_, i) => `e${i}`);
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
      api.in = (col: string, values: string[]) => {
        inCol = col;
        inIds = values;
        return api;
      };
      api.then = (onFulfilled: (v: { data: unknown; error: unknown }) => unknown) => {
        let result: { data: unknown; error: unknown } = { data: [], error: null };
        if (table === "bill_entries" && !inCol) {
          // query หลัก (ไม่มี .in) → entries ทั้งหมด
          result = {
            data: ids.map((id) => ({
              id,
              tenant_id: "t1",
              attachment_id: null,
              customer_id: null,
              upload_path: null,
              upload_name: null,
              upload_mime: null,
              entry_type: "sale",
              doc_date: "2026-07-01",
              doc_no: id,
              counterparty_name: null,
              counterparty_tax_id: null,
              seller_name: null,
              seller_tax_id: null,
              buyer_name: null,
              buyer_tax_id: null,
              wht_form: null,
              payment_method: null,
              payment_bank_account_id: null,
              due_date: null,
              status: "confirmed",
              source: "manual",
              ai_confidence: null,
              notes: null,
              created_at: "2026-07-01T00:00:00Z",
              confirmed_at: null,
            })),
            error: null,
          };
        } else if (table === "bill_entries" && inCol === "id") {
          // best-effort queries (input_tax_month/stockSync/fx) — ไม่ทดสอบละเอียด แค่ไม่พัง
          result = { data: (inIds ?? []).map((id) => ({ id })), error: null };
        } else if (table === "bill_entry_lines") {
          if (!inIds || inIds.length > 150) {
            // ★ จำลองบั๊กจริง: PostgREST ปฏิเสธถ้า .in() ยาวเกิน chunk limit
            return Promise.resolve({ data: null, error: { message: "Bad Request" } }).then(onFulfilled);
          }
          // แต่ละ entry มี 1 line, amount = index ของ entry (เช็คว่าไม่ตกหล่น/ไม่ซ้ำตอนรวมก้อน)
          result = {
            data: inIds.map((id) => ({
              id: `l-${id}`,
              entry_id: id,
              line_no: 1,
              vat_type: "vat",
              description: null,
              account_code: null,
              account_name: null,
              product_id: null,
              quantity: null,
              amount: Number(id.slice(1)) + 1,
              vat_amount: 0,
              wht_rate: 0,
              wht_amount: 0,
              ai_filled: false,
              ai_low_confidence: false,
            })),
            error: null,
          };
        }
        return Promise.resolve(result).then(onFulfilled);
      };
      return api;
    }
    return { from: (t: string) => qb(t) } as unknown as SupabaseClient;
  }

  it("entryIds ≤ 150 (เท่า chunk เดียว) → ยังทำงานปกติ ไม่มีอะไรหาย", async () => {
    const db = makeChunkTestDb(50);
    const res = await listEntries(db, "t1", {});
    expect(res.entries).toHaveLength(50);
    for (const e of res.entries) {
      expect(e.lines).toHaveLength(1);
      expect(e.lines[0]!.amount).toBe(Number(e.id.slice(1)) + 1);
    }
  });

  it("entryIds เกิน chunk limit (300 ตัว) → ตัดเป็นหลายก้อนแล้วรวมผลครบ ไม่ตกหล่น ไม่ซ้ำ (regression ของบั๊กจริง)", async () => {
    const db = makeChunkTestDb(300);
    const res = await listEntries(db, "t1", {});
    expect(res.entries).toHaveLength(300);
    // ★ นี่คือจุดที่บั๊กเดิมจะพัง: ก่อนแก้ (query เดียวไม่ตัดก้อน) ทุก entry.lines จะว่างเปล่า (amount กลายเป็น 0.00)
    let withLines = 0;
    for (const e of res.entries) {
      if (e.lines.length === 1 && e.lines[0]!.amount === Number(e.id.slice(1)) + 1) withLines++;
    }
    expect(withLines).toBe(300);
  });
});

describe("listEntries — currency/fxRate (เฟส 10 ส่วน Z, migration 0085, T81)", () => {
  it("บิล FX (currency/fx_rate มีค่า) → map เข้า BillEntry ถูกต้อง", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      fx: [{ id: "e1", currency: "USD", fx_rate: 35.5 }],
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.currency).toBe("USD");
    expect(res.entries[0]!.fxRate).toBe(35.5);
  });

  it("บิล THB ปกติ (ไม่มีแถว fx) → currency/fxRate เป็น null (ค่าเริ่มต้น)", async () => {
    const db = makeListEntriesDb({ entries: [rawEntryRow({ id: "e1" })], fx: [] });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.currency).toBeNull();
    expect(res.entries[0]!.fxRate).toBeNull();
  });

  it("คอลัมน์ยังไม่ apply migration (select error) → ไม่ทำ list พัง, currency/fxRate = null ทุกแถว", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" }), rawEntryRow({ id: "e2" })],
      fx: "error",
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries).toHaveLength(2);
    for (const e of res.entries) {
      expect(e.currency).toBeNull();
      expect(e.fxRate).toBeNull();
    }
  });
});

describe("listEntries — lines mapping fxAmount (เฟส 10 ส่วน Z, migration 0086)", () => {
  it("line มี fx_amount → map เป็น fxAmount ตรง ๆ (ไม่กระทบ amount ที่เป็น THB derived)", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      lines: [
        {
          id: "l1",
          entry_id: "e1",
          line_no: 1,
          vat_type: "vat",
          description: "ค่าสินค้า",
          account_code: "4010",
          account_name: "ขายสินค้า",
          product_id: null,
          fx_amount: 100,
          amount: 3550,
          vat_amount: 0,
          wht_rate: 0,
          wht_amount: 0,
          ai_filled: false,
          ai_low_confidence: false,
        },
      ],
    });
    const res = await listEntries(db, "t1", {});
    const line = res.entries[0]!.lines[0]!;
    expect(line.fxAmount).toBe(100);
    expect(line.amount).toBe(3550);
  });

  it("line ไม่มี fx_amount (null) → fxAmount เป็น null", async () => {
    const db = makeListEntriesDb({
      entries: [rawEntryRow({ id: "e1" })],
      lines: [
        {
          id: "l1",
          entry_id: "e1",
          line_no: 1,
          vat_type: "vat",
          description: null,
          account_code: null,
          account_name: null,
          product_id: null,
          fx_amount: null,
          amount: 1000,
          vat_amount: 70,
          wht_rate: 0,
          wht_amount: 0,
          ai_filled: false,
          ai_low_confidence: false,
        },
      ],
    });
    const res = await listEntries(db, "t1", {});
    expect(res.entries[0]!.lines[0]!.fxAmount).toBeNull();
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
