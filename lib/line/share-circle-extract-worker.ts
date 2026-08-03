import type { SupabaseClient } from "@supabase/supabase-js";
import { extractShareCircles, type ShareCircleImage } from "@/lib/ai/share-circle";
import { normalizePeriodMonth } from "@/lib/share-circles/queries";
import { decryptField, hasEncKey } from "@/lib/crypto/field";
import { mimeFromPath } from "@/lib/line/bill-extract-worker";

/**
 * Share-circle extract worker — อ่าน "ลิสต์วงแชร์" (รูป + คำพิม) จากกลุ่มไลน์ของลูกค้า(ท้าว)
 *   ของ "เดือนที่เลือก" → ส่งเข้า AI สกัดเป็นตารางวง → เขียนลง share_circle_entries (source='ai')
 *
 *   ต่างจาก bill-extract-worker: ที่นี่ trigger แบบ on-demand (นักบัญชีกดปุ่มในแท็บวงแชร์)
 *   ไม่ใช่ cron ไล่คิว — รับ customerId + month แล้วดึงเฉพาะเดือนนั้น
 *
 * ★ PDPA: ถอดรหัส content_enc "เฉพาะในหน่วยความจำ" ตอนส่งเข้า AI — ไม่เก็บ plaintext ลง DB
 *   (source_text ของ entry เก็บแค่สรุปย่อวง = ชื่อวง ไม่ใช่เนื้อแชตดิบ)
 *   ห้าม log ชื่อลูกค้า/เนื้อข้อความ/ตัวเลข — log แค่ error สั้น ๆ
 * ★ idempotent: ก่อนเขียน จะ soft-delete entry 'ai' เดิมของ (ลูกค้า+เดือน) นี้ทิ้งก่อน
 *   (อ่านซ้ำ = แทนที่ผล AI เดิม) — entry ที่คนคีย์เอง (source='manual') ไม่แตะ
 * ★ degrade: ไม่มี OpenAI key / ไม่มี enc key / ไม่มีข้อมูล → { extracted:false, count:0 }
 */

const BILLS_BUCKET = "bills";

/** เพดานรูปที่ส่งเข้า AI ต่อครั้ง (กัน payload ใหญ่/ช้า) */
const MAX_IMAGES = 12;
/** เพดานข้อความรวม (chars) ที่ส่งเข้า AI */
const MAX_TEXT_CHARS = 20_000;
/** เพดาน message ที่สแกนต่อเดือน */
const MAX_MESSAGES = 500;

export type ShareCircleExtractResult = {
  /** true = สกัดด้วย AI ได้อย่างน้อย 1 วง */
  extracted: boolean;
  /** จำนวนวงที่เขียนลง DB */
  count: number;
};

/**
 * คำนวณช่วงเวลา [start, end) ของเดือน 'YYYY-MM' — ★ ตัดตาม "เวลาไทย" (Asia/Bangkok, UTC+7)
 *   sent_at เก็บเป็น UTC → ขอบเดือนไทย 00:00 = 17:00 UTC ของวันก่อนหน้า
 *   (กันโพสต์เที่ยงคืน–ตี7 ของวันที่ 1 หลุดไปนับเป็นเดือนก่อนหน้า — สำคัญเพราะเป็นเดือนภาษี)
 */
