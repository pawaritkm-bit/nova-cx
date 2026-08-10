import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * เทสต์ server action `syncStockFromBillAction` (ปุ่ม "บันทึกรับ/จ่ายสต็อก" ที่หน้ารายการบิล — เฟส 8
 *   ส่วน Y, T71, docs/06-accounting-features-roadmap.md หมวด 0.7/0.8/0.13)
 *   - guard สิทธิ์/สโคปนักบัญชี (assertCustomerInScope ผ่าน access.ts จริง)
 *   - ★ derive scope จาก entry id จริงเสมอ (loadEntryCustomerId) — ไม่รับ customerId แยกที่ไม่ผูกกับ
 *     entryId (IDOR-safe pattern ตั้งแต่เฟส 3, 0.13)
 *   - forward ไป createMovementsFromBill (mock) แล้ว map ผลเป็นข้อความไทยสุภาพ
 * mock ชั้นล่าง (supabase/access/product-stock/next-cache) ตาม pattern tests/accounting/flowaccount-actions.test.ts
 */
const {
  requireAccountingAccessMock,
  loadEntryCustomerIdMock,
  createMovementsFromBillMock,
  revalidatePathMock,
} = vi.hoisted(() => ({
  requireAccountingAccessMock: vi.fn(),
  loadEntryCustomerIdMock: vi.fn(),
  createMovementsFromBillMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ __authed: true })),
  createServiceRoleClient: vi.fn(() => ({ __service: true })),
}));

vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePathMock(...args) }));

vi.mock("@/lib/accounting/access", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/access")>();
  return {
    ...actual,
    requireAccountingAccess: (...args: unknown[]) => requireAccountingAccessMock(...args),
    loadEntryCustomerId: (...args: unknown[]) => loadEntryCustomerIdMock(...args),
  };
});

vi.mock("@/lib/accounting/product-stock", () => ({
  createMovementsFromBill: (...args: unknown[]) => createMovementsFromBillMock(...args),
}));

import { syncStockFromBillAction } from "@/app/chat-audit/accounting/stock-sync-actions";
import { AccountingAuthError } from "@/lib/accounting/access";

const ENTRY_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const CUSTOMER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CUSTOMER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

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

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  loadEntryCustomerIdMock.mockResolvedValue(CUSTOMER_A);
  createMovementsFromBillMock.mockResolvedValue({ ok: true, created: 2, skippedLineIds: [] });
});

