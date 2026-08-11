import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * เทสต์ server actions ของหน้า "ปรับปรุงอัตราแลกเปลี่ยนปลายงวด" (/chat-audit/accounting/fx-revaluation —
 *   เฟส 10b, T133) — mock ชั้น lib/accounting/fx-revaluation.ts ทั้งชุด (ไฟล์นั้นมีเทสต์ของตัวเองครบแล้วที่
 *   tests/accounting/fx-revaluation.test.ts) เพื่อแยกทดสอบ "ชั้น action" อย่างเดียว: validate input
 *   ตื้น ๆ + guard สโคป (requireAccountingAccess/assertCustomerInScope, IDOR-safe จาก resource จริง) +
 *   ส่งต่อ error message จาก lib ตรง ๆ ไม่ swallow + revalidatePath
 */

const { requireAccountingAccessMock, createFxRevaluationDraftMock, confirmFxRevaluationMock, confirmFxReversingMock, unconfirmFxReversingMock, getFxPeriodRevaluationCustomerIdMock, fetchBotReferenceRateMock } =
  vi.hoisted(() => ({
    requireAccountingAccessMock: vi.fn(),
    createFxRevaluationDraftMock: vi.fn(),
    confirmFxRevaluationMock: vi.fn(),
    confirmFxReversingMock: vi.fn(),
    unconfirmFxReversingMock: vi.fn(),
    getFxPeriodRevaluationCustomerIdMock: vi.fn(),
    fetchBotReferenceRateMock: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ __authed: true })),
  createServiceRoleClient: vi.fn(() => ({ __service: true })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/accounting/access", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/access")>();
  return {
    ...actual,
    requireAccountingAccess: (...args: unknown[]) => requireAccountingAccessMock(...args),
  };
});

vi.mock("@/lib/accounting/chart-accounts-data", () => ({
  listChartOfAccounts: vi.fn(async () => []),
}));

vi.mock("@/lib/integrations/bot-exchange-rate", () => ({
  fetchBotReferenceRate: (...args: unknown[]) => fetchBotReferenceRateMock(...args),
}));

vi.mock("@/lib/accounting/fx-revaluation", () => ({
  createFxRevaluationDraft: (...args: unknown[]) => createFxRevaluationDraftMock(...args),
  confirmFxRevaluation: (...args: unknown[]) => confirmFxRevaluationMock(...args),
  confirmFxReversing: (...args: unknown[]) => confirmFxReversingMock(...args),
  unconfirmFxReversing: (...args: unknown[]) => unconfirmFxReversingMock(...args),
  getFxPeriodRevaluationCustomerId: (...args: unknown[]) => getFxPeriodRevaluationCustomerIdMock(...args),
}));

import {
  createFxRevaluationDraftAction,
  confirmFxRevaluationAction,
  confirmFxReversingAction,
  unconfirmFxReversingAction,
  fetchBotRateAction,
} from "@/app/chat-audit/accounting/fx-revaluation/actions";

const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const REVALUATION_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

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
  createFxRevaluationDraftMock.mockResolvedValue({ ok: true, id: "new-reval-id" });
  confirmFxRevaluationMock.mockResolvedValue({ ok: true, id: REVALUATION_ID });
  confirmFxReversingMock.mockResolvedValue({ ok: true, id: REVALUATION_ID });
  unconfirmFxReversingMock.mockResolvedValue({ ok: true, id: REVALUATION_ID });
  getFxPeriodRevaluationCustomerIdMock.mockResolvedValue(CUSTOMER_ID);
  fetchBotReferenceRateMock.mockResolvedValue({ ok: true, rate: 33.5 });
});

