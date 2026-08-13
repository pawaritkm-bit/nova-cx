import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  round3,
  isInMovementType,
  isOutMovementType,
  validateMovementInput,
  validateOpeningBalanceInput,
  computeStockLedger,
  buildStockCard,
  buildInventoryValuationReport,
  DEFAULT_PRODUCT_CATEGORY,
  listMovements,
  getMovementScope,
  createManualAdjustment,
  softDeleteMovement,
  listProductOpeningBalances,
  getProductOpeningBalance,
  upsertProductOpeningBalance,
  createMovementsFromBill,
  QTY_MAX,
  UNIT_COST_MAX,
  type StockMovement,
  type StockMovementType,
  type OpeningBalance,
  type ProductLedgerInput,
} from "@/lib/accounting/product-stock";

/**
 * เทสต์ lib/accounting/product-stock.ts (เฟส 8 ส่วน X, T75)
 *   ★★ จุดสำคัญที่สุด: reproduce ตัวอย่างบัตรสต็อกที่ผู้ใช้แนบมา (docs/06 หมวด 4.1) ให้ตรงเป๊ะทุกแถว —
 *     ยอดยกมา 100@65.000 → รับ 200@70.000 (คงเหลือ 300@68.333) → จ่าย 50 ที่ 68.333 (คงเหลือ 250@68.333 —
 *     ค่าเฉลี่ยไม่เปลี่ยนตอนจ่ายออก ตาม 0.1/T68 ที่ implementation ยึดไว้แล้ว)
 *   - validate ทุก branch (validateMovementInput/validateOpeningBalanceInput)
 *   - backdated entry → replay ใหม่ → ยอด/เฉลี่ยถูกต้องตามลำดับใหม่ (พิสูจน์ 0.5 ไม่มีบั๊ก cache)
 *   - สต็อกติดลบ → ไม่ throw มี flag เตือน (0.12)
 *   - buildStockCard/buildInventoryValuationReport (0.10)
 *   - CRUD data layer (fake DB in-memory — pattern เดียวกับ tests/accounting/recurring-journal.test.ts)
 */

