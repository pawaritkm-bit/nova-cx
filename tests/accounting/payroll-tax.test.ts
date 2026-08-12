import { describe, it, expect } from "vitest";
import {
  expenseDeduction,
  calcAnnualTax,
  remainingPeriodsInYear,
  calcMonthlyPitForRegularIncome,
  calcMonthlyPitWithBonus,
  calcSsoContribution,
  calcStatutorySeveranceDays,
  calcYearsOfServiceForTaxFormula,
  calcSeveranceWithholding,
  ENABLE_SEVERANCE_TAX_CALC,
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

  /**
   * ★★★ Golden test (2026-08-12, แก้บั๊กสถาปัตยกรรม PVD 2 ขั้นตาม ภ.ง.ด.91 — ดูคอมเมนต์เต็มเหนือ
   * sumAndCapDeductions ใน payroll-deductions.ts) — พารามิเตอร์ exemptIncome ใหม่ต้องหักออกจากเงินได้
   * **ก่อน**คำนวณค่าใช้จ่ายมาตรา 42 ทวิ (ไม่ใช่หลัง) ยืนยันด้วย cross-check ทางคณิตศาสตร์ที่ไม่พึ่งพาสูตร
   * เดียวกันตรง ๆ: เงินได้ 180,000 + PVD 27,000 (ส่วนเกิน 10,000 = 17,000 เป็น exemptIncome, ส่วน 10,000
   * แรกเป็น allowance) ต้องได้ taxableIncome ก่อนหักส่วนบุคคล = 71,500 บาทเป๊ะ ตรงกับที่คำนวณตาม ภ.ง.ด.91:
   *   incomeAfterExemption = 180,000-17,000 = 163,000; expense = 163,000×50% = 81,500 (ไม่ชน cap 100,000)
   *   remainder = 163,000-81,500-10,000(allowance) = 71,500
   * เทียบเท่ากับเงินได้ 143,000 ไม่มี exemption/allowance เลย (0.5×143,000=71,500 พอดี เพราะ expense
   * เป็นเชิงเส้น 50% ตราบเท่าที่ยังไม่ชน cap 100,000/200,000): ทั้งสองทางต้องให้ annualTax เท่ากันเป๊ะ
   * (ผิดจากวิธีเดิมที่เอา PVD ทั้งก้อนไปเป็น allowance หลังหักค่าใช้จ่าย → ได้ remainder 63,000 ผิดไป 8,500)
   */
  it("★★★ golden test — exemptIncome หักก่อนค่าใช้จ่าย: เงินได้ 180,000+PVD ส่วนเกิน 17,000 ≡ เงินได้ 143,000 ไม่มี exempt/allowance เลย", () => {
    const withExemption = calcMonthlyPitForRegularIncome(180000, 1, 10000, BRACKETS, 17000);
    const equivalentDirect = calcMonthlyPitForRegularIncome(143000, 1, 0, BRACKETS, 0);
    expect(withExemption).toBe(equivalentDirect);
  });

  it("exemptIncome default=0 (ไม่ส่งพารามิเตอร์) → ผลลัพธ์เหมือนเดิมทุกประการ (backward compatible)", () => {
    const withoutParam = calcMonthlyPitForRegularIncome(50000, 12, PERSONAL_ALLOWANCE_STANDARD, BRACKETS);
    const withExplicitZero = calcMonthlyPitForRegularIncome(50000, 12, PERSONAL_ALLOWANCE_STANDARD, BRACKETS, 0);
    expect(withoutParam).toBe(withExplicitZero);
    expect(withoutParam).toBe(1791.67);
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

  /**
   * ★★★ Golden test (2026-08-12, แก้บั๊กสถาปัตยกรรม PVD) — exemptIncome ต้องหักออกจาก annualEstimate ของ
   * ทั้งฐาน A และ B ก่อนคำนวณค่าใช้จ่ายเสมอ (periods=1 → เทียบเท่าการหัก exemptIncome ออกจาก
   * grossThisPeriod ตรง ๆ ก่อนเรียกฟังก์ชันโดยไม่ส่ง exemptIncome เลย) — ยืนยันด้วย identity ทางพีชคณิต
   * ไม่ใช่แค่เลขที่จำลองไว้ตายตัว
   */
  it("★ exemptIncome หักจาก annualEstimate ก่อนเสมอ (ทั้ง A และ B) ≡ shift grossThisPeriod ลงตรง ๆ เมื่อ periods=1", () => {
    const withExemption = calcMonthlyPitWithBonus(180000, 15000, 1, 10000, BRACKETS, 17000);
    const equivalentDirect = calcMonthlyPitWithBonus(163000, 15000, 1, 10000, BRACKETS, 0);
    expect(withExemption).toEqual(equivalentDirect);
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

// =========================================================================
// ★★★ เฟส 9b กลุ่ม BF (T158-T163) — ค่าตอบแทนเลิกจ้าง/ชดเชย — เสี่ยงกฎหมายสูงสุดของเฟส 9b
// =========================================================================

describe("calcStatutorySeveranceDays (T158, มาตรา 118 — เครื่องคำนวณช่วยเหลือ ไม่บังคับ, 0.7)", () => {
  // ★ รับ fullYearsOfService เป็นปีทศนิยม (เศษวัน/365) — ทดสอบขอบเขต 119/120 วันด้วยการหารตรง ๆ
  it("119 วัน (119/365 ปี) → 0 (ต่ำกว่า 120 วัน)", () => {
    expect(calcStatutorySeveranceDays(119 / 365)).toBe(0);
  });
  it("120 วันพอดี (120/365 ปี) → 30", () => {
    expect(calcStatutorySeveranceDays(120 / 365)).toBe(30);
  });
  it("0.5 ปี (อยู่ในช่วง 120วัน-<1ปี) → 30", () => {
    expect(calcStatutorySeveranceDays(0.5)).toBe(30);
  });
  it("ครบ 1 ปีพอดี → 90 (ขั้น 1-<3ปี)", () => {
    expect(calcStatutorySeveranceDays(1)).toBe(90);
  });
  it("2 ปี (อยู่ในช่วง 1-<3ปี) → 90", () => {
    expect(calcStatutorySeveranceDays(2)).toBe(90);
  });
  it("ครบ 3 ปีพอดี → 180 (ขั้น 3-<6ปี)", () => {
    expect(calcStatutorySeveranceDays(3)).toBe(180);
  });
  it("5 ปี (อยู่ในช่วง 3-<6ปี) → 180", () => {
    expect(calcStatutorySeveranceDays(5)).toBe(180);
  });
  it("ครบ 6 ปีพอดี → 240 (ขั้น 6-<10ปี)", () => {
    expect(calcStatutorySeveranceDays(6)).toBe(240);
  });
  it("8 ปี (อยู่ในช่วง 6-<10ปี) → 240", () => {
    expect(calcStatutorySeveranceDays(8)).toBe(240);
  });
  it("ครบ 10 ปีพอดี → 300 (ขั้น 10-<20ปี)", () => {
    expect(calcStatutorySeveranceDays(10)).toBe(300);
  });
  it("15 ปี (อยู่ในช่วง 10-<20ปี) → 300", () => {
    expect(calcStatutorySeveranceDays(15)).toBe(300);
  });
  it("ครบ 20 ปีพอดี → 400 (ขั้นสูงสุด)", () => {
    expect(calcStatutorySeveranceDays(20)).toBe(400);
  });
  it("25 ปี (มากกว่า 20 ปี) → 400", () => {
    expect(calcStatutorySeveranceDays(25)).toBe(400);
  });
  it("0/ติดลบ/NaN → 0 (ไม่ throw)", () => {
    expect(calcStatutorySeveranceDays(0)).toBe(0);
    expect(calcStatutorySeveranceDays(-1)).toBe(0);
    expect(calcStatutorySeveranceDays(NaN)).toBe(0);
  });
});

describe("calcYearsOfServiceForTaxFormula (T159, มาตรา 48(5) — [⚠️ FLAG] ต้อง verify คู่ golden test ก่อนเปิด flag, 0.7)", () => {
  it("ทำงานพอดี 3 ปี 0 วัน → 3 (ไม่ปัดขึ้น)", () => {
    expect(calcYearsOfServiceForTaxFormula("2020-01-01", "2023-01-01")).toBe(3);
  });
  it("ทำงาน 3 ปี 100 วัน (ไม่เกิน 183 วัน) → 3 (ไม่ปัดขึ้น)", () => {
    expect(calcYearsOfServiceForTaxFormula("2020-01-01", "2023-04-11")).toBe(3);
  });
  it("ทำงาน 3 ปี 183 วันพอดี (ขอบเขต — ไม่เกิน) → 3 (ไม่ปัดขึ้น)", () => {
    expect(calcYearsOfServiceForTaxFormula("2020-01-01", "2023-07-03")).toBe(3);
  });
  it("ทำงาน 3 ปี 184 วัน (เกิน 183 วันพอดี 1 วัน) → 4 (ปัดขึ้น)", () => {
    expect(calcYearsOfServiceForTaxFormula("2020-01-01", "2023-07-04")).toBe(4);
  });
  it("ทำงาน 3 ปี 200 วัน (เกิน 183 วัน) → 4 (ปัดขึ้น)", () => {
    expect(calcYearsOfServiceForTaxFormula("2020-01-01", "2023-07-20")).toBe(4);
  });
  it("ทำงานไม่ถึง 1 ปี (5 เดือน) → 0", () => {
    expect(calcYearsOfServiceForTaxFormula("2023-01-01", "2023-06-01")).toBe(0);
  });
  it("startDate/endDate เป็น null → 0 (ไม่ throw)", () => {
    expect(calcYearsOfServiceForTaxFormula(null, "2023-01-01")).toBe(0);
    expect(calcYearsOfServiceForTaxFormula("2020-01-01", null)).toBe(0);
  });
  it("endDate ก่อนหน้า startDate (ข้อมูลผิดปกติ) → 0 ไม่ throw", () => {
    expect(calcYearsOfServiceForTaxFormula("2020-01-01", "2019-12-31")).toBe(0);
  });
  it("รูปแบบวันที่ผิดปกติ → 0 ไม่ throw", () => {
    expect(calcYearsOfServiceForTaxFormula("not-a-date", "2023-01-01")).toBe(0);
  });
});

describe("calcSeveranceWithholding (T162, มาตรา 48(5) — ★★★ self-consistent, [⚠️ FLAG] ต้อง verify golden test ก่อนเปิด flag)", () => {
  it("severanceAmount ≤ 0 → ทุกค่าเป็น 0 (ไม่ throw)", () => {
    const r = calcSeveranceWithholding(0, 30000, 5, BRACKETS);
    expect(r).toEqual({ exemptAmount: 0, taxableAmount: 0, expense: 0, remainder: 0, netTaxable: 0, tax: 0 });
    const r2 = calcSeveranceWithholding(-1000, 30000, 5, BRACKETS);
    expect(r2.tax).toBe(0);
  });

  it("severanceAmount ต่ำกว่า exempt cap ทั้งหมด (dailyWage×400 และ 600,000) → exempt เต็มจำนวน → tax=0", () => {
    // finalMonthlyWage=100000 → dailyWage=3333.33 → ×400=1,333,333.33 (สูงกว่า severance และ 600,000 มาก)
    const r = calcSeveranceWithholding(300000, 100000, 5, BRACKETS);
    expect(r.exemptAmount).toBe(300000);
    expect(r.taxableAmount).toBe(0);
    expect(r.expense).toBe(0);
    expect(r.tax).toBe(0);
  });

  it("yearsOfServiceForTaxFormula=0 (ทำงานไม่ถึงปี) → expense=0 ไม่ throw ยังคำนวณภาษีต่อได้ปกติ", () => {
    // finalMonthlyWage=30000 → dailyWage=1000 → ×400=400,000 (cap ที่ 400,000 เพราะน้อยกว่า 600,000)
    // severance=450,000 → exempt=min(450000,400000,600000)=400000 → taxable=50000 → expense=min(0,50000)=0
    // remainder=50000 → netTaxable=25000 → มาตรา 48(5) ไม่มีขั้นยกเว้น 0-150,000 (ยืนยัน 2026-08-12, ดูคอมเมนต์
    // เต็มเหนือ ENABLE_SEVERANCE_TAX_CALC) → ขั้นแรกใช้อัตรา 5% → tax = 25,000×5% = 1,250
    const r = calcSeveranceWithholding(450000, 30000, 0, BRACKETS);
    expect(r.exemptAmount).toBe(400000);
    expect(r.taxableAmount).toBe(50000);
    expect(r.expense).toBe(0);
    expect(r.remainder).toBe(50000);
    expect(r.netTaxable).toBe(25000);
    expect(r.tax).toBe(1250);
  });

  it("exemptAmount ชนเพดาน 600,000 (dailyWage×400 สูงกว่า 600,000) → ใช้ 600,000 เป็นตัวคุม", () => {
    // finalMonthlyWage=60000 → dailyWage=2000 → ×400=800,000 (สูงกว่า 600,000) → exempt cap ที่ 600,000
    const r = calcSeveranceWithholding(700000, 60000, 5, BRACKETS);
    expect(r.exemptAmount).toBe(600000);
    expect(r.taxableAmount).toBe(100000);
    expect(r.expense).toBe(35000); // min(7000*5=35000, 100000)
    expect(r.remainder).toBe(65000);
    expect(r.netTaxable).toBe(32500);
    expect(r.tax).toBe(1625); // 32,500×5% (มาตรา 48(5) ไม่มีขั้นยกเว้น — ยืนยัน 2026-08-12)
  });

  it("severanceAmount สูงเกิน exempt cap มาก → ส่วนเกินเข้าสูตรภาษี 6 ขั้นถูกต้องตามลำดับ (self-consistent เทียบมือ)", () => {
    // finalMonthlyWage=30000 → dailyWage=1000 → ×400=400,000 (cap ที่ 400,000)
    // severance=2,000,000 → exempt=400,000 → taxable=1,600,000
    // years=10 → expense=min(70,000,1,600,000)=70,000 → remainder=1,530,000 → netTaxable=765,000
    // มาตรา 48(5) ไม่มีขั้นยกเว้น 0-150,000 (ยืนยัน 2026-08-12) — ขั้นแรกใช้อัตรา 5% เหมือนขั้นที่สอง:
    // tax(765,000) = 7,500(0-150k@5%) + 7,500(150k-300k@5%) + 20,000(300k-500k@10%) + 37,500(500k-750k@15%)
    //   + 3,000(750k-765k@20%, 15,000*20%) = 75,500
    const r = calcSeveranceWithholding(2000000, 30000, 10, BRACKETS);
    expect(r.exemptAmount).toBe(400000);
    expect(r.taxableAmount).toBe(1600000);
    expect(r.expense).toBe(70000);
    expect(r.remainder).toBe(1530000);
    expect(r.netTaxable).toBe(765000);
    expect(r.tax).toBe(75500);
  });

  it("finalMonthlyWage ≤ 0/ผิดปกติ → dailyWage=0 → exemptAmount cap ที่ 0 (ไม่ throw, ยกเว้นได้แค่ 0)", () => {
    const r = calcSeveranceWithholding(100000, 0, 5, BRACKETS);
    expect(r.exemptAmount).toBe(0);
    expect(r.taxableAmount).toBe(100000);
  });
});

describe("ENABLE_SEVERANCE_TAX_CALC (T163, ★★★ 0.2 gate) — เปิดใช้แล้ว 2026-08-12 หลัง verify golden test", () => {
  it("ต้องเป็น true หลังจาก golden test ครบทุกขั้นของสูตร verify กับแหล่งอ้างอิงราชการโดยตรงแล้ว (ดูคอมเมนต์เต็มใน payroll-tax.ts)", () => {
    expect(ENABLE_SEVERANCE_TAX_CALC).toBe(true);
  });
});

describe("★★★★★ Golden test — เงินได้จากการเลิกจ้าง (มาตรา 48(5)) verify 2026-08-12", () => {
  it("ยืนยันด้วยกันกับผู้ใช้ 2 รอบ — ค่าชดเชย 1,000,000 บาท ทำงาน 10 ปี เงินเดือนสุดท้าย ≥20,000/เดือน → ภาษี 8,250 บาท เป๊ะ", () => {
    // อ้างอิง: กฎกระทรวง 126 ข้อ 2(51) แก้ไขฉบับ 394 (เพดานยกเว้น 600,000), ข้อหารือ 0706/6342 (7,000×ปี, หัก50%),
    // เอกสารอบรม RD19 หน้า 33 (ไม่มีขั้นยกเว้น 0-150,000) + ตารางอัตราภาษี rd.go.th/59670.html (ยืนยันขั้น 2
    // เป็นต้นไปไม่ shift, คงอัตราเดิม) — ทั้งสองแหล่งยืนยันตรงจาก PDF/เพจจริง ไม่ใช่แค่บทความสรุป
    const brackets: PitBracket[] = [
      { bracketOrder: 1, incomeFrom: 0, incomeTo: 150000, ratePercent: 0 },
      { bracketOrder: 2, incomeFrom: 150001, incomeTo: 300000, ratePercent: 5 },
      { bracketOrder: 3, incomeFrom: 300001, incomeTo: 500000, ratePercent: 10 },
      { bracketOrder: 4, incomeFrom: 500001, incomeTo: 750000, ratePercent: 15 },
      { bracketOrder: 5, incomeFrom: 750001, incomeTo: 1000000, ratePercent: 20 },
      { bracketOrder: 6, incomeFrom: 1000001, incomeTo: 2000000, ratePercent: 25 },
      { bracketOrder: 7, incomeFrom: 2000001, incomeTo: 5000000, ratePercent: 30 },
      { bracketOrder: 8, incomeFrom: 5000001, incomeTo: null, ratePercent: 35 },
    ];
    const severanceAmount = 1000000;
    const finalMonthlyWage = 45000; // dailyWage×400 = 1500×400 = 600,000 ≥ severanceAmount ส่วนเกิน → exempt เต็มเพดาน 600,000
    const years = 10;
    const r = calcSeveranceWithholding(severanceAmount, finalMonthlyWage, years, brackets);
    expect(r.exemptAmount).toBe(600000);
    expect(r.taxableAmount).toBe(400000);
    expect(r.expense).toBe(70000); // 7,000×10
    expect(r.remainder).toBe(330000);
    expect(r.netTaxable).toBe(165000); // 330,000×50%
    expect(r.tax).toBe(8250); // 150,000×5% + 15,000×5% = 8,250 (ไม่ใช่ 9,000 ที่คำนวณผิดรอบแรกโดยเข้าใจว่าขั้น 2 เป็น 10%)
  });
});
