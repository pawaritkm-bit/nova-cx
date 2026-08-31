import { beforeEach, describe, expect, it, vi } from "vitest";

const { downloadOneDriveObjectPathMock } = vi.hoisted(() => ({
  downloadOneDriveObjectPathMock: vi.fn(),
}));

vi.mock("@/lib/storage/onedrive", () => ({
  downloadOneDriveObjectPath: (...args: unknown[]) => downloadOneDriveObjectPathMock(...args),
}));

import { downloadStoredBillFile, isOneDriveBillPath } from "@/lib/storage/bill-download";

describe("bill download backend routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("รู้จักเฉพาะ objectPath ของ NOVA-Bills/NOVA-Care", () => {
    expect(isOneDriveBillPath("NOVA-Care/ลูกค้า/บิลอื่นๆ/a.pdf")).toBe(true);
    expect(isOneDriveBillPath("NOVA-Bills/ลูกค้า/สเตทเมนต์/a.pdf")).toBe(true);
    expect(isOneDriveBillPath("tenant/customer/a.pdf")).toBe(false);
  });

  it("ไฟล์ Care ใช้ OneDrive loader ไม่แตะ Supabase", async () => {
    downloadOneDriveObjectPathMock.mockResolvedValue(Buffer.from("pdf"));
    const storage = { from: vi.fn() };
    const db = { storage } as never;
    const path = "NOVA-Care/ลูกค้า/บิลอื่นๆ/a.pdf";
    const got = await downloadStoredBillFile(db, path);
    expect(got?.toString()).toBe("pdf");
    expect(downloadOneDriveObjectPathMock).toHaveBeenCalledWith(path);
    expect(storage.from).not.toHaveBeenCalled();
  });

  it("path ปกติยังโหลดจาก Supabase bucket bills", async () => {
    const download = vi.fn().mockResolvedValue({
      data: new Blob(["image"]),
      error: null,
    });
    const from = vi.fn().mockReturnValue({ download });
    const db = { storage: { from } } as never;
    const got = await downloadStoredBillFile(db, "tenant/customer/a.jpg");
    expect(got?.toString()).toBe("image");
    expect(from).toHaveBeenCalledWith("bills");
  });
});

