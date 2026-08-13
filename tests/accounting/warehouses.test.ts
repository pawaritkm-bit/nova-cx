import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeWarehouseQuantities,
  validateWarehouseNameInput,
  listWarehouses,
  getWarehouseScope,
  getOrCreateDefaultWarehouse,
  createWarehouse,
  renameWarehouse,
  setWarehouseActive,
  createStockTransfer,
  type StockMovement,
  type OpeningBalance,
} from "@/lib/accounting/product-stock";

/**
 * เทสต์ lib/accounting/product-stock.ts ส่วนคลังสินค้า (wishlist ข้อ 8: คลังสินค้าหลายที่)
 *   ★★ จุดสำคัญที่สุด: computeWarehouseQuantities ต้องสรุปยอดรวมทุกคลังของสินค้าหนึ่งตัวเท่ากับยอดรวม
 *     ของ computeStockLedger เสมอ (ต้นทุนเฉลี่ยยัง global — ดู migration 0108) — และ transfer_out/in
 *     คู่กันไม่กระทบยอดรวม
 *   - validateWarehouseNameInput (pure)
 *   - CRUD data layer (fake DB in-memory — mirror pattern tests/accounting/product-stock.test.ts)
 *   - getOrCreateDefaultWarehouse (lazy provisioning, mirror getOrCreateFilingPeriod)
 *   - createStockTransfer (RPC atomic pair-insert, mirror set_bill_installment_plan test pattern)
 */

function mv(partial: Partial<StockMovement> & { movementType: StockMovement["movementType"]; quantity: number }): StockMovement {
  return {
    id: partial.id ?? `m-${Math.random()}`,
    tenantId: "t1",
    customerId: "c1",
    productId: "p1",
    movementType: partial.movementType,
    quantity: partial.quantity,
    unitCost: partial.unitCost ?? null,
    warehouseId: partial.warehouseId ?? null,
    sourceBillEntryLineId: partial.sourceBillEntryLineId ?? null,
    memo: partial.memo ?? null,
    movementDate: partial.movementDate ?? "2026-01-01",
    createdAt: partial.createdAt ?? `${partial.movementDate ?? "2026-01-01"}T00:00:00.000Z`,
  };
}

