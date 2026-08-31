import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listAccountMap,
  upsertAccountMap,
  deleteAccountMap,
  listProductMap,
  upsertProductMap,
  deleteProductMap,
  accountMapToRecord,
  productMapToRecord,
  type AccountMapRow,
  type ProductMapRow,
} from "@/lib/accounting/flowaccount-map";

/**
 * flowaccount-map.ts — เฟส 5 ส่วน Q (docs/06-accounting-features-roadmap.md, T24)
 *   เน้น: CRUD ปกติ (account map + product map), upsert ทับแถวเดิมไม่สร้างซ้ำ, validate ค่าว่าง/ยาวเกิน,
 *         degrade อย่างสุภาพถ้ายังไม่ apply migration 0071 (list → [] , upsert/delete → { ok:false })
 */

type Op = { kind: string; table: string; payload?: Record<string, unknown>; filters: Record<string, unknown> };

/**
 * mock DB (pattern เดียวกับ tests/accounting/products.test.ts):
 *   canned[table]            = ผล select-single (cur-check ก่อน insert/update) ตอน maybeSingle
 *   canned[`${table}:list`]  = ผล select แบบ list (.then() ไม่ผ่าน maybeSingle)
 *   canned[`${table}:insertError`] = error code (string) ตอน insert แล้ว maybeSingle
 *   canned[`${table}:updateError`] = error ตอน update แล้ว await (.then())
 *   canned[`${table}:deleteError`] = error ตอน delete แล้ว await (.then())
 */
