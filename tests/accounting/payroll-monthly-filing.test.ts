import { describe, it, expect, beforeEach } from "vitest";
import { makeInMemoryDb, type Tables, type Row } from "../helpers/fake-payroll-db";
import {
  getOrCreateFilingPeriod,
  getFilingPeriodById,
  getFilingPeriodByYearMonth,
  listFilingPeriods,
  getFilingPeriodDetail,
  getFilingPeriodEmployeeTotals,
  markPitFiled,
  unmarkPitFiled,
  markSsoFiled,
  unmarkSsoFiled,
} from "@/lib/accounting/payroll-monthly-filing";

/**
 * เทสต์ lib/accounting/payroll-monthly-filing.ts (เฟส 9b กลุ่ม BC, T137, docs/06 หมวด 0.5)
 *   ★★★ getOrCreateFilingPeriod ต้อง idempotent ต่อ (tenant,customer,ปี,เดือน) เสมอ
 *   ★★★ markPitFiled/markSsoFiled อนุญาตเฉพาะหน่วยยื่นที่มีอย่างน้อย 1 รอบจ่าย status='finalized' ผูกอยู่
 */

const TENANT = "tenant-1";
const CUSTOMER_A = "cust-a";
const CUSTOMER_B = "cust-b";

function baseTables(): Tables {
  return {
    payroll_monthly_filings: [],
    payroll_runs: [],
    payroll_run_lines: [],
    payroll_employees: [],
  };
}

describe("getOrCreateFilingPeriod (T137) — idempotent", () => {
  let tables: Tables;
  beforeEach(() => {
    tables = baseTables();
  });

  it("เรียกครั้งแรก → สร้างแถวใหม่ ค่า default not_filed ทั้ง pit/sso", async () => {
    const { db } = makeInMemoryDb(tables);
    const period = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    expect(period).toBeTruthy();
    expect(period?.periodYear).toBe(2569);
    expect(period?.periodMonth).toBe(8);
    expect(period?.pitFilingStatus).toBe("not_filed");
    expect(period?.ssoFilingStatus).toBe("not_filed");
    expect(tables.payroll_monthly_filings).toHaveLength(1);
  });

  it("เรียกซ้ำด้วย (tenant,customer,ปี,เดือน) เดิม → คืนแถวเดียวกันเสมอ ไม่สร้างซ้ำ", async () => {
    const { db } = makeInMemoryDb(tables);
    const p1 = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    const p2 = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    const p3 = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    expect(p1?.id).toBe(p2?.id);
    expect(p2?.id).toBe(p3?.id);
    expect(tables.payroll_monthly_filings).toHaveLength(1);
  });

  it("เดือน/ปี/ลูกค้าต่างกัน → ได้แถวคนละแถว", async () => {
    const { db } = makeInMemoryDb(tables);
    const pAug = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    const pSep = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 9);
    const pOtherCustomer = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_B, 2569, 8);
    expect(pAug?.id).not.toBe(pSep?.id);
    expect(pAug?.id).not.toBe(pOtherCustomer?.id);
    expect(tables.payroll_monthly_filings).toHaveLength(3);
  });

  it("getFilingPeriodByYearMonth ไม่สร้างใหม่ถ้าไม่พบ (อ่านล้วน ไม่มี side-effect ตอน GET)", async () => {
    const { db } = makeInMemoryDb(tables);
    const found = await getFilingPeriodByYearMonth(db, TENANT, CUSTOMER_A, 2569, 8);
    expect(found).toBeNull();
    expect(tables.payroll_monthly_filings).toHaveLength(0);
  });

  // ★★★ พบโดย reviewer QC — เดิมไม่มีเทสต์ที่ force ให้เข้า branch insert-conflict-then-retry จริง (มีแต่เทสต์
  //   idempotent แบบเรียกซ้ำต่อเนื่อง ไม่ใช่ race จริง) — ใช้ uniqueIndexes ของ fake DB (mirror unique index
  //   จริงที่ DB บน tenant_id,customer_id,period_year,period_month — migration 0094) + Promise.all จำลอง
  //   2 request ชนกันพร้อมกันจริง (ผ่าน `existing` check ของทั้งคู่ก่อนที่ฝั่งใดฝั่งหนึ่งจะ insert ทัน)
  it("★★★ 2 request เรียก getOrCreateFilingPeriod พร้อมกันด้วยคีย์เดียวกัน (จำลอง race จริง) → insert ฝั่งที่แพ้โดน unique ปฏิเสธ (23505) แล้ว retry เจอแถวที่ฝั่งชนะสร้างไว้ → ได้ id เดียวกัน ไม่สร้างซ้ำ", async () => {
    const uniqueIndexes = [
      { table: "payroll_monthly_filings", columns: ["tenant_id", "customer_id", "period_year", "period_month"] as string[], where: (_r: Row) => true },
    ];
    const { db } = makeInMemoryDb(tables, { uniqueIndexes });
    const [p1, p2] = await Promise.all([
      getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8),
      getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8),
    ]);
    expect(p1).toBeTruthy();
    expect(p2).toBeTruthy();
    // ★ ใจความของเทสต์นี้ — ทั้งคู่ต้องได้แถวเดียวกัน (ฝั่งแพ้ retry เจอแถวที่ฝั่งชนะสร้างไว้แล้ว) ไม่ใช่คนละแถว
    expect(p1?.id).toBe(p2?.id);
    expect(tables.payroll_monthly_filings).toHaveLength(1);
  });
});

