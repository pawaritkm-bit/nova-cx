import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMovementsFromBill, computeStockLedger, buildStockCard, listMovements, getProductOpeningBalance } from "@/lib/accounting/product-stock";

/**
 * เทสต์การผสาน "หลายหน่วยนับต่อสินค้า" (wishlist backlog ข้อ 2) เข้ากับ createMovementsFromBill
 *   ★★★ จุดสำคัญที่สุด: quantity ที่กรอกเป็นหน่วยอื่น (unit_id ตั้งไว้) ต้องถูกแปลงเป็น "หน่วยหลัก" ก่อน
 *   บันทึกลง product_stock_movements เสมอ — ไม่งั้นยอดคงเหลือ/ต้นทุนเฉลี่ยจะผิดทันทีที่มีหน่วยอื่นเข้ามาปน
 *
 * ★ หมายเหตุ fake DB: stateful in-memory (mirror tests/accounting/product-stock-e2e.test.ts) + เพิ่มตาราง
 *   product_units เพื่อให้ createMovementsFromBill เรียก getProductUnitFactors (bulk) ได้จริงในฟลว์เดียวกัน
 */

type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "is" | "in"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
    if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
    return row[f.col] === f.val;
  });
}

type Tables = {
  bill_entries: Row[];
  bill_entry_lines: Row[];
  product_stock_movements: Row[];
  product_opening_balances: Row[];
  warehouses: Row[];
  product_units: Row[];
};

