import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * เทสต์ server actions ของหน้า "จัดการผังบัญชี" (A9, docs/06-accounting-features-roadmap.md)
 *   - ยืนยัน guard (requireAdminContext) + inject tenant จาก session (ไม่เชื่อ client)
 *   - เรียก data-layer (chart-accounts-data.ts) ด้วย tenant จาก session ถูกต้อง
 *   - guard throw → คืน error สุภาพ ไม่แตะ service
 * mock ชั้นล่าง (supabase/guard/data-layer/next-cache) เพื่อทดสอบเฉพาะ logic ของ action
 */
const {
  createChartAccountMock,
  updateChartAccountMock,
  setChartAccountActiveMock,
  softDeleteChartAccountMock,
  requireAdminContextMock,
} = vi.hoisted(() => ({
  createChartAccountMock: vi.fn(),
  updateChartAccountMock: vi.fn(),
  setChartAccountActiveMock: vi.fn(),
  softDeleteChartAccountMock: vi.fn(),
  requireAdminContextMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ __authed: true })),
  createServiceRoleClient: vi.fn(() => ({ __service: true })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/admin/guard", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/admin/guard")>();
  return {
    ...actual,
    requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
  };
});

vi.mock("@/lib/accounting/chart-accounts-data", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/chart-accounts-data")>();
  return {
    ...actual,
    createChartAccount: (...args: unknown[]) => createChartAccountMock(...args),
    updateChartAccount: (...args: unknown[]) => updateChartAccountMock(...args),
    setChartAccountActive: (...args: unknown[]) => setChartAccountActiveMock(...args),
    softDeleteChartAccount: (...args: unknown[]) => softDeleteChartAccountMock(...args),
  };
});

import {
  createChartAccountAction,
  updateChartAccountAction,
  toggleChartAccountActiveAction,
  deleteChartAccountAction,
} from "@/app/chat-audit/admin/chart-of-accounts/actions";
import { AdminAuthError } from "@/lib/admin/guard";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminContextMock.mockResolvedValue({ tenantId: "tenant-9", role: "admin", userId: "user-7" });
  createChartAccountMock.mockResolvedValue({ ok: true, id: "acc-1" });
  updateChartAccountMock.mockResolvedValue({ ok: true, id: "acc-1" });
  setChartAccountActiveMock.mockResolvedValue({ ok: true, id: "acc-1" });
  softDeleteChartAccountMock.mockResolvedValue({ ok: true, id: "acc-1" });
});

