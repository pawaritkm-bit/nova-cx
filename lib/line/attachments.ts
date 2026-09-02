import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineOa } from "@/lib/env";
import { getLineClient } from "@/lib/line/client";
import { resolveSaleFolder, oaOneDriveRoot } from "@/lib/line/onedrive-mirror";
import { isBillStorageEnabled, storeBillFile } from "@/lib/storage/bill-storage";
import { isOneDriveEnabled } from "@/lib/storage/onedrive";
import { classifyBillImage } from "@/lib/ai/bill-classify";
import type { FinanceClassification } from "@/lib/accounting/classify-finance-doc";

/**
 * Bill Attachment pipeline (เฟส 1 ฝั่ง CX)
 *   ดึง binary รูปบิลจาก LINE → เก็บขึ้น storage (Supabase Storage / Drive) → บันทึก ref/สถานะ
 *   เรียกจาก cron แยก (process-attachments) เพื่อไม่หน่วง webhook ingest เดิม
 *
 * ★ backend เลือกผ่าน lib/storage/bill-storage (BILL_STORAGE_BACKEND, default = supabase)
 * ★ inert-by-default: ถ้า !isBillStorageEnabled() → return { disabled:true } (no-op)
 * ★ image + file: คิวป้อน attachment_type='image' และ 'file' — เก็บ "รูปบิล" + "ไฟล์เอกสาร"
 *   - รูป (image): คัดกรองด้วย AI (classifyBillImage) ก่อน store — เก็บเฉพาะเอกสารการเงิน
 *       keep=false (มั่นใจสูงว่าไม่ใช่บิล) → ไม่ store นับเป็น skipped ('not_a_bill')
 *       degrade: ไม่มี OpenAI key/error → classify คืน null → เก็บทุกรูปเหมือนเดิม (keep-if-unsure)
 *   - ไฟล์ (file): เก็บทุกไฟล์ (PDF/Excel/doc) โดย "ไม่คัด AI" → doc_kind='file'
 *       (bill-extract-worker จะดึงมาสร้าง bill_entry draft ต่อ — PDF ให้ AI อ่าน, อื่น ๆ draft ว่าง)
 *   ★ ไม่รวม video/audio (attachment_type อื่น) — ไม่ถูกดึง/ไม่สร้างบิล
 * ★ ยังไม่ส่งต่อ NOVA Sales (เฟสถัดไป)
 *
 * ⚠️ ความเสี่ยง timing: content ฝั่ง LINE มีอายุจำกัด ถ้า cron (ทุก 5 นาที) ดึงช้า
 *    เกินอายุ → getMessageContent คืน null → mark 'failed' + retry ได้ถึง 3 ครั้ง
 *    (fetch_attempts < 3). ถ้าจำเป็นต้องชัวร์กว่านี้ ควรลด interval cron หรือดึงทันที
 *    ตอน ingest (นอกสโคปเฟสนี้เพราะจะหน่วง webhook)
 *
 * ★ หมายเหตุคอลัมน์ DB: reuse `drive_file_id`/`drive_url` เป็น "storage ref" ทั่วไป
 *    (drive_file_id = objectPath, drive_url = signed URL/ลิงก์) ไม่ทำ migration
 *
 * ★ PDPA: ห้าม log plaintext ชื่อ/ชื่อไฟล์/คีย์ — decrypt ชื่อทำในหน่วยความจำเพื่อตั้ง
 *    ชื่อโฟลเดอร์บน storage เท่านั้น ไม่พิมพ์ออก log
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
  /** 'image' | 'file' — คัดวิธีจัดการ (รูปคัด AI, ไฟล์เก็บทุกอัน) */
  attachment_type: string;
  /** ชื่อไฟล์เดิม (file เท่านั้น) — ไว้ตั้งชื่อ storage + โชว์ · null ได้ */
  original_name: string | null;
  chat_messages: {
    sent_at: string | null;
    chat_groups: GroupContext | null;
  } | null;
};

