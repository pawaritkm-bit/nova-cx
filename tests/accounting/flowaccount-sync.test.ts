import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptField } from "@/lib/crypto/field";

vi.mock("@/lib/integrations/flowaccount", () => ({
  createSalesDocument: vi.fn(),
  createPurchaseDocument: vi.fn(),
}));

import { createSalesDocument, createPurchaseDocument } from "@/lib/integrations/flowaccount";
import { claimEntryForSync, syncEntryToFlowAccount } from "@/lib/accounting/flowaccount-sync";

/**
 * flowaccount-sync.ts — orchestration (claim atomic guard + map + เรียก client + เขียนผล/log)
 *   mock db ตาม pattern tests/accounting/actions-lib.test.ts (เก็บ ops ไว้ตรวจ payload/filters)
 *   ★ createSalesDocument/createPurchaseDocument ถูก mock เพื่อคุมผลลัพธ์ client — mapper/claim เป็นของจริง
 *
 * ★★ M2 — credential ต่อลูกค้า (docs/05-flowaccount-integration.md หมวด M2) ★★
 *   ต้องใช้ CREDENTIAL_ENC_KEY จริง encrypt/decrypt round-trip (ไม่ mock decryptField) เพื่อยืนยันว่า
 *   flowaccount-sync.ts ถอดรหัส credential ของลูกค้าถูกแถวจริงๆ ก่อนส่งต่อให้ client
 *
 * ★★ เฟส 5 ส่วน P (T33, docs/06-accounting-features-roadmap.md) — breaking rename
 *   `syncSaleEntryToFlowAccount` → `syncEntryToFlowAccount()` dispatch ตาม entry_type (sale/purchase) —
 *   เคสเดิมของ M1/M2 (sale) ทั้งหมดคงไว้ทั้งหมดหลัง rename (regression) + เพิ่มเคส purchase ใหม่ครบ
 */

const ENC_KEY = "efad676ec53aec07f1dae8d6da957bd9c8bc76e679264c7f8aaf9b8362d6b1db";
// ★ ต้องตั้งก่อนเรียก encryptField() ที่ module scope ด้านล่าง (validCustomer ถูกสร้างตอน import)
process.env.CREDENTIAL_ENC_KEY = ENC_KEY;

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
  counterparty_name: "บริษัท ผู้ซื้อ จำกัด",
  counterparty_tax_id: "0994333333333",
};

const confirmedPurchaseEntry = {
  id: "e1",
  entry_type: "purchase",
  status: "confirmed",
  customer_id: "c1",
  doc_date: "2026-07-01",
  doc_no: "PB-1",
  payment_method: "credit",
  // ★ decision 0.6 — ผู้ขาย/vendor จริง (ต้องกลายเป็น contact ของเอกสาร ไม่ใช่ customers)
  counterparty_name: "บริษัท ผู้ขาย ทดสอบ จำกัด",
  counterparty_tax_id: "0994444444444",
};

const CLIENT_ID = "cid-customer-1";
const CLIENT_SECRET = "secret-customer-1";

/** ลูกค้าที่กรอก credential ครบ (encrypt จริง) — ใช้ในเคส happy path */
function customerWithCredential(overrides: Record<string, unknown> = {}) {
  return {
    // ★ ตั้งชื่อ/เลขภาษีต่างจาก vendor ของบิลซื้อชัดเจน (กันสลับผิด decision 0.6)
    name: "บริษัท ลูกค้า ทดสอบ จำกัด",
    tax_id: "0994000000001",
    address: "ที่อยู่ทดสอบ",
    flowaccount_client_id: CLIENT_ID,
    flowaccount_client_secret_enc: encryptField(CLIENT_SECRET),
    ...overrides,
  };
}

const validCustomer = customerWithCredential();
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

