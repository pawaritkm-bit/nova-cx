"use server";

/**
 * Server actions ของหน้า "คลังคำตอบ AI" (/chat-audit/knowledge) — Phase 1
 *
 * flow ความปลอดภัยทุก action (ยึดบทเรียน write path — ห้ามเชื่อ scope จาก client):
 *   1) resolve viewer จาก session จริง (cookie) → requireAdminContext บังคับ role∈{admin,executive}
 *      + ได้ tenantId จาก session (ไม่เชื่อค่าจาก client)
 *   2) validate อินพุต (id uuid + status ใน allow-list)
 *   3) อัปเดตด้วย service-role client แต่กรอง tenant_id จาก session เท่านั้น
 *   4) revalidatePath('/chat-audit/knowledge')
 *   error ใด ๆ → คืนข้อความสุภาพ (ไม่หลุด internal)
 *
 * ★ อัปเดตได้แค่ "สถานะ" (approved/rejected) — ไม่แตะเนื้อหา gist (worker เขียนอย่างเดียว)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAdminContext, AdminAuthError } from "@/lib/admin/guard";
import { updateKnowledgeStatus, type KnowledgeStatus } from "./queries";

export type ActionResult = { ok: boolean; message: string };

function friendlyError(e: unknown): string {
  if (e instanceof AdminAuthError) return e.message;
  return "บันทึกไม่สำเร็จ กรุณาลองใหม่ หรือติดต่อผู้ดูแลระบบ";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** อนุมัติ/ตัดออก 1 รายการ — status ต้องเป็น approved|rejected เท่านั้น */
export async function setKnowledgeStatusAction(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();

  if (!UUID_RE.test(id)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  if (status !== "approved" && status !== "rejected") {
    return { ok: false, message: "สถานะไม่ถูกต้อง" };
  }

  try {
    const authed = await createClient();
    const ctx = await requireAdminContext(authed); // 403 ถ้าไม่ใช่ admin/executive
    const service = createServiceRoleClient();
    const affected = await updateKnowledgeStatus(
      service,
      ctx.tenantId,
      id,
      status as KnowledgeStatus
    );
    revalidatePath("/chat-audit/knowledge");
    if (affected === 0) return { ok: false, message: "ไม่พบรายการที่เลือก (หรือไม่ใช่ของหน่วยงานนี้)" };
    return { ok: true, message: status === "approved" ? "อนุมัติเข้าคลังแล้ว" : "ตัดออกจากคลังแล้ว" };
  } catch (e) {
    return { ok: false, message: friendlyError(e) };
  }
}
