import { describe, it, expect } from "vitest";
import { makeInMemoryDb, type Tables } from "../helpers/fake-payroll-db";
import {
  validateDeductionInput,
  listDeductions,
  listDeductionsForEmployees,
  upsertDeduction,
  deleteDeduction,
  sumAndCapDeductions,
  SPOUSE_NO_INCOME_CAP,
  LIFE_INSURANCE_CAP,
  LIFE_INSURANCE_CAP_WITH_SPOUSE,
  PROVIDENT_FUND_ABS_CAP,
  PROVIDENT_FUND_INCOME_RATIO,
  MORTGAGE_INTEREST_CAP,
  type PayrollEmployeeDeductionInput,
} from "@/lib/accounting/payroll-deductions";

/**
 * เทสต์ lib/accounting/payroll-deductions.ts (เฟส 9b กลุ่ม BE, T150-T152/T156-T157)
 *   ★★★ 0.2 gate — sumAndCapDeductions ต้อง self-consistent ตามนิยามสูตร (T152) + golden test ที่ verify
 *   กับตัวอย่างคำนวณจากแหล่งที่เชื่อถือได้จริง (T157, ดูคอมเมนต์เต็มใน payroll-deductions.ts ก่อนฟังก์ชัน)
 */

const TENANT = "tenant-1";
const CUSTOMER_A = "cust-a";
const CUSTOMER_B = "cust-b";

