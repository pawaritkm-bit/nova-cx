import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyBillImage } from "@/lib/ai/bill-classify";
import { isTooSmallToBeBill } from "@/lib/accounting/image-prep";

/**
 * Bill classify backfill — คัดกรอง "ย้อนหลัง" รูปที่เก็บไปแล้วก่อนมีระบบคัดกรอง (เฟส 1 ฝั่ง CX)
 *   ทยอยดึงรูปที่ fetch_status='stored' แต่ doc_checked=false มาผ่าน AI:
 *     - keep=true / classify=null → เก็บต่อ (เซ็ต doc_kind/doc_confidence/doc_checked=true)
 *     - keep=false (มั่นใจสูงว่าไม่ใช่บิล) → ลบไฟล์ออกจาก bucket + set skipped/not_a_bill
 *
 * ⚠️ keep-if-unsure บังคับใน classifyBillImage แล้ว: ลบเฉพาะเมื่อ AI มั่นใจสูงว่าไม่ใช่บิล
 *   classify คืน null (ไม่มี key/error) → ถือว่า keep (ไม่ลบ) — degrade ปลอดภัย
 *
 * ★ backend: รองรับ Supabase Storage (bucket `bills`) — drive_file_id = objectPath
 * ★ PDPA: ไม่ log objectPath/เนื้อไฟล์ — log แค่ error สั้น ๆ
 */

/** bucket รูปบิล (ตรงกับ bill-storage.ts) */
const BILLS_BUCKET = "bills";

export type BackfillResult = {
  /** จำนวนรูปที่ผ่าน AI จริง (kept + deleted) */
  checked: number;
  /** เก็บต่อ (เอกสารการเงิน/ไม่มั่นใจ) */
  kept: number;
  /** ลบทิ้ง (มั่นใจว่าไม่ใช่เอกสารการเงิน) */
  deleted: number;
};

/** แถวที่รอคัดย้อนหลัง */
type BackfillRow = {
  id: string;
  tenant_id: string;
  drive_file_id: string | null;
};

/** เดา mime จากนามสกุลไฟล์ใน objectPath (fallback image/jpeg) */
function mimeFromPath(path: string): string {
  const m = path.toLowerCase();
  if (m.endsWith(".png")) return "image/png";
  if (m.endsWith(".gif")) return "image/gif";
  if (m.endsWith(".webp")) return "image/webp";
  if (m.endsWith(".heic")) return "image/heic";
  if (m.endsWith(".heif")) return "image/heif";
  return "image/jpeg";
}

/**
 * คัดกรองย้อนหลังรูปที่เก็บไปแล้ว (batch)
 *   @returns สรุป { checked, kept, deleted }
 */
export async function backfillClassify(
  db: SupabaseClient,
  opts: { limit?: number } = {}
): Promise<BackfillResult> {
  const limit = opts.limit ?? 20;

  // เลือกรูปที่เก็บสำเร็จแล้วแต่ยังไม่ผ่าน AI + มีไฟล์จริงบน storage
  const { data, error } = await db
    .from("message_attachments")
    .select("id, tenant_id, drive_file_id")
    .eq("attachment_type", "image")
    .eq("fetch_status", "stored")
    .eq("doc_checked", false)
    .not("drive_file_id", "is", null)
    .limit(limit);

  if (error) {
    console.warn(`[bill-backfill] select queue error code=${(error as { code?: string }).code ?? "?"}`);
    return { checked: 0, kept: 0, deleted: 0 };
  }

  const rows = (data ?? []) as unknown as BackfillRow[];
  let checked = 0;
  let kept = 0;
  let deleted = 0;

  for (const row of rows) {
    const objectPath = row.drive_file_id;
    if (!objectPath) continue;

    // 1) ดาวน์โหลด binary จาก Supabase Storage
    let buf: Buffer;
    try {
      const { data: blob, error: dlErr } = await db.storage.from(BILLS_BUCKET).download(objectPath);
      if (dlErr || !blob) {
        console.warn("[bill-backfill] download failed");
        continue; // ดาวน์โหลดไม่ได้ → ข้าม ไม่เปลี่ยนสถานะ (รอบหน้าลองใหม่)
      }
      buf = Buffer.from(await blob.arrayBuffer());
    } catch {
      console.warn("[bill-backfill] download error");
      continue;
    }

    // 1.5) ★ ประหยัด: รูปเล็กเกินกว่าจะเป็นบิล (สติกเกอร์/emoji/ธัมบ์เนล <350px) → mark ออกจากคิว
    //   ไม่ต้องยิง Gemini classify ทิ้ง (conservative — บิลจริง >1000px ไม่มีทางโดน)
    if (await isTooSmallToBeBill(buf, mimeFromPath(objectPath))) {
      await db
        .from("message_attachments")
        .update({ fetch_status: "skipped", fetch_error: "image_too_small", doc_kind: "other", doc_checked: true })
        .eq("id", row.id);
      continue;
    }

    // 2) คัดกรองด้วย AI
    const classified = await classifyBillImage(buf, mimeFromPath(objectPath));
    checked++;

    if (classified && !classified.keep) {
      // ★ ไม่ใช่เอกสารการเงิน → "ไม่ลบไฟล์" (ผู้ใช้สั่ง: เก็บไฟล์ไว้) · แค่ mark ออกจากคิว
      //   doc_kind='other' → ถูกกันออกจาก extraction (ไม่เสีย AI) · ไฟล์คงอยู่ใน bucket ตามเดิม
      const { error: updErr } = await db
        .from("message_attachments")
        .update({
          fetch_status: "skipped",
          fetch_error: "not_a_bill",
          doc_kind: "other",
          doc_confidence: classified.confidence,
          doc_checked: true,
        })
        .eq("id", row.id);
      if (updErr) {
        console.warn(`[bill-backfill] mark-deleted update error code=${(updErr as { code?: string }).code ?? "?"}`);
        checked--; // ไม่ถือว่าคัดสำเร็จถ้า DB เขียนพลาด
        continue;
      }
      deleted++;
      continue;
    }

    // keep=true หรือ classify=null → เก็บต่อ
    const { error: updErr } = await db
      .from("message_attachments")
      .update({
        doc_kind: classified ? classified.kind : null,
        doc_confidence: classified ? classified.confidence : null,
        doc_checked: true,
      })
      .eq("id", row.id);
    if (updErr) {
      console.warn(`[bill-backfill] mark-kept update error code=${(updErr as { code?: string }).code ?? "?"}`);
      checked--;
      continue;
    }
    kept++;
  }

  return { checked, kept, deleted };
}
