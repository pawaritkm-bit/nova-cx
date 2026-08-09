import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type Capture, type Resolver } from "../helpers/fake-supabase";
import { TEST_CHART } from "./fixtures/chart";

/**
 * เทสต์ server actions ของหน้า "ลงบันทึกบัญชีเอง" (/chat-audit/accounting/journal-entry — เฟส 1 ส่วน C)
 *   mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern tests/accounting/customer-admin-actions.test.ts
 *   ★ เน้นเทสต์บังคับตาม DoD: debit ≠ credit ต้องบันทึกไม่ได้ (validation กันไม่สมดุล) + guard สโคปลูกค้า
 */

const { requireAccountingAccessMock } = vi.hoisted(() => ({
  requireAccountingAccessMock: vi.fn(),
}));

let currentDb: ReturnType<typeof makeFakeDb>["db"];
let currentCapture: Capture;

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ __authed: true })),
  createServiceRoleClient: vi.fn(() => currentDb),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/accounting/access", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/access")>();
  return {
    ...actual,
    requireAccountingAccess: (...args: unknown[]) => requireAccountingAccessMock(...args),
  };
});

import {
  saveManualEntryAction,
  confirmManualEntryAction,
  unconfirmManualEntryAction,
  deleteManualEntryAction,
} from "@/app/chat-audit/accounting/journal-entry/actions";

const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const ENTRY_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

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

/** ผังบัญชี (รูปที่ listChartOfAccounts อ่าน) — mirror TEST_CHART */
const CHART_ROWS = TEST_CHART.map((a) => ({
  code: a.code,
  name: a.name,
  category: a.category,
  is_bank: a.bank ?? false,
}));

function makeResolver(
  opts: {
    existingEntry?: { customer_id: string; status: string } | null;
    linesForConfirm?: { debit: number; credit: number }[];
  } = {}
): Resolver {
  return ({ table, op, terminal }) => {
    if (table === "chart_of_accounts") {
      return { data: CHART_ROWS, error: null };
    }
    if (table === "manual_journal_entries") {
      if (op === "select" && terminal === "maybeSingle") {
        return "existingEntry" in opts
          ? { data: opts.existingEntry, error: null }
          : { data: { customer_id: CUSTOMER_ID, status: "draft" }, error: null };
      }
      if (op === "insert" && terminal === "maybeSingle") {
        return { data: { id: "new-je-id" }, error: null };
      }
      return { data: null, error: null };
    }
    if (table === "manual_journal_entry_lines") {
      if (op === "select" && terminal === "await") {
        return { data: opts.linesForConfirm ?? [{ debit: 1000, credit: 0 }, { debit: 0, credit: 1000 }], error: null };
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };
}

function setupDb(opts: Parameters<typeof makeResolver>[0] = {}) {
  const { db, capture } = makeFakeDb(makeResolver(opts));
  currentDb = db;
  currentCapture = capture;
}

const balancedLines = [
  { accountCode: "5370", debit: 1000, credit: 0 },
  { accountCode: "1615.1", debit: 0, credit: 1000 },
];
const unbalancedLines = [
  { accountCode: "5370", debit: 1000, credit: 0 },
  { accountCode: "1615.1", debit: 0, credit: 900 },
];

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  setupDb();
});

