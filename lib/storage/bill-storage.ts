import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { isDriveEnabled, ensureFolderPath, uploadFile } from "@/lib/storage/drive";

/**
 * ชั้น abstraction เลือก backend เก็บรูปบิล (เฟส 1 ฝั่ง CX)
 *   รองรับ 2 backend ผ่าน env BILL_STORAGE_BACKEND:
 *     - 'supabase' (default) : อัปเข้า Supabase Storage bucket `bills` (private) + signed URL
 *     - 'drive'              : Google Drive service account เดิม (ไว้ต่อ OAuth ทีหลัง)
 *
 * ★ ที่มา: service account ของ Google อัปไฟล์เข้า Gmail ธรรมดาไม่ได้
 *   ("Service Accounts do not have storage quota") → สลับมาใช้ Supabase Storage ก่อน
 *   (Supabase มีพื้นที่เก็บอยู่แล้ว ใช้ service role เข้าถึงได้ ไม่ต้องตั้ง env เพิ่ม)
 *
 * ★ inert-by-default: error ทั้งหมดถูกจับภายใน คืน null ไม่ throw ทะลุ
 *   (worker/cron ต้องไม่ล้มเพราะ storage) — เหมือนพฤติกรรม drive.ts เดิม
 * ★ ความปลอดภัย: bucket เป็น private เสมอ — ใช้ signed URL (อายุยาว) ไม่ทำ public
 *   ห้าม log ชื่อไฟล์/path/เนื้อไฟล์ (PDPA) — log แค่ error สั้น ๆ
 */

export type BillStorageBackend = "supabase" | "drive";

/** bucket สำหรับรูปบิล (private) — สร้างไว้แล้วใน Supabase project */
const BILLS_BUCKET = "bills";

/** อายุ signed URL: 1 ปี (bucket private → ต้องมีลิงก์เซ็นถึงจะเปิดดูได้) */
const SIGNED_URL_TTL_SEC = 60 * 60 * 24 * 365;

/** backend ที่เลือกใช้ (default = supabase) — ค่าอื่นที่ไม่ใช่ 'drive' ถือเป็น supabase */
export function getBillStorageBackend(): BillStorageBackend {
  const raw = (process.env.BILL_STORAGE_BACKEND || "supabase").trim().toLowerCase();
  return raw === "drive" ? "drive" : "supabase";
}

/**
 * true เมื่อ backend ที่เลือกพร้อมใช้งาน
 *   - supabase: พร้อมเมื่อมี service role env (Supabase มีพื้นที่เก็บอยู่แล้ว)
 *   - drive   : เดิม — พร้อมเมื่อตั้ง env Drive ครบ (isDriveEnabled)
 */
export function isBillStorageEnabled(): boolean {
  if (getBillStorageBackend() === "drive") return isDriveEnabled();
  const env = getSupabaseEnv();
  return !!(env && env.serviceRoleKey);
}

/**
 * sanitize ชื่อส่วนของ path (โฟลเดอร์/ไฟล์)
 *   - ตัด `/` `\` กัน path traversal / แตกโฟลเดอร์เกินตั้งใจ
 *   - ตัดอักขระควบคุม (\x00-\x1f) ที่ storage key ไม่รับ
 *   - trim; ถ้าว่างใช้ "-" กัน segment ว่าง
 *   (คงอักษรไทย/unicode ไว้ได้ — Supabase Storage key รองรับ)
 */
function sanitizePart(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[/\\]/g, "_").replace(/[\x00-\x1f]/g, "").trim() || "-";
}

/** ประกอบ object path: `${tenantId}/${folderParts...}/${fileName}` (ทุกส่วน sanitize) */
function buildObjectPath(tenantId: string, folderParts: string[], fileName: string): string {
  return [sanitizePart(tenantId), ...folderParts.map(sanitizePart), sanitizePart(fileName)].join("/");
}

/** เก็บไฟล์ผ่าน Supabase Storage (service role, private bucket) */
async function storeViaSupabase(params: {
  db: SupabaseClient;
  tenantId: string;
  folderParts: string[];
  fileName: string;
  mime: string;
  data: Buffer;
}): Promise<{ objectPath: string; url: string } | null> {
  try {
    const objectPath = buildObjectPath(params.tenantId, params.folderParts, params.fileName);
    const bucket = params.db.storage.from(BILLS_BUCKET);

    // upsert:false → path ซ้ำถือว่าล้ม (caller จะ mark failed แล้ว retry/reuse ผ่าน dedup)
    const { error: upErr } = await bucket.upload(objectPath, params.data, {
      contentType: params.mime,
      upsert: false,
    });
    if (upErr) {
      console.warn("[bill-storage] supabase upload failed");
      return null;
    }

    // signed URL อายุยาว — bucket private จึงต้องเซ็น (เซ็นไม่ได้ → fallback เป็น object path)
    const { data: signed } = await bucket.createSignedUrl(objectPath, SIGNED_URL_TTL_SEC);
    return { objectPath, url: signed?.signedUrl || objectPath };
  } catch {
    console.warn("[bill-storage] supabase store error");
    return null;
  }
}

/** เก็บไฟล์ผ่าน Google Drive เดิม (ensureFolderPath + uploadFile) */
async function storeViaDrive(params: {
  folderParts: string[];
  fileName: string;
  mime: string;
  data: Buffer;
}): Promise<{ objectPath: string; url: string } | null> {
  const folderId = await ensureFolderPath(params.folderParts);
  if (!folderId) return null;
  const uploaded = await uploadFile({
    name: params.fileName,
    mime: params.mime,
    data: params.data,
    folderId,
  });
  if (!uploaded) return null;
  // map ให้เข้ากับ interface กลาง: objectPath = fileId ของ Drive
  return { objectPath: uploaded.fileId, url: uploaded.url };
}

/**
 * เก็บไฟล์รูปบิลตาม backend ที่เลือก
 *   @returns { objectPath, url } เมื่อสำเร็จ · null เมื่อล้ม/ปิดฟีเจอร์ (ไม่ throw)
 *     - objectPath : storage ref (Supabase = object path ใน bucket `bills`, Drive = fileId)
 *     - url        : Supabase = signed URL (อายุ 1 ปี), Drive = webViewLink
 */
export async function storeBillFile(params: {
  db: SupabaseClient;
  tenantId: string;
  folderParts: string[];
  fileName: string;
  mime: string;
  data: Buffer;
}): Promise<{ objectPath: string; url: string } | null> {
  if (getBillStorageBackend() === "drive") {
    return storeViaDrive(params);
  }
  return storeViaSupabase(params);
}
