import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * เทสต์ server actions ของหน้า "จัดการสินค้า/บริการ" (B4, docs/06-accounting-features-roadmap.md)
 *   - ยืนยัน guard (requireAdminContext) + inject tenant จาก session (ไม่เชื่อ client)
 *   - เรียก data-layer (products.ts) ด้วย tenant จาก session ถูกต้อง
 *   - guard throw → คืน error สุภาพ ไม่แตะ service
 * mock ชั้นล่าง (supabase/guard/data-layer/next-cache) เพื่อทดสอบเฉพาะ logic ของ action
 */
const {
  createProductMock,
  updateProductMock,
  setProductActiveMock,
  softDeleteProductMock,
  requireAdminContextMock,
} = vi.hoisted(() => ({
  createProductMock: vi.fn(),
  updateProductMock: vi.fn(),
  setProductActiveMock: vi.fn(),
  softDeleteProductMock: vi.fn(),
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

vi.mock("@/lib/accounting/products", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/products")>();
  return {
    ...actual,
    createProduct: (...args: unknown[]) => createProductMock(...args),
    updateProduct: (...args: unknown[]) => updateProductMock(...args),
    setProductActive: (...args: unknown[]) => setProductActiveMock(...args),
    softDeleteProduct: (...args: unknown[]) => softDeleteProductMock(...args),
  };
});

import {
  createProductAction,
  updateProductAction,
  toggleProductActiveAction,
  deleteProductAction,
} from "@/app/chat-audit/admin/products/actions";
import { AdminAuthError } from "@/lib/admin/guard";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminContextMock.mockResolvedValue({ tenantId: "tenant-9", role: "admin", userId: "user-7" });
  createProductMock.mockResolvedValue({ ok: true, id: "prod-1" });
  updateProductMock.mockResolvedValue({ ok: true, id: "prod-1" });
  setProductActiveMock.mockResolvedValue({ ok: true, id: "prod-1" });
  softDeleteProductMock.mockResolvedValue({ ok: true, id: "prod-1" });
});

describe("createProductAction", () => {
  it("สำเร็จ: เรียก createProduct ด้วย tenant จาก session (ไม่ใช่ client)", async () => {
    const res = await createProductAction(
      null,
      fd({ sku: "SKU-1", name: "สินค้าทดสอบ", unit: "ชิ้น", defaultPrice: "100", defaultAccountCode: "4010" })
    );
    expect(res.ok).toBe(true);
    expect(createProductMock).toHaveBeenCalledTimes(1);
    const [, tenantId, input] = createProductMock.mock.calls[0];
    expect(tenantId).toBe("tenant-9"); // ★ จาก session ไม่ใช่ client
    expect(input).toEqual({
      sku: "SKU-1",
      name: "สินค้าทดสอบ",
      unit: "ชิ้น",
      defaultPrice: "100",
      defaultAccountCode: "4010",
    });
  });

  it("data layer ปฏิเสธ (เช่น sku ซ้ำ) → คืนข้อความจาก data layer ตรง ๆ", async () => {
    createProductMock.mockResolvedValue({ ok: false, message: "รหัสสินค้า (SKU) นี้มีอยู่แล้ว" });
    const res = await createProductAction(null, fd({ sku: "DUP", name: "x" }));
    expect(res.ok).toBe(false);
    expect(res.message).toBe("รหัสสินค้า (SKU) นี้มีอยู่แล้ว");
  });

  it("ไม่มีสิทธิ์ (guard throw) → คืน error สุภาพ ไม่แตะ data layer", async () => {
    requireAdminContextMock.mockRejectedValue(new AdminAuthError());
    const res = await createProductAction(null, fd({ name: "x" }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/สิทธิ์/);
    expect(createProductMock).not.toHaveBeenCalled();
  });
});

describe("updateProductAction", () => {
  it("สำเร็จ: เรียก updateProduct ด้วย id + tenant จาก session", async () => {
    const res = await updateProductAction(null, fd({ id: "prod-1", name: "สินค้า (แก้)" }));
    expect(res.ok).toBe(true);
    const [, tenantId, id, input] = updateProductMock.mock.calls[0];
    expect(tenantId).toBe("tenant-9");
    expect(id).toBe("prod-1");
    expect(input.name).toBe("สินค้า (แก้)");
  });

  it("data layer ปฏิเสธ → คืนข้อความ", async () => {
    updateProductMock.mockResolvedValue({ ok: false, message: "กรุณากรอกชื่อสินค้า/บริการ (และตรวจว่าราคาไม่ติดลบ)" });
    const res = await updateProductAction(null, fd({ id: "prod-1", name: "" }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ชื่อสินค้า/);
  });
});

describe("toggleProductActiveAction", () => {
  it("isActive=1 → ส่ง true ให้ data layer", async () => {
    await toggleProductActiveAction(null, fd({ id: "prod-1", isActive: "1" }));
    expect(setProductActiveMock).toHaveBeenCalledWith({ __service: true }, "tenant-9", "prod-1", true);
  });

  it("isActive=0 → ส่ง false ให้ data layer", async () => {
    await toggleProductActiveAction(null, fd({ id: "prod-1", isActive: "0" }));
    expect(setProductActiveMock).toHaveBeenCalledWith({ __service: true }, "tenant-9", "prod-1", false);
  });
});

describe("deleteProductAction", () => {
  it("สำเร็จ: เรียก softDeleteProduct ด้วย tenant จาก session", async () => {
    const res = await deleteProductAction(null, fd({ id: "prod-1" }));
    expect(res.ok).toBe(true);
    expect(softDeleteProductMock).toHaveBeenCalledWith({ __service: true }, "tenant-9", "prod-1");
  });

  it("ไม่มีสิทธิ์ (guard throw) → คืน error สุภาพ ไม่แตะ data layer", async () => {
    requireAdminContextMock.mockRejectedValue(new AdminAuthError());
    const res = await deleteProductAction(null, fd({ id: "prod-1" }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/สิทธิ์/);
    expect(softDeleteProductMock).not.toHaveBeenCalled();
  });
});
