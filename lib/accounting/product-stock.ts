/**
 * สต็อกสินค้าคงเหลือ + ต้นทุนถ่วงเฉลี่ยเคลื่อนที่ (Inventory / Stock) — เฟส 8 ส่วน X
 * (docs/06-accounting-features-roadmap.md, หมวด 0.1–0.14, T67–T69)
 *
 * ★★ 0.6 ที่สำคัญที่สุดของทั้งเฟส: ไฟล์นี้เป็น "ชั้นติดตามจำนวน+มูลค่าคงเหลือ" คู่ขนานเท่านั้น —
 *   ไม่มี write path ใดกระทบบัญชีแยกประเภท/งบการเงิน/งบกระแสเงินสดเลยแม้แต่จุดเดียว (ผังบัญชีเดิมยัง
 *   เป็นระบบสต็อกสิ้นงวด/Periodic — ดู migration 0063) — ★ ห้าม import journal.ts/ledger.ts/
 *   statements.ts/manual-journal.ts เข้ามาในไฟล์นี้เด็ดขาด (grep ยืนยันก่อนปิดงานทุกครั้ง)
 *
 * ★ 0.1 วิธีคำนวณต้นทุน — ถ่วงเฉลี่ยเคลื่อนที่ (Moving Average) เท่านั้น: ค่าเฉลี่ยคำนวณใหม่ทุกครั้งที่มี
 *   การ "รับเข้า" (purchase/adjustment_in/ยอดยกมา) เท่านั้น — ตอน "จ่ายออก" (sale/adjustment_out) ใช้
 *   ค่าเฉลี่ย ณ ขณะนั้นตัดออก แล้วค่าเฉลี่ยไม่เปลี่ยน (คงเดิม) จนกว่าจะมีรับเข้ารอบถัดไป — สอดคล้องกับ
 *   ตัวอย่างบัตรสต็อกที่ผู้ใช้แนบ (100@65.000 → รับ 200@70.000 → เฉลี่ย 68.333 → จ่าย 50 ที่ 68.333)
 * ★ 0.5/0.12 ไม่เก็บยอดสะสม/cache ใด ๆ — ทุกครั้งที่ต้องรู้ยอดคงเหลือ/ต้นทุนเฉลี่ย ดึงยอดยกมา+รายการ
 *   เคลื่อนไหวทั้งหมดมา "เล่นซ้ำ" (replay, pure function computeStockLedger) ตั้งแต่ต้นทุกครั้ง — กันบั๊ก
 *   backdated-entry ทำยอดค้างผิดเงียบ ๆ · สต็อกติดลบไม่ throw คืน flag เตือน (negativeWarning) เท่านั้น
 * ★ 0.11 ยอดยกมา (product_opening_balances) ไม่มีคอลัมน์วันที่ — ถือเป็น "ก่อนรายการเคลื่อนไหวทั้งหมดเสมอ"
 * ★ 0.10 รายงาน — buildStockCard (บัตรสต็อกต่อสินค้า) + buildInventoryValuationReport (สินค้าคงเหลือแยก
 *   หมวด products.category · ไม่มี category → เข้ากลุ่ม default "สินค้า")
 * ★ ทุก query/write กรอง tenant_id (จาก session) + customer_id/product_id — IDOR-safe guard อยู่ที่ชั้น
 *   actions.ts (derive scope จาก resource id ที่กำลังเขียนจริงเสมอ ตาม 0.13)
 * ★ soft-delete (deleted_at) ทั้ง 2 ตาราง — ไม่ลบจริง (pattern เดิมทั้งระบบ)
 * ★ PDPA: ไม่ log จำนวน/มูลค่า/ชื่อสินค้า/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidCalendarDate } from "@/lib/accounting/bank-reconciliation";
import { round2 } from "@/lib/accounting/queries";

type DB = SupabaseClient;

// =========================================================================
// เพดาน/ค่าคงที่
// =========================================================================
export const QTY_MAX = 1_000_000_000;
export const UNIT_COST_MAX = 1_000_000_000;
export const MEMO_MAX = 300;
export const OPENING_NOTE_MAX = 300;
const LIST_LIMIT = 5000;

/** ปัดทศนิยม 3 ตำแหน่ง (ราคาต่อหน่วยเฉลี่ย — mirror รูปแบบตัวอย่างบัตรสต็อกที่แนบ เช่น 68.333) */
export function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

// =========================================================================
// A) ชนิดข้อมูล
// =========================================================================

export type StockMovementType = "purchase" | "sale" | "adjustment_in" | "adjustment_out";

const IN_MOVEMENT_TYPES: ReadonlySet<StockMovementType> = new Set(["purchase", "adjustment_in"]);
const OUT_MOVEMENT_TYPES: ReadonlySet<StockMovementType> = new Set(["sale", "adjustment_out"]);