function makeDb(canned: Record<string, unknown>): { db: SupabaseClient; ops: Op[] } {
  const ops: Op[] = [];
  function qb(table: string) {
    const filters: Record<string, unknown> = {};
    let mode: "select" | "update" | "insert" | "delete" = "select";
    let payload: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      filters[c] = v;
      return api;
    };
    api.is = (c: string, v: unknown) => {
      filters[c] = v;
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
      if (mode === "insert") {
        ops.push({ kind: "insert", table, payload, filters: { ...filters } });
        const errCode = canned[`${table}:insertError`] as string | undefined;
        if (errCode) return Promise.resolve({ data: null, error: { code: errCode } });
        return Promise.resolve({ data: { id: "new-id" }, error: null });
      }
      // select single (cur-check): คืน canned ของ table
      return Promise.resolve({ data: canned[table] ?? null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let error: unknown = null;
      if (mode === "update") {
        ops.push({ kind: "update", table, payload, filters: { ...filters } });
        error = canned[`${table}:updateError`] ?? null;
      } else if (mode === "delete") {
        ops.push({ kind: "delete", table, filters: { ...filters } });
        error = canned[`${table}:deleteError`] ?? null;
      }
      const data = mode === "select" ? canned[`${table}:list`] ?? [] : null;
      return Promise.resolve({ data, error }).then(onF);
    };
    return api;
  }
  return { db: { from: (t: string) => qb(t) } as unknown as SupabaseClient, ops };
}

const TENANT = "t1";
const CUSTOMER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PRODUCT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

// ---------------------------------------------------------------------
// helper pure
// ---------------------------------------------------------------------

describe("accountMapToRecord / productMapToRecord — pure", () => {
  it("[] → {}", () => {
    expect(accountMapToRecord([])).toEqual({});
    expect(productMapToRecord([])).toEqual({});
  });

  it("accountMapToRecord: แปลง account_code → flowaccount_account_code", () => {
    const rows: AccountMapRow[] = [
      { id: "m1", accountCode: "4010", flowaccountAccountCode: "SALE-01" },
      { id: "m2", accountCode: "1010", flowaccountAccountCode: "CASH-01" },
    ];
    expect(accountMapToRecord(rows)).toEqual({ "4010": "SALE-01", "1010": "CASH-01" });
  });

  it("productMapToRecord: แปลง product_id → flowaccount_product_id", () => {
    const rows: ProductMapRow[] = [{ id: "m1", productId: PRODUCT, flowaccountProductId: "999" }];
    expect(productMapToRecord(rows)).toEqual({ [PRODUCT]: "999" });
  });
});

// ---------------------------------------------------------------------
// mapping ผังบัญชี
// ---------------------------------------------------------------------

describe("listAccountMap", () => {
  it("ไม่มีข้อมูล/query error (เช่นยังไม่ apply migration 0071) → [] (ไม่ throw)", async () => {
    const { db } = makeDb({});
    const res = await listAccountMap(db, TENANT, CUSTOMER);
    expect(res).toEqual([]);
  });

  it("map แถวดิบ → AccountMapRow ถูกต้อง", async () => {
    const { db } = makeDb({
      "flowaccount_account_map:list": [
        { id: "m1", account_code: "4010", flowaccount_account_code: "SALE-01" },
      ],
    });
    const res = await listAccountMap(db, TENANT, CUSTOMER);
    expect(res).toEqual([{ id: "m1", accountCode: "4010", flowaccountAccountCode: "SALE-01" }]);
  });
});

describe("upsertAccountMap", () => {
  it("accountCode ว่าง → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertAccountMap(db, TENANT, CUSTOMER, "  ", "SALE-01");
    expect(res).toEqual({ ok: false, message: "กรุณาระบุรหัสบัญชี" });
    expect(ops).toHaveLength(0);
  });

  it("flowaccountAccountCode ว่าง → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertAccountMap(db, TENANT, CUSTOMER, "4010", "   ");
    expect(res).toEqual({ ok: false, message: "กรุณาระบุรหัสบัญชีฝั่ง FlowAccount" });
    expect(ops).toHaveLength(0);
  });

  it("customerId ไม่ใช่ uuid → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertAccountMap(db, TENANT, "not-a-uuid", "4010", "SALE-01");
    expect(res).toEqual({ ok: false, message: "ไม่พบลูกค้าที่เลือก" });
    expect(ops).toHaveLength(0);
  });

  it("ค่ายาวเกินเพดาน → clamp ไม่ throw (ไม่ปฏิเสธถ้ายังไม่ว่างหลัง clamp)", async () => {
    const { db, ops } = makeDb({});
    const longCode = "x".repeat(100);
    const res = await upsertAccountMap(db, TENANT, CUSTOMER, "4010", longCode);
    expect(res.ok).toBe(true);
    const ins = ops.find((o) => o.kind === "insert")!;
    expect((ins.payload!.flowaccount_account_code as string).length).toBeLessThanOrEqual(60);
  });

  it("ยังไม่มี mapping เดิม (cur=null) → insert ใหม่ พร้อม tenant/customer/code ถูกต้อง", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertAccountMap(db, TENANT, CUSTOMER, "4010", "SALE-01");
    expect(res).toEqual({ ok: true, id: "new-id" });
    expect(ops).toHaveLength(1);
    const ins = ops[0]!;
    expect(ins.kind).toBe("insert");
    expect(ins.table).toBe("flowaccount_account_map");
    expect(ins.payload).toEqual({
      tenant_id: TENANT,
      customer_id: CUSTOMER,
      account_code: "4010",
      flowaccount_account_code: "SALE-01",
    });
  });

  it("มี mapping เดิมอยู่แล้ว (unique tenant+customer+account_code) → update ทับแถวเดิม ไม่ insert ซ้ำ", async () => {
    const { db, ops } = makeDb({ flowaccount_account_map: { id: "existing-id" } });
    const res = await upsertAccountMap(db, TENANT, CUSTOMER, "4010", "SALE-02");
    expect(res).toEqual({ ok: true, id: "existing-id" });
    expect(ops).toHaveLength(1); // ★ ไม่มี insert เลย มีแค่ update
    expect(ops[0]!.kind).toBe("update");
    expect(ops[0]!.payload).toEqual({ flowaccount_account_code: "SALE-02" });
    expect(ops[0]!.filters.id).toBe("existing-id");
    expect(ops[0]!.filters.tenant_id).toBe(TENANT);
  });

  it("insert ชนกัน (23505 — race กับ unique index) → ข้อความสุภาพ", async () => {
    const { db } = makeDb({ "flowaccount_account_map:insertError": "23505" });
    const res = await upsertAccountMap(db, TENANT, CUSTOMER, "4010", "SALE-01");
    expect(res).toEqual({ ok: false, message: "รหัสบัญชีนี้ถูกตั้ง mapping ไว้แล้ว กรุณาลองใหม่" });
  });

  it("insert ล้มเหตุอื่น (ยังไม่ apply migration 0071) → ข้อความสุภาพ ไม่ throw", async () => {
    const { db } = makeDb({ "flowaccount_account_map:insertError": "42P01" });
    const res = await upsertAccountMap(db, TENANT, CUSTOMER, "4010", "SALE-01");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/0071/);
  });
});

