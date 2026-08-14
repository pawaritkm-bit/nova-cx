import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listProducts,
  listProductsAdmin,
  searchProducts,
  validateProductInput,
  createProduct,
  updateProduct,
  setProductActive,
  softDeleteProduct,
  type Product,
} from "@/lib/accounting/products";

/**
 * สินค้า/บริการ (products) — เฟส 1 ส่วน B2 (docs/06-accounting-features-roadmap.md)
 *   เน้น: validate (ชื่อว่าง/ราคาติดลบ/sku ซ้ำ → ปฏิเสธ) + CRUD scope tenant + search (pure)
 */

type Op = { kind: string; table: string; payload?: Record<string, unknown>; filters: Record<string, unknown> };

/** mock DB: canned select ต่อ table + เก็บ update/insert/delete (เหมือน tests/accounting/actions-lib.test.ts) */
function makeDb(canned: Record<string, unknown>): { db: SupabaseClient; ops: Op[] } {
  const ops: Op[] = [];
  function qb(table: string) {
    const filters: Record<string, unknown> = {};
    let mode = "select";
    let payload: Record<string, unknown> = {};
    let insertErrorCode: string | undefined;
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
      insertErrorCode = canned[`${table}:insertError`] as string | undefined;
      return api;
    };
    api.maybeSingle = () => {
      if (mode === "insert") {
        ops.push({ kind: "insert", table, payload, filters });
        if (insertErrorCode) return Promise.resolve({ data: null, error: { code: insertErrorCode } });
        return Promise.resolve({ data: { id: "new-id" }, error: null });
      }
      return Promise.resolve({ data: canned[table] ?? null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let error: unknown = null;
      if (mode === "update") {
        ops.push({ kind: "update", table, payload, filters });
        error = canned[`${table}:updateError`] ?? null;
      }
      const data = mode === "select" ? canned[`${table}:list`] ?? [] : null;
      return Promise.resolve({ data, error }).then(onF);
    };
    return api;
  }
  return { db: { from: (t: string) => qb(t) } as unknown as SupabaseClient, ops };
}

describe("validateProductInput", () => {
  it("ชื่อว่าง → null (ปฏิเสธ)", () => {
    expect(validateProductInput({ name: "" })).toBeNull();
    expect(validateProductInput({ name: "   " })).toBeNull();
  });

  it("ราคาติดลบ → null (ปฏิเสธทั้ง input)", () => {
    expect(validateProductInput({ name: "สินค้า A", defaultPrice: -5 })).toBeNull();
    expect(validateProductInput({ name: "สินค้า A", defaultPrice: "-1" })).toBeNull();
  });

  it("ราคาไม่ใช่ตัวเลข → null (ปฏิเสธ)", () => {
    expect(validateProductInput({ name: "สินค้า A", defaultPrice: "abc" })).toBeNull();
  });

  it("ไม่กรอกราคา (ว่าง/undefined) → defaultPrice เป็น null (ไม่บังคับราคา)", () => {
    const v1 = validateProductInput({ name: "บริการ B" });
    expect(v1?.defaultPrice).toBeNull();
    const v2 = validateProductInput({ name: "บริการ B", defaultPrice: "" });
    expect(v2?.defaultPrice).toBeNull();
  });

  it("ผ่านครบ → คืนค่าที่ trim แล้ว + ปัดราคา 2 ตำแหน่ง", () => {
    const v = validateProductInput({
      sku: "  SKU-1  ",
      name: "  สินค้า A  ",
      unit: " ชิ้น ",
      defaultPrice: 199.999,
      defaultAccountCode: " 4010 ",
    });
    expect(v).toEqual({
      sku: "SKU-1",
      name: "สินค้า A",
      unit: "ชิ้น",
      defaultPrice: 200,
      defaultAccountCode: "4010",
      category: null,
      barcode: null,
      nameEn: null,
      price2: null,
      price3: null,
      price4: null,
      price5: null,
      defaultVatType: null,
      replacementProductId: null,
    });
  });

  it("sku/unit/defaultAccountCode ว่าง → เก็บเป็น null (optional)", () => {
    const v = validateProductInput({ name: "บริการ C" });
    expect(v).toEqual({
      sku: null,
      name: "บริการ C",
      unit: null,
      defaultPrice: null,
      defaultAccountCode: null,
      category: null,
      barcode: null,
      nameEn: null,
      price2: null,
      price3: null,
      price4: null,
      price5: null,
      defaultVatType: null,
      replacementProductId: null,
    });
  });

  it("★ [0112] barcode/ชื่ออังกฤษ ว่าง/กรอกมา → trim แล้วเก็บ หรือ null ถ้าว่าง", () => {
    const v1 = validateProductInput({ name: "สินค้า A", barcode: "  8850000000012  ", nameEn: "  Product A  " });
    expect(v1?.barcode).toBe("8850000000012");
    expect(v1?.nameEn).toBe("Product A");
    const v2 = validateProductInput({ name: "สินค้า A" });
    expect(v2?.barcode).toBeNull();
    expect(v2?.nameEn).toBeNull();
  });

  it("★ [0112] ราคาขาย 2-5: ไม่กรอก → null, กรอกแล้วติดลบ/ไม่ใช่ตัวเลข → ปฏิเสธทั้ง input", () => {
    const v = validateProductInput({ name: "สินค้า A", price2: 100, price3: "200.5", price4: "", price5: undefined });
    expect(v).toMatchObject({ price2: 100, price3: 200.5, price4: null, price5: null });
    expect(validateProductInput({ name: "สินค้า A", price2: -1 })).toBeNull();
    expect(validateProductInput({ name: "สินค้า A", price3: "abc" })).toBeNull();
  });

  it("★ [0112] defaultVatType: ว่าง → null, ค่าถูกต้อง → เก็บตรงตัว, ค่าอื่น → ปฏิเสธทั้ง input", () => {
    expect(validateProductInput({ name: "สินค้า A" })?.defaultVatType).toBeNull();
    expect(validateProductInput({ name: "สินค้า A", defaultVatType: "vat" })?.defaultVatType).toBe("vat");
    expect(validateProductInput({ name: "สินค้า A", defaultVatType: "novat" })?.defaultVatType).toBe("novat");
    expect(validateProductInput({ name: "สินค้า A", defaultVatType: "weird" })).toBeNull();
  });

  it("★ [0112] replacementProductId: ว่าง → null, uuid ถูกรูปแบบ → เก็บ, ผิดรูปแบบ → ปฏิเสธทั้ง input", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    expect(validateProductInput({ name: "สินค้า A" })?.replacementProductId).toBeNull();
    expect(validateProductInput({ name: "สินค้า A", replacementProductId: uuid })?.replacementProductId).toBe(uuid);
    expect(validateProductInput({ name: "สินค้า A", replacementProductId: "not-a-uuid" })).toBeNull();
  });

  it("★ [เฟส 8] กรอกหมวดสินค้ามาด้วย → เก็บ category ที่ trim แล้ว (0.10)", () => {
    const v = validateProductInput({ name: "สินค้า A", category: "  อุปกรณ์ไอที  " });
    expect(v?.category).toBe("อุปกรณ์ไอที");
  });

  it("★ [เฟส 8] ไม่กรอกหมวดสินค้า → category เป็น null (ไม่บังคับ, default ตอนแสดงรายงาน = 'สินค้า')", () => {
    const v = validateProductInput({ name: "สินค้า A" });
    expect(v?.category).toBeNull();
  });
});