describe("listFilingPeriods", () => {
  it("เรียงปี/เดือนล่าสุดก่อน + กรองเฉพาะลูกค้าที่ระบุ", async () => {
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 1);
    await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_B, 2569, 12); // ลูกค้าอื่น ไม่ควรติดมา
    const list = await listFilingPeriods(db, TENANT, CUSTOMER_A);
    expect(list).toHaveLength(2);
    expect(list[0].periodMonth).toBe(8);
    expect(list[1].periodMonth).toBe(1);
  });
});

describe("getFilingPeriodDetail (T139)", () => {
  let tables: Tables;
  beforeEach(() => {
    tables = baseTables();
  });

  it("คืน null ถ้าไม่พบ/ลูกค้าไม่ตรง", async () => {
    const { db } = makeInMemoryDb(tables);
    const period = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    const wrongCustomer = await getFilingPeriodDetail(db, TENANT, CUSTOMER_B, period!.id);
    expect(wrongCustomer).toBeNull();
    const notFound = await getFilingPeriodDetail(db, TENANT, CUSTOMER_A, "not-exist");
    expect(notFound).toBeNull();
  });

  it("★★★ รวมยอด PIT/SSO/net_pay ต่อรอบถูกต้อง เมื่อเดือนเดียวมีหลายรอบจ่าย (non_monthly)", async () => {
    const { db } = makeInMemoryDb(tables);
    const period = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    tables.payroll_runs.push(
      { id: "run-1", tenant_id: TENANT, customer_id: CUSTOMER_A, pay_date: "2026-08-07", status: "finalized", filing_period_id: period!.id, deleted_at: null },
      { id: "run-2", tenant_id: TENANT, customer_id: CUSTOMER_A, pay_date: "2026-08-14", status: "draft", filing_period_id: period!.id, deleted_at: null }
    );
    tables.payroll_run_lines.push(
      { id: "l1", tenant_id: TENANT, run_id: "run-1", pit_withheld: 100, sso_employee: 50, sso_employer: 50, net_pay: 9850 },
      { id: "l2", tenant_id: TENANT, run_id: "run-1", pit_withheld: 200, sso_employee: 75, sso_employer: 75, net_pay: 19725 },
      { id: "l3", tenant_id: TENANT, run_id: "run-2", pit_withheld: 10, sso_employee: 5, sso_employer: 5, net_pay: 985 }
    );
    const detail = await getFilingPeriodDetail(db, TENANT, CUSTOMER_A, period!.id);
    expect(detail).toBeTruthy();
    expect(detail?.runs).toHaveLength(2);
    const run1 = detail?.runs.find((r) => r.id === "run-1")!;
    expect(run1.totalPit).toBe(300);
    expect(run1.totalSsoEmployee).toBe(125);
    expect(run1.totalSsoEmployer).toBe(125);
    expect(run1.totalNetPay).toBe(29575);
    expect(run1.status).toBe("finalized");
    const run2 = detail?.runs.find((r) => r.id === "run-2")!;
    expect(run2.totalPit).toBe(10);
    expect(run2.status).toBe("draft");
  });

  it("เดือนที่ยังไม่มีรอบจ่ายเลย → runs=[] ไม่ error", async () => {
    const { db } = makeInMemoryDb(tables);
    const period = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    const detail = await getFilingPeriodDetail(db, TENANT, CUSTOMER_A, period!.id);
    expect(detail?.runs).toEqual([]);
  });
});

