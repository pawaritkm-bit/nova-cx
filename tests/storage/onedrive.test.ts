import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * lib/storage/onedrive — Microsoft Graph app-only (client credentials)
 *   - config/enabled: ครบ 4 ตัว → enabled / ขาดตัวใด → disabled (default root NOVA-Bills)
 *   - inert: ไม่มี env → uploadOneDriveFile คืน null ไม่ยิงเครือข่าย
 *   - token cache: 200 ต่อเนื่อง → ขอ token ครั้งเดียว (reuse cache)
 *   - 401 invalidate: Graph ตอบ 401 → ล้าง cache → รอบหน้าขอ token ใหม่
 *   - upload: PUT path ถูก (encode ต่อ segment), objectPath อ่านง่าย, url = webUrl, error → null
 *
 * หมายเหตุ: cachedToken เป็น module-scope → ใช้ vi.resetModules() + dynamic import
 *   เพื่อรีเซ็ต cache ระหว่างเทสต์
 */

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchMock = ReturnType<typeof vi.fn> & { tokenCalls: number; calls: string[] };

/** ติดตั้ง fetch mock: นับจำนวนครั้งขอ token, ตอบ upload ตามคิว status ที่กำหนด, เก็บ URL ทุกครั้ง */
function installFetch(uploadStatuses: number[]): FetchMock {
  let uploadIdx = 0;
  const fn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    fn.calls.push(u);
    if (u.includes("login.microsoftonline.com")) {
      fn.tokenCalls++;
      return jsonResponse({ access_token: `tok-${fn.tokenCalls}` }, 200);
    }
    if (u.includes("graph.microsoft.com")) {
      const status = uploadStatuses[uploadIdx++] ?? 200;
      if (status >= 200 && status < 300) {
        return jsonResponse({ webUrl: "https://onedrive/webUrl-1" }, status);
      }
      return jsonResponse({ error: { message: "auth" } }, status);
    }
    return jsonResponse({}, 200);
  }) as FetchMock;
  fn.tokenCalls = 0;
  fn.calls = [];
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const UPLOAD_PARAMS = {
  folderParts: ["N023", "2026-07"],
  fileName: "2026-07-18T09-00-00Z_msg-1.jpg",
  mime: "image/jpeg",
  data: Buffer.from("IMG"),
};

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.MS_TENANT_ID = "tenant-1";
  process.env.MS_CLIENT_ID = "client-1";
  process.env.MS_CLIENT_SECRET = "secret-1";
  process.env.ONEDRIVE_USER = "finovas@wanwanach.com";
  delete process.env.ONEDRIVE_ROOT;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MS_TENANT_ID;
  delete process.env.MS_CLIENT_ID;
  delete process.env.MS_CLIENT_SECRET;
  delete process.env.ONEDRIVE_USER;
  delete process.env.ONEDRIVE_ROOT;
});

describe("onedrive — config & enabled", () => {
  it("ครบ 4 ตัว → enabled, root default = NOVA-Bills", async () => {
    const { getOneDriveConfig, isOneDriveEnabled } = await import("@/lib/storage/onedrive");
    expect(isOneDriveEnabled()).toBe(true);
    expect(getOneDriveConfig()).toMatchObject({
      tenantId: "tenant-1",
      clientId: "client-1",
      user: "finovas@wanwanach.com",
      root: "NOVA-Bills",
    });
  });

  it("ตั้ง ONEDRIVE_ROOT → ใช้ค่านั้น", async () => {
    process.env.ONEDRIVE_ROOT = "  MyBills ";
    const { getOneDriveConfig } = await import("@/lib/storage/onedrive");
    expect(getOneDriveConfig()?.root).toBe("MyBills");
  });

  it("ขาด MS_CLIENT_SECRET → disabled (คืน null)", async () => {
    delete process.env.MS_CLIENT_SECRET;
    const { getOneDriveConfig, isOneDriveEnabled } = await import("@/lib/storage/onedrive");
    expect(getOneDriveConfig()).toBeNull();
    expect(isOneDriveEnabled()).toBe(false);
  });

  it("ขาด ONEDRIVE_USER → disabled (คืน null)", async () => {
    delete process.env.ONEDRIVE_USER;
    const { isOneDriveEnabled } = await import("@/lib/storage/onedrive");
    expect(isOneDriveEnabled()).toBe(false);
  });
});