// =========================================================================
// computeWarehouseQuantities (pure)
// =========================================================================
describe("computeWarehouseQuantities", () => {
  it("ไม่มีคลัง/ยอดยกมา/รายการเลย → array ว่าง", () => {
    expect(computeWarehouseQuantities(null, null, [])).toEqual([]);
  });

  it("มีแค่ยอดยกมา → ยกไปที่ defaultWarehouseId ทั้งหมด (0.11 ไม่มีคอลัมน์คลังจริง)", () => {
    const opening: OpeningBalance = { quantity: 100, unitCost: 65, note: null };
    expect(computeWarehouseQuantities("wh-default", opening, [])).toEqual([{ warehouseId: "wh-default", quantity: 100 }]);
  });

  it("ไม่มี defaultWarehouseId (null) + มียอดยกมา → ไม่ทิ้งไปที่ไหนเลย (ไม่ throw)", () => {
    const opening: OpeningBalance = { quantity: 100, unitCost: 65, note: null };
    expect(computeWarehouseQuantities(null, opening, [])).toEqual([]);
  });

  it("รับเข้าคลัง A + จ่ายออกคลัง A → คงเหลือคลัง A ถูกต้อง", () => {
    const movements = [
      mv({ movementType: "purchase", quantity: 100, unitCost: 65, warehouseId: "A", movementDate: "2026-01-01" }),
      mv({ movementType: "sale", quantity: 30, warehouseId: "A", movementDate: "2026-01-02" }),
    ];
    expect(computeWarehouseQuantities(null, null, movements)).toEqual([{ warehouseId: "A", quantity: 70 }]);
  });

  it("movement ไม่มี warehouseId (แถวเก่าก่อน migration) → fallback ไปที่ defaultWarehouseId", () => {
    const movements = [mv({ movementType: "purchase", quantity: 50, unitCost: 10, warehouseId: null })];
    expect(computeWarehouseQuantities("wh-default", null, movements)).toEqual([{ warehouseId: "wh-default", quantity: 50 }]);
  });

  it("โอนคลัง A → B (transfer_out/transfer_in คู่กัน) → A ลด B เพิ่ม เท่ากัน ยอดรวมไม่เปลี่ยน", () => {
    const movements = [
      mv({ movementType: "purchase", quantity: 100, unitCost: 65, warehouseId: "A", movementDate: "2026-01-01" }),
      mv({ movementType: "transfer_out", quantity: 40, warehouseId: "A", movementDate: "2026-01-02" }),
      mv({ movementType: "transfer_in", quantity: 40, unitCost: 65, warehouseId: "B", movementDate: "2026-01-02" }),
    ];
    const rows = computeWarehouseQuantities(null, null, movements);
    const byId = Object.fromEntries(rows.map((r) => [r.warehouseId, r.quantity]));
    expect(byId).toEqual({ A: 60, B: 40 });
    expect(rows.reduce((s, r) => s + r.quantity, 0)).toBe(100); // ยอดรวมทุกคลังเท่ากับยอดรวมสินค้า (ไม่เปลี่ยนหลังโอน)
  });

  it("หลายคลัง หลายสินค้า (คลังเดียวกันปนกันหลาย movement) → รวมถูกต้องต่อคลัง", () => {
    const movements = [
      mv({ movementType: "purchase", quantity: 10, unitCost: 5, warehouseId: "A", movementDate: "2026-01-01" }),
      mv({ movementType: "purchase", quantity: 20, unitCost: 5, warehouseId: "B", movementDate: "2026-01-01" }),
      mv({ movementType: "adjustment_out", quantity: 3, warehouseId: "A", movementDate: "2026-01-02" }),
      mv({ movementType: "adjustment_in", quantity: 5, unitCost: 5, warehouseId: "B", movementDate: "2026-01-02" }),
    ];
    const rows = computeWarehouseQuantities(null, null, movements);
    const byId = Object.fromEntries(rows.map((r) => [r.warehouseId, r.quantity]));
    expect(byId).toEqual({ A: 7, B: 25 });
  });
});

// =========================================================================
// validateWarehouseNameInput (pure)
// =========================================================================
describe("validateWarehouseNameInput", () => {
  it("ชื่อว่าง/whitespace → ปฏิเสธ", () => {
    expect(validateWarehouseNameInput({ name: "" }).ok).toBe(false);
    expect(validateWarehouseNameInput({ name: "   " }).ok).toBe(false);
    expect(validateWarehouseNameInput({ name: undefined }).ok).toBe(false);
  });

  it("ชื่อถูกต้อง → trim + ok", () => {
    const res = validateWarehouseNameInput({ name: "  คลังสาขา 2  " });
    expect(res).toEqual({ ok: true, value: { name: "คลังสาขา 2" } });
  });

  it("ชื่อยาวเกิน 200 ตัวอักษร → ตัดที่ 200", () => {
    const res = validateWarehouseNameInput({ name: "ก".repeat(250) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.name).toHaveLength(200);
  });
});

// =========================================================================
// data layer (fake DB in-memory)
// =========================================================================
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "is"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "eq") return row[f.col] === f.val;
    if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
    return row[f.col] === f.val;
  });
}

type Tables = { warehouses: Row[]; product_stock_movements: Row[]; product_opening_balances: Row[] };