/** context ของกลุ่ม (id/ลูกค้า/OA) จาก nested select */
type GroupContext = {
  id: string | null;
  customer_id: string | null;
  /** ★ 0126 กลุ่มรวมหลายบริษัท — customer_id ว่างโดยตั้งใจ แยกบริษัทตามสลิปตอนอ่านบิล */
  route_by_slip?: boolean | null;
  group_ref: string | null;
  display_name_enc: string | null;
  customers: { customer_code: string | null; customer_type: string | null } | null;
  chat_channels: { oa_type: string | null } | null;
};

/**
 * true = เป็นไฟล์สเตทเมนต์/รายงานแพลตฟอร์มที่รับได้ (PDF/Excel/CSV)
 *   ★ ใช้กับ sale OA เท่านั้น: ดึงเข้า OneDrive เฉพาะเอกสาร ไม่ดึงรูป (jpg/png) ตามที่ลูกค้าสั่ง
 *   ดูทั้ง mime และนามสกุลไฟล์เดิม (บางไฟล์มาเป็น application/octet-stream)
 */
function isFinanceDocFormat(mime: string, name: string | null | undefined): boolean {
  const m = (mime || "").toLowerCase();
  const n = (name || "").toLowerCase();
  const isPdf = m.includes("pdf") || n.endsWith(".pdf");
  const isExcel =
    m.includes("spreadsheetml") || m.includes("ms-excel") || m.includes("excel") ||
    n.endsWith(".xlsx") || n.endsWith(".xls");
  const isCsv = m.includes("csv") || n.endsWith(".csv");
  return isPdf || isExcel || isCsv;
}

/** map mime → นามสกุลไฟล์ (รูป + เอกสารทั่วไป) · เดาไม่ได้ = bin */
function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  // รูป
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  if (m.includes("heic")) return "heic";
  if (m.includes("heif")) return "heif";
  // เอกสาร (file message มักเป็น PDF/Office)
  if (m.includes("pdf")) return "pdf";
  if (m.includes("wordprocessingml")) return "docx";
  if (m.includes("msword")) return "doc";
  if (m.includes("spreadsheetml")) return "xlsx";
  if (m.includes("ms-excel")) return "xls";
  if (m.includes("presentationml")) return "pptx";
  if (m.includes("ms-powerpoint")) return "ppt";
  if (m.includes("zip")) return "zip";
  if (m.includes("csv")) return "csv";
  if (m.includes("plain")) return "txt";
  return "bin";
}

/**
 * sanitize ชื่อไฟล์เดิมให้เป็น "ASCII-safe" สำหรับ storage key (Supabase ไม่รับไทย → 400)
 *   เก็บเฉพาะ [A-Za-z0-9._-] · อักขระอื่น (ไทย/ช่องว่าง/`/`) → `_` แล้วยุบ `_` ซ้ำ
 *   คืน "" ถ้าผลลัพธ์ว่าง/เหลือแต่จุด (caller จะ fallback เป็นชื่อ timestamp)
 */
function sanitizeAsciiFileName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._]+/, ""); // ตัด . / _ นำหน้า (กันไฟล์ซ่อน/ชื่อเพี้ยน)
  // เหลือแต่จุด/ว่าง = ถือว่าใช้ไม่ได้
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : "";
}

/** แยกนามสกุลไฟล์จริงจากชื่อ (จุดสุดท้าย, ตัวอักษร/เลข 1-8 ตัว) → { base, ext } · ไม่มี → ext="" */
function splitNameExt(raw: string): { base: string; ext: string } {
  const m = raw.trim().match(/^(.*)\.([A-Za-z0-9]{1,8})$/);
  return m ? { base: m[1], ext: m[2].toLowerCase() } : { base: raw.trim(), ext: "" };
}

