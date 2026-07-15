import type { SupabaseClient } from "@supabase/supabase-js";
import { getLineTenantId, type LineOa } from "@/lib/env";

/**
 * ตัวช่วยฝั่ง webhook: parse body + resolve tenant
 *   webhook เอง "ต้องเบา" — verify signature → enqueue → return 200
 *   การประมวลผลจริง (upsert line_users ฯลฯ) ทำใน worker line_event
 */

/** event เดี่ยวจาก LINE (เอาเฉพาะ field ที่เราสนใจ) */
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
 * TODO(chunk ถัดไป): map OA (channel id) → tenant ให้ชัดสำหรับ multi-tenant จริง
 */
export async function resolveOaTenantId(
  db: SupabaseClient,
  _oa: LineOa
): Promise<string | null> {
  const override = getLineTenantId();
  if (override) return override;

  const { data } = await db
    .from("tenants")
    .select("id")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return data ? (data as { id: string }).id : null;
}