describe("searchProducts — pure, ใช้ใน combobox", () => {
  const EXTRA = {
    barcode: null,
    nameEn: null,
    price2: null,
    price3: null,
    price4: null,
    price5: null,
    defaultVatType: null,
    replacementProductId: null,
  } as const;
  const list: Product[] = [
    { id: "p1", sku: "SKU-1", name: "ที่ปรึกษาบัญชี", unit: "ชม.", defaultPrice: 500, defaultAccountCode: "4010", category: null, ...EXTRA },
    { id: "p2", sku: "SKU-2", name: "จัดทำบัญชีรายเดือน", unit: "เดือน", defaultPrice: 3000, defaultAccountCode: null, category: null, ...EXTRA },
  ];

  it("q ว่าง → คืนทั้งหมด", () => {
    expect(searchProducts(list, "")).toEqual(list);
  });

  it("ค้นชื่อ (substring, ไม่สนตัวพิมพ์)", () => {
    expect(searchProducts(list, "บัญชีราย").map((p) => p.id)).toEqual(["p2"]);
  });

  it("ค้น sku", () => {
    expect(searchProducts(list, "sku-1").map((p) => p.id)).toEqual(["p1"]);
  });

  it("ไม่พบ → []", () => {
    expect(searchProducts(list, "ไม่มีจริง")).toEqual([]);
  });
});