describe("deleteAccountMap", () => {
  it("id ไม่ใช่ uuid → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, ops } = makeDb({});
    const res = await deleteAccountMap(db, TENANT, "not-a-uuid");
    expect(res).toEqual({ ok: false, message: "ไม่พบรายการที่เลือก" });
    expect(ops).toHaveLength(0);
  });

  it("สำเร็จ → delete scope tenant + id ถูกต้อง", async () => {
    const { db, ops } = makeDb({});
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const res = await deleteAccountMap(db, TENANT, id);
    expect(res).toEqual({ ok: true, id });
    const del = ops.find((o) => o.kind === "delete" && o.table === "flowaccount_account_map")!;
    expect(del.filters.id).toBe(id);
    expect(del.filters.tenant_id).toBe(TENANT);
  });

  it("DB error → ข้อความสุภาพ (ไม่ throw)", async () => {
    const { db } = makeDb({ "flowaccount_account_map:deleteError": { code: "500" } });
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const res = await deleteAccountMap(db, TENANT, id);
    expect(res).toEqual({ ok: false, message: "ลบ mapping ผังบัญชีไม่สำเร็จ กรุณาลองใหม่" });
  });
});

// ---------------------------------------------------------------------
// mapping สินค้า/บริการ
// ---------------------------------------------------------------------

describe("listProductMap", () => {
  it("ไม่มีข้อมูล/query error → [] (ไม่ throw)", async () => {
    const { db } = makeDb({});
    const res = await listProductMap(db, TENANT, CUSTOMER);
    expect(res).toEqual([]);
  });

  it("map แถวดิบ → ProductMapRow ถูกต้อง", async () => {
    const { db } = makeDb({
      "flowaccount_product_map:list": [{ id: "m1", product_id: PRODUCT, flowaccount_product_id: "555" }],
    });
    const res = await listProductMap(db, TENANT, CUSTOMER);
    expect(res).toEqual([{ id: "m1", productId: PRODUCT, flowaccountProductId: "555" }]);
  });
});