describe("onedrive — inert-by-default", () => {
  it("ไม่มี env → uploadOneDriveFile คืน null ไม่ยิงเครือข่าย", async () => {
    delete process.env.MS_TENANT_ID;
    const fetchMock = installFetch([200]);
    const { uploadOneDriveFile } = await import("@/lib/storage/onedrive");
    expect(await uploadOneDriveFile(UPLOAD_PARAMS)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("onedrive — token cache", () => {
  it("200 ต่อเนื่อง → ขอ token ครั้งเดียว (reuse cache)", async () => {
    const fetchMock = installFetch([200, 200]);
    const { uploadOneDriveFile } = await import("@/lib/storage/onedrive");

    const a = await uploadOneDriveFile(UPLOAD_PARAMS);
    const b = await uploadOneDriveFile(UPLOAD_PARAMS);

    expect(a?.url).toBe("https://onedrive/webUrl-1");
    expect(b?.url).toBe("https://onedrive/webUrl-1");
    expect(fetchMock.tokenCalls).toBe(1); // cache ใช้ได้ → ขอ token ครั้งเดียว
  });

  it("Graph ตอบ 401 → ล้าง cache → รอบหน้าขอ token ใหม่", async () => {
    const fetchMock = installFetch([401, 200]);
    const { uploadOneDriveFile } = await import("@/lib/storage/onedrive");

    const first = await uploadOneDriveFile(UPLOAD_PARAMS); // 401 → null + ล้าง cache
    expect(first).toBeNull();
    expect(fetchMock.tokenCalls).toBe(1);

    const second = await uploadOneDriveFile(UPLOAD_PARAMS); // ต้องขอ token ใหม่
    expect(second?.url).toBe("https://onedrive/webUrl-1");
    expect(fetchMock.tokenCalls).toBe(2); // cache ถูกล้าง → ขอ token รอบสอง
  });
});

describe("onedrive — upload path & url", () => {
  it("PUT path ถูก (ONEDRIVE_ROOT/folderParts/fileName, encode ต่อ segment) + objectPath อ่านง่าย", async () => {
    const fetchMock = installFetch([200]);
    const { uploadOneDriveFile } = await import("@/lib/storage/onedrive");

    const res = await uploadOneDriveFile(UPLOAD_PARAMS);

    // objectPath อ่านง่าย ไม่ encode
    expect(res?.objectPath).toBe(
      "NOVA-Bills/N023/2026-07/2026-07-18T09-00-00Z_msg-1.jpg"
    );
    expect(res?.url).toBe("https://onedrive/webUrl-1");

    const uploadCall = fetchMock.calls.find((u) => u.includes("graph.microsoft.com"));
    expect(uploadCall).toBeDefined();
    // path segment ถูก encode (`:` ในชื่อไฟล์ → %3A) และห่อด้วย root:/...:/content
    expect(uploadCall).toContain("/users/finovas%40wanwanach.com/drive/root:/");
    expect(uploadCall).toContain(":/content");
    expect(uploadCall).toContain("NOVA-Bills/N023/2026-07/");
    expect(uploadCall).toContain("2026-07-18T09-00-00Z_msg-1.jpg");
  });

  it("encode unicode segment (ชื่อโฟลเดอร์ภาษาไทย)", async () => {
    const fetchMock = installFetch([200]);
    const { uploadOneDriveFile } = await import("@/lib/storage/onedrive");

    const res = await uploadOneDriveFile({ ...UPLOAD_PARAMS, folderParts: ["ลูกค้า", "2026-07"] });
    // objectPath เก็บ unicode จริง
    expect(res?.objectPath).toContain("ลูกค้า");
    // URL ต้อง encode (ไม่มี unicode ดิบใน URL)
    const uploadCall = fetchMock.calls.find((u) => u.includes("graph.microsoft.com"))!;
    expect(uploadCall).toContain(encodeURIComponent("ลูกค้า"));
    expect(uploadCall).not.toContain("ลูกค้า");
  });

  it("upload ล้ม (500) → คืน null ไม่ throw", async () => {
    installFetch([500]);
    const { uploadOneDriveFile } = await import("@/lib/storage/onedrive");
    expect(await uploadOneDriveFile(UPLOAD_PARAMS)).toBeNull();
  });

  it("response ไม่มี webUrl → fallback url = objectPath", async () => {
    const fn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("login.microsoftonline.com")) {
        return jsonResponse({ access_token: "tok-x" }, 200);
      }
      return jsonResponse({}, 200); // ไม่มี webUrl
    });
    global.fetch = fn as unknown as typeof fetch;
    const { uploadOneDriveFile } = await import("@/lib/storage/onedrive");
    const res = await uploadOneDriveFile(UPLOAD_PARAMS);
    expect(res?.url).toBe(res?.objectPath);
  });
});