function mv(partial: Partial<StockMovement> & { movementType: StockMovementType; quantity: number }): StockMovement {
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
// isInMovementType / isOutMovementType
// =========================================================================
describe("isInMovementType / isOutMovementType", () => {
  it("purchase/adjustment_in = รับเข้า", () => {
    expect(isInMovementType("purchase")).toBe(true);
    expect(isInMovementType("adjustment_in")).toBe(true);
    expect(isOutMovementType("purchase")).toBe(false);
  });
  it("sale/adjustment_out = จ่ายออก", () => {
    expect(isOutMovementType("sale")).toBe(true);
    expect(isOutMovementType("adjustment_out")).toBe(true);
    expect(isInMovementType("sale")).toBe(false);
  });
});

// =========================================================================
// ★★★ computeStockLedger — reproduce ตัวอย่างบัตรสต็อกจากแผน (docs/06 หมวด 4.1) ให้ตรงเป๊ะ
// =========================================================================
describe("computeStockLedger — ★ reproduce ตัวอย่างบัตรสต็อกจากแผนเป๊ะทุกแถว (docs/06 หมวด 4.1)", () => {
  it("ยอดยกมา 100@65.000 → รับ 200@70.000 (คงเหลือ 300@68.333) → จ่าย 50 ที่ 68.333 (เฉลี่ยไม่เปลี่ยนตอนจ่ายออก ตาม 0.1)", () => {
    const opening: OpeningBalance = { quantity: 100, unitCost: 65, note: null };
    const movements: StockMovement[] = [
      mv({ id: "m-in", movementType: "purchase", quantity: 200, unitCost: 70, movementDate: "2026-01-05" }),
      mv({ id: "m-out", movementType: "sale", quantity: 50, movementDate: "2026-01-10" }),
    ];

    const rows = computeStockLedger(opening, movements);
    expect(rows).toHaveLength(3);

    // แถวยอดยกมา — 100@65.000
    expect(rows[0]).toMatchObject({
      kind: "opening",
      balanceQuantity: 100,
      balanceUnitCost: 65,
      balanceValue: 6500,
      negativeWarning: false,
    });

    // แถวรับเข้า 200@70.000 → คงเหลือ 300@68.333 (เฉลี่ยใหม่: (100*65+200*70)/300 = 68.333)
    expect(rows[1]).toMatchObject({
      kind: "movement",
      movementType: "purchase",
      inQuantity: 200,
      inUnitCost: 70,
      inValue: 14000,
      balanceQuantity: 300,
      balanceUnitCost: 68.333,
      balanceValue: 20500,
      negativeWarning: false,
    });

    // แถวจ่ายออก 50 ที่ต้นทุนเฉลี่ยก่อนหน้า (68.333) — เฉลี่ยคงเหลือไม่เปลี่ยน (ยังคง 68.333)
    expect(rows[2]).toMatchObject({
      kind: "movement",
      movementType: "sale",
      outQuantity: 50,
      outUnitCost: 68.333,
      outValue: 3416.67,
      balanceQuantity: 250,
      balanceUnitCost: 68.333,
      balanceValue: 17083.33,
      negativeWarning: false,
    });
  });

  it("รับหลายรอบราคาต่างกัน → ราคาเฉลี่ยเปลี่ยนถูกต้องตามสูตรทุกครั้งที่รับเข้า (ไม่มียอดยกมา)", () => {
    const movements: StockMovement[] = [
      mv({ movementType: "purchase", quantity: 10, unitCost: 100, movementDate: "2026-01-01" }),
      mv({ movementType: "purchase", quantity: 10, unitCost: 200, movementDate: "2026-01-02" }),
    ];
    const rows = computeStockLedger(null, movements);
    // รอบแรก: 10@100 → เฉลี่ย 100
    expect(rows[0]).toMatchObject({ balanceQuantity: 10, balanceUnitCost: 100, balanceValue: 1000 });
    // รอบสอง: (1000+2000)/20 = 150
    expect(rows[1]).toMatchObject({ balanceQuantity: 20, balanceUnitCost: 150, balanceValue: 3000 });
  });

  it("ไม่มียอดยกมา (opening=null) → ไม่มีแถว 'opening'", () => {
    const rows = computeStockLedger(null, [mv({ movementType: "purchase", quantity: 5, unitCost: 10 })]);
    expect(rows.every((r) => r.kind !== "opening")).toBe(true);
    expect(rows).toHaveLength(1);
  });
});

// =========================================================================
// backdated entry — แทรกรายการย้อนหลัง → replay ใหม่ → ยอด/เฉลี่ยถูกต้องตามลำดับใหม่ (0.5)
// =========================================================================
describe("computeStockLedger — backdated entry (0.5, กันบั๊ก cache)", () => {
  it("แทรกรายการซื้อย้อนหลังก่อนรายการที่มีอยู่แล้ว → replay ใหม่ทั้งหมด → เฉลี่ย/คงเหลือของรายการที่ตามมาเปลี่ยนถูกต้อง", () => {
    const a = mv({ id: "a", movementType: "purchase", quantity: 100, unitCost: 10, movementDate: "2026-02-01" });
    const b = mv({ id: "b", movementType: "sale", quantity: 30, movementDate: "2026-03-01" });

    // ก่อนแทรก backdated — a→เฉลี่ย 10, b→ตัดที่ 10
    const before = computeStockLedger(null, [a, b]);
    expect(before[0]).toMatchObject({ balanceQuantity: 100, balanceUnitCost: 10, balanceValue: 1000 });
    expect(before[1]).toMatchObject({ outUnitCost: 10, outValue: 300, balanceQuantity: 70, balanceUnitCost: 10, balanceValue: 700 });

    // แทรกรายการย้อนหลัง c (ซื้อ 50@20 วันที่ 2026-01-01 — มาก่อน a) → ผลลัพธ์ของ a/b ต้องเปลี่ยนตามลำดับใหม่
    const c = mv({ id: "c", movementType: "purchase", quantity: 50, unitCost: 20, movementDate: "2026-01-01" });
    const after = computeStockLedger(null, [a, b, c]); // ส่งลำดับสลับเข้าไปด้วย — ต้อง sort เองตาม movementDate
    expect(after).toHaveLength(3);

    // c ต้องถูกจัดให้อยู่แถวแรก (วันที่เก่าสุด)
    expect(after[0]).toMatchObject({ movementId: "c", balanceQuantity: 50, balanceUnitCost: 20, balanceValue: 1000 });
    // a (200 → 150 รวม, เฉลี่ยใหม่ (1000+1000)/150 = 13.333)
    expect(after[1]).toMatchObject({ movementId: "a", balanceQuantity: 150, balanceUnitCost: 13.333, balanceValue: 2000 });
    // b ตัดที่เฉลี่ยใหม่ 13.333 (ไม่ใช่ 10 เหมือนก่อนแทรก) — พิสูจน์ replay ใหม่ทั้งหมด ไม่ใช่ patch เฉพาะจุด
    expect(after[2]).toMatchObject({
      movementId: "b",
      outUnitCost: 13.333,
      outValue: 400,
      balanceQuantity: 120,
      balanceUnitCost: 13.333,
      balanceValue: 1600,
    });
  });

  it("movement_date ชนกัน (วันเดียวกัน) → ใช้ created_at เป็น tiebreak เสมอ (deterministic)", () => {
    const first = mv({ id: "first", movementType: "purchase", quantity: 10, unitCost: 10, movementDate: "2026-01-01", createdAt: "2026-01-01T08:00:00.000Z" });
    const second = mv({ id: "second", movementType: "purchase", quantity: 10, unitCost: 20, movementDate: "2026-01-01", createdAt: "2026-01-01T09:00:00.000Z" });
    // ส่งลำดับสลับเข้าไป — ผลต้องเรียงตาม created_at เสมอ (first ก่อน second)
    const rows = computeStockLedger(null, [second, first]);
    expect(rows[0].movementId).toBe("first");
    expect(rows[1].movementId).toBe("second");
    // first: 10@10 → เฉลี่ย 10 · second: รวม 20 หน่วย value=100+200=300 → เฉลี่ย 15
    expect(rows[0]).toMatchObject({ balanceQuantity: 10, balanceUnitCost: 10 });
    expect(rows[1]).toMatchObject({ balanceQuantity: 20, balanceUnitCost: 15 });
  });
});

// =========================================================================
// สต็อกติดลบ (0.12) — ไม่ throw, มี flag เตือน
// =========================================================================
describe("computeStockLedger — สต็อกติดลบ (0.12)", () => {
  it("จ่ายมากกว่าที่มี → ไม่ throw, balanceQuantity ติดลบ, negativeWarning=true", () => {
    const movements: StockMovement[] = [
      mv({ movementType: "purchase", quantity: 10, unitCost: 5, movementDate: "2026-01-01" }),
      mv({ movementType: "sale", quantity: 15, movementDate: "2026-01-02" }),
    ];
    expect(() => computeStockLedger(null, movements)).not.toThrow();
    const rows = computeStockLedger(null, movements);
    expect(rows[1]).toMatchObject({ balanceQuantity: -5, negativeWarning: true });
    // ต้นทุนเฉลี่ย/มูลค่าคงเหลือยังคำนวณต่อได้ตามสูตร (ไม่ throw/ไม่เป็น NaN)
    expect(rows[1].balanceUnitCost).toBe(5);
    expect(Number.isFinite(rows[1].balanceValue)).toBe(true);
  });

  it("ยอดยกมาติดลบ (0.12 อนุญาต) → negativeWarning=true ตั้งแต่แถวยอดยกมา", () => {
    const rows = computeStockLedger({ quantity: -10, unitCost: 5, note: null }, []);
    expect(rows[0]).toMatchObject({ balanceQuantity: -10, negativeWarning: true });
  });

  it("คงเหลือกลับมาเป็นบวกอีกครั้งหลังรับเข้าเพิ่ม → negativeWarning=false", () => {
    const movements: StockMovement[] = [
      mv({ movementType: "purchase", quantity: 10, unitCost: 5, movementDate: "2026-01-01" }),
      mv({ movementType: "sale", quantity: 15, movementDate: "2026-01-02" }),
      mv({ movementType: "purchase", quantity: 20, unitCost: 5, movementDate: "2026-01-03" }),
    ];
    const rows = computeStockLedger(null, movements);
    expect(rows[2]).toMatchObject({ balanceQuantity: 15, negativeWarning: false });
  });
});

// =========================================================================
// buildStockCard (0.10)
// =========================================================================
describe("buildStockCard", () => {
  it("แปลงผล ledger เป็นแถวบัตรสต็อก — label ตรงตามประเภท + คงข้อมูลครบ", () => {
    const opening: OpeningBalance = { quantity: 100, unitCost: 65, note: "ยกมาจากปีก่อน" };
    const movements: StockMovement[] = [
      mv({ movementType: "purchase", quantity: 200, unitCost: 70, movementDate: "2026-01-05", memo: "บิลซื้อ #1" }),
      mv({ movementType: "sale", quantity: 50, movementDate: "2026-01-10", memo: "บิลขาย #9" }),
      mv({ movementType: "adjustment_in", quantity: 5, unitCost: 70, movementDate: "2026-01-11", memo: "นับสต็อกจริงเกิน" }),
      mv({ movementType: "adjustment_out", quantity: 2, movementDate: "2026-01-12", memo: "สินค้าเสียหาย" }),
    ];
    const ledger = computeStockLedger(opening, movements);
    const card = buildStockCard(ledger);

    expect(card).toHaveLength(5);
    expect(card[0]).toMatchObject({ date: "", docLabel: "ยอดยกมา", reference: "ยกมาจากปีก่อน" });
    expect(card[1]).toMatchObject({ date: "2026-01-05", docLabel: "ซื้อ", reference: "บิลซื้อ #1", inQuantity: 200 });
    expect(card[2]).toMatchObject({ date: "2026-01-10", docLabel: "ขาย", reference: "บิลขาย #9", outQuantity: 50 });
    expect(card[3]).toMatchObject({ date: "2026-01-11", docLabel: "ปรับปรุงเพิ่ม", reference: "นับสต็อกจริงเกิน", inQuantity: 5 });
    expect(card[4]).toMatchObject({ date: "2026-01-12", docLabel: "ปรับปรุงลด", reference: "สินค้าเสียหาย", outQuantity: 2 });
  });
});

// =========================================================================
// buildInventoryValuationReport (0.10)
// =========================================================================
describe("buildInventoryValuationReport", () => {
  function ledgerFor(qty: number, cost: number): ProductLedgerInput["ledgerRows"] {
    return computeStockLedger({ quantity: qty, unitCost: cost, note: null }, []);
  }

  it("จัดกลุ่มตาม category ถูกต้อง + สินค้าไม่มี category → เข้ากลุ่ม default 'สินค้า' + รวมยอดต่อหมวด/รวมทั้งสิ้นถูกต้อง", () => {
    const products: ProductLedgerInput[] = [
      { productId: "p1", productName: "จอคอมพิวเตอร์", category: "อุปกรณ์ไอที", ledgerRows: ledgerFor(10, 100) }, // 1000
      { productId: "p2", productName: "คีย์บอร์ด", category: "อุปกรณ์ไอที", ledgerRows: ledgerFor(5, 50) }, // 250
      { productId: "p3", productName: "ปากกา", category: null, ledgerRows: ledgerFor(20, 5) }, // 100 → default
      { productId: "p4", productName: "สินค้าไม่มีหมวด (ว่าง)", category: "   ", ledgerRows: ledgerFor(1, 10) }, // 10 → default (whitespace ล้วน)
    ];

    const report = buildInventoryValuationReport(products);
    expect(report.groups).toHaveLength(2);

    const itGroup = report.groups.find((g) => g.category === "อุปกรณ์ไอที")!;
    expect(itGroup.items).toHaveLength(2);
    expect(itGroup.totalValue).toBe(1250);

    const defaultGroup = report.groups.find((g) => g.category === DEFAULT_PRODUCT_CATEGORY)!;
    expect(defaultGroup.category).toBe("สินค้า");
    expect(defaultGroup.items).toHaveLength(2);
    expect(defaultGroup.totalValue).toBe(110);

    expect(report.grandTotalValue).toBe(1360);
  });

  it("สินค้าไม่มี movement/opening เลย (ledgerRows=[]) → ยอด 0 ไม่ throw", () => {
    const products: ProductLedgerInput[] = [{ productId: "p1", productName: "สินค้าใหม่", category: null, ledgerRows: [] }];
    const report = buildInventoryValuationReport(products);
    expect(report.groups[0].items[0]).toMatchObject({ quantity: 0, unitCost: 0, value: 0, negativeWarning: false });
    expect(report.grandTotalValue).toBe(0);
  });

  it("สินค้าที่คงเหลือติดลบ → negativeWarning=true ถูกส่งต่อมาจากแถวสุดท้ายของ ledger", () => {
    const rows = computeStockLedger(null, [
      mv({ movementType: "sale", quantity: 5, movementDate: "2026-01-01" }),
    ]);
    const products: ProductLedgerInput[] = [{ productId: "p1", productName: "สินค้าติดลบ", category: null, ledgerRows: rows }];
    const report = buildInventoryValuationReport(products);
    expect(report.groups[0].items[0].negativeWarning).toBe(true);
  });
});

// =========================================================================
// validateMovementInput
// =========================================================================
describe("validateMovementInput", () => {
  const base = { movementType: "purchase", quantity: 10, unitCost: 100, movementDate: "2026-01-01", memo: "ทดสอบ" };

  it("input ถูกต้องครบถ้วน → ผ่าน", () => {
    const res = validateMovementInput(base);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        movementType: "purchase",
        quantity: 10,
        unitCost: 100,
        movementDate: "2026-01-01",
        memo: "ทดสอบ",
      });
    }
  });

  it("movementType ไม่รู้จัก → ปฏิเสธ", () => {
    expect(validateMovementInput({ ...base, movementType: "transfer" }).ok).toBe(false);
    expect(validateMovementInput({ ...base, movementType: undefined }).ok).toBe(false);
  });

  it("quantity <= 0 → ปฏิเสธ", () => {
    expect(validateMovementInput({ ...base, quantity: 0 }).ok).toBe(false);
    expect(validateMovementInput({ ...base, quantity: -5 }).ok).toBe(false);
    expect(validateMovementInput({ ...base, quantity: "abc" }).ok).toBe(false);
  });

  it("quantity เกินเพดาน → ปฏิเสธ", () => {
    expect(validateMovementInput({ ...base, quantity: QTY_MAX + 1 }).ok).toBe(false);
  });

  it("movementDate ผิดรูปแบบ/ไม่มีจริงในปฏิทิน → ปฏิเสธ", () => {
    expect(validateMovementInput({ ...base, movementDate: "01/01/2026" }).ok).toBe(false);
    expect(validateMovementInput({ ...base, movementDate: "2026-02-30" }).ok).toBe(false);
    expect(validateMovementInput({ ...base, movementDate: "" }).ok).toBe(false);
  });

  it("★ IN-type (purchase/adjustment_in) ไม่กรอก unit_cost → ปฏิเสธ", () => {
    expect(validateMovementInput({ ...base, movementType: "purchase", unitCost: undefined }).ok).toBe(false);
    expect(validateMovementInput({ ...base, movementType: "adjustment_in", unitCost: null }).ok).toBe(false);
    expect(validateMovementInput({ ...base, movementType: "adjustment_in", unitCost: "" }).ok).toBe(false);
  });

  it("★ IN-type unit_cost ติดลบ → ปฏิเสธ", () => {
    expect(validateMovementInput({ ...base, unitCost: -1 }).ok).toBe(false);
  });

  it("★ IN-type unit_cost เกินเพดาน → ปฏิเสธ", () => {
    expect(validateMovementInput({ ...base, unitCost: UNIT_COST_MAX + 1 }).ok).toBe(false);
  });

  it("★ IN-type unit_cost = 0 → ผ่าน (ของแจก/ต้นทุน 0 ก็เป็นไปได้จริง)", () => {
    expect(validateMovementInput({ ...base, unitCost: 0 }).ok).toBe(true);
  });

  it("★ OUT-type (sale/adjustment_out) ไม่ต้องกรอก unit_cost เลยก็ผ่าน (ใช้ต้นทุนเฉลี่ยตอน replay แทน)", () => {
    const res = validateMovementInput({ ...base, movementType: "sale", unitCost: undefined });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.unitCost).toBeNull();
  });

  it("memo เกินเพดาน → ตัดให้พอดี (ไม่ปฏิเสธทั้ง input)", () => {
    const longMemo = "ก".repeat(400);
    const res = validateMovementInput({ ...base, memo: longMemo });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.memo?.length).toBeLessThanOrEqual(300);
  });

  it("memo ว่าง/undefined → null (ไม่บังคับกรอก)", () => {
    const res = validateMovementInput({ ...base, memo: undefined });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.memo).toBeNull();
  });
});