describe("listProducts — เฉพาะที่ active (สำหรับ picker)", () => {
  it("query error/ไม่มีข้อมูล → คืน [] (ไม่ throw)", async () => {
    const { db } = makeDb({});
    const res = await listProducts(db, "t1");
    expect(res).toEqual([]);
  });

  it("map แถวดิบ → Product ถูกต้อง (รวม bank:false ไม่มีในสินค้า)", async () => {
    const { db } = makeDb({
      "products:list": [
        { id: "p1", sku: "SKU-1", name: "สินค้า A", unit: "ชิ้น", default_price: "150.50", default_account_code: "4010" },
      ],
    });
    const res = await listProducts(db, "t1");
    expect(res).toEqual([
      {
        id: "p1", sku: "SKU-1", name: "สินค้า A", unit: "ชิ้น", defaultPrice: 150.5, defaultAccountCode: "4010",
        category: null, barcode: null, nameEn: null, price2: null, price3: null, price4: null, price5: null,
        defaultVatType: null, replacementProductId: null,
      },
    ]);
  });

  it("★ [เฟส 8] map category ถูกต้อง (0.10)", async () => {
    const { db } = makeDb({
      "products:list": [
        { id: "p1", sku: "SKU-1", name: "สินค้า A", unit: "ชิ้น", default_price: "100", default_account_code: "4010", category: "อุปกรณ์ไอที" },
      ],
    });
    const res = await listProducts(db, "t1");
    expect(res[0].category).toBe("อุปกรณ์ไอที");
  });
});

describe("listProductsAdmin — รวม inactive", () => {
  it("map isActive ถูกต้อง", async () => {
    const { db } = makeDb({
      "products:list": [
        { id: "p1", sku: null, name: "สินค้า B", unit: null, default_price: null, default_account_code: null, is_active: false },
      ],
    });
    const res = await listProductsAdmin(db, "t1");
    expect(res).toEqual([
      {
        id: "p1", sku: null, name: "สินค้า B", unit: null, defaultPrice: null, defaultAccountCode: null,
        category: null, barcode: null, nameEn: null, price2: null, price3: null, price4: null, price5: null,
        defaultVatType: null, replacementProductId: null, isActive: false,
      },
    ]);
  });
});

describe("createProduct", () => {
  it("input ไม่ผ่าน validate → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, ops } = makeDb({});
    const res = await createProduct(db, "t1", { name: "" });
    expect(res).toEqual({ ok: false, message: "กรุณากรอกชื่อสินค้า/บริการ (และตรวจว่าราคาไม่ติดลบ)" });
    expect(ops).toHaveLength(0);
  });

  it("สำเร็จ → insert พร้อม tenant_id ถูกต้อง", async () => {
    const { db, ops } = makeDb({});
    const res = await createProduct(db, "t1", { name: "สินค้า A", defaultPrice: 100 });
    expect(res).toEqual({ ok: true, id: "new-id" });
    const ins = ops.find((o) => o.kind === "insert" && o.table === "products")!;
    expect(ins.payload!.tenant_id).toBe("t1");
    expect(ins.payload!.name).toBe("สินค้า A");
    expect(ins.payload!.default_price).toBe(100);
  });

  it("★ [เฟส 8] ส่งหมวดสินค้ามาด้วย → insert พร้อม category (0.10)", async () => {
    const { db, ops } = makeDb({});
    await createProduct(db, "t1", { name: "สินค้า A", category: "อุปกรณ์ไอที" });
    const ins = ops.find((o) => o.kind === "insert" && o.table === "products")!;
    expect(ins.payload!.category).toBe("อุปกรณ์ไอที");
  });

  it("sku ซ้ำ (DB unique constraint 23505) → ข้อความสุภาพ", async () => {
    const { db } = makeDb({ "products:insertError": "23505" });
    const res = await createProduct(db, "t1", { name: "สินค้า A", sku: "DUP" });
    expect(res).toEqual({ ok: false, message: "รหัสสินค้า (SKU) นี้มีอยู่แล้ว" });
  });

  it("★ [0112] สินค้าทดแทนไม่มีจริง/เป็นของ tenant อื่น → ปฏิเสธ ไม่ยิง insert (กัน IDOR)", async () => {
    const { db, ops } = makeDb({});
    const res = await createProduct(db, "t1", {
      name: "สินค้า A",
      replacementProductId: "22222222-2222-2222-2222-222222222222",
    });
    expect(res).toEqual({ ok: false, message: "ไม่พบสินค้าทดแทนที่เลือก" });
    expect(ops.find((o) => o.kind === "insert" && o.table === "products")).toBeUndefined();
  });

  it("★ [0112] สินค้าทดแทนมีจริงใน tenant เดียวกัน → ผ่าน + insert พร้อม replacement_product_id", async () => {
    const otherId = "22222222-2222-2222-2222-222222222222";
    const { db, ops } = makeDb({ products: { id: otherId } });
    const res = await createProduct(db, "t1", { name: "สินค้า A", replacementProductId: otherId });
    expect(res).toEqual({ ok: true, id: "new-id" });
    const ins = ops.find((o) => o.kind === "insert" && o.table === "products")!;
    expect(ins.payload!.replacement_product_id).toBe(otherId);
  });
});