describe("syncStockFromBillAction", () => {
  it("entryId ไม่ใช่ uuid → ปฏิเสธทันที ไม่แตะ DB", async () => {
    const res = await syncStockFromBillAction("not-a-uuid");
    expect(res).toEqual({ ok: false, message: "ไม่พบรายการที่เลือก" });
    expect(requireAccountingAccessMock).not.toHaveBeenCalled();
  });

  it("ไม่มีสิทธิ์ (guard throw) → คืน error สุภาพ ไม่เรียก createMovementsFromBill", async () => {
    requireAccountingAccessMock.mockRejectedValue(new AccountingAuthError());
    const res = await syncStockFromBillAction(ENTRY_ID);
    expect(res.ok).toBe(false);
    expect(createMovementsFromBillMock).not.toHaveBeenCalled();
  });

  it("ไม่พบบิล (loadEntryCustomerId คืน undefined) → ปฏิเสธ ไม่เรียก createMovementsFromBill", async () => {
    loadEntryCustomerIdMock.mockResolvedValue(undefined);
    const res = await syncStockFromBillAction(ENTRY_ID);
    expect(res).toEqual({ ok: false, message: "ไม่พบบิลนี้ (อาจถูกลบไปแล้ว)" });
    expect(createMovementsFromBillMock).not.toHaveBeenCalled();
  });

  it("★ 0.13 ปฏิเสธนักบัญชีนอกสโคป (ลูกค้าของบิลไม่อยู่ในชุดที่ดูแล) → ไม่เรียก createMovementsFromBill", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    loadEntryCustomerIdMock.mockResolvedValue(CUSTOMER_A); // ลูกค้าของบิล ≠ ลูกค้าที่นักบัญชีดูแล
    const res = await syncStockFromBillAction(ENTRY_ID);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ความดูแล/);
    expect(createMovementsFromBillMock).not.toHaveBeenCalled();
  });

  it("★ derive scope จาก entry จริงเสมอ — ไม่มีพารามิเตอร์ customerId ให้ปลอมส่งมาข้าม (0.13, IDOR-safe)", async () => {
    // syncStockFromBillAction รับแค่ entryId เดียว — สโคปคำนวณจาก loadEntryCustomerId(entryId) เท่านั้น
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_A]));
    loadEntryCustomerIdMock.mockResolvedValue(CUSTOMER_A);
    await syncStockFromBillAction(ENTRY_ID);
    expect(loadEntryCustomerIdMock).toHaveBeenCalledWith(expect.anything(), "tenant-1", ENTRY_ID);
  });

  it("นักบัญชีในสโคป (ลูกค้าของบิลอยู่ในชุดที่ดูแล) → เรียก createMovementsFromBill สำเร็จ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_A]));
    loadEntryCustomerIdMock.mockResolvedValue(CUSTOMER_A);
    const res = await syncStockFromBillAction(ENTRY_ID);
    expect(res.ok).toBe(true);
    expect(createMovementsFromBillMock).toHaveBeenCalledTimes(1);
  });

  it("สำเร็จ → คืนข้อความสุภาพ + revalidatePath หน้าบัญชี", async () => {
    const res = await syncStockFromBillAction(ENTRY_ID);
    expect(res).toEqual({ ok: true, message: "บันทึกรายการสต็อกสำเร็จ 2 รายการ", created: 2, skipped: 0 });
    expect(revalidatePathMock).toHaveBeenCalledWith("/chat-audit/accounting");
  });

  it("กดซ้ำ/สองแท็บ (already claimed) → คืนข้อความสุภาพ ไม่ throw", async () => {
    createMovementsFromBillMock.mockResolvedValue({ ok: false, message: "สร้างรายการสต็อกไปแล้ว" });
    const res = await syncStockFromBillAction(ENTRY_ID);
    expect(res).toEqual({ ok: false, message: "สร้างรายการสต็อกไปแล้ว" });
  });

  it("บิลไม่มีบรรทัดที่ product_id+quantity ครบ → คืนข้อความสุภาพจาก createMovementsFromBill ตรง ๆ", async () => {
    createMovementsFromBillMock.mockResolvedValue({
      ok: false,
      message: "บิลนี้ไม่มีบรรทัดที่ผูกสินค้า+จำนวนครบ ไม่สามารถบันทึกสต็อกได้",
    });
    const res = await syncStockFromBillAction(ENTRY_ID);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ไม่มีบรรทัดที่ผูกสินค้า/);
  });

  it("throw ไม่คาดคิดจาก createMovementsFromBill → จับแล้วคืนข้อความสุภาพ ไม่หลุด error ดิบ", async () => {
    createMovementsFromBillMock.mockRejectedValue(new Error("db explode"));
    const res = await syncStockFromBillAction(ENTRY_ID);
    expect(res.ok).toBe(false);
    expect(res.message).not.toMatch(/db explode/);
  });

  it("มีบรรทัดถูกข้าม (skippedLineIds) → นับ skipped ในผลลัพธ์", async () => {
    createMovementsFromBillMock.mockResolvedValue({ ok: true, created: 1, skippedLineIds: ["l1", "l2"] });
    const res = await syncStockFromBillAction(ENTRY_ID);
    expect(res).toEqual({ ok: true, message: "บันทึกรายการสต็อกสำเร็จ 1 รายการ", created: 1, skipped: 2 });
  });
});
