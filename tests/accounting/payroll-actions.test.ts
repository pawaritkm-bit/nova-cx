import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeInMemoryDb, type Tables } from "../helpers/fake-payroll-db";
import { TEST_CHART } from "./fixtures/chart";

/**
 * เทสต์ server actions ของหน้า "รอบเงินเดือน" (/chat-audit/accounting/payroll — เฟส 9 ส่วน AD/AE)
 *   mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern
 *   tests/accounting/recurring-journal-actions.test.ts (fake DB stateful in-memory + uuid จริง)
 *
 * ★ 0.15 เน้นเทสต์บังคับตาม DoD: guard สโคปครบทุก action, ล็อกแก้บรรทัด/คำนวณซ้ำหลังสร้าง JE,
 *   markFiledAction/unmarkFiledAction เฉพาะรอบที่ status='finalized'
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

import {
  createRunAction,
  recalcRunAction,
  generateJournalEntryAction,
  deleteRunAction,
  markFiledAction,
  unmarkFiledAction,
} from "@/app/chat-audit/accounting/payroll/actions";

const TENANT = "tenant-1";
const CUSTOMER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CUSTOMER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RUN_DRAFT = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const RUN_FINALIZED = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const LINE_1 = "11111111-1111-1111-1111-111111111111";
const EMP_1 = "22222222-2222-2222-2222-222222222222";
// ★ เฟส 9b กลุ่ม BC — หน่วยยื่นรายเดือน (payroll_monthly_filings) ที่ RUN_DRAFT/RUN_FINALIZED ผูกอยู่
const FILING_DRAFT = "33333333-3333-3333-3333-333333333333";
const FILING_FINALIZED = "44444444-4444-4444-4444-444444444444";

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
    employeeId: "emp-acc-1",
    name: "นักบัญชี",
    allowedCustomerIds: new Set(allowed),
    navRole: "accountant" as const,
  };
}

const PAYROLL_CHART = [
  ...TEST_CHART,
  { code: "2050", name: "เงินสมทบประกันสังคมค้างนำส่ง", category: "หนี้สิน" },
  { code: "5311", name: "เงินสมทบประกันสังคม (ส่วนนายจ้าง)", category: "ค่าใช้จ่าย" },
];

function setupTables(): Tables {
  return {
    payroll_runs: [
      {
        id: RUN_DRAFT,
        tenant_id: TENANT,
        customer_id: CUSTOMER_A,
        pay_period_year: 2569,
        pay_period_month: 8,
        pay_date: "2026-08-10",
        status: "draft",
        manual_entry_id: null,
        pit_filing_status: "not_filed",
        pit_filed_at: null,
        pit_filed_by: null,
        sso_filing_status: "not_filed",
        sso_filed_at: null,
        sso_filed_by: null,
        filing_period_id: FILING_DRAFT,
        deleted_at: null,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      },
      {
        id: RUN_FINALIZED,
        tenant_id: TENANT,
        customer_id: CUSTOMER_A,
        pay_period_year: 2569,
        pay_period_month: 7,
        pay_date: "2026-07-10",
        status: "finalized",
        manual_entry_id: "je-1",
        pit_filing_status: "not_filed",
        pit_filed_at: null,
        pit_filed_by: null,
        sso_filing_status: "not_filed",
        sso_filed_at: null,
        sso_filed_by: null,
        filing_period_id: FILING_FINALIZED,
        deleted_at: null,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
    ],
    // ★ เฟส 9b กลุ่ม BC — หน่วยยื่นรายเดือนตัวจริง (สถานะยื่นย้ายมาอยู่ที่นี่แล้ว, ไม่ใช่บน payroll_runs ตรง ๆ)
    payroll_monthly_filings: [
      {
        id: FILING_DRAFT,
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
        id: FILING_FINALIZED,
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
    ],
    payroll_run_lines: [
      {
        id: LINE_1,
        tenant_id: TENANT,
        run_id: RUN_DRAFT,
        payroll_employee_id: EMP_1,
        gross_salary: 20000,
        other_additions: 0,
        bonus_amount: 0,
        other_deductions: 0,
        pit_withheld: 0,
        sso_employee: 0,
        sso_employer: 0,
        // ★ net_pay ต้องสอดคล้องกับ gross-pit-sso-otherDed จริง (20000-0-0-0=20000) — เหมือนผลลัพธ์ที่
        //   recalcRunAction จะคำนวณให้จริง (ที่นี่ตั้งไว้ตรง ๆ ข้ามการเรียก recalc เพื่อเทสต์ generateJournalEntryAction แยกจาก recalc)
        net_pay: 20000,
        created_at: "2026-08-01T00:00:00Z",
      },
    ],
    payroll_employees: [
      {
        id: EMP_1,
        tenant_id: TENANT,
        customer_id: CUSTOMER_A,
        employee_code: "E1",
        full_name: "สมชาย ใจดี",
        id_card_no: "1234567890123",
        passport_no: null,
        position: null,
        base_salary: 20000,
        start_date: null,
        resign_date: null,
        is_active: true,
        deleted_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    payroll_settings: [
      {
        id: "settings-1",
        tenant_id: TENANT,
        customer_id: CUSTOMER_A,
        salary_expense_account_code: "5310",
        sso_employer_expense_account_code: "5311",
        sso_payable_account_code: "2050",
        pit_payable_account_code: "2910",
        other_deductions_account_code: null,
        net_pay_account_code: "2040",
        net_pay_is_paid_immediately: false,
        pay_frequency: "monthly",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    pit_tax_brackets: [
      { id: "b1", effective_from: "2017-01-01", bracket_order: 1, income_from: 0, income_to: 150000, rate_percent: 0 },
      { id: "b2", effective_from: "2017-01-01", bracket_order: 2, income_from: 150001, income_to: 300000, rate_percent: 5 },
    ],
    sso_contribution_config: [
      { id: "s1", effective_from: "1997-01-01", employee_rate_percent: 5, employer_rate_percent: 5, wage_floor: 1650, wage_ceiling: 15000 },
      { id: "s2", effective_from: "2026-01-01", employee_rate_percent: 5, employer_rate_percent: 5, wage_floor: 1650, wage_ceiling: 17500 },
    ],
    manual_journal_entries: [],
    manual_journal_entry_lines: [],
    chart_of_accounts: PAYROLL_CHART.map((a, i) => ({
      code: a.code,
      name: a.name,
      category: a.category,
      is_bank: false,
      is_active: true,
      deleted_at: null,
      sort_order: i,
      tenant_id: TENANT,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  tables = setupTables();
  currentDb = makeInMemoryDb(tables).db;
});

describe("createRunAction", () => {
  it("สร้างรอบใหม่สำเร็จ (admin)", async () => {
    const res = await createRunAction(CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 9, payDate: "2026-09-10" });
    expect(res.ok).toBe(true);
    expect(tables.payroll_runs).toHaveLength(3);
  });

  it("★ ลูกค้านอกสโคป → ปฏิเสธ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const before = tables.payroll_runs.length;
    const res = await createRunAction(CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 9, payDate: "2026-09-10" });
    expect(res.ok).toBe(false);
    expect(tables.payroll_runs).toHaveLength(before);
  });

  it("customerId ไม่ใช่ uuid → ปฏิเสธทันที", async () => {
    const res = await createRunAction("not-a-uuid", { payPeriodYear: 2569, payPeriodMonth: 9, payDate: "2026-09-10" });
    expect(res.ok).toBe(false);
  });
});

describe("recalcRunAction", () => {
  it("คำนวณสำเร็จ (รอบยัง draft)", async () => {
    const res = await recalcRunAction(RUN_DRAFT, CUSTOMER_A, []);
    expect(res.ok).toBe(true);
    const line = tables.payroll_run_lines.find((l) => l.id === LINE_1)!;
    expect(Number(line.net_pay)).toBeGreaterThan(0);
  });

  it("★ ลูกค้านอกสโคป → ปฏิเสธ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await recalcRunAction(RUN_DRAFT, CUSTOMER_A, []);
    expect(res.ok).toBe(false);
  });

  it("★★★ IDOR — ส่ง customerId ปลอมที่อยู่ในสโคป แต่รอบจริงเป็นของลูกค้าอื่น → ปฏิเสธ (scope derive จาก run id จริง)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await recalcRunAction(RUN_DRAFT, CUSTOMER_B, []); // รอบจริงเป็นของ CUSTOMER_A
    expect(res.ok).toBe(false);
  });

  it("★ รอบ finalized แล้ว → ปฏิเสธ (ล็อกแก้ไข/คำนวณซ้ำ)", async () => {
    const res = await recalcRunAction(RUN_FINALIZED, CUSTOMER_A, []);
    expect(res.ok).toBe(false);
  });

  it("รอบไม่มีอยู่จริง → ปฏิเสธ", async () => {
    const res = await recalcRunAction("99999999-9999-9999-9999-999999999999", CUSTOMER_A, []);
    expect(res.ok).toBe(false);
  });
});

describe("generateJournalEntryAction (0.7/0.9)", () => {
  it("สร้าง JE สำเร็จ — draft เสมอ, รอบเปลี่ยนเป็น finalized", async () => {
    const res = await generateJournalEntryAction(RUN_DRAFT, CUSTOMER_A);
    expect(res.ok).toBe(true);
    expect(tables.manual_journal_entries).toHaveLength(1);
    expect(tables.manual_journal_entries[0].status).toBe("draft");
    const run = tables.payroll_runs.find((r) => r.id === RUN_DRAFT)!;
    expect(run.status).toBe("finalized");
  });

  it("★ ลูกค้านอกสโคป → ปฏิเสธ ไม่สร้าง JE", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await generateJournalEntryAction(RUN_DRAFT, CUSTOMER_A);
    expect(res.ok).toBe(false);
    expect(tables.manual_journal_entries).toHaveLength(0);
  });

  it("กดซ้ำที่รอบที่สร้าง JE ไปแล้ว → ปฏิเสธ พร้อม existingManualEntryId", async () => {
    const res = await generateJournalEntryAction(RUN_FINALIZED, CUSTOMER_A);
    expect(res.ok).toBe(false);
    expect(res.existingManualEntryId).toBe("je-1");
  });

  it("★★★ กดสองแท็บพร้อมกัน (Promise.all) → สร้างได้แค่ครั้งเดียว", async () => {
    const [r1, r2] = await Promise.all([
      generateJournalEntryAction(RUN_DRAFT, CUSTOMER_A),
      generateJournalEntryAction(RUN_DRAFT, CUSTOMER_A),
    ]);
    const successes = [r1, r2].filter((r) => r.ok);
    expect(successes).toHaveLength(1);
    expect(tables.manual_journal_entries).toHaveLength(1);
  });
});

describe("deleteRunAction (0.14)", () => {
  it("ลบรอบ draft สำเร็จ", async () => {
    const res = await deleteRunAction(RUN_DRAFT, CUSTOMER_A);
    expect(res.ok).toBe(true);
    expect(tables.payroll_runs.find((r) => r.id === RUN_DRAFT)!.deleted_at).toBeTruthy();
  });

  it("รอบ finalized แล้ว → ลบไม่ได้", async () => {
    const res = await deleteRunAction(RUN_FINALIZED, CUSTOMER_A);
    expect(res.ok).toBe(false);
  });

  it("★ ลูกค้านอกสโคป → ปฏิเสธ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await deleteRunAction(RUN_DRAFT, CUSTOMER_A);
    expect(res.ok).toBe(false);
  });
});

describe("markFiledAction/unmarkFiledAction (T116, 0.3)", () => {
  it("รอบยัง draft (ไม่มี JE) → mark ปฏิเสธ", async () => {
    const res = await markFiledAction(RUN_DRAFT, CUSTOMER_A, "pit");
    expect(res.ok).toBe(false);
  });

  it("รอบ finalized → mark ภ.ง.ด.1 สำเร็จ (สถานะจริงย้ายไป payroll_monthly_filings แล้ว, เฟส 9b กลุ่ม BC)", async () => {
    const res = await markFiledAction(RUN_FINALIZED, CUSTOMER_A, "pit");
    expect(res.ok).toBe(true);
    const filing = tables.payroll_monthly_filings.find((f) => f.id === FILING_FINALIZED)!;
    expect(filing.pit_filing_status).toBe("filed");
    expect(filing.pit_filed_at).toBeTruthy();
  });

  it("mark สปส.1-10 สำเร็จ แล้ว unmark กลับเป็นยังไม่ยื่นได้", async () => {
    await markFiledAction(RUN_FINALIZED, CUSTOMER_A, "sso");
    const res = await unmarkFiledAction(RUN_FINALIZED, CUSTOMER_A, "sso");
    expect(res.ok).toBe(true);
    const filing = tables.payroll_monthly_filings.find((f) => f.id === FILING_FINALIZED)!;
    expect(filing.sso_filing_status).toBe("not_filed");
  });

  it("★ ลูกค้านอกสโคป → ปฏิเสธ mark/unmark", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const markRes = await markFiledAction(RUN_FINALIZED, CUSTOMER_A, "pit");
    expect(markRes.ok).toBe(false);
    const unmarkRes = await unmarkFiledAction(RUN_FINALIZED, CUSTOMER_A, "pit");
    expect(unmarkRes.ok).toBe(false);
  });
});
