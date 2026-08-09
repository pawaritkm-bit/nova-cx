"use server";

/**
 * Server actions ของหน้า "จัดการผังบัญชี" (admin) — เฟส 1 ส่วน A9 (docs/06-accounting-features-roadmap.md)
 *
 * flow ความปลอดภัยทุก action (เหมือน lib/chat-admin/actions.ts):
 *   1) resolve viewer จาก session จริง (cookie) → requireAdminContext บังคับ role∈{admin,executive}
 *      + ได้ tenantId จาก session (ไม่เชื่อค่าจาก client)
 *   2) เขียนด้วย service-role client แต่ inject tenant_id จาก session เท่านั้น
 *   3) validate + guard PROTECTED_CODES/BANK_STRUCTURAL_CODES อยู่ใน lib/accounting/chart-accounts-data.ts
 *      (ห้ามลบรหัสโครงสร้าง, ห้ามปลด is_bank ถ้ามีบัญชีลูกค้าผูกอยู่ — ดู docs/06 หมวด 0.7)
 *   4) revalidatePath('/chat-audit/admin/chart-of-accounts')
 *   error ใด ๆ → คืนข้อความสุภาพ (ไม่หลุด internal)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAdminContext, AdminAuthError } from "@/lib/admin/guard";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createChartAccount,
  updateChartAccount,
  setChartAccountActive,
  softDeleteChartAccount,
  type ChartActionResult,
} from "@/lib/accounting/chart-accounts-data";

export type ActionResult = { ok: boolean; message: string };

const PATH = "/chat-audit/admin/chart-of-accounts";

function friendlyError(e: unknown): string {
  if (e instanceof AdminAuthError) return e.message;
  if (e instanceof Error && e.message && /[ก-๙]/.test(e.message)) return e.message;
  return "บันทึกไม่สำเร็จ กรุณาลองใหม่ หรือติดต่อผู้ดูแลระบบ";
}

/** wrapper: guard admin + service-role + revalidate — fn คืน ChartActionResult จาก data layer ตรง ๆ */
async function withChartAdminWrite(
  fn: (db: SupabaseClient, tenantId: string) => Promise<ChartActionResult>
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

/** เพิ่มบัญชีใหม่ในผัง */
export async function createChartAccountAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const input = {
    code: formData.get("code"),
    name: formData.get("name"),
    category: formData.get("category"),
    isBank: formData.get("isBank") === "on",
  };
  const res = await withChartAdminWrite((db, tenantId) => createChartAccount(db, tenantId, input));
  return res.ok ? { ok: true, message: "เพิ่มบัญชีแล้ว" } : res;
}

/** แก้ชื่อ/หมวด/is_bank ของบัญชีเดิม */
export async function updateChartAccountAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  const input = {
    code: formData.get("code"),
    name: formData.get("name"),
    category: formData.get("category"),
    isBank: formData.get("isBank") === "on",
  };
  const res = await withChartAdminWrite((db, tenantId) => updateChartAccount(db, tenantId, id, input));
  return res.ok ? { ok: true, message: "บันทึกแล้ว" } : res;
}

/** สลับเปิด/ปิดใช้งาน (ไม่ใช่ลบ) */
export async function toggleChartAccountActiveAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  const isActive = formData.get("isActive") === "1";
  const res = await withChartAdminWrite((db, tenantId) => setChartAccountActive(db, tenantId, id, isActive));
  return res.ok ? { ok: true, message: isActive ? "เปิดใช้งานแล้ว" : "ปิดใช้งานแล้ว" } : res;
}

/** ลบบัญชี (soft-delete) — ปฏิเสธถ้าเป็นรหัสโครงสร้าง/มีบัญชีลูกค้าผูกอยู่ (guard ใน data layer) */
export async function deleteChartAccountAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  const res = await withChartAdminWrite((db, tenantId) => softDeleteChartAccount(db, tenantId, id));
  return res.ok ? { ok: true, message: "ลบบัญชีแล้ว" } : res;
}
