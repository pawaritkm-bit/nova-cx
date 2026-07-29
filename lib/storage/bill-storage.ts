import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { isDriveEnabled, ensureFolderPath, uploadFile } from "@/lib/storage/drive";
import { isOneDriveEnabled, uploadOneDriveFile } from "@/lib/storage/onedrive";

/**
 * ชั้น abstraction เลือก backend เก็บรูปบิล (เฟส 1 ฝั่ง CX)
 *   รองรับ 3 backend ผ่าน env BILL_STORAGE_BACKEND:
 *     - 'supabase' (default) : อัปเข้า Supabase Storage bucket `bills` (private) + signed URL
 *     - 'drive'              : Google Drive service account เดิม (ไว้ต่อ OAuth ทีหลัง)
 *     - 'onedrive'           : Microsoft 365 OneDrive ของบริษัท (Graph, app-only)
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

export type BillStorageBackend = "supabase" | "drive" | "onedrive";

/** bucket สำหรับรูปบิล (private) — สร้างไว้แล้วใน Supabase project */
const BILLS_BUCKET = "bills";

/** อายุ signed URL: 1 ปี (bucket private → ต้องมีลิงก์เซ็นถึงจะเปิดดูได้) */
const SIGNED_URL_TTL_SEC = 60 * 60 * 24 * 365;

/** backend ที่เลือกใช้ (default = supabase) — ค่าที่ไม่รู้จักถือเป็น supabase */
export function getBillStorageBackend(): BillStorageBackend {
  const raw = (process.env.BILL_STORAGE_BACKEND || "supabase").trim().toLowerCase();
  if (raw === "drive") return "drive";
  if (raw === "onedrive") return "onedrive";
  return "supabase";
}

/**
 * true เมื่อ backend ที่เลือกพร้อมใช้งาน
 *   - supabase: พร้อมเมื่อมี service role env (Supabase มีพื้นที่เก็บอยู่แล้ว)
 *   - drive   : เดิม — พร้อมเมื่อตั้ง env Drive ครบ (isDriveEnabled)
 *   - onedrive: พร้อมเมื่อตั้ง env MS ครบ (isOneDriveEnabled)
 */
export function isBillStorageEnabled(): boolean {
  const backend = getBillStorageBackend();
  if (backend === "drive") return isDriveEnabled();
  if (backend === "onedrive") return isOneDriveEnabled();
  const env = getSupabaseEnv();
  return !!(env && env.serviceRoleKey);
}

/**
 * sanitize ชื่อส่วนของ path ให้เป็น **ASCII-safe ล้วน**
 *   ★ Supabase Storage key ไม่รับอักขระไทย/นอก ASCII (→ 400 InvalidKey)
 *   เก็บเฉพาะ [A-Za-z0-9._-] อักขระอื่นทั้งหมด (ช่องว่าง/ไทย/`/`/`\`/control) → `_`
 *   กัน path traversal (`/`,`\` กลายเป็น `_`) และ key เพี้ยนจาก unicode
 */
function sanitizePart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * ประกอบ object path: `${tenantId}/${folderParts...}/${fileName}`
 *   ทุกส่วน sanitize เป็น ASCII แล้วตัด segment ว่างทิ้ง (กัน `//` / key เพี้ยน)
 */
function buildObjectPath(tenantId: string, folderParts: string[], fileName: string): string {
  return [tenantId, ...folderParts, fileName]
    .map(sanitizePart)
    .filter((p) => p.length > 0)
    .join("/");
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

/** เก็บไฟล์ผ่าน Microsoft OneDrive (Graph, app-only) */
async function storeViaOneDrive(params: {
  folderParts: string[];
  fileName: string;
  mime: string;
  data: Buffer;
}): Promise<{ objectPath: string; url: string } | null> {
  // uploadOneDriveFile คืน { objectPath, url } ตรง interface กลางอยู่แล้ว
  return uploadOneDriveFile({
    folderParts: params.folderParts,
    fileName: params.fileName,
    mime: params.mime,
    data: params.data,
  });
}

/**
 * เก็บไฟล์รูปบิลตาม backend ที่เลือก
 *   @returns { objectPath, url } เมื่อสำเร็จ · null เมื่อล้ม/ปิดฟีเจอร์ (ไม่ throw)
 *     - objectPath : storage ref (Supabase = object path ใน bucket `bills`, Drive = fileId,
 *                    OneDrive = path เต็มใต้ ONEDRIVE_ROOT)
 *     - url        : Supabase = signed URL (อายุ 1 ปี), Drive = webViewLink, OneDrive = webUrl
 */
export async function storeBillFile(params: {
  db: SupabaseClient;
  tenantId: string;
  folderParts: string[];
  fileName: string;
  mime: string;
  data: Buffer;
}): Promise<{ objectPath: string; url: string } | null> {
  const backend = getBillStorageBackend();
  if (backend === "drive") return storeViaDrive(params);
  if (backend === "onedrive") return storeViaOneDrive(params);
  return storeViaSupabase(params);
}
