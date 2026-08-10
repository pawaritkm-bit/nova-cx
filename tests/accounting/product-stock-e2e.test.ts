import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeStockLedger,
  buildStockCard,
  buildInventoryValuationReport,
  createMovementsFromBill,
  createManualAdjustment,
  softDeleteMovement,
  listMovements,
  getMovementScope,
  getProductOpeningBalance,
  upsertProductOpeningBalance,
  DEFAULT_PRODUCT_CATEGORY,
  type ProductLedgerInput,
} from "@/lib/accounting/product-stock";

/**
 * เทสต์ end-to-end เต็ม flow ของเฟส 8 (สต็อกสินค้าคงเหลือ + ต้นทุนถ่วงเฉลี่ยเคลื่อนที่ + เชื่อมกับบิลที่
 * ยืนยันแล้ว) — เพิ่มเติมต่อจาก tests/accounting/product-stock.test.ts (unit test ต่อฟังก์ชัน) โดยเน้น
 * "ครบวงจรจริงตั้งแต่ตั้งยอดยกมา → สร้างบิล → กด sync → เปิดบัตรสต็อก/รายงาน" ตาม
 * docs/06-accounting-features-roadmap.md หมวด "เฟส 8 — แผนละเอียด" § 4.2 (manual integration test checklist)
 * — จำลองผ่านชั้น data layer จริงทั้งหมด (ไม่ mock ฟังก์ชันคำนวณเลย) ต่างจาก
 * tests/accounting/stock-sync-actions.test.ts ที่ mock createMovementsFromBill ไว้ (เทสต์แค่ guard สโคป)
 *
 * ★ หมายเหตุ fake DB: ใช้ stateful in-memory fake สร้างในไฟล์นี้เอง (ไม่ใช้ tests/helpers/fake-supabase.ts
 *   กลาง) — mirror เหตุผลเดียวกับ tests/accounting/fixed-assets-e2e.test.ts: helper กลางเป็นแบบ resolver
 *   ไม่มี state ต่อแถว/ไม่รองรับ filter จริง ไม่พอสำหรับจำลอง flow ที่ query ข้ามหลายตาราง
 *   (bill_entries/bill_entry_lines/product_stock_movements/product_opening_balances) ต่อเนื่องในเทสต์เดียว
 *
 * ครอบคลุม:
 *   1) ยอดยกมา → บิลซื้อยืนยันแล้ว (มีบรรทัด product_id+quantity) → sync สต็อก → เปิดบัตรสต็อก → ยอด/ราคา
 *      เฉลี่ยถูกต้อง (reproduce ตัวอย่างจากแผนผ่าน flow เต็ม ไม่ใช่เรียก computeStockLedger ตรง ๆ)
 *   2) บิลขายยืนยันแล้ว (สินค้าเดียวกัน) → sync สต็อก → ยอดคงเหลือลดถูกต้อง
 *   3) sync ซ้ำจากบิลเดิม (กดปุ่มซ้ำ) → ไม่สร้าง movement ซ้ำสอง (ทั้งบิลซื้อ+ขาย)
 *   4) เปิดรายงานสินค้าคงเหลือแยกหมวด → ยอดตรงกับบัตรสต็อกรายตัว
 *   5) บันทึกปรับปรุงสต็อกมือ (adjustment) → เห็นผลในบัตรสต็อกถูกต้อง
 *   6) ยกเลิกรายการสต็อก (soft-delete movement) → ยอดกลับมาถูกต้อง
 *   7) edge case: บิลมีหลายบรรทัดสินค้าเดียวกัน, category เดียวกันหลายสินค้า, quantity ทศนิยม
 */

type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "is"; val: unknown };

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "eq") return row[f.col] === f.val;
    if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
    return row[f.col] === f.val;
  });
}

type Tables = {
  bill_entries: Row[];
  bill_entry_lines: Row[];
  product_stock_movements: Row[];
  product_opening_balances: Row[];
};