// =========================================================================
// validateOpeningBalanceInput (0.11/0.12)
// =========================================================================
describe("validateOpeningBalanceInput", () => {
  const base = { quantity: 100, unitCost: 65, note: "ยกมาจากปีก่อน" };

  it("input ถูกต้องครบถ้วน → ผ่าน", () => {
    const res = validateOpeningBalanceInput(base);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ quantity: 100, unitCost: 65, note: "ยกมาจากปีก่อน" });
  });

  it("★ 0.12 quantity ติดลบ → ผ่านได้ (สต็อกยกมาติดลบไม่ block)", () => {
    const res = validateOpeningBalanceInput({ ...base, quantity: -20 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.quantity).toBe(-20);
  });

  it("quantity ไม่ใช่ตัวเลข → ปฏิเสธ", () => {
    expect(validateOpeningBalanceInput({ ...base, quantity: "abc" }).ok).toBe(false);
    expect(validateOpeningBalanceInput({ ...base, quantity: undefined }).ok).toBe(false);
  });

  it("|quantity| เกินเพดาน → ปฏิเสธ", () => {
    expect(validateOpeningBalanceInput({ ...base, quantity: QTY_MAX + 1 }).ok).toBe(false);
    expect(validateOpeningBalanceInput({ ...base, quantity: -(QTY_MAX + 1) }).ok).toBe(false);
  });

  it("unit_cost ติดลบ/ไม่ใช่ตัวเลข → ปฏิเสธ (ราคาต่อหน่วยห้ามติดลบ)", () => {
    expect(validateOpeningBalanceInput({ ...base, unitCost: -1 }).ok).toBe(false);
    expect(validateOpeningBalanceInput({ ...base, unitCost: "abc" }).ok).toBe(false);
    expect(validateOpeningBalanceInput({ ...base, unitCost: undefined }).ok).toBe(false);
  });

  it("unit_cost เกินเพดาน → ปฏิเสธ", () => {
    expect(validateOpeningBalanceInput({ ...base, unitCost: UNIT_COST_MAX + 1 }).ok).toBe(false);
  });

  it("note ว่าง/undefined → null", () => {
    const res = validateOpeningBalanceInput({ ...base, note: undefined });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.note).toBeNull();
  });
});

