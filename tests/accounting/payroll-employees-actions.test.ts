import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeInMemoryDb, type Tables } from "../helpers/fake-payroll-db";
import { TEST_CHART } from "./fixtures/chart";

/**
 * เทสต์ server actions ของหน้า "ทะเบียนพนักงาน/ตั้งค่าเงินเดือน" (/chat-audit/accounting/payroll-employees
 *   — เฟส 9 ส่วน AC) — mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern
 *   tests/accounting/recurring-journal-actions.test.ts (fake DB stateful in-memory + uuid จริง เพราะ
 *   actions.ts เช็ค isUuid(id) ก่อนแตะ DB เสมอ)
 *
 * ★ 0.15 เน้นเทสต์บังคับตาม DoD: guard สโคปครบทุก action (นักบัญชีนอกสโคปทำรายการของลูกค้าอื่นไม่ได้)
 * ★ 0.12 PDPA: revealIdCardAction คืนเลขบัตรเต็มเฉพาะเมื่ออยู่ในสโคปเท่านั้น
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
  upsertEmployeeAction,
  deleteEmployeeAction,
  revealIdCardAction,
  upsertSettingsAction,
  listDeductionsAction,
  upsertDeductionAction,
  deleteDeductionAction,
} from "@/app/chat-audit/accounting/payroll-employees/actions";

const CUSTOMER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CUSTOMER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const EMPLOYEE_A = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
/** ★ พนักงานอีกคนของลูกค้า B — ใช้ทดสอบ IDOR ของ action ค่าลดหย่อน (listDeductionsAction/
 *   upsertDeductionAction/deleteDeductionAction) */
const EMPLOYEE_B = "ffffffff-ffff-ffff-ffff-ffffffffffff";

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