/** fake DB เดียวรองรับทั้ง 4 ตาราง — ให้เรียก createMovementsFromBill + data layer อื่นทั้งหมดใน flow เดียวกันได้จริง */
function makeFullFakeDb(): { db: SupabaseClient; tables: Tables } {
  const tables: Tables = {
    bill_entries: [],
    bill_entry_lines: [],
    product_stock_movements: [],
    product_opening_balances: [],
  };
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}-${seq++}`;
  // ★ created_at เพิ่มขึ้นทีละวินาทีตามลำดับ insert จริง — ให้ order/tiebreak deterministic
  let clockMs = Date.parse("2026-01-01T00:00:00.000Z");
  const nextCreatedAt = () => {
    clockMs += 1000;
    return new Date(clockMs).toISOString();
  };

  const ROW_DEFAULTS: Partial<Record<keyof Tables, Row>> = {
    bill_entries: { deleted_at: null, stock_synced_at: null },
    bill_entry_lines: {},
    product_stock_movements: { deleted_at: null, memo: null, source_bill_entry_line_id: null, unit_cost: null },
    product_opening_balances: { deleted_at: null, note: null },
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
        const row: Row = {
          id: nextId(table),
          created_at: nextCreatedAt(),
          ...(ROW_DEFAULTS[table] ?? {}),
          ...(payload as Row),
        };
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
        // รองรับ insert แบบ array (createMovementsFromBill สร้างหลาย movement พร้อมกัน 1 คำสั่ง)
        const items = Array.isArray(payload) ? payload : [payload];
        for (const p of items) {
          const row: Row = {
            id: nextId(table),
            created_at: nextCreatedAt(),
            ...(ROW_DEFAULTS[table] ?? {}),
            ...(p as Row),
          };
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
    ...overrides,
  });
  return id;
}

/** เปิดบัตรสต็อกจริงของสินค้า 1 ตัว (mirror ทุกขั้นที่ app/chat-audit/accounting/inventory/page.tsx ทำจริง) */
async function openStockCard(db: SupabaseClient, customerId: string, productId: string) {
  const opening = await getProductOpeningBalance(db, TENANT, customerId, productId);
  const movements = await listMovements(db, TENANT, customerId, productId);
  const ledger = computeStockLedger(opening, movements);
  return { opening, movements, ledger, card: buildStockCard(ledger) };
}

// =========================================================================
// 1-3) ยอดยกมา → บิลซื้อ → sync → บัตรสต็อก → บิลขาย → sync → บัตรสต็อก → sync ซ้ำ (0.7/0.8)
// =========================================================================
describe("E2E เฟส 8 — flow เต็ม: ยอดยกมา → บิลซื้อยืนยันแล้ว → sync สต็อก → บัตรสต็อก", () => {
  it("ตั้งยอดยกมา 100@65 → บิลซื้อยืนยันแล้ว (200@70) → กด sync → บัตรสต็อกแสดงคงเหลือ 300@68.333 ถูกต้อง (reproduce ตัวอย่างแผนผ่าน flow เต็ม ไม่เรียก computeStockLedger ตรง ๆ)", async () => {
    const { db, tables } = makeFullFakeDb();
    const productId = "prod-a";

    // ① ตั้งยอดยกมาสต็อก
    const openingRes = await upsertProductOpeningBalance(db, TENANT, CUSTOMER, productId, {
      quantity: 100,
      unitCost: 65,
      note: "ยกมาจากปีก่อน",
    });
    expect(openingRes.ok).toBe(true);

    // ② เปิดบัตรสต็อก ก่อนมีบิล — ต้องเห็นยอดยกมาถูกต้องทันที
    const before = await openStockCard(db, CUSTOMER, productId);
    expect(before.card).toHaveLength(1);
    expect(before.card[0]).toMatchObject({ docLabel: "ยอดยกมา", balanceQuantity: 100, balanceUnitCost: 65 });

    // ③ สร้างบิลซื้อยืนยันแล้ว มีบรรทัดผูก product_id+quantity ครบ (200 หน่วย มูลค่า 14000 = 70/หน่วย)
    const entryId = seedBillEntry(tables, { entry_type: "purchase", doc_date: "2026-01-10", doc_no: "PO-9001" });
    const lineId = seedBillLine(tables, entryId, { product_id: productId, quantity: 200, amount: 14000 });

    // ④ กดปุ่ม "บันทึกรับสต็อก"
    const syncRes = await createMovementsFromBill(db, TENANT, entryId);
    expect(syncRes.ok).toBe(true);
    if (!syncRes.ok) throw new Error("unreachable");
    expect(syncRes.created).toBe(1);
    expect(syncRes.skippedLineIds).toEqual([]);

    // ⑤ เปิดบัตรสต็อกอีกครั้ง — ต้องเห็นรายการรับใหม่ + ราคาเฉลี่ยเปลี่ยนถูกต้อง (68.333 ตามตัวอย่างในแผน)
    const afterPurchase = await openStockCard(db, CUSTOMER, productId);
    expect(afterPurchase.card).toHaveLength(2);
    expect(afterPurchase.card[1]).toMatchObject({
      docLabel: "ซื้อ",
      reference: "รับจากบิลซื้อ PO-9001",
      inQuantity: 200,
      inUnitCost: 70,
      inValue: 14000,
      balanceQuantity: 300,
      balanceUnitCost: 68.333,
      balanceValue: 20500,
      negativeWarning: false,
    });
    // movement ต้องอ้างอิงกลับไปที่บรรทัดบิลต้นทางจริง (สำหรับตรวจ 0.9 ทีหลัง)
    expect(afterPurchase.movements[0].sourceBillEntryLineId).toBe(lineId);
  });

  it("ต่อจากรับสต็อก → บิลขายยืนยันแล้ว (สินค้าเดียวกัน 50 หน่วย) → กด sync → ยอดคงเหลือลดถูกต้อง ราคาเฉลี่ยไม่เปลี่ยน (0.1)", async () => {
    const { db, tables } = makeFullFakeDb();
    const productId = "prod-a";
    await upsertProductOpeningBalance(db, TENANT, CUSTOMER, productId, { quantity: 100, unitCost: 65 });
    const purchaseEntry = seedBillEntry(tables, { entry_type: "purchase", doc_date: "2026-01-10" });
    seedBillLine(tables, purchaseEntry, { product_id: productId, quantity: 200, amount: 14000 });
    await createMovementsFromBill(db, TENANT, purchaseEntry);

    const saleEntry = seedBillEntry(tables, { entry_type: "sale", doc_date: "2026-01-15", doc_no: "INV-5001" });
    const saleLineId = seedBillLine(tables, saleEntry, { product_id: productId, quantity: 50, amount: 4000 });

    const syncRes = await createMovementsFromBill(db, TENANT, saleEntry);
    expect(syncRes.ok).toBe(true);
    if (!syncRes.ok) throw new Error("unreachable");
    expect(syncRes.created).toBe(1);

    const card = (await openStockCard(db, CUSTOMER, productId)).card;
    expect(card).toHaveLength(3);
    expect(card[2]).toMatchObject({
      docLabel: "ขาย",
      reference: "จ่ายจากบิลขาย INV-5001",
      outQuantity: 50,
      outUnitCost: 68.333, // ★ ตัดที่ราคาเฉลี่ยก่อนหน้า ไม่ใช่ราคาขายในบิล (0.1)
      outValue: 3416.67,
      balanceQuantity: 250,
      balanceUnitCost: 68.333, // ★ ราคาเฉลี่ยไม่เปลี่ยนตอนจ่ายออก
      balanceValue: 17083.33,
      negativeWarning: false,
    });
    const saleMovement = tables.product_stock_movements.find((m) => m.source_bill_entry_line_id === saleLineId)!;
    expect(saleMovement.unit_cost).toBeNull(); // OUT-type ไม่เก็บ unit_cost เอง (ใช้เฉลี่ยตอน replay)
  });

  it("★ 0.8 กด sync ซ้ำจากบิลเดิม (ทั้งบิลซื้อและบิลขาย) → ไม่สร้าง movement ซ้ำสอง — บัตรสต็อกยอดเท่าเดิม", async () => {
    const { db, tables } = makeFullFakeDb();
    const productId = "prod-a";
    const purchaseEntry = seedBillEntry(tables, { entry_type: "purchase" });
    seedBillLine(tables, purchaseEntry, { product_id: productId, quantity: 200, amount: 14000 });
    const saleEntry = seedBillEntry(tables, { entry_type: "sale", doc_date: "2026-01-15" });
    seedBillLine(tables, saleEntry, { product_id: productId, quantity: 50, amount: 4000 });

    await createMovementsFromBill(db, TENANT, purchaseEntry);
    await createMovementsFromBill(db, TENANT, saleEntry);
    const cardOnce = (await openStockCard(db, CUSTOMER, productId)).card;
    expect(cardOnce).toHaveLength(2);
    const balanceOnce = cardOnce[cardOnce.length - 1].balanceQuantity;

    // จำลองกดปุ่มซ้ำ (double-click) ทั้งสองบิล
    const repeatPurchase = await createMovementsFromBill(db, TENANT, purchaseEntry);
    const repeatSale = await createMovementsFromBill(db, TENANT, saleEntry);
    expect(repeatPurchase.ok).toBe(false);
    expect(repeatSale.ok).toBe(false);

    expect(tables.product_stock_movements).toHaveLength(2); // ไม่เพิ่มเลย
    const cardTwice = (await openStockCard(db, CUSTOMER, productId)).card;
    expect(cardTwice).toHaveLength(2);
    expect(cardTwice[cardTwice.length - 1].balanceQuantity).toBe(balanceOnce);
  });
});

// =========================================================================
// 4) รายงานสินค้าคงเหลือแยกหมวด → ยอดตรงกับบัตรสต็อกรายตัว
// =========================================================================
describe("E2E เฟส 8 — รายงานสินค้าคงเหลือแยกหมวด ต้องตรงกับบัตรสต็อกรายตัวเป๊ะ (0.10)", () => {
  it("2 สินค้าหมวดเดียวกัน + 1 สินค้าไม่มีหมวด → รวมยอดต่อหมวด/รวมทั้งสิ้น เท่ากับผลรวมบัตรสต็อกจริงของแต่ละตัว", async () => {
    const { db, tables } = makeFullFakeDb();

    // สินค้า A: หมวด "อุปกรณ์ไอที" — ยอดยกมา + บิลซื้อยืนยันแล้ว
    await upsertProductOpeningBalance(db, TENANT, CUSTOMER, "prod-a", { quantity: 10, unitCost: 100 });
    const entryA = seedBillEntry(tables, { entry_type: "purchase" });
    seedBillLine(tables, entryA, { product_id: "prod-a", quantity: 5, amount: 600 }); // 120/หน่วย
    await createMovementsFromBill(db, TENANT, entryA);

    // สินค้า B: หมวด "อุปกรณ์ไอที" เดียวกัน — เฉพาะยอดยกมา
    await upsertProductOpeningBalance(db, TENANT, CUSTOMER, "prod-b", { quantity: 20, unitCost: 50 });

    // สินค้า C: ไม่มีหมวด (default) — บิลขายเท่านั้น (ไม่มียอดยกมา)
    const entryC = seedBillEntry(tables, { entry_type: "purchase" });
    seedBillLine(tables, entryC, { product_id: "prod-c", quantity: 8, amount: 80 }); // 10/หน่วย
    await createMovementsFromBill(db, TENANT, entryC);

    const cardA = await openStockCard(db, CUSTOMER, "prod-a");
    const cardB = await openStockCard(db, CUSTOMER, "prod-b");
    const cardC = await openStockCard(db, CUSTOMER, "prod-c");

    const products: ProductLedgerInput[] = [
      { productId: "prod-a", productName: "จอคอมพิวเตอร์", category: "อุปกรณ์ไอที", ledgerRows: cardA.ledger },
      { productId: "prod-b", productName: "คีย์บอร์ด", category: "อุปกรณ์ไอที", ledgerRows: cardB.ledger },
      { productId: "prod-c", productName: "ปากกา", category: null, ledgerRows: cardC.ledger },
    ];
    const report = buildInventoryValuationReport(products);

    const lastA = cardA.card[cardA.card.length - 1];
    const lastB = cardB.card[cardB.card.length - 1];
    const lastC = cardC.card[cardC.card.length - 1];

    const itGroup = report.groups.find((g) => g.category === "อุปกรณ์ไอที")!;
    expect(itGroup.items.find((i) => i.productId === "prod-a")).toMatchObject({
      quantity: lastA.balanceQuantity,
      unitCost: lastA.balanceUnitCost,
      value: lastA.balanceValue,
    });
    expect(itGroup.items.find((i) => i.productId === "prod-b")).toMatchObject({
      quantity: lastB.balanceQuantity,
      unitCost: lastB.balanceUnitCost,
      value: lastB.balanceValue,
    });
    // ยอดรวมหมวด = ผลรวมบัตรสต็อกจริงของ A+B (ไม่ใช่ตัวเลขที่คำนวณแยกซ้ำ)
    expect(itGroup.totalValue).toBe(Math.round((lastA.balanceValue + lastB.balanceValue) * 100) / 100);

    const defaultGroup = report.groups.find((g) => g.category === DEFAULT_PRODUCT_CATEGORY)!;
    expect(defaultGroup.items[0]).toMatchObject({ quantity: lastC.balanceQuantity, value: lastC.balanceValue });

    expect(report.grandTotalValue).toBe(
      Math.round((lastA.balanceValue + lastB.balanceValue + lastC.balanceValue) * 100) / 100
    );
  });
});

// =========================================================================
// 5-6) ปรับปรุงสต็อกมือ + ยกเลิกรายการสต็อก (soft-delete) → ยอดกลับมาถูกต้อง
// =========================================================================
describe("E2E เฟส 8 — ปรับปรุงสต็อกมือ + ยกเลิกรายการสต็อก (0.9)", () => {
  it("บันทึกปรับปรุงลด (สินค้าเสียหาย) หลังรับสต็อกจากบิล → เห็นผลในบัตรสต็อกถูกต้องทันที (ราคาเฉลี่ยไม่เปลี่ยน)", async () => {
    const { db, tables } = makeFullFakeDb();
    const productId = "prod-a";
    const entry = seedBillEntry(tables, { entry_type: "purchase", doc_date: "2026-01-05" });
    seedBillLine(tables, entry, { product_id: productId, quantity: 100, amount: 10000 }); // 100/หน่วย
    await createMovementsFromBill(db, TENANT, entry);

    const adjRes = await createManualAdjustment(db, TENANT, CUSTOMER, productId, {
      movementType: "adjustment_out",
      quantity: 3,
      movementDate: "2026-01-06",
      memo: "สินค้าเสียหายจากการขนส่ง",
    });
    expect(adjRes.ok).toBe(true);

    const card = (await openStockCard(db, CUSTOMER, productId)).card;
    expect(card).toHaveLength(2);
    expect(card[1]).toMatchObject({
      docLabel: "ปรับปรุงลด",
      reference: "สินค้าเสียหายจากการขนส่ง",
      outQuantity: 3,
      outUnitCost: 100,
      balanceQuantity: 97,
      balanceUnitCost: 100,
    });
  });

  it("ยกเลิกรายการสต็อกที่มาจากบิล (soft-delete movement) → ยอดคงเหลือกลับไปเป็นก่อนมีรายการนั้นเป๊ะ (mirror flow แก้บิลแล้วต้องยกเลิก+สร้างใหม่, 0.9)", async () => {
    const { db, tables } = makeFullFakeDb();
    const productId = "prod-a";
    await upsertProductOpeningBalance(db, TENANT, CUSTOMER, productId, { quantity: 100, unitCost: 65 });
    const entry = seedBillEntry(tables, { entry_type: "purchase", doc_date: "2026-01-10" });
    seedBillLine(tables, entry, { product_id: productId, quantity: 200, amount: 14000 });
    await createMovementsFromBill(db, TENANT, entry);

    const beforeCancel = await openStockCard(db, CUSTOMER, productId);
    expect(beforeCancel.card).toHaveLength(2);
    const movementId = beforeCancel.movements[0].id;

    // ★ derive scope ก่อนลบ (0.13) — ต้องได้ customer/product ตรงกับที่สร้างจริง
    const scope = await getMovementScope(db, TENANT, movementId);
    expect(scope).toEqual({ customerId: CUSTOMER, productId });

    const cancelRes = await softDeleteMovement(db, TENANT, movementId);
    expect(cancelRes.ok).toBe(true);

    // ★ ยกเลิกแล้ว — บัตรสต็อกกลับไปเหลือแค่ยอดยกมา (100@65) เท่านั้น
    const afterCancel = await openStockCard(db, CUSTOMER, productId);
    expect(afterCancel.card).toHaveLength(1);
    expect(afterCancel.card[0]).toMatchObject({ docLabel: "ยอดยกมา", balanceQuantity: 100, balanceUnitCost: 65 });

    // getMovementScope หลังลบ → ต้องคืน null (ไม่เห็นรายการที่ถูกยกเลิกแล้วอีก)
    expect(await getMovementScope(db, TENANT, movementId)).toBeNull();

    // ★ บิลต้นทางยัง "claimed" อยู่ (stock_synced_at ไม่ถูกล้าง) — ต้องกด "ยกเลิกรายการสต็อก" ที่ movement
    //   เอง (ทำไปแล้วข้างบน) แต่ระบบไม่ auto-unclaim บิลให้ (0.9 — ไม่มี auto-sync ตาม)
    const billRow = tables.bill_entries.find((e) => e.id === entry)!;
    expect(billRow.stock_synced_at).toBeTruthy();
    // sync ซ้ำจากบิลเดิมตอนนี้จะยังถูกปฏิเสธ (claim ค้างอยู่) แม้ movement จริงถูกยกเลิกไปแล้ว — พฤติกรรม
    // ตามที่แผนออกแบบไว้ (0.9): นักบัญชีต้องรู้ว่าต้อง "แก้ไข claim" ไม่ได้ผ่านปุ่มเดิมซ้ำ — เป็น known
    // behavior ไม่ใช่บั๊ก แต่ทดสอบไว้กันความเข้าใจผิดของ QA/dev ในอนาคต
    const resyncRes = await createMovementsFromBill(db, TENANT, entry);
    expect(resyncRes.ok).toBe(false);
  });
});

// =========================================================================
// 7) edge cases เพิ่มเติมที่แผนอาจมองข้าม
// =========================================================================
describe("E2E เฟส 8 — edge cases เพิ่มเติม", () => {
  it("บิลซื้อ 1 ใบมี 2 บรรทัดผูก product_id เดียวกัน (คนละราคา/จำนวน) → สร้าง 2 movement แยกกัน รวมยอด+ถ่วงเฉลี่ยถูกต้อง", async () => {
    const { db, tables } = makeFullFakeDb();
    const productId = "prod-dup";
    const entry = seedBillEntry(tables, { entry_type: "purchase", doc_date: "2026-02-01" });
    seedBillLine(tables, entry, { product_id: productId, quantity: 10, amount: 1000 }); // 100/หน่วย
    seedBillLine(tables, entry, { product_id: productId, quantity: 5, amount: 300 }); // 60/หน่วย — บรรทัดที่ 2 สินค้าเดียวกันในบิลเดียวกัน

    const res = await createMovementsFromBill(db, TENANT, entry);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.created).toBe(2);

    const card = (await openStockCard(db, CUSTOMER, productId)).card;
    expect(card).toHaveLength(2);
    // แถวที่ 2 (ก้อนที่สอง): รวม 15 หน่วย มูลค่ารวม 1000+300=1300 → เฉลี่ย 86.667
    expect(card[1]).toMatchObject({ balanceQuantity: 15, balanceUnitCost: 86.667, balanceValue: 1300 });
  });

  it("quantity เป็นทศนิยม (1.5 กก.) — ซื้อแล้วขายต่อ → unit_cost/ต้นทุนเฉลี่ยคำนวณถูกต้องไม่มี rounding error สะสม", async () => {
    const { db, tables } = makeFullFakeDb();
    const productId = "prod-kg";
    const purchaseEntry = seedBillEntry(tables, { entry_type: "purchase", doc_date: "2026-03-01" });
    seedBillLine(tables, purchaseEntry, { product_id: productId, quantity: 1.5, amount: 225 }); // 150/กก.
    const purchaseRes = await createMovementsFromBill(db, TENANT, purchaseEntry);
    expect(purchaseRes.ok).toBe(true);

    const afterPurchase = (await openStockCard(db, CUSTOMER, productId)).card;
    expect(afterPurchase[0]).toMatchObject({ inQuantity: 1.5, inUnitCost: 150, balanceQuantity: 1.5, balanceUnitCost: 150 });

    const saleEntry = seedBillEntry(tables, { entry_type: "sale", doc_date: "2026-03-05" });
    seedBillLine(tables, saleEntry, { product_id: productId, quantity: 0.5, amount: 100 }); // ราคาขายไม่เกี่ยวกับต้นทุน
    const saleRes = await createMovementsFromBill(db, TENANT, saleEntry);
    expect(saleRes.ok).toBe(true);

    const afterSale = (await openStockCard(db, CUSTOMER, productId)).card;
    expect(afterSale[1]).toMatchObject({
      outQuantity: 0.5,
      outUnitCost: 150, // ตัดที่ราคาเฉลี่ยเดิม ไม่ใช่ราคาขาย 200/กก. ในบิล
      balanceQuantity: 1, // 1.5 - 0.5
      balanceUnitCost: 150,
      balanceValue: 150,
    });
  });

  it("บิลซื้อ quantity ทศนิยมที่หารไม่ลงตัว (amount/quantity มีเศษ) → unit_cost ปัด 3 ตำแหน่งถูกต้อง ไม่ throw/ไม่เป็น NaN", async () => {
    const { db, tables } = makeFullFakeDb();
    const productId = "prod-frac";
    const entry = seedBillEntry(tables, { entry_type: "purchase", doc_date: "2026-03-10" });
    seedBillLine(tables, entry, { product_id: productId, quantity: 3, amount: 100 }); // 33.333...

    const res = await createMovementsFromBill(db, TENANT, entry);
    expect(res.ok).toBe(true);
    const movement = tables.product_stock_movements[0];
    expect(movement.unit_cost).toBe(33.333);
    expect(Number.isFinite(movement.unit_cost as number)).toBe(true);
  });

  it("บิลที่ status='draft' (ยังไม่ยืนยัน) แต่มีบรรทัด product_id+quantity ครบ → createMovementsFromBill ปฏิเสธเสมอ (mirror เงื่อนไข confirmed ที่ RowActions.tsx ใช้โชว์ปุ่ม)", async () => {
    const { db, tables } = makeFullFakeDb();
    const entry = seedBillEntry(tables, { entry_type: "purchase", status: "draft", doc_date: "2026-03-15" });
    seedBillLine(tables, entry, { product_id: "prod-draft", quantity: 10, amount: 500 });

    const res = await createMovementsFromBill(db, TENANT, entry);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.message).toMatch(/ยืนยัน/);
    expect(tables.product_stock_movements).toHaveLength(0);
  });
});
