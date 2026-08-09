import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * เทสต์ server actions ของหน้า "กระทบยอดธนาคาร" (/chat-audit/accounting/bank-reconciliation — เฟส 6 ส่วน T)
 *   mock ชั้นล่าง (supabase/access/next-cache/bank-accounts/bank-reconciliation data layer) ตาม pattern
 *   tests/accounting/recurring-journal-actions.test.ts / budget-actions.test.ts
 *
 * ★ เน้นเทสต์บังคับตาม DoD (T52/T53):
 *   - guard สโคป: นักบัญชีนอกสโคปทำรายการของลูกค้าอื่นไม่ได้ (ทุก action)
 *   - resolveBankAccount: ไม่เชื่อ accountCode จาก client — ต้องเป็นบัญชีเงินฝากของลูกค้ารายนั้นจริงเท่านั้น
 *   - confirmMatchAction: ★ re-compute bookLines สดฝั่ง server เสมอ — ไม่พบ bookLineKey ที่ client ส่งมา
 *     ในผลลัพธ์ที่ re-compute แล้ว → ปฏิเสธ (กัน client ปลอม snapshot, 0.15/0.17)
 *   - ไม่มี action ไหน auto-confirm/auto-post (0.17/0.18) — ทุกจับคู่ต้องมาจาก client เรียกทีละคู่เท่านั้น
 *   ★ pure function ของ lib/accounting/bank-reconciliation.ts (parseBankStatementCsv ฯลฯ) ทดสอบครบแล้วที่
 *     tests/accounting/bank-reconciliation.test.ts — ไฟล์นี้ mock data layer ทั้งหมดเพื่อเน้นตรวจ guard/
 *     wiring ของ actions.ts ล้วน ๆ
 */

const { requireAccountingAccessMock } = vi.hoisted(() => ({
  requireAccountingAccessMock: vi.fn(),
}));

const {
  listCustomerBankAccountsMock,
  importBatchFromCsvMock,
  addManualStatementLineMock,
  deleteStatementLineMock,
  deleteBatchMock,
  confirmMatchMock,
  unmatchMock,
  listBookLinesMock,
  getBatchScopeMock,
  getStatementLineScopeMock,
} = vi.hoisted(() => ({
  listCustomerBankAccountsMock: vi.fn(),
  importBatchFromCsvMock: vi.fn(),
  addManualStatementLineMock: vi.fn(),
  deleteStatementLineMock: vi.fn(),
  deleteBatchMock: vi.fn(),
  confirmMatchMock: vi.fn(),
  unmatchMock: vi.fn(),
  listBookLinesMock: vi.fn(),
  getBatchScopeMock: vi.fn(),
  getStatementLineScopeMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ __authed: true })),
  createServiceRoleClient: vi.fn(() => ({}) as unknown),
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

vi.mock("@/lib/accounting/bank-accounts", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/bank-accounts")>();
  return { ...actual, listCustomerBankAccounts: (...args: unknown[]) => listCustomerBankAccountsMock(...args) };
});

vi.mock("@/lib/accounting/bank-reconciliation", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/bank-reconciliation")>();
  return {
    ...actual,
    importBatchFromCsv: (...args: unknown[]) => importBatchFromCsvMock(...args),
    addManualStatementLine: (...args: unknown[]) => addManualStatementLineMock(...args),
    deleteStatementLine: (...args: unknown[]) => deleteStatementLineMock(...args),
    deleteBatch: (...args: unknown[]) => deleteBatchMock(...args),
    confirmMatch: (...args: unknown[]) => confirmMatchMock(...args),
    unmatch: (...args: unknown[]) => unmatchMock(...args),
    listBookLines: (...args: unknown[]) => listBookLinesMock(...args),
    getBatchScope: (...args: unknown[]) => getBatchScopeMock(...args),
    getStatementLineScope: (...args: unknown[]) => getStatementLineScopeMock(...args),
  };
});

import {
  importCsvAction,
  addManualLineAction,
  deleteStatementLineAction,
  deleteBatchAction,
  confirmMatchAction,
  unmatchAction,
} from "@/app/chat-audit/accounting/bank-reconciliation/actions";

const TENANT = "tenant-1";
const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const BANK_ACCOUNT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const STATEMENT_LINE_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const BATCH_ID = "11111111-1111-1111-1111-111111111111";

const adminCtx = {
  tenantId: TENANT,
  mode: "admin" as const,
  employeeId: null,
  name: null,
  allowedCustomerIds: null,
  navRole: "admin" as const,
};

function accountantCtx(allowed: string[]) {
  return {
    tenantId: TENANT,
    mode: "accountant" as const,
    employeeId: "emp-1",
    name: "นักบัญชี",
    allowedCustomerIds: new Set(allowed),
    navRole: "accountant" as const,
  };
}

