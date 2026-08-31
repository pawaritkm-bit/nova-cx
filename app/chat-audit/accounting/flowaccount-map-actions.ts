"use server";

/**
 * Server actions "mapping ผังบัญชี/สินค้า nova-cx ↔ FlowAccount ต่อลูกค้า" (เฟส 5 ส่วน Q)
 *   upsertAccountMapAction / deleteAccountMapAction / upsertProductMapAction / deleteProductMapAction
 *
 * flow ความปลอดภัย (ยึดมาตรฐาน write path เดียวกับ customer-admin-actions.ts/actions.ts):
 *   1) requireAccountingAccess (สิทธิ์จาก session จริง) + tenantId จาก session
 *   2) validate uuid ของ customerId/id ก่อนแตะ DB
 *   3) ★ assertCustomerInScope — นักบัญชี/หัวหน้าแก้ mapping ได้เฉพาะลูกค้าที่ตัวเองดูแล (decision 0.11
 *      ของเฟส 5 — เหมือนสิทธิ์แก้ credential FlowAccount ของ M2 ไม่ใช่ admin-only)
 *   4) เขียนผ่าน lib/accounting/flowaccount-map.ts (service-role client + tenantId จาก session)
 *   5) revalidatePath('/chat-audit/accounting/flowaccount-map')
 *
 * ★ PDPA: ไม่ log รหัสบัญชี/รหัสสินค้า/ชื่อลูกค้า (ไม่มี console.* ที่นี่)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  assertCustomerInScope,
  AccountingAuthError,
} from "@/lib/accounting/access";
import {
  listAccountMap,
  upsertAccountMap,
  deleteAccountMap,
  listProductMap,
  upsertProductMap,
  deleteProductMap,
  type AccountMapRow,
  type ProductMapRow,
} from "@/lib/accounting/flowaccount-map";

const PATH = "/chat-audit/accounting/flowaccount-map";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type SaveResult = {
  ok: boolean;
  message: string;
  id?: string;
};

/** ยืนยันลูกค้าอยู่ใน tenant นี้จริง (defense-in-depth — admin scope ผ่านทุก uuid) */
async function customerBelongsToTenant(
  service: ReturnType<typeof createServiceRoleClient>,
  tenantId: string,
  customerId: string
): Promise<boolean> {
  const { data } = await service
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  return !!data;
}

/**
 * ยืนยันสินค้าอยู่ใน tenant นี้จริง (defense-in-depth — mirror customerBelongsToTenant ด้านบน)
 *   ★ ช่องโหว่ที่พบใน QA (เฟส 5 ส่วน Q): upsertProductMapAction ตรวจ customerId เป็นของ tenant นี้เสมอ
 *     แต่ไม่เคยตรวจว่า productId เป็นสินค้าของ tenant เดียวกัน — validate แค่รูปแบบ uuid เท่านั้น (isUuid)
 *     ทำให้ผูก mapping ข้าม tenant ได้ถ้ารู้ uuid สินค้าของ tenant อื่น (FK migration 0071 เช็คแค่ "แถวมีอยู่
 *     จริงในตาราง products" ไม่เช็ค tenant_id) → ต้อง query ตาราง products ยืนยัน tenant_id ก่อนเขียนลง DB เสมอ
 */
async function productBelongsToTenant(
  service: ReturnType<typeof createServiceRoleClient>,
  tenantId: string,
  productId: string
): Promise<boolean> {
  const { data } = await service
    .from("products")
    .select("id")
    .eq("id", productId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  return !!data;
}

// ---------------------------------------------------------------------
// อ่าน mapping (ใช้จาก page.tsx — export ไว้เผื่ออนาคตต้องการ client refetch)
// ---------------------------------------------------------------------

export async function listAccountMapAction(customerId: string): Promise<AccountMapRow[]> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!isUuid(customerId)) return [];
    assertCustomerInScope(ctx, customerId);
    return await listAccountMap(service, ctx.tenantId, customerId);
  } catch {
    return [];
  }
}

export async function listProductMapAction(customerId: string): Promise<ProductMapRow[]> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!isUuid(customerId)) return [];
    assertCustomerInScope(ctx, customerId);
    return await listProductMap(service, ctx.tenantId, customerId);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// mapping ผังบัญชี
// ---------------------------------------------------------------------

