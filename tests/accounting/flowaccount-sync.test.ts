import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/integrations/flowaccount", () => ({
  createSalesDocument: vi.fn(),
}));

import { createSalesDocument } from "@/lib/integrations/flowaccount";
import { claimEntryForSync, syncSaleEntryToFlowAccount } from "@/lib/accounting/flowaccount-sync";

/**
 * flowaccount-sync.ts — orchestration (claim atomic guard + map + เรียก client + เขียนผล/log)
 *   mock db ตาม pattern tests/accounting/actions-lib.test.ts (เก็บ ops ไว้ตรวจ payload/filters)
 *   ★ createSalesDocument ถูก mock เพื่อคุมผลลัพธ์ client — mapper/claim เป็นของจริง
 */

type Op = { kind: string; table: string; payload?: Record<string, unknown>; filters: Record<string, unknown> };

/**
 * mock DB:
 *   - canned[table] = ผล select เดี่ยว (maybeSingle ที่ไม่ตามหลัง update)
 *   - canned[`${table}:list`] = ผล select แบบ list (.then())
 *   - canned[`${table}:claim`] = false → claim ไม่ติด (0 แถว) · undefined/object → claim ติด
 */
function makeDb(canned: Record<string, unknown>): { db: SupabaseClient; ops: Op[] } {
  const ops: Op[] = [];
  function qb(table: string) {
    const filters: Record<string, unknown> = {};
    let mode: "select" | "update" | "insert" | "delete" = "select";
    let payload: Record<string, unknown> = {};
    let selectedAfterUpdate = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => {
      if (mode === "update") selectedAfterUpdate = true;
      return api;
    };
    api.eq = (c: string, v: unknown) => {
      filters[c] = v;
      return api;
    };
    api.is = (c: string, v: unknown) => {
      filters[c] = v;
      return api;
    };
    api.in = (c: string, v: unknown) => {
      filters[c] = v;
      return api;
    };
    api.or = (expr: string) => {
      filters.or = expr;
      return api;
    };
    api.order = () => api;
    api.limit = () => api;
    api.update = (p: Record<string, unknown>) => {
      mode = "update";
      payload = p;
      return api;
    };
    api.insert = (p: Record<string, unknown>) => {
      mode = "insert";
      payload = p;
      return api;
    };
    api.delete = () => {
      mode = "delete";
      return api;
    };
    api.maybeSingle = () => {
      if (mode === "update" && selectedAfterUpdate) {
        ops.push({ kind: "claim", table, payload, filters: { ...filters } });
        const claimed = canned[`${table}:claim`];
        const data = claimed === false ? null : claimed ?? { id: filters.id };
        return Promise.resolve({ data, error: null });
      }
      if (mode === "insert") {
        ops.push({ kind: "insert", table, payload, filters: { ...filters } });
        return Promise.resolve({ data: { id: "new-id" }, error: null });
      }
      return Promise.resolve({ data: canned[table] ?? null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      if (mode === "update") ops.push({ kind: "update", table, payload, filters: { ...filters } });
      else if (mode === "insert") ops.push({ kind: "insert", table, payload, filters: { ...filters } });
      else if (mode === "delete") ops.push({ kind: "delete", table, filters: { ...filters } });
      const data = mode === "select" ? canned[`${table}:list`] ?? [] : null;
      return Promise.resolve({ data, error: null }).then(onF);
    };
    return api;
  }
  return { db: { from: (t: string) => qb(t) } as unknown as SupabaseClient, ops };
}

const confirmedSaleEntry = {
  id: "e1",
  entry_type: "sale",
  status: "confirmed",
  customer_id: "c1",
  doc_date: "2026-07-01",
  doc_no: "INV-1",
  payment_method: "credit",
};

const validCustomer = { name: "บริษัท ทดสอบ จำกัด", tax_id: "0994000000001", address: "ที่อยู่ทดสอบ" };
const validLines = [{ description: "ค่าบริการ", amount: 100, vat_amount: 7, vat_type: "vat" }];

describe("claimEntryForSync", () => {
  it("claim สำเร็จ (0→syncing) → true + update payload/filters ถูกต้อง", async () => {
    const { db, ops } = makeDb({});
    const ok = await claimEntryForSync(db, "t1", "e1");
    expect(ok).toBe(true);
    const claim = ops.find((o) => o.kind === "claim")!;
    expect(claim.payload!.flowaccount_sync_status).toBe("syncing");
    expect(claim.filters.id).toBe("e1");
    expect(claim.filters.tenant_id).toBe("t1");
    expect(claim.filters.or).toBe(
      "flowaccount_sync_status.in.(not_synced,failed),and(flowaccount_sync_status.eq.synced,flowaccount_needs_resync.eq.true)"
    );
  });

  it("claim ซ้ำ (จำลอง 0 แถว — มีคน claim ไปแล้ว) → false", async () => {
    const { db } = makeDb({ "bill_entries:claim": false });
    const ok = await claimEntryForSync(db, "t1", "e1");
    expect(ok).toBe(false);
  });

  it("บิล synced+needsResync=true (กดปุ่มส่งใหม่) → claim ต้องสำเร็จได้ (mock DB จำลองผลจริงของ PostgREST .or())", async () => {
    // mock ฝั่งทดสอบนี้ไม่ประเมิน expression ของ .or() จริง (แค่บันทึกไว้ตรวจ) — ยืนยัน "ผลลัพธ์คาดหวัง"
    // จาก server จริงด้วยการจำลองว่า claim สำเร็จ (canned data ไม่เป็น false) เพื่อยืนยันว่า caller ไม่ได้ไป
    // เติมเงื่อนไขอื่นที่บล็อกเคสนี้ไว้ที่จุดอื่นในโค้ด — ตัว query filter (.or() expression ด้านบน) คือสิ่งที่
    // ทำให้ PostgREST อนุญาต claim จาก synced+needsResync=true ได้จริงในระบบจริง
    const { db, ops } = makeDb({});
    const ok = await claimEntryForSync(db, "t1", "e1");
    expect(ok).toBe(true);
    const claim = ops.find((o) => o.kind === "claim")!;
    // เงื่อนไข or ต้องครอบทั้ง (not_synced/failed) และ (synced+needsResync) ไม่ใช่แค่ any string ใดๆ
    expect(claim.filters.or).toContain("flowaccount_sync_status.eq.synced");
    expect(claim.filters.or).toContain("flowaccount_needs_resync.eq.true");
  });
});

describe("syncSaleEntryToFlowAccount", () => {
  beforeEach(() => {
    vi.mocked(createSalesDocument).mockReset();
  });

  it("entry ไม่พบ → not_found (ไม่ claim ไม่เรียก client)", async () => {
    const { db, ops } = makeDb({ bill_entries: null });
    const res = await syncSaleEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(ops.find((o) => o.kind === "claim")).toBeUndefined();
    expect(createSalesDocument).not.toHaveBeenCalled();
  });

  it("ไม่ใช่บิลขาย (purchase) → not_sale ก่อน claim", async () => {
    const { db, ops } = makeDb({ bill_entries: { ...confirmedSaleEntry, entry_type: "purchase" } });
    const res = await syncSaleEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "not_sale" });
    expect(ops.find((o) => o.kind === "claim")).toBeUndefined();
  });

  it("ยังไม่ยืนยัน (draft) → not_confirmed ก่อน claim", async () => {
    const { db, ops } = makeDb({ bill_entries: { ...confirmedSaleEntry, status: "draft" } });
    const res = await syncSaleEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "not_confirmed" });
    expect(ops.find((o) => o.kind === "claim")).toBeUndefined();
  });

  it("ไม่มีลูกค้า → missing_customer ก่อน claim", async () => {
    const { db, ops } = makeDb({ bill_entries: { ...confirmedSaleEntry, customer_id: null } });
    const res = await syncSaleEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "missing_customer" });
    expect(ops.find((o) => o.kind === "claim")).toBeUndefined();
  });

  it("claim ซ้ำ (สองแท็บ/กดรัว) → already_syncing ไม่เรียก client", async () => {
    const { db } = makeDb({
      bill_entries: confirmedSaleEntry,
      "bill_entries:claim": false,
    });
    const res = await syncSaleEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "already_syncing" });
    expect(createSalesDocument).not.toHaveBeenCalled();
  });

  it("mapper reject (ลูกค้าไม่มีเลขภาษี) → claim ติดแล้วแต่เขียน failed + log ไม่เรียก client", async () => {
    const { db, ops } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: { ...validCustomer, tax_id: null },
      "bill_entry_lines:list": validLines,
    });
    const res = await syncSaleEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "missing_customer_tax_id" });
    expect(createSalesDocument).not.toHaveBeenCalled();

    const claim = ops.find((o) => o.kind === "claim");
    expect(claim).toBeDefined();

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("failed");
    expect(upd.payload!.flowaccount_last_error).toBeTruthy();

    const log = ops.find((o) => o.kind === "insert" && o.table === "flowaccount_sync_log")!;
    expect(log.payload!.status).toBe("failed");
    expect(log.payload!.doc_type).toBeNull();
  });

  it("mapper reject (ไม่มี line มูลค่า) → failed + log", async () => {
    const { db } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: validCustomer,
      "bill_entry_lines:list": [{ description: "x", amount: 0, vat_amount: 0, vat_type: "vat" }],
    });
    const res = await syncSaleEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "no_value_lines" });
  });

  it("mapper reject (ไม่มีวันที่บิล) → failed + log", async () => {
    const { db } = makeDb({
      bill_entries: { ...confirmedSaleEntry, doc_date: null },
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    });
    const res = await syncSaleEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "missing_doc_date" });
  });

  it("success path → synced + doc_id/doc_no + log success", async () => {
    const { db, ops } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    });
    vi.mocked(createSalesDocument).mockResolvedValue({ ok: true, docId: "999", docNo: "IV-0001" });

    const res = await syncSaleEntryToFlowAccount(db, "t1", "e1", { requestedBy: "emp-1" });
    expect(res).toEqual({ ok: true, docType: "tax_invoice", docId: "999", docNo: "IV-0001" });

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("synced");
    expect(upd.payload!.flowaccount_doc_id).toBe("999");
    expect(upd.payload!.flowaccount_doc_no).toBe("IV-0001");
    expect(upd.payload!.flowaccount_doc_type).toBe("tax_invoice");
    expect(upd.payload!.flowaccount_needs_resync).toBe(false);

    const log = ops.find((o) => o.kind === "insert" && o.table === "flowaccount_sync_log")!;
    expect(log.payload!.status).toBe("success");
    expect(log.payload!.flowaccount_doc_id).toBe("999");
    expect(log.payload!.requested_by).toBe("emp-1");
  });

  it("failure path (client ปฏิเสธ) → failed + error สั้น + log failed (doc_type ยังรู้)", async () => {
    const { db, ops } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    });
    vi.mocked(createSalesDocument).mockResolvedValue({ ok: false, reason: "validation_error" });

    const res = await syncSaleEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "validation_error" });

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("failed");
    expect(upd.payload!.flowaccount_last_error).toBeTruthy();
    // ★ PDPA: error message สั้น ไม่มี payload/เลขภาษี/ยอดเงิน
    expect(String(upd.payload!.flowaccount_last_error)).not.toMatch(/0994000000001|100|107/);

    const log = ops.find((o) => o.kind === "insert" && o.table === "flowaccount_sync_log")!;
    expect(log.payload!.status).toBe("failed");
    expect(log.payload!.doc_type).toBe("tax_invoice");
  });

  it("cash_sale (payment_method=transfer) → docType cash_sale ส่งต่อถูก", async () => {
    const { db } = makeDb({
      bill_entries: { ...confirmedSaleEntry, payment_method: "transfer" },
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    });
    vi.mocked(createSalesDocument).mockResolvedValue({ ok: true, docId: "1", docNo: null });

    const res = await syncSaleEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: true, docType: "cash_sale", docId: "1", docNo: null });
    expect(vi.mocked(createSalesDocument).mock.calls[0]![0].docType).toBe("cash_sale");
  });
});
