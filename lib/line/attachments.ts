import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineOa } from "@/lib/env";
import { getLineClient } from "@/lib/line/client";
import { isDriveEnabled, ensureFolderPath, uploadFile } from "@/lib/storage/drive";
import { decryptField, hasEncKey } from "@/lib/crypto/field";

/**
 * Bill Attachment pipeline (เฟส 1 ฝั่ง CX)
 *   ดึง binary รูปบิลจาก LINE → อัปขึ้น Google Drive → บันทึกลิงก์/สถานะ
 *   เรียกจาก cron แยก (process-attachments) เพื่อไม่หน่วง webhook ingest เดิม
 *
 * ★ inert-by-default: ถ้า !isDriveEnabled() → return { disabled:true } (no-op)
 * ★ เฟสนี้ทำเฉพาะ attachment_type='image' เท่านั้น (ข้าม video/audio/file)
 * ★ ยังไม่ส่งต่อ NOVA Sales / ยังไม่อ่าน-จำแนกบิล (เฟสถัดไป)
 *
 * ⚠️ ความเสี่ยง timing: content ฝั่ง LINE มีอายุจำกัด ถ้า cron (ทุก 5 นาที) ดึงช้า
 *    เกินอายุ → getMessageContent คืน null → mark 'failed' + retry ได้ถึง 3 ครั้ง
 *    (fetch_attempts < 3). ถ้าจำเป็นต้องชัวร์กว่านี้ ควรลด interval cron หรือดึงทันที
 *    ตอน ingest (นอกสโคปเฟสนี้เพราะจะหน่วง webhook)
 *
 * ★ PDPA: ห้าม log plaintext ชื่อ/ชื่อไฟล์/คีย์ — decrypt ชื่อทำในหน่วยความจำเพื่อตั้ง
 *    ชื่อโฟลเดอร์บน Drive เท่านั้น ไม่พิมพ์ออก log
 */

export type ProcessAttachmentsResult = {
  disabled?: boolean;
  processed: number;
  stored: number;
  failed: number;
  skipped: number;
};

/**
 * เวลาที่ยอมให้แถวค้างสถานะ 'processing' ก่อนถือว่า worker ตายกลางคัน แล้วดึงกลับมาทำใหม่
 *   (กัน race: worker คว้าแถว → set 'processing' → ตายก่อน mark ผล → แถวค้างถาวร)
 */
const PROCESSING_STALE_MS = 10 * 60 * 1000; // 10 นาที

/** แถว attachment ที่ดึงมาพร้อม context กลุ่ม/ลูกค้า/OA (จาก nested select) */
type AttachmentRow = {
  id: string;
  tenant_id: string;
  line_content_id: string | null;
  created_at: string;
  fetch_attempts: number;
  chat_messages: {
    sent_at: string | null;
    chat_groups: GroupContext | null;
  } | null;
};

/** context ของกลุ่ม (ลูกค้า/ชื่อกลุ่ม/OA) จาก nested select */
type GroupContext = {
  customer_id: string | null;
  display_name_enc: string | null;
  customers: { name: string | null; customer_code: string | null } | null;
  chat_channels: { oa_type: string | null } | null;
};

/** map mime รูป → นามสกุลไฟล์ (fallback bin) */
function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  if (m.includes("heic")) return "heic";
  if (m.includes("heif")) return "heif";
  return "bin";
}

