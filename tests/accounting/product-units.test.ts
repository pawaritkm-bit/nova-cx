import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validateProductUnitInput,
  convertQuantityToBase,
  listProductUnits,
  listProductUnitsForProducts,
  getProductUnitsByIds,
  getProductUnitFactors,
  getProductUnitScope,
  createProductUnit,
  updateProductUnit,
  softDeleteProductUnit,
} from "@/lib/accounting/product-units";

/**
 * product-units.ts — หลายหน่วยนับต่อสินค้า (wishlist backlog ข้อ 2)
 *   เน้น: validateProductUnitInput ทุก branch · convertQuantityToBase (pure) · data layer (mock DB) ·
 *   getProductUnitsByIds ต้องกรอง tenant_id (กัน client ส่ง unit_id ข้าม tenant) · softDelete ไม่ลบจริง
 */

// ---------------------------------------------------------------------
// validateProductUnitInput
// ---------------------------------------------------------------------
describe("validateProductUnitInput", () => {
  it("ชื่อ+ตัวคูณถูกต้อง → ผ่าน", () => {
    expect(validateProductUnitInput({ unitName: "โหล", factorToBase: 12 })).toEqual({
      unitName: "โหล",
      factorToBase: 12,
    });
  });

  it("ชื่อว่าง → ปฏิเสธ (null)", () => {
    expect(validateProductUnitInput({ unitName: "", factorToBase: 12 })).toBeNull();
    expect(validateProductUnitInput({ unitName: "   ", factorToBase: 12 })).toBeNull();
  });

  it("ตัวคูณ <= 0/ไม่ใช่ตัวเลข → ปฏิเสธ (null)", () => {
    expect(validateProductUnitInput({ unitName: "โหล", factorToBase: 0 })).toBeNull();
    expect(validateProductUnitInput({ unitName: "โหล", factorToBase: -5 })).toBeNull();
    expect(validateProductUnitInput({ unitName: "โหล", factorToBase: "abc" })).toBeNull();
  });

  it("ตัวคูณเกินเพดาน → ตัดที่เพดาน ไม่ปฏิเสธ", () => {
    const res = validateProductUnitInput({ unitName: "ลัง", factorToBase: 999_999_999 });
    expect(res?.factorToBase).toBe(100_000);
  });

  it("ชื่อเกินความยาว → ตัดตามเพดาน", () => {
    const res = validateProductUnitInput({ unitName: "x".repeat(100), factorToBase: 1 });
    expect(res?.unitName.length).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------
// convertQuantityToBase (pure)
// ---------------------------------------------------------------------
describe("convertQuantityToBase", () => {
  it("factor=1 (หน่วยหลัก) → ค่าเดิมไม่แปลง", () => {
    expect(convertQuantityToBase(5, 1)).toBe(5);
  });
  it("2 โหล (factor=12) → 24 ชิ้น", () => {
    expect(convertQuantityToBase(2, 12)).toBe(24);
  });
  it("ปัด 2 ตำแหน่งทศนิยม", () => {
    expect(convertQuantityToBase(1.333, 3)).toBe(4);
  });
});

// ---------------------------------------------------------------------
// data layer (mock DB)
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "in"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => (f.op === "eq" ? row[f.col] === f.val : (f.val as unknown[]).includes(row[f.col])));
}

function makeFakeDb(): { db: SupabaseClient; units: Row[] } {
  const units: Row[] = [];
  let nextId = 1;

  function qb(table: string) {
    if (table !== "product_units") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const noop: any = {};
      noop.select = () => noop;
      noop.eq = () => noop;
      noop.is = () => noop;
      noop.in = () => noop;
      noop.order = () => noop;
      noop.limit = () => noop;
      noop.maybeSingle = () => Promise.resolve({ data: null, error: null });
      noop.then = (onF: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onF);
      return noop;
    }
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: unknown = {};
    let orderCol: string | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      filters.push({ col: c, op: "eq", val: v });
      return api;
    };
    api.is = (c: string, v: unknown) => {
      filters.push({ col: c, op: "eq", val: v === null ? null : v });
      return api;
    };
    api.in = (c: string, v: unknown[]) => {
      filters.push({ col: c, op: "in", val: v });
      return api;
    };
    api.order = (c: string) => {
      orderCol = c;
      return api;
    };
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
    api.maybeSingle = () => {
      if (mode === "insert") {
        const row: Row = {
          id: `u${nextId++}`,
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-01T00:00:00Z",
          deleted_at: null,
          ...(payload as Row),
        };
        units.push(row);
        return Promise.resolve({ data: { id: row.id }, error: null });
      }
      if (mode === "update") {
        const row = units.find((r) => matchRow(r, filters));
        if (!row) return Promise.resolve({ data: null, error: null });
        Object.assign(row, payload as Row);
        return Promise.resolve({ data: { id: row.id }, error: null });
      }
      const row = units.find((r) => matchRow(r, filters));
      return Promise.resolve({ data: row ? { ...row } : null, error: null });
    };
    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      if (mode === "update") {
        for (const row of units) if (matchRow(row, filters)) Object.assign(row, payload as Row);
        return Promise.resolve({ data: null, error: null }).then(onF);
      }
      let rows = units.filter((r) => matchRow(r, filters));
      if (orderCol) rows = [...rows].sort((a, b) => String(a[orderCol as string]).localeCompare(String(b[orderCol as string])));
      return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(onF);
    };
    return api;
  }

  return { db: { from: (t: string) => qb(t) } as unknown as SupabaseClient, units };
}

