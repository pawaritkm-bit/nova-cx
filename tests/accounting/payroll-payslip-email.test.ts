import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeInMemoryDb, type Tables } from "../helpers/fake-payroll-db";
import { createDraftRun } from "@/lib/accounting/payroll";

/**
 * เทสต์ lib/accounting/payroll-payslip-email.ts::sendPayslipEmails (wishlist ข้อ 6)
 *   ★ mock ทั้ง buildPayslipPdfBuffer (pdfkit จริงช้า/ไม่ต้อง verify ซ้ำที่นี่ — มีเทสต์แยกที่
 *   payroll-payslip-pdf.test.ts แล้ว) และ sendEmail (ไม่ยิง SMTP จริง) — โฟกัสที่ตรรกะ orchestration:
 *   skip คนไม่มีอีเมล, per-employee try/catch ไม่บล็อกคนอื่น, สรุปผลถูกต้อง
 */

vi.mock("@/lib/accounting/payroll-payslip-pdf", () => ({
  buildPayslipPdfBuffer: vi.fn(async () => Buffer.from("fake-pdf")),
  buildPayslipEmailContent: vi.fn(() => ({ subject: "สลิปเงินเดือน", text: "แนบมาด้วย" })),
  payslipFilename: vi.fn(() => "payslip.pdf"),
}));

const sendEmailMock = vi.fn();
vi.mock("@/lib/email/mailer", () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

const TENANT = "tenant-1";
const CUSTOMER_A = "cust-a";

function baseTables(): Tables {
  return {
    payroll_employees: [],
    payroll_runs: [],
    payroll_run_lines: [],
  };
}

function seedEmployees(tables: Tables, specs: Array<{ id: string; email: string | null }>) {
  for (const s of specs) {
    tables.payroll_employees.push({
      id: s.id,
      tenant_id: TENANT,
      customer_id: CUSTOMER_A,
      employee_code: s.id.toUpperCase(),
      full_name: `พนักงาน ${s.id}`,
      id_card_no: null,
      passport_no: "P" + s.id,
      position: null,
      base_salary: 20000,
      start_date: null,
      resign_date: null,
      is_active: true,
      email: s.email,
      deleted_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendPayslipEmails", () => {
  it("ไม่พบรอบเงินเดือน → {ok:false}", async () => {
    const { sendPayslipEmails } = await import("@/lib/accounting/payroll-payslip-email");
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    const res = await sendPayslipEmails(db, TENANT, CUSTOMER_A, "not-exist");
    expect(res.ok).toBe(false);
  });

  it("ส่งสำเร็จให้คนที่มีอีเมล, ข้ามคนที่ไม่มีอีเมล", async () => {
    const { sendPayslipEmails } = await import("@/lib/accounting/payroll-payslip-email");
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, [
      { id: "emp-1", email: "a@example.com" },
      { id: "emp-2", email: null },
    ]);
    const created = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-31" });
    expect(created.ok).toBe(true);
    const runId = (created as { id: string }).id;

    sendEmailMock.mockResolvedValue({ ok: true });

    const res = await sendPayslipEmails(db, TENANT, CUSTOMER_A, runId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.results).toHaveLength(2);
    const byEmp = new Map(res.results.map((r) => [r.payrollEmployeeId, r]));
    expect(byEmp.get("emp-1")?.status).toBe("sent");
    expect(byEmp.get("emp-2")?.status).toBe("skipped_no_email");
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("sendEmail คืน {ok:false} → status='failed' พร้อม message, ไม่บล็อกคนอื่น", async () => {
    const { sendPayslipEmails } = await import("@/lib/accounting/payroll-payslip-email");
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, [
      { id: "emp-1", email: "a@example.com" },
      { id: "emp-2", email: "b@example.com" },
    ]);
    const created = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-31" });
    const runId = (created as { id: string }).id;

    sendEmailMock
      .mockResolvedValueOnce({ ok: false, message: "ส่งอีเมลไม่สำเร็จ" })
      .mockResolvedValueOnce({ ok: true });

    const res = await sendPayslipEmails(db, TENANT, CUSTOMER_A, runId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byEmp = new Map(res.results.map((r) => [r.payrollEmployeeId, r]));
    expect(byEmp.get("emp-1")?.status).toBe("failed");
    expect(byEmp.get("emp-2")?.status).toBe("sent");
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });

  it("สร้าง PDF ล้มเหลว (throw) สำหรับคนหนึ่ง → status='failed' เฉพาะคนนั้น คนอื่นยังส่งได้ปกติ", async () => {
    const { buildPayslipPdfBuffer } = await import("@/lib/accounting/payroll-payslip-pdf");
    const { sendPayslipEmails } = await import("@/lib/accounting/payroll-payslip-email");
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, [
      { id: "emp-1", email: "a@example.com" },
      { id: "emp-2", email: "b@example.com" },
    ]);
    const created = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-31" });
    const runId = (created as { id: string }).id;

    (buildPayslipPdfBuffer as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("pdf boom"))
      .mockResolvedValueOnce(Buffer.from("ok"));
    sendEmailMock.mockResolvedValue({ ok: true });

    const res = await sendPayslipEmails(db, TENANT, CUSTOMER_A, runId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const statuses = res.results.map((r) => r.status).sort();
    expect(statuses).toEqual(["failed", "sent"]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("รอบไม่มีบรรทัดพนักงานเลย → {ok:false}", async () => {
    const { sendPayslipEmails } = await import("@/lib/accounting/payroll-payslip-email");
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    tables.payroll_runs.push({
      id: "run-empty",
      tenant_id: TENANT,
      customer_id: CUSTOMER_A,
      pay_period_year: 2569,
      pay_period_month: 8,
      pay_date: "2026-08-31",
      status: "finalized",
      manual_entry_id: null,
      deleted_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const res = await sendPayslipEmails(db, TENANT, CUSTOMER_A, "run-empty");
    expect(res.ok).toBe(false);
  });
});