/** true = รับเข้า (คำนวณต้นทุนเฉลี่ยใหม่) · false = จ่ายออก (ตัดที่ต้นทุนเฉลี่ย ณ ขณะนั้น ไม่เปลี่ยนเฉลี่ย) */
export function isInMovementType(t: StockMovementType): boolean {
  return IN_MOVEMENT_TYPES.has(t);
}
export function isOutMovementType(t: StockMovementType): boolean {
  return OUT_MOVEMENT_TYPES.has(t);
}

/** 1 รายการเคลื่อนไหวสต็อก (แถวจาก product_stock_movements) */
export type StockMovement = {
  id: string;
  tenantId: string;
  customerId: string;
  productId: string;
  movementType: StockMovementType;
  /** บวกเสมอ — ทิศทางกำหนดจาก movementType ไม่ใช่เครื่องหมาย */
  quantity: number;
  /** ราคาต่อหน่วยตอนรับเข้า · null สำหรับรายการจ่ายออก (ใช้ต้นทุนเฉลี่ย ณ ขณะนั้นแทน) */
  unitCost: number | null;
  sourceBillEntryLineId: string | null;
  memo: string | null;
  /** YYYY-MM-DD */
  movementDate: string;
  /** ISO timestamp — ใช้เป็น tiebreak ตอน sort วันเดียวกัน (mirror bookLineKeyOf แนวคิด) */
  createdAt: string;
};

/** input สร้างรายการเคลื่อนไหว (ก่อน validate) */
export type StockMovementInput = {
  movementType: StockMovementType;
  quantity: number;
  unitCost?: number | null;
  movementDate: string;
  memo?: string | null;
};

/** ยอดยกมาสต็อก 1 สินค้า (ไม่มีวันที่ — ถือเป็นก่อนรายการเคลื่อนไหวทั้งหมดเสมอ) */
export type OpeningBalance = {
  quantity: number;
  unitCost: number;
  note: string | null;
};

/** 1 แถวผลการ replay (ต้นทุนถ่วงเฉลี่ยเคลื่อนที่) — ใช้ทำทั้งบัตรสต็อก/รายงานสินค้าคงเหลือ */
export type StockLedgerRow = {
  kind: "opening" | "movement";
  movementId: string | null;
  movementType: StockMovementType | null;
  /** '' สำหรับแถวยอดยกมา (ไม่มีวันที่จริง — 0.11) */
  date: string;
  memo: string | null;
  sourceBillEntryLineId: string | null;
  inQuantity: number | null;
  inUnitCost: number | null;
  inValue: number | null;
  outQuantity: number | null;
  outUnitCost: number | null;
  outValue: number | null;
  balanceQuantity: number;
  balanceUnitCost: number;
  balanceValue: number;
  /** 0.12 — คงเหลือติดลบ (ไม่ throw แค่เตือน) */
  negativeWarning: boolean;
};

export type StockActionResult = { ok: true; id: string } | { ok: false; message: string };

