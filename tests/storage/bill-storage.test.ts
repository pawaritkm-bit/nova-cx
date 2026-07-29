import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * lib/storage/bill-storage — ชั้นเลือก backend เก็บรูปบิล
 *   - default backend = supabase (ไม่ตั้ง env)
 *   - isBillStorageEnabled: supabase ต้องมี service role env / drive ตาม isDriveEnabled
 *   - storeBillFile (supabase): upload เข้า bucket `bills` + signed URL, path = tenant/parts/file
 *   - upsert:false, contentType=mime, upload ล้ม → คืน null (ไม่ throw)
 *   - drive backend: delegate ไป ensureFolderPath + uploadFile
 */

// --- mock ชั้น drive (สำหรับเส้นทาง backend=drive) ---
const isDriveEnabledMock = vi.fn<() => boolean>();
const ensureFolderPathMock = vi.fn<(parts: string[]) => Promise<string | null>>();
const uploadFileMock = vi.fn();
vi.mock("@/lib/storage/drive", () => ({
  isDriveEnabled: () => isDriveEnabledMock(),
  ensureFolderPath: (parts: string[]) => ensureFolderPathMock(parts),
  uploadFile: (params: unknown) => uploadFileMock(params),
}));

// --- mock ชั้น onedrive (สำหรับเส้นทาง backend=onedrive) ---
const isOneDriveEnabledMock = vi.fn<() => boolean>();
const uploadOneDriveFileMock = vi.fn();
vi.mock("@/lib/storage/onedrive", () => ({
  isOneDriveEnabled: () => isOneDriveEnabledMock(),
  uploadOneDriveFile: (params: unknown) => uploadOneDriveFileMock(params),
}));

import {
  getBillStorageBackend,
  isBillStorageEnabled,
  storeBillFile,
} from "@/lib/storage/bill-storage";

// ---------------------------------------------------------------------
// Fake Supabase Storage client — จับ arg ที่ส่งเข้า upload/createSignedUrl
// ---------------------------------------------------------------------
type UploadCall = { path: string; data: unknown; opts: unknown };

function makeFakeStorageDb(cfg: {
  uploadError?: { message: string } | null;
  signedUrl?: string | null;
}) {
  const uploads: UploadCall[] = [];
  let signedPath = "";

  const fileApi = {
    upload(path: string, data: unknown, opts: unknown) {
      uploads.push({ path, data, opts });
      return Promise.resolve({ data: null, error: cfg.uploadError ?? null });
    },
    createSignedUrl(path: string) {
      signedPath = path;
      return Promise.resolve({
        data: cfg.signedUrl ? { signedUrl: cfg.signedUrl } : null,
        error: cfg.signedUrl ? null : { message: "sign failed" },
      });
    },
  };

  const buckets: string[] = [];
  const db = {
    storage: {
      from(bucket: string) {
        buckets.push(bucket);
        return fileApi;
      },
    },
  } as unknown as SupabaseClient;

  return { db, uploads, buckets, getSignedPath: () => signedPath };
}

