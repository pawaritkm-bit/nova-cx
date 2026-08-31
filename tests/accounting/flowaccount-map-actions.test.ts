import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type Capture, type Resolver } from "../helpers/fake-supabase";

/**
 * เทสต์ server actions "mapping ผังบัญชี/สินค้า nova-cx ↔ FlowAccount ต่อลูกค้า" (เฟส 5 ส่วน Q, T25)
 *   mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern tests/accounting/customer-admin-actions.test.ts
 *   ★ ใช้ makeFakeDb (tests/helpers/fake-supabase.ts) จำลอง service-role client จริง (ไม่ mock ทั้ง action)
 */

const { requireAccountingAccessMock, revalidatePathMock } = vi.hoisted(() => ({
  requireAccountingAccessMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

let currentDb: ReturnType<typeof makeFakeDb>["db"];
let currentCapture: Capture;

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ __authed: true })),
  createServiceRoleClient: vi.fn(() => currentDb),
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

vi.mock("@/lib/accounting/access", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/access")>();
  return {
    ...actual,
    requireAccountingAccess: (...args: unknown[]) => requireAccountingAccessMock(...args),
  };
});

import {
  upsertAccountMapAction,
  deleteAccountMapAction,
  upsertProductMapAction,
  deleteProductMapAction,
} from "@/app/chat-audit/accounting/flowaccount-map-actions";

const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const PRODUCT_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const MAP_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const adminCtx = {
  tenantId: "tenant-1",
  mode: "admin" as const,
  employeeId: null,
  name: null,
  allowedCustomerIds: null,
  navRole: "admin" as const,
};

function accountantCtx(allowed: string[]) {
  return {
    tenantId: "tenant-1",
    mode: "accountant" as const,
    employeeId: "emp-1",
    name: "นักบัญชี",
    allowedCustomerIds: new Set(allowed),
    navRole: "accountant" as const,
  };
}

/**
 * resolver มาตรฐาน:
 *   - customers select maybeSingle (customerBelongsToTenant) → พบเสมอ (เว้นแต่ customerFound=false)
 *   - products select maybeSingle (productBelongsToTenant) → พบเสมอ (เว้นแต่ productFound=false)
 *   - flowaccount_account_map/flowaccount_product_map:
 *       select maybeSingle (cur-check ตอน upsert หรือโหลด customer_id ตอน delete) → ตาม opts
 *       insert/update/delete → สำเร็จเสมอ (เว้นแต่ opts.dbError)
 */