function baseTables(): Tables {
  return {
    payroll_employees: [
      {
        id: "emp-a",
        tenant_id: TENANT,
        customer_id: CUSTOMER_A,
        employee_code: "EA",
        full_name: "พนักงาน เอ",
        id_card_no: null,
        passport_no: "PA",
        position: null,
        base_salary: 30000,
        start_date: null,
        resign_date: null,
        is_active: true,
        deleted_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "emp-b",
        tenant_id: TENANT,
        customer_id: CUSTOMER_B,
        employee_code: "EB",
        full_name: "พนักงาน บี",
        id_card_no: null,
        passport_no: "PB",
        position: null,
        base_salary: 25000,
        start_date: null,
        resign_date: null,
        is_active: true,
        deleted_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    payroll_employee_deductions: [],
  };
}

function baseInput(p: Partial<PayrollEmployeeDeductionInput> = {}): PayrollEmployeeDeductionInput {
  return {
    taxYear: 2569,
    deductionType: "spouse_no_income",
    amount: 60000,
    ...p,
  };
}

describe("validateDeductionInput (T151)", () => {
  it("input ถูกต้องครบถ้วน → ผ่าน", () => {
    const res = validateDeductionInput(baseInput());
    expect(res.ok).toBe(true);
  });

  it("★ taxYear ไม่ใช่ปี พ.ศ. ที่สมเหตุสมผล → ปฏิเสธ", () => {
    expect(validateDeductionInput(baseInput({ taxYear: 1999 })).ok).toBe(false);
    expect(validateDeductionInput(baseInput({ taxYear: 3000 })).ok).toBe(false);
    expect(validateDeductionInput(baseInput({ taxYear: "abc" })).ok).toBe(false);
    expect(validateDeductionInput(baseInput({ taxYear: 2569.5 })).ok).toBe(false);
  });

  it("★ deductionType นอกรายการที่กำหนด → ปฏิเสธ", () => {
    expect(validateDeductionInput(baseInput({ deductionType: "something_else" })).ok).toBe(false);
    expect(validateDeductionInput(baseInput({ deductionType: undefined })).ok).toBe(false);
  });

  it("★ amount ติดลบ/ไม่ใช่ตัวเลข → ปฏิเสธ", () => {
    expect(validateDeductionInput(baseInput({ amount: -1 })).ok).toBe(false);
    expect(validateDeductionInput(baseInput({ amount: "abc" })).ok).toBe(false);
  });

  it("amount = 0 → ผ่าน (ขอบเขต)", () => {
    expect(validateDeductionInput(baseInput({ amount: 0 })).ok).toBe(true);
  });

  it("★ deductionType='child' ต้องเป็น 30,000 หรือ 60,000 เท่านั้น", () => {
    expect(validateDeductionInput(baseInput({ deductionType: "child", amount: 30000 })).ok).toBe(true);
    expect(validateDeductionInput(baseInput({ deductionType: "child", amount: 60000 })).ok).toBe(true);
    expect(validateDeductionInput(baseInput({ deductionType: "child", amount: 45000 })).ok).toBe(false);
    expect(validateDeductionInput(baseInput({ deductionType: "child", amount: 0 })).ok).toBe(false);
  });

  it("note ยาวเกิน 300 ตัวอักษร → ตัดให้พอดี (ไม่ปฏิเสธ)", () => {
    const res = validateDeductionInput(baseInput({ note: "x".repeat(400) }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.note?.length).toBe(300);
  });
});

describe("CRUD ค่าลดหย่อน (IDOR-safe, T151)", () => {
  it("upsert สร้างแถวใหม่ + list เห็นแถวนั้น", async () => {
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    const res = await upsertDeduction(db, TENANT, CUSTOMER_A, "emp-a", baseInput());
    expect(res.ok).toBe(true);

    const list = await listDeductions(db, TENANT, CUSTOMER_A, "emp-a", 2569);
    expect(list.length).toBe(1);
    expect(list[0].deductionType).toBe("spouse_no_income");
    expect(list[0].amount).toBe(60000);
  });

  it("★ insert หลายแถว deduction_type='child' ต่อพนักงานคนเดียวได้ (ไม่ unique)", async () => {
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    const r1 = await upsertDeduction(db, TENANT, CUSTOMER_A, "emp-a", baseInput({ deductionType: "child", amount: 30000 }));
    const r2 = await upsertDeduction(db, TENANT, CUSTOMER_A, "emp-a", baseInput({ deductionType: "child", amount: 60000 }));
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const list = await listDeductions(db, TENANT, CUSTOMER_A, "emp-a", 2569);
    expect(list.filter((d) => d.deductionType === "child").length).toBe(2);
  });

  it("★ IDOR — upsert ด้วย customerId ที่ไม่ตรงกับพนักงานจริง → ปฏิเสธ", async () => {
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    // emp-a เป็นของ CUSTOMER_A จริง แต่ส่ง CUSTOMER_B มาลำพัง
    const res = await upsertDeduction(db, TENANT, CUSTOMER_B, "emp-a", baseInput());
    expect(res.ok).toBe(false);
  });

  it("★ IDOR — list ด้วย customerId ที่ไม่ตรงกับพนักงานจริง → คืน [] (fail-closed ไม่โยน error)", async () => {
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    await upsertDeduction(db, TENANT, CUSTOMER_A, "emp-a", baseInput());
    const list = await listDeductions(db, TENANT, CUSTOMER_B, "emp-a", 2569);
    expect(list).toEqual([]);
  });

  it("★ IDOR — แก้/ลบเฉพาะแถวของพนักงานที่ระบุ scope ตรงเท่านั้น (ระบุ employeeId คนละคนกับแถวเดิม → ปฏิเสธ)", async () => {
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    const created = await upsertDeduction(db, TENANT, CUSTOMER_A, "emp-a", baseInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // อ้าง employeeId คนละคน (emp-b, ของลูกค้า B) แต่ระบุ id ของแถวเดิมที่เป็นของ emp-a — ต้องปฏิเสธ
    const updateRes = await upsertDeduction(db, TENANT, CUSTOMER_B, "emp-b", baseInput({ amount: 100 }), created.id);
    expect(updateRes.ok).toBe(false);

    const deleteRes = await deleteDeduction(db, TENANT, CUSTOMER_B, "emp-b", created.id);
    expect(deleteRes.ok).toBe(false);

    // ยืนยันแถวเดิมยังอยู่ครบ ไม่ถูกแก้/ลบ
    const list = await listDeductions(db, TENANT, CUSTOMER_A, "emp-a", 2569);
    expect(list.length).toBe(1);
    expect(list[0].amount).toBe(60000);
  });

  it("update ถูกต้อง (scope ตรงทุกจุด) → แก้ยอดสำเร็จ", async () => {
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    const created = await upsertDeduction(db, TENANT, CUSTOMER_A, "emp-a", baseInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const updated = await upsertDeduction(db, TENANT, CUSTOMER_A, "emp-a", baseInput({ amount: 50000 }), created.id);
    expect(updated.ok).toBe(true);
    const list = await listDeductions(db, TENANT, CUSTOMER_A, "emp-a", 2569);
    expect(list[0].amount).toBe(50000);
  });

  it("delete ถูกต้อง (scope ตรงทุกจุด) → ลบสำเร็จ", async () => {
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    const created = await upsertDeduction(db, TENANT, CUSTOMER_A, "emp-a", baseInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = await deleteDeduction(db, TENANT, CUSTOMER_A, "emp-a", created.id);
    expect(res.ok).toBe(true);
    const list = await listDeductions(db, TENANT, CUSTOMER_A, "emp-a", 2569);
    expect(list.length).toBe(0);
  });

  it("listDeductionsForEmployees รวมหลายพนักงานพร้อมกัน (bulk, internal — ไม่ตรวจสโคปซ้ำ)", async () => {
    const tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    await upsertDeduction(db, TENANT, CUSTOMER_A, "emp-a", baseInput());
    await upsertDeduction(db, TENANT, CUSTOMER_B, "emp-b", baseInput({ deductionType: "mortgage_interest", amount: 20000 }));
    const map = await listDeductionsForEmployees(db, TENANT, ["emp-a", "emp-b"], 2569);
    expect(map.get("emp-a")?.length).toBe(1);
    expect(map.get("emp-b")?.length).toBe(1);
  });
});

describe("sumAndCapDeductions (T152) — self-consistent", () => {
  it("spouse_no_income รวมหลายแถวแล้ว cap ที่ 60,000 เป๊ะ", () => {
    const res = sumAndCapDeductions(
      [
        { deductionType: "spouse_no_income", amount: 40000 },
        { deductionType: "spouse_no_income", amount: 40000 },
      ],
      1000000
    );
    expect(res.totalOtherAllowance).toBe(SPOUSE_NO_INCOME_CAP);
    expect(res.warnings.length).toBe(1);
  });

  it("spouse_no_income ไม่เกิน cap → ไม่มี warning", () => {
    const res = sumAndCapDeductions([{ deductionType: "spouse_no_income", amount: 60000 }], 1000000);
    expect(res.totalOtherAllowance).toBe(60000);
    expect(res.warnings.length).toBe(0);
  });

  it("★ child ไม่มี cap อัตโนมัติ — รวมตรง ๆ แม้เกิน 60,000 (นักบัญชีเลือก 30,000/60,000 ต่อคนเอง)", () => {
    const res = sumAndCapDeductions(
      [
        { deductionType: "child", amount: 30000 },
        { deductionType: "child", amount: 60000 },
        { deductionType: "child", amount: 60000 },
      ],
      1000000
    );
    expect(res.totalOtherAllowance).toBe(150000);
    expect(res.warnings.length).toBe(0);
  });

  it("life_insurance เกิน 100,000 โดยไม่มีคู่สมรสไม่มีเงินได้ → cap ที่ 100,000 เป๊ะ", () => {
    const res = sumAndCapDeductions([{ deductionType: "life_insurance", amount: 150000 }], 1000000);
    expect(res.totalOtherAllowance).toBe(LIFE_INSURANCE_CAP);
    expect(res.warnings.length).toBe(1);
  });

  it("provident_fund เกิน 500,000 แต่ยังไม่ถึง 30% ของเงินได้ → cap ที่ 500,000", () => {
    // เงินได้ 3,000,000 → 30% = 900,000 (มากกว่า 500,000) → ใช้ 500,000 เป็นเพดาน
    const res = sumAndCapDeductions([{ deductionType: "provident_fund", amount: 600000 }], 3000000);
    expect(res.totalOtherAllowance).toBe(PROVIDENT_FUND_ABS_CAP);
    expect(res.warnings.length).toBe(1);
  });

  it("provident_fund — เงินได้ต่อปีต่ำจน 30% ของเงินได้ < 500,000 → cap ที่ 30% ของเงินได้แทน", () => {
    // เงินได้ 600,000 → 30% = 180,000 (น้อยกว่า 500,000) → ใช้ 180,000 เป็นเพดาน
    const income = 600000;
    const expectedCap = income * PROVIDENT_FUND_INCOME_RATIO;
    const res = sumAndCapDeductions([{ deductionType: "provident_fund", amount: 300000 }], income);
    expect(res.totalOtherAllowance).toBe(expectedCap);
    expect(res.warnings.length).toBe(1);
  });

  it("provident_fund ไม่เกิน cap ทั้งสองเกณฑ์ → ไม่มี warning ยอดผ่านตรง ๆ", () => {
    const res = sumAndCapDeductions([{ deductionType: "provident_fund", amount: 50000 }], 3000000);
    expect(res.totalOtherAllowance).toBe(50000);
    expect(res.warnings.length).toBe(0);
  });

  it("annualIncomeEstimate ≤0/ไม่ใช่ตัวเลข → provident_fund cap เป็น 0 ทันที (ไม่ throw)", () => {
    const res = sumAndCapDeductions([{ deductionType: "provident_fund", amount: 10000 }], 0);
    expect(res.totalOtherAllowance).toBe(0);
    expect(res.warnings.length).toBe(1);
    const resNeg = sumAndCapDeductions([{ deductionType: "provident_fund", amount: 10000 }], -500);
    expect(resNeg.totalOtherAllowance).toBe(0);
  });

  it("mortgage_interest เกิน 100,000 → cap ที่ 100,000 เป๊ะ", () => {
    const res = sumAndCapDeductions([{ deductionType: "mortgage_interest", amount: 250000 }], 1000000);
    expect(res.totalOtherAllowance).toBe(MORTGAGE_INTEREST_CAP);
    expect(res.warnings.length).toBe(1);
  });

  it("mortgage_interest ไม่เกิน cap → ไม่มี warning", () => {
    const res = sumAndCapDeductions([{ deductionType: "mortgage_interest", amount: 80000 }], 1000000);
    expect(res.totalOtherAllowance).toBe(80000);
    expect(res.warnings.length).toBe(0);
  });

  it("รวมหลายประเภทพร้อมกัน (ไม่มีปะทะกัน) → บวกรวมทุกประเภทหลัง cap ถูกต้อง", () => {
    const res = sumAndCapDeductions(
      [
        { deductionType: "spouse_no_income", amount: 60000 },
        { deductionType: "child", amount: 30000 },
        { deductionType: "mortgage_interest", amount: 50000 },
      ],
      1000000
    );
    expect(res.totalOtherAllowance).toBe(60000 + 30000 + 50000);
    expect(res.warnings.length).toBe(0);
  });

  it("ไม่มีแถวเลย → totalOtherAllowance=0, warnings=[] (ค่า default ของพนักงานที่ไม่ได้กรอกอะไรเลย)", () => {
    const res = sumAndCapDeductions([], 1000000);
    expect(res.totalOtherAllowance).toBe(0);
    expect(res.warnings).toEqual([]);
  });

  /**
   * ★★★ Golden test case (T157, 0.2 ★★★ gate) — verify ตัวเลขจากเอกสารทางการของกรมสรรพากรเอง:
   *
   *   "วิธีกรอกแบบแสดงรายการภาษีเงินได้บุคคลธรรมดา ปีภาษี 2568" (กรมสรรพากร, ปรับปรุงล่าสุด 2 ก.พ. 2569)
   *   https://www.rd.go.th/fileadmin/tax_pdf/pit/2568/Ins90_241268.pdf
   *   หัวข้อ "การกรอกรายการในใบแนบแสดงรายละเอียดรายการลดหย่อนและยกเว้นหลังจากหักค่าใช้จ่าย" ข้อ 7.2(2) —
   *   ตัวอย่างตัวเลขจริงที่เอกสารยกมา (อ้างตรงตัว):
   *
   *     "ผู้มีเงินได้มีเงินได้แต่คู่สมรสไม่มีเงินได้ ผู้มีเงินได้จ่ายเบี้ยประกันชีวิต 100,000 บาท คู่สมรสจ่าย
   *     เบี้ยประกันชีวิต 100,000 บาท ถ้าความเป็นคู่สมรสได้มีอยู่ตลอดปีภาษี ผู้มีเงินได้หักลดหย่อนและยกเว้น
   *     ภาษีสำหรับผู้มีเงินได้ 100,000 บาท และผู้มีเงินได้หักลดหย่อนคู่สมรส 10,000 บาท" — รวม 110,000 บาท
   *
   *   ระบบนี้ไม่แยกเก็บ "เบี้ยประกันชีวิตของผู้มีเงินได้เอง" กับ "ของคู่สมรส" เป็นคนละประเภท (deduction_type
   *   เดียวกันคือ life_insurance, นักบัญชีกรอกยอดรวมทั้งสองก้อน) — สิ่งที่ verify ได้ตรงคือ **ยอดรวมสุดท้าย
   *   หลัง cap ต้องตรงกับ 110,000 บาทตามตัวอย่างทางการ** เมื่อมีเงื่อนไข "คู่สมรสไม่มีเงินได้" (มี
   *   deduction_type='spouse_no_income' amount>0 อยู่ในชุดข้อมูลเดียวกัน) — ตรงตามที่ทดสอบด้านล่าง
   */
  it("★★★ golden test — ประกันชีวิต 100,000+100,000 (คู่สมรสไม่มีเงินได้) → cap ที่ 110,000 ตรงตามตัวอย่างทางการของกรมสรรพากร (rd.go.th, Ins90_241268.pdf ข้อ 7.2(2))", () => {
    const res = sumAndCapDeductions(
      [
        { deductionType: "spouse_no_income", amount: 60000 },
        // ผู้มีเงินได้จ่าย 100,000 + คู่สมรสจ่าย 100,000 = 200,000 รวมกันในชุดข้อมูลเดียว (ระบบไม่แยกฝ่าย)
        { deductionType: "life_insurance", amount: 200000 },
      ],
      1000000
    );
    // ยอดรวมของทั้ง 2 ประเภท = 60,000 (คู่สมรส, ไม่เกิน cap ไม่ตัด) + 110,000 (ประกันชีวิต, cap ขยับจาก
    // 100,000 → 110,000 เพราะมีคู่สมรสไม่มีเงินได้) = 170,000 — ส่วนย่อยของประกันชีวิตต้อง = 110,000 เป๊ะ
    // ตรงกับตัวอย่างทางการข้างต้น (verify แยกด้วยการคำนวณ isolate เฉพาะ life_insurance ด้านล่าง)
    const lifeInsuranceOnly = sumAndCapDeductions(
      [
        { deductionType: "spouse_no_income", amount: 60000 },
        { deductionType: "life_insurance", amount: 200000 },
      ],
      1000000
    ).totalOtherAllowance - 60000; // หัก spouse cap ออกเพื่อ isolate ยอดประกันชีวิตล้วน ๆ
    expect(lifeInsuranceOnly).toBe(LIFE_INSURANCE_CAP_WITH_SPOUSE);
    expect(lifeInsuranceOnly).toBe(110000);
    expect(res.totalOtherAllowance).toBe(60000 + 110000);
    expect(res.warnings.some((w) => w.includes("ประกันชีวิต"))).toBe(true);
  });

  it("golden test เดียวกัน แต่ไม่มีคู่สมรสไม่มีเงินได้ → cap ที่ 100,000 เท่านั้น (ไม่ขยับเป็น 110,000)", () => {
    const res = sumAndCapDeductions([{ deductionType: "life_insurance", amount: 200000 }], 1000000);
    expect(res.totalOtherAllowance).toBe(LIFE_INSURANCE_CAP);
    expect(res.totalOtherAllowance).toBe(100000);
  });
});
