import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeInMemoryDb, type Tables } from "../helpers/fake-payroll-db";

/**
 * เทสต์ server actions ของหน้า "สรุปการยื่นรายเดือน" (/chat-audit/accounting/payroll/filing — เฟส 9b
 *   กลุ่ม BC) — mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern เดียวกับ
 *   tests/accounting/payroll-employees-actions.test.ts (fake DB stateful in-memory + uuid จริง เพราะ
 *   actions.ts เช็ค isUuid(id) ก่อนแตะ DB เสมอ)
 *
 * ★ พบโดย reviewer QC (เฟส 9b กลุ่ม BC) — ไฟล์นี้ไม่มีเทสต์ IDOR มาก่อน (มีแต่เทสต์ตัวฟังก์ชัน data layer
 *   ใน payroll-monthly-filing.test.ts) — เน้นเทสต์บังคับตาม DoD 0.15: ลูกค้านอกสโคป → ปฏิเสธ,
 *   filingPeriodId ของลูกค้า B แต่ส่ง customerId ของลูกค้า A → ปฏิเสธ (scope derive จาก resource id จริง
 *   ไม่เชื่อ customerId ที่ client ส่งมาลำพัง)
 */

const { requireAccountingAccessMock } = vi.hoisted(() => ({
  requireAccountingAccessMock: vi.fn(),
}));

let currentDb: SupabaseClient;
let tables: Tables;

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

import { markFilingAction, unmarkFilingAction } from "@/app/chat-audit/accounting/payroll/filing/actions";

const TENANT = "tenant-1";
const CUSTOMER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CUSTOMER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
// หน่วยยื่นรายเดือนของลูกค้า A — มีรอบ finalized ผูกอยู่แล้ว (mark ได้)
const FILING_A_READY = "11111111-1111-1111-1111-111111111111";
// หน่วยยื่นรายเดือนของลูกค้า A — ไม่มีรอบ finalized เลย (mark ไม่ได้)
const FILING_A_DRAFT_ONLY = "22222222-2222-2222-2222-222222222222";
// หน่วยยื่นรายเดือนของลูกค้า B
const FILING_B_READY = "33333333-3333-3333-3333-333333333333";
const RUN_A_FINALIZED = "44444444-4444-4444-4444-444444444444";
const RUN_A_DRAFT = "55555555-5555-5555-5555-555555555555";
const RUN_B_FINALIZED = "66666666-6666-6666-6666-666666666666";

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