const STORE_PARAMS_BASE = {
  tenantId: "tenant-1",
  folderParts: ["N023", "2026-07"],
  fileName: "2026-07-18T09-00-00Z_msg-1.jpg",
  mime: "image/jpeg",
  data: Buffer.from("IMG"),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.BILL_STORAGE_BACKEND;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BILL_STORAGE_BACKEND;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe("getBillStorageBackend", () => {
  it("ไม่ตั้ง env → default supabase", () => {
    expect(getBillStorageBackend()).toBe("supabase");
  });
  it("ตั้ง drive → drive (case-insensitive/trim)", () => {
    process.env.BILL_STORAGE_BACKEND = "  Drive ";
    expect(getBillStorageBackend()).toBe("drive");
  });
  it("ตั้ง onedrive → onedrive (case-insensitive/trim)", () => {
    process.env.BILL_STORAGE_BACKEND = "  OneDrive ";
    expect(getBillStorageBackend()).toBe("onedrive");
  });
  it("ค่าแปลก ๆ → ถือเป็น supabase", () => {
    process.env.BILL_STORAGE_BACKEND = "s3";
    expect(getBillStorageBackend()).toBe("supabase");
  });
});

describe("isBillStorageEnabled", () => {
  it("supabase: มี service role env → true", () => {
    expect(isBillStorageEnabled()).toBe(true);
  });
  it("supabase: ไม่มี service role env → false", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(isBillStorageEnabled()).toBe(false);
  });
  it("drive: ตาม isDriveEnabled", () => {
    process.env.BILL_STORAGE_BACKEND = "drive";
    isDriveEnabledMock.mockReturnValue(true);
    expect(isBillStorageEnabled()).toBe(true);
    isDriveEnabledMock.mockReturnValue(false);
    expect(isBillStorageEnabled()).toBe(false);
  });
  it("onedrive: ตาม isOneDriveEnabled", () => {
    process.env.BILL_STORAGE_BACKEND = "onedrive";
    isOneDriveEnabledMock.mockReturnValue(true);
    expect(isBillStorageEnabled()).toBe(true);
    isOneDriveEnabledMock.mockReturnValue(false);
    expect(isBillStorageEnabled()).toBe(false);
  });
});

describe("storeBillFile — supabase backend", () => {
  it("upload สำเร็จ → คืน objectPath (tenant/parts/file) + signed URL", async () => {
    const { db, uploads, buckets, getSignedPath } = makeFakeStorageDb({
      signedUrl: "https://x.supabase.co/signed/abc",
    });

    const res = await storeBillFile({ db, ...STORE_PARAMS_BASE });

    expect(buckets).toEqual(["bills"]); // เรียก .from('bills') ครั้งเดียว reuse handle
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toBe("tenant-1/N023/2026-07/2026-07-18T09-00-00Z_msg-1.jpg");
    expect(uploads[0].opts).toMatchObject({ contentType: "image/jpeg", upsert: false });
    expect(res).toEqual({
      objectPath: "tenant-1/N023/2026-07/2026-07-18T09-00-00Z_msg-1.jpg",
      url: "https://x.supabase.co/signed/abc",
    });
    expect(getSignedPath()).toBe(res?.objectPath);
  });

  it("เซ็น URL ไม่ได้ → fallback url = objectPath", async () => {
    const { db } = makeFakeStorageDb({ signedUrl: null });
    const res = await storeBillFile({ db, ...STORE_PARAMS_BASE });
    expect(res?.url).toBe(res?.objectPath);
  });

  it("upload ล้ม (error) → คืน null ไม่ throw", async () => {
    const { db } = makeFakeStorageDb({ uploadError: { message: "duplicate" }, signedUrl: "x" });
    const res = await storeBillFile({ db, ...STORE_PARAMS_BASE });
    expect(res).toBeNull();
  });

  it("sanitize: ตัด / ในชื่อโฟลเดอร์ กัน path traversal", async () => {
    const { db, uploads } = makeFakeStorageDb({ signedUrl: "u" });
    await storeBillFile({
      db,
      ...STORE_PARAMS_BASE,
      folderParts: ["a/b", "../etc"],
    });
    expect(uploads[0].path).toBe("tenant-1/a_b/.._etc/2026-07-18T09-00-00Z_msg-1.jpg");
  });

  it("sanitize: อักขระไทย/ช่องว่าง → ASCII ล้วน (กัน 400 InvalidKey)", async () => {
    const { db, uploads } = makeFakeStorageDb({ signedUrl: "u" });
    await storeBillFile({
      db,
      ...STORE_PARAMS_BASE,
      folderParts: ["ลูกค้า A", "2026-07"],
    });
    const path = uploads[0].path;
    // ทั้ง key ต้องเป็น ASCII-safe เท่านั้น: [A-Za-z0-9._/-]
    expect(path).toMatch(/^[A-Za-z0-9._/-]+$/);
    // ไม่เหลืออักขระไทยเลย
    expect(/[^\x00-\x7f]/.test(path)).toBe(false);
    // ไทย 6 ตัว + ช่องว่าง + A → "_______A"
    expect(path).toBe("tenant-1/_______A/2026-07/2026-07-18T09-00-00Z_msg-1.jpg");
  });

  it("sanitize: segment ที่ว่างถูกตัดทิ้ง (กัน // ใน key)", async () => {
    const { db, uploads } = makeFakeStorageDb({ signedUrl: "u" });
    await storeBillFile({
      db,
      ...STORE_PARAMS_BASE,
      folderParts: ["", "2026-07"],
    });
    expect(uploads[0].path).toBe("tenant-1/2026-07/2026-07-18T09-00-00Z_msg-1.jpg");
  });

  it("storage client throw → จับภายใน คืน null", async () => {
    const db = {
      storage: {
        from() {
          throw new Error("boom");
        },
      },
    } as unknown as SupabaseClient;
    const res = await storeBillFile({ db, ...STORE_PARAMS_BASE });
    expect(res).toBeNull();
  });
});

