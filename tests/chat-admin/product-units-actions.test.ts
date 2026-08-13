import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type Resolver } from "../helpers/fake-supabase";

/**
 * เทสต์ server actions ของหน้า "จัดการสินค้า/บริการ" ส่วนหน่วยนับเพิ่มเติม (wishlist backlog ข้อ 2)
 *   - createProductUnitAction ต้องเช็คว่า productId เป็นของ tenant นี้จริงก่อนเรียก data layer
 *     (กัน client ผูกหน่วยนับเข้ากับสินค้าของ tenant อื่นผ่าน productId ปลอม)
 *   - update/delete ผ่าน data layer ตรง ๆ (scope tenant อยู่ใน data layer อยู่แล้ว)
 *   - guard throw → คืน error สุภาพ ไม่แตะ service
 * mock ชั้นล่าง (supabase/guard/data-layer/next-cache) ตาม pattern tests/chat-admin/products-actions.test.ts
 *   ★ ต่าง: createProductUnitAction คิวรี "products" ตรงในไฟล์ actions.ts เอง (ไม่ผ่าน data layer)
 *     ต้อง mock service client ให้เป็น fake DB จริง (ไม่ใช่ {__service:true} เฉย ๆ)
 */

const { createProductUnitMock, updateProductUnitMock, softDeleteProductUnitMock, requireAdminContextMock } = vi.hoisted(() => ({
  createProductUnitMock: vi.fn(),
  updateProductUnitMock: vi.fn(),
  softDeleteProductUnitMock: vi.fn(),
  requireAdminContextMock: vi.fn(),
}));

let currentDb: ReturnType<typeof makeFakeDb>["db"];

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ __authed: true })),
  createServiceRoleClient: vi.fn(() => currentDb),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/admin/guard", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/admin/guard")>();
  return {
    ...actual,
    requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
  };
});

vi.mock("@/lib/accounting/product-units", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/product-units")>();
  return {
    ...actual,
    createProductUnit: (...args: unknown[]) => createProductUnitMock(...args),
    updateProductUnit: (...args: unknown[]) => updateProductUnitMock(...args),
    softDeleteProductUnit: (...args: unknown[]) => softDeleteProductUnitMock(...args),
  };
});

import {
  createProductUnitAction,
  updateProductUnitAction,
  deleteProductUnitAction,
} from "@/app/chat-audit/admin/products/actions";
import { AdminAuthError } from "@/lib/admin/guard";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function makeResolver(opts: { productExists?: boolean } = {}): Resolver {
  const productExists = opts.productExists ?? true;
  return ({ table, op, terminal }) => {
    if (table === "products" && op === "select" && terminal === "maybeSingle") {
      return { data: productExists ? { id: "prod-1" } : null, error: null };
    }
    return { data: null, error: null };
  };
}

function setupDb(opts: Parameters<typeof makeResolver>[0] = {}) {
  currentDb = makeFakeDb(makeResolver(opts)).db;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminContextMock.mockResolvedValue({ tenantId: "tenant-9", role: "admin", userId: "user-7" });
  createProductUnitMock.mockResolvedValue({ ok: true, id: "unit-1" });
  updateProductUnitMock.mockResolvedValue({ ok: true, id: "unit-1" });
  softDeleteProductUnitMock.mockResolvedValue({ ok: true, id: "unit-1" });
  setupDb();
});

describe("createProductUnitAction", () => {
  it("productId เป็นของ tenant นี้จริง → เรียก createProductUnit ด้วย tenant จาก session", async () => {
    const res = await createProductUnitAction(null, fd({ productId: "prod-1", unitName: "โหล", factorToBase: "12" }));
    expect(res.ok).toBe(true);
    expect(createProductUnitMock).toHaveBeenCalledTimes(1);
    const [, tenantId, productId, input] = createProductUnitMock.mock.calls[0];
    expect(tenantId).toBe("tenant-9");
    expect(productId).toBe("prod-1");
    expect(input).toEqual({ unitName: "โหล", factorToBase: "12" });
  });

  it("★ productId ไม่พบใน tenant นี้ (ปลอม/ข้าม tenant) → ปฏิเสธ ไม่เรียก data layer", async () => {
    setupDb({ productExists: false });
    const res = await createProductUnitAction(null, fd({ productId: "prod-foreign", unitName: "โหล", factorToBase: "12" }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ไม่พบสินค้า/);
    expect(createProductUnitMock).not.toHaveBeenCalled();
  });

  it("data layer ปฏิเสธ (เช่น ชื่อหน่วยซ้ำ) → คืนข้อความจาก data layer ตรง ๆ", async () => {
    createProductUnitMock.mockResolvedValue({ ok: false, message: "สินค้านี้มีหน่วยนับชื่อนี้อยู่แล้ว" });
    const res = await createProductUnitAction(null, fd({ productId: "prod-1", unitName: "โหล", factorToBase: "12" }));
    expect(res.ok).toBe(false);
    expect(res.message).toBe("สินค้านี้มีหน่วยนับชื่อนี้อยู่แล้ว");
  });

  it("ไม่มีสิทธิ์ (guard throw) → คืน error สุภาพ ไม่แตะ data layer", async () => {
    requireAdminContextMock.mockRejectedValue(new AdminAuthError());
    const res = await createProductUnitAction(null, fd({ productId: "prod-1", unitName: "โหล", factorToBase: "12" }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/สิทธิ์/);
    expect(createProductUnitMock).not.toHaveBeenCalled();
  });
});

describe("updateProductUnitAction", () => {
  it("สำเร็จ: เรียก updateProductUnit ด้วย id + tenant จาก session", async () => {
    const res = await updateProductUnitAction(null, fd({ id: "unit-1", unitName: "ลัง", factorToBase: "24" }));
    expect(res.ok).toBe(true);
    const [, tenantId, id, input] = updateProductUnitMock.mock.calls[0];
    expect(tenantId).toBe("tenant-9");
    expect(id).toBe("unit-1");
    expect(input).toEqual({ unitName: "ลัง", factorToBase: "24" });
  });

  it("ไม่มีสิทธิ์ → คืน error สุภาพ ไม่แตะ data layer", async () => {
    requireAdminContextMock.mockRejectedValue(new AdminAuthError());
    const res = await updateProductUnitAction(null, fd({ id: "unit-1", unitName: "ลัง", factorToBase: "24" }));
    expect(res.ok).toBe(false);
    expect(updateProductUnitMock).not.toHaveBeenCalled();
  });
});

describe("deleteProductUnitAction", () => {
  it("สำเร็จ: เรียก softDeleteProductUnit ด้วย tenant จาก session", async () => {
    const res = await deleteProductUnitAction(null, fd({ id: "unit-1" }));
    expect(res.ok).toBe(true);
    expect(softDeleteProductUnitMock).toHaveBeenCalledWith(currentDb, "tenant-9", "unit-1");
  });

  it("ไม่มีสิทธิ์ → คืน error สุภาพ ไม่แตะ data layer", async () => {
    requireAdminContextMock.mockRejectedValue(new AdminAuthError());
    const res = await deleteProductUnitAction(null, fd({ id: "unit-1" }));
    expect(res.ok).toBe(false);
    expect(softDeleteProductUnitMock).not.toHaveBeenCalled();
  });
});