function setupTables(): Tables {
  return {
    payroll_employees: [
      {
        id: EMPLOYEE_A,
        tenant_id: "tenant-1",
        customer_id: CUSTOMER_A,
        employee_code: "E1",
        full_name: "สมชาย ใจดี",
        id_card_no: "1234567890123",
        passport_no: null,
        position: "เซลส์",
        base_salary: 25000,
        start_date: null,
        resign_date: null,
        is_active: true,
        deleted_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        id: EMPLOYEE_B,
        tenant_id: "tenant-1",
        customer_id: CUSTOMER_B,
        employee_code: "E3",
        full_name: "สมศรี มั่งมี",
        id_card_no: "1112223334445",
        passport_no: null,
        position: "บัญชี",
        base_salary: 22000,
        start_date: null,
        resign_date: null,
        is_active: true,
        deleted_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    payroll_settings: [],
    payroll_employee_deductions: [],
    chart_of_accounts: [
      ...TEST_CHART,
      { code: "2050", name: "เงินสมทบประกันสังคมค้างนำส่ง", category: "หนี้สิน" },
      { code: "5311", name: "เงินสมทบประกันสังคม (ส่วนนายจ้าง)", category: "ค่าใช้จ่าย" },
    ].map((a, i) => ({
      code: a.code,
      name: a.name,
      category: a.category,
      is_bank: false,
      is_active: true,
      deleted_at: null,
      sort_order: i,
      tenant_id: "tenant-1",
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  tables = setupTables();
  currentDb = makeInMemoryDb(tables).db;
});

describe("upsertEmployeeAction", () => {
  it("สร้างพนักงานใหม่สำเร็จ (admin)", async () => {
    const before = tables.payroll_employees.length;
    const res = await upsertEmployeeAction({
      customerId: CUSTOMER_A,
      employeeCode: "E2",
      fullName: "สมหญิง รักงาน",
      idCardNo: "9876543210987",
      passportNo: null,
      position: null,
      baseSalary: 18000,
      startDate: null,
      resignDate: null,
      isActive: true,
    });
    expect(res.ok).toBe(true);
    expect(tables.payroll_employees).toHaveLength(before + 1);
  });

  it("★ ลูกค้านอกสโคปของนักบัญชี → ปฏิเสธ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const before = tables.payroll_employees.length;
    const res = await upsertEmployeeAction({
      customerId: CUSTOMER_A,
      employeeCode: "E2",
      fullName: "สมหญิง รักงาน",
      idCardNo: "9876543210987",
      passportNo: null,
      position: null,
      baseSalary: 18000,
      startDate: null,
      resignDate: null,
      isActive: true,
    });
    expect(res.ok).toBe(false);
    expect(tables.payroll_employees).toHaveLength(before);
  });

  it("★★★ IDOR — แก้พนักงานจริง (EMPLOYEE_A อยู่ CUSTOMER_A) แต่ส่ง customerId ปลอมเป็นลูกค้าที่อยู่ในสโคป → ปฏิเสธ (scope derive จาก employee id จริง)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await upsertEmployeeAction({
      id: EMPLOYEE_A,
      customerId: CUSTOMER_B, // ปลอม — พนักงานจริงเป็นของ CUSTOMER_A
      employeeCode: "E1",
      fullName: "แก้ชื่อ",
      idCardNo: "",
      passportNo: "",
      position: null,
      baseSalary: 25000,
      startDate: null,
      resignDate: null,
      isActive: true,
    });
    expect(res.ok).toBe(false);
    expect(tables.payroll_employees.find((e) => e.id === EMPLOYEE_A)!.full_name).toBe("สมชาย ใจดี");
  });

  it("แก้ไขพนักงาน ปล่อยเลขบัตรว่าง → คงเลขบัตรเดิมไว้ (0.12)", async () => {
    const res = await upsertEmployeeAction({
      id: EMPLOYEE_A,
      customerId: CUSTOMER_A,
      employeeCode: "E1",
      fullName: "สมชาย ใจดี (แก้ตำแหน่ง)",
      idCardNo: "",
      passportNo: "",
      position: "ผู้จัดการ",
      baseSalary: 30000,
      startDate: null,
      resignDate: null,
      isActive: true,
    });
    expect(res.ok).toBe(true);
    const row = tables.payroll_employees.find((e) => e.id === EMPLOYEE_A)!;
    expect(row.id_card_no).toBe("1234567890123");
    expect(row.position).toBe("ผู้จัดการ");
  });

  it("customerId ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await upsertEmployeeAction({
      customerId: "not-a-uuid",
      employeeCode: "E2",
      fullName: "x",
      idCardNo: "9876543210987",
      passportNo: null,
      position: null,
      baseSalary: 1000,
      startDate: null,
      resignDate: null,
      isActive: true,
    });
    expect(res.ok).toBe(false);
  });

  // ★★★ เฟส 9b กลุ่ม BA/BD — ssoExempt/priorEmployerYtd* ไหลผ่าน action ลง data layer ถูกต้อง
  it("★ BA/BD: บันทึก ssoExempt + priorEmployerYtd* ผ่าน action สำเร็จ", async () => {
    const res = await upsertEmployeeAction({
      customerId: CUSTOMER_A,
      employeeCode: "E2",
      fullName: "สมหญิง รักงาน",
      idCardNo: "9876543210987",
      passportNo: null,
      position: null,
      baseSalary: 18000,
      startDate: null,
      resignDate: null,
      isActive: true,
      ssoExempt: true,
      priorEmployerYtdGross: 100000,
      priorEmployerYtdPitWithheld: 3000,
      priorEmployerNote: "นายจ้างเดิม",
    });
    expect(res.ok).toBe(true);
    const row = tables.payroll_employees.find((e) => e.employee_code === "E2")!;
    expect(row.sso_exempt).toBe(true);
    expect(row.prior_employer_ytd_gross).toBe(100000);
    expect(row.prior_employer_ytd_pit_withheld).toBe(3000);
    expect(row.prior_employer_note).toBe("นายจ้างเดิม");
  });
});

describe("deleteEmployeeAction", () => {
  it("ลบสำเร็จ (soft-delete)", async () => {
    const res = await deleteEmployeeAction(EMPLOYEE_A, CUSTOMER_A);
    expect(res.ok).toBe(true);
    expect(tables.payroll_employees.find((e) => e.id === EMPLOYEE_A)!.deleted_at).toBeTruthy();
  });

  it("★ ลูกค้านอกสโคป → ปฏิเสธ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await deleteEmployeeAction(EMPLOYEE_A, CUSTOMER_A);
    expect(res.ok).toBe(false);
    expect(tables.payroll_employees.find((e) => e.id === EMPLOYEE_A)!.deleted_at ?? null).toBeNull();
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที", async () => {
    const res = await deleteEmployeeAction("not-a-uuid", CUSTOMER_A);
    expect(res.ok).toBe(false);
  });
});