function makeFakeDb(): { db: SupabaseClient; tables: Tables } {
  const tables: Tables = {
    bill_entries: [],
    bill_entry_lines: [],
    product_stock_movements: [],
    product_opening_balances: [],
    warehouses: [],
    product_units: [],
  };
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}-${seq++}`;
  let clockMs = Date.parse("2026-01-01T00:00:00.000Z");
  const nextCreatedAt = () => {
    clockMs += 1000;
    return new Date(clockMs).toISOString();
  };

  const ROW_DEFAULTS: Partial<Record<keyof Tables, Row>> = {
    bill_entries: { deleted_at: null, stock_synced_at: null },
    bill_entry_lines: { unit_id: null },
    product_stock_movements: { deleted_at: null, memo: null, source_bill_entry_line_id: null, unit_cost: null, warehouse_id: null },
    product_opening_balances: { deleted_at: null, note: null },
    warehouses: { deleted_at: null, is_default: false, is_active: true },
    product_units: { deleted_at: null },
  };

  function qb(table: keyof Tables) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: unknown;
    const orderCols: string[] = [];
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
    api.in = (c: string, v: unknown[]) => {
      filters.push({ col: c, op: "in", val: v });
      return api;
    };
    api.order = (c: string) => {
      orderCols.push(c);
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
      if (orderCols.length === 0) return rows;
      return [...rows].sort((a, b) => {
        for (const c of orderCols) {
          const av = String(a[c] ?? "");
          const bv = String(b[c] ?? "");
          if (av !== bv) return av < bv ? -1 : 1;
        }
        return 0;
      });
    }

    api.maybeSingle = () => {
      if (mode === "insert") {
        const row: Row = { id: nextId(table), created_at: nextCreatedAt(), ...(ROW_DEFAULTS[table] ?? {}), ...(payload as Row) };
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
      const error: unknown = null;
      if (mode === "insert") {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const p of items) {
          const row: Row = { id: nextId(table), created_at: nextCreatedAt(), ...(ROW_DEFAULTS[table] ?? {}), ...(p as Row) };
          tables[table].push(row);
        }
      } else if (mode === "update") {
        for (const row of tables[table]) if (matchRow(row, filters)) Object.assign(row, payload as Row);
      } else {
        data = applyOrder(tables[table].filter((r) => matchRow(r, filters))).map((r) => ({ ...r }));
      }
      return Promise.resolve({ data, error }).then(onF);
    };
    return api;
  }

  return { db: { from: (t: string) => qb(t as keyof Tables) } as unknown as SupabaseClient, tables };
}

const TENANT = "t1";
const CUSTOMER = "c1";

function seedBillEntry(tables: Tables, overrides: Partial<Row> = {}): string {
  const id = overrides.id ? String(overrides.id) : `entry-${tables.bill_entries.length + 1}`;
  tables.bill_entries.push({
    id,
    tenant_id: TENANT,
    customer_id: CUSTOMER,
    entry_type: "purchase",
    status: "confirmed",
    doc_date: "2026-01-05",
    doc_no: "PO-0001",
    deleted_at: null,
    stock_synced_at: null,
    ...overrides,
  });
  return id;
}

function seedBillLine(tables: Tables, entryId: string, overrides: Partial<Row> = {}): string {
  const id = overrides.id ? String(overrides.id) : `line-${tables.bill_entry_lines.length + 1}`;
  tables.bill_entry_lines.push({
    id,
    entry_id: entryId,
    tenant_id: TENANT,
    line_no: tables.bill_entry_lines.filter((l) => l.entry_id === entryId).length + 1,
    product_id: "prod-1",
    quantity: 10,
    amount: 1000,
    unit_id: null,
    ...overrides,
  });
  return id;
}

function seedUnit(tables: Tables, overrides: Partial<Row> = {}): string {
  const id = overrides.id ? String(overrides.id) : `unit-${tables.product_units.length + 1}`;
  tables.product_units.push({
    id,
    tenant_id: TENANT,
    product_id: "prod-1",
    unit_name: "โหล",
    factor_to_base: 12,
    deleted_at: null,
    ...overrides,
  });
  return id;
}

async function openStockCard(db: SupabaseClient, customerId: string, productId: string) {
  const opening = await getProductOpeningBalance(db, TENANT, customerId, productId);
  const movements = await listMovements(db, TENANT, customerId, productId);
  const ledger = computeStockLedger(opening, movements);
  return { movements, card: buildStockCard(ledger) };
}

describe("createMovementsFromBill — แปลงหน่วยนับก่อนบันทึกสต็อก (wishlist backlog ข้อ 2)", () => {
  it("★★★ บิลซื้อกรอกเป็น 'โหล' (factor=12, quantity=2) → movement.quantity ต้องเป็น 24 (หน่วยหลัก) ไม่ใช่ 2", async () => {
    const { db, tables } = makeFakeDb();
    const unitId = seedUnit(tables, { unit_name: "โหล", factor_to_base: 12 });
    const entry = seedBillEntry(tables);
    seedBillLine(tables, entry, { product_id: "prod-1", quantity: 2, amount: 2400, unit_id: unitId }); // 2 โหล = 24 ชิ้น, รวม 2400 บาท

    const res = await createMovementsFromBill(db, TENANT, entry);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.created).toBe(1);

    const movement = tables.product_stock_movements[0];
    expect(movement.quantity).toBe(24); // ★ แปลงแล้ว ไม่ใช่ 2 ดิบ ๆ
    expect(movement.unit_cost).toBe(100); // 2400 / 24 = 100/ชิ้น (ไม่ใช่ 2400/2=1200)

    const card = (await openStockCard(db, CUSTOMER, "prod-1")).card;
    expect(card[0]).toMatchObject({ inQuantity: 24, inUnitCost: 100, balanceQuantity: 24 });
  });

  it("unit_id=null (บิลเก่า/หน่วยหลัก) → quantity ไม่ถูกแปลง (factor=1) เหมือนพฤติกรรมเดิมก่อนฟีเจอร์นี้ 100%", async () => {
    const { db, tables } = makeFakeDb();
    const entry = seedBillEntry(tables);
    seedBillLine(tables, entry, { product_id: "prod-1", quantity: 10, amount: 1000, unit_id: null });

    const res = await createMovementsFromBill(db, TENANT, entry);
    expect(res.ok).toBe(true);
    expect(tables.product_stock_movements[0].quantity).toBe(10);
    expect(tables.product_stock_movements[0].unit_cost).toBe(100);
  });

  it("unit_id ชี้ไปยัง product_units ที่ถูกลบไปแล้ว (soft-deleted) → ยังแปลงด้วย factor เดิมได้ปกติ (getProductUnitFactors ไม่กรอง deleted_at ตั้งใจ)", async () => {
    const { db, tables } = makeFakeDb();
    const unitId = seedUnit(tables, { unit_name: "ลัง", factor_to_base: 24, deleted_at: "2026-01-01T00:00:00Z" });
    const entry = seedBillEntry(tables);
    seedBillLine(tables, entry, { product_id: "prod-1", quantity: 1, amount: 2400, unit_id: unitId });

    const res = await createMovementsFromBill(db, TENANT, entry);
    expect(res.ok).toBe(true);
    expect(tables.product_stock_movements[0].quantity).toBe(24);
  });

  it("unit_id ไม่พบเลย (ถูกส่งมาผิด/ไม่มีจริง) → fallback factor=1 (ไม่ throw ไม่ skip บรรทัด)", async () => {
    const { db, tables } = makeFakeDb();
    const entry = seedBillEntry(tables);
    seedBillLine(tables, entry, { product_id: "prod-1", quantity: 10, amount: 1000, unit_id: "unit-does-not-exist" });

    const res = await createMovementsFromBill(db, TENANT, entry);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.skippedLineIds).toEqual([]);
    expect(tables.product_stock_movements[0].quantity).toBe(10);
  });

  it("บิลขายกรอกเป็นหน่วยอื่น + ซื้อมาเป็นหน่วยหลัก → ตัดสต็อกถูกต้องข้ามหน่วย (สินค้าเดียวกัน คนละหน่วยกรอก)", async () => {
    const { db, tables } = makeFakeDb();
    const dozenId = seedUnit(tables, { unit_name: "โหล", factor_to_base: 12 });

    const purchaseEntry = seedBillEntry(tables, { entry_type: "purchase" });
    seedBillLine(tables, purchaseEntry, { product_id: "prod-1", quantity: 100, amount: 10000, unit_id: null }); // 100 ชิ้น @100
    await createMovementsFromBill(db, TENANT, purchaseEntry);

    const saleEntry = seedBillEntry(tables, { entry_type: "sale", doc_date: "2026-01-10" });
    seedBillLine(tables, saleEntry, { product_id: "prod-1", quantity: 1, amount: 1500, unit_id: dozenId }); // ขาย 1 โหล = 12 ชิ้น
    const saleRes = await createMovementsFromBill(db, TENANT, saleEntry);
    expect(saleRes.ok).toBe(true);

    const card = (await openStockCard(db, CUSTOMER, "prod-1")).card;
    expect(card[1]).toMatchObject({ outQuantity: 12, balanceQuantity: 88 }); // 100 - 12
  });
});
