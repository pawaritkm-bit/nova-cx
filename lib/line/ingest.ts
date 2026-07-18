import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineOa } from "@/lib/env";
import type { LineClient } from "@/lib/line/client";
import type { QueuedLineEvent } from "@/lib/line/webhook";

/**
 * Ingestion (Phase 1): เก็บข้อความจากกลุ่ม/ห้อง LINE ลง chat_* (เข้ารหัสแล้ว)
 *   - upsert chat_group (by provider+group_ref) + best-effort chat_channel_id
 *   - upsert chat_member (by group+line_user) + best-effort ระบุตัวตน (line_users → customer)
 *   - persist chat_message: idempotent by line_message_id (ซ้ำ = skip)
 *   - media (image/video/audio/file) → metadata ใน message_attachments (ยังไม่ดึง binary)
 *
 * ★ content_enc มาจาก payload (เข้ารหัสตั้งแต่ตอน enqueue) — ที่นี่ไม่แตะ plaintext เลย
 * ★ ยังไม่ enqueue AI (Phase 2)
 *
 * degrade อย่างสุภาพ: resolve ไม่เจอ = ไม่ผูก (ไม่ throw), 1:1/ไม่มี group = skip
 */

const MEDIA_TYPES = new Set(["image", "video", "audio", "file"]);
const PROVIDER = "line";

export type IngestResult =
  | { status: "skipped"; reason: string }
  | { status: "duplicate"; lineMessageId: string }
  | {
      status: "stored";
      chatGroupId: string;
      lineMessageId: string;
      /** ลูกค้าที่ผูกกับกลุ่ม (จาก chat_groups.customer_id) — null ถ้ายังไม่จับคู่ */
      customerId: string | null;
    };

export type IngestDeps = {
  db: SupabaseClient;
  /** client ของ OA (null = ไม่มี credential → ข้ามการดึงชื่อสมาชิก) */
  client?: LineClient | null;
  now?: () => Date;
};