const TH_OFFSET_MS = 7 * 60 * 60 * 1000;
function monthRange(month: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  if (mo < 1 || mo > 12) return null;
  // instant UTC ที่ตรงกับ 00:00 น. เวลาไทย ของวันที่ 1 เดือนนั้น / เดือนถัดไป
  const start = new Date(Date.UTC(y, mo - 1, 1) - TH_OFFSET_MS);
  const end = new Date(Date.UTC(y, mo, 1) - TH_OFFSET_MS);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * ประมวลผลอ่านวงแชร์จากไลน์ 1 ครั้ง (customer + month)
 *   @param db service-role client · @param tenantId จาก session · customerId ต้อง in-scope แล้ว
 */
export async function extractShareCirclesFromLine(
  db: SupabaseClient,
  tenantId: string,
  customerId: string,
  monthInput: string
): Promise<ShareCircleExtractResult> {
  const NONE: ShareCircleExtractResult = { extracted: false, count: 0 };

  // ★ บังคับเป็น ค.ศ. YYYY-MM เสมอ (กันเผลอส่ง พ.ศ. มา → range/period_month เพี้ยน)
  const month = normalizePeriodMonth(monthInput);
  const range = monthRange(month);
  if (!range) return NONE;

  // 1) กลุ่มไลน์ของลูกค้ารายนี้ (chat_groups.customer_id) — อาจมีหลายกลุ่ม
  const { data: groupData, error: groupErr } = await db
    .from("chat_groups")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId);
  if (groupErr) {
    console.warn(`[share-circle-worker] group error code=${(groupErr as { code?: string }).code ?? "?"}`);
    return NONE;
  }
  const groupIds = ((groupData ?? []) as { id: string }[]).map((g) => g.id);
  if (groupIds.length === 0) return NONE; // ยังไม่จับคู่กลุ่มไลน์ → ไม่มีอะไรให้อ่าน

  // 2) ข้อความในเดือนนั้น (ทุกกลุ่มของลูกค้า) — เอา id + type + content_enc
  const { data: msgData, error: msgErr } = await db
    .from("chat_messages")
    .select("id, message_type, content_enc, sent_at")
    .in("chat_group_id", groupIds)
    .gte("sent_at", range.start)
    .lt("sent_at", range.end)
    .is("deleted_at", null)
    .order("sent_at", { ascending: true })
    .limit(MAX_MESSAGES);
  if (msgErr) {
    console.warn(`[share-circle-worker] messages error code=${(msgErr as { code?: string }).code ?? "?"}`);
    return NONE;
  }
  const messages = (msgData ?? []) as {
    id: string;
    message_type: string;
    content_enc: string | null;
    sent_at: string | null;
  }[];
  if (messages.length === 0) return NONE;

  // 3) ถอดข้อความ text (in-memory เท่านั้น) — ต้องมี enc key ถึงจะอ่านได้
  const textParts: string[] = [];
  if (hasEncKey()) {
    for (const m of messages) {
      if (m.message_type !== "text" || !m.content_enc) continue;
      try {
        const t = decryptField(m.content_enc);
        if (t && t.trim()) textParts.push(t.trim());
      } catch {
        // ถอดไม่ได้ = ข้าม (best-effort) — ห้าม log ciphertext/plaintext
      }
    }
  }
  let text = textParts.join("\n");
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);

  // 4) รูปในเดือนนั้น (message_attachments ที่ stored) → ดาวน์โหลดเป็น base64
  const messageIds = messages.map((m) => m.id);
  const images: ShareCircleImage[] = [];
  {
    const { data: attData } = await db
      .from("message_attachments")
      .select("id, chat_message_id, drive_file_id")
      .in("chat_message_id", messageIds)
      .eq("attachment_type", "image")
      .eq("fetch_status", "stored")
      .not("drive_file_id", "is", null)
      .limit(MAX_IMAGES);
    for (const a of (attData ?? []) as { drive_file_id: string | null }[]) {
      const path = a.drive_file_id;
      if (!path) continue;
      try {
        const { data: blob, error: dlErr } = await db.storage.from(BILLS_BUCKET).download(path);
        if (dlErr || !blob) continue;
        const buf = Buffer.from(await blob.arrayBuffer());
        images.push({ base64: buf.toString("base64"), mime: mimeFromPath(path) });
      } catch {
        // ดาวน์โหลดพลาด → ข้ามรูปนั้น
      }
    }
  }

  if (!text && images.length === 0) return NONE; // ไม่มีทั้งข้อความ+รูป

  // 5) ส่งเข้า AI สกัด
  const circles = await extractShareCircles({ text: text || undefined, images });
  if (circles.length === 0) return NONE;

  // 6) idempotent (insert ก่อน delete ทีหลัง) — กัน "ข้อมูลหาย" ถ้า insert ล้มหลัง delete
  //    ★ จับ cutoff = เวลาก่อน insert → insert วงใหม่ → ค่อย soft-delete วง 'ai' เก่า
  //      ที่ created_at < cutoff (ผลรอบก่อน) เท่านั้น · ไม่แตะ manual + ไม่แตะวงที่เพิ่ง insert
  //    ถ้า insert ล้ม = ของเก่ายังอยู่ครบ (ไม่ลบ) · ถ้า delete ล้ม = มีวงซ้ำชั่วคราว (นักบัญชีลบเองได้)
  const cutoff = new Date().toISOString();

  // 7) เขียนผลลง share_circle_entries (source='ai')
  const rows = circles.map((c) => ({
    tenant_id: tenantId,
    customer_id: customerId,
    period_month: month,
    circle_name: c.circle_name,
    round_note: c.round_note,
    member_count: c.member_count,
    principal_per_head: c.principal_per_head,
    tao_income: c.tao_income,
    mgmt_fee: c.mgmt_fee,
    operation_fee: c.operation_fee,
    interest_income: c.interest_income,
    expense: c.expense,
    source: "ai",
    source_ref: `line:${month}`,
    // ★ PDPA: เก็บแค่ชื่อวง (สรุปย่อ) ไม่ใช่เนื้อแชตดิบ
    source_text: c.circle_name,
    status: "active",
  }));
  const { error: insErr } = await db.from("share_circle_entries").insert(rows);
  if (insErr) {
    console.warn(`[share-circle-worker] insert error code=${(insErr as { code?: string }).code ?? "?"}`);
    return NONE; // insert ล้ม → ของเก่ายังอยู่ (ยังไม่ได้ลบ) ปลอดภัย
  }

  // 8) soft-delete ผล AI รอบก่อน (created_at < cutoff) — วงใหม่รอบนี้ created_at ≥ cutoff จึงไม่โดน
  const { error: delErr } = await db
    .from("share_circle_entries")
    .update({ deleted_at: cutoff })
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("period_month", month)
    .eq("source", "ai")
    .lt("created_at", cutoff)
    .is("deleted_at", null);
  if (delErr) {
    // ลบผลเก่าไม่สำเร็จ → มีวงซ้ำชั่วคราว (ไม่ critical — นักบัญชีลบเองได้) log สั้น ๆ
    console.warn(`[share-circle-worker] cleanup error code=${(delErr as { code?: string }).code ?? "?"}`);
  }

  return { extracted: true, count: rows.length };
}
