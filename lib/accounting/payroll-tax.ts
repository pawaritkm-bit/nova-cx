/**
 * เครื่องคำนวณภาษีหัก ณ ที่จ่าย (มาตรา 50) + เงินสมทบประกันสังคม (มาตรา 33) — ★ pure ล้วน ไม่แตะ DB
 *   ทุกฟังก์ชันในไฟล์นี้ unit-test ได้ตรง ๆ (T111/T113)
 *
 * บริบท: เฟส 9 ส่วน AD (docs/06-accounting-features-roadmap.md, หมวด 0.4/0.5/0.6) — จุดที่สำคัญที่สุด
 *   ของเฟสนี้ เพราะกระทบเงินจริงของพนักงานลูกค้าโดยตรง
 *
 * ★★★ 0.5 สูตรภาษีโบนัส — **verify แล้ว เปิดใช้งานจริง** (T112 เสร็จ, แก้จากรอบก่อนที่อ้างอิงกฎหมายผิด):
 *   เดิมโค้ด/คอมเมนต์อ้างอิง "ทป.4/2528 ข้อ 3" ผิด — ข้อนั้นจริง ๆ คือเรื่องหักภาษี ณ ที่จ่าย 0.75% สำหรับ
 *   นิติบุคคลซื้อสินค้าเกษตร ไม่เกี่ยวกับโบนัส/เงินเดือนเลย (ยืนยันจาก rd.go.th + วิกิซอร์ซ อิสระ 2 แหล่ง) —
 *   กฎหมายที่ถูกต้องคือ **คำสั่งกรมสรรพากรที่ ป.96/2543 ข้อ 1(5)** เรื่อง "การคำนวณภาษีเงินได้บุคคลธรรมดา
 *   หัก ณ ที่จ่ายตามมาตรา 50(1) กรณีเงินได้พึงประเมินตามมาตรา 40(1)" ครอบคลุม "เงินได้พิเศษที่จ่ายเป็น
 *   ครั้งคราวระหว่างปี เช่น ค่าล่วงเวลา เงินโบนัส" (rd.go.th/3558.html) — ดูฟังก์ชัน `calcMonthlyPitWithBonus`
 *   ด้านล่าง + golden test ที่ verify ตัวเลขแล้วใน `payroll-tax.test.ts`
 *
 * ★ 0.4 คำนวณอิสระทุกงวดจากยอดของงวดนั้นเอง — ไม่ต้องเก็บ/อ้างอิงยอดสะสม (YTD) ข้ามงวด (ตรงตามวิธีที่กรม
 *   สรรพากรใช้จริงสำหรับเงินได้ประจำ) — periodsPerYear=12 คงที่สำหรับพนักงานเก่า, พนักงานเข้าใหม่กลางปี
 *   (start_date ปีเดียวกับ pay_date) ใช้ remainingPeriodsInYear = จำนวนเดือนจากเดือนที่เริ่มงานถึงธันวาคม
 * ★ [⚠️ FLAG] สูตร remainingPeriodsInYear อ้างอิงวิธีปฏิบัติที่พบทั่วไป — ควรให้นักบัญชีจริงยืนยันอีกรอบ
 *   ก่อนใช้กับลูกค้าจริงรายแรก (ระบุไว้ตามเอกสารแผน 0.4)
 */
import { round2 } from "@/lib/accounting/queries";
import type { PitBracket } from "@/lib/accounting/payroll-config";

/** เพดานค่าใช้จ่ายเหมา (มาตรา 42 ทวิ) — 50% ของเงินได้ แต่ไม่เกิน 100,000 บาทต่อปี */
export const EXPENSE_DEDUCTION_CAP = 100000;
/** ค่าลดหย่อนส่วนบุคคลมาตรฐาน (มาตรา 47(1)(ก)) — ทุกพนักงานได้รับเสมอไม่ว่าจะมีค่าลดหย่อนอื่นเพิ่มหรือไม่ */
export const PERSONAL_ALLOWANCE_STANDARD = 60000;

