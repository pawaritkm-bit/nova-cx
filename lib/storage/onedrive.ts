/**
 * Microsoft OneDrive (Microsoft 365) ผ่าน Microsoft Graph — app-only (client credentials)
 *   ใช้เก็บรูปบิลที่ดึงจาก LINE (เฟส 1) ลง OneDrive ของบริษัท (finovas@wanwanach.com)
 *
 * ★ inert-by-default: ถ้าไม่มี env MS (getOneDriveConfig()=null) ทุกฟังก์ชันเป็น no-op
 *   คืน null/false โดยไม่ยิงเครือข่าย ไม่ throw → ระบบเดิมไม่กระทบ
 * ★ ความปลอดภัย: ห้าม log client_secret / access_token / ชื่อไฟล์ / เนื้อไฟล์ (เฉพาะ error สั้น ๆ)
 * ★ error ทั้งหมดถูกจับภายใน ไม่ throw ทะลุออกไปหา caller (worker/cron ต้องไม่ล้มเพราะ OneDrive)
 */

export type OneDriveConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** UPN เจ้าของ OneDrive เช่น finovas@wanwanach.com */
  user: string;
  /** โฟลเดอร์รากที่จะสร้างโฟลเดอร์ลูกค้า/เดือนซ้อนใต้ (default "NOVA-Bills") */
  root: string;
};

/**
 * config OneDrive — คืน null ถ้าตั้งไม่ครบ (= ปิดฟีเจอร์)
 *   บังคับ 4 ตัว: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, ONEDRIVE_USER
 *   ONEDRIVE_ROOT เป็น optional (default "NOVA-Bills")
 *   ★ inert-by-default: ขาดตัวใดตัวหนึ่งในสี่ → null (ไม่ throw ไม่ยิงเครือข่าย)
 */
export function getOneDriveConfig(): OneDriveConfig | null {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  const user = process.env.ONEDRIVE_USER;
  if (!tenantId || !clientId || !clientSecret || !user) return null;

  const root = (process.env.ONEDRIVE_ROOT || "").trim() || "NOVA-Bills";
  return { tenantId, clientId, clientSecret, user, root };
}

/** true เมื่อพร้อมใช้ OneDrive (ตั้ง env ครบ 4 ตัว) */
export function isOneDriveEnabled(): boolean {
  return getOneDriveConfig() !== null;
}

// ---------------------------------------------------------------------
// access token: client credentials flow → แลก access_token
//   cache in-memory ~50 นาที (token อายุจริง ~60 นาที เผื่อ clock skew/ความหน่วง)
//   invalidate cache เมื่อได้ 401 ตอนใช้งาน (บังคับขอ token ใหม่รอบถัดไป)
// ---------------------------------------------------------------------
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const TOKEN_TTL_MS = 50 * 60 * 1000;

let cachedToken: { value: string; expiresAt: number } | null = null;

/** ล้าง cache access token — เรียกเมื่อ Graph ตอบ 401 (token เพี้ยน/ถูกเพิกถอน/สิทธิ์เปลี่ยน) */
function invalidateToken(): void {
  cachedToken = null;
}

