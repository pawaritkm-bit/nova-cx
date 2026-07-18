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
  propagateMemberSchema,
  saveWeightsSchema,
  slaRuleSchema,
  updateSlaRuleSchema,
  firstZodError,
} from "./schema";
import { mapGroupToCustomer, setChatMember } from "./mapping";
import { propagateMemberIdentity } from "./member-directory";
import { saveWeights } from "./weights";
import { createSlaRule, updateSlaRule, deleteSlaRule, setSlaRuleActive } from "./sla";
import { DIMENSIONS, type Weights } from "@/lib/evaluation/weights";

export type ActionResult = { ok: boolean; message: string };

function friendlyError(e: unknown): string {
  if (e instanceof AdminAuthError) return e.message;
  if (e instanceof Error && e.message && /[ก-๙]/.test(e.message)) return e.message;
  return "บันทึกไม่สำเร็จ กรุณาลองใหม่ หรือติดต่อผู้ดูแลระบบ";
}

/**
 * wrapper: guard admin + service-role + revalidate
 *   fn รับ (serviceDb, tenantId, actorUserId) — ★ tenant/actor จาก session เท่านั้น
 *   actorUserId = users.id ของผู้ล็อกอิน (มาจาก requireAdminContext — ไม่ query ซ้ำ)
 */
async function withChatAdminWrite(
  fn: (db: SupabaseClient, tenantId: string, actorUserId: string | null) => Promise<void>
): Promise<ActionResult> {
  try {
    const authed = await createClient();
    const ctx = await requireAdminContext(authed); // 403 ถ้าไม่ใช่ admin/executive
    const service = createServiceRoleClient();
    await fn(service, ctx.tenantId, ctx.userId);
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

// ---- propagate ตัวตนสมาชิกข้ามกลุ่ม (ตัวช่วย 1B, review-first) --------
//   ไม่ใช้ withChatAdminWrite เพราะต้องคืน "จำนวนกลุ่มที่ผูก" ในข้อความ + revalidate หน้าภาพรวม
export async function propagateMemberAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  // scope=selected → ผูกเฉพาะกลุ่มที่ติ๊ก (group_ids หลายค่า); อื่น = ทุกกลุ่มที่ยังไม่ผูก
  const scope = String(formData.get("scope") ?? "all");
  const groupIds =
    scope === "selected"
      ? formData.getAll("group_ids").map((v) => String(v)).filter(Boolean)
      : undefined;

  const parsed = propagateMemberSchema.safeParse({
    line_user_id: formData.get("line_user_id"),
    member_kind: formData.get("member_kind"),
    employee_id: formData.get("employee_id"),
    group_ids: groupIds,
  });
  if (!parsed.success) return { ok: false, message: firstZodError(parsed.error) };
  if (scope === "selected" && (!groupIds || groupIds.length === 0)) {
    return { ok: false, message: "กรุณาเลือกอย่างน้อย 1 กลุ่ม" };
  }

  try {
    const authed = await createClient();
    const ctx = await requireAdminContext(authed); // 403 ถ้าไม่ใช่ admin/executive
    const service = createServiceRoleClient();
    const { affected } = await propagateMemberIdentity(
      service,
      ctx.tenantId,
      {
        lineUserId: parsed.data.line_user_id,
        employeeId: parsed.data.employee_id,
        memberKind: parsed.data.member_kind,
        groupIds: parsed.data.group_ids,
      },
      ctx.userId
    );
    revalidatePath("/chat-audit/admin/members");
    return {
      ok: true,
      message:
        affected > 0
          ? `ผูกตัวตนเรียบร้อย ${affected} กลุ่ม`
          : "ไม่มีกลุ่มที่ต้องผูกเพิ่ม (อาจผูกครบแล้ว)",
    };
  } catch (e) {
    return { ok: false, message: friendlyError(e) };
  }
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
