/**
 * Chat-admin group service — ลบกลุ่ม LINE (soft-delete) สำหรับเคลียร์กลุ่มทดสอบ
 *
 * สัญญา (contract):
 *   - รับ db (service-role client เพื่อข้าม RLS) + tenantId (จาก session เท่านั้น) + chatGroupId
 *   - soft-delete เท่านั้น (set deleted_at) — ไม่ hard-delete
 *     กลุ่ม (chat_groups) เป็นหลัก + assertAffected กัน id ผิด/ข้าม tenant คืน success เท็จ
 *   - soft-delete ข้อมูลลูกในกลุ่มแบบ best-effort (chat_members, chat_messages,
 *     ai_chat_analysis, conversation_cases) เพื่อให้หายจาก dashboard/ไม่ถูกวิเคราะห์ต่อ
 *   - บันทึก audit_logs (action = chat_group_deleted)
 *
 * ★ migration-free: ใช้คอลัมน์ deleted_at ที่ทุกตารางมีอยู่แล้ว (0032/0033/0034)
 *   ตารางเป้าหมายมีแค่ trigger set_updated_at (ไม่มี prevent_update_delete) จึง update ได้
 *
 * ⚠️ หมายเหตุกลุ่มทดสอบ: ถ้ากลุ่มยัง active ใน LINE และมีข้อความใหม่เข้ามา
 *   resolveOrCreateGroup (lib/line/ingest.ts) จะ match แถวเดิมด้วย provider+group_ref
 *   (ไม่กรอง deleted_at) แล้ว insert ข้อความใหม่ (deleted_at=null) อ้างกลุ่มนี้ →
 *   กลุ่ม/ข้อความอาจกลับมาโผล่ได้ ฟีเจอร์นี้จึงเหมาะกับ "กลุ่มทดสอบ" ที่บอทออกจากกลุ่มแล้วเท่านั้น
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

/** ยืนยันว่า mutation แตะจริง ≥1 แถว (service-role ข้าม RLS จึงต้องเช็คเอง) */
function assertAffected(data: unknown[] | null, error: unknown): void {
  if (error) throw new Error((error as { message?: string }).message ?? "update failed");
  if (!data || data.length === 0) throw new Error("ไม่พบกลุ่มที่ต้องการลบ (หรืออยู่นอกสำนักงานของคุณ)");
}

/** ตารางลูกที่ผูกกับ chat_group_id โดยตรง — soft-delete แบบ best-effort */
const CHILD_TABLES = [
  "chat_members",
  "chat_messages",
  "ai_chat_analysis",
  "conversation_cases",
] as const;

/**
 * soft-delete แถวลูกของกลุ่มแบบ best-effort — ล้มก็ไม่โยน error ต่อ (แค่ log)
 *   scope: tenant + chat_group_id + เฉพาะที่ยังไม่ถูกลบ (deleted_at is null)
 */
async function softDeleteChildren(
  db: DB,
  tenantId: string,
  chatGroupId: string,
  nowIso: string
): Promise<void> {
  for (const table of CHILD_TABLES) {
    try {
      const { error } = await db
        .from(table)
        .update({ deleted_at: nowIso })
        .eq("chat_group_id", chatGroupId)
        .eq("tenant_id", tenantId)
        .is("deleted_at", null);
      if (error) {
        // best-effort: ตารางบางตัวอาจมี trigger กัน update (append-only) → ข้าม
        console.warn(`[deleteChatGroup] soft-delete ${table} ไม่สำเร็จ (ข้าม best-effort):`, error.message);
      }
    } catch (e) {
      console.warn(`[deleteChatGroup] soft-delete ${table} ผิดพลาด (ข้าม best-effort):`, e);
    }
  }
}

/**
 * soft-delete กลุ่ม LINE + ข้อมูลในกลุ่ม (สำหรับเคลียร์กลุ่มทดสอบ)
 *   1) chat_groups.deleted_at = now (scope tenant + assertAffected) — ต้องแตะ 1 แถวจริง
 *   2) soft-delete ตารางลูก (chat_members/chat_messages/ai_chat_analysis/conversation_cases) best-effort
 *   3) audit_logs (chat_group_deleted)
 */
export async function deleteChatGroup(
  db: DB,
  tenantId: string,
  chatGroupId: string,
  actorUserId: string | null
): Promise<void> {
  const nowIso = new Date().toISOString();

  // 1) soft-delete ตัวกลุ่มเอง — scope tenant + เฉพาะที่ยังไม่ถูกลบ
  const { data, error } = await db
    .from("chat_groups")
    .update({ deleted_at: nowIso })
    .eq("id", chatGroupId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .select("id");
  assertAffected(data as unknown[] | null, error);

  // 2) soft-delete ข้อมูลลูกในกลุ่ม (best-effort — ให้หายจาก dashboard/ไม่วิเคราะห์ต่อ)
  await softDeleteChildren(db, tenantId, chatGroupId, nowIso);

  // 3) audit (append-only) — บันทึกการลบกลุ่ม
  const { error: auditErr } = await db.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: actorUserId,
    action: "chat_group_deleted",
    resource: "chat_group",
    resource_id: chatGroupId,
    meta: { soft_deleted_at: nowIso },
  });
  if (auditErr) throw new Error(auditErr.message);
}