/** ขอ (หรือใช้ cache) access token — คืน null ถ้าปิดฟีเจอร์/ล้มเหลว */
async function getAccessToken(): Promise<string | null> {
  const cfg = getOneDriveConfig();
  if (!cfg) return null;

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.value;
  }

  try {
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(
      cfg.tenantId
    )}/oauth2/v2.0/token`;
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: "client_credentials",
        scope: GRAPH_SCOPE,
      }),
    });
    if (!res.ok) {
      console.warn(`[onedrive] token exchange failed status=${res.status}`);
      invalidateToken(); // กันเผลอใช้ token เก่าที่ค้าง (ปกติเป็น null อยู่แล้ว)
      return null;
    }
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) return null;

    cachedToken = { value: data.access_token, expiresAt: now + TOKEN_TTL_MS };
    return data.access_token;
  } catch {
    console.warn("[onedrive] token exchange error");
    return null;
  }
}

/** encode แต่ละ segment ของ path ให้ปลอดภัยกับ URL (OneDrive รับ unicode ได้) */
function encodePath(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => encodeURIComponent(p))
    .join("/");
}

/**
 * อัปโหลดไฟล์ (simple upload) เข้า OneDrive → คืน { objectPath, url } หรือ null ถ้าล้ม/ปิดฟีเจอร์
 *   - path = `${ONEDRIVE_ROOT}/${folderParts.join('/')}/${fileName}` (encode ต่อ segment)
 *   - PUT .../drive/root:/{path}:/content (รองรับไฟล์ถึง ~250MB พอสำหรับรูปบิล)
 *   - objectPath = path (ยังไม่ encode, ไว้อ้างอิง) · url = webUrl จาก response
 */
export async function uploadOneDriveFile(params: {
  folderParts: string[];
  fileName: string;
  mime: string;
  data: Buffer;
  /** โฟลเดอร์รากบนสุด (default = ONEDRIVE_ROOT="NOVA-Bills") — care ใช้ "NOVA-Care" */
  root?: string;
}): Promise<{ objectPath: string; url: string } | null> {
  const cfg = getOneDriveConfig();
  if (!cfg) return null;
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const topRoot = params.root ?? cfg.root;
    // path แบบอ่านง่าย (objectPath ที่คืนกลับ) — ไม่ encode
    const objectPath = [topRoot, ...params.folderParts, params.fileName]
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .join("/");

    // path ที่ encode ต่อ segment สำหรับใส่ใน URL
    const encodedPath = encodePath([topRoot, ...params.folderParts, params.fileName]);

    const url =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.user)}` +
      `/drive/root:/${encodedPath}:/content`;

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": params.mime,
      },
      // Node fetch รับ Buffer เป็น body ได้ (binary ตรง ๆ) — cast ให้ผ่าน type BodyInit
      body: params.data as unknown as BodyInit,
    });
    if (!res.ok) {
      console.warn(`[onedrive] upload failed status=${res.status}`);
      // 401 → token เพี้ยน/สิทธิ์เปลี่ยน: ล้าง cache ให้รอบหน้าขอใหม่
      if (res.status === 401) invalidateToken();
      return null;
    }
    const item = (await res.json()) as { webUrl?: string };
    return { objectPath, url: item.webUrl || objectPath };
  } catch {
    console.warn("[onedrive] upload error");
    return null;
  }
}

/** แปลง parentReference.path ("/drive/root:/NOVA-Bills/ลูกค้า/2026-08") → folderParts ใต้ root */
export function folderPartsFromParentPath(parentPath: string, root: string): string[] {
  let after = "";
  const i = parentPath.indexOf(":/");
  after = i >= 0 ? parentPath.slice(i + 2) : parentPath;
  try { after = decodeURIComponent(after); } catch { /* raw */ }
  const parts = after.split("/").filter((p) => p.length > 0);
  if (parts[0] === root) parts.shift();
  return parts;
}

/**
 * ลิสต์ลูกในโฟลเดอร์ (path ใต้ root · [] = ตัว ONEDRIVE_ROOT เอง) → [{id,name,isFolder}]
 *   ★ ใช้แทน search (Graph search บน OneDrive app-only จัดindex ช้า/ไม่ทัน) — listing เห็นทันที
 */