/** บันทึก mapping ผังบัญชี 1 รายการของลูกค้า (admin หรือ นักบัญชี/หัวหน้าที่ดูแลลูกค้ารายนั้น) */
export async function upsertAccountMapAction(input: {
  customerId: string;
  accountCode: string;
  flowaccountAccountCode: string;
}): Promise<SaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    if (!(await customerBelongsToTenant(service, ctx.tenantId, input.customerId))) {
      return { ok: false, message: "ไม่พบลูกค้าในสำนักงานนี้" };
    }
    // ★ สโคป: นักบัญชี/หัวหน้าแก้ได้เฉพาะลูกค้าที่ตัวเองดูแล (admin ผ่านทุกราย)
    assertCustomerInScope(ctx, input.customerId);

    const res = await upsertAccountMap(
      service,
      ctx.tenantId,
      input.customerId,
      input.accountCode,
      input.flowaccountAccountCode
    );
    if (!res.ok) return res;

    revalidatePath(PATH);
    return { ok: true, message: "บันทึก mapping ผังบัญชีแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึก mapping ผังบัญชีไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ลบ mapping ผังบัญชี 1 รายการ (admin หรือ นักบัญชี/หัวหน้าที่ดูแลลูกค้ารายนั้น) */
export async function deleteAccountMapAction(id: string): Promise<SaveResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const { data: row } = await service
      .from("flowaccount_account_map")
      .select("customer_id")
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    if (!row) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, (row as { customer_id: string | null }).customer_id);

    const res = await deleteAccountMap(service, ctx.tenantId, id);
    if (!res.ok) return res;

    revalidatePath(PATH);
    return { ok: true, message: "ลบ mapping ผังบัญชีแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบ mapping ผังบัญชีไม่สำเร็จ กรุณาลองใหม่" };
  }
}

// ---------------------------------------------------------------------
// mapping สินค้า/บริการ
// ---------------------------------------------------------------------

/** บันทึก mapping สินค้า 1 รายการของลูกค้า (admin หรือ นักบัญชี/หัวหน้าที่ดูแลลูกค้ารายนั้น) */
export async function upsertProductMapAction(input: {
  customerId: string;
  productId: string;
  flowaccountProductId: string;
}): Promise<SaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    if (!(await customerBelongsToTenant(service, ctx.tenantId, input.customerId))) {
      return { ok: false, message: "ไม่พบลูกค้าในสำนักงานนี้" };
    }
    // ★ สโคป: นักบัญชี/หัวหน้าแก้ได้เฉพาะลูกค้าที่ตัวเองดูแล (admin ผ่านทุกราย)
    assertCustomerInScope(ctx, input.customerId);

    // ★ ยืนยัน productId เป็นสินค้าของ tenant นี้จริง (กันช่องโหว่ผูก mapping ข้าม tenant — ดูคอมเมนต์
    //   ที่ productBelongsToTenant ด้านบน) — mirror การตรวจ customerId ข้างต้นทุกประการ
    if (!isUuid(input.productId)) return { ok: false, message: "ไม่พบสินค้าที่เลือก" };
    if (!(await productBelongsToTenant(service, ctx.tenantId, input.productId))) {
      return { ok: false, message: "ไม่พบสินค้าในสำนักงานนี้" };
    }

    const res = await upsertProductMap(
      service,
      ctx.tenantId,
      input.customerId,
      input.productId,
      input.flowaccountProductId
    );
    if (!res.ok) return res;

    revalidatePath(PATH);
    return { ok: true, message: "บันทึก mapping สินค้าแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึก mapping สินค้าไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ลบ mapping สินค้า 1 รายการ (admin หรือ นักบัญชี/หัวหน้าที่ดูแลลูกค้ารายนั้น) */
export async function deleteProductMapAction(id: string): Promise<SaveResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const { data: row } = await service
      .from("flowaccount_product_map")
      .select("customer_id")
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    if (!row) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, (row as { customer_id: string | null }).customer_id);

    const res = await deleteProductMap(service, ctx.tenantId, id);
    if (!res.ok) return res;

    revalidatePath(PATH);
    return { ok: true, message: "ลบ mapping สินค้าแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบ mapping สินค้าไม่สำเร็จ กรุณาลองใหม่" };
  }
}