/** แปลง event.timestamp (ms) → ISO string; ไม่มี/เพี้ยน = ใช้ now */
function sentAtIso(timestampMs: number | undefined, now: Date): string {
  if (typeof timestampMs === "number" && Number.isFinite(timestampMs)) {
    const d = new Date(timestampMs);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return now.toISOString();
}

/** หา chat_channel ของ OA นี้ใน tenant (best-effort) → id หรือ null */
async function resolveChatChannelId(
  db: SupabaseClient,
  tenantId: string,
  oa: LineOa
): Promise<string | null> {
  const { data } = await db
    .from("chat_channels")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("provider", PROVIDER)
    .eq("oa_type", oa)
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * resolve ตัวตนสมาชิกจาก line_user_id (best-effort)
 *   เทียบกับ line_users (บัญชี LINE ลูกค้าที่รู้จัก) → ถ้าเจอ + ผูกลูกค้าแล้ว = 'customer'
 *   ★ พนักงาน (accountant) ยัง resolve ไม่ได้ — LINE ไม่บอก และ employees ยังไม่มี line_user_id
 *     ต้องมี flow ลงทะเบียนสมาชิก→พนักงานใน Phase หลัง (member_kind คงเป็น 'unknown')
 */
async function resolveMemberIdentity(
  db: SupabaseClient,
  tenantId: string,
  lineUserId: string
): Promise<{ memberKind: string; lineUserRef: string | null }> {
  const { data } = await db
    .from("line_users")
    .select("id, customer_id")
    .eq("tenant_id", tenantId)
    .eq("line_user_id", lineUserId)
    .is("deleted_at", null)
    .maybeSingle();

  const row = data as { id?: string; customer_id?: string | null } | null;
  if (row?.id) {
    return {
      memberKind: row.customer_id ? "customer" : "unknown",
      lineUserRef: row.id,
    };
  }
  return { memberKind: "unknown", lineUserRef: null };
}

/**
 * ประมวลผล message event จากกลุ่ม/ห้อง — persist ลง chat_*
 *   คืน IngestResult ให้ worker ตัดสินใจ (stored/duplicate/skipped)
 */
export async function ingestGroupMessage(
  deps: IngestDeps,
  tenantId: string,
  oa: LineOa,
  event: QueuedLineEvent
): Promise<IngestResult> {
  const now = deps.now ? deps.now() : new Date();
  const db = deps.db;

  const sourceType = event.source?.type;
  // Phase 1: เก็บเฉพาะแชตกลุ่ม/ห้อง — 1:1 (user) ปล่อยผ่าน (survey/follow domain เดิม)
  if (sourceType !== "group" && sourceType !== "room") {
    return { status: "skipped", reason: "not_group_or_room" };
  }
  const groupRef = sourceType === "group" ? event.source?.groupId : event.source?.roomId;
  if (!groupRef) return { status: "skipped", reason: "missing_group_ref" };

  const lineMessageId = event.message?.id;
  if (!lineMessageId) return { status: "skipped", reason: "missing_message_id" };

  // --- (1) upsert chat_group (source of truth ของ customer_id ไม่ถูกแตะ) ---
  const chatChannelId = await resolveChatChannelId(db, tenantId, oa);
  const groupUpsert: Record<string, unknown> = {
    tenant_id: tenantId,
    provider: PROVIDER,
    group_ref: groupRef,
    group_kind: sourceType,
    is_active: true,
  };
  if (chatChannelId) groupUpsert.chat_channel_id = chatChannelId;

  const { data: groupRow, error: groupErr } = await db
    .from("chat_groups")
    .upsert(groupUpsert, { onConflict: "provider,group_ref" })
    .select("id, customer_id")
    .maybeSingle();
  if (groupErr) throw groupErr;
  const groupData = groupRow as { id?: string; customer_id?: string | null } | null;
  const chatGroupId = groupData?.id;
  if (!chatGroupId) return { status: "skipped", reason: "chat_group_upsert_failed" };
  // resolve group→customer: source of truth = chat_groups.customer_id (จับคู่โดยแอดมิน Phase หลัง)
  const customerId = groupData?.customer_id ?? null;

  // --- (2) upsert chat_member (best-effort ระบุตัวตน) ---
  let chatMemberId: string | null = null;
  const senderLineUserId = event.source?.userId;
  if (senderLineUserId) {
    let displayName: string | null = null;
    const client = deps.client ?? null;
    if (client) {
      const profile = await client.getGroupMemberProfile(sourceType, groupRef, senderLineUserId);
      displayName = profile?.displayName ?? null;
    }

    const { memberKind, lineUserRef } = await resolveMemberIdentity(db, tenantId, senderLineUserId);

    const memberUpsert: Record<string, unknown> = {
      tenant_id: tenantId,
      chat_group_id: chatGroupId,
      line_user_id: senderLineUserId,
      member_kind: memberKind,
    };
    if (displayName) memberUpsert.display_name = displayName;
    if (lineUserRef) memberUpsert.line_user_ref = lineUserRef;

    const { data: memberRow, error: memberErr } = await db
      .from("chat_members")
      .upsert(memberUpsert, { onConflict: "chat_group_id,line_user_id" })
      .select("id")
      .maybeSingle();
    if (memberErr) throw memberErr;
    chatMemberId = (memberRow as { id?: string } | null)?.id ?? null;
  }

  // --- (3) idempotency: line_message_id ซ้ำ → skip (กันนับซ้ำเมื่อ LINE ส่ง webhook ซ้ำ) ---
  const { data: existing } = await db
    .from("chat_messages")
    .select("id")
    .eq("line_message_id", lineMessageId)
    .maybeSingle();
  if ((existing as { id?: string } | null)?.id) {
    return { status: "duplicate", lineMessageId };
  }

  // --- (4) persist chat_message (content_enc = ciphertext จาก payload; ไม่มี plaintext) ---
  const messageType = event.message?.type ?? "text";
  // raw_meta: metadata ที่ไม่มี PII ดิบ (ไม่มีเนื้อหาข้อความ)
  const rawMeta: Record<string, unknown> = {
    source_type: sourceType,
    oa,
  };
  if (event.message?.encSkipped) rawMeta.enc_skipped = true;

  const { data: msgRow, error: msgErr } = await db
    .from("chat_messages")
    .insert({
      tenant_id: tenantId,
      chat_group_id: chatGroupId,
      line_message_id: lineMessageId,
      sender_line_user_id: senderLineUserId ?? null,
      chat_member_id: chatMemberId,
      message_type: messageType,
      content_enc: event.message?.contentEnc ?? null,
      sent_at: sentAtIso(event.timestamp, now),
      raw_meta: rawMeta,
    })
    .select("id")
    .maybeSingle();
  if (msgErr) throw msgErr;
  const chatMessageId = (msgRow as { id?: string } | null)?.id;

  // --- (5) media → metadata ใน message_attachments (Phase 1 ยังไม่ดึง binary) ---
  if (chatMessageId && MEDIA_TYPES.has(messageType)) {
    await db.from("message_attachments").insert({
      tenant_id: tenantId,
      chat_message_id: chatMessageId,
      attachment_type: messageType,
      line_content_id: lineMessageId, // LINE ใช้ message.id เป็น content id สำหรับดึง binary
      status: "pending",
    });
  }

  return { status: "stored", chatGroupId, lineMessageId, customerId };
}
