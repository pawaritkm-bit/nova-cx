import { describe, it, expect } from "vitest";
import {
  expenseDeduction,
  calcAnnualTax,
  remainingPeriodsInYear,
  calcMonthlyPitForRegularIncome,
  calcSsoContribution,
  PERSONAL_ALLOWANCE_STANDARD,
} from "@/lib/accounting/payroll-tax";
import type { PitBracket } from "@/lib/accounting/payroll-config";

/**
 * เทสต์ lib/accounting/payroll-tax.ts (เฟส 9 ส่วน AD, T111/T113) — ★ จุดสำคัญที่สุดของเฟสนี้
 *   (เกี่ยวข้องกับเงินจริงของพนักงานลูกค้าโดยตรง)
 *
 * ★★★ 0.5 หมายเหตุสำคัญ — ไม่มี golden test ของ `calcMonthlyPitWithBonus` ในไฟล์นี้โดยตั้งใจ: ในรอบ
 *   implement นี้ไม่มีเครื่องมือค้นเว็บให้ verify ตัวอย่างคำนวณโบนัสตามคำสั่งกรมสรรพากร ทป.4/2528 กับแหล่ง
 *   อ้างอิงที่เชื่อถือได้จริงทันเวลา (T112 ยังไม่เสร็จ) — เลือกทางเลือก (ข) ตามที่เอกสารแผนระบุไว้: ไม่เขียน/
 *   ไม่ deploy engine โบนัสที่ยังไม่ verify เลย (ไม่มีฟังก์ชัน `calcMonthlyPitWithBonus` อยู่ใน payroll-tax.ts
 *   ด้วยซ้ำ) — ปฏิเสธ `bonus_amount > 0` ที่ชั้น validate ของ lib/accounting/payroll.ts แทน (ดูเทสต์ที่เกี่ยวข้อง
 *   ใน tests/accounting/payroll.test.ts) — เปิด backlog 9b ทำต่อเมื่อหาตัวอย่างอ้างอิงที่เชื่อถือได้จริงมาได้แล้ว
 */

// อัตราภาษีก้าวหน้า 8 ขั้นปัจจุบัน (ตรงกับ seed migration 0079) — ใช้ทดสอบ calcAnnualTax/calcMonthlyPit...
const BRACKETS: PitBracket[] = [
  { bracketOrder: 1, incomeFrom: 0, incomeTo: 150000, ratePercent: 0 },
  { bracketOrder: 2, incomeFrom: 150001, incomeTo: 300000, ratePercent: 5 },
  { bracketOrder: 3, incomeFrom: 300001, incomeTo: 500000, ratePercent: 10 },
  { bracketOrder: 4, incomeFrom: 500001, incomeTo: 750000, ratePercent: 15 },
  { bracketOrder: 5, incomeFrom: 750001, incomeTo: 1000000, ratePercent: 20 },
  { bracketOrder: 6, incomeFrom: 1000001, incomeTo: 2000000, ratePercent: 25 },
  { bracketOrder: 7, incomeFrom: 2000001, incomeTo: 5000000, ratePercent: 30 },
  { bracketOrder: 8, incomeFrom: 5000001, incomeTo: null, ratePercent: 35 },
];

describe("expenseDeduction", () => {
  it("รายได้ต่อปี 100,000 → หักได้ 50,000 (50%)", () => {
    expect(expenseDeduction(100000)).toBe(50000);
  });
  it("รายได้ต่อปี 200,000 → หักได้ 100,000 (คิด 50%=100,000 พอดีเท่าเพดาน)", () => {
    expect(expenseDeduction(200000)).toBe(100000);
  });
  it("รายได้ต่อปี 1,000,000 → หักได้ 100,000 (ชน cap ที่ 100,000)", () => {
    expect(expenseDeduction(1000000)).toBe(100000);
  });
  it("รายได้ ≤ 0 → 0", () => {
    expect(expenseDeduction(0)).toBe(0);
    expect(expenseDeduction(-500)).toBe(0);
  });
});

