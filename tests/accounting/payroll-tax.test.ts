import { describe, it, expect } from "vitest";
import {
  expenseDeduction,
  calcAnnualTax,
  remainingPeriodsInYear,
  calcMonthlyPitForRegularIncome,
  calcMonthlyPitWithBonus,
  calcSsoContribution,
  PERSONAL_ALLOWANCE_STANDARD,
} from "@/lib/accounting/payroll-tax";
import type { PitBracket } from "@/lib/accounting/payroll-config";

/**
 * เทสต์ lib/accounting/payroll-tax.ts (เฟส 9 ส่วน AD, T111/T112/T113) — ★ จุดสำคัญที่สุดของเฟสนี้
 *   (เกี่ยวข้องกับเงินจริงของพนักงานลูกค้าโดยตรง)
 *
 * ★★★ 0.5 หมายเหตุ (T112 — verify แล้ว): golden test ของ `calcMonthlyPitWithBonus` อยู่ในบล็อกด้านล่างสุด
 *   ของไฟล์นี้ — เดิมโค้ด/คอมเมนต์อ้างอิงกฎหมายผิดเป็น "ทป.4/2528 ข้อ 3" (จริง ๆ คือเรื่องหักภาษี ณ ที่จ่าย
 *   0.75% ซื้อสินค้าเกษตร ไม่เกี่ยวกับโบนัส) — กฎหมายที่ถูกต้องคือคำสั่งกรมสรรพากรที่ **ป.96/2543 ข้อ 1(5)**
 *   (rd.go.th/3558.html) — ตัวอย่างคำนวณอ้างอิงจากเอกสารประกอบการสอนของมหาวิทยาลัยราชภัฏสุราษฎร์ธานี
 *   (hiperc.sru.ac.th) ที่จำลองตัวอย่างทางการของ ป.96/2543 ด้วยอัตรา/ค่าลดหย่อนปัจจุบันหลังปฏิรูป 2560 —
 *   ตรวจทานคณิตศาสตร์ภายในตัวเองแล้วถูกต้อง 100% (โครงสร้างตรงกับตัวอย่างทางการของ ป.96/2543 ทุกประการ)
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

describe("calcMonthlyPitWithBonus — golden test (T112, 0.5, verify แล้ว)", () => {
  /**
   * ★★★ Golden test case — ยืนยันตัวเลขจากเอกสารสอนบัญชี hiperc.sru.ac.th ที่จำลองตัวอย่างทางการของคำสั่ง
   *   กรมสรรพากรที่ **ป.96/2543 ข้อ 1(5)** ("การคำนวณภาษีเงินได้บุคคลธรรมดาหัก ณ ที่จ่ายตามมาตรา 50(1) กรณี
   *   เงินได้พึงประเมินตามมาตรา 40(1) — เงินได้พิเศษที่จ่ายเป็นครั้งคราวระหว่างปี เช่น ค่าล่วงเวลา เงินโบนัส")
   *   ด้วยอัตรา/ค่าลดหย่อนปัจจุบันหลังปฏิรูป 2560 (rd.go.th/3558.html ยืนยันตัวบทกฎหมาย, hiperc.sru.ac.th
   *   ยืนยันตัวอย่างคำนวณ — ตรวจทานคณิตศาสตร์ภายในตัวเองแล้วถูกต้อง 100%):
   *   - เงินเดือน 60,000/เดือน (ปีละ 720,000), ค่าลดหย่อนรวม 360,000, ค่าใช้จ่ายเหมา 100,000 (เพดานปัจจุบัน)
   *   - A (ไม่มีโบนัส): 720,000−100,000−360,000 = 260,000 → ภาษี = 150,000×0%+110,000×5% = 5,500
   *   - B (โบนัส 90,000 เดือนมีนาคม): (720,000+90,000)−100,000−360,000 = 350,000
   *     → ภาษี = 150,000×0%+150,000×5%+50,000×10% = 12,500
   *   - ภาษีจากโบนัส = B−A = 12,500−5,500 = 7,000 (หักเต็มจำนวน ไม่หารงวด)
   *   - ภาษีที่หักเดือนมีนาคม = 458.33 (ปกติ, 5,500/12) + 7,000 (โบนัส) = 7,458.33
   *   ★ ห้ามปรับตัวเลขในเทสต์นี้ให้ตรงกับผล implementation — ถ้าไม่ตรงกันต้องตรวจ logic ของ
   *   calcMonthlyPitWithBonus/calcAnnualTax/expenseDeduction ก่อนเสมอ
   */
  const allowance = 360000; // ค่าลดหย่อนรวมของตัวอย่าง (ผู้มีเงินได้+คู่สมรส+บุตร 3 คน+ประกันชีวิต+เลี้ยงดูบุพการี+ประกันสุขภาพบุพการี)

  it("A (ไม่มีโบนัส) — เงินเดือน 60,000/เดือน → ภาษีทั้งปี 5,500 → ต่อเดือน 458.33", () => {
    const pit = calcMonthlyPitForRegularIncome(60000, 12, allowance, BRACKETS);
    expect(pit).toBe(458.33);
  });

  it("golden case หลัก — เดือนมีนาคมมีโบนัส 90,000 → regularPit=458.33, bonusPit=7,000, totalPit=7,458.33", () => {
    const r = calcMonthlyPitWithBonus(60000, 90000, 12, allowance, BRACKETS);
    expect(r.regularPit).toBe(458.33);
    expect(r.bonusPit).toBe(7000);
    expect(r.totalPit).toBe(7458.33);
  });

  it("เดือนอื่นที่ไม่มีโบนัส (bonus=0) → totalPit เท่ากับ regularPit เป๊ะ ไม่ถูกกระทบจากโบนัสเดือนอื่น", () => {
    const r = calcMonthlyPitWithBonus(60000, 0, 12, allowance, BRACKETS);
    expect(r.regularPit).toBe(458.33);
    expect(r.bonusPit).toBe(0);
    expect(r.totalPit).toBe(458.33);
  });

  it("bonus ติดลบ/ผิดปกติ → ปฏิบัติเหมือนไม่มีโบนัส (ไม่ throw)", () => {
    const r = calcMonthlyPitWithBonus(60000, -1000, 12, allowance, BRACKETS);
    expect(r.bonusPit).toBe(0);
    expect(r.totalPit).toBe(458.33);
  });

  it("★ edge case: พนักงานเข้าใหม่กลางปี (periods=6) ได้โบนัสด้วย — bonusPit ไม่หารด้วย periods, regularPit หารด้วย periods", () => {
    // gross=100,000/เดือน, periods=6 (เข้าใหม่ ก.ค.), allowance=60,000 (มาตรฐาน), bonus=100,000
    // A: annual=600,000, expense=min(300,000,100,000)=100,000, taxable=600,000-100,000-60,000=440,000
    //    tax = 150,000*0% + 150,000*5%(7,500) + 140,000*10%(14,000) = 21,500 → regularPit = 21,500/6 = 3,583.33
    // B: annualB=700,000, expenseB=min(350,000,100,000)=100,000, taxableB=700,000-100,000-60,000=540,000
    //    tax = 7,500 + 200,000*10%(20,000) + 40,000*15%(6,000) = 33,500 (ข้ามขั้น 10%→15%)
    // bonusPit = 33,500-21,500 = 12,000 (ไม่หารด้วย periods=6) → totalPit = 3,583.33+12,000 = 15,583.33
    const r = calcMonthlyPitWithBonus(100000, 100000, 6, PERSONAL_ALLOWANCE_STANDARD, BRACKETS);
    expect(r.regularPit).toBe(3583.33);
    expect(r.bonusPit).toBe(12000);
    expect(r.totalPit).toBe(15583.33);
  });

  it("★ edge case: โบนัสทำให้ยอดคาบเกี่ยวข้ามขั้นภาษี (พนักงานเก่า periods=12)", () => {
    // gross=50,000/เดือน (annual=600,000), allowance=60,000, bonus=100,000
    // A: taxable=600,000-100,000-60,000=440,000 → tax=7,500+14,000=21,500 → regularPit=21,500/12=1,791.67
    // B: annualB=700,000, taxableB=700,000-100,000-60,000=540,000 → tax=7,500+20,000+6,000=33,500 (ข้ามขั้น 10%→15%)
    // bonusPit=33,500-21,500=12,000 → totalPit=1,791.67+12,000=13,791.67
    const r = calcMonthlyPitWithBonus(50000, 100000, 12, PERSONAL_ALLOWANCE_STANDARD, BRACKETS);
    expect(r.regularPit).toBe(1791.67);
    expect(r.bonusPit).toBe(12000);
    expect(r.totalPit).toBe(13791.67);
  });

  it("gross ≤ 0 (แต่มีโบนัส) → regularPit=0, bonusPit คำนวณจากฐาน 0 บวกโบนัสเท่านั้น", () => {
    const r = calcMonthlyPitWithBonus(0, 90000, 12, PERSONAL_ALLOWANCE_STANDARD, BRACKETS);
    expect(r.regularPit).toBe(0);
    // annualEstimateA=0 (gross<=0), taxableA=0 → annualTaxA=0
    // annualEstimateB=0+90000=90000, expenseB=min(45000,100000)=45000, taxableB=max(90000-45000-60000,0)=0
    // bonusPit = 0-0 = 0
    expect(r.bonusPit).toBe(0);
    expect(r.totalPit).toBe(0);
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