/** 'YYYY-MM' จาก timestamp string (fallback เดือนปัจจุบันถ้า parse ไม่ได้) */
function monthFolder(ts: string): string {
  const d = new Date(ts);
  const use = isNaN(d.getTime()) ? new Date() : d;
  const y = use.getUTCFullYear();
  const mo = String(use.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${mo}`;
}

/** ทำ timestamp ให้ปลอดภัยกับชื่อไฟล์ (ตัดอักขระที่ FS/Drive ไม่ชอบ) */
function safeStamp(ts: string | null): string {
  const base = ts ?? new Date().toISOString();
  return base.replace(/[:.]/g, "-").replace(/[^\w\-T]/g, "");
}

/** resolve ชื่อโฟลเดอร์ลูกค้า (best-effort) — ไม่ log ค่านี้ (PDPA) */
function resolveCustomerFolder(group: GroupContext): string {
  // 1) ลูกค้าที่ผูกแล้ว: ใช้ชื่อ (plaintext) หรือ customer_code
  const cust = group.customers;
  if (cust) {
    if (cust.name && cust.name.trim()) return cust.name.trim();
    if (cust.customer_code && cust.customer_code.trim()) return cust.customer_code.trim();
  }
  // 2) ยังไม่ผูกลูกค้า แต่มีชื่อกลุ่ม (ciphertext) → decrypt best-effort
  if (group.display_name_enc && hasEncKey()) {
    try {
      const name = decryptField(group.display_name_enc);
      if (name && name.trim()) return name.trim();
    } catch {
      // ถอดไม่ได้ → ตกไป fallback
    }
  }
  // 3) ไม่รู้ลูกค้า
  return "ยังไม่ระบุลูกค้า";
}

/** resolve OA จาก channel (fallback 'care') */
function resolveOa(oaType: string | null | undefined): LineOa {
  return oaType === "sale" ? "sale" : "care";
}

/** อัปเดตสถานะ fail + เพิ่ม attempt (best-effort — error log อย่างเดียว) */
async function markFailed(
  db: SupabaseClient,
  id: string,
  attempts: number,
  reason: string
): Promise<void> {
  const { error } = await db
    .from("message_attachments")
    .update({
      fetch_status: "failed",
      fetch_error: reason,
      fetch_attempts: attempts + 1,
    })
    .eq("id", id);
  if (error) {
    console.warn(`[line/attachments] markFailed update error id=${id} code=${(error as { code?: string }).code ?? "?"}`);
  }
}

/**
 * ปิดงานแบบ reuse ลิงก์ไฟล์เดิม (dedup ในรอบ/ข้ามรอบ) — ไฟล์มีอยู่จริงบน Drive แล้ว
 *   จึงบันทึกลิงก์ + set 'stored' ในสเต็ปเดียวได้ (ไม่มีความเสี่ยง orphan เพราะไม่ได้อัปใหม่)
 */
async function finalizeReuse(
  db: SupabaseClient,
  row: AttachmentRow,
  sha256: string,
  bytes: number,
  reuse: { fileId: string | null; url: string },
  onOk: () => void,
  onFail: () => void
): Promise<void> {
  const { error } = await db
    .from("message_attachments")
    .update({
      drive_file_id: reuse.fileId,
      drive_url: reuse.url,
      bytes,
      sha256,
      fetched_at: new Date().toISOString(),
      fetch_status: "stored",
      fetch_error: null,
    })
    .eq("id", row.id);
  if (error) {
    await markFailed(db, row.id, row.fetch_attempts, "db_update_failed");
    onFail();
  } else {
    onOk(); // นับเป็น skipped (dedup) แต่ DB เป็น stored
  }
}

/**
 * Claim แถวแบบ atomic ก่อนลงมือทำ — กัน worker/cron สองรอบจับแถวเดียวกันแล้วอัปซ้ำ
 *   UPDATE ... SET fetch_status='processing' WHERE id=? AND (ยัง pending/failed หรือ
 *   processing ที่ค้างเกิน PROCESSING_STALE_MS) RETURNING id
 *   → คืน true เฉพาะแถวที่ "คว้าได้จริง" (DB คืนแถว). ถ้า worker อื่นคว้าไปแล้วจะคืน null
 *
 *   หมายเหตุ: ใช้ fetched_at เป็น timestamp เวลา claim (เขียนทับตอนสำเร็จอีกที) เพื่อวัด staleness
 */
async function claimAttachment(
  db: SupabaseClient,
  id: string,
  staleCutoffIso: string
): Promise<boolean> {
  const { data, error } = await db
    .from("message_attachments")
    .update({ fetch_status: "processing", fetched_at: new Date().toISOString() })
    .eq("id", id)
    // คว้าได้เมื่อ: ยัง pending/failed  หรือ  processing ที่ค้างเกินกำหนด (worker เดิมน่าจะตาย)
    .or(
      `fetch_status.in.(pending,failed),and(fetch_status.eq.processing,fetched_at.lt.${staleCutoffIso})`
    )
    .select("id")
    .maybeSingle();
  if (error) {
    console.warn(`[line/attachments] claim update error id=${id} code=${(error as { code?: string }).code ?? "?"}`);
    return false;
  }
  return data != null;
}

/**
 * ประมวลผลรูปบิลที่ยังค้างคิว (pending/failed/processing-ค้าง) เป็น batch
 *   @returns สรุปจำนวน processed/stored/failed/skipped (หรือ {disabled:true} ถ้าปิดฟีเจอร์)
 */
export async function processPendingAttachments(
  db: SupabaseClient,
  opts: { limit?: number } = {}
): Promise<ProcessAttachmentsResult> {
  // inert: ไม่มี env Drive → no-op
  if (!isDriveEnabled()) {
    return { disabled: true, processed: 0, stored: 0, failed: 0, skipped: 0 };
  }

  const limit = opts.limit ?? 20;
  const staleCutoffIso = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();

  // ดึงรูปที่ยังไม่สำเร็จ + ยังไม่เกิน 3 ครั้ง (เก่าก่อน) พร้อม context กลุ่ม/ลูกค้า/OA
  //   เงื่อนไข candidate:
  //     - pending/failed ที่ attempts < 3  (คิวปกติ + retry)
  //     - processing ที่ค้างเกิน PROCESSING_STALE_MS (worker เดิมตายกลางคัน — เอากลับมาทำใหม่)
  //
  // ★ inner join chat_messages → chat_groups ปลอดภัย ไม่ทำแถวค้างถาวร:
  //   ทุก message_attachment ถูกสร้างจาก ingest ผ่าน ensureAttachment() ที่ผูกกับ
  //   chat_message เสมอ และทุก chat_message มี chat_group_id เสมอ — ทั้งแชตกลุ่ม/ห้อง
  //   (ingestGroupMessage) และ 1:1 (ingestDirectMessage, group_kind='user') ล้วนสร้าง
  //   chat_groups ก่อน insert message. จึงไม่มี attachment ที่ไม่มี group ให้ถูก inner join ตัดทิ้ง
  //   (ref: lib/line/ingest.ts §5 ทั้งสอง handler)
  const { data, error } = await db
    .from("message_attachments")
    .select(
      `id, tenant_id, line_content_id, created_at, fetch_attempts,
       chat_messages!inner (
         sent_at,
         chat_groups!inner (
           customer_id, display_name_enc,
           customers ( name, customer_code ),
           chat_channels ( oa_type )
         )
       )`
    )
    .eq("attachment_type", "image")
    .lt("fetch_attempts", 3)
    .or(
      `fetch_status.in.(pending,failed),and(fetch_status.eq.processing,fetched_at.lt.${staleCutoffIso})`
    )
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.warn(`[line/attachments] select queue error code=${(error as { code?: string }).code ?? "?"}`);
    return { processed: 0, stored: 0, failed: 0, skipped: 0 };
  }

  const rows = (data ?? []) as unknown as AttachmentRow[];
  let processed = 0;
  let stored = 0;
  let failed = 0;
  let skipped = 0;

  // in-batch dedup: ถ้ารูป (sha256) เดียวกันโผล่หลายแถวในรอบเดียว จะอัปครั้งเดียวแล้ว reuse
  //   (DB ยังไม่เห็นแถวแรกว่ามี drive_url จนกว่าจะ commit — Map นี้อุดช่องนั้นภายในรอบ)
  const batchDedup = new Map<string, { fileId: string | null; url: string }>();

  for (const row of rows) {
    // 0) claim แบบ atomic ก่อนทำงานจริง — กัน worker/cron รอบอื่นจับแถวเดียวกันแล้วอัปซ้ำ
    //    คว้าไม่ได้ (worker อื่นชิงไป) → ข้าม ไม่นับ processed
    const claimed = await claimAttachment(db, row.id, staleCutoffIso);
    if (!claimed) continue;
    processed++;

    const contentId = row.line_content_id;
    if (!contentId) {
      await markFailed(db, row.id, row.fetch_attempts, "missing_line_content_id");
      failed++;
      continue;
    }

    const group = row.chat_messages?.chat_groups ?? null;
    const oa = resolveOa(group?.chat_channels?.oa_type);

    // 1) LINE client (ต้องมี access token ของ OA)
    const client = getLineClient(oa);
    if (!client) {
      await markFailed(db, row.id, row.fetch_attempts, "line_client_unavailable");
      failed++;
      continue;
    }

    // 2) ดึง binary — null = content หมดอายุ/ล้ม
    const content = await client.getMessageContent(contentId);
    if (!content) {
      await markFailed(db, row.id, row.fetch_attempts, "line_content_unavailable");
      failed++;
      continue;
    }

    const sha256 = createHash("sha256").update(content.data).digest("hex");

    // 3) dedup (ในรอบนี้): เจอ sha256 ที่เพิ่งอัปในรอบเดียวกัน → reuse ทันที ไม่แตะ Drive/DB dedup
    const inBatch = batchDedup.get(sha256);
    if (inBatch) {
      await finalizeReuse(db, row, sha256, content.data.length, inBatch, () => {
        skipped++;
      }, () => {
        failed++;
      });
      continue;
    }

    // 4) dedup (ข้ามรอบ): เคยเก็บ binary เดียวกันใน tenant นี้แล้ว (มี drive_url) → reuse ลิงก์เดิม
    //    ★ ไม่จำกัด fetch_status='stored' อีกต่อไป: ครอบเคส upload สำเร็จแต่ยังไม่ทัน set 'stored'
    //      (เช่น write DB พลาดกลางคัน แถวค้าง 'processing' แต่ drive_url ถูกเขียนไปแล้ว)
    //      → retry จะ reuse ไฟล์เดิม ไม่อัปซ้ำจนเกิด orphan บน Drive
    //    หมายเหตุ: อาจ match แถวตัวเอง (ถ้ารอบก่อนเขียน drive_url สำเร็จแต่ set 'stored' พลาด) —
    //      นั่นคือเส้นทาง recovery ที่ต้องการ (reuse ลิงก์ตัวเองแล้วปิดงานเป็น 'stored')
    const { data: dup } = await db
      .from("message_attachments")
      .select("drive_file_id, drive_url")
      .eq("tenant_id", row.tenant_id)
      .eq("sha256", sha256)
      .not("drive_url", "is", null)
      .limit(1)
      .maybeSingle();

    const dupRow = dup as { drive_file_id: string | null; drive_url: string | null } | null;
    if (dupRow && dupRow.drive_url) {
      const reuse = { fileId: dupRow.drive_file_id, url: dupRow.drive_url };
      batchDedup.set(sha256, reuse);
      await finalizeReuse(db, row, sha256, content.data.length, reuse, () => {
        skipped++;
      }, () => {
        failed++;
      });
      continue;
    }

    // 5) โฟลเดอร์: [ชื่อลูกค้า, เดือน YYYY-MM] ใต้ root
    const customerFolder = group ? resolveCustomerFolder(group) : "ยังไม่ระบุลูกค้า";
    const month = monthFolder(row.created_at);
    const folderId = await ensureFolderPath([customerFolder, month]);
    if (!folderId) {
      await markFailed(db, row.id, row.fetch_attempts, "drive_folder_failed");
      failed++;
      continue;
    }

    // 6) upload — ชื่อไฟล์ = <sent_at>_<contentId>.<ext>
    const ext = extFromMime(content.mime);
    const fileName = `${safeStamp(row.chat_messages?.sent_at ?? null)}_${contentId}.${ext}`;
    const uploaded = await uploadFile({
      name: fileName,
      mime: content.mime,
      data: content.data,
      folderId,
    });
    if (!uploaded) {
      await markFailed(db, row.id, row.fetch_attempts, "drive_upload_failed");
      failed++;
      continue;
    }

    // จำไว้ใน batch — แถวอื่นที่ sha256 เดียวกันในรอบนี้ reuse ได้เลย
    batchDedup.set(sha256, { fileId: uploaded.fileId, url: uploaded.url });

    // 7) สำเร็จ → บันทึกแบบ 2 สเต็ป กัน orphan:
    //    7a) เขียน drive_file_id/drive_url/sha256 ก่อน (แถวยังเป็น 'processing')
    //        ถ้าพลาดตรงนี้: retry จะเจอไฟล์ผ่าน dedup (มี drive_url) แล้ว reuse ไม่อัปซ้ำ
    const { error: linkErr } = await db
      .from("message_attachments")
      .update({
        drive_file_id: uploaded.fileId,
        drive_url: uploaded.url,
        bytes: content.data.length,
        sha256,
        fetched_at: new Date().toISOString(),
        fetch_error: null,
      })
      .eq("id", row.id);
    if (linkErr) {
      // อัปขึ้น Drive แล้วแต่บันทึกลิงก์ไม่ได้ → mark failed. retry จะ reuse ผ่าน dedup (กัน orphan)
      await markFailed(db, row.id, row.fetch_attempts, "db_link_write_failed");
      failed++;
      continue;
    }

    //    7b) ปิดงาน: set fetch_status='stored' (แยกสเต็ป — ถ้า 7a สำเร็จแต่ 7b พลาด แถวค้าง
    //        'processing' ที่มี drive_url แล้ว → รอบหน้า reuse ตัวเองปิดเป็น 'stored')
    const { error: statusErr } = await db
      .from("message_attachments")
      .update({ fetch_status: "stored", fetch_error: null })
      .eq("id", row.id);
    if (statusErr) {
      await markFailed(db, row.id, row.fetch_attempts, "db_status_write_failed");
      failed++;
      continue;
    }
    stored++;
  }

  return { processed, stored, failed, skipped };
}