function setupTables(): Tables {
  return {
    payroll_monthly_filings: [
      {
        id: FILING_A_READY,
        tenant_id: TENANT,
        customer_id: CUSTOMER_A,
        period_year: 2569,
        period_month: 8,
        pit_filing_status: "not_filed",
        pit_filed_at: null,
        pit_filed_by: null,
        sso_filing_status: "not_filed",
        sso_filed_at: null,
        sso_filed_by: null,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      },
      {
        id: FILING_A_DRAFT_ONLY,
        tenant_id: TENANT,
        customer_id: CUSTOMER_A,
        period_year: 2569,
        period_month: 7,
        pit_filing_status: "not_filed",
        pit_filed_at: null,
        pit_filed_by: null,
        sso_filing_status: "not_filed",
        sso_filed_at: null,
        sso_filed_by: null,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
      {
        id: FILING_B_READY,
        tenant_id: TENANT,
        customer_id: CUSTOMER_B,
        period_year: 2569,
        period_month: 8,
        pit_filing_status: "not_filed",
        pit_filed_at: null,
        pit_filed_by: null,
        sso_filing_status: "not_filed",
        sso_filed_at: null,
        sso_filed_by: null,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      },
    ],
    payroll_runs: [
      {
        id: RUN_A_FINALIZED,
        tenant_id: TENANT,
        customer_id: CUSTOMER_A,
        pay_period_year: 2569,
        pay_period_month: 8,
        pay_date: "2026-08-10",
        status: "finalized",
        manual_entry_id: "je-1",
        filing_period_id: FILING_A_READY,
        deleted_at: null,
        created_at: "2026-08-10T00:00:00Z",
        updated_at: "2026-08-10T00:00:00Z",
      },
      {
        id: RUN_A_DRAFT,
        tenant_id: TENANT,
        customer_id: CUSTOMER_A,
        pay_period_year: 2569,
        pay_period_month: 7,
        pay_date: "2026-07-10",
        status: "draft",
        manual_entry_id: null,
        filing_period_id: FILING_A_DRAFT_ONLY,
        deleted_at: null,
        created_at: "2026-07-10T00:00:00Z",
        updated_at: "2026-07-10T00:00:00Z",
      },
      {
        id: RUN_B_FINALIZED,
        tenant_id: TENANT,
        customer_id: CUSTOMER_B,
        pay_period_year: 2569,
        pay_period_month: 8,
        pay_date: "2026-08-10",
        status: "finalized",
        manual_entry_id: "je-2",
        filing_period_id: FILING_B_READY,
        deleted_at: null,
        created_at: "2026-08-10T00:00:00Z",
        updated_at: "2026-08-10T00:00:00Z",
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  tables = setupTables();
  currentDb = makeInMemoryDb(tables).db;
});

describe("markFilingAction (เฟส 9b กลุ่ม BC)", () => {
  it("หน่วยยื่นมีรอบ finalized ผูกอยู่แล้ว → mark ภ.ง.ด.1 สำเร็จ", async () => {
    const res = await markFilingAction(FILING_A_READY, CUSTOMER_A, "pit");
    expect(res.ok).toBe(true);
    const filing = tables.payroll_monthly_filings.find((f) => f.id === FILING_A_READY)!;
    expect(filing.pit_filing_status).toBe("filed");
    expect(filing.pit_filed_at).toBeTruthy();
  });

  it("หน่วยยื่นยังไม่มีรอบ finalized เลย → ปฏิเสธ", async () => {
    const res = await markFilingAction(FILING_A_DRAFT_ONLY, CUSTOMER_A, "pit");
    expect(res.ok).toBe(false);
    const filing = tables.payroll_monthly_filings.find((f) => f.id === FILING_A_DRAFT_ONLY)!;
    expect(filing.pit_filing_status).toBe("not_filed");
  });

  it("★ ลูกค้านอกสโคปของนักบัญชี → ปฏิเสธ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await markFilingAction(FILING_A_READY, CUSTOMER_A, "pit");
    expect(res.ok).toBe(false);
    const filing = tables.payroll_monthly_filings.find((f) => f.id === FILING_A_READY)!;
    expect(filing.pit_filing_status).toBe("not_filed");
  });

  it("★★★ IDOR — filingPeriodId จริงเป็นของลูกค้า B แต่ส่ง customerId ปลอมเป็นลูกค้า A (อยู่ในสโคปนักบัญชี) → ปฏิเสธ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_A]));
    const res = await markFilingAction(FILING_B_READY, CUSTOMER_A, "pit");
    expect(res.ok).toBe(false);
    const filing = tables.payroll_monthly_filings.find((f) => f.id === FILING_B_READY)!;
    expect(filing.pit_filing_status).toBe("not_filed");
  });

  it("★★★ IDOR — filingPeriodId ของลูกค้า A แต่ส่ง customerId ของลูกค้า B (นักบัญชีอยู่ในสโคปทั้งคู่) → ปฏิเสธ (customerId ไม่ตรงกับหน่วยยื่นจริง)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_A, CUSTOMER_B]));
    const res = await markFilingAction(FILING_A_READY, CUSTOMER_B, "pit");
    expect(res.ok).toBe(false);
    const filing = tables.payroll_monthly_filings.find((f) => f.id === FILING_A_READY)!;
    expect(filing.pit_filing_status).toBe("not_filed");
  });

  it("ไม่พบหน่วยยื่น (id ไม่มีจริง) → ปฏิเสธ", async () => {
    const res = await markFilingAction("77777777-7777-7777-7777-777777777777", CUSTOMER_A, "pit");
    expect(res.ok).toBe(false);
  });

  it("filingPeriodId/customerId ไม่ใช่ uuid → ปฏิเสธทันที ไม่แตะ DB", async () => {
    const res = await markFilingAction("not-a-uuid", CUSTOMER_A, "pit");
    expect(res.ok).toBe(false);
  });

  it("mark สปส.1-10 สำเร็จ (แยกจาก pit)", async () => {
    const res = await markFilingAction(FILING_A_READY, CUSTOMER_A, "sso");
    expect(res.ok).toBe(true);
    const filing = tables.payroll_monthly_filings.find((f) => f.id === FILING_A_READY)!;
    expect(filing.sso_filing_status).toBe("filed");
    // ★ ไม่กระทบสถานะ pit ที่ยังไม่ได้ mark
    expect(filing.pit_filing_status).toBe("not_filed");
  });
});

describe("unmarkFilingAction (undo)", () => {
  it("mark แล้ว unmark กลับเป็นยังไม่ยื่นได้", async () => {
    await markFilingAction(FILING_A_READY, CUSTOMER_A, "pit");
    const res = await unmarkFilingAction(FILING_A_READY, CUSTOMER_A, "pit");
    expect(res.ok).toBe(true);
    const filing = tables.payroll_monthly_filings.find((f) => f.id === FILING_A_READY)!;
    expect(filing.pit_filing_status).toBe("not_filed");
    expect(filing.pit_filed_at).toBeNull();
  });

  it("★ ลูกค้านอกสโคป → ปฏิเสธ unmark", async () => {
    await markFilingAction(FILING_A_READY, CUSTOMER_A, "pit");
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await unmarkFilingAction(FILING_A_READY, CUSTOMER_A, "pit");
    expect(res.ok).toBe(false);
    const filing = tables.payroll_monthly_filings.find((f) => f.id === FILING_A_READY)!;
    expect(filing.pit_filing_status).toBe("filed");
  });

  it("★★★ IDOR — filingPeriodId ของลูกค้า B แต่ส่ง customerId ของลูกค้า A → ปฏิเสธ unmark", async () => {
    await markFilingAction(FILING_B_READY, CUSTOMER_B, "pit");
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_A, CUSTOMER_B]));
    const res = await unmarkFilingAction(FILING_B_READY, CUSTOMER_A, "pit");
    expect(res.ok).toBe(false);
    const filing = tables.payroll_monthly_filings.find((f) => f.id === FILING_B_READY)!;
    expect(filing.pit_filing_status).toBe("filed");
  });
});