describe("revealIdCardAction (0.12 PDPA)", () => {
  it("อยู่ในสโคป → คืนเลขบัตรเต็ม", async () => {
    const res = await revealIdCardAction(EMPLOYEE_A, CUSTOMER_A);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.idCardNo).toBe("1234567890123");
  });

  it("★ นอกสโคป → ปฏิเสธ ไม่คืนเลขบัตร", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await revealIdCardAction(EMPLOYEE_A, CUSTOMER_A);
    expect(res.ok).toBe(false);
  });

  it("customerId ที่ส่งมาไม่ตรงกับพนักงานจริง → ปฏิเสธ", async () => {
    const res = await revealIdCardAction(EMPLOYEE_A, CUSTOMER_B);
    expect(res.ok).toBe(false);
  });
});

describe("upsertSettingsAction (0.11)", () => {
  it("บันทึกตั้งค่าบัญชีสำเร็จ", async () => {
    const res = await upsertSettingsAction({
      customerId: CUSTOMER_A,
      salaryExpenseAccountCode: "5310",
      ssoEmployerExpenseAccountCode: "5311",
      ssoPayableAccountCode: "2050",
      pitPayableAccountCode: "2910",
      otherDeductionsAccountCode: null,
      netPayAccountCode: null,
      netPayIsPaidImmediately: false,
    });
    expect(res.ok).toBe(true);
    expect(tables.payroll_settings).toHaveLength(1);
  });

  it("★ รหัสบัญชีหมวดผิด → ปฏิเสธ ไม่เขียน DB", async () => {
    const res = await upsertSettingsAction({
      customerId: CUSTOMER_A,
      salaryExpenseAccountCode: "2910", // หนี้สิน ไม่ใช่ค่าใช้จ่าย → ผิด
      ssoEmployerExpenseAccountCode: "5311",
      ssoPayableAccountCode: "2050",
      pitPayableAccountCode: "2910",
      otherDeductionsAccountCode: null,
      netPayAccountCode: null,
      netPayIsPaidImmediately: false,
    });
    expect(res.ok).toBe(false);
    expect(tables.payroll_settings).toHaveLength(0);
  });

  it("★ ลูกค้านอกสโคป → ปฏิเสธ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await upsertSettingsAction({
      customerId: CUSTOMER_A,
      salaryExpenseAccountCode: "5310",
      ssoEmployerExpenseAccountCode: "5311",
      ssoPayableAccountCode: "2050",
      pitPayableAccountCode: "2910",
      otherDeductionsAccountCode: null,
      netPayAccountCode: null,
      netPayIsPaidImmediately: false,
    });
    expect(res.ok).toBe(false);
    expect(tables.payroll_settings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// ค่าลดหย่อนภาษีอื่นของพนักงาน (เฟส 9b กลุ่ม BE) — เทสต์ระดับ action ถาวร (QC ข้อ 3): พิสูจน์ IDOR guard
//   ครบทั้ง 3 action (list/upsert/delete) — customerId ตรงสโคปของนักบัญชี แต่ employeeId เป็นของลูกค้าอื่น
//   (EMPLOYEE_B อยู่ CUSTOMER_B จริง) ต้องถูกปฏิเสธเสมอ ไม่แตะ DB
// ---------------------------------------------------------------------

describe("listDeductionsAction (0.2 BE, IDOR)", () => {
  it("โหลดค่าลดหย่อนสำเร็จเมื่อ scope ตรงทุกจุด", async () => {
    tables.payroll_employee_deductions.push({
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      tenant_id: "tenant-1",
      payroll_employee_id: EMPLOYEE_A,
      tax_year: 2569,
      deduction_type: "spouse_no_income",
      amount: 60000,
      note: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const res = await listDeductionsAction(EMPLOYEE_A, CUSTOMER_A, 2569);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.deductions).toHaveLength(1);
  });

  it("★★★ IDOR — customerId ตรงสโคปนักบัญชี (CUSTOMER_A) แต่ employeeId เป็นของลูกค้าอื่น (EMPLOYEE_B อยู่ CUSTOMER_B) → ปฏิเสธ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_A, CUSTOMER_B]));
    const res = await listDeductionsAction(EMPLOYEE_B, CUSTOMER_A, 2569);
    expect(res.ok).toBe(false);
  });

  it("★ ลูกค้านอกสโคปของนักบัญชี → ปฏิเสธ", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await listDeductionsAction(EMPLOYEE_A, CUSTOMER_A, 2569);
    expect(res.ok).toBe(false);
  });
});

describe("upsertDeductionAction (0.2 BE, IDOR)", () => {
  it("บันทึกค่าลดหย่อนสำเร็จเมื่อ scope ตรงทุกจุด", async () => {
    const res = await upsertDeductionAction({
      employeeId: EMPLOYEE_A,
      customerId: CUSTOMER_A,
      taxYear: 2569,
      deductionType: "life_insurance_self",
      amount: 50000,
      note: null,
    });
    expect(res.ok).toBe(true);
    expect(tables.payroll_employee_deductions).toHaveLength(1);
  });

  it("★★★ IDOR — customerId ตรงสโคปนักบัญชี (CUSTOMER_A) แต่ employeeId เป็นของลูกค้าอื่น (EMPLOYEE_B อยู่ CUSTOMER_B) → ปฏิเสธ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_A, CUSTOMER_B]));
    const res = await upsertDeductionAction({
      employeeId: EMPLOYEE_B,
      customerId: CUSTOMER_A, // ปลอม — พนักงานจริงเป็นของ CUSTOMER_B
      taxYear: 2569,
      deductionType: "life_insurance_self",
      amount: 50000,
      note: null,
    });
    expect(res.ok).toBe(false);
    expect(tables.payroll_employee_deductions).toHaveLength(0);
  });

  it("★ ลูกค้านอกสโคปของนักบัญชี → ปฏิเสธ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await upsertDeductionAction({
      employeeId: EMPLOYEE_A,
      customerId: CUSTOMER_A,
      taxYear: 2569,
      deductionType: "life_insurance_self",
      amount: 50000,
      note: null,
    });
    expect(res.ok).toBe(false);
    expect(tables.payroll_employee_deductions).toHaveLength(0);
  });
});