describe("markPitFiled/unmarkPitFiled/markSsoFiled/unmarkSsoFiled (T137)", () => {
  let tables: Tables;
  let periodId: string;

  beforeEach(async () => {
    tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    const period = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    periodId = period!.id;
  });

  it("ไม่มีรอบไหน finalized ผูกอยู่เลย → mark filed ถูกปฏิเสธ", async () => {
    const { db } = makeInMemoryDb(tables);
    const res = await markPitFiled(db, TENANT, periodId, "acc-1");
    expect(res.ok).toBe(false);
  });

  it("มีรอบ draft ผูกอยู่ (ยังไม่ finalized) → mark filed ยังถูกปฏิเสธ", async () => {
    tables.payroll_runs.push({ id: "run-1", tenant_id: TENANT, customer_id: CUSTOMER_A, status: "draft", filing_period_id: periodId, deleted_at: null });
    const { db } = makeInMemoryDb(tables);
    const res = await markPitFiled(db, TENANT, periodId, "acc-1");
    expect(res.ok).toBe(false);
  });

  it("มีอย่างน้อย 1 รอบ finalized ผูกอยู่ → mark สำเร็จ ตั้ง filed_at/filed_by ถูกต้อง", async () => {
    tables.payroll_runs.push({ id: "run-1", tenant_id: TENANT, customer_id: CUSTOMER_A, status: "finalized", filing_period_id: periodId, deleted_at: null });
    const { db } = makeInMemoryDb(tables);
    const res = await markPitFiled(db, TENANT, periodId, "acc-1");
    expect(res.ok).toBe(true);
    const row = tables.payroll_monthly_filings.find((f) => f.id === periodId)!;
    expect(row.pit_filing_status).toBe("filed");
    expect(row.pit_filed_by).toBe("acc-1");
    expect(row.pit_filed_at).toBeTruthy();
  });

  it("unmark รีเซ็ตกลับ not_filed ได้", async () => {
    tables.payroll_runs.push({ id: "run-1", tenant_id: TENANT, customer_id: CUSTOMER_A, status: "finalized", filing_period_id: periodId, deleted_at: null });
    const { db } = makeInMemoryDb(tables);
    await markPitFiled(db, TENANT, periodId, "acc-1");
    const res = await unmarkPitFiled(db, TENANT, periodId);
    expect(res.ok).toBe(true);
    const row = tables.payroll_monthly_filings.find((f) => f.id === periodId)!;
    expect(row.pit_filing_status).toBe("not_filed");
    expect(row.pit_filed_by ?? null).toBeNull();
  });

  it("markSsoFiled แยกอิสระจาก pit (mark pit ไม่กระทบสถานะ sso)", async () => {
    tables.payroll_runs.push({ id: "run-1", tenant_id: TENANT, customer_id: CUSTOMER_A, status: "finalized", filing_period_id: periodId, deleted_at: null });
    const { db } = makeInMemoryDb(tables);
    await markPitFiled(db, TENANT, periodId, "acc-1");
    const res = await markSsoFiled(db, TENANT, periodId, "acc-1");
    expect(res.ok).toBe(true);
    const row = tables.payroll_monthly_filings.find((f) => f.id === periodId)!;
    expect(row.pit_filing_status).toBe("filed");
    expect(row.sso_filing_status).toBe("filed");
  });

  it("unmarkSsoFiled ไม่กระทบสถานะ pit", async () => {
    tables.payroll_runs.push({ id: "run-1", tenant_id: TENANT, customer_id: CUSTOMER_A, status: "finalized", filing_period_id: periodId, deleted_at: null });
    const { db } = makeInMemoryDb(tables);
    await markPitFiled(db, TENANT, periodId, "acc-1");
    await markSsoFiled(db, TENANT, periodId, "acc-1");
    const res = await unmarkSsoFiled(db, TENANT, periodId);
    expect(res.ok).toBe(true);
    const row = tables.payroll_monthly_filings.find((f) => f.id === periodId)!;
    expect(row.pit_filing_status).toBe("filed");
    expect(row.sso_filing_status).toBe("not_filed");
  });

  it("ไม่พบหน่วยยื่น (id ผิด) → ปฏิเสธ", async () => {
    const { db } = makeInMemoryDb(tables);
    const res = await markPitFiled(db, TENANT, "not-exist", "acc-1");
    expect(res.ok).toBe(false);
  });

  it("★ getFilingPeriodById คืน null ถ้า tenant ไม่ตรง (IDOR-safe)", async () => {
    const { db } = makeInMemoryDb(tables);
    const found = await getFilingPeriodById(db, "other-tenant", periodId);
    expect(found).toBeNull();
  });
});

