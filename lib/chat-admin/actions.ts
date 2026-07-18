"use server";

/**
 * Server actions ของหน้า "ตั้งค่าตรวจแชต" (admin) — Phase 5b
 *
 * flow ความปลอดภัยทุก action (ยึดบทเรียน Phase 4 — write path ห้ามเชื่อ scope จาก client):
 *   1) resolve viewer จาก session จริง (cookie) → requireAdminContext บังคับ role∈{admin,executive}
 *      + ได้ tenantId จาก session (ไม่เชื่อค่าจาก client)
 *   2) validate อินพุตด้วย zod
 *   3) เขียนด้วย service-role client แต่ inject tenant_id จาก session เท่านั้น
 *   4) revalidatePath('/chat-audit/admin')
 *   error ใด ๆ → คืนข้อความสุภาพ (ไม่หลุด internal)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAdminContext, AdminAuthError } from "@/lib/admin/guard";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  mapGroupSchema,
  setMemberSchema,
  saveWeightsSchema,
  slaRuleSchema,
  updateSlaRuleSchema,
  firstZodError,
} from "./schema";
import { mapGroupToCustomer, setChatMember } from "./mapping";
import { saveWeights } from "./weights";
import { createSlaRule, updateSlaRule, deleteSlaRule, setSlaRuleActive } from "./sla";
import { DIMENSIONS, type Weights } from "@/lib/evaluation/weights";

export type ActionResult = { ok: boolean; message: string };

function friendlyError(e: unknown): string {
  if (e instanceof AdminAuthError) return e.message;
  if (e instanceof Error && e.message && /[ก-๙]/.test(e.message)) return e.message;
  return "บันทึกไม่สำเร็จ กรุณาลองใหม่ หรือติดต่อผู้ดูแลระบบ";
}

/** app user id (users.id) ของผู้ล็อกอิน — ใช้เป็น actor/mapped_by (audit) */
async function resolveActorUserId(authed: SupabaseClient): Promise<string | null> {
  try {
    const { data } = await authed.auth.getUser();
    if (!data?.user) return null;
    const { data: row } = await authed
      .from("users")
      .select("id")
      .eq("auth_user_id", data.user.id)
      .is("deleted_at", null)
      .maybeSingle();
    return (row as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * wrapper: guard admin + service-role + revalidate
 *   fn รับ (serviceDb, tenantId, actorUserId) — ★ tenant/actor จาก session เท่านั้น
 */
async function withChatAdminWrite(
  fn: (db: SupabaseClient, tenantId: string, actorUserId: string | null) => Promise<void>
): Promise<ActionResult> {
  try {
    const authed = await createClient();
    const ctx = await requireAdminContext(authed); // 403 ถ้าไม่ใช่ admin/executive
    const actorUserId = await resolveActorUserId(authed);
    const service = createServiceRoleClient();
    await fn(service, ctx.tenantId, actorUserId);
    revalidatePath("/chat-audit/admin");
    return { ok: true, message: "บันทึกสำเร็จ" };
  } catch (e) {
    return { ok: false, message: friendlyError(e) };
  }
}

// ---- จับคู่กลุ่ม → ลูกค้า ---------------------------------------------
export async function mapGroupAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const parsed = mapGroupSchema.safeParse({
    chat_group_id: formData.get("chat_group_id"),
    customer_id: formData.get("customer_id"),
  });
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };
  const res = await withChatAdminWrite((db, tenantId, actor) =>
    mapGroupToCustomer(db, tenantId, parsed.data, actor)
  );
  return res.ok
    ? { ok: true, message: parsed.data.customer_id ? "จับคู่ลูกค้าแล้ว" : "ยกเลิกการจับคู่แล้ว" }
    : res;
}

// ---- จับคู่สมาชิก → พนักงาน / ระบุบทบาท -----------------------------
export async function setMemberAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const parsed = setMemberSchema.safeParse({
    chat_member_id: formData.get("chat_member_id"),
    member_kind: formData.get("member_kind"),
    employee_id: formData.get("employee_id"),
  });
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };
  const res = await withChatAdminWrite((db, tenantId, actor) =>
    setChatMember(db, tenantId, parsed.data, actor)
  );
  return res.ok ? { ok: true, message: "บันทึกบทบาทสมาชิกแล้ว" } : res;
}

// ---- น้ำหนักคะแนน 8 มิติ ---------------------------------------------
export async function saveWeightsAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const raw: Record<string, unknown> = {};
  for (const d of DIMENSIONS) raw[d] = formData.get(d);
  const parsed = saveWeightsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };
  const weights = parsed.data as unknown as Weights;
  const res = await withChatAdminWrite((db, tenantId) => saveWeights(db, tenantId, weights));
  return res.ok ? { ok: true, message: "บันทึกน้ำหนักคะแนนแล้ว" } : res;
}

// ---- SLA rules -------------------------------------------------------
function parseSlaForm(formData: FormData) {
  return slaRuleSchema.safeParse({
    name: formData.get("name"),
    customer_type: formData.get("customer_type"),
    urgency: formData.get("urgency"),
    work_type: formData.get("work_type"),
    team_id: formData.get("team_id"),
    first_response_minutes: formData.get("first_response_minutes"),
    resolution_minutes: formData.get("resolution_minutes"),
    priority: formData.get("priority"),
    is_active: formData.get("is_active"),
  });
}

export async function createSlaRuleAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const parsed = parseSlaForm(formData);
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };
  const res = await withChatAdminWrite((db, tenantId) =>
    createSlaRule(db, tenantId, parsed.data).then(() => undefined)
  );
  return res.ok ? { ok: true, message: "เพิ่มเงื่อนไข SLA แล้ว" } : res;
}

export async function updateSlaRuleAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const idParsed = updateSlaRuleSchema.safeParse({ id: formData.get("id") });
  if (!idParsed.success) return { ok: false, message: firstZodError(idParsed.error) };
  const parsed = parseSlaForm(formData);
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };
  const res = await withChatAdminWrite((db, tenantId) =>
    updateSlaRule(db, tenantId, idParsed.data.id, parsed.data)
  );
  return res.ok ? { ok: true, message: "บันทึกเงื่อนไข SLA แล้ว" } : res;
}

export async function deleteSlaRuleAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, message: "ไม่พบเงื่อนไขที่เลือก" };
  const res = await withChatAdminWrite((db, tenantId) => deleteSlaRule(db, tenantId, id));
  return res.ok ? { ok: true, message: "ลบเงื่อนไข SLA แล้ว" } : res;
}

export async function toggleSlaRuleAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "");
  const next = String(formData.get("next") ?? "") === "true";
  if (!id) return { ok: false, message: "ไม่พบเงื่อนไขที่เลือก" };
  const res = await withChatAdminWrite((db, tenantId) => setSlaRuleActive(db, tenantId, id, next));
  return res.ok ? { ok: true, message: next ? "เปิดใช้งานเงื่อนไขแล้ว" : "ปิดใช้งานเงื่อนไขแล้ว" } : res;
}
