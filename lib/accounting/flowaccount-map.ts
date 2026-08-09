/**
 * mapping ผังบัญชี/สินค้า nova-cx ↔ FlowAccount ต่อลูกค้า — data layer (CRUD) + helper pure
 *
 * บริบท: เฟส 5 ส่วน Q (docs/06-accounting-features-roadmap.md) — ผังบัญชี/สินค้า (chart_of_accounts/
 *   products, migration 0063/0064) เป็น tenant-wide แต่ FlowAccount ของแต่ละลูกค้าเป็นบัญชีแยกกันจริง
 *   (credential ต่อลูกค้า M2) → รหัสฝั่ง FlowAccount ของแต่ละลูกค้าไม่จำเป็นตรงกัน → mapping จึง scope
 *   ต่อ (tenant_id, customer_id) เสมอ (decision 0.9) — ตาราง flowaccount_account_map/flowaccount_product_map
 *   (migration 0071)
 *
 * ★ ทุก query/write กรอง tenant_id (จาก session — ห้ามรับจาก client) + customer_id
 * ★ ไม่ soft-delete (decision 0.10) — เป็น config lookup ธรรมดา ลบแถวจริงได้เลย
 * ★ กรอกแบบ manual text-entry (decision 0.12) — validate ความยาว/ไม่ว่าง ไม่ live-fetch จาก FlowAccount
 *   ★ ยกเว้น flowaccountProductId (รหัสสินค้าฝั่ง FlowAccount) ต้องเป็น "ตัวเลขล้วน" เท่านั้น (บั๊กที่พบใน
 *     code review เฟส 5: FlowAccount เก็บ product id เป็นตัวเลขเสมอ — ดู lib/integrations/flowaccount-mapper.ts
 *     buildLineItems ที่ Number(...) ค่านี้ตรงๆ ถ้าพิมพ์ผิด/มีตัวอักษรปนจะได้ NaN → fallback เป็น id:0 เงียบๆ
 *     เหมือนไม่ได้ตั้ง mapping เลย โดยไม่มี error แจ้ง) → ปฏิเสธตั้งแต่ตอนบันทึกแทน ไม่รับ "0" ด้วยเพราะ 0
 *     ชนกับค่า fallback "ไม่มี mapping" ของ buildLineItems พอดี (ตั้งเป็น 0 จะดูเหมือนไม่ได้ mapping)
 * ★ degrade อย่างสุภาพถ้ายังไม่ apply migration 0071 (list → [] , upsert/delete → { ok:false, message }) —
 *   ไม่ throw ทะลุ (เหมือน listChartOfAccounts/listOpeningBalances)
 * ★ PDPA: ไม่ log รหัสบัญชี/รหัสสินค้า/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

/** เพดานความยาว (กัน payload ใหญ่ผิดปกติ) */
export const ACCOUNT_CODE_MAX = 20;
export const FLOWACCOUNT_ACCOUNT_CODE_MAX = 60;
export const FLOWACCOUNT_PRODUCT_ID_MAX = 60;

/** เพดานแถว (mapping ต่อลูกค้าไม่ควรเยอะ — กันดึงเวอร์) */
const LIMIT = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/**
 * รหัสสินค้าฝั่ง FlowAccount ต้องเป็นเลขจำนวนเต็มบวกล้วน (ไม่รับ 0/ติดลบ/ทศนิยม/เว้นวรรคคั่น/ตัวอักษรปน)
 *   — FlowAccount เก็บ product id เป็นตัวเลขเสมอ และ 0 ถูกใช้เป็นค่า fallback "ไม่มี mapping" ใน
 *   buildLineItems (lib/integrations/flowaccount-mapper.ts) จึงห้ามใช้ 0 เป็นค่า mapping จริงด้วย
 */
const FLOWACCOUNT_PRODUCT_ID_RE = /^[1-9]\d*$/;

function isFlowAccountProductId(v: string): boolean {
  return FLOWACCOUNT_PRODUCT_ID_RE.test(v);
}