const BANK_ACCOUNT_FIXTURE = { id: BANK_ACCOUNT_ID, accountCode: "1020", bankName: "ธนาคารทดสอบ", accountNo: "111-1" };

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  listCustomerBankAccountsMock.mockResolvedValue([BANK_ACCOUNT_FIXTURE]);
});

// ---------------------------------------------------------------------
// importCsvAction
// ---------------------------------------------------------------------
describe("importCsvAction", () => {
  const csvText = "date,description,amount\n2026-01-05,รับโอน,1000.00";

  it("นำเข้าสำเร็จ (ลูกค้า+บัญชีในสโคป+ไฟล์ถูกต้อง)", async () => {
    importBatchFromCsvMock.mockResolvedValue({ ok: true, batchId: BATCH_ID, lineCount: 1 });
    const res = await importCsvAction({ customerId: CUSTOMER_ID, bankAccountId: BANK_ACCOUNT_ID, fileName: "a.csv", csvText });
    expect(res.ok).toBe(true);
    expect(importBatchFromCsvMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      CUSTOMER_ID,
      BANK_ACCOUNT_ID,
      "a.csv",
      expect.arrayContaining([expect.objectContaining({ date: "2026-01-05", amount: 1000 })])
    );
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ ไม่แตะ data layer", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await importCsvAction({ customerId: CUSTOMER_ID, bankAccountId: BANK_ACCOUNT_ID, csvText });
    expect(res.ok).toBe(false);
    expect(importBatchFromCsvMock).not.toHaveBeenCalled();
  });

  it("★ bankAccountId ไม่ใช่บัญชีเงินฝากของลูกค้ารายนี้จริง → ปฏิเสธ ไม่แตะ data layer", async () => {
    listCustomerBankAccountsMock.mockResolvedValue([]); // ลูกค้ารายนี้ไม่มีบัญชีเงินฝากเลย
    const res = await importCsvAction({ customerId: CUSTOMER_ID, bankAccountId: BANK_ACCOUNT_ID, csvText });
    expect(res.ok).toBe(false);
    expect(importBatchFromCsvMock).not.toHaveBeenCalled();
  });

  it("CSV มีบรรทัดผิดรูปแบบ → ปฏิเสธ ไม่เรียก importBatchFromCsv เลย", async () => {
    const badCsv = "2026-01-05,รับโอน,ไม่ใช่ตัวเลข";
    const res = await importCsvAction({ customerId: CUSTOMER_ID, bankAccountId: BANK_ACCOUNT_ID, csvText: badCsv });
    expect(res.ok).toBe(false);
    expect(importBatchFromCsvMock).not.toHaveBeenCalled();
  });

  it("customerId ไม่ใช่ uuid → ปฏิเสธทันที (ไม่เรียก requireAccountingAccess)", async () => {
    const res = await importCsvAction({ customerId: "not-a-uuid", bankAccountId: BANK_ACCOUNT_ID, csvText });
    expect(res.ok).toBe(false);
    expect(requireAccountingAccessMock).not.toHaveBeenCalled();
  });

  it("ไฟล์ว่างเปล่า → ปฏิเสธ ไม่แตะ data layer", async () => {
    const res = await importCsvAction({ customerId: CUSTOMER_ID, bankAccountId: BANK_ACCOUNT_ID, csvText: "   " });
    expect(res.ok).toBe(false);
    expect(importBatchFromCsvMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// addManualLineAction
// ---------------------------------------------------------------------
describe("addManualLineAction", () => {
  it("เพิ่มรายการสำเร็จ", async () => {
    addManualStatementLineMock.mockResolvedValue({ ok: true, id: STATEMENT_LINE_ID });
    const res = await addManualLineAction({
      customerId: CUSTOMER_ID,
      bankAccountId: BANK_ACCOUNT_ID,
      date: "2026-01-05",
      description: "รับโอน",
      amount: 500,
    });
    expect(res.ok).toBe(true);
    expect(addManualStatementLineMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      CUSTOMER_ID,
      BANK_ACCOUNT_ID,
      expect.objectContaining({ amount: 500 })
    );
  });

  it("★ ลูกค้านอกสโคป → ปฏิเสธ ไม่เรียก data layer", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await addManualLineAction({
      customerId: CUSTOMER_ID,
      bankAccountId: BANK_ACCOUNT_ID,
      date: "2026-01-05",
      amount: 500,
    });
    expect(res.ok).toBe(false);
    expect(addManualStatementLineMock).not.toHaveBeenCalled();
  });

  it("bankAccountId ไม่ใช่ของลูกค้ารายนี้ → ปฏิเสธ", async () => {
    listCustomerBankAccountsMock.mockResolvedValue([]);
    const res = await addManualLineAction({
      customerId: CUSTOMER_ID,
      bankAccountId: BANK_ACCOUNT_ID,
      date: "2026-01-05",
      amount: 500,
    });
    expect(res.ok).toBe(false);
    expect(addManualStatementLineMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// deleteStatementLineAction
// ---------------------------------------------------------------------
describe("deleteStatementLineAction", () => {
  it("ลบสำเร็จ (สโคปตรง)", async () => {
    getStatementLineScopeMock.mockResolvedValue({ customerId: CUSTOMER_ID, bankAccountId: BANK_ACCOUNT_ID });
    deleteStatementLineMock.mockResolvedValue({ ok: true });
    const res = await deleteStatementLineAction(STATEMENT_LINE_ID, CUSTOMER_ID);
    expect(res.ok).toBe(true);
    expect(deleteStatementLineMock).toHaveBeenCalledWith(expect.anything(), TENANT, STATEMENT_LINE_ID);
  });

  it("★ ไม่พบรายการ (ถูกลบไปแล้ว) → ปฏิเสธ ไม่เรียก data layer ลบซ้ำ", async () => {
    getStatementLineScopeMock.mockResolvedValue(null);
    const res = await deleteStatementLineAction(STATEMENT_LINE_ID, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(deleteStatementLineMock).not.toHaveBeenCalled();
  });

  it("★ customerId ที่ client ส่งมาไม่ตรงกับเจ้าของรายการจริง (สวมรอย) → ปฏิเสธ", async () => {
    getStatementLineScopeMock.mockResolvedValue({ customerId: CUSTOMER_OTHER, bankAccountId: BANK_ACCOUNT_ID });
    const res = await deleteStatementLineAction(STATEMENT_LINE_ID, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(deleteStatementLineMock).not.toHaveBeenCalled();
  });

  it("★ ลูกค้านอกสโคป → ปฏิเสธ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await deleteStatementLineAction(STATEMENT_LINE_ID, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(deleteStatementLineMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// deleteBatchAction — hard-delete cascade (T49)
// ---------------------------------------------------------------------
describe("deleteBatchAction", () => {
  it("ลบสำเร็จ (สโคปตรง)", async () => {
    getBatchScopeMock.mockResolvedValue({ customerId: CUSTOMER_ID, bankAccountId: BANK_ACCOUNT_ID });
    deleteBatchMock.mockResolvedValue({ ok: true });
    const res = await deleteBatchAction(BATCH_ID, CUSTOMER_ID);
    expect(res.ok).toBe(true);
    expect(deleteBatchMock).toHaveBeenCalledWith(expect.anything(), TENANT, BATCH_ID);
  });

  it("★ customerId ไม่ตรงกับเจ้าของ batch จริง → ปฏิเสธ ไม่ลบ", async () => {
    getBatchScopeMock.mockResolvedValue({ customerId: CUSTOMER_OTHER, bankAccountId: BANK_ACCOUNT_ID });
    const res = await deleteBatchAction(BATCH_ID, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(deleteBatchMock).not.toHaveBeenCalled();
  });

  it("★ ลูกค้านอกสโคป → ปฏิเสธ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await deleteBatchAction(BATCH_ID, CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(deleteBatchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// confirmMatchAction — ★ 0.15/0.17: re-compute bookLines สดฝั่ง server เสมอ ไม่เชื่อ client
// ---------------------------------------------------------------------
describe("confirmMatchAction", () => {
  const baseInput = {
    customerId: CUSTOMER_ID,
    bankAccountId: BANK_ACCOUNT_ID,
    statementLineId: STATEMENT_LINE_ID,
    bookLineKey: "e1:1020:debit:1000:0",
    month: "2026-01",
    includeDraft: true,
  };

  it("ยืนยันจับคู่สำเร็จ (bookLineKey ตรงกับที่ re-compute สดได้จริง)", async () => {
    getStatementLineScopeMock.mockResolvedValue({ customerId: CUSTOMER_ID, bankAccountId: BANK_ACCOUNT_ID });
    listBookLinesMock.mockResolvedValue([
      { key: "e1:1020:debit:1000:0", entryId: "e1", date: "2026-01-05", amount: 1000, accountCode: "1020", docNo: null, counterparty: null },
    ]);
    confirmMatchMock.mockResolvedValue({ ok: true });

    const res = await confirmMatchAction(baseInput);
    expect(res.ok).toBe(true);
    expect(confirmMatchMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      STATEMENT_LINE_ID,
      expect.objectContaining({ key: "e1:1020:debit:1000:0", entryId: "e1", amount: 1000 })
    );
  });

  it("★ bookLineKey ที่ client ส่งมาไม่พบใน bookLines ที่ re-compute สด (ข้อมูลเปลี่ยนไปแล้ว/ปลอมมา) → ปฏิเสธ ไม่เขียน snapshot", async () => {
    getStatementLineScopeMock.mockResolvedValue({ customerId: CUSTOMER_ID, bankAccountId: BANK_ACCOUNT_ID });
    listBookLinesMock.mockResolvedValue([
      { key: "e2:1020:debit:2000:0", entryId: "e2", date: "2026-01-05", amount: 2000, accountCode: "1020", docNo: null, counterparty: null },
    ]);

    const res = await confirmMatchAction(baseInput);
    expect(res.ok).toBe(false);
    expect(confirmMatchMock).not.toHaveBeenCalled();
  });

  it("★ statement line ไม่พบ (ถูกลบไปแล้ว) → ปฏิเสธ ไม่เรียก re-compute/confirm", async () => {
    getStatementLineScopeMock.mockResolvedValue(null);
    const res = await confirmMatchAction(baseInput);
    expect(res.ok).toBe(false);
    expect(listBookLinesMock).not.toHaveBeenCalled();
    expect(confirmMatchMock).not.toHaveBeenCalled();
  });

  it("★ statement line เป็นของลูกค้า/บัญชีอื่น (สวมรอย) → ปฏิเสธ", async () => {
    getStatementLineScopeMock.mockResolvedValue({ customerId: CUSTOMER_OTHER, bankAccountId: BANK_ACCOUNT_ID });
    const res = await confirmMatchAction(baseInput);
    expect(res.ok).toBe(false);
    expect(confirmMatchMock).not.toHaveBeenCalled();
  });

  it("★ ลูกค้านอกสโคปของนักบัญชี → ปฏิเสธ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await confirmMatchAction(baseInput);
    expect(res.ok).toBe(false);
    expect(confirmMatchMock).not.toHaveBeenCalled();
  });

  it("bankAccountId ไม่ใช่ของลูกค้ารายนี้จริง → ปฏิเสธ", async () => {
    listCustomerBankAccountsMock.mockResolvedValue([]);
    const res = await confirmMatchAction(baseInput);
    expect(res.ok).toBe(false);
    expect(confirmMatchMock).not.toHaveBeenCalled();
  });

  it("month ผิดรูปแบบ → ปฏิเสธทันที (ไม่แตะ DB เลย)", async () => {
    const res = await confirmMatchAction({ ...baseInput, month: "2026/01" });
    expect(res.ok).toBe(false);
    expect(requireAccountingAccessMock).not.toHaveBeenCalled();
  });

  it("bookLineKey ว่างเปล่า → ปฏิเสธทันที", async () => {
    const res = await confirmMatchAction({ ...baseInput, bookLineKey: "" });
    expect(res.ok).toBe(false);
    expect(requireAccountingAccessMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// unmatchAction
// ---------------------------------------------------------------------
describe("unmatchAction", () => {
  it("ยกเลิกจับคู่สำเร็จ", async () => {
    getStatementLineScopeMock.mockResolvedValue({ customerId: CUSTOMER_ID, bankAccountId: BANK_ACCOUNT_ID });
    unmatchMock.mockResolvedValue({ ok: true });
    const res = await unmatchAction(STATEMENT_LINE_ID, CUSTOMER_ID, BANK_ACCOUNT_ID);
    expect(res.ok).toBe(true);
    expect(unmatchMock).toHaveBeenCalledWith(expect.anything(), TENANT, STATEMENT_LINE_ID);
  });

  it("★ ลูกค้านอกสโคป → ปฏิเสธ ไม่แตะ data layer", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await unmatchAction(STATEMENT_LINE_ID, CUSTOMER_ID, BANK_ACCOUNT_ID);
    expect(res.ok).toBe(false);
    expect(unmatchMock).not.toHaveBeenCalled();
  });

  it("★ statement line เป็นของลูกค้า/บัญชีอื่น → ปฏิเสธ", async () => {
    getStatementLineScopeMock.mockResolvedValue({ customerId: CUSTOMER_OTHER, bankAccountId: BANK_ACCOUNT_ID });
    const res = await unmatchAction(STATEMENT_LINE_ID, CUSTOMER_ID, BANK_ACCOUNT_ID);
    expect(res.ok).toBe(false);
    expect(unmatchMock).not.toHaveBeenCalled();
  });

  it("statementLineId ไม่ใช่ uuid → ปฏิเสธทันที", async () => {
    const res = await unmatchAction("not-a-uuid", CUSTOMER_ID, BANK_ACCOUNT_ID);
    expect(res.ok).toBe(false);
    expect(requireAccountingAccessMock).not.toHaveBeenCalled();
  });
});