// =========================================================================
// B) validate (pure)
// =========================================================================

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export type ValidatedMovementInput = {
  movementType: StockMovementType;
  quantity: number;
  unitCost: number | null;
  movementDate: string;
  memo: string | null;
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * validate input 1 รายการเคลื่อนไหว (0.4 ของ T68):
 *   - quantity ต้องเป็นตัวเลข > 0 (ทิศทางกำหนดจาก movementType เสมอ)
 *   - unit_cost >= 0 บังคับกรอกเมื่อเป็น IN-type (purchase/adjustment_in) — OUT-type ไม่ต้องกรอก/ไม่เก็บ
 *     (ใช้ต้นทุนถ่วงเฉลี่ย ณ ขณะนั้นตอน replay แทนเสมอ)
 *   - movement_date ต้องเป็นวันที่ปฏิทินจริง (reuse isValidCalendarDate จาก bank-reconciliation.ts)
 */
export function validateMovementInput(input: {
  movementType: unknown;
  quantity: unknown;
  unitCost?: unknown;
  movementDate: unknown;
  memo?: unknown;
}): ValidationResult<ValidatedMovementInput> {
  const movementType = input.movementType;
  if (
    movementType !== "purchase" &&
    movementType !== "sale" &&
    movementType !== "adjustment_in" &&
    movementType !== "adjustment_out"
  ) {
    return { ok: false, message: "ประเภทรายการไม่ถูกต้อง" };
  }

  const quantity = toFiniteNumber(input.quantity);
  if (quantity === null || quantity <= 0) return { ok: false, message: "จำนวนต้องมากกว่า 0" };
  if (quantity > QTY_MAX) return { ok: false, message: `จำนวนต้องไม่เกิน ${QTY_MAX.toLocaleString("th-TH")}` };

  const movementDate = typeof input.movementDate === "string" ? input.movementDate.trim() : "";
  if (!isValidCalendarDate(movementDate)) {
    return { ok: false, message: "วันที่ไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD)" };
  }

  let unitCost: number | null = null;
  if (isInMovementType(movementType)) {
    const raw = input.unitCost;
    if (raw === undefined || raw === null || raw === "") {
      return { ok: false, message: "กรุณากรอกราคาต่อหน่วย (ต้องไม่ติดลบ)" };
    }
    const n = toFiniteNumber(raw);
    if (n === null || n < 0) return { ok: false, message: "ราคาต่อหน่วยต้องไม่ติดลบ" };
    if (n > UNIT_COST_MAX) return { ok: false, message: `ราคาต่อหน่วยต้องไม่เกิน ${UNIT_COST_MAX.toLocaleString("th-TH")}` };
    unitCost = round3(n);
  }

  const memo = clampText(input.memo, MEMO_MAX);

  return { ok: true, value: { movementType, quantity, unitCost, movementDate, memo } };
}

export type ValidatedOpeningBalanceInput = { quantity: number; unitCost: number; note: string | null };

/** validate input ยอดยกมาสต็อก (0.11) — quantity รับค่าติดลบได้ (0.12, ไม่บังคับ >=0), unitCost ต้อง >= 0 */
export function validateOpeningBalanceInput(input: {
  quantity: unknown;
  unitCost: unknown;
  note?: unknown;
}): ValidationResult<ValidatedOpeningBalanceInput> {
  const quantity = toFiniteNumber(input.quantity);
  if (quantity === null) return { ok: false, message: "จำนวนยอดยกมาไม่ถูกต้อง" };
  if (Math.abs(quantity) > QTY_MAX) return { ok: false, message: `จำนวนต้องไม่เกิน ${QTY_MAX.toLocaleString("th-TH")}` };

  const unitCost = toFiniteNumber(input.unitCost);
  if (unitCost === null || unitCost < 0) return { ok: false, message: "ราคาต่อหน่วยต้องไม่ติดลบ" };
  if (unitCost > UNIT_COST_MAX) return { ok: false, message: `ราคาต่อหน่วยต้องไม่เกิน ${UNIT_COST_MAX.toLocaleString("th-TH")}` };

  const note = clampText(input.note, OPENING_NOTE_MAX);
  return { ok: true, value: { quantity: round2(quantity), unitCost: round3(unitCost), note } };
}

// =========================================================================
// C) computeStockLedger — pure, ★ จุดสำคัญที่สุดของเฟส (T68, 0.1/0.5/0.12)
// =========================================================================

/**
 * เล่นซ้ำ (replay) ยอดยกมา + รายการเคลื่อนไหวทั้งหมดของสินค้า 1 ตัว → คำนวณยอดคงเหลือ+ต้นทุนถ่วงเฉลี่ย
 * เคลื่อนที่ทีละรายการ (pure function — ไม่แตะ DB, ไม่เก็บ cache)
 *
 *   ลำดับ replay: ยอดยกมา (ถ้ามี — เสมอเป็นจุดเริ่ม ไม่ว่า movement_date ของรายการอื่นจะเป็นอะไร, 0.11)
 *     → movements เรียงตาม movement_date แล้ว created_at เป็น tiebreak (กันคีย์ชนวันเดียวกัน, 0.5)
 *
 *   สูตร (0.1 — ตรงกับตัวอย่างบัตรสต็อกที่ผู้ใช้แนบ 100@65.000→รับ200@70.000→เฉลี่ย68.333):
 *     - รับเข้า (purchase/adjustment_in): totalValue += quantity*unitCost; qty += quantity
 *         → ต้นทุนเฉลี่ยใหม่ = totalValue / qty (คำนวณเฉลี่ยใหม่ทุกครั้งที่รับเข้าเท่านั้น)
 *     - จ่ายออก (sale/adjustment_out): ตัดที่ต้นทุนเฉลี่ย "ก่อน" รายการนี้ (avgBefore = totalValue/qty)
 *         → outValue = quantity*avgBefore; totalValue -= outValue; qty -= quantity
 *         → ต้นทุนเฉลี่ยไม่เปลี่ยน (คงเดิม) จนกว่าจะมีรับเข้ารอบถัดไป
 *   ★ totalValue เก็บที่ float precision เต็มตลอดการวนซ้ำ (ปัดแค่ตอนสร้างแถวผลลัพธ์) — กัน error สะสม
 *     จากการปัดเศษซ้ำ ๆ หลายรอบ (สำคัญมากสำหรับสินค้าที่มีรายการเคลื่อนไหวจำนวนมาก)
 *   ★ สต็อกติดลบ (0.12) — ไม่ throw, ไม่ block: คำนวณต่อตามปกติ ตั้ง negativeWarning=true ในแถวนั้น
 */
export function computeStockLedger(
  opening: OpeningBalance | null,
  movements: StockMovement[]
): StockLedgerRow[] {
  const rows: StockLedgerRow[] = [];

  let qty = 0;
  let totalValue = 0;

  if (opening) {
    const openQty = Number.isFinite(opening.quantity) ? opening.quantity : 0;
    const openUnitCost = Number.isFinite(opening.unitCost) ? opening.unitCost : 0;
    qty = openQty;
    totalValue = openQty * openUnitCost;
    rows.push({
      kind: "opening",
      movementId: null,
      movementType: null,
      date: "",
      memo: opening.note,
      sourceBillEntryLineId: null,
      inQuantity: null,
      inUnitCost: null,
      inValue: null,
      outQuantity: null,
      outUnitCost: null,
      outValue: null,
      balanceQuantity: round2(qty),
      balanceUnitCost: qty !== 0 ? round3(totalValue / qty) : 0,
      balanceValue: round2(totalValue),
      negativeWarning: qty < 0,
    });
  }

  const sorted = [...movements].sort((a, b) => {
    if (a.movementDate !== b.movementDate) return a.movementDate < b.movementDate ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return 0;
  });

  for (const m of sorted) {
    if (isInMovementType(m.movementType)) {
      const unitCost = m.unitCost ?? 0;
      const inValue = m.quantity * unitCost;
      qty += m.quantity;
      totalValue += inValue;
      rows.push({
        kind: "movement",
        movementId: m.id,
        movementType: m.movementType,
        date: m.movementDate,
        memo: m.memo,
        sourceBillEntryLineId: m.sourceBillEntryLineId,
        inQuantity: round2(m.quantity),
        inUnitCost: round3(unitCost),
        inValue: round2(inValue),
        outQuantity: null,
        outUnitCost: null,
        outValue: null,
        balanceQuantity: round2(qty),
        balanceUnitCost: qty !== 0 ? round3(totalValue / qty) : 0,
        balanceValue: round2(totalValue),
        negativeWarning: qty < 0,
      });
    } else {
      const avgBefore = qty !== 0 ? totalValue / qty : 0;
      const outValue = m.quantity * avgBefore;
      qty -= m.quantity;
      totalValue -= outValue;
      rows.push({
        kind: "movement",
        movementId: m.id,
        movementType: m.movementType,
        date: m.movementDate,
        memo: m.memo,
        sourceBillEntryLineId: m.sourceBillEntryLineId,
        inQuantity: null,
        inUnitCost: null,
        inValue: null,
        outQuantity: round2(m.quantity),
        outUnitCost: round3(avgBefore),
        outValue: round2(outValue),
        balanceQuantity: round2(qty),
        balanceUnitCost: qty !== 0 ? round3(totalValue / qty) : 0,
        balanceValue: round2(totalValue),
        negativeWarning: qty < 0,
      });
    }
  }

  return rows;
}

// =========================================================================
// D) buildStockCard — บัตรสต็อก (T69, 0.10) — mirror ตัวอย่างที่แนบ
// =========================================================================

export type StockCardRow = {
  /** null สำหรับแถวยอดยกมา (ไม่มี movement จริงให้ยกเลิก) */
  movementId: string | null;
  /** null สำหรับแถวยอดยกมา */
  movementType: StockMovementType | null;
  /** '' สำหรับแถวยอดยกมา */
  date: string;
  docLabel: string;
  reference: string | null;
  inQuantity: number | null;
  inUnitCost: number | null;
  inValue: number | null;
  outQuantity: number | null;
  outUnitCost: number | null;
  outValue: number | null;
  balanceQuantity: number;
  balanceUnitCost: number;
  balanceValue: number;
  negativeWarning: boolean;
};

const MOVEMENT_LABELS: Record<StockMovementType, string> = {
  purchase: "ซื้อ",
  sale: "ขาย",
  adjustment_in: "ปรับปรุงเพิ่ม",
  adjustment_out: "ปรับปรุงลด",
};

/** แปลงผล computeStockLedger เป็นแถวบัตรสต็อก (คอลัมน์ วันที่/รายการรับ/รายการจ่าย/คงเหลือ/เอกสารอ้างอิง) */
export function buildStockCard(ledgerRows: StockLedgerRow[]): StockCardRow[] {
  return ledgerRows.map((r) => ({
    movementId: r.movementId,
    movementType: r.movementType,
    date: r.date,
    docLabel: r.kind === "opening" ? "ยอดยกมา" : MOVEMENT_LABELS[r.movementType as StockMovementType],
    reference: r.memo,
    inQuantity: r.inQuantity,
    inUnitCost: r.inUnitCost,
    inValue: r.inValue,
    outQuantity: r.outQuantity,
    outUnitCost: r.outUnitCost,
    outValue: r.outValue,
    balanceQuantity: r.balanceQuantity,
    balanceUnitCost: r.balanceUnitCost,
    balanceValue: r.balanceValue,
    negativeWarning: r.negativeWarning,
  }));
}

// =========================================================================
// E) buildInventoryValuationReport — สินค้าคงเหลือแยกหมวด (T69, 0.10)
// =========================================================================

/** หมวด default เมื่อสินค้าไม่มี category (0.10) */
export const DEFAULT_PRODUCT_CATEGORY = "สินค้า";

export type ProductLedgerInput = {
  productId: string;
  productName: string;
  /** null/ว่าง → เข้ากลุ่ม default (0.10) */
  category: string | null;
  /** ผล computeStockLedger ของสินค้านี้ (คำนวณจากยอดยกมา+รายการเคลื่อนไหวล่าสุด) — ใช้แถวสุดท้ายเป็นยอด ณ วันนี้ */
  ledgerRows: StockLedgerRow[];
};

export type ProductStockSummary = {
  productId: string;
  productName: string;
  category: string;
  quantity: number;
  unitCost: number;
  value: number;
  negativeWarning: boolean;
};

export type InventoryValuationCategoryGroup = {
  category: string;
  items: ProductStockSummary[];
  totalValue: number;
};

export type InventoryValuationReport = {
  groups: InventoryValuationCategoryGroup[];
  grandTotalValue: number;
};

/** จัดกลุ่มยอดคงเหลือปัจจุบัน (แถวสุดท้ายของแต่ละ ledger) ตามหมวดสินค้า + รวมยอดต่อหมวด/รวมทั้งสิ้น (0.10) */
export function buildInventoryValuationReport(products: ProductLedgerInput[]): InventoryValuationReport {
  const groupMap = new Map<string, ProductStockSummary[]>();

  for (const p of products) {
    const last = p.ledgerRows.length > 0 ? p.ledgerRows[p.ledgerRows.length - 1] : null;
    const quantity = last ? last.balanceQuantity : 0;
    const unitCost = last ? last.balanceUnitCost : 0;
    const value = last ? last.balanceValue : 0;
    const negativeWarning = last ? last.negativeWarning : false;
    const category = p.category && p.category.trim() ? p.category.trim() : DEFAULT_PRODUCT_CATEGORY;

    const arr = groupMap.get(category) ?? [];
    arr.push({ productId: p.productId, productName: p.productName, category, quantity, unitCost, value, negativeWarning });
    groupMap.set(category, arr);
  }

  const groups: InventoryValuationCategoryGroup[] = [...groupMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "th"))
    .map(([category, items]) => ({
      category,
      items,
      totalValue: round2(items.reduce((s, i) => s + i.value, 0)),
    }));

  const grandTotalValue = round2(groups.reduce((s, g) => s + g.totalValue, 0));

  return { groups, grandTotalValue };
}