describe("upsertProductMap", () => {
  it("productId ไม่ใช่ uuid → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertProductMap(db, TENANT, CUSTOMER, "not-a-uuid", "999");
    expect(res).toEqual({ ok: false, message: "ไม่พบสินค้าที่เลือก" });
    expect(ops).toHaveLength(0);
  });

  it("flowaccountProductId ว่าง → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertProductMap(db, TENANT, CUSTOMER, PRODUCT, "   ");
    expect(res).toEqual({ ok: false, message: "กรุณาระบุรหัสสินค้าฝั่ง FlowAccount" });
    expect(ops).toHaveLength(0);
  });

  // ★ บั๊กที่พบใน code review เฟส 5 ส่วน Q: flowaccountProductId ต้องเป็นตัวเลขล้วนเท่านั้น
  //   (FlowAccount เก็บ product id เป็นตัวเลขเสมอ — Number(...) ตรงๆ ที่ buildLineItems ถ้าพิมพ์ผิดจะได้
  //   NaN แล้ว fallback เป็น id:0 เงียบๆ เหมือนไม่ได้ตั้ง mapping) → ต้องปฏิเสธตั้งแต่ตอนบันทึก ไม่ insert ลง DB
  it.each([
    ["มีตัวอักษรปน", "P-123"],
    ["ติดลบ", "-123"],
    ["ทศนิยม", "123.45"],
    ["มีช่องว่างคั่นกลาง", "1 2 3"],
    ["เป็นตัวอักษรล้วน", "abc"],
    ["0 เดี่ยวๆ (ชนกับค่า fallback ไม่มี mapping ใน buildLineItems)", "0"],
    ["มีเลขศูนย์นำหน้า", "0123"],
  ])("flowaccountProductId ไม่ใช่ตัวเลขล้วน (%s: %j) → ปฏิเสธด้วยข้อความชัดเจน ไม่แตะ DB", async (_label, bad) => {
    const { db, ops } = makeDb({});
    const res = await upsertProductMap(db, TENANT, CUSTOMER, PRODUCT, bad);
    expect(res).toEqual({
      ok: false,
      message: "รหัสสินค้าฝั่ง FlowAccount ต้องเป็นตัวเลข (เช่น 12345) เท่านั้น",
    });
    expect(ops).toHaveLength(0);
  });

  it.each(["1", "12345", "999999999"])(
    "flowaccountProductId เป็นตัวเลขจำนวนเต็มบวกล้วน (%s) → ผ่านปกติ",
    async (good) => {
      const { db, ops } = makeDb({});
      const res = await upsertProductMap(db, TENANT, CUSTOMER, PRODUCT, good);
      expect(res).toEqual({ ok: true, id: "new-id" });
      const ins = ops.find((o) => o.kind === "insert")!;
      expect(ins.payload!.flowaccount_product_id).toBe(good);
    }
  );

  it("customerId ไม่ใช่ uuid → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertProductMap(db, TENANT, "not-a-uuid", PRODUCT, "999");
    expect(res).toEqual({ ok: false, message: "ไม่พบลูกค้าที่เลือก" });
    expect(ops).toHaveLength(0);
  });

  it("ยังไม่มี mapping เดิม → insert ใหม่", async () => {
    const { db, ops } = makeDb({});
    const res = await upsertProductMap(db, TENANT, CUSTOMER, PRODUCT, "999");
    expect(res).toEqual({ ok: true, id: "new-id" });
    const ins = ops.find((o) => o.kind === "insert")!;
    expect(ins.payload).toEqual({
      tenant_id: TENANT,
      customer_id: CUSTOMER,
      product_id: PRODUCT,
      flowaccount_product_id: "999",
    });
  });

  it("มี mapping เดิมอยู่แล้ว → update ทับแถวเดิม ไม่ insert ซ้ำ", async () => {
    const { db, ops } = makeDb({ flowaccount_product_map: { id: "existing-id" } });
    const res = await upsertProductMap(db, TENANT, CUSTOMER, PRODUCT, "1000");
    expect(res).toEqual({ ok: true, id: "existing-id" });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("update");
    expect(ops[0]!.payload).toEqual({ flowaccount_product_id: "1000" });
  });

  it("insert ชนกัน (23505) → ข้อความสุภาพ", async () => {
    const { db } = makeDb({ "flowaccount_product_map:insertError": "23505" });
    const res = await upsertProductMap(db, TENANT, CUSTOMER, PRODUCT, "999");
    expect(res).toEqual({ ok: false, message: "สินค้านี้ถูกตั้ง mapping ไว้แล้ว กรุณาลองใหม่" });
  });
});

describe("deleteProductMap", () => {
  it("id ไม่ใช่ uuid → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, ops } = makeDb({});
    const res = await deleteProductMap(db, TENANT, "not-a-uuid");
    expect(res).toEqual({ ok: false, message: "ไม่พบรายการที่เลือก" });
    expect(ops).toHaveLength(0);
  });

  it("สำเร็จ → delete scope tenant + id ถูกต้อง", async () => {
    const { db, ops } = makeDb({});
    const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const res = await deleteProductMap(db, TENANT, id);
    expect(res).toEqual({ ok: true, id });
    const del = ops.find((o) => o.kind === "delete" && o.table === "flowaccount_product_map")!;
    expect(del.filters.id).toBe(id);
    expect(del.filters.tenant_id).toBe(TENANT);
  });
});