/**
 * ★★★ เฟส 9b กลุ่ม BE (docs/06-accounting-features-roadmap.md, หมวด 0.2 ★★★ gate, T153/T157) —
 *   สวิตช์เปิด/ปิดการนำค่าลดหย่อนภาษีอื่น (คู่สมรสไม่มีเงินได้/บุตร/ประกันชีวิต/PVD-RMF-กบข/ดอกเบี้ยกู้บ้าน,
 *   `payroll-deductions.ts::sumAndCapDeductions`) เข้าสูตรคำนวณภาษีหัก ณ ที่จ่ายจริงใน
 *   `payroll.ts::recalcRunLines`
 *
 *   `false` = ยังไม่เปิดใช้จริง (คงค่าเดิมตาม DoD, docs/06-accounting-features-roadmap.md:5416-5417 —
 *   engine ครบสมบูรณ์พร้อม flag=false ถือว่าปิดงานได้ตามปกติ ไม่ใช่ความล้มเหลว) — เหตุผลที่ยังไม่เปิด
 *   (พบโดย independent code reviewer รอบ QC, ยืนยันเป็นบั๊กจริง):
 *   1) golden test เดิมที่อ้างว่า "verify แล้ว" ยืนยันได้จริงแค่ 1 ใน 5 ประเภทค่าลดหย่อน (ไม่ใช่ตัวอย่างรวม
 *      หลายประเภทพร้อมกันตามที่ T157 ต้องการจริง ๆ)
 *   2) ที่สำคัญกว่านั้น พบ**บั๊กคำนวณจริง**ในสูตร life_insurance เดิม (เก็บเบี้ยประกันของผู้มีเงินได้เอง+
 *      คู่สมรสเป็นก้อนเดียวแล้วเดา cap จากยอดรวม — ผิดกฎหมายจริงเมื่อยอดไม่ได้แบ่งสัดส่วนตรงกับที่โค้ดสมมติ)
 *      ซึ่งบังเอิญ golden test เดิมจับไม่ได้เพราะใช้ตัวเลขที่สมมาตรเป๊ะ (100,000+100,000) — แก้แล้วใน
 *      `payroll-deductions.ts::sumAndCapDeductions` (แยก `life_insurance_self`/`life_insurance_spouse`
 *      cap อิสระคนละก้อน) แต่ยังต้อง verify เพิ่ม/ทดสอบกับนักบัญชีจริงอีกรอบก่อนเปิด flag นี้เป็น true
 *   ★ เมื่อ flag=false: personalAllowance ที่ใช้จริงยังเท่ากับ PERSONAL_ALLOWANCE_STANDARD เสมอ ไม่ว่า
 *   นักบัญชีจะกรอกข้อมูลใน `payroll_employee_deductions` ไว้เท่าไหร่ก็ตาม (แสดงเป็นแค่ "preview" ในหน้าจอ)
 *   — ไม่กระทบยอดภาษีของลูกค้าเดิมเลย (regression-safe)
 */
export let ENABLE_EXTRA_DEDUCTIONS_IN_PIT = false;

// ---------------------------------------------------------------------
// PIT (มาตรา 50) — annualize ต่องวด
// ---------------------------------------------------------------------

/** ค่าใช้จ่ายเหมา = min(เงินได้ต่อปี × 50%, 100,000) — 0 ถ้าเงินได้ ≤ 0/ไม่ใช่ตัวเลข */
export function expenseDeduction(annualIncome: number): number {
  if (!Number.isFinite(annualIncome) || annualIncome <= 0) return 0;
  return round2(Math.min(annualIncome * 0.5, EXPENSE_DEDUCTION_CAP));
}

/**
 * ภาษีเงินได้ทั้งปีตามอัตราก้าวหน้า (progressive) จากเงินได้สุทธิ — pure, ไม่ throw
 *   ★ ใช้ "ขอบเขตต่อเนื่อง" (running lower bound เริ่มที่ 0 ไล่ตาม incomeTo ของแต่ละขั้นตามลำดับ
 *   bracketOrder) แทนการใช้ `incomeFrom` ของแต่ละแถวตรง ๆ — ตาราง `pit_tax_brackets` เก็บ income_from
 *   ของขั้นที่ 2 เป็นต้นไปแบบ "+1 บาท" จากเพดานขั้นก่อนหน้า (เช่น 150,001 ต่อจาก 150,000) ตามรูปแบบตาราง
 *   ภาษีที่กรมสรรพากรเผยแพร่ทั่วไป — ถ้าใช้ income_from ตรง ๆ เป็นจุดตัดจะเกิดผลต่างปัดเศษ 1 บาทต่อขั้น
 *   (คลาดเคลื่อนจากตัวอย่างคำนวณมือมาตรฐานทุกกรณี) การไล่ตาม incomeTo ต่อเนื่องกันแก้ปัญหานี้เป๊ะ
 */
export function calcAnnualTax(taxableIncome: number, brackets: PitBracket[]): number {
  const income = Number.isFinite(taxableIncome) ? Math.max(taxableIncome, 0) : 0;
  const sorted = [...brackets].sort((a, b) => a.bracketOrder - b.bracketOrder);

  let tax = 0;
  let lower = 0;
  for (const b of sorted) {
    if (income <= lower) break;
    const upper = b.incomeTo === null ? Infinity : b.incomeTo;
    const taxableInBracket = Math.min(income, upper) - lower;
    if (taxableInBracket > 0) tax += taxableInBracket * (b.ratePercent / 100);
    lower = upper;
  }
  return round2(tax);
}

const MONTH_RE = /^(\d{4})-(\d{2})-\d{2}$/;