describe("getFilingPeriodEmployeeTotals (wishlist ข้อ 5 — ยื่น ภ.ง.ด.1)", () => {
  let tables: Tables;
  beforeEach(() => {
    tables = baseTables();
  });

  it("ไม่พบหน่วยยื่น/ลูกค้าไม่ตรง → คืน []", async () => {
    const { db } = makeInMemoryDb(tables);
    const period = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    const wrongCustomer = await getFilingPeriodEmployeeTotals(db, TENANT, CUSTOMER_B, period!.id);
    expect(wrongCustomer).toEqual([]);
    const notFound = await getFilingPeriodEmployeeTotals(db, TENANT, CUSTOMER_A, "not-exist");
    expect(notFound).toEqual([]);
  });

  it("ยังไม่มีรอบจ่ายเลยในเดือนนี้ → คืน []", async () => {
    const { db } = makeInMemoryDb(tables);
    const period = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    const totals = await getFilingPeriodEmployeeTotals(db, TENANT, CUSTOMER_A, period!.id);
    expect(totals).toEqual([]);
  });

  it("★★★ รวมยอดต่อพนักงานข้ามหลายรอบจ่ายในเดือนเดียวกัน (non_monthly) ถูกต้อง + join ข้อมูลพนักงาน", async () => {
    const { db } = makeInMemoryDb(tables);
    const period = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    tables.payroll_employees.push(
      { id: "emp-1", tenant_id: TENANT, customer_id: CUSTOMER_A, employee_code: "E001", full_name: "สมชาย ใจดี", id_card_no: "1111111111111", passport_no: null },
      { id: "emp-2", tenant_id: TENANT, customer_id: CUSTOMER_A, employee_code: "E002", full_name: "สมหญิง มีสุข", id_card_no: "2222222222222", passport_no: null }
    );
    tables.payroll_runs.push(
      { id: "run-1", tenant_id: TENANT, customer_id: CUSTOMER_A, pay_date: "2026-08-07", status: "finalized", filing_period_id: period!.id, deleted_at: null },
      { id: "run-2", tenant_id: TENANT, customer_id: CUSTOMER_A, pay_date: "2026-08-14", status: "finalized", filing_period_id: period!.id, deleted_at: null }
    );
    tables.payroll_run_lines.push(
      { id: "l1", tenant_id: TENANT, run_id: "run-1", payroll_employee_id: "emp-1", gross_salary: 20000, other_additions: 0, bonus_amount: 0, pit_withheld: 100 },
      { id: "l2", tenant_id: TENANT, run_id: "run-2", payroll_employee_id: "emp-1", gross_salary: 5000, other_additions: 500, bonus_amount: 0, pit_withheld: 20 },
      { id: "l3", tenant_id: TENANT, run_id: "run-1", payroll_employee_id: "emp-2", gross_salary: 15000, other_additions: 0, bonus_amount: 3000, pit_withheld: 80 }
    );

    const totals = await getFilingPeriodEmployeeTotals(db, TENANT, CUSTOMER_A, period!.id);
    expect(totals).toHaveLength(2);

    const emp1 = totals.find((t) => t.employeeId === "emp-1")!;
    expect(emp1.grossIncome).toBe(25500); // 20000 + 5000 + 500
    expect(emp1.pitWithheld).toBe(120); // 100 + 20
    expect(emp1.fullName).toBe("สมชาย ใจดี");
    expect(emp1.idCardNo).toBe("1111111111111"); // ★ เต็ม ไม่มาสก์ (เอกสารยื่นต้องใช้เลขเต็ม)

    const emp2 = totals.find((t) => t.employeeId === "emp-2")!;
    expect(emp2.grossIncome).toBe(18000); // 15000 + 3000
    expect(emp2.pitWithheld).toBe(80);

    // เรียงตามรหัสพนักงาน (E001 ก่อน E002)
    expect(totals[0].employeeCode).toBe("E001");
    expect(totals[1].employeeCode).toBe("E002");
  });

  it("รอบจ่ายของลูกค้าอื่น/เดือนอื่น ไม่ปนเข้ามา", async () => {
    const { db } = makeInMemoryDb(tables);
    const periodA = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 8);
    const periodOtherMonth = await getOrCreateFilingPeriod(db, TENANT, CUSTOMER_A, 2569, 9);
    tables.payroll_employees.push({ id: "emp-1", tenant_id: TENANT, customer_id: CUSTOMER_A, employee_code: "E001", full_name: "สมชาย", id_card_no: "111", passport_no: null });
    tables.payroll_runs.push(
      { id: "run-aug", tenant_id: TENANT, customer_id: CUSTOMER_A, pay_date: "2026-08-07", status: "finalized", filing_period_id: periodA!.id, deleted_at: null },
      { id: "run-sep", tenant_id: TENANT, customer_id: CUSTOMER_A, pay_date: "2026-09-07", status: "finalized", filing_period_id: periodOtherMonth!.id, deleted_at: null }
    );
    tables.payroll_run_lines.push(
      { id: "l1", tenant_id: TENANT, run_id: "run-aug", payroll_employee_id: "emp-1", gross_salary: 10000, other_additions: 0, bonus_amount: 0, pit_withheld: 50 },
      { id: "l2", tenant_id: TENANT, run_id: "run-sep", payroll_employee_id: "emp-1", gross_salary: 99999, other_additions: 0, bonus_amount: 0, pit_withheld: 999 }
    );
    const totals = await getFilingPeriodEmployeeTotals(db, TENANT, CUSTOMER_A, periodA!.id);
    expect(totals).toHaveLength(1);
    expect(totals[0].grossIncome).toBe(10000); // ไม่รวมของเดือนกันยา
  });
});