describe("updateProduct", () => {
  it("input ไม่ผ่าน validate → ปฏิเสธ", async () => {
    const { db } = makeDb({});
    const res = await updateProduct(db, "t1", "p1", { name: "", defaultPrice: -1 });
    expect(res.ok).toBe(false);
  });

  it("สำเร็จ → update scope tenant + id ถูกต้อง", async () => {
    const { db, ops } = makeDb({});
    const res = await updateProduct(db, "t1", "p1", { name: "สินค้า A (แก้)" });
    expect(res).toEqual({ ok: true, id: "p1" });
    const upd = ops.find((o) => o.kind === "update" && o.table === "products")!;
    expect(upd.filters.tenant_id).toBe("t1");
    expect(upd.filters.id).toBe("p1");
    expect(upd.payload!.name).toBe("สินค้า A (แก้)");
  });

  it("sku ซ้ำ (DB unique constraint) → ข้อความสุภาพ", async () => {
    const { db } = makeDb({ "products:updateError": { code: "23505" } });
    const res = await updateProduct(db, "t1", "p1", { name: "สินค้า A", sku: "DUP" });
    expect(res).toEqual({ ok: false, message: "รหัสสินค้า (SKU) นี้มีอยู่แล้ว" });
  });

  it("★ [0112] เลือกสินค้าทดแทนเป็นตัวเอง → ปฏิเสธ ไม่ยิง update", async () => {
    const { db, ops } = makeDb({});
    const selfId = "11111111-1111-1111-1111-111111111111";
    const res = await updateProduct(db, "t1", selfId, { name: "สินค้า A", replacementProductId: selfId });
    expect(res.ok).toBe(false);
    expect(ops.find((o) => o.kind === "update" && o.table === "products")).toBeUndefined();
  });

  it("★ [0112] สินค้าทดแทนไม่มีจริง/เป็นของ tenant อื่น → ปฏิเสธ ไม่ยิง update (กัน IDOR)", async () => {
    const { db, ops } = makeDb({}); // ★ ไม่ canned "products" → replacementProductIsValid หา "ไม่พบ"
    const selfId = "11111111-1111-1111-1111-111111111111";
    const otherId = "22222222-2222-2222-2222-222222222222";
    const res = await updateProduct(db, "t1", selfId, { name: "สินค้า A", replacementProductId: otherId });
    expect(res).toEqual({ ok: false, message: "ไม่พบสินค้าทดแทนที่เลือก" });
    expect(ops.find((o) => o.kind === "update" && o.table === "products")).toBeUndefined();
  });

  it("★ [0112] เลือกสินค้าทดแทนเป็นตัวอื่นที่มีจริงใน tenant เดียวกัน → ผ่าน + เขียนคอลัมน์ใหม่ทั้งหมด", async () => {
    const otherId = "22222222-2222-2222-2222-222222222222";
    const { db, ops } = makeDb({ products: { id: otherId } }); // ★ จำลองว่าเจอสินค้าทดแทนใน tenant นี้จริง
    const selfId = "11111111-1111-1111-1111-111111111111";
    const res = await updateProduct(db, "t1", selfId, {
      name: "สินค้า A",
      barcode: "8850000000012",
      nameEn: "Product A",
      price2: 10,
      defaultVatType: "novat",
      replacementProductId: otherId,
    });
    expect(res).toEqual({ ok: true, id: selfId });
    const upd = ops.find((o) => o.kind === "update" && o.table === "products")!;
    expect(upd.payload).toMatchObject({
      barcode: "8850000000012",
      name_en: "Product A",
      price_2: 10,
      default_vat_type: "novat",
      replacement_product_id: otherId,
    });
  });
});

describe("setProductActive / softDeleteProduct", () => {
  it("setProductActive → update is_active scope tenant", async () => {
    const { db, ops } = makeDb({});
    const res = await setProductActive(db, "t1", "p1", false);
    expect(res).toEqual({ ok: true, id: "p1" });
    const upd = ops.find((o) => o.kind === "update" && o.table === "products")!;
    expect(upd.payload!.is_active).toBe(false);
    expect(upd.filters.tenant_id).toBe("t1");
  });

  it("softDeleteProduct → update deleted_at scope tenant", async () => {
    const { db, ops } = makeDb({});
    const res = await softDeleteProduct(db, "t1", "p1");
    expect(res).toEqual({ ok: true, id: "p1" });
    const upd = ops.find((o) => o.kind === "update" && o.table === "products")!;
    expect(upd.payload!.deleted_at).toBeTruthy();
    expect(upd.filters.tenant_id).toBe("t1");
  });

  it("DB error → ข้อความสุภาพ (ไม่ throw)", async () => {
    const { db } = makeDb({ "products:updateError": { code: "500" } });
    const res = await softDeleteProduct(db, "t1", "p1");
    expect(res).toEqual({ ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" });
  });
});