function yearMonthOf(iso: string): { year: number; month: number } | null {
  const m = MONTH_RE.exec(iso);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

/**
 * จำนวนงวดที่เหลือในปีนี้ (0.4) — ใช้เป็นตัวหาร annualize แทน 12 คงที่เมื่อพนักงานเข้าใหม่กลางปี
 *   - startDate เป็น null/ผิดรูปแบบ/ปีก่อนปีของ payDate → 12 เสมอ (พนักงานเก่า)
 *   - startDate ปีเดียวกับ payDate → เดือนธันวาคม(12) − เดือนที่เริ่มงาน + 1 (เช่น เริ่ม ก.ค. → 6, เริ่ม
 *     ธ.ค. → 1, เริ่ม ม.ค. → 12 เท่ากับพนักงานเก่า)
 *   - startDate อยู่ปีหลัง payDate (ข้อมูลผิดปกติ) → fallback 12 (ไม่ throw)
 */
export function remainingPeriodsInYear(payDate: string, startDate: string | null): number {
  const pay = yearMonthOf(payDate);
  if (!pay) return 12;
  if (!startDate) return 12;
  const start = yearMonthOf(startDate);
  if (!start) return 12;
  if (start.year !== pay.year) return 12;
  const remaining = 12 - start.month + 1;
  return remaining >= 1 && remaining <= 12 ? remaining : 12;
}

/**
 * ภาษีหัก ณ ที่จ่ายของงวดนี้ (เงินได้ประจำปกติเท่านั้น — ไม่รวมโบนัส, 0.4):
 *   annualEstimate = grossThisPeriod × periodsPerYear
 *   → หักค่าใช้จ่ายเหมา (expenseDeduction) → หักค่าลดหย่อนส่วนบุคคล (personalAllowance)
 *   → เงินได้สุทธิ (≥0) → calcAnnualTax ตามอัตราก้าวหน้า → หาร periodsPerYear = ภาษีที่หักงวดนี้
 *   ★ grossThisPeriod ควรเป็นเงินได้ประจำที่ต้อง annualize ทั้งหมด (เงินเดือนฐาน + ค่าตอบแทนประจำอื่น ๆ
 *   ของงวดนี้ เช่น ค่าคอมมิชชั่น) — ไม่รวมโบนัส/เงินได้ครั้งเดียว (คำนวณแยกตามคนละสูตร, 0.5 ยังไม่เปิดใช้)
 */
export function calcMonthlyPitForRegularIncome(
  grossThisPeriod: number,
  periodsPerYear: number,
  personalAllowance: number,
  brackets: PitBracket[],
  /** ★★★ 2026-08-12 (เฟส 9b BE follow-up) — เงินได้ที่ได้รับยกเว้นก่อนหักค่าใช้จ่าย (เช่น PVD ส่วนเกิน
   *   10,000 ตาม ภ.ง.ด.91) ต่างจาก personalAllowance ที่หักหลังค่าใช้จ่าย — default 0 (backward compatible
   *   กับผู้เรียกเดิมทั้งหมดที่ไม่มีแนวคิดนี้) ดูคอมเมนต์เต็มใน payroll-deductions.ts::sumAndCapDeductions */
  exemptIncome: number = 0
): number {
  const gross = Number.isFinite(grossThisPeriod) && grossThisPeriod > 0 ? grossThisPeriod : 0;
  const periods = Number.isFinite(periodsPerYear) && periodsPerYear > 0 ? periodsPerYear : 12;
  if (gross <= 0) return 0;

  const annualEstimate = round2(gross * periods);
  const exempt = Number.isFinite(exemptIncome) && exemptIncome > 0 ? Math.min(exemptIncome, annualEstimate) : 0;
  const incomeAfterExemption = round2(annualEstimate - exempt);
  const expense = expenseDeduction(incomeAfterExemption);
  const allowance = Number.isFinite(personalAllowance) && personalAllowance >= 0 ? personalAllowance : 0;
  const taxableIncome = Math.max(round2(incomeAfterExemption - expense - allowance), 0);
  const annualTax = calcAnnualTax(taxableIncome, brackets);
  return round2(annualTax / periods);
}

export type MonthlyPitWithBonusResult = {
  /** ภาษีเงินได้ประจำของงวดนี้ (ไม่รวมโบนัส) — เท่ากับ calcMonthlyPitForRegularIncome ทุกประการ (A/periods) */
  regularPit: number;
  /** ภาษีที่ต้องหักจากโบนัสงวดนี้ (B − A) — หักเต็มจำนวน ไม่หารด้วย periodsPerYear */
  bonusPit: number;
  /** ภาษีรวมที่ต้องหักงวดนี้ = regularPit + bonusPit */
  totalPit: number;
};

/**
 * ภาษีหัก ณ ที่จ่ายของงวดที่มีเงินได้พิเศษ/โบนัส (มาตรา 40(1)) — ตามคำสั่งกรมสรรพากรที่ **ป.96/2543 ข้อ 1(5)**
 *   (verify แล้ว, 0.5 — ดูคอมเมนต์เต็มด้านบนไฟล์เรื่องแก้การอ้างอิงกฎหมายที่ผิดจากรอบก่อน "ทป.4/2528"):
 *   1) A = ภาษีทั้งปีไม่รวมโบนัส — annualize ปกติเหมือน `calcMonthlyPitForRegularIncome` (ก่อนหารงวด)
 *   2) B = ภาษีทั้งปีอีกครั้งโดยรวมโบนัสเข้า annualEstimate **ก่อน**หักค่าใช้จ่ายเหมา/ค่าลดหย่อน (ใช้ชุด
 *      ลดหย่อนเดียวกันกับ A) — ★ ค่าใช้จ่ายเหมาคำนวณใหม่จาก annualEstimate ที่รวมโบนัสแล้ว (ผ่าน
 *      `expenseDeduction` ตรง ๆ — ไม่ได้ reuse ค่า A เดิม เพราะฐานเงินได้เปลี่ยนไป แม้ในทางปฏิบัติมักชนเพดาน
 *      100,000 เท่ากันทั้ง 2 กรณีเมื่อเงินได้สูงพอ)
 *   3) ภาษีจากโบนัส = B − A หักเต็มจำนวนในงวดที่จ่ายจริง (**ไม่หารด้วย periodsPerYear**)
 *   4) ภาษีรวมที่หักงวดนี้ = ภาษีเงินได้ประจำ (A/periods, หารงวดตามปกติ) + ภาษีจากโบนัส (ไม่หาร)
 *   ★ reuse `expenseDeduction`/`calcAnnualTax`/`calcMonthlyPitForRegularIncome` ล้วน — ไม่คำนวณภาษีก้าวหน้าซ้ำ
 *   ★ periodsPerYear เป็นตัวเดียวกับที่ใช้กับเงินได้ประจำ (รองรับ `remainingPeriodsInYear` ของพนักงานเข้าใหม่
 *   กลางปี, 0.4) — มีผลกับ regularPit เท่านั้น ส่วน bonusPit (B−A) ไม่ถูกหารด้วย periods เลยตามข้อ 1(5)
 *   ★ golden test case verify ตัวเลขแล้วใน payroll-tax.test.ts (อ้างอิงคำสั่ง ป.96/2543 ข้อ 1(5) +
 *   ตัวอย่างจำลองจาก hiperc.sru.ac.th)
 */
export function calcMonthlyPitWithBonus(
  grossThisPeriod: number,
  bonusAmount: number,
  periodsPerYear: number,
  personalAllowance: number,
  brackets: PitBracket[],
  /** ★★★ 2026-08-12 — ดูคอมเมนต์เต็มที่ calcMonthlyPitForRegularIncome (เงินได้ยกเว้นก่อนหักค่าใช้จ่าย
   *   เช่น PVD ส่วนเกิน 10,000) — เป็นยอดต่อปีคงที่ ไม่เปลี่ยนตามโบนัส จึงหักออกจากฐานทั้ง A และ B เท่ากัน */
  exemptIncome: number = 0
): MonthlyPitWithBonusResult {
  const gross = Number.isFinite(grossThisPeriod) && grossThisPeriod > 0 ? grossThisPeriod : 0;
  const bonus = Number.isFinite(bonusAmount) && bonusAmount > 0 ? bonusAmount : 0;
  const periods = Number.isFinite(periodsPerYear) && periodsPerYear > 0 ? periodsPerYear : 12;
  const allowance = Number.isFinite(personalAllowance) && personalAllowance >= 0 ? personalAllowance : 0;

  const regularPit = calcMonthlyPitForRegularIncome(gross, periods, allowance, brackets, exemptIncome);
  if (bonus <= 0) return { regularPit, bonusPit: 0, totalPit: regularPit };

  // A: ภาษีทั้งปีไม่รวมโบนัส (คำนวณตรง ๆ อีกครั้งเพื่อหาผลต่าง B−A ที่แม่นยำ — ไม่ derive จาก regularPit*periods
  //   ที่ปัดเศษไปแล้ว กัน error สะสมจากการปัดเศษซ้อน)
  const annualEstimateA = round2(gross * periods);
  const exempt = Number.isFinite(exemptIncome) && exemptIncome > 0 ? Math.min(exemptIncome, annualEstimateA) : 0;
  const incomeAfterExemptionA = round2(annualEstimateA - exempt);
  const taxableA = Math.max(round2(incomeAfterExemptionA - expenseDeduction(incomeAfterExemptionA) - allowance), 0);
  const annualTaxA = calcAnnualTax(taxableA, brackets);

  // B: รวมโบนัสเข้า annualEstimate ก่อนหักค่าใช้จ่าย/ลดหย่อน (ชุดลดหย่อนเดียวกัน) — exempt เดิม (ไม่เปลี่ยนตามโบนัส)
  const annualEstimateB = round2(annualEstimateA + bonus);
  const incomeAfterExemptionB = round2(annualEstimateB - exempt);
  const taxableB = Math.max(round2(incomeAfterExemptionB - expenseDeduction(incomeAfterExemptionB) - allowance), 0);
  const annualTaxB = calcAnnualTax(taxableB, brackets);

  const bonusPit = round2(annualTaxB - annualTaxA);
  return { regularPit, bonusPit, totalPit: round2(regularPit + bonusPit) };
}

// ---------------------------------------------------------------------
// ประกันสังคม (มาตรา 33, 0.6)
// ---------------------------------------------------------------------

export type SsoContributionResult = {
  /** ฐานค่าจ้างที่ใช้คำนวณจริง (หลัง clamp floor/ceiling) */
  wageBase: number;
  employeeContribution: number;
  employerContribution: number;
};

/**
 * เงินสมทบประกันสังคม (มาตรา 33) — clamp ค่าจ้างด้วย floor/ceiling ของ config ก่อนคำนวณ (0.6):
 *   - ค่าจ้างต่ำกว่า floor → ใช้ floor เป็นฐาน
 *   - ค่าจ้างสูงกว่า ceiling → ใช้ ceiling เป็นฐาน
 *   - อยู่ระหว่างกลาง → ใช้ค่าจริง
 */
export function calcSsoContribution(
  grossWage: number,
  config: { employeeRatePercent: number; employerRatePercent: number; wageFloor: number; wageCeiling: number }
): SsoContributionResult {
  const wage = Number.isFinite(grossWage) && grossWage > 0 ? grossWage : 0;
  // ★ ค่าจ้าง 0 (ไม่มีค่าจ้างงวดนี้เลย — ข้อมูลผิดปกติ/พนักงานไม่มีรายได้งวดนี้) → ไม่มีเงินสมทบ (ไม่ clamp
  //   ขึ้นไปที่ floor) ต่างจากกรณี "มีค่าจ้างจริงแต่ต่ำกว่า floor" (เช่น 500 บาท) ที่ยัง clamp ขึ้น floor ตามปกติ
  if (wage <= 0) return { wageBase: 0, employeeContribution: 0, employerContribution: 0 };
  const wageBase = Math.min(Math.max(wage, config.wageFloor), config.wageCeiling);
  return {
    wageBase: round2(wageBase),
    employeeContribution: round2(wageBase * (config.employeeRatePercent / 100)),
    employerContribution: round2(wageBase * (config.employerRatePercent / 100)),
  };
}

// ---------------------------------------------------------------------
// ★★★ เฟส 9b กลุ่ม BF — ค่าตอบแทนเลิกจ้าง/ชดเชย (docs 06, T158-T163) — เสี่ยงกฎหมายสูงสุดของเฟส 9b
//   ★★★ 0.2 ห้ามเปิดใช้เครื่องคำนวณภาษีชดเชย (ENABLE_SEVERANCE_TAX_CALC) กับเงินจริงจนกว่าจะมี golden
//   test ที่ verify กับแหล่งอ้างอิงที่เชื่อถือได้จริง (mirror T112 เดิม) — ดู payroll-tax.test.ts
// ---------------------------------------------------------------------

/**
 * T158 — อายุงานสำหรับ "จำนวนวันค่าชดเชยตามกฎหมายแรงงาน" (มาตรา 118 พ.ร.บ.คุ้มครองแรงงาน) ★ pure
 *   ★ 0.7 เครื่องคำนวณ**ช่วยเหลือ**เท่านั้น (ไม่บังคับ) — นักบัญชียังกรอก severance_amount เองได้เสมอ
 *   ★★ ตั้งใจสะกดชื่อ/พารามิเตอร์ต่างจาก `calcYearsOfServiceForTaxFormula` ชัดเจน (0.7) — ห้ามใช้ตัวแปรชื่อ
 *   `yearsOfService` เดี่ยว ๆ ปนกันทั้งสองความหมาย
 *   ★ รับ `fullYearsOfService` เป็นจำนวนปีแบบทศนิยม (เศษวันคิดเป็นเศษปี หาร 365) — จำเป็นต้องเป็นทศนิยม
 *   (ไม่ใช่จำนวนเต็มปี) เพราะขั้นบันไดแรกอยู่ที่ระดับ "วัน" (120 วัน = 120/365 ปี) ไม่ใช่ระดับปี — ผู้เรียกใช้
 *   (เช่น payroll.ts) แปลงจำนวนวันที่ทำงานจริงเป็นปีทศนิยมก่อนเรียกฟังก์ชันนี้
 *   ขั้นบันได (ม.118): <120วัน→0, 120วัน-<1ปี→30, 1-<3ปี→90, 3-<6ปี→180, 6-<10ปี→240, 10-<20ปี→300, ≥20ปี→400
 */
export function calcStatutorySeveranceDays(fullYearsOfService: number): number {
  const years = Number.isFinite(fullYearsOfService) && fullYearsOfService > 0 ? fullYearsOfService : 0;
  const days120AsYears = 120 / 365;
  if (years < days120AsYears) return 0;
  if (years < 1) return 30;
  if (years < 3) return 90;
  if (years < 6) return 180;
  if (years < 10) return 240;
  if (years < 20) return 300;
  return 400;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** แปลง YYYY-MM-DD → Date (UTC เที่ยงคืน) — คืน null ถ้าไม่ใช่วันที่ปฏิทินจริง (กัน 2026-02-30) */
function parseIsoDateUTC(iso: string): Date | null {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

/**
 * T159 — อายุงานสำหรับ "สูตรหักค่าใช้จ่ายทางภาษี" (มาตรา 48(5)) ★ pure
 *   [⚠️ FLAG] 0.7 — กติกาเศษปีนี้อ้างอิงหลักปฏิบัติทั่วไปของกรมสรรพากร (แนวเดียวกับการนับอายุงานสำหรับกองทุน
 *   สำรองเลี้ยงชีพ/บำเหน็จ) ต้องยืนยันกับตัวอย่างคำนวณจริงคู่กับ golden test (0.2) ก่อนเปิดใช้ ENABLE_SEVERANCE_
 *   TAX_CALC=true เช่นกัน ไม่ใช่แค่สูตรหลักของ calcSeveranceWithholding
 *
 *   จำนวนปีเต็มที่ทำงาน (นับแบบ "วันครบรอบปี" เหมือนอายุคน — ปีปฏิทินจริง ไม่ใช่ 365 วันคงที่) + เศษของปีที่
 *   เกิน 183 วัน ปัดขึ้นอีก 1 ปี — คืน 0 (ไม่ throw) ถ้าวันที่ผิดรูปแบบ/startDate ไม่ก่อนหน้า endDate
 */
export function calcYearsOfServiceForTaxFormula(startDate: string | null, endDate: string | null): number {
  if (!startDate || !endDate) return 0;
  const start = parseIsoDateUTC(startDate);
  const end = parseIsoDateUTC(endDate);
  if (!start || !end) return 0;
  if (end.getTime() <= start.getTime()) return 0;

  let fullYears = end.getUTCFullYear() - start.getUTCFullYear();
  let anniversary = new Date(Date.UTC(start.getUTCFullYear() + fullYears, start.getUTCMonth(), start.getUTCDate()));
  if (anniversary.getTime() > end.getTime()) {
    fullYears -= 1;
    anniversary = new Date(Date.UTC(start.getUTCFullYear() + fullYears, start.getUTCMonth(), start.getUTCDate()));
  }
  if (fullYears < 0) return 0;

  const remainderDays = Math.round((end.getTime() - anniversary.getTime()) / 86400000);
  if (remainderDays > 183) fullYears += 1;
  return fullYears;
}

/**
 * เงื่อนไขสิทธิ์แยกคำนวณภาษีตามมาตรา 48(5) — ต้องมีอายุงานตั้งแต่ 5 ปีขึ้นไปเท่านั้น (ยืนยันจาก "คำแนะนำการยื่น
 * ภ.ง.ด.90/91 ผ่านอินเทอร์เน็ต" กรมสรรพากร https://www.rd.go.th/61081.html) — ต่ำกว่านี้ต้องนำเงินส่วนที่ไม่ได้รับ
 * ยกเว้นไปรวมคำนวณกับเงินได้อื่นตามวิธีปกติ ไม่ควรเรียก calcSeveranceWithholding (สูตรมาตรา 48(5)) เลย — ระบบไม่
 * บล็อกการคำนวณ preview (ยังให้ดูตัวเลขได้เพื่อเป็นตัวช่วย) แต่ UI ต้องเตือนชัดเจนให้นักบัญชีตัดสินใจเอง (T165)
 */
export const SEVERANCE_SEPARATE_CALC_MIN_YEARS = 5;

export type SeveranceWithholdingResult = {
  /** ส่วนที่ได้รับยกเว้นภาษี (กฎกระทรวง 126 ข้อ 2(51) แก้ไข ฉบับ 394) */
  exemptAmount: number;
  /** ส่วนที่ต้องเสียภาษี (severanceAmount − exemptAmount) */
  taxableAmount: number;
  /** ค่าใช้จ่ายตามมาตรา 48(5) = min(7,000 × ปีทำงาน, taxableAmount) */
  expense: number;
  /** เงินได้หลังหักค่าใช้จ่าย (taxableAmount − expense) */
  remainder: number;
  /** เงินได้สุทธิที่ใช้คำนวณภาษี = remainder × 0.5 (ตามมาตรา 48(5)) */
  netTaxable: number;
  /** ภาษีที่ต้องหัก — คำนวณแยกอิสระจากเงินได้อื่นของปีนั้นทั้งหมด */
  tax: number;
};

/**
 * T162 — ภาษีหัก ณ ที่จ่ายของเงินได้จากการเลิกจ้าง (มาตรา 48(5)) ★ pure — ★★★ สูตรที่ 3 แยกจาก
 *   `calcMonthlyPitForRegularIncome`/`calcMonthlyPitWithBonus` โดยสิ้นเชิง (ไม่ reuse โครงสร้างเดิม เพราะ
 *   ฐานภาษี/ค่าใช้จ่ายที่ยกเว้นต่างกันโดยสิ้นเชิงตามมาตรา 48(5)):
 *   (1) dailyWage = finalMonthlyWage/30, exemptAmount = min(severanceAmount, dailyWage×400, 600,000)
 *       (กฎกระทรวง 126 ข้อ 2(51) แก้ไข ฉบับ 394)
 *   (2) taxableAmount = max(severanceAmount − exemptAmount, 0)
 *   (3) expense = min(7,000 × yearsOfServiceForTaxFormula, taxableAmount) (มาตรา 48(5))
 *   (4) remainder = taxableAmount − expense
 *   (5) netTaxable = remainder × 0.5
 *   (6) tax = calcAnnualTax(netTaxable, brackets) — ★★★ คำนวณแยกอิสระ ไม่รวมกับเงินได้อื่นของปีนั้นเลย
 *       (ตามมาตรา 48(5) ผู้มีเงินได้เลือกแยกคำนวณภาษีจากเงินได้ประเภทนี้โดยไม่ต้องนำไปรวมคำนวณกับเงินได้อื่น)
 *   ★ severanceAmount ≤ 0 → ทุกค่าเป็น 0 (ไม่ throw) · yearsOfServiceForTaxFormula=0 (ทำงานไม่ถึงปี) →
 *   expense=0 ไม่ throw (ยังคำนวณ exempt/tax ต่อได้ปกติ)
 */
/**
 * ★★★★★ แก้บั๊กจริงที่พบ 2026-08-12 — ยืนยันตรงจากเอกสารอบรมกรมสรรพากร RD19 หน้า 33
 * (https://interweb1.rd.go.th/publish/seminar/training/RD19.pdf, อ่านต้นฉบับ PDF ตรงเพื่อยืนยันคำพูด ไม่ใช่แค่
 * เชื่อคำสรุป): "เสียภาษี 5% ตั้งแต่บาทแรก หรือ 150,000 บาทแรกไม่ได้รับสิทธิยกเว้นภาษี" — เงินได้จากการเลิกจ้าง
 * (มาตรา 48(5)) **ไม่ได้รับสิทธิยกเว้นภาษีขั้นแรก (0-150,000 = 0%)** เหมือนเงินได้ทั่วไป — สูตรเดิมของ commit
 * ก่อนหน้าเรียก `calcAnnualTax` ด้วย brackets มาตรฐานตรงๆ (มีขั้น 0% ปนอยู่) ซึ่งผิดตามเอกสารนี้
 *
 * แปลงขั้นแรกให้ใช้อัตราเดียวกับขั้นที่สอง (ไม่ hardcode เปอร์เซ็นต์ตรง ๆ เพื่อให้ยังถูกต้องถ้าตารางภาษีมาตรฐาน
 * เปลี่ยนในอนาคต — อัตรา 5% ปัจจุบันมาจาก `pit_tax_brackets` bracketOrder=2 อยู่แล้ว) ส่วนขั้นที่ 2 เป็นต้นไป
 * (150,001+) **ยังคงอัตราเดิมทุกขั้นไม่ shift** — ตีความตามคำพูดตรงตัวที่มี (ระบุแค่ว่า "ขั้นแรกไม่ยกเว้น" ไม่ได้
 * บอกว่าตารางที่เหลือเลื่อนขึ้น) — ⚠️ ยังไม่พบตัวอย่างคำนวณเต็มรูปจากกรมสรรพากรที่มีตัวเลขยืนยันขั้นที่ 2 เป็น
 * ต้นไปด้วยความมั่นใจ 100% ต้อง verify เพิ่มก่อนเปิด ENABLE_SEVERANCE_TAX_CALC=true
 */
function toSeveranceBrackets(brackets: PitBracket[]): PitBracket[] {
  const sorted = [...brackets].sort((a, b) => a.bracketOrder - b.bracketOrder);
  const first = sorted[0];
  const second = sorted[1];
  if (!first || !second) return sorted;
  return sorted.map((b) => (b.bracketOrder === first.bracketOrder ? { ...b, ratePercent: second.ratePercent } : b));
}

export function calcSeveranceWithholding(
  severanceAmount: number,
  finalMonthlyWage: number,
  yearsOfServiceForTaxFormula: number,
  brackets: PitBracket[]
): SeveranceWithholdingResult {
  const severance = Number.isFinite(severanceAmount) && severanceAmount > 0 ? severanceAmount : 0;
  if (severance <= 0) {
    return { exemptAmount: 0, taxableAmount: 0, expense: 0, remainder: 0, netTaxable: 0, tax: 0 };
  }
  const wage = Number.isFinite(finalMonthlyWage) && finalMonthlyWage > 0 ? finalMonthlyWage : 0;
  const years =
    Number.isFinite(yearsOfServiceForTaxFormula) && yearsOfServiceForTaxFormula > 0 ? yearsOfServiceForTaxFormula : 0;

  const dailyWage = round2(wage / 30);
  const exemptAmount = round2(Math.min(severance, dailyWage * 400, 600000));
  const taxableAmount = round2(Math.max(severance - exemptAmount, 0));
  const expense = round2(Math.min(7000 * years, taxableAmount));
  const remainder = round2(Math.max(taxableAmount - expense, 0));
  const netTaxable = round2(remainder * 0.5);
  const tax = calcAnnualTax(netTaxable, toSeveranceBrackets(brackets));
  return { exemptAmount, taxableAmount, expense, remainder, netTaxable, tax };
}

/**
 * T163 — ★★★ 0.2 สวิตช์ปิด/เปิดเครื่องคำนวณภาษีค่าชดเชย — เปิดใช้แล้ว 2026-08-12 หลัง verify golden test
 *   ครบทุกขั้นของสูตรกับแหล่งอ้างอิงราชการโดยตรง (ตรวจสอบย้อนกลับได้ทุกจุด ไม่ใช่แค่บทความสรุป):
 *
 *   1. เพดานยกเว้น 600,000 บาท (กฎกระทรวง 126 ข้อ 2(51) แก้ไขฉบับ 394) — https://www.rd.go.th/2502.html
 *   2. ค่าใช้จ่าย 7,000×ปี แล้วหักอีก 50% (มาตรา 48(5)) — ข้อหารือกรมสรรพากรเลขที่ 0706/6342
 *      (https://www.rd.go.th/24379.html) + เงื่อนไขทำงาน ≥5 ปี — ประกาศอธิบดีกรมสรรพากรฉบับที่ 45
 *      (https://www.rd.go.th/3213.html) — บังคับเป็น hard-gate จริงใน recalcRunLines (ไม่ใช่แค่ UI warning)
 *   3. เศษปีเกิน 183 วันปัดขึ้น 1 ปี — ข้อหารือเลขที่ 0811/00140 (https://www.rd.go.th/23378.html)
 *   4. ★★★★★ ขั้นภาษีไม่มีขั้นยกเว้น 0-150,000 เหมือนเงินได้ทั่วไป — ยืนยันตรงจากเอกสารอบรมกรมสรรพากร RD19
 *      หน้า 33 (https://interweb1.rd.go.th/publish/seminar/training/RD19.pdf, ดาวน์โหลด+อ่านต้นฉบับ PDF ตรง
 *      ยืนยันคำพูดเป๊ะ: "เสียภาษี 5% ตั้งแต่บาทแรก หรือ 150,000 บาทแรกไม่ได้รับสิทธิยกเว้นภาษี") ประกอบกับตาราง
 *      อัตราภาษีทางการที่ยืนยันแยกว่าขั้น 0-150,000 มีอัตรานาม 5% เท่ากับขั้น 150,001-300,000 เพียงแต่ขั้นแรก
 *      ได้รับยกเว้นพิเศษสำหรับเงินได้ทั่วไปเท่านั้น (https://www.rd.go.th/59670.html) — เงินได้จากการเลิกจ้าง
 *      ไม่ได้รับยกเว้นพิเศษนี้ จึงตกกลับไปที่อัตรานาม 5% ปกติ (ดู `toSeveranceBrackets` ด้านบน)
 *   5. Golden test เต็มรูป (ยกเว้น→7,000×ปี→หัก50%→ภาษี) verify ร่วมกับผู้ใช้ 2 รอบ (รอบแรกคำนวณผิดที่ขั้น
 *      ภาษี ได้ 9,000 เพราะเข้าใจว่าขั้นที่ 2 เปลี่ยนเป็น 10% — แก้ไขแล้วด้วยหลักฐานตารางอัตราทางการข้างบน
 *      ยืนยันว่าขั้นที่ 2 เป็นต้นไปไม่ shift, คงอัตราเดิมทุกขั้น) → ผลลัพธ์สุดท้ายที่ verify แล้ว = **8,250 บาท**
 *      (ดู golden test ใน payroll-tax.test.ts ที่ทำซ้ำเคสนี้เป๊ะ)
 *
 *   ห้ามเปลี่ยนกลับเป็น false โดยไม่มีเหตุผลบันทึกไว้ (mirror T112 เดิม)
 */
export let ENABLE_SEVERANCE_TAX_CALC = true;
