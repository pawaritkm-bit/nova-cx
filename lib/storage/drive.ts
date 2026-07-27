import { createSign } from "node:crypto";
import { getGoogleDriveConfig } from "@/lib/env";

/**
 * Google Drive ผ่าน service account — ไม่พึ่ง SDK google (ทำ JWT/REST เอง ด้วย node:crypto)
 *   ใช้เก็บรูปบิลที่ดึงจาก LINE (เฟส 1)
 *
 * ★ inert-by-default: ถ้าไม่มี env Drive (getGoogleDriveConfig()=null) ทุกฟังก์ชันเป็น no-op
 *   คืน null/false โดยไม่ยิงเครือข่าย ไม่ throw → ระบบเดิมไม่กระทบ
 * ★ ความปลอดภัย: ห้าม log private_key / access_token / เนื้อไฟล์ (เฉพาะ error สั้น ๆ)
 * ★ error ทั้งหมดถูกจับภายใน ไม่ throw ทะลุออกไปหา caller (worker/cron ต้องไม่ล้มเพราะ Drive)
 */

/** true เมื่อพร้อมใช้ Drive (ตั้ง env ครบ) */
export function isDriveEnabled(): boolean {
  return getGoogleDriveConfig() !== null;
}

// ---------------------------------------------------------------------
// access token: สร้าง JWT RS256 ด้วย private_key ของ SA → แลก access_token
//   cache in-memory ~50 นาที (token อายุจริง 60 นาที เผื่อ clock skew/ความหน่วง)
// ---------------------------------------------------------------------
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_TTL_MS = 50 * 60 * 1000;

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * ล้าง cache access token — เรียกเมื่อ Google ตอบ 401/403 (token เพี้ยน/ถูกเพิกถอน/สิทธิ์เปลี่ยน)
 *   เพื่อบังคับขอ token ใหม่รอบถัดไป ไม่วน 401 ซ้ำจนกว่า cache หมดอายุ
 */
function invalidateToken(): void {
  cachedToken = null;
}

/** true ถ้า status เป็น auth error (token ต้อง refresh) */
function isAuthError(status: number): boolean {
  return status === 401 || status === 403;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** ขอ (หรือใช้ cache) access token — คืน null ถ้าปิดฟีเจอร์/ล้มเหลว */
async function getAccessToken(): Promise<string | null> {
  const cfg = getGoogleDriveConfig();
  if (!cfg) return null;

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.value;
  }

  try {
    const { client_email, private_key, token_uri } = cfg.serviceAccount;
    const iat = Math.floor(now / 1000);
    const exp = iat + 3600; // JWT อายุ 1 ชม.

    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64url(
      JSON.stringify({
        iss: client_email,
        scope: DRIVE_SCOPE,
        aud: token_uri,
        iat,
        exp,
      })
    );
    const signingInput = `${header}.${claim}`;

    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = base64url(signer.sign(private_key));
    const assertion = `${signingInput}.${signature}`;

    const res = await fetch(token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!res.ok) {
      console.warn(`[drive] token exchange failed status=${res.status}`);
      invalidateToken(); // กันเผลอใช้ token เก่าที่ค้าง (ปกติเป็น null อยู่แล้ว)
      return null;
    }
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) return null;

    cachedToken = { value: data.access_token, expiresAt: now + TOKEN_TTL_MS };
    return data.access_token;
  } catch {
    console.warn("[drive] token exchange error");
    return null;
  }
}

