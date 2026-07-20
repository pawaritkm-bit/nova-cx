import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineOa } from "@/lib/env";
import type { LineClient } from "@/lib/line/client";
import type { QueuedLineEvent } from "@/lib/line/webhook";
import { encryptField, hasEncKey } from "@/lib/crypto/field";

/**
 * Ingestion (Phase 1): เก็บข้อความจากกลุ่ม/ห้อง LINE ลง chat_* (เข้ารหัสแล้ว)
 *   - resolve/สร้าง chat_group (by provider+group_ref) + best-effort chat_channel_id
 *     ★ ไม่เขียนทับ is_active/tenant_id/customer_id ของกลุ่มที่มีอยู่ (source of truth)
 *   - upsert chat_member (by group+line_user) + best-effort ระบุตัวตน (line_users → customer)
 *     ★ display_name เข้ารหัสก่อนเก็บ (display_name_enc) — PDPA
 *   - persist chat_message: idempotent by line_message_id (ซ้ำ/race 23505 = duplicate)
 *   - media (image/video/audio/file) → metadata ใน message_attachments (idempotent, ยังไม่ดึง binary)
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

/** true เมื่อ error เป็น unique violation (Postgres 23505) — ใช้ตัดสิน idempotency race */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}

/** แปลง event.timestamp (ms) → ISO string; ไม่มี/เพี้ยน = ใช้ now */
function sentAtIso(timestampMs: number | undefined, now: Date): string {
  if (typeof timestampMs === "number" && Number.isFinite(timestampMs)) {
    const d = new Date(timestampMs);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return now.toISOString();
}

/**
 * หา chat_channel ของ OA นี้ใน tenant (best-effort) → id หรือ null
 *   ใช้ order+limit(1) แทน single แท้ ๆ เพื่อไม่ให้ throw เมื่อมีหลาย channel ต่อ oa_type
 */
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
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * resolve ตัวตนสมาชิกจาก line_user_id (best-effort)
 *   1) เทียบกับ line_users (บัญชี LINE ลูกค้าที่รู้จัก) → ถ้าเจอ + ผูกลูกค้าแล้ว = 'customer'
 *   2) ★ auto-resolve (ตัวช่วย 1C): ถ้าทางเดิมยังไม่ได้พนักงาน → สืบทอดจาก chat_members อื่น
 *      ใน tenant ที่ line_user_id เดียวกันและ "แอดมินยืนยันแล้ว" (employee_id ไม่ null)
 *      → สืบทอด employee_id + member_kind. สืบทอดเฉพาะจากที่ยืนยันแล้วเท่านั้น ไม่เดาเอง
 *   order+limit(1) → best-effort ไม่ throw ถ้าเจอ >1 แถว
 */