/** sanitize ชื่อฐานสำหรับ OneDrive: คงไทย/unicode ตัดเฉพาะอักขระต้องห้าม + ยุบช่องว่าง (ว่าง→"") */
// eslint-disable-next-line no-control-regex
const ONEDRIVE_FORBIDDEN = /[\/:*?"<>|\x00-\x1f\\]/g;
function sanitizeOneDriveBase(raw: string): string {
  const v = raw.replace(ONEDRIVE_FORBIDDEN, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return /\S/.test(v) ? v : "";
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

/**
 * resolve ชื่อโฟลเดอร์ลูกค้า — ต้องเป็น **ASCII เท่านั้น**
 *   (Supabase Storage key ไม่รับอักขระไทย/นอก ASCII → 400 InvalidKey)
 *   ★ ห้ามใช้ชื่อลูกค้า/ชื่อกลุ่ม (เป็นภาษาไทย + PDPA) — ใช้ customer_code หรือ group id เท่านั้น
 *   ลำดับ:
 *     1) customer_code (เช่น N023/P648 = ASCII)
 *     2) unassigned-<8 ตัวแรกของ chat_group id> (UUID = ASCII)
 *     3) unassigned (เผื่อไม่มี group id — ไม่ควรเกิดเพราะ inner join)
 *   ไม่ log ค่านี้ (PDPA)
 */
function resolveCustomerFolder(group: GroupContext): string {
  const code = group.customers?.customer_code?.trim();
  if (code) return code;
  const gid = group.id?.trim();
  if (gid) return `unassigned-${gid.slice(0, 8)}`;
  return "unassigned";
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
 * ปิดงานแบบ "ไม่ใช่บิล" — AI คัดกรองมั่นใจสูงว่าไม่ใช่เอกสารการเงิน → ไม่เก็บไฟล์
 *   นับเป็น skipped (ไม่ใช่ stored/failed): fetch_status='skipped', fetch_error='not_a_bill'
 *   บันทึกผลคัด (doc_kind='other', doc_checked=true) กัน backfill มาคัดซ้ำ
 *   ★ ใช้เฉพาะเมื่อ keep=false เท่านั้น (keep-if-unsure บังคับใน classifyBillImage แล้ว)
 */
async function markSkippedNotBill(
  db: SupabaseClient,
  id: string,
  confidence: number | null
): Promise<void> {
  const { error } = await db
    .from("message_attachments")
    .update({
      fetch_status: "skipped",
      fetch_error: "not_a_bill",
      fetched_at: new Date().toISOString(),
      doc_kind: "other",
      doc_confidence: confidence,
      doc_checked: true,
    })
    .eq("id", id);
  if (error) {
    console.warn(`[line/attachments] markSkippedNotBill update error id=${id} code=${(error as { code?: string }).code ?? "?"}`);
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
  docFields: Record<string, unknown>,
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
      ...docFields,
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
 * ไฟล์ storage (drive_file_id) นี้ยังมี attachment row "อื่น" ชี้อยู่ไหม
 *   ★ ป้องกันบั๊ก orphan: ไฟล์ที่ sha256 ซ้ำถูก dedup-reuse (หลาย row ชี้ไฟล์เดียว) → ถ้าลบไฟล์จริงตอนลบบิลใบเดียว
 *     row อื่นที่ reuse จะกลายเป็น orphan · จึงต้องลบไฟล์จริงเฉพาะเมื่อเป็น "ref สุดท้าย" เท่านั้น
 *   ★ เช็กไม่ได้/พลาด → คืน true (ถือว่ายังมี ref = ไม่ลบ ปลอดภัยกว่า orphan)
 */
export async function isFileStillReferenced(
  db: SupabaseClient,
  tenantId: string,
  driveFileId: string,
  exceptAttachmentId: string
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("message_attachments")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("drive_file_id", driveFileId)
      .neq("id", exceptAttachmentId)
      .limit(1);
    if (error) return true;
    return !!(data && data.length > 0);
  } catch {
    return true;
  }
}

/**
 * ประมวลผลรูปบิลที่ยังค้างคิว (pending/failed/processing-ค้าง) เป็น batch
 *   @returns สรุปจำนวน processed/stored/failed/skipped (หรือ {disabled:true} ถ้าปิดฟีเจอร์)
 */
export async function processPendingAttachments(
  db: SupabaseClient,
  opts: { limit?: number } = {}
): Promise<ProcessAttachmentsResult> {
  // inert: storage backend ยังไม่พร้อม → no-op
  if (!isBillStorageEnabled()) {
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
      `id, tenant_id, line_content_id, created_at, fetch_attempts, attachment_type, original_name,
       chat_messages!inner (
         sent_at,
         chat_groups!inner (
           id, customer_id, route_by_slip, group_ref, display_name_enc,
           customers ( customer_code, customer_type ),
           chat_channels ( oa_type )
         )
       )`
    )
    // ★ image + file: เก็บ "รูปบิล" และ "ไฟล์เอกสาร" (PDF/Excel/doc) ที่ลูกค้าส่งในกลุ่ม
    //   - รูป (image): คัด AI (keep-if-unsure) เก็บเฉพาะเอกสารการเงิน
    //   - ไฟล์ (file): เก็บทุกไฟล์ (ไม่คัด AI) → doc_kind='file' → ไปสร้าง bill_entry (draft) ต่อ
    //   ★ ไม่รวม video/audio — คิวไม่ป้อน (attachment_type อื่น) จึงไม่ถูกดึง/ไม่สร้างบิล
    .in("attachment_type", ["image", "file"])
    .lt("fetch_attempts", 3)
    .or(
      `fetch_status.in.(pending,failed),and(fetch_status.eq.processing,fetched_at.lt.${staleCutoffIso})`
    )
    // ★ ใหม่สุดก่อน (desc): LINE เก็บ binary ให้ดาวน์โหลดได้ชั่วคราว → รูปใหม่ยังดึงได้
    //   ต้องรีบเก็บก่อนหมดอายุ · รูปเก่า (เกิน ~ไม่กี่วัน) มักหมดอายุแล้ว ดึงไม่ได้อยู่ดี
    .order("created_at", { ascending: false })
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
  // ★ real-time: กลุ่ม (ผูกลูกค้าแล้ว) ที่เพิ่งได้ "บิล" ใหม่ → หลังเก็บไฟล์เสร็จ สั่งอ่านทันที (ไม่รอ cron)
  const billGroups = new Set<string>();

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
    const isFile = row.attachment_type === "file";

    // 2.4) ★ sale OA (สนง.บัญชี Finovas): ดึงเข้า OneDrive เฉพาะสเตทเมนต์/รายงานแพลตฟอร์ม (PDF/Excel/CSV)
    //   รูปภาพ (jpg/png) ไม่ต้องดึง → ปิดงานเป็น skipped ('sale_image_skipped') ไม่เก็บ ไม่อ่าน
    if ((group?.chat_channels?.oa_type || "") === "sale" && !isFinanceDocFormat(content.mime, row.original_name)) {
      await db
        .from("message_attachments")
        .update({
          fetch_status: "skipped",
          fetch_error: "sale_image_skipped",
          fetched_at: new Date().toISOString(),
          doc_kind: "other",
          doc_checked: true,
        })
        .eq("id", row.id);
      skipped++;
      continue;
    }

    // 2.5) คัดกรอง (ต่างกันตามชนิด):
    //   - ไฟล์ (file, PDF/เอกสาร): ★ ไม่คัด AI — เก็บทุกไฟล์เสมอ (classifyBillImage ใช้กับรูปเท่านั้น)
    //       set doc_kind='file' (ไม่ใช่ค่าใน DocKind หน้า UI — หน้าจอแยกไฟล์ด้วย attachment_type)
    //   - รูป (image): คัด AI (keep-if-unsure) เก็บเฉพาะเอกสารการเงิน · keep=false = ทิ้ง (not_a_bill)
    //       degrade: ไม่มี OpenAI key / error / timeout → classify คืน null → ถือว่า keep
    let docFields: Record<string, unknown>;
    if (isFile) {
      docFields = { doc_kind: "file", doc_confidence: null, doc_checked: true };
    } else {
      const classified = await classifyBillImage(content.data, content.mime);
      // ★ รูปที่ "ไม่ใช่บิล" (kind='other' — เช่น ภ.พ.30/ภ.ธ.40/สรุปรายได้/สกรีนช็อตเอกสาร) → ไม่ทิ้งแล้ว
      //   เก็บลง OneDrive โฟลเดอร์ "บิลอื่นๆ" ของลูกค้า ให้นักบัญชีเห็น · mark not_a_bill กันเข้า bill extraction (ไม่มีค่า AI)
      //   ★ classify=null (error/timeout) → ถือเป็น "บิล" (keep-if-unsure) → ไปไปป์ไลน์ปกติ ไม่ route ผิด
      if (classified && classified.kind === "other") {
        const oaT = group?.chat_channels?.oa_type || "";
        if (isOneDriveEnabled() && group && (oaT === "sale" || oaT === "care")) {
          try {
            const odRoot = oaOneDriveRoot(oaT);
            const odFolder = await resolveSaleFolder(group, odRoot);
            const oext = (row.original_name ? splitNameExt(row.original_name).ext : "") || extFromMime(content.mime) || "jpg";
            const ofn = `${safeStamp(row.chat_messages?.sent_at ?? null)}_${contentId}.${oext}`;
            await storeBillFile({
              db,
              tenantId: row.tenant_id,
              folderParts: [odFolder, "บิลอื่นๆ"],
              fileName: ofn,
              mime: content.mime,
              data: content.data,
              backendOverride: "onedrive",
              root: odRoot,
            });
          } catch {
            console.warn("[line/attachments] non-bill image → OneDrive บิลอื่นๆ failed");
          }
        }
        await markSkippedNotBill(db, row.id, classified.confidence);
        skipped++;
        continue;
      }
      // keep=true หรือ classify=null → เก็บต่อ + แนบผลคัด (doc_checked=true เสมอบนเส้นทาง forward)
      docFields = {
        doc_kind: classified ? classified.kind : null,
        doc_confidence: classified ? classified.confidence : null,
        doc_checked: true,
      };
    }

    // 3) dedup (ในรอบนี้): เจอ sha256 ที่เพิ่งอัปในรอบเดียวกัน → reuse ทันที ไม่แตะ Drive/DB dedup
    const inBatch = batchDedup.get(sha256);
    if (inBatch) {
      await finalizeReuse(db, row, sha256, content.data.length, inBatch, docFields, () => {
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
      await finalizeReuse(db, row, sha256, content.data.length, reuse, docFields, () => {
        skipped++;
      }, () => {
        failed++;
      });
      continue;
    }

    // 5) เก็บไฟล์ผ่าน storage abstraction: โฟลเดอร์ [ชื่อลูกค้า, เดือน YYYY-MM]
    //    ชื่อไฟล์:
    //      - รูป (image): <sent_at>_<contentId>.<ext> (เหมือนเดิม)
    //      - ไฟล์ (file): <contentId>_<original_name ที่ sanitize ASCII> ถ้ามีชื่อเดิม
    //          (prefix contentId = กันชื่อชนกันในโฟลเดอร์เดียว เพราะ upload upsert:false)
    //          ไม่มีชื่อเดิม/ชื่อ sanitize แล้วว่าง → fallback <sent_at>_<contentId>.<ext(mime)>
    const customerFolder = group ? resolveCustomerFolder(group) : "unassigned";
    const month = monthFolder(row.created_at);
    const stampBase = `${safeStamp(row.chat_messages?.sent_at ?? null)}_${contentId}`;

    // ★ เก็บ OneDrive:
    //   - sale OA (สนง.บัญชี Finovas): เอกสาร (PDF/Excel/CSV) → NOVA-Bills · รูปถูก skip ที่ 2.4 แล้ว
    //   - care OA (Finovas Care): "ไฟล์" (เอกสารทุกชนิด) → NOVA-Care · "รูป" → Supabase เหมือนเดิม
    //   OA อื่น/บิล: เก็บ Supabase · OneDrive ไม่พร้อม → fallback Supabase กันไฟล์หาย
    const oaType = group?.chat_channels?.oa_type || "";
    const isSaleOa = oaType === "sale";
    const isCareOa = oaType === "care";
    const useOneDrive =
      group !== null && isOneDriveEnabled() && (isSaleOa || (isCareOa && isFile));
    const oneDriveRoot = oaOneDriveRoot(oaType); // sale → NOVA-Bills · care → NOVA-Care

    // ชื่อไฟล์: ★ คงนามสกุลจริงเสมอ (กัน OneDrive/SharePoint พรีวิวไม่ได้เพราะไม่มี .pdf/.xlsx)
    //   นามสกุล = จากชื่อเดิม > เดาจาก mime · ฐานชื่อ: OneDrive คงไทยได้ · Supabase ต้อง ASCII
    //   ฐานว่าง (ชื่อไทยล้วนบน Supabase) → fallback <sent_at>_<contentId>
    const split = row.original_name ? splitNameExt(row.original_name) : { base: "", ext: "" };
    const ext = split.ext || extFromMime(content.mime) || "bin";
    let fileName = `${stampBase}.${ext}`;
    if (isFile && split.base) {
      const base = useOneDrive ? sanitizeOneDriveBase(split.base) : sanitizeAsciiFileName(split.base);
      if (base) fileName = `${contentId}_${base}.${ext}`;
    }
    const storeFolder = useOneDrive && group ? await resolveSaleFolder(group, oneDriveRoot) : customerFolder;

    // ★ subfolder-by-type (เฉพาะ OneDrive + เปิด auto-read): จัดประเภทจาก "เนื้อไฟล์" ครั้งเดียว
    //   → วางไฟล์ในโฟลเดอร์ย่อยตามชนิด (สเตทเมนต์ / รายงานแพลตฟอร์ม / บิลอื่นๆ) แล้วส่ง cls ต่อให้
    //   auto-read summarize โดยไม่อ่าน/จัดประเภทซ้ำ · ★ dynamic import: กัน dep หนัก (pdf/excel/AI) โหลดตอน cron init
    const autoReadOn = process.env.ACCT_AUTO_READ === "on" && useOneDrive && group !== null;
    let classification: FinanceClassification | undefined;
    if (autoReadOn) {
      try {
        const { extractAndClassify } = await import("@/lib/accounting/classify-finance-doc");
        classification = await extractAndClassify({
          db,
          chatGroupId: group?.id ?? "",
          tenantId: row.tenant_id,
          fileName,
          originalName: row.original_name,
          mime: content.mime,
          data: content.data,
          // ★ ประหยัดงบ: ปิด AI จัดประเภท "รูป" ทั้งหมด — สเตทเมนต์/แพลตฟอร์ม "รูป" ไม่ auto-summary (ใช้ AI vision แพง)
          //   เก็บเฉพาะดิจิทัล (PDF/Excel/CSV = deterministic ฟรี) · รูป → "other" (บิลไป bill-worker แยก)
          imageAiClassify: false,
        });
      } catch {
        classification = undefined; // จัดประเภทพลาด → วางแบบ flat (auto-read จะจัดเองภายหลัง)
      }
    }
    // OneDrive: [ลูกค้า, ชนิด] (มี cls) หรือ [ลูกค้า] (ไม่มี) · Supabase: คงโฟลเดอร์เดือนเดิม
    const storeFolderParts = useOneDrive
      ? classification
        ? [storeFolder, classification.subFolder]
        : [storeFolder]
      : [storeFolder, month];
    const saved = await storeBillFile({
      db,
      tenantId: row.tenant_id,
      folderParts: storeFolderParts,
      fileName,
      mime: content.mime,
      data: content.data,
      backendOverride: useOneDrive ? "onedrive" : undefined,
      root: useOneDrive ? oneDriveRoot : undefined,
    });
    if (!saved) {
      await markFailed(db, row.id, row.fetch_attempts, "storage_upload_failed");
      failed++;
      continue;
    }

    // ★ อ่านอัตโนมัติ + save ผลกลับ OneDrive (sale + care ที่เก็บลง OneDrive · gate ACCT_AUTO_READ · best-effort)
    //   ★ ส่ง classification ที่จัดไว้แล้วต่อ → auto-read summarize ในโฟลเดอร์ย่อยเดียวกัน ไม่อ่านซ้ำ
    //   ★ dynamic import: กัน dep หนัก (pdfjs/claude/sharp) โหลดตอน cron module init
    if (autoReadOn) {
      try {
        const { autoReadSaleAttachment } = await import("@/lib/line/auto-read");
        await autoReadSaleAttachment({
          db,
          chatGroupId: group?.id ?? "",
          group,
          month,
          fileName,
          originalName: row.original_name,
          mime: content.mime,
          data: content.data,
          classification,
        });
      } catch {
        console.warn("[attachments] auto-read import/run failed");
      }
    }

    // จำไว้ใน batch — แถวอื่นที่ sha256 เดียวกันในรอบนี้ reuse ได้เลย
    batchDedup.set(sha256, { fileId: saved.objectPath, url: saved.url });

    // 6) สำเร็จ → บันทึกแบบ 2 สเต็ป กัน orphan:
    //    6a) เขียน storage ref (drive_file_id=objectPath, drive_url=url) + sha256 ก่อน
    //        (แถวยังเป็น 'processing') ถ้าพลาดตรงนี้: retry จะเจอไฟล์ผ่าน dedup (มี drive_url)
    //        แล้ว reuse ไม่อัปซ้ำ
    const { error: linkErr } = await db
      .from("message_attachments")
      .update({
        drive_file_id: saved.objectPath,
        drive_url: saved.url,
        bytes: content.data.length,
        sha256,
        fetched_at: new Date().toISOString(),
        fetch_error: null,
        ...docFields,
      })
      .eq("id", row.id);
    if (linkErr) {
      // อัปขึ้น storage แล้วแต่บันทึก ref ไม่ได้ → mark failed. retry จะ reuse ผ่าน dedup (กัน orphan)
      await markFailed(db, row.id, row.fetch_attempts, "db_link_write_failed");
      failed++;
      continue;
    }

    //    6b) ปิดงาน: set fetch_status='stored' (แยกสเต็ป — ถ้า 6a สำเร็จแต่ 6b พลาด แถวค้าง
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
    // ★ เก็บกลุ่มที่ได้ "บิล" ใหม่ (ไม่ใช่สเตทเมนต์/แพลตฟอร์ม) + ผูกลูกค้าแล้ว → อ่านทันทีหลัง loop
    // ★ 0126: กลุ่มรวมหลายบริษัท (route_by_slip) customer_id ว่างโดยตั้งใจ — ต้องอ่านทันทีเหมือนกัน
    //   (บั๊กที่ผู้ใช้เจอ 2026-09-02: สลิปแรกในกลุ่มรวมค้าง pending ตลอด เพราะเกตนี้เช็คแค่ customer_id
    //    ส่วน cron extract-bills แบบตามเวลาปิดอยู่ → ไม่มีทางอื่นให้บิลถูกอ่านเลย)
    if (
      group?.id &&
      (group.customer_id || group.route_by_slip) &&
      (!classification || classification.type === "other")
    ) {
      billGroups.add(group.id);
    }
  }

  // ★ real-time: อ่านบิลใหม่ของกลุ่มที่เพิ่งได้รับ "ทันที" (ไม่รอ cron 30 นาที) — group-scoped, best-effort
  //   processBillExtraction คัดเฉพาะ eligible + linked + ยังไม่ทำ → อ่านแค่บิลใหม่ (ต้นทุนเท่า cron เดิม แต่เร็ว)
  if (billGroups.size > 0) {
    try {
      const { processBillExtraction } = await import("@/lib/line/bill-extract-worker");
      for (const chatGroupId of billGroups) {
        try {
          await processBillExtraction(db, { chatGroupId, limit: 10 });
        } catch {
          /* กลุ่มเดียวพลาด → ข้าม (best-effort) */
        }
      }
    } catch {
      console.warn("[attachments] realtime bill-extract import failed");
    }
  }

  return { processed, stored, failed, skipped };
}