export async function listOneDriveChildren(folderParts: string[], root?: string): Promise<{ id: string; name: string; isFolder: boolean }[]> {
  const cfg = getOneDriveConfig();
  if (!cfg) return [];
  const token = await getAccessToken();
  if (!token) return [];
  try {
    const encodedPath = encodePath([root ?? cfg.root, ...folderParts]);
    const url =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.user)}/drive/root:/${encodedPath}:/children` +
      `?$select=id,name,folder&$top=400`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { if (res.status === 401) invalidateToken(); return []; }
    const data = (await res.json()) as { value?: { id: string; name: string; folder?: unknown }[] };
    return (data.value ?? []).map((v) => ({ id: v.id, name: v.name, isFolder: v.folder !== undefined }));
  } catch {
    return [];
  }
}

/** ค้นหาไฟล์ใน OneDrive ตามชื่อ/เนื้อหา (Graph search) → [{id,name,parentPath}] · ล้ม → [] */
export async function searchOneDriveItems(query: string): Promise<{ id: string; name: string; parentPath: string }[]> {
  const cfg = getOneDriveConfig();
  if (!cfg) return [];
  const token = await getAccessToken();
  if (!token) return [];
  try {
    const url =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.user)}` +
      `/drive/root/search(q='${encodeURIComponent(query)}')?$select=id,name,parentReference&$top=100`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { if (res.status === 401) invalidateToken(); return []; }
    const data = (await res.json()) as { value?: { id: string; name: string; parentReference?: { path?: string } }[] };
    return (data.value ?? []).map((v) => ({ id: v.id, name: v.name, parentPath: v.parentReference?.path ?? "" }));
  } catch {
    return [];
  }
}

/** โหลดเนื้อไฟล์ (binary) ตาม path ใต้ root → Buffer หรือ null */
export async function downloadOneDriveFile(folderParts: string[], fileName: string, root?: string): Promise<Buffer | null> {
  const cfg = getOneDriveConfig();
  if (!cfg) return null;
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const encodedPath = encodePath([root ?? cfg.root, ...folderParts, fileName]);
    const url =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.user)}/drive/root:/${encodedPath}:/content`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { if (res.status === 401) invalidateToken(); return null; }
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** อ่านไฟล์ข้อความตาม id → string หรือ null (ตัด BOM) */
export async function getOneDriveTextById(id: string): Promise<string | null> {
  const cfg = getOneDriveConfig();
  if (!cfg) return null;
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.user)}/drive/items/${id}/content`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { if (res.status === 401) invalidateToken(); return null; }
    return (await res.text()).replace(/^﻿/, "");
  } catch {
    return null;
  }
}

/** ลบไฟล์ตาม id → true ถ้าสำเร็จ */
export async function deleteOneDriveItemById(id: string): Promise<boolean> {
  const cfg = getOneDriveConfig();
  if (!cfg) return false;
  const token = await getAccessToken();
  if (!token) return false;
  try {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.user)}/drive/items/${id}`;
    const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) invalidateToken();
    return res.ok || res.status === 204;
  } catch {
    return false;
  }
}

/**
 * เปลี่ยนชื่อไฟล์ใน OneDrive (PATCH driveItem.name) — ใช้ติดเครื่องหมาย ✅ "อ่านแล้ว" ที่ไฟล์ต้นฉบับ
 *   @param folderParts โฟลเดอร์ใต้ ONEDRIVE_ROOT (ไม่รวม root)
 *   @param fileName    ชื่อไฟล์เดิม
 *   @param newName     ชื่อใหม่ (ในโฟลเดอร์เดิม)
 *   @returns true ถ้าสำเร็จ · false ถ้าล้ม/ปิดฟีเจอร์ (best-effort ไม่ throw)
 */
export async function renameOneDriveFile(params: {
  folderParts: string[];
  fileName: string;
  newName: string;
  root?: string;
}): Promise<boolean> {
  const cfg = getOneDriveConfig();
  if (!cfg) return false;
  const token = await getAccessToken();
  if (!token) return false;
  try {
    const encodedPath = encodePath([params.root ?? cfg.root, ...params.folderParts, params.fileName]);
    const url =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.user)}` +
      `/drive/root:/${encodedPath}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: params.newName }),
    });
    if (!res.ok) {
      console.warn(`[onedrive] rename failed status=${res.status}`);
      if (res.status === 401) invalidateToken();
      return false;
    }
    return true;
  } catch {
    console.warn("[onedrive] rename error");
    return false;
  }
}