function normText(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** 1 แถว mapping ผังบัญชี (nova-cx account_code → รหัสบัญชีฝั่ง FlowAccount ของลูกค้ารายนี้) */
export type AccountMapRow = {
  id: string;
  accountCode: string;
  flowaccountAccountCode: string;
};

/** 1 แถว mapping สินค้า/บริการ (nova-cx product_id → id สินค้าฝั่ง FlowAccount ของลูกค้ารายนี้) */
export type ProductMapRow = {
  id: string;
  productId: string;
  flowaccountProductId: string;
};

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline */
export type FlowAccountMapResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

// ---------------------------------------------------------------------
// mapping ผังบัญชี
// ---------------------------------------------------------------------

type RawAccountMap = { id: string; account_code: string; flowaccount_account_code: string };

/**
 * ดึง mapping ผังบัญชีของลูกค้า 1 ราย (scope tenant + customer) — เรียงตามรหัสบัญชี
 *   คืน [] ถ้าไม่มี/ผิดพลาด (รวมกรณียังไม่ apply migration 0071 — ไม่ throw)
 */
export async function listAccountMap(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<AccountMapRow[]> {
  const { data, error } = await db
    .from("flowaccount_account_map")
    .select("id, account_code, flowaccount_account_code")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .order("account_code", { ascending: true })
    .limit(LIMIT);
  if (error || !data) return [];
  return (data as RawAccountMap[]).map((r) => ({
    id: r.id,
    accountCode: r.account_code,
    flowaccountAccountCode: r.flowaccount_account_code,
  }));
}

/**
 * บันทึก mapping ผังบัญชี 1 รายการของลูกค้า — ทับแถวเดิมถ้ามีอยู่แล้ว (unique tenant+customer+account_code)
 *   ไม่ insert ซ้ำ · validate ค่าว่าง/ยาวเกิน (decision 0.12) → ปฏิเสธก่อนแตะ DB
 */
export async function upsertAccountMap(
  db: DB,
  tenantId: string,
  customerId: string,
  accountCode: string,
  flowaccountAccountCode: string
): Promise<FlowAccountMapResult> {
  const code = normText(accountCode, ACCOUNT_CODE_MAX);
  if (!code) return { ok: false, message: "กรุณาระบุรหัสบัญชี" };
  const faCode = normText(flowaccountAccountCode, FLOWACCOUNT_ACCOUNT_CODE_MAX);
  if (!faCode) return { ok: false, message: "กรุณาระบุรหัสบัญชีฝั่ง FlowAccount" };
  if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };

  const { data: cur } = await db
    .from("flowaccount_account_map")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("account_code", code)
    .maybeSingle();

  if (cur) {
    const id = (cur as { id: string }).id;
    const { error } = await db
      .from("flowaccount_account_map")
      .update({ flowaccount_account_code: faCode })
      .eq("id", id)
      .eq("tenant_id", tenantId);
    if (error) return { ok: false, message: "บันทึก mapping ผังบัญชีไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, id };
  }

  const { data, error } = await db
    .from("flowaccount_account_map")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      account_code: code,
      flowaccount_account_code: faCode,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    const errCode = (error as { code?: string } | null)?.code;
    if (errCode === "23505") return { ok: false, message: "รหัสบัญชีนี้ถูกตั้ง mapping ไว้แล้ว กรุณาลองใหม่" };
    return {
      ok: false,
      message: "บันทึก mapping ผังบัญชีไม่สำเร็จ กรุณาลองใหม่ (อาจยังไม่ apply migration 0071)",
    };
  }
  return { ok: true, id: (data as { id: string }).id };
}

/** ลบ mapping ผังบัญชี 1 รายการ (scope tenant — ผู้เรียกตรวจสโคปลูกค้าก่อนเรียกฟังก์ชันนี้แล้ว) */
export async function deleteAccountMap(db: DB, tenantId: string, id: string): Promise<FlowAccountMapResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  const { error } = await db
    .from("flowaccount_account_map")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "ลบ mapping ผังบัญชีไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

// ---------------------------------------------------------------------
// mapping สินค้า/บริการ
// ---------------------------------------------------------------------

type RawProductMap = { id: string; product_id: string; flowaccount_product_id: string };

/**
 * ดึง mapping สินค้าของลูกค้า 1 ราย (scope tenant + customer)
 *   คืน [] ถ้าไม่มี/ผิดพลาด (รวมกรณียังไม่ apply migration 0071 — ไม่ throw)
 */
export async function listProductMap(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<ProductMapRow[]> {
  const { data, error } = await db
    .from("flowaccount_product_map")
    .select("id, product_id, flowaccount_product_id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .limit(LIMIT);
  if (error || !data) return [];
  return (data as RawProductMap[]).map((r) => ({
    id: r.id,
    productId: r.product_id,
    flowaccountProductId: r.flowaccount_product_id,
  }));
}

/**
 * บันทึก mapping สินค้า 1 รายการของลูกค้า — ทับแถวเดิมถ้ามีอยู่แล้ว (unique tenant+customer+product_id)
 *   ไม่ insert ซ้ำ · validate ค่าว่าง/ยาวเกิน/product_id ต้องเป็น uuid ที่ถูกต้อง ·
 *   ★ flowaccountProductId ต้องเป็นเลขจำนวนเต็มบวกล้วนเท่านั้น (ดูคอมเมนต์หัวไฟล์) — ปฏิเสธก่อนแตะ DB
 *   ถ้าไม่ผ่าน กันไม่ให้เงียบๆ กลายเป็น id:0 ตอน sync จริง (lib/integrations/flowaccount-mapper.ts)
 */
export async function upsertProductMap(
  db: DB,
  tenantId: string,
  customerId: string,
  productId: string,
  flowaccountProductId: string
): Promise<FlowAccountMapResult> {
  if (!isUuid(productId)) return { ok: false, message: "ไม่พบสินค้าที่เลือก" };
  const faProductId = normText(flowaccountProductId, FLOWACCOUNT_PRODUCT_ID_MAX);
  if (!faProductId) return { ok: false, message: "กรุณาระบุรหัสสินค้าฝั่ง FlowAccount" };
  if (!isFlowAccountProductId(faProductId)) {
    return { ok: false, message: "รหัสสินค้าฝั่ง FlowAccount ต้องเป็นตัวเลข (เช่น 12345) เท่านั้น" };
  }
  if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };

  const { data: cur } = await db
    .from("flowaccount_product_map")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("product_id", productId)
    .maybeSingle();

  if (cur) {
    const id = (cur as { id: string }).id;
    const { error } = await db
      .from("flowaccount_product_map")
      .update({ flowaccount_product_id: faProductId })
      .eq("id", id)
      .eq("tenant_id", tenantId);
    if (error) return { ok: false, message: "บันทึก mapping สินค้าไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, id };
  }

  const { data, error } = await db
    .from("flowaccount_product_map")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      product_id: productId,
      flowaccount_product_id: faProductId,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    const errCode = (error as { code?: string } | null)?.code;
    if (errCode === "23505") return { ok: false, message: "สินค้านี้ถูกตั้ง mapping ไว้แล้ว กรุณาลองใหม่" };
    return {
      ok: false,
      message: "บันทึก mapping สินค้าไม่สำเร็จ กรุณาลองใหม่ (อาจยังไม่ apply migration 0071)",
    };
  }
  return { ok: true, id: (data as { id: string }).id };
}

/** ลบ mapping สินค้า 1 รายการ (scope tenant — ผู้เรียกตรวจสโคปลูกค้าก่อนเรียกฟังก์ชันนี้แล้ว) */
export async function deleteProductMap(db: DB, tenantId: string, id: string): Promise<FlowAccountMapResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  const { error } = await db
    .from("flowaccount_product_map")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "ลบ mapping สินค้าไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

// ---------------------------------------------------------------------
// helper pure — แปลง array ของ mapping → Record<code/productId, flowaccountCode> (ใช้ในเดครี mapper)
// ---------------------------------------------------------------------

/** แปลง mapping ผังบัญชี → Record<account_code, flowaccount_account_code> — pure, `[]` → `{}` */
export function accountMapToRecord(rows: AccountMapRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [r.accountCode, r.flowaccountAccountCode]));
}

/** แปลง mapping สินค้า → Record<product_id, flowaccount_product_id> — pure, `[]` → `{}` */
export function productMapToRecord(rows: ProductMapRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [r.productId, r.flowaccountProductId]));
}
