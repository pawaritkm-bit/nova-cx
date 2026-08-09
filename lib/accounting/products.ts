/**
 * สินค้า/บริการ (products) — data layer (DB) + validate/CRUD + pure search
 *
 * บริบท: เฟส 1 ส่วน B (docs/06-accounting-features-roadmap.md) — Product Master ต่อ tenant
 *   ใช้เป็นตัวช่วย prefill (description + account_code) ในบรรทัดบิล ผ่าน product_id ที่ผูกไว้บน
 *   bill_entry_lines (migration 0065) — ★ ไม่กระทบ engine บัญชีเลย (journal/ledger/statements
 *   ยังคำนวณจาก amount/vat/wht ต่อบรรทัดเหมือนเดิมทุกอย่าง — ไฟล์นี้ไม่ import จากไฟล์ engine เหล่านั้น)
 *
 * ★ ทุก query/write กรอง tenant_id (จาก session — ห้ามรับจาก client)
 * ★ soft-delete (deleted_at) — ไม่ลบจริง (pattern เดิมทั้งระบบ)
 * ★ default_account_code เก็บเป็นข้อความตรงตัวกับ chart_of_accounts.code (ไม่ใช่ FK จริง — เหมือน
 *   bill_entry_lines.account_code เดิม) — ไฟล์นี้ไม่ validate ว่ารหัสมีอยู่ในผังจริงไหม (ผู้เรียกที่มีผัง
 *   ในมือ เช่น หน้า admin จัดการสินค้า ทำหน้าที่นั้นด้วย dropdown ที่จำกัดตัวเลือกให้เลือกจากผังอยู่แล้ว)
 * ★ PDPA: ไม่ log ชื่อ/ราคาสินค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

/** เพดานความยาว (กัน payload ใหญ่ผิดปกติ) */
export const SKU_MAX = 60;
export const NAME_MAX = 200;
export const UNIT_MAX = 30;
export const ACCOUNT_CODE_MAX = 20;
/** เพดานราคา (กันค่าเวอร์ผิดปกติ — ธุรกิจ SME ทั่วไปไม่เกินนี้) */
export const PRICE_MAX = 1_000_000_000;

/** เพดานแถว (สินค้า/บริการไม่ควรเกินหลักพัน — กันดึงเวอร์) */
const LIMIT = 5000;

/** สินค้า/บริการ 1 รายการ ที่ใช้งานได้จริง (สำหรับ picker/prefill) */
export type Product = {
  id: string;
  sku: string | null;
  name: string;
  unit: string | null;
  defaultPrice: number | null;
  /** รหัสบัญชีเริ่มต้น (ตรงตัวกับ chart_of_accounts.code) — null = ยังไม่ผูก */
  defaultAccountCode: string | null;
};

/** แถวสินค้าสำหรับหน้า admin (มี isActive เพิ่มจาก Product) */
export type ProductRow = Product & { isActive: boolean };

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline */
export type ProductActionResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