describe("storeBillFile — drive backend", () => {
  it("delegate ไป ensureFolderPath + uploadFile, map fileId→objectPath", async () => {
    process.env.BILL_STORAGE_BACKEND = "drive";
    ensureFolderPathMock.mockResolvedValue("folder-1");
    uploadFileMock.mockResolvedValue({ fileId: "drive-file-1", url: "https://drive/view" });

    const { db } = makeFakeStorageDb({ signedUrl: "unused" });
    const res = await storeBillFile({ db, ...STORE_PARAMS_BASE });

    expect(ensureFolderPathMock).toHaveBeenCalledWith(["N023", "2026-07"]);
    expect(uploadFileMock).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ objectPath: "drive-file-1", url: "https://drive/view" });
  });

  it("ensureFolderPath ล้ม → คืน null ไม่ upload", async () => {
    process.env.BILL_STORAGE_BACKEND = "drive";
    ensureFolderPathMock.mockResolvedValue(null);
    const { db } = makeFakeStorageDb({ signedUrl: "u" });
    const res = await storeBillFile({ db, ...STORE_PARAMS_BASE });
    expect(res).toBeNull();
    expect(uploadFileMock).not.toHaveBeenCalled();
  });
});

describe("storeBillFile — onedrive backend", () => {
  it("delegate ไป uploadOneDriveFile (ส่ง folderParts/fileName/mime/data ตรง)", async () => {
    process.env.BILL_STORAGE_BACKEND = "onedrive";
    uploadOneDriveFileMock.mockResolvedValue({
      objectPath: "NOVA-Bills/N023/2026-07/2026-07-18T09-00-00Z_msg-1.jpg",
      url: "https://onedrive/webUrl",
    });

    const { db } = makeFakeStorageDb({ signedUrl: "unused" });
    const res = await storeBillFile({ db, ...STORE_PARAMS_BASE });

    expect(uploadOneDriveFileMock).toHaveBeenCalledWith({
      folderParts: ["N023", "2026-07"],
      fileName: "2026-07-18T09-00-00Z_msg-1.jpg",
      mime: "image/jpeg",
      data: STORE_PARAMS_BASE.data,
    });
    expect(res).toEqual({
      objectPath: "NOVA-Bills/N023/2026-07/2026-07-18T09-00-00Z_msg-1.jpg",
      url: "https://onedrive/webUrl",
    });
  });

  it("upload ล้ม → คืน null", async () => {
    process.env.BILL_STORAGE_BACKEND = "onedrive";
    uploadOneDriveFileMock.mockResolvedValue(null);
    const { db } = makeFakeStorageDb({ signedUrl: "u" });
    const res = await storeBillFile({ db, ...STORE_PARAMS_BASE });
    expect(res).toBeNull();
  });
});