// =========================================================================
// data layer (fake DB in-memory) — pattern เดียวกับ tests/accounting/recurring-journal.test.ts
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

type Tables = {
  product_stock_movements: Row[];
  product_opening_balances: Row[];
};

function makeFakeDb(): { db: SupabaseClient; tables: Tables } {
  const tables: Tables = { product_stock_movements: [], product_opening_balances: [] };
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}-${seq++}`;
  // ★ created_at เพิ่มขึ้นทีละวินาที ตามลำดับ insert จริง — ให้ order/tiebreak deterministic ในเทสต์
  let clockMs = Date.parse("2026-01-01T00:00:00.000Z");
  const nextCreatedAt = () => {
    clockMs += 1000;
    return new Date(clockMs).toISOString();
  };

  const ROW_DEFAULTS: Partial<Record<keyof Tables, Row>> = {
    product_stock_movements: { deleted_at: null, memo: null, source_bill_entry_line_id: null, unit_cost: null },
    product_opening_balances: { deleted_at: null, note: null },
  };

  function qb(table: keyof Tables) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: unknown;
    let orderCols: string[] = [];
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
      let error: unknown = null;
      if (mode === "insert") {
        const row: Row = {
          id: nextId(table),
          created_at: nextCreatedAt(),
          ...(ROW_DEFAULTS[table] ?? {}),
          ...(payload as Row),
        };
        tables[table].push(row);
      } else if (mode === "update") {
        let found = false;
        for (const row of tables[table]) {
          if (matchRow(row, filters)) {
            Object.assign(row, payload as Row);
            found = true;
          }
        }
        if (!found) error = null; // update บน record ที่ไม่เจอ — ไม่ error (mirror supabase)
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
const PRODUCT = "p1";

describe("createManualAdjustment / listMovements / softDeleteMovement", () => {
  it("บันทึกปรับปรุงสต็อกเข้า (adjustment_in) สำเร็จ → เห็นใน listMovements", async () => {
    const { db } = makeFakeDb();
    const res = await createManualAdjustment(db, TENANT, CUSTOMER, PRODUCT, {
      movementType: "adjustment_in",
      quantity: 5,
      unitCost: 20,
      movementDate: "2026-01-05",
      memo: "นับสต็อกจริงเกิน",
      warehouseId: "w1",
    });
    expect(res.ok).toBe(true);

    const list = await listMovements(db, TENANT, CUSTOMER, PRODUCT);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ movementType: "adjustment_in", quantity: 5, unitCost: 20, memo: "นับสต็อกจริงเกิน" });
  });

  it("ประเภทไม่ใช่ adjustment_in/out (เช่น purchase/sale) → ปฏิเสธ ไม่แตะ DB (0.9 — purchase/sale มาจากปุ่ม manual-trigger บิลเท่านั้น เฟส 8-Y)", async () => {
    const { db, tables } = makeFakeDb();
    const res = await createManualAdjustment(db, TENANT, CUSTOMER, PRODUCT, {
      movementType: "purchase" as never,
      quantity: 5,
      unitCost: 20,
      movementDate: "2026-01-05",
      warehouseId: "w1",
    });
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements).toHaveLength(0);
  });

  it("validate ไม่ผ่าน (quantity<=0) → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, tables } = makeFakeDb();
    const res = await createManualAdjustment(db, TENANT, CUSTOMER, PRODUCT, {
      movementType: "adjustment_out",
      quantity: -1,
      movementDate: "2026-01-05",
      warehouseId: "w1",
    });
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements).toHaveLength(0);
  });

  it("softDeleteMovement → ตั้ง deleted_at + หายจาก listMovements", async () => {
    const { db } = makeFakeDb();
    const created = await createManualAdjustment(db, TENANT, CUSTOMER, PRODUCT, {
      movementType: "adjustment_out",
      quantity: 2,
      movementDate: "2026-01-06",
      memo: "สินค้าเสียหาย",
      warehouseId: "w1",
    });
    if (!created.ok) throw new Error("setup failed");

    const del = await softDeleteMovement(db, TENANT, created.id);
    expect(del.ok).toBe(true);

    const list = await listMovements(db, TENANT, CUSTOMER, PRODUCT);
    expect(list).toHaveLength(0);
  });

  it("listMovements เรียงตามวันที่/created_at ถูกต้อง (สร้างสลับลำดับ)", async () => {
    const { db } = makeFakeDb();
    await createManualAdjustment(db, TENANT, CUSTOMER, PRODUCT, {
      movementType: "adjustment_in",
      quantity: 1,
      unitCost: 1,
      movementDate: "2026-03-01",
      warehouseId: "w1",
    });
    await createManualAdjustment(db, TENANT, CUSTOMER, PRODUCT, {
      movementType: "adjustment_in",
      quantity: 2,
      unitCost: 2,
      movementDate: "2026-01-01",
      warehouseId: "w1",
    });
    const list = await listMovements(db, TENANT, CUSTOMER, PRODUCT);
    expect(list.map((m) => m.movementDate)).toEqual(["2026-01-01", "2026-03-01"]);
  });
});

describe("getMovementScope", () => {
  it("คืน customerId/productId ของ movement ที่มีอยู่จริง", async () => {
    const { db } = makeFakeDb();
    const created = await createManualAdjustment(db, TENANT, CUSTOMER, PRODUCT, {
      movementType: "adjustment_in",
      quantity: 1,
      unitCost: 1,
      movementDate: "2026-01-01",
      warehouseId: "w1",
    });
    if (!created.ok) throw new Error("setup failed");
    const scope = await getMovementScope(db, TENANT, created.id);
    expect(scope).toEqual({ customerId: CUSTOMER, productId: PRODUCT });
  });

  it("ไม่พบ (ถูกลบไปแล้ว/ไม่มีจริง) → คืน null", async () => {
    const { db } = makeFakeDb();
    const created = await createManualAdjustment(db, TENANT, CUSTOMER, PRODUCT, {
      movementType: "adjustment_in",
      quantity: 1,
      unitCost: 1,
      movementDate: "2026-01-01",
      warehouseId: "w1",
    });
    if (!created.ok) throw new Error("setup failed");
    await softDeleteMovement(db, TENANT, created.id);
    expect(await getMovementScope(db, TENANT, created.id)).toBeNull();
    expect(await getMovementScope(db, TENANT, "not-exist")).toBeNull();
  });
});

describe("upsertProductOpeningBalance / listProductOpeningBalances / getProductOpeningBalance", () => {
  it("สร้างยอดยกมาใหม่ → เห็นใน list/get", async () => {
    const { db } = makeFakeDb();
    const res = await upsertProductOpeningBalance(db, TENANT, CUSTOMER, PRODUCT, {
      quantity: 100,
      unitCost: 65,
      note: "ยกมาจากปีก่อน",
    });
    expect(res.ok).toBe(true);

    const one = await getProductOpeningBalance(db, TENANT, CUSTOMER, PRODUCT);
    expect(one).toEqual({ quantity: 100, unitCost: 65, note: "ยกมาจากปีก่อน" });

    const list = await listProductOpeningBalances(db, TENANT, CUSTOMER);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ productId: PRODUCT, quantity: 100, unitCost: 65 });
  });

  it("เรียกซ้ำ (แก้ยอดยกมาเดิม) → update ทับแถวเดิม ไม่สร้างซ้ำ (mirror account_opening_balances)", async () => {
    const { db, tables } = makeFakeDb();
    await upsertProductOpeningBalance(db, TENANT, CUSTOMER, PRODUCT, { quantity: 100, unitCost: 65, note: null });
    await upsertProductOpeningBalance(db, TENANT, CUSTOMER, PRODUCT, { quantity: 120, unitCost: 70, note: "แก้ใหม่" });

    expect(tables.product_opening_balances).toHaveLength(1);
    const one = await getProductOpeningBalance(db, TENANT, CUSTOMER, PRODUCT);
    expect(one).toEqual({ quantity: 120, unitCost: 70, note: "แก้ใหม่" });
  });

  it("validate ไม่ผ่าน (unit_cost ติดลบ) → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, tables } = makeFakeDb();
    const res = await upsertProductOpeningBalance(db, TENANT, CUSTOMER, PRODUCT, { quantity: 100, unitCost: -1 });
    expect(res.ok).toBe(false);
    expect(tables.product_opening_balances).toHaveLength(0);
  });

  it("ยังไม่ตั้งยอดยกมา → getProductOpeningBalance คืน null (computeStockLedger รับ null ได้)", async () => {
    const { db } = makeFakeDb();
    expect(await getProductOpeningBalance(db, TENANT, CUSTOMER, PRODUCT)).toBeNull();
  });
});

// =========================================================================
// createMovementsFromBill (เฟส 8 ส่วน Y, T70) — เชื่อมกับบิลที่ยืนยันแล้ว (0.7/0.8)
//   fake DB แยกต่างหาก (bill_entries/bill_entry_lines/product_stock_movements) — mirror pattern qb() เดิม
// =========================================================================
type BillSyncTables = {
  bill_entries: Row[];
  bill_entry_lines: Row[];
  product_stock_movements: Row[];
  warehouses: Row[];
};

function makeBillSyncFakeDb(): { db: SupabaseClient; tables: BillSyncTables } {
  const tables: BillSyncTables = { bill_entries: [], bill_entry_lines: [], product_stock_movements: [], warehouses: [] };
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}-${seq++}`;

  const ROW_DEFAULTS: Partial<Record<keyof BillSyncTables, Row>> = {
    bill_entries: { deleted_at: null, stock_synced_at: null },
    bill_entry_lines: {},
    product_stock_movements: { deleted_at: null, memo: null, source_bill_entry_line_id: null, unit_cost: null, warehouse_id: null },
    warehouses: { deleted_at: null, is_default: false, is_active: true },
  };

  function qb(table: keyof BillSyncTables) {
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
        const row: Row = { id: nextId(table), created_at: new Date().toISOString(), ...(ROW_DEFAULTS[table] ?? {}), ...(payload as Row) };
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
        // ★ รองรับ insert แบบ array (createMovementsFromBill สร้างหลาย movement พร้อมกัน 1 คำสั่ง)
        const items = Array.isArray(payload) ? payload : [payload];
        for (const p of items) {
          const row: Row = { id: nextId(table), created_at: new Date().toISOString(), ...(ROW_DEFAULTS[table] ?? {}), ...(p as Row) };
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

  return { db: { from: (t: string) => qb(t as keyof BillSyncTables) } as unknown as SupabaseClient, tables };
}

const ENTRY_TENANT = "t1";
const ENTRY_CUSTOMER = "c1";

function seedBillEntry(
  tables: BillSyncTables,
  overrides: Partial<Row> = {}
): string {
  const id = overrides.id ? String(overrides.id) : `entry-${tables.bill_entries.length + 1}`;
  tables.bill_entries.push({
    id,
    tenant_id: ENTRY_TENANT,
    customer_id: ENTRY_CUSTOMER,
    entry_type: "purchase",
    status: "confirmed",
    doc_date: "2026-01-10",
    doc_no: "PO-0001",
    deleted_at: null,
    stock_synced_at: null,
    ...overrides,
  });
  return id;
}

function seedBillLine(
  tables: BillSyncTables,
  entryId: string,
  overrides: Partial<Row> = {}
): string {
  const id = overrides.id ? String(overrides.id) : `line-${tables.bill_entry_lines.length + 1}`;
  tables.bill_entry_lines.push({
    id,
    entry_id: entryId,
    tenant_id: ENTRY_TENANT,
    line_no: tables.bill_entry_lines.length + 1,
    product_id: "prod-1",
    quantity: 10,
    amount: 1000,
    ...overrides,
  });
  return id;
}

describe("createMovementsFromBill", () => {
  it("บิลซื้อผสม (บางบรรทัดมี product_id+quantity ครบ บางบรรทัดไม่มี) → สร้าง movement เฉพาะบรรทัดที่ครบ", async () => {
    const { db, tables } = makeBillSyncFakeDb();
    const entryId = seedBillEntry(tables, { entry_type: "purchase" });
    const line1 = seedBillLine(tables, entryId, { product_id: "prod-1", quantity: 10, amount: 1000 }); // ครบ → unit_cost 100
    const line2 = seedBillLine(tables, entryId, { product_id: "prod-2", quantity: null, amount: 500 }); // ไม่มี quantity → ข้าม
    const line3 = seedBillLine(tables, entryId, { product_id: null, quantity: 5, amount: 200 }); // ไม่มี product_id → ข้าม

    const res = await createMovementsFromBill(db, ENTRY_TENANT, entryId);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.created).toBe(1);
    expect(res.skippedLineIds.sort()).toEqual([line2, line3].sort());

    expect(tables.product_stock_movements).toHaveLength(1);
    expect(tables.product_stock_movements[0]).toMatchObject({
      tenant_id: ENTRY_TENANT,
      customer_id: ENTRY_CUSTOMER,
      product_id: "prod-1",
      movement_type: "purchase",
      quantity: 10,
      unit_cost: 100,
      source_bill_entry_line_id: line1,
      movement_date: "2026-01-10",
    });
  });

  it("บิลซื้อ → unit_cost คำนวณถูกต้องจาก amount/quantity ต่อบรรทัด", async () => {
    const { db, tables } = makeBillSyncFakeDb();
    const entryId = seedBillEntry(tables, { entry_type: "purchase" });
    seedBillLine(tables, entryId, { product_id: "prod-1", quantity: 4, amount: 250 }); // 62.5

    const res = await createMovementsFromBill(db, ENTRY_TENANT, entryId);
    expect(res.ok).toBe(true);
    expect(tables.product_stock_movements[0]).toMatchObject({ unit_cost: 62.5, quantity: 4 });
  });

  it("บิลขาย → สร้าง movement type 'sale' ไม่มี unit_cost (ใช้ moving-average ตอน replay)", async () => {
    const { db, tables } = makeBillSyncFakeDb();
    const entryId = seedBillEntry(tables, { entry_type: "sale" });
    seedBillLine(tables, entryId, { product_id: "prod-1", quantity: 3, amount: 900 });

    const res = await createMovementsFromBill(db, ENTRY_TENANT, entryId);
    expect(res.ok).toBe(true);
    expect(tables.product_stock_movements[0]).toMatchObject({
      movement_type: "sale",
      quantity: 3,
      unit_cost: null,
    });
  });

  it("★ 0.8 เรียกซ้อน 2 ครั้ง (จำลอง double-click) → สร้างสำเร็จแค่ครั้งเดียว ครั้งที่ 2 ปฏิเสธ", async () => {
    const { db, tables } = makeBillSyncFakeDb();
    const entryId = seedBillEntry(tables, { entry_type: "purchase" });
    seedBillLine(tables, entryId, { product_id: "prod-1", quantity: 10, amount: 1000 });

    const first = await createMovementsFromBill(db, ENTRY_TENANT, entryId);
    const second = await createMovementsFromBill(db, ENTRY_TENANT, entryId);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.message).toMatch(/ไปแล้ว/);
    expect(tables.product_stock_movements).toHaveLength(1);
  });

  it("status ≠ 'confirmed' → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, tables } = makeBillSyncFakeDb();
    const entryId = seedBillEntry(tables, { entry_type: "purchase", status: "draft" });
    seedBillLine(tables, entryId, { product_id: "prod-1", quantity: 10, amount: 1000 });

    const res = await createMovementsFromBill(db, ENTRY_TENANT, entryId);
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements).toHaveLength(0);
  });

  it("entry_type อื่น (unspecified) → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db, tables } = makeBillSyncFakeDb();
    const entryId = seedBillEntry(tables, { entry_type: "unspecified" });
    seedBillLine(tables, entryId, { product_id: "prod-1", quantity: 10, amount: 1000 });

    const res = await createMovementsFromBill(db, ENTRY_TENANT, entryId);
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements).toHaveLength(0);
  });

  it("ไม่มีลูกค้าผูก (customer_id null) → ปฏิเสธ", async () => {
    const { db, tables } = makeBillSyncFakeDb();
    const entryId = seedBillEntry(tables, { customer_id: null });
    seedBillLine(tables, entryId, { product_id: "prod-1", quantity: 10, amount: 1000 });

    const res = await createMovementsFromBill(db, ENTRY_TENANT, entryId);
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements).toHaveLength(0);
  });

  it("ไม่มีวันที่เอกสาร (doc_date null) → ปฏิเสธ", async () => {
    const { db, tables } = makeBillSyncFakeDb();
    const entryId = seedBillEntry(tables, { doc_date: null });
    seedBillLine(tables, entryId, { product_id: "prod-1", quantity: 10, amount: 1000 });

    const res = await createMovementsFromBill(db, ENTRY_TENANT, entryId);
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements).toHaveLength(0);
  });

  it("ไม่มีบรรทัดที่ product_id+quantity ครบเลย → ปฏิเสธ ไม่ claim", async () => {
    const { db, tables } = makeBillSyncFakeDb();
    const entryId = seedBillEntry(tables, { entry_type: "purchase" });
    seedBillLine(tables, entryId, { product_id: null, quantity: 10, amount: 1000 });
    seedBillLine(tables, entryId, { product_id: "prod-1", quantity: null, amount: 500 });

    const res = await createMovementsFromBill(db, ENTRY_TENANT, entryId);
    expect(res.ok).toBe(false);
    expect(tables.product_stock_movements).toHaveLength(0);
    // ★ ไม่ claim (stock_synced_at ยังเป็น null) — เผื่อกรอกบรรทัดเพิ่มแล้วกดใหม่ได้
    expect(tables.bill_entries.find((e) => e.id === entryId)?.stock_synced_at).toBeNull();
  });

  it("quantity=0 หรือติดลบ → ถือว่าไม่ครบเงื่อนไข (ข้าม)", async () => {
    const { db, tables } = makeBillSyncFakeDb();
    const entryId = seedBillEntry(tables, { entry_type: "purchase" });
    seedBillLine(tables, entryId, { product_id: "prod-1", quantity: 0, amount: 0 });
    seedBillLine(tables, entryId, { product_id: "prod-2", quantity: -5, amount: -100 });
    seedBillLine(tables, entryId, { product_id: "prod-3", quantity: 2, amount: 20 });

    const res = await createMovementsFromBill(db, ENTRY_TENANT, entryId);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.created).toBe(1);
    expect(res.skippedLineIds).toHaveLength(2);
  });

  it("ไม่พบบิล (ถูกลบ/ไม่มีจริง) → ปฏิเสธ", async () => {
    const { db } = makeBillSyncFakeDb();
    const res = await createMovementsFromBill(db, ENTRY_TENANT, "not-exist");
    expect(res.ok).toBe(false);
  });
});
