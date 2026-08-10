import { describe, it, expect, beforeEach } from "vitest";
import { makeInMemoryDb, type Tables } from "../helpers/fake-payroll-db";
import {
  validatePayrollEmployeeInput,
  listEmployees,
  upsertEmployee,
  softDeleteEmployee,
  getEmployeeScope,
  getEmployeeById,
  maskIdCardNo,
  type PayrollEmployeeInput,
} from "@/lib/accounting/payroll-employees";

/**
 * เทสต์ lib/accounting/payroll-employees.ts (เฟส 9 ส่วน AC, T104)
 *   ★ 0.2 ตารางนี้ (payroll_employees) คือพนักงานของบริษัทลูกค้า — คนละเอนทิตีกับ public.employees เดิม
 *     (พนักงานภายใน Finovas) เทสต์นี้ไม่แตะตาราง employees เลย
 */

const TENANT = "tenant-1";
const CUSTOMER_A = "cust-a";
const CUSTOMER_B = "cust-b";

function baseInput(p: Partial<PayrollEmployeeInput> = {}): PayrollEmployeeInput {
  return {
    fullName: "สมชาย ใจดี",
    idCardNo: "1234567890123",
    baseSalary: 20000,
    ...p,
  };
}

describe("validatePayrollEmployeeInput (0.12)", () => {
  it("input ถูกต้องครบถ้วน → ผ่าน, normalize เลขบัตรตัดขีด/ช่องว่าง", () => {
    const res = validatePayrollEmployeeInput(baseInput({ idCardNo: "1-2345-67890-12-3" }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.idCardNo).toBe("1234567890123");
  });

  it("ไม่มีชื่อ → ปฏิเสธ", () => {
    expect(validatePayrollEmployeeInput(baseInput({ fullName: "" })).ok).toBe(false);
  });

  it("★ id_card_no รูปแบบผิด (ไม่ครบ 13 หลัก) → ปฏิเสธ (reuse isValidTaxId)", () => {
    expect(validatePayrollEmployeeInput(baseInput({ idCardNo: "123" })).ok).toBe(false);
    expect(validatePayrollEmployeeInput(baseInput({ idCardNo: "12345678901234" })).ok).toBe(false);
  });

  it("★ ไม่กรอกทั้ง id_card_no และ passport_no → ปฏิเสธ", () => {
    expect(validatePayrollEmployeeInput(baseInput({ idCardNo: undefined, passportNo: undefined })).ok).toBe(false);
  });

  it("มี passport_no แทน id_card_no (พนักงานต่างชาติ) → ผ่าน", () => {
    const res = validatePayrollEmployeeInput(baseInput({ idCardNo: undefined, passportNo: "AB123456" }));
    expect(res.ok).toBe(true);
  });

  it("★ base_salary ติดลบ → ปฏิเสธ", () => {
    expect(validatePayrollEmployeeInput(baseInput({ baseSalary: -1 })).ok).toBe(false);
  });

  it("base_salary ไม่ใช่ตัวเลข → ปฏิเสธ", () => {
    expect(validatePayrollEmployeeInput(baseInput({ baseSalary: "abc" })).ok).toBe(false);
  });

  it("start_date/resign_date ผิดรูปแบบ → ปฏิเสธ", () => {
    expect(validatePayrollEmployeeInput(baseInput({ startDate: "31/12/2026" })).ok).toBe(false);
    expect(validatePayrollEmployeeInput(baseInput({ resignDate: "2026-02-30" })).ok).toBe(false);
  });

  it("ไม่กรอก start_date/resign_date เลย → ผ่าน (nullable)", () => {
    const res = validatePayrollEmployeeInput(baseInput());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.startDate).toBeNull();
      expect(res.value.resignDate).toBeNull();
    }
  });
});

describe("maskIdCardNo (0.12 PDPA)", () => {
  it("มาสก์ 9 หลักแรก โชว์ 4 ตัวท้ายรูปแบบ x-xxxx-xxxxx-xx-N", () => {
    expect(maskIdCardNo("1234567890123")).toBe("x-xxxx-xxxxx-xx-3");
  });
  it("null → null", () => {
    expect(maskIdCardNo(null)).toBeNull();
  });
});