describe("calcAnnualTax — เทียบตัวอย่างคำนวณมือทุกขั้น (ไม่ใช่แค่ขั้นแรก/สุดท้าย)", () => {
  it("เงินได้สุทธิ 140,000 (ต่ำกว่าขั้นแรก) → ภาษี 0", () => {
    expect(calcAnnualTax(140000, BRACKETS)).toBe(0);
  });
  it("เงินได้สุทธิ 150,000 (พอดีเพดานขั้นแรก) → ภาษี 0", () => {
    expect(calcAnnualTax(150000, BRACKETS)).toBe(0);
  });
  it("เงินได้สุทธิ 200,000 (กลางขั้น 5%) → ภาษี 2,500", () => {
    expect(calcAnnualTax(200000, BRACKETS)).toBe(2500);
  });
  it("เงินได้สุทธิ 400,000 (กลางขั้น 10%) → ภาษี 17,500 (7,500 จากขั้น 5% + 10,000 จากขั้น 10%)", () => {
    expect(calcAnnualTax(400000, BRACKETS)).toBe(17500);
  });
  it("เงินได้สุทธิ 600,000 (กลางขั้น 15%) → ภาษี 7500+20000+15000=42,500", () => {
    // ขั้น1:0, ขั้น2(150k-300k):150000*5%=7500, ขั้น3(300k-500k):200000*10%=20000, ขั้น4(500k-600k):100000*15%=15000
    expect(calcAnnualTax(600000, BRACKETS)).toBe(42500);
  });
  it("เงินได้สุทธิ 900,000 (กลางขั้น 20%) → ภาษี 7500+20000+37500+30000=95,000", () => {
    expect(calcAnnualTax(900000, BRACKETS)).toBe(95000);
  });
  it("เงินได้สุทธิ 1,500,000 (กลางขั้น 25%) → คำนวณสะสมถูกต้อง", () => {
    // 0 + 7500 + 20000 + 37500 + 50000 + (500000*25%=125000) = 240000
    expect(calcAnnualTax(1500000, BRACKETS)).toBe(240000);
  });
  it("เงินได้สุทธิ 3,000,000 (กลางขั้น 30%) → คำนวณสะสมถูกต้อง", () => {
    // สะสมถึงขั้น 25% (income=2,000,000): 7500+20000+37500+50000+250000=365000
    // ขั้น 30% (2,000,000-3,000,000): 1,000,000*30%=300000 → รวม 665000
    expect(calcAnnualTax(3000000, BRACKETS)).toBe(665000);
  });
  it("เงินได้สุทธิ 6,000,000 (ขั้นสูงสุด ไม่มีเพดาน income_to=null) → ไม่ throw คำนวณได้ปกติ", () => {
    // สะสมถึงขั้น 30% (income=5,000,000): 365000 + (3,000,000*30%=900000) = 1,265,000
    // ขั้น 35% (5,000,000-6,000,000): 1,000,000*35%=350,000 → รวม 1,615,000
    expect(calcAnnualTax(6000000, BRACKETS)).toBe(1615000);
  });
  it("เงินได้สุทธิติดลบ/ผิดปกติ → ปฏิบัติเหมือน 0 (ไม่ throw)", () => {
    expect(calcAnnualTax(-1000, BRACKETS)).toBe(0);
    expect(calcAnnualTax(NaN, BRACKETS)).toBe(0);
  });
});

describe("remainingPeriodsInYear (0.4)", () => {
  it("พนักงานเก่า (start_date ปีก่อน) → 12 เสมอไม่ว่า pay_date เดือนไหน", () => {
    expect(remainingPeriodsInYear("2026-01-31", "2020-03-15")).toBe(12);
    expect(remainingPeriodsInYear("2026-12-31", "2020-03-15")).toBe(12);
  });
  it("ไม่มี start_date (null) → 12", () => {
    expect(remainingPeriodsInYear("2026-06-30", null)).toBe(12);
  });
  it("เข้าใหม่เดือน ก.ค. ปีเดียวกับ pay_date → 6 (ก.ค.-ธ.ค.)", () => {
    expect(remainingPeriodsInYear("2026-07-31", "2026-07-01")).toBe(6);
    expect(remainingPeriodsInYear("2026-12-15", "2026-07-05")).toBe(6);
  });
  it("เข้าใหม่เดือน ธ.ค. (เดือนสุดท้าย) → 1", () => {
    expect(remainingPeriodsInYear("2026-12-31", "2026-12-01")).toBe(1);
  });
  it("เข้าใหม่เดือน ม.ค. → 12 เท่ากับพนักงานเก่า", () => {
    expect(remainingPeriodsInYear("2026-01-31", "2026-01-15")).toBe(12);
  });
  it("start_date ปีหลัง pay_date (ข้อมูลผิดปกติ) → fallback 12 ไม่ throw", () => {
    expect(remainingPeriodsInYear("2026-01-01", "2027-01-01")).toBe(12);
  });
  it("รูปแบบวันที่ผิดปกติ → fallback 12 ไม่ throw", () => {
    expect(remainingPeriodsInYear("not-a-date", "2026-01-01")).toBe(12);
    expect(remainingPeriodsInYear("2026-01-01", "not-a-date")).toBe(12);
  });
});

