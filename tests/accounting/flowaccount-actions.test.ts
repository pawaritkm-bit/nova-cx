import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * เทสต์ server action `sendToFlowAccountAction` (ปุ่ม "ส่งไป FlowAccount")
 *   - guard สิทธิ์/สโคปนักบัญชี (assertCustomerInScope ผ่าน access.ts จริง)
 *   - forward ไป syncEntryToFlowAccount (mock) แล้ว map ผลเป็นข้อความไทยสุภาพ (เฟส 5 ส่วน P — เดิมชื่อ
 *     syncSaleEntryToFlowAccount รองรับแค่ sale — T34 rename ตาม T33)
 *   ★ M2: ไม่มี allowlist FLOWACCOUNT_CUSTOMER_ID อีกต่อไป (ลบเทสต์เดิมทั้งหมดออก — ดู decision 0.5)
 *     credential ต่อลูกค้าทำหน้าที่แทน (reason `customer_not_configured` มาจาก flowaccount-sync.ts)
 * mock ชั้นล่าง (supabase/access/flowaccount-sync/next-cache) ตาม pattern tests/admin/actions.test.ts
 */
const {
  requireAccountingAccessMock,
  loadEntryCustomerIdMock,
  syncEntryToFlowAccountMock,
  revalidatePathMock,
} = vi.hoisted(() => ({
  requireAccountingAccessMock: vi.fn(),
  loadEntryCustomerIdMock: vi.fn(),
  syncEntryToFlowAccountMock: vi.fn(),
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

vi.mock("@/lib/accounting/flowaccount-sync", () => ({
  syncEntryToFlowAccount: (...args: unknown[]) => syncEntryToFlowAccountMock(...args),
}));

import { sendToFlowAccountAction } from "@/app/chat-audit/accounting/flowaccount-actions";
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
  syncEntryToFlowAccountMock.mockResolvedValue({
    ok: true,
    docType: "tax_invoice",
    docId: "999",
    docNo: "IV-0001",
  });
});

describe("sendToFlowAccountAction", () => {
  it("entryId ไม่ใช่ uuid → ปฏิเสธทันที ไม่แตะ DB", async () => {
    const res = await sendToFlowAccountAction("not-a-uuid");
    expect(res).toEqual({ ok: false, message: "ไม่พบรายการที่เลือก" });
    expect(requireAccountingAccessMock).not.toHaveBeenCalled();
  });

  it("ไม่มีสิทธิ์ (guard throw) → คืน error สุภาพ ไม่เรียก sync", async () => {
    requireAccountingAccessMock.mockRejectedValue(new AccountingAuthError());
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res.ok).toBe(false);
    expect(syncEntryToFlowAccountMock).not.toHaveBeenCalled();
  });

  it("ไม่พบบิล (loadEntryCustomerId คืน undefined) → ปฏิเสธ ไม่เรียก sync", async () => {
    loadEntryCustomerIdMock.mockResolvedValue(undefined);
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res).toEqual({ ok: false, message: "ไม่พบบิลนี้ (อาจถูกลบไปแล้ว)" });
    expect(syncEntryToFlowAccountMock).not.toHaveBeenCalled();
  });

  it("ปฏิเสธนักบัญชีนอกสโคป (ลูกค้าของบิลไม่อยู่ในชุดที่ดูแล) → ไม่เรียก sync", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    loadEntryCustomerIdMock.mockResolvedValue(CUSTOMER_A); // ลูกค้าของบิล ≠ ลูกค้าที่นักบัญชีดูแล
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ความดูแล/);
    expect(syncEntryToFlowAccountMock).not.toHaveBeenCalled();
  });

  it("นักบัญชีในสโคป (ลูกค้าของบิลอยู่ในชุดที่ดูแล) → เรียก sync สำเร็จ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_A]));
    loadEntryCustomerIdMock.mockResolvedValue(CUSTOMER_A);
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res.ok).toBe(true);
    expect(syncEntryToFlowAccountMock).toHaveBeenCalledTimes(1);
  });

  it("ลูกค้ายังไม่เปิดใช้การเชื่อมต่อ FlowAccount (customer_not_configured) → ข้อความสุภาพ ไม่ throw", async () => {
    syncEntryToFlowAccountMock.mockResolvedValue({ ok: false, reason: "customer_not_configured" });
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res).toEqual({ ok: false, message: "ลูกค้ารายนี้ยังไม่เปิดใช้การเชื่อมต่อ FlowAccount" });
  });

  it("entry ไม่ confirmed → คืนข้อความไทยสุภาพตาม reason ที่ sync ปฏิเสธ", async () => {
    syncEntryToFlowAccountMock.mockResolvedValue({ ok: false, reason: "not_confirmed" });
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res).toEqual({ ok: false, message: "บิลต้องยืนยันก่อนถึงจะส่งได้" });
  });

  it("entry_type ไม่รองรับ (เช่น unspecified) → คืนข้อความไทยสุภาพตาม reason unsupported_entry_type (เฟส 5 ส่วน P)", async () => {
    syncEntryToFlowAccountMock.mockResolvedValue({ ok: false, reason: "unsupported_entry_type" });
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ยังไม่รองรับการส่ง FlowAccount/);
  });

  it("บิลซื้อ (purchase) ผู้ขายไม่มีเลขภาษี → missing_vendor_tax_id ข้อความสุภาพ (เฟส 5 ส่วน P)", async () => {
    syncEntryToFlowAccountMock.mockResolvedValue({ ok: false, reason: "missing_vendor_tax_id" });
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res).toEqual({ ok: false, message: "ผู้ขายยังไม่มีเลขประจำตัวผู้เสียภาษี กรุณาเพิ่มก่อนส่ง" });
  });

  it("ส่งบิลซื้อ (purchase_bill) สำเร็จ → คืนข้อความมีเลขที่เอกสาร (เฟส 5 ส่วน P)", async () => {
    syncEntryToFlowAccountMock.mockResolvedValue({
      ok: true,
      docType: "purchase_bill",
      docId: "888",
      docNo: "PB-0001",
    });
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res).toEqual({ ok: true, message: "ส่งไป FlowAccount แล้ว — เลขที่ PB-0001", docNo: "PB-0001" });
  });

  it("กดซ้ำ/สองแท็บ (already_syncing) → คืนข้อความสุภาพ ไม่ throw", async () => {
    syncEntryToFlowAccountMock.mockResolvedValue({ ok: false, reason: "already_syncing" });
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ส่งบิลนี้อยู่แล้ว/);
  });

  it("สำเร็จ → คืนข้อความมีเลขที่เอกสาร + revalidatePath หน้าบัญชี", async () => {
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res).toEqual({ ok: true, message: "ส่งไป FlowAccount แล้ว — เลขที่ IV-0001", docNo: "IV-0001" });
    expect(revalidatePathMock).toHaveBeenCalledWith("/chat-audit/accounting");
  });

  it("สำเร็จแต่ไม่มีเลขที่เอกสาร (docNo null) → ข้อความไม่มีเลขที่", async () => {
    syncEntryToFlowAccountMock.mockResolvedValue({
      ok: true,
      docType: "cash_sale",
      docId: "1",
      docNo: null,
    });
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res).toEqual({ ok: true, message: "ส่งไป FlowAccount แล้ว", docNo: null });
  });

  it("ล้มเหลวจาก FlowAccount (server_error) → ข้อความสุภาพ ไม่หลุด reason ดิบ", async () => {
    syncEntryToFlowAccountMock.mockResolvedValue({ ok: false, reason: "server_error" });
    const res = await sendToFlowAccountAction(ENTRY_ID);
    expect(res.ok).toBe(false);
    expect(res.message).not.toMatch(/server_error/);
  });

  it("ส่ง requestedBy = employeeId ของนักบัญชีที่กดส่ง", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_A]));
    loadEntryCustomerIdMock.mockResolvedValue(CUSTOMER_A);
    await sendToFlowAccountAction(ENTRY_ID);
    const [, , , opts] = syncEntryToFlowAccountMock.mock.calls[0];
    expect(opts).toEqual({ requestedBy: "emp-1" });
  });
});