describe("syncEntryToFlowAccount — sale (regression หลัง rename T33)", () => {
  const prevKey = process.env.CREDENTIAL_ENC_KEY;

  beforeEach(() => {
    process.env.CREDENTIAL_ENC_KEY = ENC_KEY;
    vi.mocked(createSalesDocument).mockReset();
    vi.mocked(createPurchaseDocument).mockReset();
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.CREDENTIAL_ENC_KEY;
    else process.env.CREDENTIAL_ENC_KEY = prevKey;
  });

  it("entry ไม่พบ → not_found (ไม่ claim ไม่เรียก client)", async () => {
    const { db, ops } = makeDb({ bill_entries: null });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(ops.find((o) => o.kind === "claim")).toBeUndefined();
    expect(createSalesDocument).not.toHaveBeenCalled();
  });

  it("entry_type ที่ไม่รองรับ (unspecified) → unsupported_entry_type ก่อน claim (ไม่เสีย claim เปล่าๆ)", async () => {
    const { db, ops } = makeDb({ bill_entries: { ...confirmedSaleEntry, entry_type: "unspecified" } });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "unsupported_entry_type" });
    expect(ops.find((o) => o.kind === "claim")).toBeUndefined();
    expect(createSalesDocument).not.toHaveBeenCalled();
    expect(createPurchaseDocument).not.toHaveBeenCalled();
  });

  it("ยังไม่ยืนยัน (draft) → not_confirmed ก่อน claim", async () => {
    const { db, ops } = makeDb({ bill_entries: { ...confirmedSaleEntry, status: "draft" } });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "not_confirmed" });
    expect(ops.find((o) => o.kind === "claim")).toBeUndefined();
  });

  it("ไม่มีลูกค้า → missing_customer ก่อน claim", async () => {
    const { db, ops } = makeDb({ bill_entries: { ...confirmedSaleEntry, customer_id: null } });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "missing_customer" });
    expect(ops.find((o) => o.kind === "claim")).toBeUndefined();
  });

  it("claim ซ้ำ (สองแท็บ/กดรัว) → already_syncing ไม่เรียก client", async () => {
    const { db } = makeDb({
      bill_entries: confirmedSaleEntry,
      "bill_entries:claim": false,
    });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "already_syncing" });
    expect(createSalesDocument).not.toHaveBeenCalled();
  });

  it("ลูกค้าไม่มี flowaccount_client_id/secret เลย (null ทั้งคู่) → customer_not_configured หลัง claim ไม่เรียก client", async () => {
    const { db, ops } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: { name: "x", tax_id: "1", address: "a", flowaccount_client_id: null, flowaccount_client_secret_enc: null },
      "bill_entry_lines:list": validLines,
    });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "customer_not_configured" });
    expect(createSalesDocument).not.toHaveBeenCalled();

    const claim = ops.find((o) => o.kind === "claim");
    expect(claim).toBeDefined(); // เช็คหลัง claim

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("failed");
    expect(upd.payload!.flowaccount_last_error).toMatch(/ยังไม่เปิดใช้การเชื่อมต่อ FlowAccount/);

    const log = ops.find((o) => o.kind === "insert" && o.table === "flowaccount_sync_log")!;
    expect(log.payload!.status).toBe("failed");
    expect(log.payload!.doc_type).toBeNull();
  });

  it("ลูกค้ามี client_id แต่ secret_enc เป็น null (กรอกไม่ครบ) → customer_not_configured เช่นกัน", async () => {
    const { db } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: customerWithCredential({ flowaccount_client_secret_enc: null }),
      "bill_entry_lines:list": validLines,
    });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "customer_not_configured" });
    expect(createSalesDocument).not.toHaveBeenCalled();
  });

  it("client_secret_enc เป็น ciphertext เพี้ยน (decrypt ไม่ได้) → customer_not_configured ไม่ throw ทะลุ", async () => {
    const { db } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: customerWithCredential({ flowaccount_client_secret_enc: "v1:garbage.not.valid" }),
      "bill_entry_lines:list": validLines,
    });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "customer_not_configured" });
    expect(createSalesDocument).not.toHaveBeenCalled();
  });

  it("ไม่มี CREDENTIAL_ENC_KEY ตอน decrypt (คีย์หาย) → customer_not_configured ไม่ throw ทะลุ", async () => {
    delete process.env.CREDENTIAL_ENC_KEY;
    const { db } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "customer_not_configured" });
    expect(createSalesDocument).not.toHaveBeenCalled();
  });

  it("mapper reject (ลูกค้าไม่มีเลขภาษี) → claim ติดแล้วแต่เขียน failed + log ไม่เรียก client", async () => {
    const { db, ops } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: customerWithCredential({ tax_id: null }),
      "bill_entry_lines:list": validLines,
    });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
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
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "no_value_lines" });
  });

  it("mapper reject (ไม่มีวันที่บิล) → failed + log", async () => {
    const { db } = makeDb({
      bill_entries: { ...confirmedSaleEntry, doc_date: null },
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "missing_doc_date" });
  });

  it("success path → synced + doc_id/doc_no + log success + ส่ง credential ที่ decrypt ได้จริงให้ client", async () => {
    const { db, ops } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    });
    vi.mocked(createSalesDocument).mockResolvedValue({ ok: true, docId: "999", docNo: "IV-0001" });

    const res = await syncEntryToFlowAccount(db, "t1", "e1", { requestedBy: "emp-1" });
    expect(res).toEqual({ ok: true, docType: "tax_invoice", docId: "999", docNo: "IV-0001" });

    // ★ credential ต้องตรงกับที่ decrypt ได้จริงจากแถวลูกค้านั้น (ไม่ใช่ credential ของลูกค้าอื่น)
    const [, credential] = vi.mocked(createSalesDocument).mock.calls[0]!;
    expect(credential).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

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

    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "validation_error" });

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("failed");
    expect(upd.payload!.flowaccount_last_error).toBeTruthy();
    // ★ PDPA: error message สั้น ไม่มี payload/เลขภาษี/ยอดเงิน/client_secret
    expect(String(upd.payload!.flowaccount_last_error)).not.toMatch(
      new RegExp(`0994000000001|100|107|${CLIENT_SECRET}`)
    );

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

    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: true, docType: "cash_sale", docId: "1", docNo: null });
    expect(vi.mocked(createSalesDocument).mock.calls[0]![0].docType).toBe("cash_sale");
  });

  // ---------------------------------------------------------------------
  // เฟส 5 ส่วน Q (docs/06-accounting-features-roadmap.md, T28) — mapping ผังบัญชี/สินค้า
  // ---------------------------------------------------------------------

  it("ลูกค้าไม่มี mapping ตั้งไว้เลย (ตาราง mapping ว่าง) → sync สำเร็จเหมือนเดิมทุกประการ (regression)", async () => {
    const { db, ops } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
      // ไม่ใส่ flowaccount_account_map:list/flowaccount_product_map:list เลย → mock คืน [] ตาม default
    });
    vi.mocked(createSalesDocument).mockResolvedValue({ ok: true, docId: "999", docNo: "IV-0001" });

    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: true, docType: "tax_invoice", docId: "999", docNo: "IV-0001" });

    const [payload] = vi.mocked(createSalesDocument).mock.calls[0]!;
    const items = (payload.body as { items: Array<Record<string, unknown>> }).items;
    expect(items[0]!.sellChartOfAccountCode).toBe("");
    expect(items[0]!.id).toBe(0);

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("synced");
  });

  it("ลูกค้ามี mapping ผังบัญชี/สินค้าตั้งไว้ → createSalesDocument ถูกเรียกด้วย sellChartOfAccountCode/items[].id ตรงตาม mapping จริง", async () => {
    const linesWithCodes = [
      {
        description: "ค่าบริการ",
        amount: 100,
        vat_amount: 7,
        vat_type: "vat",
        account_code: "4010",
        product_id: "prod-uuid-1",
      },
    ];
    const { db, ops } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: validCustomer,
      "bill_entry_lines:list": linesWithCodes,
      "flowaccount_account_map:list": [
        { id: "m1", account_code: "4010", flowaccount_account_code: "SALE-01" },
      ],
      "flowaccount_product_map:list": [
        { id: "m2", product_id: "prod-uuid-1", flowaccount_product_id: "555" },
      ],
    });
    vi.mocked(createSalesDocument).mockResolvedValue({ ok: true, docId: "999", docNo: "IV-0001" });

    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res.ok).toBe(true);

    const [payload] = vi.mocked(createSalesDocument).mock.calls[0]!;
    const items = (payload.body as { items: Array<Record<string, unknown>> }).items;
    expect(items[0]!.sellChartOfAccountCode).toBe("SALE-01");
    expect(items[0]!.id).toBe(555);

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("synced");
  });

  it("ลูกค้ามี mapping ผังบัญชีอย่างเดียว (ไม่มี mapping สินค้าเลย) → เติมเฉพาะ sellChartOfAccountCode ส่วน items[].id ยังเป็น 0 เหมือนไม่มี mapping", async () => {
    const linesWithCodes = [
      {
        description: "ค่าบริการ",
        amount: 100,
        vat_amount: 7,
        vat_type: "vat",
        account_code: "4010",
        product_id: "prod-uuid-1",
      },
    ];
    const { db, ops } = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: validCustomer,
      "bill_entry_lines:list": linesWithCodes,
      "flowaccount_account_map:list": [
        { id: "m1", account_code: "4010", flowaccount_account_code: "SALE-01" },
      ],
      // ★ ไม่ใส่ flowaccount_product_map:list เลย → mock คืน [] (ลูกค้าตั้ง mapping ผังบัญชีแต่ไม่ตั้ง mapping สินค้า)
    });
    vi.mocked(createSalesDocument).mockResolvedValue({ ok: true, docId: "999", docNo: "IV-0001" });

    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res.ok).toBe(true);

    const [payload] = vi.mocked(createSalesDocument).mock.calls[0]!;
    const items = (payload.body as { items: Array<Record<string, unknown>> }).items;
    expect(items[0]!.sellChartOfAccountCode).toBe("SALE-01");
    expect(items[0]!.id).toBe(0);

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("synced");
  });

  it("ลูกค้าคนละราย credential คนละชุด → ไม่ปนกัน (mock ลูกค้า 2 รายติดกัน ยังส่ง credential ถูกคน)", async () => {
    const customer2 = customerWithCredential({
      flowaccount_client_id: "cid-customer-2",
      flowaccount_client_secret_enc: encryptField("secret-customer-2"),
    });

    // ลูกค้า 1
    const db1 = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    }).db;
    vi.mocked(createSalesDocument).mockResolvedValue({ ok: true, docId: "1", docNo: null });
    await syncEntryToFlowAccount(db1, "t1", "e1");
    const [, cred1] = vi.mocked(createSalesDocument).mock.calls[0]!;
    expect(cred1).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    // ลูกค้า 2 (เรียกแยกอีกครั้ง — ต้องได้ credential ของลูกค้า 2 เท่านั้น ไม่ใช่ของลูกค้า 1 ที่ mock ไว้ก่อนหน้า)
    const db2 = makeDb({
      bill_entries: confirmedSaleEntry,
      customers: customer2,
      "bill_entry_lines:list": validLines,
    }).db;
    await syncEntryToFlowAccount(db2, "t1", "e2");
    const [, cred2] = vi.mocked(createSalesDocument).mock.calls[1]!;
    expect(cred2).toEqual({ clientId: "cid-customer-2", clientSecret: "secret-customer-2" });
    expect(cred2).not.toEqual(cred1);
  });
});

