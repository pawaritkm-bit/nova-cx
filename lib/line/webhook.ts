import type { SupabaseClient } from "@supabase/supabase-js";
import { getLineTenantId, type LineOa } from "@/lib/env";

/**
 * ตัวช่วยฝั่ง webhook: parse body + resolve tenant
 *   webhook เอง "ต้องเบา" — verify signature → enqueue → return 200
 *   การประมวลผลจริง (upsert line_users ฯลฯ) ทำใน worker line_event
 */

/** event ดิบจาก LINE (parse แล้ว — อาจมี field เนื้อหา/PII ติดมา) */
export type LineWebhookEvent = {
  type: string; // follow | unfollow | message | ...
  timestamp?: number;
  replyToken?: string;
  source?: {
    type?: string; // user | group | room
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: {
    id?: string;
    type?: string;
    text?: string;
  };
};

/**
 * event ที่ผ่านการ trim แล้ว (ชั้นกลางก่อนเข้ารหัส) — ยัง "อาจ" มี message.text plaintext
 *   ★ อย่านำ shape นี้ไปเก็บลง job_queue ตรง ๆ — ต้องผ่าน toQueuedEvent() เข้ารหัสก่อนเสมอ
 *   follow/unfollow ใช้แค่ type + source.userId (คงพฤติกรรมเดิม)
 *   message (group/room) เพิ่ม: message.id/type/text + source.groupId/roomId เพื่อส่งต่อ handler
 */
export type TrimmedLineEvent = {
  type: string;
  timestamp?: number;
  source?: {
    type?: string; // user | group | room
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: {
    id?: string;
    type?: string;
    text?: string;
  };
};

/**
 * event ที่เก็บลง job_queue จริง — ★ ไม่มี plaintext เนื้อหาแชต
 *   contentEnc = ciphertext ของ message.text (เข้ารหัสแล้ว) หรือ null ถ้าไม่ใช่ text/ไม่มีคีย์
 */
export type QueuedLineEvent = {
  type: string;
  timestamp?: number;
  source?: {
    type?: string;
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: {
    id?: string;
    type?: string;
    /** ciphertext ของข้อความ (ไม่มี plaintext) — null ถ้าไม่ใช่ text หรือเข้ารหัสไม่ได้ */
    contentEnc?: string | null;
    /** true เมื่อมี text แต่เข้ารหัสไม่ได้ (ไม่มี CREDENTIAL_ENC_KEY) → ตัดทิ้งไม่เก็บ plaintext */
    encSkipped?: boolean;
  };
};

/**
 * ตัด event ดิบให้เหลือเฉพาะ field ที่ worker ใช้
 *   - follow/unfollow: type + source.userId (พฤติกรรมเดิม ไม่กระทบ)
 *   - message: เก็บ message.id/type/text + source.type/groupId/roomId เพื่อส่งต่อ handler
 *   ★ message.text ที่ติดมายังเป็น plaintext — ต้องส่งต่อ toQueuedEvent() เข้ารหัสก่อนเก็บ
 */
export function trimLineEvent(event: LineWebhookEvent): TrimmedLineEvent {
  const trimmed: TrimmedLineEvent = { type: event.type };
  if (typeof event.timestamp === "number") trimmed.timestamp = event.timestamp;
  if (event.source) {
    trimmed.source = {};
    if (event.source.type) trimmed.source.type = event.source.type;
    if (event.source.userId) trimmed.source.userId = event.source.userId;
    if (event.source.groupId) trimmed.source.groupId = event.source.groupId;
    if (event.source.roomId) trimmed.source.roomId = event.source.roomId;
  }
  if (event.type === "message" && event.message) {
    trimmed.message = {};
    if (event.message.id) trimmed.message.id = event.message.id;
    if (event.message.type) trimmed.message.type = event.message.type;
    if (typeof event.message.text === "string") trimmed.message.text = event.message.text;
  }
  return trimmed;
}

/** ฟังก์ชันเข้ารหัส field (inject ได้เพื่อ test) — คืน ciphertext จาก plaintext */
export type EncryptFn = (plaintext: string) => string;

/**
 * แปลง TrimmedLineEvent → QueuedLineEvent สำหรับเก็บลง job_queue
 *   ★ เข้ารหัส message.text เป็น contentEnc แล้ว "ตัด plaintext ทิ้ง" ก่อนคืนค่า
 *   - encrypt = null (ไม่มี CREDENTIAL_ENC_KEY): มี text → ตัดทิ้ง (encSkipped=true) ไม่เก็บ plaintext
 *   - event ที่ไม่ใช่ message: คืนค่าเหมือนเดิม (ไม่มี message เลย)
 */
export function toQueuedEvent(
  event: TrimmedLineEvent,
  encrypt: EncryptFn | null
): QueuedLineEvent {
  const queued: QueuedLineEvent = { type: event.type };
  if (typeof event.timestamp === "number") queued.timestamp = event.timestamp;
  if (event.source) queued.source = { ...event.source };

  if (event.type === "message" && event.message) {
    const { id, type, text } = event.message;
    const msg: NonNullable<QueuedLineEvent["message"]> = {};
    if (id) msg.id = id;
    if (type) msg.type = type;

    if (typeof text === "string" && text.length > 0) {
      if (encrypt) {
        msg.contentEnc = encrypt(text);
      } else {
        // ไม่มีคีย์ → ไม่เก็บ plaintext เด็ดขาด (เก็บแค่ envelope + flag)
        msg.contentEnc = null;
        msg.encSkipped = true;
      }
    } else {
      msg.contentEnc = null;
    }
    queued.message = msg;
  }

  return queued;
}

export type LineWebhookBody = {
  destination?: string;
  events?: LineWebhookEvent[];
};

/** parse JSON body ของ webhook (คืน events ว่างถ้า parse ไม่ได้ — ไม่ throw) */
export function parseWebhookBody(rawBody: string): LineWebhookBody {
  try {
    const parsed = JSON.parse(rawBody) as LineWebhookBody;
    if (!parsed || typeof parsed !== "object") return { events: [] };
    return { destination: parsed.destination, events: parsed.events ?? [] };
  } catch {
    return { events: [] };
  }
}

/**
 * หา tenant_id สำหรับ enqueue line_event
 *   0) mapping จริงจากตาราง chat_channels ตาม channel_ref (OA→tenant) — วิธีที่ถูกต้อง
 *   1) env LINE_TENANT_ID (multi-tenant future / บังคับชัด) — fallback
 *   2) tenant แรกในระบบ (เฟสแรก 1 tenant — Q2 default) — fallback สุดท้าย
 * คืน null ถ้าไม่พบ tenant เลย (webhook จะ return 200 แต่ไม่ enqueue)
 *
 * channelRef: ค่าอ้างอิง channel จาก webhook (LINE = body.destination = bot user id)
 *   ถ้าไม่ส่งมา/หา mapping ไม่เจอ → degrade ลง fallback เดิมอย่างนุ่มนวล (ไม่ทำ webhook พัง)
 *
 * M1 (guard): ถ้าตกมาถึง fallback tenant แรก และในระบบมี tenant มากกว่า 1 → route event
 *   ไปที่ tenant แรกเสมอ ซึ่ง "ไม่ปลอดภัยสำหรับ multi-tenant" (event ของ OA อาจไป
 *   ผิด tenant) → log warning ชัดเจนให้ ops รู้ตัว
 */
export async function resolveOaTenantId(
  db: SupabaseClient,
  _oa: LineOa,
  channelRef?: string | null
): Promise<string | null> {
  // (0) mapping จริงจาก chat_channels — วิธีที่ถูกต้องสำหรับ multi-tenant
  //     อ่านผ่าน service_role (bypass RLS) เฉพาะ channel ที่ active และยังไม่ถูกลบ
  if (channelRef) {
    const { data: channel } = await db
      .from("chat_channels")
      .select("tenant_id")
      .eq("provider", "line")
      .eq("channel_ref", channelRef)
      .eq("is_active", true)
      .is("deleted_at", null)
      .maybeSingle();

    const mappedTenantId = (channel as { tenant_id?: string } | null)?.tenant_id;
    if (mappedTenantId) return mappedTenantId;

    // ไม่พบ mapping → log แล้วตกลง fallback เดิม (ไม่ทำ webhook พัง)
    console.warn(
      `[line/webhook] no chat_channels mapping for channel_ref=${channelRef} (oa=${_oa}) — ` +
        `falling back to LINE_TENANT_ID / first tenant.`
    );
  }

  // (1) env override
  const override = getLineTenantId();
  if (override) return override;

  // (2) fallback: tenant แรกในระบบ — ดึง 2 แถวเพื่อตรวจว่ามี tenant มากกว่า 1 หรือไม่
  const { data } = await db
    .from("tenants")
    .select("id")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(2);

  const rows = (data ?? []) as { id: string }[];
  if (rows.length === 0) return null;

  if (rows.length > 1) {
    console.warn(
      `[line/webhook] multiple tenants but no chat_channels mapping / LINE_TENANT_ID — using first tenant (${rows[0].id}), ` +
        `unsafe for multi-tenant. Add a chat_channels row (provider='line', channel_ref=<OA destination>) or set LINE_TENANT_ID.`
    );
  }

  return rows[0].id;
}