function makeFakeDb(): { db: SupabaseClient; tables: Tables } {
  const tables: Tables = { warehouses: [], product_stock_movements: [], product_opening_balances: [] };
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}-${seq++}`;
  let clockMs = Date.parse("2026-01-01T00:00:00.000Z");
  const nextCreatedAt = () => {
    clockMs += 1000;
    return new Date(clockMs).toISOString();
  };

  const ROW_DEFAULTS: Partial<Record<keyof Tables, Row>> = {
    warehouses: { deleted_at: null, is_default: false, is_active: true },
    product_stock_movements: { deleted_at: null, memo: null, source_bill_entry_line_id: null, unit_cost: null, warehouse_id: null },
    product_opening_balances: { deleted_at: null, note: null },
  };

  // ★ mirror unique index uq_warehouses_customer_name (migration 0108) — ชื่อซ้ำ (ไม่สนตัวพิมพ์) ในลูกค้า
  //   เดียวกัน (เฉพาะยังไม่ลบ) → error code 23505 (เหมือน postgres unique violation จริง)
  function violatesUniqueName(row: Row): boolean {
    return tables.warehouses.some(
      (r) =>
        r.deleted_at == null &&
        r.customer_id === row.customer_id &&
        r.id !== row.id &&
        String(r.name).toLowerCase() === String(row.name).toLowerCase()
    );
  }

  function qb(table: keyof Tables) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: unknown;
    const orderSpecs: { col: string; asc: boolean }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => {
      filters.push({ col: c, op: "eq", val: v });
      return api;
    };
    api.is = (c: string, v: unknown) => {
      filters.push({ col: c, op: "is", val: v });
      return api;
    };
    api.order = (c: string, o?: { ascending?: boolean }) => {
      orderSpecs.push({ col: c, asc: o?.ascending !== false });
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

    function applyOrder(rows: Row[]): Row[] {
      let out = rows;
      for (const spec of [...orderSpecs].reverse()) {
        out = [...out].sort((a, b) => {
          const av = a[spec.col] as string | number | boolean;
          const bv = b[spec.col] as string | number | boolean;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (spec.asc ? 1 : -1);
        });
      }
      return out;
    }

    api.maybeSingle = () => {
      if (mode === "insert") {
        const row: Row = { id: nextId(table), created_at: nextCreatedAt(), ...(ROW_DEFAULTS[table] ?? {}), ...(payload as Row) };
        if (table === "warehouses" && violatesUniqueName(row)) {
          return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } });
        }
        tables[table].push(row);
        return Promise.resolve({ data: { id: row.id }, error: null });
      }
      if (mode === "update") {
        const row = tables[table].find((r) => matchRow(r, filters));
        if (!row) return Promise.resolve({ data: null, error: null });
        Object.assign(row, payload as Row);
        return Promise.resolve({ data: { id: row.id }, error: null });
      }
      const row = tables[table].find((r) => matchRow(r, filters));
      return Promise.resolve({ data: row ? { ...row } : null, error: null });
    };

    api.then = (onF: (v: { data: unknown; error: unknown }) => unknown) => {
      let data: unknown = null;
      let error: unknown = null;
      if (mode === "insert") {
        const row: Row = { id: nextId(table), created_at: nextCreatedAt(), ...(ROW_DEFAULTS[table] ?? {}), ...(payload as Row) };
        if (table === "warehouses" && violatesUniqueName(row)) {
          error = { code: "23505", message: "duplicate" };
        } else {
          tables[table].push(row);
        }
      } else if (mode === "update") {
        const targets = tables[table].filter((r) => matchRow(r, filters));
        if (table === "warehouses" && targets.some((t) => violatesUniqueName({ ...t, ...(payload as Row) }))) {
          error = { code: "23505", message: "duplicate" };
        } else {
          for (const row of targets) Object.assign(row, payload as Row);
        }
      } else {
        data = applyOrder(tables[table].filter((r) => matchRow(r, filters))).map((r) => ({ ...r }));
      }
      return Promise.resolve({ data, error }).then(onF);
    };
    return api;
  }

  const db = {
    from: (t: string) => qb(t as keyof Tables),
    // ★ mirror RPC create_stock_transfer (migration 0108) — insert 2 แถว (out+in) ในทรานแซกชันเดียว
    rpc: (fn: string, params: Row) => {
      if (fn !== "create_stock_transfer") return Promise.resolve({ data: null, error: { message: "unknown rpc" } });
      const base = { deleted_at: null, memo: params.p_memo, source_bill_entry_line_id: null };
      tables.product_stock_movements.push({
        id: nextId("m"),
        created_at: nextCreatedAt(),
        ...base,
        tenant_id: params.p_tenant_id,
        customer_id: params.p_customer_id,
        product_id: params.p_product_id,
        warehouse_id: params.p_from_warehouse_id,
        movement_type: "transfer_out",
        quantity: params.p_quantity,
        unit_cost: null,
        movement_date: params.p_movement_date,
      });
      tables.product_stock_movements.push({
        id: nextId("m"),
        created_at: nextCreatedAt(),
        ...base,
        tenant_id: params.p_tenant_id,
        customer_id: params.p_customer_id,
        product_id: params.p_product_id,
        warehouse_id: params.p_to_warehouse_id,
        movement_type: "transfer_in",
        quantity: params.p_quantity,
        unit_cost: params.p_unit_cost,
        movement_date: params.p_movement_date,
      });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;

  return { db, tables };
}

const TENANT = "t1";
const CUSTOMER = "c1";
const PRODUCT = "p1";

describe("createWarehouse / renameWarehouse / listWarehouses", () => {
  it("สร้างคลังใหม่สำเร็จ → เห็นใน listWarehouses", async () => {
    const { db } = makeFakeDb();
    const res = await createWarehouse(db, TENANT, CUSTOMER, { name: "คลังสาขา 2" });
    expect(res.ok).toBe(true);

    const list = await listWarehouses(db, TENANT, CUSTOMER);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "คลังสาขา 2", isDefault: false, isActive: true });
  });

  it("ชื่อว่าง → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, tables } = makeFakeDb();
    const res = await createWarehouse(db, TENANT, CUSTOMER, { name: "  " });
    expect(res.ok).toBe(false);
    expect(tables.warehouses).toHaveLength(0);
  });

  it("ชื่อซ้ำในลูกค้าเดียวกัน (ไม่สนตัวพิมพ์) → ปฏิเสธด้วยข้อความเฉพาะ", async () => {
    const { db } = makeFakeDb();
    await createWarehouse(db, TENANT, CUSTOMER, { name: "คลังหลัก" });
    const res = await createWarehouse(db, TENANT, CUSTOMER, { name: "คลังหลัก" });
    expect(res).toEqual({ ok: false, message: "มีชื่อคลังนี้อยู่แล้ว" });
  });

  it("ชื่อซ้ำข้ามลูกค้า (ลูกค้าคนละราย) → ไม่ถือว่าซ้ำ", async () => {
    const { db } = makeFakeDb();
    await createWarehouse(db, TENANT, CUSTOMER, { name: "คลังหลัก" });
    const res = await createWarehouse(db, TENANT, "c-other", { name: "คลังหลัก" });
    expect(res.ok).toBe(true);
  });

  it("renameWarehouse สำเร็จ → เห็นชื่อใหม่", async () => {
    const { db } = makeFakeDb();
    const created = await createWarehouse(db, TENANT, CUSTOMER, { name: "คลัง A" });
    if (!created.ok) throw new Error("setup failed");
    const res = await renameWarehouse(db, TENANT, created.id, { name: "คลัง A ใหม่" });
    expect(res.ok).toBe(true);
    const list = await listWarehouses(db, TENANT, CUSTOMER);
    expect(list[0].name).toBe("คลัง A ใหม่");
  });

  it("renameWarehouse ชื่อซ้ำกับคลังอื่นของลูกค้าเดียวกัน → ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    await createWarehouse(db, TENANT, CUSTOMER, { name: "คลัง A" });
    const b = await createWarehouse(db, TENANT, CUSTOMER, { name: "คลัง B" });
    if (!b.ok) throw new Error("setup failed");
    const res = await renameWarehouse(db, TENANT, b.id, { name: "คลัง A" });
    expect(res).toEqual({ ok: false, message: "มีชื่อคลังนี้อยู่แล้ว" });
  });

  it("listWarehouses เรียงคลังหลักก่อนเสมอ แล้วเรียงชื่อ", async () => {
    const { db } = makeFakeDb();
    await createWarehouse(db, TENANT, CUSTOMER, { name: "คลัง Z" });
    await getOrCreateDefaultWarehouse(db, TENANT, CUSTOMER);
    await createWarehouse(db, TENANT, CUSTOMER, { name: "คลัง A" });
    const list = await listWarehouses(db, TENANT, CUSTOMER);
    expect(list.map((w) => w.name)).toEqual(["คลังหลัก", "คลัง A", "คลัง Z"]);
  });

  it("includeInactive=false (ค่าเริ่มต้น) → ไม่รวมคลังที่ปิดใช้งาน", async () => {
    const { db } = makeFakeDb();
    const created = await createWarehouse(db, TENANT, CUSTOMER, { name: "คลัง A" });
    if (!created.ok) throw new Error("setup failed");
    await setWarehouseActive(db, TENANT, created.id, false);
    expect(await listWarehouses(db, TENANT, CUSTOMER)).toHaveLength(0);
    expect(await listWarehouses(db, TENANT, CUSTOMER, { includeInactive: true })).toHaveLength(1);
  });
});

describe("getWarehouseScope", () => {
  it("คืน customerId/isDefault ของคลังที่มีอยู่จริง", async () => {
    const { db } = makeFakeDb();
    const created = await createWarehouse(db, TENANT, CUSTOMER, { name: "คลัง A" });
    if (!created.ok) throw new Error("setup failed");
    expect(await getWarehouseScope(db, TENANT, created.id)).toEqual({ customerId: CUSTOMER, isDefault: false });
  });

  it("ไม่พบ → คืน null", async () => {
    const { db } = makeFakeDb();
    expect(await getWarehouseScope(db, TENANT, "not-exist")).toBeNull();
  });
});

describe("getOrCreateDefaultWarehouse", () => {
  it("ยังไม่มีคลังหลัก → สร้างใหม่ชื่อ 'คลังหลัก'", async () => {
    const { db, tables } = makeFakeDb();
    const id = await getOrCreateDefaultWarehouse(db, TENANT, CUSTOMER);
    expect(id).toBeTruthy();
    expect(tables.warehouses).toHaveLength(1);
    expect(tables.warehouses[0]).toMatchObject({ name: "คลังหลัก", is_default: true, is_active: true });
  });

  it("เรียกซ้ำ 2 ครั้ง → ได้ id เดิม ไม่สร้างซ้ำสอง", async () => {
    const { db, tables } = makeFakeDb();
    const id1 = await getOrCreateDefaultWarehouse(db, TENANT, CUSTOMER);
    const id2 = await getOrCreateDefaultWarehouse(db, TENANT, CUSTOMER);
    expect(id1).toBe(id2);
    expect(tables.warehouses).toHaveLength(1);
  });

  it("ลูกค้าคนละรายกัน → ได้คลังหลักคนละคลัง", async () => {
    const { db } = makeFakeDb();
    const idA = await getOrCreateDefaultWarehouse(db, TENANT, CUSTOMER);
    const idB = await getOrCreateDefaultWarehouse(db, TENANT, "c-other");
    expect(idA).not.toBe(idB);
  });
});

describe("setWarehouseActive", () => {
  it("ปิดใช้งานคลังธรรมดา → สำเร็จ", async () => {
    const { db } = makeFakeDb();
    const created = await createWarehouse(db, TENANT, CUSTOMER, { name: "คลัง A" });
    if (!created.ok) throw new Error("setup failed");
    const res = await setWarehouseActive(db, TENANT, created.id, false);
    expect(res.ok).toBe(true);
  });

  it("ห้ามปิดใช้งานคลังหลัก", async () => {
    const { db } = makeFakeDb();
    const id = await getOrCreateDefaultWarehouse(db, TENANT, CUSTOMER);
    if (!id) throw new Error("setup failed");
    const res = await setWarehouseActive(db, TENANT, id, false);
    expect(res).toEqual({ ok: false, message: "ปิดใช้งานคลังหลักไม่ได้ (รายการจากบิลผูกคลังนี้เสมอ)" });
  });

  it("ไม่พบคลัง → ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    const res = await setWarehouseActive(db, TENANT, "not-exist", false);
    expect(res.ok).toBe(false);
  });
});

describe("createStockTransfer", () => {
  it("โอนสำเร็จ → สร้าง transfer_out+transfer_in คู่กัน unit_cost ฝั่ง in = ต้นทุนเฉลี่ยปัจจุบัน", async () => {
    const { db, tables } = makeFakeDb();
    const whA = await getOrCreateDefaultWarehouse(db, TENANT, CUSTOMER);
    const whB = await createWarehouse(db, TENANT, CUSTOMER, { name: "คลัง B" });
    if (!whA || !whB.ok) throw new Error("setup failed");

    // ยอดยกมา 100@65.000 → รับ 200@70.000 (เฉลี่ย 68.333 — ตัวอย่างเดียวกับ computeStockLedger)
    tables.product_opening_balances.push({
      id: "ob1", tenant_id: TENANT, customer_id: CUSTOMER, product_id: PRODUCT, quantity: 100, unit_cost: 65, note: null,
    });
    tables.product_stock_movements.push({
      id: "mv1", tenant_id: TENANT, customer_id: CUSTOMER, product_id: PRODUCT, movement_type: "purchase",
      quantity: 200, unit_cost: 70, warehouse_id: whA, movement_date: "2026-01-05", created_at: "2026-01-05T00:00:00Z",
    });

    const res = await createStockTransfer(db, TENANT, CUSTOMER, PRODUCT, {
      fromWarehouseId: whA,
      toWarehouseId: whB.id,
      quantity: 40,
      movementDate: "2026-01-06",
      memo: "โอนไปสาขา 2",
    });
    expect(res.ok).toBe(true);

    const created = tables.product_stock_movements.filter((m) => m.movement_date === "2026-01-06");
    expect(created).toHaveLength(2);
    const out = created.find((m) => m.movement_type === "transfer_out")!;
    const inn = created.find((m) => m.movement_type === "transfer_in")!;
    expect(out).toMatchObject({ warehouse_id: whA, quantity: 40, unit_cost: null });
    expect(inn).toMatchObject({ warehouse_id: whB.id, quantity: 40, unit_cost: 68.333 });
  });

  it("คลังต้นทาง/ปลายทางเดียวกัน → ปฏิเสธ ไม่เรียก RPC", async () => {
    const { db, tables } = makeFakeDb();
    const whA = await getOrCreateDefaultWarehouse(db, TENANT, CUSTOMER);
    if (!whA) throw new Error("setup failed");
    const res = await createStockTransfer(db, TENANT, CUSTOMER, PRODUCT, {
      fromWarehouseId: whA,
      toWarehouseId: whA,
      quantity: 10,
      movementDate: "2026-01-06",
    });
    expect(res).toEqual({ ok: false, message: "คลังต้นทางและปลายทางต้องไม่ใช่คลังเดียวกัน" });
    expect(tables.product_stock_movements).toHaveLength(0);
  });

  it("quantity<=0 → ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    const res = await createStockTransfer(db, TENANT, CUSTOMER, PRODUCT, {
      fromWarehouseId: "A",
      toWarehouseId: "B",
      quantity: 0,
      movementDate: "2026-01-06",
    });
    expect(res.ok).toBe(false);
  });

  it("วันที่ไม่ถูกต้อง → ปฏิเสธ", async () => {
    const { db } = makeFakeDb();
    const res = await createStockTransfer(db, TENANT, CUSTOMER, PRODUCT, {
      fromWarehouseId: "A",
      toWarehouseId: "B",
      quantity: 10,
      movementDate: "not-a-date",
    });
    expect(res.ok).toBe(false);
  });
});