async function resolveMemberIdentity(
  db: SupabaseClient,
  tenantId: string,
  lineUserId: string
): Promise<{ memberKind: string; lineUserRef: string | null; employeeId: string | null }> {
  const { data } = await db
    .from("line_users")
    .select("id, customer_id")
    .eq("tenant_id", tenantId)
    .eq("line_user_id", lineUserId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const row = data as { id?: string; customer_id?: string | null } | null;
  const lineUserRef = row?.id ?? null;

  // เป็นลูกค้าที่รู้จักแล้ว (line_users ผูก customer) → ไม่ต้องสืบทอดพนักงาน
  if (row?.id && row.customer_id) {
    return { memberKind: "customer", lineUserRef, employeeId: null };
  }

  // สืบทอดจากการจับคู่ที่แอดมินยืนยันแล้ว (คนเดียวกัน คนละกลุ่ม)
  const inherited = await inheritConfirmedIdentity(db, tenantId, lineUserId);
  if (inherited) {
    return { memberKind: inherited.memberKind, lineUserRef, employeeId: inherited.employeeId };
  }

  return { memberKind: "unknown", lineUserRef, employeeId: null };
}

/**
 * lookup การจับคู่สมาชิกที่ "ยืนยันแล้ว" (employee_id ไม่ null) ของ line_user_id เดียวกัน
 *   ใน tenant นี้ (กลุ่มใดก็ได้) → คืน employee_id + member_kind เพื่อสืบทอด
 *   ★ ต้องยืนยันแล้วเท่านั้น (employee_id IS NOT NULL = แอดมินตั้งผ่านหน้าจับคู่) ไม่เดาเอง
 *   order updated_at desc + limit(1) → เอาการยืนยันล่าสุด ไม่ throw ถ้าเจอหลายแถว
 */
async function inheritConfirmedIdentity(
  db: SupabaseClient,
  tenantId: string,
  lineUserId: string
): Promise<{ employeeId: string; memberKind: string } | null> {
  const { data } = await db
    .from("chat_members")
    .select("employee_id, member_kind")
    .eq("tenant_id", tenantId)
    .eq("line_user_id", lineUserId)
    .not("employee_id", "is", null)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = data as { employee_id?: string | null; member_kind?: string | null } | null;
  if (!row?.employee_id) return null;
  // member_kind ต้องเป็นค่า enum เดิม; ถ้าเป็นค่าที่ผูกพนักงานได้ให้ใช้ตามนั้น มิฉะนั้น fallback 'accountant'
  const kind =
    row.member_kind === "accountant" || row.member_kind === "lead" ? row.member_kind : "accountant";
  return { employeeId: row.employee_id, memberKind: kind };
}

/**
 * resolve หรือสร้าง chat_group โดย "ไม่เขียนทับ" is_active/tenant_id/customer_id ของกลุ่มเดิม
 *   - มีอยู่แล้ว → คืน id + customer_id เดิม (ไม่แตะ flag ที่แอดมินตั้ง)
 *   - ยังไม่มี → insert ใหม่ (จับ 23505 กรณี race แล้ว re-select)
 */
async function resolveOrCreateGroup(
  db: SupabaseClient,
  tenantId: string,
  groupRef: string,
  groupKind: "group" | "room",
  chatChannelId: string | null
): Promise<{ id: string; customerId: string | null; hasName: boolean } | null> {
  const selectExisting = () =>
    db
      .from("chat_groups")
      .select("id, customer_id, display_name_enc")
      .eq("provider", PROVIDER)
      .eq("group_ref", groupRef)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

  type GroupRow = { id?: string; customer_id?: string | null; display_name_enc?: string | null };

  const { data: existing } = await selectExisting();
  const ex = existing as GroupRow | null;
  if (ex?.id) {
    return { id: ex.id, customerId: ex.customer_id ?? null, hasName: !!ex.display_name_enc };
  }

  const row: Record<string, unknown> = {
    tenant_id: tenantId,
    provider: PROVIDER,
    group_ref: groupRef,
    group_kind: groupKind,
    is_active: true,
  };
  if (chatChannelId) row.chat_channel_id = chatChannelId;

  const { data: inserted, error } = await db
    .from("chat_groups")
    .insert(row)
    .select("id, customer_id, display_name_enc")
    .maybeSingle();

  if (error) {
    // race: อีก event สร้างกลุ่มพร้อมกัน → re-select เอา id เดิม (ไม่ throw)
    if (isUniqueViolation(error)) {
      const { data: after } = await selectExisting();
      const a = after as GroupRow | null;
      if (a?.id) return { id: a.id, customerId: a.customer_id ?? null, hasName: !!a.display_name_enc };
    }
    throw error;
  }

  const ins = inserted as GroupRow | null;
  if (!ins?.id) return null;
  // กลุ่มที่เพิ่งสร้าง ยังไม่มีชื่อเสมอ (hasName=false → caller จะไปดึงชื่อ)
  return { id: ins.id, customerId: ins.customer_id ?? null, hasName: !!ins.display_name_enc };
}

/**
 * ดึงชื่อกลุ่มจาก LINE แล้วเก็บเป็น ciphertext ลง chat_groups.display_name_enc — best-effort
 *   เรียกเฉพาะตอน "ยังไม่มีชื่อ" (display_name_enc null) เพื่อไม่ยิง API ซ้ำทุกข้อความ
 *   เงื่อนไขที่ทำงาน:
 *     - มี client (มี LINE credential) และมีคีย์เข้ารหัส (hasEncKey) — ไม่มีคีย์ = ไม่เก็บ (ตาม pattern เดิม)
 *     - เฉพาะ group เท่านั้น (LINE ไม่มี summary API สำหรับ room)
 *   update ใช้ guard `.is(display_name_enc, null)` กันเขียนทับชื่อที่มีอยู่แล้ว (กัน race)
 *   ★ best-effort: ทุก error กลืน (log warn) ไม่ให้ ingest/worker พัง
 */
export async function ensureGroupName(
  db: SupabaseClient,
  tenantId: string,
  chatGroupId: string,
  groupRef: string,
  groupKind: "group" | "room",
  client: LineClient | null
): Promise<void> {
  if (!client || !hasEncKey()) return;
  if (groupKind !== "group") return; // room ไม่มีชื่อ/ไม่มี summary API

  try {
    const summary = await client.getGroupSummary(groupRef);
    const groupName = summary?.groupName ?? null;
    if (!groupName) return; // ดึงไม่ได้ → คงว่างไว้ (ลองใหม่รอบหน้า)

    const displayNameEnc = encryptField(groupName);
    const { error } = await db
      .from("chat_groups")
      .update({ display_name_enc: displayNameEnc })
      .eq("id", chatGroupId)
      .eq("tenant_id", tenantId)
      .is("display_name_enc", null); // เขียนเฉพาะตอนยังว่าง (กันทับ + กัน race)
    if (error) {
      console.warn(
        `[line/ingest] set group display_name_enc failed (code=${
          (error as { code?: string }).code ?? "unknown"
        }) chat_group_id=${chatGroupId}`
      );
    }
  } catch (e) {
    // best-effort: ห้ามทำ ingest พัง — ไม่ log plaintext/ชื่อ
    console.warn(
      `[line/ingest] ensureGroupName error (${
        e instanceof Error ? e.name : "unknown"
      }) chat_group_id=${chatGroupId}`
    );
  }
}

/**
 * อ่าน member_kind เดิมของสมาชิก (chat_group_id, line_user_id) — best-effort
 *   ใช้กันการ downgrade "ป้ายที่แอดมินตั้ง" (system/customer/accountant/lead) กลับเป็น unknown (Y1)
 *   เรียกเฉพาะตอน resolve ได้ 'unknown' เท่านั้น (ไม่เพิ่ม query ในเคสที่ resolve ได้ค่าชัดเจน)
 */
async function selectExistingMemberKind(
  db: SupabaseClient,
  chatGroupId: string,
  lineUserId: string
): Promise<string | null> {
  const { data } = await db
    .from("chat_members")
    .select("member_kind")
    .eq("chat_group_id", chatGroupId)
    .eq("line_user_id", lineUserId)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  return (data as { member_kind?: string | null } | null)?.member_kind ?? null;
}

/** หา id ของ chat_message ตาม line_message_id (best-effort) → id หรือ null */
async function selectExistingMessageId(
  db: SupabaseClient,
  lineMessageId: string
): Promise<string | null> {
  const { data } = await db
    .from("chat_messages")
    .select("id")
    .eq("line_message_id", lineMessageId)
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * บันทึก metadata ไฟล์แนบแบบ idempotent (upsert onConflict) — เขียนได้ทั้งเส้น stored/duplicate
 *   เพื่อกัน attachment หายถาวรเมื่อ retry เจอ message duplicate (rev-M1)
 *   error = log อย่างเดียว (attachment เป็น metadata รอง ไม่ควรล้มทั้ง job)
 */
async function ensureAttachment(
  db: SupabaseClient,
  tenantId: string,
  chatMessageId: string,
  attachmentType: string,
  lineContentId: string
): Promise<void> {
  const { error } = await db.from("message_attachments").upsert(
    {
      tenant_id: tenantId,
      chat_message_id: chatMessageId,
      attachment_type: attachmentType,
      line_content_id: lineContentId, // LINE ใช้ message.id เป็น content id สำหรับดึง binary
      status: "pending",
    },
    { onConflict: "chat_message_id,line_content_id" }
  );
  if (error) {
    console.warn(
      `[line/ingest] message_attachments upsert failed (code=${
        (error as { code?: string }).code ?? "unknown"
      }) chat_message_id=${chatMessageId}`
    );
  }
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

  const messageType = event.message?.type ?? "text";
  const isMedia = MEDIA_TYPES.has(messageType);

  // --- (1) resolve/สร้าง chat_group (ไม่เขียนทับ is_active/tenant_id/customer_id ของกลุ่มเดิม) ---
  const chatChannelId = await resolveChatChannelId(db, tenantId, oa);
  const group = await resolveOrCreateGroup(db, tenantId, groupRef, sourceType, chatChannelId);
  if (!group) return { status: "skipped", reason: "chat_group_upsert_failed" };
  const chatGroupId = group.id;
  const customerId = group.customerId; // resolve group→customer (source of truth)

  // fetch-if-missing: ยังไม่มีชื่อกลุ่ม → ดึงจาก LINE แล้วเก็บ ciphertext (best-effort, ไม่ยิงซ้ำถ้ามีแล้ว)
  if (!group.hasName) {
    await ensureGroupName(db, tenantId, chatGroupId, groupRef, sourceType, deps.client ?? null);
  }

  // --- (2) upsert chat_member (best-effort ระบุตัวตน + display_name เข้ารหัส) ---
  let chatMemberId: string | null = null;
  const senderLineUserId = event.source?.userId;
  if (senderLineUserId) {
    // ดึงชื่อเฉพาะเมื่อมีคีย์ (จะเก็บเป็น ciphertext เท่านั้น — ไม่มีคีย์ = ไม่เก็บชื่อ ไม่มี plaintext)
    let displayNameEnc: string | null = null;
    const client = deps.client ?? null;
    if (client && hasEncKey()) {
      const profile = await client.getGroupMemberProfile(sourceType, groupRef, senderLineUserId);
      const displayName = profile?.displayName ?? null;
      if (displayName) displayNameEnc = encryptField(displayName);
    }

    const { memberKind, lineUserRef, employeeId } = await resolveMemberIdentity(
      db,
      tenantId,
      senderLineUserId
    );

    const memberUpsert: Record<string, unknown> = {
      tenant_id: tenantId,
      chat_group_id: chatGroupId,
      line_user_id: senderLineUserId,
    };
    if (displayNameEnc) memberUpsert.display_name_enc = displayNameEnc;
    if (lineUserRef) memberUpsert.line_user_ref = lineUserRef;
    // ★ สืบทอดพนักงานจากการจับคู่ที่ยืนยันแล้ว (ตัวช่วย 1C) — ผูกให้ระบุตัวตนได้ทันทีที่ ingest
    if (employeeId) memberUpsert.employee_id = employeeId;

    // member_kind: set ปกติ; แต่ถ้า resolve ได้ 'unknown' และแถวเดิมมีป้ายที่แอดมินตั้งไว้แล้ว
    //   (system/customer/accountant/lead) → "อย่าเขียนทับ" ให้คงค่าเดิม (Y1) — ไม่ downgrade known→unknown
    let includeMemberKind = true;
    if (memberKind === "unknown") {
      const existingKind = await selectExistingMemberKind(db, chatGroupId, senderLineUserId);
      if (existingKind && existingKind !== "unknown") includeMemberKind = false;
    }
    if (includeMemberKind) memberUpsert.member_kind = memberKind;

    const { data: memberRow, error: memberErr } = await db
      .from("chat_members")
      .upsert(memberUpsert, { onConflict: "chat_group_id,line_user_id" })
      .select("id")
      .maybeSingle();
    if (memberErr) throw memberErr;
    chatMemberId = (memberRow as { id?: string } | null)?.id ?? null;
  }

  // --- (3) idempotency (pre-check): line_message_id ซ้ำ → duplicate (กันนับซ้ำ) ---
  const existingId = await selectExistingMessageId(db, lineMessageId);
  if (existingId) {
    // กัน attachment หายถ้ารอบก่อน insert message สำเร็จแต่ attachment ล้ม (rev-M1)
    if (isMedia) await ensureAttachment(db, tenantId, existingId, messageType, lineMessageId);
    return { status: "duplicate", lineMessageId };
  }

  // --- (4) persist chat_message (content_enc = ciphertext จาก payload; ไม่มี plaintext) ---
  // raw_meta: metadata ที่ไม่มี PII ดิบ (ไม่มีเนื้อหาข้อความ)
  const rawMeta: Record<string, unknown> = { source_type: sourceType, oa };
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

  if (msgErr) {
    // race idempotency: webhook ยิงซ้ำพร้อมกัน → insert ตัวที่สองชน unique(line_message_id) (H1)
    if (isUniqueViolation(msgErr)) {
      const dupId = await selectExistingMessageId(db, lineMessageId);
      if (dupId && isMedia) await ensureAttachment(db, tenantId, dupId, messageType, lineMessageId);
      return { status: "duplicate", lineMessageId };
    }
    throw msgErr;
  }

  const chatMessageId = (msgRow as { id?: string } | null)?.id;

  // --- (5) media → metadata ใน message_attachments (idempotent; Phase 1 ยังไม่ดึง binary) ---
  if (chatMessageId && isMedia) {
    await ensureAttachment(db, tenantId, chatMessageId, messageType, lineMessageId);
  }

  return { status: "stored", chatGroupId, lineMessageId, customerId };
}

export type JoinResult =
  | { status: "skipped"; reason: string }
  | { status: "created"; chatGroupId: string };

/**
 * ประมวลผล event 'join' (บอทถูกเชิญเข้ากลุ่ม/ห้อง) — สร้าง chat_group + ดึงชื่อทันที
 *   เพื่อให้กลุ่มโผล่ในหน้า admin พร้อมชื่อทันทีที่เชิญบอท ไม่ต้องรอข้อความแรก
 *   ★ additive: ไม่แตะ flow message/follow เดิม; ใช้ resolveOrCreateGroup + ensureGroupName ร่วมกัน
 *   degrade: ไม่ใช่กลุ่ม/ข้อมูลไม่ครบ = skip (ไม่ throw)
 */
export async function ingestGroupJoin(
  deps: IngestDeps,
  tenantId: string,
  oa: LineOa,
  event: QueuedLineEvent
): Promise<JoinResult> {
  const db = deps.db;

  const sourceType = event.source?.type;
  if (sourceType !== "group" && sourceType !== "room") {
    return { status: "skipped", reason: "not_group_or_room" };
  }
  const groupRef = sourceType === "group" ? event.source?.groupId : event.source?.roomId;
  if (!groupRef) return { status: "skipped", reason: "missing_group_ref" };

  const chatChannelId = await resolveChatChannelId(db, tenantId, oa);
  const group = await resolveOrCreateGroup(db, tenantId, groupRef, sourceType, chatChannelId);
  if (!group) return { status: "skipped", reason: "chat_group_upsert_failed" };

  // ดึงชื่อทันทีถ้ายังไม่มี (best-effort — ไม่ยิงซ้ำถ้ากลุ่มเก่ามีชื่อแล้ว)
  if (!group.hasName) {
    await ensureGroupName(db, tenantId, group.id, groupRef, sourceType, deps.client ?? null);
  }

  return { status: "created", chatGroupId: group.id };
}
