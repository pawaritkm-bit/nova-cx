import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

/**
 * lib/storage/drive — โฟกัสพฤติกรรม cache access token (rev รอบ 2 ข้อ 3)
 *   - inert: ไม่มี env Drive → uploadFile คืน null ไม่ยิงเครือข่าย
 *   - cache: 200 ต่อเนื่อง → ขอ token ครั้งเดียว (reuse cache)
 *   - invalidate: Drive ตอบ 401/403 → ล้าง cache → รอบหน้าขอ token ใหม่
 *
 * หมายเหตุ: cachedToken เป็น module-scope → ใช้ vi.resetModules() + dynamic import
 *   เพื่อรีเซ็ต cache ระหว่างเทสต์
 */

// สร้าง RSA keypair จริงครั้งเดียว (createSign ต้องใช้ PEM ที่ถูกต้อง)
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SA_JSON = JSON.stringify({
  client_email: "sa@example.iam.gserviceaccount.com",
  private_key: privateKey,
  token_uri: "https://oauth2.googleapis.com/token",
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchMock = ReturnType<typeof vi.fn> & { tokenCalls: number };

/** ติดตั้ง fetch mock: นับจำนวนครั้งขอ token, ตอบ upload ตามคิว status ที่กำหนด */
function installFetch(uploadStatuses: number[]): FetchMock {
  let uploadIdx = 0;
  const fn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com/token")) {
      fn.tokenCalls++;
      return jsonResponse({ access_token: `tok-${fn.tokenCalls}` }, 200);
    }
    if (u.includes("/upload/drive/v3/files")) {
      const status = uploadStatuses[uploadIdx++] ?? 200;
      if (status >= 200 && status < 300) {
        return jsonResponse({ id: "file-1", webViewLink: "https://drive/file-1" }, status);
      }
      return jsonResponse({ error: { message: "auth" } }, status);
    }
    return jsonResponse({}, 200);
  }) as FetchMock;
  fn.tokenCalls = 0;
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const UPLOAD_PARAMS = {
  name: "x.jpg",
  mime: "image/jpeg",
  data: Buffer.from("IMG"),
  folderId: "folder-1",
};

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.GOOGLE_DRIVE_SA_JSON = SA_JSON;
  process.env.GDRIVE_ROOT_FOLDER_ID = "root-1";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GOOGLE_DRIVE_SA_JSON;
  delete process.env.GDRIVE_ROOT_FOLDER_ID;
});

describe("drive — inert-by-default", () => {
  it("ไม่มี env Drive → uploadFile คืน null ไม่ยิงเครือข่าย", async () => {
    delete process.env.GOOGLE_DRIVE_SA_JSON;
    const fetchMock = installFetch([200]);
    const { uploadFile, isDriveEnabled } = await import("@/lib/storage/drive");

    expect(isDriveEnabled()).toBe(false);
    expect(await uploadFile(UPLOAD_PARAMS)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("drive — token cache", () => {
  it("200 ต่อเนื่อง → ขอ token ครั้งเดียว (reuse cache)", async () => {
    const fetchMock = installFetch([200, 200]);
    const { uploadFile } = await import("@/lib/storage/drive");

    const a = await uploadFile(UPLOAD_PARAMS);
    const b = await uploadFile(UPLOAD_PARAMS);

    expect(a?.fileId).toBe("file-1");
    expect(b?.fileId).toBe("file-1");
    expect(fetchMock.tokenCalls).toBe(1); // cache ใช้ได้ → ขอ token ครั้งเดียว
  });

  it("Drive ตอบ 401 → ล้าง cache → รอบหน้าขอ token ใหม่", async () => {
    const fetchMock = installFetch([401, 200]);
    const { uploadFile } = await import("@/lib/storage/drive");

    const first = await uploadFile(UPLOAD_PARAMS); // 401 → null + ล้าง cache
    expect(first).toBeNull();
    expect(fetchMock.tokenCalls).toBe(1);

    const second = await uploadFile(UPLOAD_PARAMS); // ต้องขอ token ใหม่
    expect(second?.fileId).toBe("file-1");
    expect(fetchMock.tokenCalls).toBe(2); // cache ถูกล้าง → ขอ token รอบสอง
  });

  it("Drive ตอบ 403 → ล้าง cache เช่นกัน", async () => {
    const fetchMock = installFetch([403, 200]);
    const { uploadFile } = await import("@/lib/storage/drive");

    await uploadFile(UPLOAD_PARAMS);
    await uploadFile(UPLOAD_PARAMS);

    expect(fetchMock.tokenCalls).toBe(2);
  });
});
