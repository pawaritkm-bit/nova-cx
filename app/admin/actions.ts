"use server";

/**
 * Server actions ของหน้า Admin — จุดเดียวที่ "เขียน" ข้อมูล
 *
 * flow ความปลอดภัยทุก action (สำคัญ):
 *   1) resolve viewer จาก session จริง (cookie) → requireAdminContext บังคับ role∈{admin,executive}
 *      + ได้ tenantId จาก session (ไม่เชื่อค่าจาก client)
 *   2) validate อินพุตด้วย zod
 *   3) เขียนด้วย service-role client แต่ inject tenant_id จาก session เท่านั้น
 *   4) revalidatePath('/admin') ให้ list อัปเดต
 * error ใด ๆ → คืนข้อความสุภาพ (ไม่หลุด internal)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAdminContext, AdminAuthError } from "@/lib/admin/guard";
import {
  createTeamSchema,
  createEmployeeSchema,
  updateEmployeeSchema,
  createCustomerSchema,
  updateCustomerSchema,
  createAssignmentSchema,
  setAutoSurveySchema,
  manualSurveySchema,
  firstZodError,
} from "@/lib/admin/schema";
import {
  createTeam,
  createEmployee,
  updateEmployee,
  createCustomer,
  updateCustomer,
  createAssignment,
  deactivateTeam,
  deactivateCustomer,
  setEmployeeActive,
  setCustomerAutoSurvey,
  endAssignment,
} from "@/lib/admin/service";
import { sendManualSurvey, ManualSurveyError } from "@/lib/admin/manual-survey";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ActionResult = { ok: boolean; message: string };

/** แปลง error เป็นข้อความสุภาพ (ปกปิด internal detail) */
function friendlyError(e: unknown): string {
  if (e instanceof AdminAuthError) return e.message;
  if (e instanceof Error && e.message) {
    // ข้อความที่เราตั้งเองเป็นภาษาไทย → แสดงได้; อื่น ๆ ปกปิด
    if (/[ก-๙]/.test(e.message)) return e.message;
  }
  return "บันทึกไม่สำเร็จ กรุณาลองใหม่ หรือติดต่อผู้ดูแลระบบ";
}

/**
 * wrapper: guard admin + เตรียม service-role client + revalidate
 * fn รับ (serviceDb, tenantId) ทำงานเขียนจริง
 */
async function withAdminWrite(
  fn: (db: SupabaseClient, tenantId: string) => Promise<void>
): Promise<ActionResult> {
  try {
    const authed = await createClient(); // anon + cookie → auth.uid() ของผู้ล็อกอิน
    const ctx = await requireAdminContext(authed); // 403 ถ้าไม่ใช่ admin/executive
    const service = createServiceRoleClient(); // เขียนข้าม RLS
    await fn(service, ctx.tenantId); // ★ tenant จาก session
    revalidatePath("/admin");
    return { ok: true, message: "บันทึกสำเร็จ" };
  } catch (e) {
    return { ok: false, message: friendlyError(e) };
  }
}

// ---- ทีม -------------------------------------------------------------
export async function createTeamAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const parsed = createTeamSchema.safeParse({
    name: formData.get("name"),
    type: formData.get("type"),
    lead_employee_id: formData.get("lead_employee_id"),
    handles_customer_type: formData.get("handles_customer_type"),
  });
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };
  const res = await withAdminWrite((db, tenantId) =>
    createTeam(db, tenantId, parsed.data).then(() => undefined)
  );
  return res.ok ? { ok: true, message: "เพิ่มทีมสำเร็จ" } : res;
}

export async function deactivateTeamAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, message: "ไม่พบรายการที่ต้องการปิด" };
  const res = await withAdminWrite((db, tenantId) => deactivateTeam(db, tenantId, id));
  return res.ok ? { ok: true, message: "ปิดใช้งานทีมแล้ว" } : res;
}

// ---- พนักงาน ---------------------------------------------------------
export async function createEmployeeAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const parsed = createEmployeeSchema.safeParse({
    first_name: formData.get("first_name"),
    nickname: formData.get("nickname"),
    position: formData.get("position"),
    employee_type: formData.get("employee_type"),
    is_active: formData.get("is_active") ?? undefined,
    team_id: formData.get("team_id"),
  });
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };
  const res = await withAdminWrite((db, tenantId) =>
    createEmployee(db, tenantId, parsed.data).then(() => undefined)
  );
  return res.ok ? { ok: true, message: "เพิ่มพนักงานสำเร็จ" } : res;
}

/** แก้ไขพนักงานรายคน (edit panel) — guard admin/executive + tenant จาก session */
export async function updateEmployeeAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const parsed = updateEmployeeSchema.safeParse({
    employeeId: formData.get("employeeId"),
    first_name: formData.get("first_name") ?? undefined,
    nickname: formData.get("nickname"),
    position: formData.get("position"),
    // ไม่ส่งมา (null) = ไม่แก้ประเภท — กัน null ตกไปชน enum
    employee_type: formData.get("employee_type") ?? undefined,
    teamId: formData.get("teamId"),
  });
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };
  const { employeeId, ...patch } = parsed.data;
  const res = await withAdminWrite((db, tenantId) =>
    updateEmployee(db, tenantId, employeeId, patch)
  );
  return res.ok ? { ok: true, message: "บันทึกข้อมูลพนักงานแล้ว" } : res;
}