describe("calcMonthlyPitForRegularIncome — golden test (T111)", () => {
  it("เงินเดือน 30,000/เดือน (=360,000/ปี), หักลดหย่อนมาตรฐานรวม 160,000 (ค่าใช้จ่าย 100,000 cap + ส่วนบุคคล 60,000) → เหลือ 200,000 → ภาษีปี 2,500 → ต่อเดือน 208.33", () => {
    const pit = calcMonthlyPitForRegularIncome(30000, 12, PERSONAL_ALLOWANCE_STANDARD, BRACKETS);
    expect(pit).toBe(208.33);
  });
  it("เงินเดือนต่ำกว่าเกณฑ์เสียภาษี (10,000/เดือน = 120,000/ปี) → ภาษี 0", () => {
    const pit = calcMonthlyPitForRegularIncome(10000, 12, PERSONAL_ALLOWANCE_STANDARD, BRACKETS);
    expect(pit).toBe(0);
  });
  it("เงินเดือนกลางขั้น 10% (50,000/เดือน = 600,000/ปี)", () => {
    // annual=600000, expense=min(300000,100000)=100000, allowance=60000, taxable=440000
    // tax = bracket2(150000*5%=7500)+bracket3(140000*10%=14000)=21500 → /12
    const pit = calcMonthlyPitForRegularIncome(50000, 12, PERSONAL_ALLOWANCE_STANDARD, BRACKETS);
    expect(pit).toBe(1791.67);
  });
  it("เงินเดือนสูง (150,000/เดือน = 1,800,000/ปี)", () => {
    // annual=1800000, expense cap 100000, allowance 60000, taxable=1640000
    // tax = 7500+20000+37500+50000 + (640000*25%=160000) = 275000 → /12 = 22916.6666.. → round 22916.67
    const pit = calcMonthlyPitForRegularIncome(150000, 12, PERSONAL_ALLOWANCE_STANDARD, BRACKETS);
    expect(pit).toBe(22916.67);
  });
  it("พนักงานเข้าใหม่กลางปี (periodsPerYear=6) — annualize ด้วย periods ไม่ใช่ 12", () => {
    // gross 30000, periods=6 → annual=180000, expense=min(90000,100000)=90000, allowance=60000
    // taxable=30000 → ต่ำกว่าขั้นแรก(150000) → tax ทั้งปี=0 → ต่อเดือน=0
    const pit = calcMonthlyPitForRegularIncome(30000, 6, PERSONAL_ALLOWANCE_STANDARD, BRACKETS);
    expect(pit).toBe(0);
  });
  it("grossThisPeriod ≤ 0 → 0 (ไม่ throw)", () => {
    expect(calcMonthlyPitForRegularIncome(0, 12, PERSONAL_ALLOWANCE_STANDARD, BRACKETS)).toBe(0);
    expect(calcMonthlyPitForRegularIncome(-100, 12, PERSONAL_ALLOWANCE_STANDARD, BRACKETS)).toBe(0);
  });
});

describe("calcSsoContribution (0.6)", () => {
  const configOld = { employeeRatePercent: 5, employerRatePercent: 5, wageFloor: 1650, wageCeiling: 15000 };
  const configNew = { employeeRatePercent: 5, employerRatePercent: 5, wageFloor: 1650, wageCeiling: 17500 };

  it("ค่าจ้างต่ำกว่า floor (1,650) → ใช้ floor เป็นฐาน", () => {
    const r = calcSsoContribution(500, configOld);
    expect(r.wageBase).toBe(1650);
    expect(r.employeeContribution).toBe(82.5);
    expect(r.employerContribution).toBe(82.5);
  });
  it("ค่าจ้างสูงกว่า ceiling เดิม (15,000) → ใช้ ceiling เป็นฐาน", () => {
    const r = calcSsoContribution(30000, configOld);
    expect(r.wageBase).toBe(15000);
    expect(r.employeeContribution).toBe(750);
    expect(r.employerContribution).toBe(750);
  });
  it("ค่าจ้างสูงกว่า ceiling ใหม่ (17,500 — ตั้งแต่ 1 ม.ค. 2569) → ใช้ ceiling ใหม่เป็นฐาน", () => {
    const r = calcSsoContribution(30000, configNew);
    expect(r.wageBase).toBe(17500);
    expect(r.employeeContribution).toBe(875);
    expect(r.employerContribution).toBe(875);
  });
  it("ค่าจ้างอยู่ระหว่าง floor-ceiling → ใช้ค่าจริง", () => {
    const r = calcSsoContribution(10000, configOld);
    expect(r.wageBase).toBe(10000);
    expect(r.employeeContribution).toBe(500);
    expect(r.employerContribution).toBe(500);
  });
  it("ค่าจ้าง = 0 (ไม่มีค่าจ้างงวดนี้) → ไม่มีเงินสมทบ (ไม่ clamp ขึ้น floor)", () => {
    const r = calcSsoContribution(0, configOld);
    expect(r).toEqual({ wageBase: 0, employeeContribution: 0, employerContribution: 0 });
  });
});