function seedUnit(units: Row[], overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: `u${units.length + 1}`,
    tenant_id: "t1",
    product_id: "p1",
    unit_name: "โหล",
    factor_to_base: 12,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
  units.push(row);
  return row;
}

describe("createProductUnit / listProductUnits", () => {
  it("สร้างสำเร็จ + list กลับมาถูกต้อง", async () => {
    const { db } = makeFakeDb();
    const res = await createProductUnit(db, "t1", "p1", { unitName: "โหล", factorToBase: 12 });
    expect(res.ok).toBe(true);

    const list = await listProductUnits(db, "t1", "p1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ unitName: "โหล", factorToBase: 12, productId: "p1", tenantId: "t1" });
  });

  it("input ไม่ผ่าน validate → ปฏิเสธ ไม่ insert", async () => {
    const { db, units } = makeFakeDb();
    const res = await createProductUnit(db, "t1", "p1", { unitName: "", factorToBase: 12 });
    expect(res.ok).toBe(false);
    expect(units).toHaveLength(0);
  });

  it("ชื่อซ้ำในสินค้าเดียวกัน (unique constraint จำลอง code 23505) → ข้อความสุภาพ", async () => {
    const { db } = makeFakeDb();
    // จำลอง DB error 23505 โดยตรง (ไม่ผ่าน mock DB จริง — data layer แค่ map error code)
    const dbWithConflict = {
      from: () => ({
        insert: () => ({
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: { code: "23505" } }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    const res = await createProductUnit(dbWithConflict, "t1", "p1", { unitName: "โหล", factorToBase: 12 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toBe("สินค้านี้มีหน่วยนับชื่อนี้อยู่แล้ว");
  });
});

describe("listProductUnitsForProducts", () => {
  it("bulk หลายสินค้า → จัดกลุ่มตาม productId ถูกต้อง", async () => {
    const { db, units } = makeFakeDb();
    seedUnit(units, { id: "u1", product_id: "p1", unit_name: "โหล", factor_to_base: 12 });
    seedUnit(units, { id: "u2", product_id: "p1", unit_name: "ลัง", factor_to_base: 288 });
    seedUnit(units, { id: "u3", product_id: "p2", unit_name: "แพ็ค", factor_to_base: 6 });

    const map = await listProductUnitsForProducts(db, "t1", ["p1", "p2", "p3"]);
    expect(map.get("p1")).toHaveLength(2);
    expect(map.get("p2")).toHaveLength(1);
    expect(map.has("p3")).toBe(false);
  });

  it("productIds ว่าง → คืน map ว่างทันที (ไม่ query)", async () => {
    const { db } = makeFakeDb();
    const map = await listProductUnitsForProducts(db, "t1", []);
    expect(map.size).toBe(0);
  });
});

describe("getProductUnitsByIds / getProductUnitFactors", () => {
  it("★★★ กรอง tenant_id — unit_id ของ tenant อื่นไม่ติดมาแม้ id ตรง (กัน client ข้าม tenant ให้ตัวคูณผิด)", async () => {
    const { db, units } = makeFakeDb();
    seedUnit(units, { id: "u1", tenant_id: "t1", product_id: "p1", factor_to_base: 12 });
    seedUnit(units, { id: "u2", tenant_id: "t2", product_id: "px", factor_to_base: 999 });

    const map = await getProductUnitsByIds(db, "t1", ["u1", "u2"]);
    expect(map.has("u1")).toBe(true);
    expect(map.has("u2")).toBe(false); // ★ tenant t2 ไม่ควรติดมาเมื่อ query ด้วย tenant t1

    const factors = await getProductUnitFactors(db, "t1", ["u1", "u2"]);
    expect(factors.get("u1")).toBe(12);
    expect(factors.has("u2")).toBe(false);
  });

  it("unitIds ว่าง → คืน map ว่างทันที", async () => {
    const { db } = makeFakeDb();
    expect((await getProductUnitsByIds(db, "t1", [])).size).toBe(0);
    expect((await getProductUnitFactors(db, "t1", [])).size).toBe(0);
  });
});

describe("getProductUnitScope", () => {
  it("คืนสโคปถูกต้อง", async () => {
    const { db, units } = makeFakeDb();
    seedUnit(units, { id: "u1", product_id: "p1" });
    expect(await getProductUnitScope(db, "t1", "u1")).toEqual({ productId: "p1" });
  });
  it("ไม่พบ/ถูกลบแล้ว → null", async () => {
    const { db, units } = makeFakeDb();
    seedUnit(units, { id: "u1", product_id: "p1", deleted_at: "2026-08-01T00:00:00Z" });
    expect(await getProductUnitScope(db, "t1", "u1")).toBeNull();
    expect(await getProductUnitScope(db, "t1", "missing")).toBeNull();
  });
});

describe("updateProductUnit / softDeleteProductUnit", () => {
  it("แก้ไขได้ถูกต้อง", async () => {
    const { db, units } = makeFakeDb();
    const created = await createProductUnit(db, "t1", "p1", { unitName: "โหล", factorToBase: 12 });
    const id = created.ok ? created.id : "";
    const res = await updateProductUnit(db, "t1", id, { unitName: "ลัง", factorToBase: 24 });
    expect(res.ok).toBe(true);
    expect(units.find((u) => u.id === id)).toMatchObject({ unit_name: "ลัง", factor_to_base: 24 });
  });

  it("★ soft-delete ไม่ลบแถวจริง — แค่ตั้ง deleted_at", async () => {
    const { db, units } = makeFakeDb();
    const created = await createProductUnit(db, "t1", "p1", { unitName: "โหล", factorToBase: 12 });
    const id = created.ok ? created.id : "";
    const res = await softDeleteProductUnit(db, "t1", id);
    expect(res.ok).toBe(true);
    expect(units).toHaveLength(1);
    expect(units[0].deleted_at).toBeTruthy();
  });

  it("★ getProductUnitFactors ยังคืน factor เดิมให้ unit ที่ลบไปแล้ว (บิลเก่าที่อ้างถึงคำนวณสต็อกถูกต้องต่อไป)", async () => {
    const { db, units } = makeFakeDb();
    const created = await createProductUnit(db, "t1", "p1", { unitName: "โหล", factorToBase: 12 });
    const id = created.ok ? created.id : "";
    await softDeleteProductUnit(db, "t1", id);

    const factors = await getProductUnitFactors(db, "t1", [id]);
    expect(factors.get(id)).toBe(12);
  });
});