describe("createFxRevaluationDraftAction", () => {
  const validInput = {
    customerId: CUSTOMER_ID,
    entryType: "sale",
    currency: "USD",
    periodEndDate: "2026-06-30",
    closingRate: 33.5,
    source: "manual",
  };

  it("input ถูกต้อง + อยู่ในสโคป → เรียก createFxRevaluationDraft ของ lib ด้วยพารามิเตอร์ที่ถูก แล้วส่งต่อผลสำเร็จ", async () => {
    const res = await createFxRevaluationDraftAction(validInput);
    expect(res.ok).toBe(true);
    expect(res.id).toBe("new-reval-id");
    expect(createFxRevaluationDraftMock).toHaveBeenCalledTimes(1);
    const args = createFxRevaluationDraftMock.mock.calls[0];
    expect(args[1]).toBe("tenant-1"); // tenantId จาก session
    expect(args[2]).toBe(CUSTOMER_ID);
    expect(args[3]).toBe("sale");
    expect(args[4]).toBe("USD");
    expect(args[5]).toBe("2026-06-30");
    expect(args[6]).toBe(33.5);
    expect(args[7]).toBe("manual");
  });

  it("★ ส่งต่อ error message จาก lib ตรง ๆ ไม่ swallow (เช่น guard #1 ปฏิเสธ)", async () => {
    createFxRevaluationDraftMock.mockResolvedValue({ ok: false, message: "ต้องยืนยันรายการกลับรายการของงวดก่อนหน้าให้เสร็จก่อน" });
    const res = await createFxRevaluationDraftAction(validInput);
    expect(res.ok).toBe(false);
    expect(res.message).toBe("ต้องยืนยันรายการกลับรายการของงวดก่อนหน้าให้เสร็จก่อน");
  });

  it("★★★ นักบัญชีนอกสโคปเรียกกับลูกค้าอื่น → ปฏิเสธ ไม่เรียก lib เลย (IDOR-safe)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await createFxRevaluationDraftAction(validInput);
    expect(res.ok).toBe(false);
    expect(createFxRevaluationDraftMock).not.toHaveBeenCalled();
  });

  it("customerId ไม่ใช่ uuid → ปฏิเสธทันที ไม่เรียก lib", async () => {
    const res = await createFxRevaluationDraftAction({ ...validInput, customerId: "not-a-uuid" });
    expect(res.ok).toBe(false);
    expect(createFxRevaluationDraftMock).not.toHaveBeenCalled();
  });

  it("entryType ไม่ใช่ sale/purchase → ปฏิเสธทันที ไม่เรียก lib", async () => {
    const res = await createFxRevaluationDraftAction({ ...validInput, entryType: "unspecified" });
    expect(res.ok).toBe(false);
    expect(createFxRevaluationDraftMock).not.toHaveBeenCalled();
  });

  it("currency ไม่ถูกต้อง → ปฏิเสธทันที ไม่เรียก lib", async () => {
    const res = await createFxRevaluationDraftAction({ ...validInput, currency: "usd1" });
    expect(res.ok).toBe(false);
    expect(createFxRevaluationDraftMock).not.toHaveBeenCalled();
  });

  it("source='bot' ส่งต่อไปยัง lib ตรง ๆ", async () => {
    await createFxRevaluationDraftAction({ ...validInput, source: "bot" });
    expect(createFxRevaluationDraftMock.mock.calls[0][7]).toBe("bot");
  });

  it("source ไม่ใช่ 'bot' (เช่นไม่ระบุ/ค่าอื่น) → default เป็น 'manual' เสมอ", async () => {
    await createFxRevaluationDraftAction({ ...validInput, source: undefined });
    expect(createFxRevaluationDraftMock.mock.calls[0][7]).toBe("manual");
  });
});

/** ทดสอบ 3 action ที่ pattern เดียวกัน (confirm reval/confirm reversing/unconfirm reversing) แบบ table-driven */
const scopedActions: {
  name: string;
  run: (id: string, customerId: string) => Promise<{ ok: boolean; message: string }>;
  mock: typeof confirmFxRevaluationMock;
}[] = [
  { name: "confirmFxRevaluationAction", run: confirmFxRevaluationAction, mock: confirmFxRevaluationMock },
  { name: "confirmFxReversingAction", run: confirmFxReversingAction, mock: confirmFxReversingMock },
  { name: "unconfirmFxReversingAction", run: unconfirmFxReversingAction, mock: unconfirmFxReversingMock },
];

