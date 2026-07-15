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
    type?: string;
    text?: string;
  };
};

/**
 * event ที่เก็บลง job_queue จริง (M2: trim PII)
 *   เก็บเฉพาะ field ที่ worker line_event ใช้ — ไม่เก็บ message.text (เนื้อหาแชตลูกค้า/PII)
 *   หรือ field เนื้อหาอื่นที่ไม่จำเป็น
 */
export type TrimmedLineEvent = {
  type: string;
  timestamp?: number;
  source?: {
    type?: string; // user | group | room
    userId?: string;
  };
};

/**
 * ตัด event ดิบให้เหลือเฉพาะ field ที่ worker ใช้ (follow/unfollow อ้าง type + source.userId)
 *   ทิ้ง message.text/replyToken/groupId/roomId ที่ไม่ได้ใช้ (ลด PII ค้างในคิว)
 */
export function trimLineEvent(event: LineWebhookEvent): TrimmedLineEvent {
  const trimmed: TrimmedLineEvent = { type: event.type };
  if (typeof event.timestamp === "number") trimmed.timestamp = event.timestamp;
  if (event.source) {
    trimmed.source = {};
    if (event.source.type) trimmed.source.type = event.source.type;
    if (event.source.userId) trimmed.source.userId = event.source.userId;
  }
  return trimmed;
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
 *   1) env LINE_TENANT_ID (multi-tenant future / บังคับชัด)
 *   2) tenant แรกในระบบ (เฟสแรก 1 tenant — Q2 default)
 * คืน null ถ้าไม่พบ tenant เลย (webhook จะ return 200 แต่ไม่ enqueue)
 *
 * M1 (guard): ถ้าไม่ตั้ง LINE_TENANT_ID และในระบบมี tenant มากกว่า 1 → route event
 *   ไปที่ tenant แรกเสมอ ซึ่ง "ไม่ปลอดภัยสำหรับ multi-tenant" (event ของ OA อาจไป
 *   ผิด tenant) → log warning ชัดเจนให้ ops รู้ตัว
 *
 * TODO(ก่อนเปิด multi-tenant): ทำ OA→tenant mapping จริง (คอลัมน์/ตาราง line_oa_channels
 *   เก็บ channel id ของแต่ละ OA → tenant_id) แล้ว resolve ด้วย mapping นั้นแทนการใช้ tenant แรก
 */
export async function resolveOaTenantId(
  db: SupabaseClient,
  _oa: LineOa
): Promise<string | null> {
  const override = getLineTenantId();
  if (override) return override;

  // ดึงมา 2 แถวเพื่อตรวจว่ามี tenant มากกว่า 1 หรือไม่ (แต่ยังใช้แถวแรก)
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
      `[line/webhook] multiple tenants but no LINE_TENANT_ID — using first tenant (${rows[0].id}), ` +
        `unsafe for multi-tenant. Set LINE_TENANT_ID or implement OA→tenant mapping (line_oa_channels) before enabling multi-tenant.`
    );
  }

  return rows[0].id;
}
