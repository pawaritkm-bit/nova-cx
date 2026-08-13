/**
 * หลายหน่วยนับต่อสินค้า (Product Units) — data layer (DB) + validate/CRUD + pure convert
 *
 * บริบท: wishlist backlog ข้อ 2 — สินค้า 1 รายการมี "หน่วยหลัก" (products.unit เดิม, ไม่แตะ) +
 *   เพิ่ม "หน่วยอื่น" ได้ต่อสินค้า (เช่น โหล/ลัง) พร้อม factorToBase (จำนวนหน่วยหลักต่อ 1 หน่วยนี้)
 *
 * ★ ไม่กระทบ engine บัญชีเลย (journal/ledger/statements ไม่ import ไฟล์นี้) — ใช้แค่แปลงจำนวนก่อน
 *   บันทึกสต็อก (product-stock.ts::createMovementsFromBill) เท่านั้น
 * ★ ทุก query/write กรอง tenant_id (จาก session — ห้ามรับจาก client)
 * ★ soft-delete (deleted_at) — ไม่ลบจริง (pattern เดิมทั้งระบบ) — บรรทัดบิลเก่าที่ผูก unit_id ไว้ไม่หาย
 * ★ PDPA: ไม่ log ชื่อหน่วย/ตัวคูณ
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

export const UNIT_NAME_MAX = 30;
/** เพดานตัวคูณ (กันกรอกผิดเวอร์ — ธุรกิจ SME ทั่วไปไม่เกินนี้) */
export const FACTOR_MAX = 100_000;
/** เพดานแถวต่อสินค้า (หน่วยนับไม่ควรเกินหลักสิบ — กันดึงเวอร์) */
const LIMIT = 500;

export type ProductUnit = {
  id: string;
  tenantId: string;
  productId: string;
  unitName: string;
  factorToBase: number;
  createdAt: string;
  updatedAt: string;
};

export type ProductUnitActionResult = { ok: true; id: string } | { ok: false; message: string };

/** สโคปของหน่วยนับ 1 แถว (ใช้ตรวจสิทธิ์ก่อนเขียนทุกครั้ง — IDOR guard) */
export type ProductUnitScope = { productId: string };

function num(v: number | string): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

type RawProductUnit = {
  id: string;
  tenant_id: string;
  product_id: string;
  unit_name: string;
  factor_to_base: number | string;
  created_at: string;
  updated_at: string;
};