// ---------------------------------------------------------------------
// helper เรียก Drive REST พร้อม auth header
// ---------------------------------------------------------------------
async function driveFetch(
  token: string,
  url: string,
  init?: RequestInit
): Promise<Response | null> {
  try {
    return await fetch(url, {
      ...init,
      headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` },
    });
  } catch {
    return null;
  }
}

/** escape single-quote ในค่าที่ใส่ใน Drive query (q) กัน query พัง/เพี้ยน */
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * หา folder ชื่อ `name` ใต้ parent — ถ้าไม่มีสร้างใหม่ คืน folderId (หรือ null ถ้าล้ม)
 */
async function ensureSingleFolder(
  token: string,
  name: string,
  parentId: string
): Promise<string | null> {
  // 1) ค้นหาก่อน (ไม่นับที่ถูก trash)
  const q = [
    `name = '${escapeQueryValue(name)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    `'${escapeQueryValue(parentId)}' in parents`,
    "trashed = false",
  ].join(" and ");

  const listUrl =
    "https://www.googleapis.com/drive/v3/files?" +
    new URLSearchParams({
      q,
      fields: "files(id,name)",
      pageSize: "1",
      // รองรับ Shared Drive เผื่อ root อยู่บน Shared Drive
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    }).toString();

  const listRes = await driveFetch(token, listUrl);
  if (listRes && listRes.ok) {
    const data = (await listRes.json()) as { files?: { id: string }[] };
    const existing = data.files?.[0]?.id;
    if (existing) return existing;
  } else if (listRes) {
    console.warn(`[drive] folder list failed status=${listRes.status}`);
    // 401/403 → token เพี้ยน/สิทธิ์เปลี่ยน: ล้าง cache ให้รอบหน้าขอใหม่
    if (isAuthError(listRes.status)) invalidateToken();
    // list ล้ม → ไม่พยายามสร้าง (กัน duplicate) คืน null
    return null;
  } else {
    return null;
  }

  // 2) ไม่เจอ → สร้างใหม่
  const createUrl =
    "https://www.googleapis.com/drive/v3/files?" +
    new URLSearchParams({ fields: "id", supportsAllDrives: "true" }).toString();
  const createRes = await driveFetch(token, createUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  if (!createRes || !createRes.ok) {
    console.warn(`[drive] folder create failed status=${createRes?.status ?? "network"}`);
    return null;
  }
  const created = (await createRes.json()) as { id?: string };
  return created.id ?? null;
}

/**
 * หา/สร้างโฟลเดอร์ซ้อนตาม parts ใต้ GDRIVE_ROOT_FOLDER_ID → คืน folderId ใบสุดท้าย
 *   คืน null ถ้าปิดฟีเจอร์ หรือสร้างไม่สำเร็จระหว่างทาง
 */
export async function ensureFolderPath(parts: string[]): Promise<string | null> {
  const cfg = getGoogleDriveConfig();
  if (!cfg) return null;
  const token = await getAccessToken();
  if (!token) return null;

  let parentId = cfg.rootFolderId;
  for (const rawPart of parts) {
    // sanitize: ตัด / (กัน path เพี้ยน) + trim + กันชื่อว่าง
    const name = rawPart.replace(/[\/\\]/g, "_").trim() || "-";
    const folderId = await ensureSingleFolder(token, name, parentId);
    if (!folderId) return null;
    parentId = folderId;
  }
  return parentId;
}

/**
 * อัปโหลดไฟล์ (multipart) เข้า folderId → คืน { fileId, url } หรือ null ถ้าล้ม/ปิดฟีเจอร์
 *   url = webViewLink (ลิงก์เปิดดูบน Drive)
 */
export async function uploadFile(params: {
  name: string;
  mime: string;
  data: Buffer;
  folderId: string;
}): Promise<{ fileId: string; url: string } | null> {
  const cfg = getGoogleDriveConfig();
  if (!cfg) return null;
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const boundary = `nova-cx-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    const metadata = {
      name: params.name,
      parents: [params.folderId],
    };

    // ประกอบ multipart body เอง (metadata JSON + binary) — Node fetch รับ Buffer เป็น body ได้
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${params.mime}\r\n\r\n`,
      "utf8"
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([head, params.data, tail]);

    const url =
      "https://www.googleapis.com/upload/drive/v3/files?" +
      new URLSearchParams({
        uploadType: "multipart",
        fields: "id,webViewLink",
        supportsAllDrives: "true",
      }).toString();

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) {
      console.warn(`[drive] upload failed status=${res.status}`);
      // 401/403 → token เพี้ยน/สิทธิ์เปลี่ยน: ล้าง cache ให้รอบหน้าขอใหม่
      if (isAuthError(res.status)) invalidateToken();
      return null;
    }
    const data = (await res.json()) as { id?: string; webViewLink?: string };
    if (!data.id) return null;
    return {
      fileId: data.id,
      url: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
    };
  } catch {
    console.warn("[drive] upload error");
    return null;
  }
}