for (const { name, run, mock } of scopedActions) {
  describe(name, () => {
    it("customerId ตรงกับของแถวจริง + อยู่ในสโคป → เรียก lib แล้วส่งต่อผลสำเร็จ", async () => {
      const res = await run(REVALUATION_ID, CUSTOMER_ID);
      expect(res.ok).toBe(true);
      expect(mock).toHaveBeenCalledWith(expect.anything(), "tenant-1", REVALUATION_ID);
    });

    it("★ ส่งต่อ error message จาก lib ตรง ๆ ไม่ swallow", async () => {
      mock.mockResolvedValue({ ok: false, message: "เดบิตรวมไม่เท่ากับเครดิตรวม — ยืนยันไม่ได้" });
      const res = await run(REVALUATION_ID, CUSTOMER_ID);
      expect(res.ok).toBe(false);
      expect(res.message).toBe("เดบิตรวมไม่เท่ากับเครดิตรวม — ยืนยันไม่ได้");
    });

    it("★★★ IDOR — customerId ที่ client ส่งมาไม่ตรงกับ customerId จริงของแถว (แม้จะ valid uuid + อยู่ในสโคปของ client เอง) → ปฏิเสธ ไม่เรียก lib", async () => {
      getFxPeriodRevaluationCustomerIdMock.mockResolvedValue(CUSTOMER_OTHER); // แถวจริงเป็นของลูกค้าอื่น
      const res = await run(REVALUATION_ID, CUSTOMER_ID);
      expect(res.ok).toBe(false);
      expect(mock).not.toHaveBeenCalled();
    });

    it("นักบัญชีนอกสโคปของลูกค้าที่ระบุ → ปฏิเสธก่อนแม้ยังไม่ query แถวจริง", async () => {
      requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
      const res = await run(REVALUATION_ID, CUSTOMER_ID);
      expect(res.ok).toBe(false);
      expect(mock).not.toHaveBeenCalled();
    });

    it("ไม่พบแถวจริง (ถูกลบไปแล้ว) → ปฏิเสธ ไม่เรียก lib", async () => {
      getFxPeriodRevaluationCustomerIdMock.mockResolvedValue(null);
      const res = await run(REVALUATION_ID, CUSTOMER_ID);
      expect(res.ok).toBe(false);
      expect(mock).not.toHaveBeenCalled();
    });

    it("id ไม่ใช่ uuid → ปฏิเสธทันที ไม่เรียก lib", async () => {
      const res = await run("not-a-uuid", CUSTOMER_ID);
      expect(res.ok).toBe(false);
      expect(mock).not.toHaveBeenCalled();
    });
  });
}

describe("fetchBotRateAction", () => {
  it("สกุลเงินถูกต้อง + มีสิทธิ์ → ส่งต่อผลจาก fetchBotReferenceRate ตรง ๆ", async () => {
    const res = await fetchBotRateAction("USD", "2026-06-30");
    expect(res).toEqual({ ok: true, rate: 33.5 });
    expect(fetchBotReferenceRateMock).toHaveBeenCalledWith("USD", "2026-06-30");
  });

  it("สกุลเงินผิดรูปแบบ → {ok:false} ทันที ไม่เรียก fetchBotReferenceRate เลย", async () => {
    const res = await fetchBotRateAction("usd", "2026-06-30");
    expect(res).toEqual({ ok: false });
    expect(fetchBotReferenceRateMock).not.toHaveBeenCalled();
  });

  it("ไม่มีสิทธิ์เข้าถึงหน้าบัญชี (ไม่ login/ไม่ใช่นักบัญชี) → {ok:false} กันใช้เป็น proxy โดยคนนอกระบบ", async () => {
    requireAccountingAccessMock.mockRejectedValue(new Error("no access"));
    const res = await fetchBotRateAction("USD", "2026-06-30");
    expect(res).toEqual({ ok: false });
    expect(fetchBotReferenceRateMock).not.toHaveBeenCalled();
  });
});