function makeResolver(
  opts: {
    customerFound?: boolean;
    productFound?: boolean;
    mapCustomerId?: string | null; // customer_id ของแถว mapping ที่กำลังจะลบ (undefined = ไม่พบแถว)
    dbError?: boolean;
  } = {}
): Resolver {
  const customerFound = opts.customerFound ?? true;
  const productFound = opts.productFound ?? true;
  const dbError = opts.dbError ?? false;
  return ({ table, op, terminal, payload }) => {
    if (table === "customers") {
      if (op === "select" && terminal === "maybeSingle") {
        return customerFound ? { data: { id: CUSTOMER_ID }, error: null } : { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === "products") {
      if (op === "select" && terminal === "maybeSingle") {
        return productFound ? { data: { id: PRODUCT_ID }, error: null } : { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === "flowaccount_account_map" || table === "flowaccount_product_map") {
      if (op === "select" && terminal === "maybeSingle") {
        // ใช้ทั้งกรณี cur-check ตอน upsert (ไม่มี mapping เดิม → null) และโหลด customer_id ตอน delete
        if (opts.mapCustomerId === undefined) return { data: null, error: null };
        return { data: { customer_id: opts.mapCustomerId }, error: null };
      }
      if (op === "insert" && terminal === "maybeSingle") {
        return dbError ? { data: null, error: { message: "boom" } } : { data: { id: "new-map-id" }, error: null };
      }
      if ((op === "update" || op === "delete") && terminal === "await") {
        return dbError ? { data: null, error: { message: "boom" } } : { data: null, error: null };
      }
      return { data: null, error: null };
    }
    void payload;
    return { data: null, error: null };
  };
}

function setupDb(opts: Parameters<typeof makeResolver>[0] = {}) {
  const { db, capture } = makeFakeDb(makeResolver(opts));
  currentDb = db;
  currentCapture = capture;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  setupDb();
});

// ---------------------------------------------------------------------
// upsertAccountMapAction / deleteAccountMapAction
// ---------------------------------------------------------------------

describe("upsertAccountMapAction", () => {
  it("admin บันทึก mapping ผังบัญชีของลูกค้าใดก็ได้ → สำเร็จ + revalidatePath", async () => {
    const res = await upsertAccountMapAction({
      customerId: CUSTOMER_ID,
      accountCode: "4010",
      flowaccountAccountCode: "SALE-01",
    });
    expect(res.ok).toBe(true);
    expect(revalidatePathMock).toHaveBeenCalledWith("/chat-audit/accounting/flowaccount-map");
    const ins = currentCapture.inserts.find((i) => i.table === "flowaccount_account_map");
    expect(ins).toBeTruthy();
  });

  it("นักบัญชีนอกสโคป — ลูกค้าไม่อยู่ในชุดที่ดูแล → บันทึกไม่ได้ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await upsertAccountMapAction({
      customerId: CUSTOMER_ID,
      accountCode: "4010",
      flowaccountAccountCode: "SALE-01",
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts).toHaveLength(0);
    expect(currentCapture.updates).toHaveLength(0);
  });

  it("นักบัญชีในสโคป — บันทึก mapping ของลูกค้าที่ตัวเองดูแลได้", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_ID]));
    const res = await upsertAccountMapAction({
      customerId: CUSTOMER_ID,
      accountCode: "4010",
      flowaccountAccountCode: "SALE-01",
    });
    expect(res.ok).toBe(true);
  });

  it("lead ทำได้ทุกลูกค้าในทีม (allowedCustomerIds มีลูกค้านี้)", async () => {
    requireAccountingAccessMock.mockResolvedValue({ ...accountantCtx([CUSTOMER_ID]), mode: "lead", navRole: "acc_lead" });
    const res = await upsertAccountMapAction({
      customerId: CUSTOMER_ID,
      accountCode: "4010",
      flowaccountAccountCode: "SALE-01",
    });
    expect(res.ok).toBe(true);
  });

  it("ลูกค้าไม่พบในเทแนนต์นี้ → ปฏิเสธสุภาพ ไม่หลุด internal", async () => {
    setupDb({ customerFound: false });
    const res = await upsertAccountMapAction({
      customerId: CUSTOMER_ID,
      accountCode: "4010",
      flowaccountAccountCode: "SALE-01",
    });
    expect(res.ok).toBe(false);
    expect(res.message).not.toMatch(/undefined|null|Error|stack/i);
  });

  it("customerId ไม่ใช่ uuid → ปฏิเสธทันที ไม่แตะ DB", async () => {
    const res = await upsertAccountMapAction({
      customerId: "not-a-uuid",
      accountCode: "4010",
      flowaccountAccountCode: "SALE-01",
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts).toHaveLength(0);
  });

  it("DB ล้ม (เช่นยังไม่ apply migration 0071) → ข้อความสุภาพ ไม่ throw", async () => {
    setupDb({ dbError: true });
    const res = await upsertAccountMapAction({
      customerId: CUSTOMER_ID,
      accountCode: "4010",
      flowaccountAccountCode: "SALE-01",
    });
    expect(res.ok).toBe(false);
    expect(res.message).not.toMatch(/undefined|null|Error|stack|boom/i);
  });
});

