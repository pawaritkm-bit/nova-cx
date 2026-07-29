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
}): Promise<{ objectPath: string; url: string } | null> {
  const cfg = getOneDriveConfig();
  if (!cfg) return null;
  const token = await getAccessToken();
  if (!token) return null;

  try {
    // path แบบอ่านง่าย (objectPath ที่คืนกลับ) — ไม่ encode
    const objectPath = [cfg.root, ...params.folderParts, params.fileName]
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .join("/");

    // path ที่ encode ต่อ segment สำหรับใส่ใน URL
    const encodedPath = encodePath([cfg.root, ...params.folderParts, params.fileName]);

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