function mapProductUnit(r: RawProductUnit): ProductUnit {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    productId: r.product_id,
    unitName: r.unit_name,
    factorToBase: num(r.factor_to_base),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = "id, tenant_id, product_id, unit_name, factor_to_base, created_at, updated_at";

/** หน่วยนับเพิ่มเติมของสินค้า 1 รายการ (ไม่รวมหน่วยหลัก — ดู products.unit) เรียงตามชื่อ */
export async function listProductUnits(db: DB, tenantId: string, productId: string): Promise<ProductUnit[]> {
  const { data, error } = await db
    .from("product_units")
    .select(COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("product_id", productId)
    .is("deleted_at", null)
    .order("unit_name", { ascending: true })
    .limit(LIMIT);
  if (error || !data) return [];
  return (data as unknown as RawProductUnit[]).map(mapProductUnit);
}

/**
 * หน่วยนับเพิ่มเติมของสินค้าหลายรายการพร้อมกัน (bulk) — ใช้โหลดครั้งเดียวต่อ request ส่งลง
 *   EntryEditor (dropdown เลือกหน่วยต่อบรรทัด, mirror listProducts) คืน [] ถ้า productIds ว่าง
 */
export async function listProductUnitsForProducts(
  db: DB,
  tenantId: string,
  productIds: string[]
): Promise<Map<string, ProductUnit[]>> {
  const map = new Map<string, ProductUnit[]>();
  if (productIds.length === 0) return map;
  const { data, error } = await db
    .from("product_units")
    .select(COLUMNS)
    .eq("tenant_id", tenantId)
    .in("product_id", productIds)
    .is("deleted_at", null)
    .order("unit_name", { ascending: true })
    .limit(LIMIT * productIds.length);
  if (error || !data) return map;
  for (const r of (data as unknown as RawProductUnit[]).map(mapProductUnit)) {
    const arr = map.get(r.productId);
    if (arr) arr.push(r);
    else map.set(r.productId, [r]);
  }
  return map;
}

/**
 * product_id + factorToBase ของหน่วยนับหลาย id พร้อมกัน (bulk) — id ที่ไม่พบ/ถูกลบไปแล้ว/นอก tenant
 *   → ไม่อยู่ใน map (ผู้เรียก fallback เอง) ★ ไม่กรอง deleted_at ตั้งใจ (ดู softDeleteProductUnit)
 *   — ใช้ทั้งตอน validate unit_id ของบรรทัดบิล (ต้องเป็นหน่วยของ product_id เดียวกันเท่านั้น กัน client
 *   ส่ง unit_id ของสินค้าอื่นมาให้ตัวคูณผิด) และตอนสร้าง stock movement (createMovementsFromBill)
 */
export async function getProductUnitsByIds(
  db: DB,
  tenantId: string,
  unitIds: string[]
): Promise<Map<string, { productId: string; factorToBase: number }>> {
  const map = new Map<string, { productId: string; factorToBase: number }>();
  if (unitIds.length === 0) return map;
  const { data, error } = await db
    .from("product_units")
    .select("id, product_id, factor_to_base")
    .eq("tenant_id", tenantId)
    .in("id", unitIds);
  if (error || !data) return map;
  for (const r of data as unknown as { id: string; product_id: string; factor_to_base: number | string }[]) {
    map.set(r.id, { productId: r.product_id, factorToBase: num(r.factor_to_base) });
  }
  return map;
}

/** factorToBase อย่างเดียว (ไม่ต้องเช็ค product_id) — ใช้ตอนสร้าง stock movement (unit_id ผ่าน validate มาแล้วตอนบันทึกบรรทัด) */
export async function getProductUnitFactors(db: DB, tenantId: string, unitIds: string[]): Promise<Map<string, number>> {
  const byId = await getProductUnitsByIds(db, tenantId, unitIds);
  const map = new Map<string, number>();
  for (const [id, v] of byId) map.set(id, v.factorToBase);
  return map;
}

export async function getProductUnitScope(db: DB, tenantId: string, id: string): Promise<ProductUnitScope | null> {
  const { data } = await db
    .from("product_units")
    .select("product_id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  return { productId: (data as { product_id: string }).product_id };
}

/** input ที่ validate แล้ว (ก่อนเขียน DB) */
export type ValidatedProductUnitInput = { unitName: string; factorToBase: number };

/**
 * validate input สร้าง/แก้หน่วยนับ — คืน null ถ้าไม่ผ่าน (ชื่อว่าง/ตัวคูณไม่ใช่ตัวเลข>0)
 *   ★ ไม่เช็คชื่อซ้ำในนี้ (ซ้ำในสินค้าเดียวกันชนที่ unique index ของ DB → error 23505 ให้ caller แปลข้อความ)
 */
export function validateProductUnitInput(input: { unitName: unknown; factorToBase: unknown }): ValidatedProductUnitInput | null {
  const unitName = typeof input.unitName === "string" ? input.unitName.trim().slice(0, UNIT_NAME_MAX) : "";
  if (!unitName) return null;

  const raw = input.factorToBase;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const factorToBase = Math.round(Math.min(n, FACTOR_MAX) * 10000) / 10000;

  return { unitName, factorToBase };
}

/** สร้างหน่วยนับใหม่ให้สินค้า 1 รายการ */
export async function createProductUnit(
  db: DB,
  tenantId: string,
  productId: string,
  input: { unitName: unknown; factorToBase: unknown }
): Promise<ProductUnitActionResult> {
  const v = validateProductUnitInput(input);
  if (!v) return { ok: false, message: "กรุณากรอกชื่อหน่วยนับ และตัวคูณเทียบหน่วยหลักต้องมากกว่า 0" };

  const { data, error } = await db
    .from("product_units")
    .insert({ tenant_id: tenantId, product_id: productId, unit_name: v.unitName, factor_to_base: v.factorToBase })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "23505") return { ok: false, message: "สินค้านี้มีหน่วยนับชื่อนี้อยู่แล้ว" };
    return { ok: false, message: "เพิ่มหน่วยนับไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id: (data as { id: string }).id };
}

/** แก้หน่วยนับเดิม (scope tenant — ผู้เรียกต้อง getProductUnitScope + ตรวจสิทธิ์สินค้าเจ้าของก่อนเสมอ) */
export async function updateProductUnit(
  db: DB,
  tenantId: string,
  id: string,
  input: { unitName: unknown; factorToBase: unknown }
): Promise<ProductUnitActionResult> {
  const v = validateProductUnitInput(input);
  if (!v) return { ok: false, message: "กรุณากรอกชื่อหน่วยนับ และตัวคูณเทียบหน่วยหลักต้องมากกว่า 0" };

  const { error } = await db
    .from("product_units")
    .update({ unit_name: v.unitName, factor_to_base: v.factorToBase })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") return { ok: false, message: "สินค้านี้มีหน่วยนับชื่อนี้อยู่แล้ว" };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id };
}

/**
 * ลบหน่วยนับ (soft-delete) — บรรทัดบิลเก่าที่ผูก unit_id ไว้ไม่หาย (unit_id ยังชี้ id เดิมได้ —
 *   UI แค่ไม่โชว์หน่วยนี้ในตัวเลือกใหม่ · getProductUnitFactors ยังคืน factor เดิมให้บรรทัดเก่าที่อ้างถึง
 *   เพราะไม่ได้กรอง deleted_at — คงเดิมไว้ตั้งใจ กันบิลเก่าคำนวณสต็อกผิดเพราะหน่วยถูกลบไปแล้ว)
 */
export async function softDeleteProductUnit(db: DB, tenantId: string, id: string): Promise<ProductUnitActionResult> {
  const { error } = await db
    .from("product_units")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

/** แปลงจำนวนที่กรอกเป็น "หน่วยหลัก" — pure, factor=1 (unit_id=null/ไม่พบ) = ค่าเดิมไม่แปลง */
export function convertQuantityToBase(quantity: number, factorToBase: number): number {
  return Math.round(quantity * factorToBase * 100) / 100;
}