describe("deleteAccountMapAction", () => {
  it("admin ลบ mapping ของลูกค้าใดก็ได้ → สำเร็จ + revalidatePath", async () => {
    setupDb({ mapCustomerId: CUSTOMER_ID });
    const res = await deleteAccountMapAction(MAP_ID);
    expect(res.ok).toBe(true);
    expect(revalidatePathMock).toHaveBeenCalledWith("/chat-audit/accounting/flowaccount-map");
    expect(currentCapture.deletes).toContainEqual({ table: "flowaccount_account_map" });
  });

  it("นักบัญชีนอกสโคปลบ mapping ของลูกค้าอื่นไม่ได้", async () => {
    setupDb({ mapCustomerId: CUSTOMER_ID });
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await deleteAccountMapAction(MAP_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.deletes ?? []).toHaveLength(0);
  });

  it("นักบัญชีในสโคปลบ mapping ของลูกค้าที่ตัวเองดูแลได้", async () => {
    setupDb({ mapCustomerId: CUSTOMER_ID });
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_ID]));
    const res = await deleteAccountMapAction(MAP_ID);
    expect(res.ok).toBe(true);
  });

  it("ไม่พบแถว mapping (ถูกลบไปแล้ว) → ปฏิเสธสุภาพ", async () => {
    setupDb({ mapCustomerId: undefined });
    const res = await deleteAccountMapAction(MAP_ID);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ไม่พบ/);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที ไม่แตะ DB", async () => {
    const res = await deleteAccountMapAction("not-a-uuid");
    expect(res.ok).toBe(false);
    expect(currentCapture.deletes ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// upsertProductMapAction / deleteProductMapAction
// ---------------------------------------------------------------------

describe("upsertProductMapAction", () => {
  it("admin บันทึก mapping สินค้าของลูกค้าใดก็ได้ → สำเร็จ + revalidatePath", async () => {
    const res = await upsertProductMapAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      flowaccountProductId: "999",
    });
    expect(res.ok).toBe(true);
    expect(revalidatePathMock).toHaveBeenCalledWith("/chat-audit/accounting/flowaccount-map");
    const ins = currentCapture.inserts.find((i) => i.table === "flowaccount_product_map");
    expect(ins).toBeTruthy();
  });

  it("นักบัญชีนอกสโคป — ลูกค้าไม่อยู่ในชุดที่ดูแล → บันทึกไม่ได้", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await upsertProductMapAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      flowaccountProductId: "999",
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts).toHaveLength(0);
  });

  it("นักบัญชีในสโคปบันทึกได้", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_ID]));
    const res = await upsertProductMapAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      flowaccountProductId: "999",
    });
    expect(res.ok).toBe(true);
  });

  it("productId ไม่ใช่ uuid → ปฏิเสธ (มาจาก data layer validate) ไม่หลุด internal", async () => {
    const res = await upsertProductMapAction({
      customerId: CUSTOMER_ID,
      productId: "not-a-uuid",
      flowaccountProductId: "999",
    });
    expect(res.ok).toBe(false);
    expect(res.message).not.toMatch(/undefined|Error|stack/i);
  });

  /**
   * ★ ช่องโหว่ data-integrity ที่ QA พบในเฟส 5 ส่วน Q (แก้แล้ว): เดิม upsertProductMapAction ตรวจว่า
   *   `customerId` เป็นของ tenant นี้จริง (customerBelongsToTenant) แต่ไม่เคยตรวจว่า `productId` เป็นสินค้า
   *   ของ tenant นี้จริง — validate แค่รูปแบบ uuid เท่านั้น (FK migration 0071 เช็คแค่ "แถวมีอยู่จริงในตาราง
   *   products" ไม่เช็ค tenant_id) → mapping ผูก productId ข้าม tenant ได้ถ้ารู้ uuid สินค้าของ tenant อื่น
   *   แก้ด้วย productBelongsToTenant() (mirror customerBelongsToTenant) เช็คก่อนเขียนลง DB ทุกครั้ง
   */
  it("productId เป็นของ tenant อื่น (ไม่พบใน products ของ tenant นี้) → ปฏิเสธ ไม่ insert ลง DB", async () => {
    setupDb({ productFound: false });
    const res = await upsertProductMapAction({
      customerId: CUSTOMER_ID,
      productId: "aaaaaaaa-1111-1111-1111-111111111111", // uuid ที่ถูกรูปแบบ แต่เป็นสินค้าของ tenant อื่น (mock ไม่พบ)
      flowaccountProductId: "999",
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ไม่พบสินค้า/);
    expect(currentCapture.inserts).toHaveLength(0);
    expect(currentCapture.updates).toHaveLength(0);
  });

  it("ยืนยัน productBelongsToTenant query ตาราง products ด้วย id + tenant_id จริง", async () => {
    const res = await upsertProductMapAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      flowaccountProductId: "999",
    });
    expect(res.ok).toBe(true);
    const productFilters = currentCapture.filters.filter((f) => f.table === "products");
    expect(productFilters).toContainEqual({ table: "products", kind: "eq", column: "id", value: PRODUCT_ID });
    expect(productFilters).toContainEqual({
      table: "products",
      kind: "eq",
      column: "tenant_id",
      value: "tenant-1",
    });
  });

  it("productId เป็นของ tenant นี้จริง (ปกติ) → ยังบันทึกได้เหมือนเดิม", async () => {
    const res = await upsertProductMapAction({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      flowaccountProductId: "999",
    });
    expect(res.ok).toBe(true);
    expect(currentCapture.inserts.find((i) => i.table === "flowaccount_product_map")).toBeTruthy();
  });
});

describe("deleteProductMapAction", () => {
  it("admin ลบ mapping สินค้าของลูกค้าใดก็ได้ → สำเร็จ + revalidatePath", async () => {
    setupDb({ mapCustomerId: CUSTOMER_ID });
    const res = await deleteProductMapAction(MAP_ID);
    expect(res.ok).toBe(true);
    expect(revalidatePathMock).toHaveBeenCalledWith("/chat-audit/accounting/flowaccount-map");
    expect(currentCapture.deletes).toContainEqual({ table: "flowaccount_product_map" });
  });

  it("นักบัญชีนอกสโคปลบไม่ได้", async () => {
    setupDb({ mapCustomerId: CUSTOMER_ID });
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await deleteProductMapAction(MAP_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.deletes ?? []).toHaveLength(0);
  });

  it("นักบัญชีในสโคปลบ mapping สินค้าของลูกค้าที่ตัวเองดูแลได้", async () => {
    setupDb({ mapCustomerId: CUSTOMER_ID });
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_ID]));
    const res = await deleteProductMapAction(MAP_ID);
    expect(res.ok).toBe(true);
    expect(currentCapture.deletes).toContainEqual({ table: "flowaccount_product_map" });
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที ไม่แตะ DB", async () => {
    const res = await deleteProductMapAction("not-a-uuid");
    expect(res.ok).toBe(false);
    expect(currentCapture.deletes ?? []).toHaveLength(0);
  });
});