describe("saveManualEntryAction", () => {
  it("สร้างใหม่ + สมดุล → บันทึกสำเร็จ (status=draft)", async () => {
    const res = await saveManualEntryAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      docDate: "2026-07-01",
      lines: balancedLines,
    });
    expect(res.ok).toBe(true);
    const headerIns = currentCapture.inserts.find((i) => i.table === "manual_journal_entries");
    expect(headerIns).toBeTruthy();
    expect((headerIns!.payload as Record<string, unknown>).status).toBe("draft");
    const linesIns = currentCapture.inserts.find((i) => i.table === "manual_journal_entry_lines");
    expect(linesIns).toBeTruthy();
  });

  it("★ เดบิต ≠ เครดิต (ไม่สมดุล) → บันทึกไม่สำเร็จ ไม่มี insert เกิดขึ้นเลย (เทสต์บังคับตาม DoD)", async () => {
    const res = await saveManualEntryAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      docDate: "2026-07-01",
      lines: unbalancedLines,
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts).toHaveLength(0);
  });

  it("รหัสบัญชีไม่อยู่ในผัง → บันทึกไม่สำเร็จ", async () => {
    const res = await saveManualEntryAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      docDate: "2026-07-01",
      lines: [
        { accountCode: "9999-ไม่มีจริง", debit: 1000, credit: 0 },
        { accountCode: "1615.1", debit: 0, credit: 1000 },
      ],
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts).toHaveLength(0);
  });

  it("ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ (ไม่แตะ DB)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await saveManualEntryAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      docDate: "2026-07-01",
      lines: balancedLines,
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts).toHaveLength(0);
  });

  it("confirm:true → บันทึกแล้วยืนยันทันที (มี update status=confirmed)", async () => {
    const res = await saveManualEntryAction({
      customerId: CUSTOMER_ID,
      docType: "JV",
      docDate: "2026-07-01",
      lines: balancedLines,
      confirm: true,
    });
    expect(res.ok).toBe(true);
    const confirmUpd = currentCapture.updates.find(
      (u) => u.table === "manual_journal_entries" && (u.payload as Record<string, unknown>).status === "confirmed"
    );
    expect(confirmUpd).toBeTruthy();
  });

  it("แก้ไขรายการเดิมที่ยืนยันแล้ว → ปฏิเสธ (ต้องยกเลิกการยืนยันก่อน)", async () => {
    setupDb({ existingEntry: { customer_id: CUSTOMER_ID, status: "confirmed" } });
    const res = await saveManualEntryAction({
      id: ENTRY_ID,
      customerId: CUSTOMER_ID,
      docType: "JV",
      docDate: "2026-07-01",
      lines: balancedLines,
    });
    expect(res.ok).toBe(false);
  });

  it("แก้ไขรายการเดิมที่เป็น draft → สำเร็จ (update header + แทนที่ lines)", async () => {
    setupDb({ existingEntry: { customer_id: CUSTOMER_ID, status: "draft" } });
    const res = await saveManualEntryAction({
      id: ENTRY_ID,
      customerId: CUSTOMER_ID,
      docType: "JV",
      docDate: "2026-07-01",
      lines: balancedLines,
    });
    expect(res.ok).toBe(true);
    expect(currentCapture.updates.some((u) => u.table === "manual_journal_entries")).toBe(true);
    expect(currentCapture.deletes?.some((d) => d.table === "manual_journal_entry_lines")).toBe(true);
  });

  it("ลูกค้าใน payload ไม่ตรงกับลูกค้าของรายการเดิม → ปฏิเสธ", async () => {
    setupDb({ existingEntry: { customer_id: CUSTOMER_OTHER, status: "draft" } });
    requireAccountingAccessMock.mockResolvedValue(adminCtx); // admin เห็นทุกลูกค้า แต่ยังต้องตรงกัน
    const res = await saveManualEntryAction({
      id: ENTRY_ID,
      customerId: CUSTOMER_ID,
      docType: "JV",
      docDate: "2026-07-01",
      lines: balancedLines,
    });
    expect(res.ok).toBe(false);
  });

  it("ไม่พบรายการเดิม (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ existingEntry: null });
    const res = await saveManualEntryAction({
      id: ENTRY_ID,
      customerId: CUSTOMER_ID,
      docType: "JV",
      docDate: "2026-07-01",
      lines: balancedLines,
    });
    expect(res.ok).toBe(false);
  });
});

describe("confirmManualEntryAction", () => {
  it("บรรทัดสมดุล → ยืนยันสำเร็จ", async () => {
    const res = await confirmManualEntryAction(ENTRY_ID, CUSTOMER_ID);
    expect(res.ok).toBe(true);
  });

  it("★ บรรทัดไม่สมดุล → ยืนยันไม่สำเร็จ", async () => {
    setupDb({ linesForConfirm: [{ debit: 1000, credit: 0 }, { debit: 0, credit: 900 }] });
    const res = await confirmManualEntryAction(ENTRY_ID, CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });

  it("ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await confirmManualEntryAction(ENTRY_ID, CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await confirmManualEntryAction("not-a-uuid", CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });
});

describe("unconfirmManualEntryAction", () => {
  it("ยกเลิกการยืนยันสำเร็จ (status → draft)", async () => {
    setupDb({ existingEntry: { customer_id: CUSTOMER_ID, status: "confirmed" } });
    const res = await unconfirmManualEntryAction(ENTRY_ID, CUSTOMER_ID);
    expect(res.ok).toBe(true);
    const upd = currentCapture.updates.find((u) => u.table === "manual_journal_entries");
    expect((upd!.payload as Record<string, unknown>).status).toBe("draft");
  });

  it("ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await unconfirmManualEntryAction(ENTRY_ID, CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });
});

describe("deleteManualEntryAction", () => {
  it("ลบสำเร็จ (soft-delete)", async () => {
    const res = await deleteManualEntryAction(ENTRY_ID, CUSTOMER_ID);
    expect(res.ok).toBe(true);
    const upd = currentCapture.updates.find((u) => u.table === "manual_journal_entries");
    expect((upd!.payload as Record<string, unknown>).deleted_at).toBeTruthy();
  });

  it("ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await deleteManualEntryAction(ENTRY_ID, CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });

  it("ไม่พบรายการ → ปฏิเสธ", async () => {
    setupDb({ existingEntry: null });
    const res = await deleteManualEntryAction(ENTRY_ID, CUSTOMER_ID);
    expect(res.ok).toBe(false);
  });
});
