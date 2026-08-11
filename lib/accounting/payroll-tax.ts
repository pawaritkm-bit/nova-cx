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
 *   `true` = เปิดใช้จริงแล้ว — เงื่อนไขที่ทำให้เปิดได้ (0.2 ข้อ 4, verify แล้ว, T157): เพดานค่าลดหย่อนทุก
 *   ประเภทที่ระบบใช้ (SPOUSE_NO_INCOME_CAP/CHILD_ALLOWANCE_AMOUNTS/LIFE_INSURANCE_CAP(_WITH_SPOUSE)/
 *   PROVIDENT_FUND_ABS_CAP+INCOME_RATIO/MORTGAGE_INTEREST_CAP ใน payroll-deductions.ts) ตรวจสอบแล้วตรงกับ
 *   "วิธีกรอกแบบแสดงรายการภาษีเงินได้บุคคลธรรมดา ปีภาษี 2568" ที่กรมสรรพากรเผยแพร่เอง (rd.go.th/fileadmin/
 *   tax_pdf/pit/2568/Ins90_241268.pdf) รวมถึงตัวอย่างตัวเลขจริงกรณีประกันชีวิต+คู่สมรสไม่มีเงินได้ (110,000
 *   บาท) ที่ golden test ใน payroll-deductions.test.ts ใช้ตรง ๆ (ดูคอมเมนต์เต็มใน
 *   payroll-deductions.ts::sumAndCapDeductions) — ห้ามเปลี่ยนกลับเป็น false โดยไม่มีเหตุผลบันทึกไว้
 *   ★ ถึงแม้ flag=true แล้ว การไม่มีแถวใน `payroll_employee_deductions` ของพนักงาน/ปีภาษีใดเลย (ค่า
 *   default ของทุกคนก่อนนักบัญชีกรอกเพิ่ม) ทำให้ personalAllowance ยังเท่ากับ PERSONAL_ALLOWANCE_STANDARD
 *   เป๊ะเหมือนก่อนเฟสนี้ — ไม่กระทบยอดภาษีของลูกค้าเดิมที่ไม่มีใครกรอกข้อมูลเพิ่มเลย (regression-safe)
 */
export let ENABLE_EXTRA_DEDUCTIONS_IN_PIT = true;

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
  brackets: PitBracket[]
): number {
  const gross = Number.isFinite(grossThisPeriod) && grossThisPeriod > 0 ? grossThisPeriod : 0;
  const periods = Number.isFinite(periodsPerYear) && periodsPerYear > 0 ? periodsPerYear : 12;
  if (gross <= 0) return 0;

  const annualEstimate = round2(gross * periods);
  const expense = expenseDeduction(annualEstimate);
  const allowance = Number.isFinite(personalAllowance) && personalAllowance >= 0 ? personalAllowance : 0;
  const taxableIncome = Math.max(round2(annualEstimate - expense - allowance), 0);
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
  brackets: PitBracket[]
): MonthlyPitWithBonusResult {
  const gross = Number.isFinite(grossThisPeriod) && grossThisPeriod > 0 ? grossThisPeriod : 0;
  const bonus = Number.isFinite(bonusAmount) && bonusAmount > 0 ? bonusAmount : 0;
  const periods = Number.isFinite(periodsPerYear) && periodsPerYear > 0 ? periodsPerYear : 12;
  const allowance = Number.isFinite(personalAllowance) && personalAllowance >= 0 ? personalAllowance : 0;

  const regularPit = calcMonthlyPitForRegularIncome(gross, periods, allowance, brackets);
  if (bonus <= 0) return { regularPit, bonusPit: 0, totalPit: regularPit };

  // A: ภาษีทั้งปีไม่รวมโบนัส (คำนวณตรง ๆ อีกครั้งเพื่อหาผลต่าง B−A ที่แม่นยำ — ไม่ derive จาก regularPit*periods
  //   ที่ปัดเศษไปแล้ว กัน error สะสมจากการปัดเศษซ้อน)
  const annualEstimateA = round2(gross * periods);
  const taxableA = Math.max(round2(annualEstimateA - expenseDeduction(annualEstimateA) - allowance), 0);
  const annualTaxA = calcAnnualTax(taxableA, brackets);

  // B: รวมโบนัสเข้า annualEstimate ก่อนหักค่าใช้จ่าย/ลดหย่อน (ชุดลดหย่อนเดียวกัน)
  const annualEstimateB = round2(annualEstimateA + bonus);
  const taxableB = Math.max(round2(annualEstimateB - expenseDeduction(annualEstimateB) - allowance), 0);
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