describe("deleteDeductionAction (0.2 BE, IDOR)", () => {
  const DEDUCTION_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

  function seedDeduction() {
    tables.payroll_employee_deductions.push({
      id: DEDUCTION_ID,
      tenant_id: "tenant-1",
      payroll_employee_id: EMPLOYEE_A,
      tax_year: 2569,
      deduction_type: "spouse_no_income",
      amount: 60000,
      note: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
  }

  it("ลบสำเร็จเมื่อ scope ตรงทุกจุด", async () => {
    seedDeduction();
    const res = await deleteDeductionAction(DEDUCTION_ID, EMPLOYEE_A, CUSTOMER_A);
    expect(res.ok).toBe(true);
    expect(tables.payroll_employee_deductions).toHaveLength(0);
  });

  it("★★★ IDOR — customerId ตรงสโคปนักบัญชี (CUSTOMER_A) แต่ employeeId เป็นของลูกค้าอื่น (EMPLOYEE_B อยู่ CUSTOMER_B) → ปฏิเสธ ไม่ลบ", async () => {
    seedDeduction();
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_A, CUSTOMER_B]));
    const res = await deleteDeductionAction(DEDUCTION_ID, EMPLOYEE_B, CUSTOMER_A);
    expect(res.ok).toBe(false);
    expect(tables.payroll_employee_deductions).toHaveLength(1);
  });

  it("★ ลูกค้านอกสโคปของนักบัญชี → ปฏิเสธ ไม่ลบ", async () => {
    seedDeduction();
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_B]));
    const res = await deleteDeductionAction(DEDUCTION_ID, EMPLOYEE_A, CUSTOMER_A);
    expect(res.ok).toBe(false);
    expect(tables.payroll_employee_deductions).toHaveLength(1);
  });
});