// =========================================================================
// F) data layer (DB) — T69
// =========================================================================

function toNum(v: number | string | null): number {
  if (v === null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

type RawMovement = {
  id: string;
  tenant_id: string;
  customer_id: string;
  product_id: string;
  movement_type: StockMovementType;
  quantity: number | string;
  unit_cost: number | string | null;
  source_bill_entry_line_id: string | null;
  memo: string | null;
  movement_date: string;
  created_at: string;
};

function mapMovement(r: RawMovement): StockMovement {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    productId: r.product_id,
    movementType: r.movement_type,
    quantity: toNum(r.quantity),
    unitCost: r.unit_cost === null ? null : toNum(r.unit_cost),
    sourceBillEntryLineId: r.source_bill_entry_line_id,
    memo: r.memo,
    movementDate: r.movement_date,
    createdAt: r.created_at,
  };
}

const MOVEMENT_SELECT =
  "id, tenant_id, customer_id, product_id, movement_type, quantity, unit_cost, source_bill_entry_line_id, memo, movement_date, created_at";

/** รายการเคลื่อนไหวทั้งหมดของสินค้า 1 ตัว (ยังไม่ลบ) — เรียงวันที่/created_at (0.5) ไม่ cache */
export async function listMovements(
  db: DB,
  tenantId: string,
  customerId: string,
  productId: string
): Promise<StockMovement[]> {
  const { data, error } = await db
    .from("product_stock_movements")
    .select(MOVEMENT_SELECT)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("product_id", productId)
    .is("deleted_at", null)
    .order("movement_date", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(LIST_LIMIT);
  if (error || !data) return [];
  return (data as unknown as RawMovement[]).map(mapMovement);
}

/** scope (customer_id/product_id) ของรายการเคลื่อนไหว 1 แถว — ใช้ตรวจสโคปก่อนลบที่ actions.ts ชั้นบน (0.13) */
export async function getMovementScope(
  db: DB,
  tenantId: string,
  movementId: string
): Promise<{ customerId: string; productId: string } | null> {
  const { data } = await db
    .from("product_stock_movements")
    .select("customer_id, product_id")
    .eq("id", movementId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as { customer_id: string; product_id: string };
  return { customerId: r.customer_id, productId: r.product_id };
}

/**
 * บันทึกปรับปรุงสต็อกมือ (0.9/T69) — เฉพาะ adjustment_in/adjustment_out เท่านั้น (purchase/sale มาจาก
 *   ปุ่ม manual-trigger ที่หน้ารายการบิลเท่านั้น — เฟส 8-Y, T70/71 ไม่อยู่ในสโคปไฟล์นี้รอบนี้)
 */
export async function createManualAdjustment(
  db: DB,
  tenantId: string,
  customerId: string,
  productId: string,
  input: {
    movementType: "adjustment_in" | "adjustment_out";
    quantity: unknown;
    unitCost?: unknown;
    movementDate: unknown;
    memo?: unknown;
  }
): Promise<StockActionResult> {
  if (input.movementType !== "adjustment_in" && input.movementType !== "adjustment_out") {
    return { ok: false, message: "ประเภทการปรับปรุงไม่ถูกต้อง" };
  }
  const v = validateMovementInput({
    movementType: input.movementType,
    quantity: input.quantity,
    unitCost: input.unitCost,
    movementDate: input.movementDate,
    memo: input.memo,
  });
  if (!v.ok) return { ok: false, message: v.message };

  const { data, error } = await db
    .from("product_stock_movements")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      product_id: productId,
      movement_type: v.value.movementType,
      quantity: v.value.quantity,
      unit_cost: v.value.unitCost,
      source_bill_entry_line_id: null,
      memo: v.value.memo,
      movement_date: v.value.movementDate,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "บันทึกปรับปรุงสต็อกไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: (data as { id: string }).id };
}

/** ยกเลิกรายการเคลื่อนไหว (soft-delete — 0.9 ใช้ตอนบิลต้นทางถูกแก้/ยกเลิกยืนยันหลังสร้าง movement ไปแล้ว) */
export async function softDeleteMovement(
  db: DB,
  tenantId: string,
  movementId: string
): Promise<StockActionResult> {
  const { error } = await db
    .from("product_stock_movements")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", movementId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ยกเลิกรายการสต็อกไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: movementId };
}

type RawOpeningBalance = {
  id: string;
  product_id: string;
  quantity: number | string;
  unit_cost: number | string;
  note: string | null;
};

export type ProductOpeningBalanceRow = OpeningBalance & { id: string; productId: string };

function mapOpeningBalance(r: RawOpeningBalance): ProductOpeningBalanceRow {
  return {
    id: r.id,
    productId: r.product_id,
    quantity: toNum(r.quantity),
    unitCost: toNum(r.unit_cost),
    note: r.note,
  };
}

/** ยอดยกมาสต็อกทั้งหมดของลูกค้า 1 ราย (0.11) — ไม่มีวันที่ */
export async function listProductOpeningBalances(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<ProductOpeningBalanceRow[]> {
  const { data, error } = await db
    .from("product_opening_balances")
    .select("id, product_id, quantity, unit_cost, note")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .limit(LIST_LIMIT);
  if (error || !data) return [];
  return (data as unknown as RawOpeningBalance[]).map(mapOpeningBalance);
}

/** ยอดยกมาสต็อกของสินค้า 1 ตัว (null = ยังไม่ตั้ง — computeStockLedger รับ null ได้ ถือว่าไม่มียอดยกมา) */
export async function getProductOpeningBalance(
  db: DB,
  tenantId: string,
  customerId: string,
  productId: string
): Promise<OpeningBalance | null> {
  const { data } = await db
    .from("product_opening_balances")
    .select("quantity, unit_cost, note")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("product_id", productId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as { quantity: number | string; unit_cost: number | string; note: string | null };
  return { quantity: toNum(r.quantity), unitCost: toNum(r.unit_cost), note: r.note };
}

// =========================================================================
// G) createMovementsFromBill — เชื่อมกับบิลที่ยืนยันแล้ว (เฟส 8 ส่วน Y, T70, 0.7/0.8/0.9)
// =========================================================================

export type CreateMovementsFromBillResult =
  | { ok: true; created: number; skippedLineIds: string[] }
  | { ok: false; message: string };

type RawBillEntryForStock = {
  id: string;
  customer_id: string | null;
  entry_type: string;
  status: string;
  doc_date: string | null;
  doc_no: string | null;
};

type RawBillLineForStock = {
  id: string;
  product_id: string | null;
  quantity: number | string | null;
  amount: number | string | null;
};

/**
 * สร้างรายการเคลื่อนไหวสต็อกจากบิลที่ยืนยันแล้ว 1 ใบ (0.7 — เฉพาะ `bill_entries` ที่ `status='confirmed'`
 *   และ `entry_type` เป็น `sale`/`purchase` เท่านั้น) — กรองเฉพาะบรรทัดที่มีทั้ง `product_id`+`quantity`
 *   ครบ (quantity>0) บรรทัดที่ไม่ครบ**ข้าม**ไม่สร้าง movement (คืนรายชื่อไว้ใน `skippedLineIds`)
 *   - `entry_type='purchase'` → สร้าง movement type `'purchase'` (IN) ต่อบรรทัด, `unit_cost =
 *     amount/quantity` (ต้นทุนต่อหน่วยจากยอดเงินหารจำนวน)
 *   - `entry_type='sale'` → สร้าง movement type `'sale'` (OUT) ต่อบรรทัด, ไม่มี `unit_cost` (ใช้
 *     moving-average ตอน replay — ดู computeStockLedger)
 *
 * ★ 0.8 กันกดซ้ำสร้างซ้ำสอง (double-click/สองแท็บ) — atomic claim ด้วย
 *   `UPDATE bill_entries SET stock_synced_at=now() WHERE id=... AND tenant_id=... AND
 *   stock_synced_at IS NULL RETURNING id` (1 คำสั่ง SQL, mirror flowaccount_sync_log claim) —
 *   claim ไม่ได้แถวกลับมา = มีคนกดไปแล้ว → ปฏิเสธ ไม่สร้างซ้ำ
 *   ★ guard ธุรกิจ (confirmed/entry_type/มีลูกค้า/มีวันที่เอกสาร/มีบรรทัดที่ครบเงื่อนไข) ทำก่อน claim
 *     เสมอ — กันเสีย claim ไปเปล่า ๆ กับบิลที่สร้างไม่ได้แน่ ๆ (mirror syncEntryToFlowAccount)
 *   ★ ถ้า insert movement ล้มเหลวหลัง claim สำเร็จ — คืน claim (ตั้ง stock_synced_at กลับเป็น null)
 *     ให้กดสร้างใหม่ได้ ไม่ค้างสถานะ "claimed แต่ไม่มี movement" ค้างไว้เงียบ ๆ
 * ★ ไม่ import journal.ts/ledger.ts/statements.ts/manual-journal.ts เลย — ไม่มี write path กระทบ
 *   บัญชีแยกประเภท/งบการเงินเลยแม้แต่จุดเดียว (0.6)
 */
export async function createMovementsFromBill(
  db: DB,
  tenantId: string,
  entryId: string
): Promise<CreateMovementsFromBillResult> {
  const { data: entryData, error: entryErr } = await db
    .from("bill_entries")
    .select("id, customer_id, entry_type, status, doc_date, doc_no")
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (entryErr || !entryData) return { ok: false, message: "ไม่พบบิลนี้ (อาจถูกลบไปแล้ว)" };
  const entry = entryData as unknown as RawBillEntryForStock;

  if (entry.entry_type !== "sale" && entry.entry_type !== "purchase") {
    return { ok: false, message: "บิลประเภทนี้ยังไม่รองรับการบันทึกสต็อก (ต้องเป็นบิลซื้อหรือขายเท่านั้น)" };
  }
  if (entry.status !== "confirmed") {
    return { ok: false, message: "บิลต้องยืนยันก่อนถึงจะบันทึกรับ/จ่ายสต็อกได้" };
  }
  if (!entry.customer_id) {
    return { ok: false, message: "บิลนี้ยังไม่ผูกลูกค้า" };
  }
  if (!entry.doc_date || !isValidCalendarDate(entry.doc_date)) {
    return { ok: false, message: "บิลนี้ยังไม่มีวันที่เอกสารที่ถูกต้อง" };
  }
  const movementType: "purchase" | "sale" = entry.entry_type;
  const customerId = entry.customer_id;
  const movementDate = entry.doc_date;

  const { data: lineData, error: lineErr } = await db
    .from("bill_entry_lines")
    .select("id, product_id, quantity, amount")
    .eq("tenant_id", tenantId)
    .eq("entry_id", entryId)
    .order("line_no", { ascending: true });
  if (lineErr) return { ok: false, message: "โหลดรายการบิลไม่สำเร็จ กรุณาลองใหม่" };

  const rawLines = (lineData ?? []) as unknown as RawBillLineForStock[];
  const skippedLineIds: string[] = [];
  const eligible: { lineId: string; productId: string; quantity: number; amount: number }[] = [];

  for (const l of rawLines) {
    const qty = l.quantity === null ? null : toNum(l.quantity);
    if (
      l.product_id &&
      qty !== null &&
      qty > 0 &&
      qty <= QTY_MAX &&
      (movementType !== "purchase" || (toNum(l.amount) / qty <= UNIT_COST_MAX && toNum(l.amount) >= 0))
    ) {
      eligible.push({ lineId: l.id, productId: l.product_id, quantity: qty, amount: toNum(l.amount) });
    } else {
      skippedLineIds.push(l.id);
    }
  }

  if (eligible.length === 0) {
    return { ok: false, message: "บิลนี้ไม่มีบรรทัดที่ผูกสินค้า+จำนวนครบ ไม่สามารถบันทึกสต็อกได้" };
  }

  // ★ 0.8 — atomic claim (1 UPDATE...WHERE...RETURNING) กันกดซ้ำสร้างซ้ำสอง
  const { data: claimed, error: claimErr } = await db
    .from("bill_entries")
    .update({ stock_synced_at: new Date().toISOString() })
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .is("stock_synced_at", null)
    .select("id")
    .maybeSingle();
  if (claimErr || !claimed) {
    return { ok: false, message: "สร้างรายการสต็อกไปแล้ว" };
  }

  const memoLabel =
    movementType === "purchase"
      ? entry.doc_no ? `รับจากบิลซื้อ ${entry.doc_no}` : "รับจากบิลซื้อ"
      : entry.doc_no ? `จ่ายจากบิลขาย ${entry.doc_no}` : "จ่ายจากบิลขาย";
  const memo = clampText(memoLabel, MEMO_MAX);

  const rows = eligible.map((l) => ({
    tenant_id: tenantId,
    customer_id: customerId,
    product_id: l.productId,
    movement_type: movementType,
    quantity: round2(l.quantity),
    unit_cost: movementType === "purchase" ? round3(l.amount / l.quantity) : null,
    source_bill_entry_line_id: l.lineId,
    memo,
    movement_date: movementDate,
  }));

  const { error: insertErr } = await db.from("product_stock_movements").insert(rows);
  if (insertErr) {
    // ★ คืน claim ให้กดสร้างใหม่ได้ — กันค้างสถานะ "claimed แต่ไม่มี movement" เงียบ ๆ
    await db
      .from("bill_entries")
      .update({ stock_synced_at: null })
      .eq("id", entryId)
      .eq("tenant_id", tenantId);
    return { ok: false, message: "บันทึกรายการสต็อกไม่สำเร็จ กรุณาลองใหม่" };
  }

  return { ok: true, created: rows.length, skippedLineIds };
}

/**
 * ตั้ง/แก้ยอดยกมาสต็อก 1 สินค้า ของลูกค้า (0.11) — select-then-update/insert (pattern เดียวกับ
 *   upsertOpeningBalanceAction::account_opening_balances เดิม — unique index เป็น partial ไม่ใช้
 *   .upsert()/onConflict ตรง ๆ)
 */
export async function upsertProductOpeningBalance(
  db: DB,
  tenantId: string,
  customerId: string,
  productId: string,
  input: { quantity: unknown; unitCost: unknown; note?: unknown }
): Promise<StockActionResult> {
  const v = validateOpeningBalanceInput(input);
  if (!v.ok) return { ok: false, message: v.message };

  const { data: cur } = await db
    .from("product_opening_balances")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("product_id", productId)
    .is("deleted_at", null)
    .maybeSingle();

  if (cur) {
    const id = (cur as { id: string }).id;
    const { error } = await db
      .from("product_opening_balances")
      .update({ quantity: v.value.quantity, unit_cost: v.value.unitCost, note: v.value.note })
      .eq("id", id)
      .eq("tenant_id", tenantId);
    if (error) return { ok: false, message: "บันทึกยอดยกมาไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, id };
  }

  const { data, error } = await db
    .from("product_opening_balances")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      product_id: productId,
      quantity: v.value.quantity,
      unit_cost: v.value.unitCost,
      note: v.value.note,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "เพิ่มยอดยกมาไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: (data as { id: string }).id };
}