describe("createChartAccountAction", () => {
  it("สำเร็จ: เรียก createChartAccount ด้วย tenant จาก session (ไม่ใช่ client)", async () => {
    const res = await createChartAccountAction(
      null,
      fd({ code: "5900", name: "ค่าใช้จ่ายทดสอบ", category: "ค่าใช้จ่าย" })
    );
    expect(res.ok).toBe(true);
    expect(createChartAccountMock).toHaveBeenCalledTimes(1);
    const [, tenantId, input] = createChartAccountMock.mock.calls[0];
    expect(tenantId).toBe("tenant-9"); // ★ จาก session ไม่ใช่ client
    expect(input).toEqual({ code: "5900", name: "ค่าใช้จ่ายทดสอบ", category: "ค่าใช้จ่าย", isBank: false });
  });

  it("checkbox isBank ติ๊ก (on) → isBank:true", async () => {
    const form = fd({ code: "1099", name: "เงินฝากทดสอบ", category: "สินทรัพย์" });
    form.set("isBank", "on");
    await createChartAccountAction(null, form);
    const [, , input] = createChartAccountMock.mock.calls[0];
    expect(input.isBank).toBe(true);
  });

  it("data layer ปฏิเสธ (เช่นรหัสซ้ำ) → คืนข้อความจาก data layer ตรง ๆ", async () => {
    createChartAccountMock.mockResolvedValue({ ok: false, message: "รหัสบัญชีนี้มีอยู่ในผังแล้ว" });
    const res = await createChartAccountAction(null, fd({ code: "1010", name: "ซ้ำ", category: "สินทรัพย์" }));
    expect(res.ok).toBe(false);
    expect(res.message).toBe("รหัสบัญชีนี้มีอยู่ในผังแล้ว");
  });

  it("ไม่มีสิทธิ์ (guard throw) → คืน error สุภาพ ไม่แตะ data layer", async () => {
    requireAdminContextMock.mockRejectedValue(new AdminAuthError());
    const res = await createChartAccountAction(null, fd({ code: "5900", name: "x", category: "ค่าใช้จ่าย" }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/สิทธิ์/);
    expect(createChartAccountMock).not.toHaveBeenCalled();
  });
});

describe("updateChartAccountAction", () => {
  it("สำเร็จ: เรียก updateChartAccount ด้วย id + tenant จาก session", async () => {
    const res = await updateChartAccountAction(
      null,
      fd({ id: "acc-1", code: "5340", name: "ค่าน้ำมัน (แก้ชื่อ)", category: "ค่าใช้จ่าย" })
    );
    expect(res.ok).toBe(true);
    const [, tenantId, id, input] = updateChartAccountMock.mock.calls[0];
    expect(tenantId).toBe("tenant-9");
    expect(id).toBe("acc-1");
    expect(input.name).toBe("ค่าน้ำมัน (แก้ชื่อ)");
  });

  it("data layer ปฏิเสธ (รหัสโครงสร้าง) → คืนข้อความ", async () => {
    updateChartAccountMock.mockResolvedValue({
      ok: false,
      message: "รหัสบัญชีนี้เป็นรหัสโครงสร้างที่ระบบผูกไว้ — แก้รหัสไม่ได้ (แก้ชื่อ/หมวดได้)",
    });
    const res = await updateChartAccountAction(
      null,
      fd({ id: "acc-1", code: "9999", name: "เงินสด", category: "สินทรัพย์" })
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/โครงสร้าง/);
  });
});

describe("toggleChartAccountActiveAction", () => {
  it("isActive=1 → ส่ง true ให้ data layer", async () => {
    await toggleChartAccountActiveAction(null, fd({ id: "acc-1", isActive: "1" }));
    expect(setChartAccountActiveMock).toHaveBeenCalledWith({ __service: true }, "tenant-9", "acc-1", true);
  });

  it("isActive=0 → ส่ง false ให้ data layer", async () => {
    await toggleChartAccountActiveAction(null, fd({ id: "acc-1", isActive: "0" }));
    expect(setChartAccountActiveMock).toHaveBeenCalledWith({ __service: true }, "tenant-9", "acc-1", false);
  });
});

describe("deleteChartAccountAction", () => {
  it("สำเร็จ: เรียก softDeleteChartAccount ด้วย tenant จาก session", async () => {
    const res = await deleteChartAccountAction(null, fd({ id: "acc-1" }));
    expect(res.ok).toBe(true);
    expect(softDeleteChartAccountMock).toHaveBeenCalledWith({ __service: true }, "tenant-9", "acc-1");
  });

  it("data layer ปฏิเสธ (รหัสป้องกัน) → คืนข้อความปฏิเสธ ไม่ revalidate", async () => {
    softDeleteChartAccountMock.mockResolvedValue({
      ok: false,
      message: "รหัส 1010 เป็นรหัสโครงสร้างที่ระบบบัญชีผูกไว้ — ลบไม่ได้",
    });
    const res = await deleteChartAccountAction(null, fd({ id: "acc-1" }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ลบไม่ได้/);
  });

  it("ไม่มีสิทธิ์ (guard throw) → คืน error สุภาพ ไม่แตะ data layer", async () => {
    requireAdminContextMock.mockRejectedValue(new AdminAuthError());
    const res = await deleteChartAccountAction(null, fd({ id: "acc-1" }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/สิทธิ์/);
    expect(softDeleteChartAccountMock).not.toHaveBeenCalled();
  });
});
