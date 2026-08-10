"use server";

/**
 * Server actions ของหน้า "จัดการสินค้า/บริการ" (admin) — เฟส 1 ส่วน B4 (docs/06-accounting-features-roadmap.md)
 *
 * flow ความปลอดภัยทุก action (เหมือน app/chat-audit/admin/chart-of-accounts/actions.ts):
 *   1) resolve viewer จาก session จริง (cookie) → requireAdminContext บังคับ role∈{admin,executive}
 *      + ได้ tenantId จาก session (ไม่เชื่อค่าจาก client)
 *   2) เขียนด้วย service-role client แต่ inject tenant_id จาก session เท่านั้น
 *   3) validate อยู่ใน lib/accounting/products.ts (ชื่อว่าง/ราคาติดลบ/sku ซ้ำ → ปฏิเสธ)
 *   4) revalidatePath('/chat-audit/admin/products')
 *   error ใด ๆ → คืนข้อความสุภาพ (ไม่หลุด internal)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAdminContext, AdminAuthError } from "@/lib/admin/guard";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createProduct,
  updateProduct,
  setProductActive,
  softDeleteProduct,
  type ProductActionResult,
} from "@/lib/accounting/products";

export type ActionResult = { ok: boolean; message: string };

const PATH = "/chat-audit/admin/products";

function friendlyError(e: unknown): string {
  if (e instanceof AdminAuthError) return e.message;
  if (e instanceof Error && e.message && /[ก-๙]/.test(e.message)) return e.message;
  return "บันทึกไม่สำเร็จ กรุณาลองใหม่ หรือติดต่อผู้ดูแลระบบ";
}

/** wrapper: guard admin + service-role + revalidate — fn คืน ProductActionResult จาก data layer ตรง ๆ */
async function withProductAdminWrite(
  fn: (db: SupabaseClient, tenantId: string) => Promise<ProductActionResult>
): Promise<ActionResult> {
  try {
    const authed = await createClient();
    const ctx = await requireAdminContext(authed); // throw ถ้าไม่ใช่ admin/executive
    const service = createServiceRoleClient();
    const res = await fn(service, ctx.tenantId);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "บันทึกสำเร็จ" };
  } catch (e) {
    return { ok: false, message: friendlyError(e) };
  }
}

/** เพิ่มสินค้า/บริการใหม่ */
export async function createProductAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const input = {
    sku: formData.get("sku"),
    name: formData.get("name"),
    unit: formData.get("unit"),
    defaultPrice: formData.get("defaultPrice"),
    defaultAccountCode: formData.get("defaultAccountCode"),
    category: formData.get("category"),
  };
  const res = await withProductAdminWrite((db, tenantId) => createProduct(db, tenantId, input));
  return res.ok ? { ok: true, message: "เพิ่มสินค้าแล้ว" } : res;
}

/** แก้สินค้า/บริการเดิม */
export async function updateProductAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  const input = {
    sku: formData.get("sku"),
    name: formData.get("name"),
    unit: formData.get("unit"),
    defaultPrice: formData.get("defaultPrice"),
    defaultAccountCode: formData.get("defaultAccountCode"),
    category: formData.get("category"),
  };
  const res = await withProductAdminWrite((db, tenantId) => updateProduct(db, tenantId, id, input));
  return res.ok ? { ok: true, message: "บันทึกแล้ว" } : res;
}

/** สลับเปิด/ปิดใช้งาน (ไม่ใช่ลบ) */
export async function toggleProductActiveAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  const isActive = formData.get("isActive") === "1";
  const res = await withProductAdminWrite((db, tenantId) => setProductActive(db, tenantId, id, isActive));
  return res.ok ? { ok: true, message: isActive ? "เปิดใช้งานแล้ว" : "ปิดใช้งานแล้ว" } : res;
}

/** ลบสินค้า/บริการ (soft-delete) */
export async function deleteProductAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  const res = await withProductAdminWrite((db, tenantId) => softDeleteProduct(db, tenantId, id));
  return res.ok ? { ok: true, message: "ลบสินค้าแล้ว" } : res;
}