function normText(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** ข้อความว่าง → null (sku/unit/account_code เป็น optional — เก็บ null ถ้าไม่กรอก) */
function normOptionalText(v: unknown, max: number): string | null {
  const s = normText(v, max);
  return s || null;
}

/** ราคา: ตัวเลข >= 0 เท่านั้น · ค่าอื่น (ว่าง/ติดลบ/NaN) → null (ไม่ตั้งราคาเริ่มต้น) */
function normPrice(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(Math.min(n, PRICE_MAX) * 100) / 100;
}

function num(v: number | string | null): number | null {
  if (v === null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

type RawProduct = {
  id: string;
  sku: string | null;
  name: string;
  unit: string | null;
  default_price: number | string | null;
  default_account_code: string | null;
};

function mapProduct(r: RawProduct): Product {
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    unit: r.unit,
    defaultPrice: num(r.default_price),
    defaultAccountCode: r.default_account_code,
  };
}

/**
 * ดึงสินค้า "ที่ใช้งานได้จริง" ของ tenant (is_active + ไม่ถูกลบ) เรียงตามชื่อ
 *   ★ ใช้โดย EntryEditor (product picker ต่อบรรทัด) — โหลดครั้งเดียวต่อ request
 *   คืน [] ถ้าไม่มี/query พลาด (ไม่ throw — ผู้เรียก degrade เอง เหมือน listChartOfAccounts)
 */
export async function listProducts(db: DB, tenantId: string): Promise<Product[]> {
  const { data, error } = await db
    .from("products")
    .select("id, sku, name, unit, default_price, default_account_code")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .limit(LIMIT);
  if (error || !data) return [];
  return (data as RawProduct[]).map(mapProduct);
}

/** ดึงสินค้าทั้งหมดของ tenant (รวม inactive แต่ไม่รวมที่ลบแล้ว) — ใช้หน้า admin list+CRUD */
export async function listProductsAdmin(db: DB, tenantId: string): Promise<ProductRow[]> {
  const { data, error } = await db
    .from("products")
    .select("id, sku, name, unit, default_price, default_account_code, is_active")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .limit(LIMIT);
  if (error || !data) return [];
  return (data as (RawProduct & { is_active: boolean })[]).map((r) => ({
    ...mapProduct(r),
    isActive: r.is_active,
  }));
}

/** ค้นสินค้าแบบ substring (ชื่อ/sku) — pure, ใช้ใน combobox ของ EntryEditor */
export function searchProducts(list: Product[], q: string): Product[] {
  const s = (q ?? "").trim().toLowerCase();
  if (!s) return list;
  return list.filter(
    (p) => p.name.toLowerCase().includes(s) || (p.sku ?? "").toLowerCase().includes(s)
  );
}

/** input ที่ validate แล้ว (ก่อนเขียน DB) */
export type ValidatedProductInput = {
  sku: string | null;
  name: string;
  unit: string | null;
  defaultPrice: number | null;
  defaultAccountCode: string | null;
};

/**
 * validate input สร้าง/แก้สินค้า — คืน null ถ้าไม่ผ่าน (ชื่อว่าง/ราคาติดลบ/ผิดรูป)
 *   ★ ไม่เช็ค sku ซ้ำในนี้ (ซ้ำในผังเดียวกันชนที่ unique index ของ DB → error 23505 ให้ caller แปลข้อความ)
 *   ★ ราคาติดลบ/ไม่ใช่ตัวเลข → ปฏิเสธทั้ง input (ไม่ silent ทิ้งเป็น null) ต่างจาก normPrice ที่ใช้ตอนไม่ต้อง
 *     บังคับ — ที่นี่ "ถ้ากรอกราคามา" ต้องเป็นตัวเลข >= 0 เท่านั้น ถ้ากรอกแล้วผิด (เช่น -5) ต้องถูกปฏิเสธ
 */
export function validateProductInput(input: {
  sku?: unknown;
  name: unknown;
  unit?: unknown;
  defaultPrice?: unknown;
  defaultAccountCode?: unknown;
}): ValidatedProductInput | null {
  const name = normText(input.name, NAME_MAX);
  if (!name) return null;

  // ราคา: ถ้าไม่กรอก (ว่าง/undefined/null) → null (ไม่บังคับ) · กรอกแล้วต้องเป็นตัวเลข >= 0
  const rawPrice = input.defaultPrice;
  let defaultPrice: number | null = null;
  if (rawPrice !== undefined && rawPrice !== null && rawPrice !== "") {
    const n = typeof rawPrice === "number" ? rawPrice : Number(rawPrice);
    if (!Number.isFinite(n) || n < 0) return null; // กรอกมาแต่ผิด → ปฏิเสธทั้ง input
    defaultPrice = Math.round(Math.min(n, PRICE_MAX) * 100) / 100;
  }

  return {
    sku: normOptionalText(input.sku, SKU_MAX),
    name,
    unit: normOptionalText(input.unit, UNIT_MAX),
    defaultPrice,
    defaultAccountCode: normOptionalText(input.defaultAccountCode, ACCOUNT_CODE_MAX),
  };
}

/** สร้างสินค้าใหม่ (tenant นี้) */
export async function createProduct(
  db: DB,
  tenantId: string,
  input: { sku?: unknown; name: unknown; unit?: unknown; defaultPrice?: unknown; defaultAccountCode?: unknown }
): Promise<ProductActionResult> {
  const v = validateProductInput(input);
  if (!v) return { ok: false, message: "กรุณากรอกชื่อสินค้า/บริการ (และตรวจว่าราคาไม่ติดลบ)" };

  const { data, error } = await db
    .from("products")
    .insert({
      tenant_id: tenantId,
      sku: v.sku,
      name: v.name,
      unit: v.unit,
      default_price: v.defaultPrice,
      default_account_code: v.defaultAccountCode,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "23505") return { ok: false, message: "รหัสสินค้า (SKU) นี้มีอยู่แล้ว" };
    return { ok: false, message: "เพิ่มสินค้าไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id: (data as { id: string }).id };
}

/** แก้สินค้าเดิม (scope tenant) */
export async function updateProduct(
  db: DB,
  tenantId: string,
  id: string,
  input: { sku?: unknown; name: unknown; unit?: unknown; defaultPrice?: unknown; defaultAccountCode?: unknown }
): Promise<ProductActionResult> {
  const v = validateProductInput(input);
  if (!v) return { ok: false, message: "กรุณากรอกชื่อสินค้า/บริการ (และตรวจว่าราคาไม่ติดลบ)" };

  const { error } = await db
    .from("products")
    .update({
      sku: v.sku,
      name: v.name,
      unit: v.unit,
      default_price: v.defaultPrice,
      default_account_code: v.defaultAccountCode,
    })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") return { ok: false, message: "รหัสสินค้า (SKU) นี้มีอยู่แล้ว" };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id };
}

/** สลับ is_active (ปิดใช้งานชั่วคราว/เปิดกลับ) — ไม่ใช่ลบ */
export async function setProductActive(
  db: DB,
  tenantId: string,
  id: string,
  isActive: boolean
): Promise<ProductActionResult> {
  const { error } = await db
    .from("products")
    .update({ is_active: isActive })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

/**
 * ลบสินค้า (soft-delete) — บรรทัดบิลเก่าที่ผูก product_id ไว้ไม่หาย (product_id ยังชี้ id เดิมได้ —
 *   UI แค่ไม่โชว์สินค้านี้ในตัวเลือกใหม่)
 */
export async function softDeleteProduct(
  db: DB,
  tenantId: string,
  id: string
): Promise<ProductActionResult> {
  const { error } = await db
    .from("products")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}