export async function toggleEmployeeActiveAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  const next = String(formData.get("next") ?? "") === "true";
  if (!id) return { ok: false, message: "ไม่พบพนักงานที่เลือก" };
  const res = await withAdminWrite((db, tenantId) =>
    setEmployeeActive(db, tenantId, id, next)
  );
  return res.ok
    ? { ok: true, message: next ? "เปิดใช้งานพนักงานแล้ว" : "ปิดใช้งานพนักงานแล้ว" }
    : res;
}

// ---- ลูกค้า ----------------------------------------------------------
export async function createCustomerAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const parsed = createCustomerSchema.safeParse({
    customer_code: formData.get("customer_code"),
    name: formData.get("name"),
    business_name: formData.get("business_name"),
    service_start_date: formData.get("service_start_date"),
    customer_type: formData.get("customer_type"),
  });
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };
  const res = await withAdminWrite((db, tenantId) =>
    createCustomer(db, tenantId, parsed.data).then(() => undefined)
  );
  return res.ok ? { ok: true, message: "เพิ่มลูกค้าสำเร็จ" } : res;
}

/** แก้ไขฟิลด์ลูกค้ารายคน (edit panel) — guard admin/executive + tenant จาก session */
export async function updateCustomerAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const parsed = updateCustomerSchema.safeParse({
    customerId: formData.get("customerId"),
    customer_code: formData.get("customer_code"),
    name: formData.get("name") ?? undefined,
    business_name: formData.get("business_name"),
    service_start_date: formData.get("service_start_date"),
    customer_type: formData.get("customer_type"),
  });
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };
  const { customerId, ...patch } = parsed.data;
  const res = await withAdminWrite((db, tenantId) =>
    updateCustomer(db, tenantId, customerId, patch)
  );
  return res.ok ? { ok: true, message: "บันทึกข้อมูลลูกค้าแล้ว" } : res;
}

export async function deactivateCustomerAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
  const res = await withAdminWrite((db, tenantId) =>
    deactivateCustomer(db, tenantId, id)
  );
  return res.ok ? { ok: true, message: "ปิดใช้งานลูกค้าแล้ว" } : res;
}

/** เปิด/ปิดสวิตช์ "ส่งแบบประเมินอัตโนมัติ" ต่อลูกค้า (0029) */
export async function setCustomerAutoSurveyAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const parsed = setAutoSurveySchema.safeParse({
    customer_id: formData.get("customer_id"),
    enabled: formData.get("enabled") ?? undefined,
  });
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };
  const res = await withAdminWrite((db, tenantId) =>
    setCustomerAutoSurvey(db, tenantId, parsed.data.customer_id, parsed.data.enabled)
  );
  return res.ok
    ? {
        ok: true,
        message: parsed.data.enabled
          ? "เปิดส่งอัตโนมัติแล้ว"
          : "ปิดส่งอัตโนมัติแล้ว",
      }
    : res;
}

/** ผลลัพธ์ปุ่มส่งเอง — เพิ่ม pushed/surveyUrl ให้ UI แสดงลิงก์เมื่อไม่ได้ push */
export type ManualSurveyActionResult = ActionResult & {
  pushed?: boolean;
  surveyUrl?: string;
};

/**
 * ปุ่ม "ส่งแบบประเมิน" (กดเอง) — guard admin/executive + tenant จาก session
 *   push เข้า LINE ถ้าลูกค้าแอด OA / ไม่งั้นคืนลิงก์ให้ copy
 */
export async function sendManualSurveyAction(
  _prev: ManualSurveyActionResult | null,
  formData: FormData
): Promise<ManualSurveyActionResult> {
  const parsed = manualSurveySchema.safeParse({
    customer_id: formData.get("customer_id"),
    survey_type: formData.get("survey_type"),
  });
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };

  try {
    const authed = await createClient();
    const ctx = await requireAdminContext(authed); // admin/executive เท่านั้น
    const service = createServiceRoleClient();
    const out = await sendManualSurvey(service, ctx.tenantId, {
      customerId: parsed.data.customer_id,
      surveyType: parsed.data.survey_type,
    });
    revalidatePath("/admin");
    return {
      ok: true,
      pushed: out.pushed,
      surveyUrl: out.surveyUrl,
      message: out.pushed
        ? "ส่งเข้า LINE แล้ว"
        : "ลูกค้ายังไม่ได้แอด LINE OA — คัดลอกลิงก์นี้ส่งให้ลูกค้า",
    };
  } catch (e) {
    if (e instanceof ManualSurveyError) return { ok: false, message: e.message };
    return { ok: false, message: friendlyError(e) };
  }
}

// ---- มอบหมาย ---------------------------------------------------------
export async function createAssignmentAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const parsed = createAssignmentSchema.safeParse({
    customer_id: formData.get("customer_id"),
    employee_id: formData.get("employee_id"),
    role: formData.get("role"),
    team_id: formData.get("team_id"),
  });
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };

  let replaced = false;
  const res = await withAdminWrite(async (db, tenantId) => {
    const out = await createAssignment(db, tenantId, parsed.data);
    replaced = out.replacedPrevious;
  });
  if (!res.ok) return res;
  return {
    ok: true,
    message: replaced
      ? "มอบหมายสำเร็จ (แทนที่การมอบหมายเดิมของคู่นี้)"
      : "มอบหมายสำเร็จ",
  };
}

export async function endAssignmentAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, message: "ไม่พบรายการมอบหมาย" };
  const res = await withAdminWrite((db, tenantId) => endAssignment(db, tenantId, id));
  return res.ok ? { ok: true, message: "สิ้นสุดการมอบหมายแล้ว" } : res;
}