describe("data layer (mock DB in-memory)", () => {
  let tables: Tables;

  beforeEach(() => {
    tables = {
      payroll_employees: [],
    };
  });

  it("upsertEmployee สร้างใหม่ → normalize เลขบัตรก่อนเก็บ, scope tenant+customer ถูกต้อง", async () => {
    const { db } = makeInMemoryDb(tables);
    const res = await upsertEmployee(db, TENANT, CUSTOMER_A, baseInput({ idCardNo: "1-2345-67890-12-3" }));
    expect(res.ok).toBe(true);
    expect(tables.payroll_employees).toHaveLength(1);
    expect(tables.payroll_employees[0].id_card_no).toBe("1234567890123");
    expect(tables.payroll_employees[0].tenant_id).toBe(TENANT);
    expect(tables.payroll_employees[0].customer_id).toBe(CUSTOMER_A);
  });

  it("★★ id_card_no ซ้ำในลูกค้าเดียวกัน → ถูกปฏิเสธ (unique index simulation)", async () => {
    const uniqueIndexes = [
      { table: "payroll_employees", columns: ["tenant_id", "customer_id", "id_card_no"], where: (r: Record<string, unknown>) => !r.deleted_at && !!r.id_card_no },
    ];
    const { db } = makeInMemoryDb(tables, { uniqueIndexes });
    const first = await upsertEmployee(db, TENANT, CUSTOMER_A, baseInput());
    expect(first.ok).toBe(true);
    const second = await upsertEmployee(db, TENANT, CUSTOMER_A, baseInput({ fullName: "อีกคน" }));
    expect(second.ok).toBe(false);
  });

  it("ลูกค้าคนละรายใช้เลขบัตรเดียวกันได้ (ไม่ unique ข้ามลูกค้า)", async () => {
    const uniqueIndexes = [
      { table: "payroll_employees", columns: ["tenant_id", "customer_id", "id_card_no"], where: (r: Record<string, unknown>) => !r.deleted_at && !!r.id_card_no },
    ];
    const { db } = makeInMemoryDb(tables, { uniqueIndexes });
    const a = await upsertEmployee(db, TENANT, CUSTOMER_A, baseInput());
    const b = await upsertEmployee(db, TENANT, CUSTOMER_B, baseInput());
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("upsertEmployee แก้ไข — id ระบุ + customer ไม่ตรง → ปฏิเสธ", async () => {
    const { db } = makeInMemoryDb(tables);
    const created = await upsertEmployee(db, TENANT, CUSTOMER_A, baseInput());
    expect(created.ok).toBe(true);
    const res = await upsertEmployee(db, TENANT, CUSTOMER_B, baseInput({ fullName: "แก้ชื่อ" }), (created as { id: string }).id);
    expect(res.ok).toBe(false);
  });

  it("upsertEmployee แก้ไข — customer ตรง → บันทึกสำเร็จ", async () => {
    const { db } = makeInMemoryDb(tables);
    const created = await upsertEmployee(db, TENANT, CUSTOMER_A, baseInput());
    const id = (created as { id: string }).id;
    const res = await upsertEmployee(db, TENANT, CUSTOMER_A, baseInput({ fullName: "แก้ชื่อแล้ว" }), id);
    expect(res.ok).toBe(true);
    const full = await getEmployeeById(db, TENANT, id);
    expect(full?.fullName).toBe("แก้ชื่อแล้ว");
  });

  it("listEmployees scope tenant+customer ถูกต้อง — ไม่เห็นของลูกค้าอื่น", async () => {
    const { db } = makeInMemoryDb(tables);
    await upsertEmployee(db, TENANT, CUSTOMER_A, baseInput({ fullName: "เอ" }));
    await upsertEmployee(db, TENANT, CUSTOMER_B, baseInput({ fullName: "บี", idCardNo: "9876543210987" }));
    const listA = await listEmployees(db, TENANT, CUSTOMER_A);
    expect(listA).toHaveLength(1);
    expect(listA[0].fullName).toBe("เอ");
  });

  it("listEmployees({activeOnly:true}) กรองเฉพาะ active", async () => {
    const { db } = makeInMemoryDb(tables);
    await upsertEmployee(db, TENANT, CUSTOMER_A, baseInput({ fullName: "ทำงานอยู่", isActive: true }));
    await upsertEmployee(db, TENANT, CUSTOMER_A, baseInput({ fullName: "ลาออกแล้ว", idCardNo: "1111111111116", isActive: false }));
    const activeOnly = await listEmployees(db, TENANT, CUSTOMER_A, { activeOnly: true });
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0].fullName).toBe("ทำงานอยู่");
  });

  it("softDeleteEmployee — ลบแล้วไม่ปรากฏใน listEmployees อีก", async () => {
    const { db } = makeInMemoryDb(tables);
    const created = await upsertEmployee(db, TENANT, CUSTOMER_A, baseInput());
    const id = (created as { id: string }).id;
    const res = await softDeleteEmployee(db, TENANT, id);
    expect(res.ok).toBe(true);
    const list = await listEmployees(db, TENANT, CUSTOMER_A);
    expect(list).toHaveLength(0);
  });

  it("getEmployeeScope คืน null ถ้าไม่พบ (ถูกลบไปแล้ว)", async () => {
    const { db } = makeInMemoryDb(tables);
    const created = await upsertEmployee(db, TENANT, CUSTOMER_A, baseInput());
    const id = (created as { id: string }).id;
    await softDeleteEmployee(db, TENANT, id);
    const scope = await getEmployeeScope(db, TENANT, id);
    expect(scope).toBeNull();
  });
});
