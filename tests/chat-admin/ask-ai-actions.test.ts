import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * เทสต์ server action ของหน้า "ถาม AI เรื่องข้อมูลธุรกิจ" (/chat-audit/accounting/ask-ai — wishlist ข้อ 3)
 *   - ยืนยัน guard (requireAccountingAccess) + assertCustomerInScope(customerId ที่ client ส่งมา)
 *   - validate customerId เป็น uuid + คำถามไม่ว่าง/ไม่ยาวเกิน ก่อนแตะ data layer
 *   - guard throw (ลูกค้านอกสโคป) → คืน error สุภาพ ไม่เรียก answerBusinessQuestion
 * mock ชั้นล่าง (supabase/access/lib/ai/business-qa) ตาม pattern tests/chat-admin/products-actions.test.ts
 */

const { answerBusinessQuestionMock, requireAccountingAccessMock, assertCustomerInScopeMock } = vi.hoisted(() => ({
  answerBusinessQuestionMock: vi.fn(),
  requireAccountingAccessMock: vi.fn(),
  assertCustomerInScopeMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ __authed: true })),
  createServiceRoleClient: vi.fn(() => ({ __service: true })),
}));

vi.mock("@/lib/accounting/access", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/access")>();
  return {
    ...actual,
    requireAccountingAccess: (...args: unknown[]) => requireAccountingAccessMock(...args),
    assertCustomerInScope: (...args: unknown[]) => assertCustomerInScopeMock(...args),
  };
});

vi.mock("@/lib/ai/business-qa", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ai/business-qa")>();
  return { ...actual, answerBusinessQuestion: answerBusinessQuestionMock };
});

import { askBusinessQuestionAction } from "@/app/chat-audit/accounting/ask-ai/actions";
import { AccountingAuthError } from "@/lib/accounting/access";

const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const adminCtx = {
  tenantId: "tenant-1",
  mode: "admin" as const,
  employeeId: null,
  name: null,
  allowedCustomerIds: null,
  navRole: "admin" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  assertCustomerInScopeMock.mockReset();
  assertCustomerInScopeMock.mockImplementation(() => undefined);
  answerBusinessQuestionMock.mockResolvedValue({ ok: true, answer: "ยอดขายเดือนนี้ 1,000 บาทครับ", intent: "sales_month" });
});

describe("askBusinessQuestionAction", () => {
  it("customerId ในสโคป + คำถามถูกต้อง → เรียก answerBusinessQuestion ด้วย tenantId จาก session", async () => {
    const res = await askBusinessQuestionAction(CUSTOMER_ID, "ยอดขายเดือนนี้เท่าไหร่");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.answer).toBe("ยอดขายเดือนนี้ 1,000 บาทครับ");
    expect(assertCustomerInScopeMock).toHaveBeenCalledWith(adminCtx, CUSTOMER_ID);
    const [, tenantId, customerId, question] = answerBusinessQuestionMock.mock.calls[0];
    expect(tenantId).toBe("tenant-1");
    expect(customerId).toBe(CUSTOMER_ID);
    expect(question).toBe("ยอดขายเดือนนี้เท่าไหร่");
  });

  it("customerId ไม่ใช่ uuid → ปฏิเสธทันที ไม่แตะ AI/DB", async () => {
    const res = await askBusinessQuestionAction("not-a-uuid", "ยอดขายเดือนนี้เท่าไหร่");
    expect(res.ok).toBe(false);
    expect(answerBusinessQuestionMock).not.toHaveBeenCalled();
    expect(requireAccountingAccessMock).not.toHaveBeenCalled();
  });

  it("คำถามว่างเปล่า → ปฏิเสธทันที ไม่แตะ AI/DB", async () => {
    const res = await askBusinessQuestionAction(CUSTOMER_ID, "   ");
    expect(res.ok).toBe(false);
    expect(answerBusinessQuestionMock).not.toHaveBeenCalled();
  });

  it("คำถามยาวเกินเพดาน → ปฏิเสธทันที ไม่แตะ AI/DB", async () => {
    const res = await askBusinessQuestionAction(CUSTOMER_ID, "ก".repeat(501));
    expect(res.ok).toBe(false);
    expect(answerBusinessQuestionMock).not.toHaveBeenCalled();
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี (assertCustomerInScope throw) → ปฏิเสธ ไม่เรียก answerBusinessQuestion", async () => {
    assertCustomerInScopeMock.mockImplementation(() => {
      throw new AccountingAuthError("ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ");
    });
    const res = await askBusinessQuestionAction(CUSTOMER_ID, "ยอดขายเดือนนี้เท่าไหร่");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/ความดูแล/);
    expect(answerBusinessQuestionMock).not.toHaveBeenCalled();
  });

  it("ไม่มีสิทธิ์เลย (requireAccountingAccess throw) → คืน error สุภาพ ไม่แตะ AI/DB", async () => {
    requireAccountingAccessMock.mockRejectedValue(new AccountingAuthError());
    const res = await askBusinessQuestionAction(CUSTOMER_ID, "ยอดขายเดือนนี้เท่าไหร่");
    expect(res.ok).toBe(false);
    expect(answerBusinessQuestionMock).not.toHaveBeenCalled();
  });

  it("answerBusinessQuestion ปฏิเสธ (เช่น ไม่มี AI provider) → คืนข้อความจาก lib ตรง ๆ", async () => {
    answerBusinessQuestionMock.mockResolvedValue({ ok: false, message: "ยังไม่ได้ตั้งค่า AI (OPENAI_API_KEY)" });
    const res = await askBusinessQuestionAction(CUSTOMER_ID, "ยอดขายเดือนนี้เท่าไหร่");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toBe("ยังไม่ได้ตั้งค่า AI (OPENAI_API_KEY)");
  });
});