/**
 * เฟส 5 ส่วน P (docs/06-accounting-features-roadmap.md, T33) — บิลซื้อ/ค่าใช้จ่าย ใหม่
 *   ★★ decision 0.6 (สำคัญที่สุด) — contact ของเอกสารต้องมาจาก entry.counterparty_name/counterparty_tax_id
 *   (ผู้ขายจริง) ไม่ใช่ customers (ลูกค้า NOVA-CX เอง) — ยืนยันตรงๆ ในเทสต์ success path ด้านล่าง
 */
describe("syncEntryToFlowAccount — purchase (เฟส 5 ส่วน P, ใหม่)", () => {
  const prevKey = process.env.CREDENTIAL_ENC_KEY;

  beforeEach(() => {
    process.env.CREDENTIAL_ENC_KEY = ENC_KEY;
    vi.mocked(createSalesDocument).mockReset();
    vi.mocked(createPurchaseDocument).mockReset();
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.CREDENTIAL_ENC_KEY;
    else process.env.CREDENTIAL_ENC_KEY = prevKey;
  });

  it("บิลซื้อไม่มี customer_id ผูก → missing_customer ก่อน claim (เหมือนบิลขาย — guard ใช้ร่วมกัน)", async () => {
    const { db, ops } = makeDb({ bill_entries: { ...confirmedPurchaseEntry, customer_id: null } });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "missing_customer" });
    expect(ops.find((o) => o.kind === "claim")).toBeUndefined();
    expect(createPurchaseDocument).not.toHaveBeenCalled();
  });

  it("claim ซ้ำ (สองแท็บ/กดรัว) → already_syncing ไม่เรียก client", async () => {
    const { db } = makeDb({
      bill_entries: confirmedPurchaseEntry,
      "bill_entries:claim": false,
    });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "already_syncing" });
    expect(createPurchaseDocument).not.toHaveBeenCalled();
  });

  it("ลูกค้าไม่มี credential → customer_not_configured หลัง claim ไม่เรียก client", async () => {
    const { db, ops } = makeDb({
      bill_entries: confirmedPurchaseEntry,
      customers: {
        name: "x",
        tax_id: "1",
        address: "a",
        flowaccount_client_id: null,
        flowaccount_client_secret_enc: null,
      },
      "bill_entry_lines:list": validLines,
    });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "customer_not_configured" });
    expect(createPurchaseDocument).not.toHaveBeenCalled();

    const claim = ops.find((o) => o.kind === "claim");
    expect(claim).toBeDefined();
  });

  it("ผู้ขาย/vendor ไม่มีเลขภาษี (counterparty_tax_id null) → missing_vendor_tax_id หลัง claim + failed + log", async () => {
    const { db, ops } = makeDb({
      bill_entries: { ...confirmedPurchaseEntry, counterparty_tax_id: null },
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "missing_vendor_tax_id" });
    expect(createPurchaseDocument).not.toHaveBeenCalled();

    const claim = ops.find((o) => o.kind === "claim");
    expect(claim).toBeDefined();

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("failed");
    expect(upd.payload!.flowaccount_last_error).toMatch(/ผู้ขายไม่มีเลขประจำตัวผู้เสียภาษี/);

    const log = ops.find((o) => o.kind === "insert" && o.table === "flowaccount_sync_log")!;
    expect(log.payload!.status).toBe("failed");
    expect(log.payload!.doc_type).toBeNull();
  });

  it("mapper reject (ไม่มี line มูลค่า) → no_value_lines", async () => {
    const { db } = makeDb({
      bill_entries: confirmedPurchaseEntry,
      customers: validCustomer,
      "bill_entry_lines:list": [{ description: "x", amount: 0, vat_amount: 0, vat_type: "vat" }],
    });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "no_value_lines" });
  });

  it("mapper reject (ไม่มีวันที่บิล) → missing_doc_date", async () => {
    const { db } = makeDb({
      bill_entries: { ...confirmedPurchaseEntry, doc_date: null },
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    });
    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "missing_doc_date" });
  });

  it("success path (purchase_bill/เชื่อ) → synced + doc_id/doc_no + log success + contact=vendor (ไม่ใช่ customer)", async () => {
    const { db, ops } = makeDb({
      bill_entries: confirmedPurchaseEntry,
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    });
    vi.mocked(createPurchaseDocument).mockResolvedValue({ ok: true, docId: "888", docNo: "PB-0001" });

    const res = await syncEntryToFlowAccount(db, "t1", "e1", { requestedBy: "emp-1" });
    expect(res).toEqual({ ok: true, docType: "purchase_bill", docId: "888", docNo: "PB-0001" });

    expect(createSalesDocument).not.toHaveBeenCalled();

    const [payload, credential] = vi.mocked(createPurchaseDocument).mock.calls[0]!;
    // ★ decision 0.7 — credential เดียวกับฝั่งขายของลูกค้ารายนี้
    expect(credential).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    // ★★ decision 0.6 (จุดสำคัญที่สุด) — contact ต้องเป็นผู้ขาย ไม่ใช่ลูกค้า NOVA-CX
    const body = payload.body as Record<string, unknown>;
    expect(body.contactTaxId).toBe(confirmedPurchaseEntry.counterparty_tax_id);
    expect(body.contactName).toBe(confirmedPurchaseEntry.counterparty_name);
    expect(body.contactTaxId).not.toBe(validCustomer.tax_id);
    expect(body.contactName).not.toBe(validCustomer.name);

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("synced");
    expect(upd.payload!.flowaccount_doc_id).toBe("888");
    expect(upd.payload!.flowaccount_doc_no).toBe("PB-0001");
    expect(upd.payload!.flowaccount_doc_type).toBe("purchase_bill");

    const log = ops.find((o) => o.kind === "insert" && o.table === "flowaccount_sync_log")!;
    expect(log.payload!.status).toBe("success");
    expect(log.payload!.doc_type).toBe("purchase_bill");
    expect(log.payload!.requested_by).toBe("emp-1");
  });

  it("cash_expense (payment_method=cash) → docType cash_expense ส่งต่อถูก", async () => {
    const { db } = makeDb({
      bill_entries: { ...confirmedPurchaseEntry, payment_method: "cash" },
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    });
    vi.mocked(createPurchaseDocument).mockResolvedValue({ ok: true, docId: "1", docNo: null });

    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: true, docType: "cash_expense", docId: "1", docNo: null });
    expect(vi.mocked(createPurchaseDocument).mock.calls[0]![0].docType).toBe("cash_expense");
  });

  it("failure path (client ปฏิเสธ) → failed + error สั้น + log failed (doc_type ยังรู้)", async () => {
    const { db, ops } = makeDb({
      bill_entries: confirmedPurchaseEntry,
      customers: validCustomer,
      "bill_entry_lines:list": validLines,
    });
    vi.mocked(createPurchaseDocument).mockResolvedValue({ ok: false, reason: "validation_error" });

    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res).toEqual({ ok: false, reason: "validation_error" });

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("failed");
    expect(upd.payload!.flowaccount_last_error).toBeTruthy();

    const log = ops.find((o) => o.kind === "insert" && o.table === "flowaccount_sync_log")!;
    expect(log.payload!.status).toBe("failed");
    expect(log.payload!.doc_type).toBe("purchase_bill");
  });

  it("มี mapping ผังบัญชี/สินค้าตั้งไว้ → createPurchaseDocument ถูกเรียกด้วย buyChartOfAccountCode/items[].id ตรงตาม mapping จริง", async () => {
    const linesWithCodes = [
      {
        description: "ค่าซื้อวัสดุ",
        amount: 100,
        vat_amount: 7,
        vat_type: "vat",
        account_code: "5010",
        product_id: "prod-uuid-buy-1",
      },
    ];
    const { db, ops } = makeDb({
      bill_entries: confirmedPurchaseEntry,
      customers: validCustomer,
      "bill_entry_lines:list": linesWithCodes,
      "flowaccount_account_map:list": [
        { id: "m1", account_code: "5010", flowaccount_account_code: "BUY-01" },
      ],
      "flowaccount_product_map:list": [
        { id: "m2", product_id: "prod-uuid-buy-1", flowaccount_product_id: "777" },
      ],
    });
    vi.mocked(createPurchaseDocument).mockResolvedValue({ ok: true, docId: "999", docNo: "PB-0001" });

    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res.ok).toBe(true);

    const [payload] = vi.mocked(createPurchaseDocument).mock.calls[0]!;
    const items = (payload.body as { items: Array<Record<string, unknown>> }).items;
    expect(items[0]!.buyChartOfAccountCode).toBe("BUY-01");
    expect(items[0]!.id).toBe(777);
    expect(items[0]!.sellChartOfAccountCode).toBe("");

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("synced");
  });

  it("ลูกค้ามี mapping สินค้าอย่างเดียว (ไม่มี mapping ผังบัญชีเลย) → เติมเฉพาะ items[].id ส่วน buyChartOfAccountCode ยังว่างเหมือนไม่มี mapping", async () => {
    const linesWithCodes = [
      {
        description: "ค่าซื้อวัสดุ",
        amount: 100,
        vat_amount: 7,
        vat_type: "vat",
        account_code: "5010",
        product_id: "prod-uuid-buy-1",
      },
    ];
    const { db, ops } = makeDb({
      bill_entries: confirmedPurchaseEntry,
      customers: validCustomer,
      "bill_entry_lines:list": linesWithCodes,
      // ★ ไม่ใส่ flowaccount_account_map:list เลย → mock คืน [] (ตั้ง mapping สินค้าแต่ไม่ตั้ง mapping ผังบัญชี)
      "flowaccount_product_map:list": [
        { id: "m2", product_id: "prod-uuid-buy-1", flowaccount_product_id: "777" },
      ],
    });
    vi.mocked(createPurchaseDocument).mockResolvedValue({ ok: true, docId: "999", docNo: "PB-0001" });

    const res = await syncEntryToFlowAccount(db, "t1", "e1");
    expect(res.ok).toBe(true);

    const [payload] = vi.mocked(createPurchaseDocument).mock.calls[0]!;
    const items = (payload.body as { items: Array<Record<string, unknown>> }).items;
    expect(items[0]!.id).toBe(777);
    expect(items[0]!.buyChartOfAccountCode).toBe("");

    const upd = ops.find((o) => o.kind === "update" && o.table === "bill_entries")!;
    expect(upd.payload!.flowaccount_sync_status).toBe("synced");
  });
});
