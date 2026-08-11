/**
 * เครื่องคำนวณภาษีหัก ณ ที่จ่าย (มาตรา 50) + เงินสมทบประกันสังคม (มาตรา 33) — ★ pure ล้วน ไม่แตะ DB
 *   ทุกฟังก์ชันในไฟล์นี้ unit-test ได้ตรง ๆ (T111/T113)
 *
 * บริบท: เฟส 9 ส่วน AD (docs/06-accounting-features-roadmap.md, หมวด 0.4/0.5/0.6) — จุดที่สำคัญที่สุด
 *   ของเฟสนี้ เพราะกระทบเงินจริงของพนักงานลูกค้าโดยตรง
 *
 * ★★★ 0.5 สูตรภาษีโบนัส (คำสั่งกรมสรรพากร ทป.4/2528 ข้อ 3) — [ยังไม่เปิดใช้งาน — ดูหมายเหตุด้านล่าง]:
 *   ไม่มีฟังก์ชัน `calcMonthlyPitWithBonus` ในไฟล์นี้โดยตั้งใจ — เอกสารแผนสั่งให้ต้องหาตัวอย่างคำนวณ
 *   อ้างอิงที่เชื่อถือได้จริง (เอกสารประกอบคำสั่ง ทป.4/2528 ฉบับเต็ม หรือแหล่งที่ระบุเลขอ้างอิงชัดเจน) มาทำเป็น
 *   golden test case ก่อนถือว่า T112 เสร็จ — ในรอบ implement นี้หาแหล่งอ้างอิงที่เชื่อถือได้จริงทันเวลาไม่ได้
 *   (ไม่มีเครื่องมือค้นเว็บให้ verify ในสภาพแวดล้อมที่ implement งานนี้) → เลือกทางเลือก (ข) ตามที่เอกสารแผน
 *   ระบุไว้: **ไม่ deploy engine โบนัสที่ยังไม่ verify** — ปฏิเสธ `bonus_amount > 0` ที่ชั้น validate ของ
 *   `lib/accounting/payroll.ts` (recalcRunLines/updateRunLineAction) และ UI (ช่องกรอกโบนัสถูกปิดใช้งาน/
 *   แจ้งเหตุผลชัดเจน) ไปก่อน — เปิด backlog 9b ทำต่อเมื่อหาตัวอย่างอ้างอิงที่เชื่อถือได้จริงมาได้แล้ว
 *   ห้ามเขียนสูตรเดามาใช้กับเงินจริงของลูกค้าเด็ดขาด
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
/** ค่าลดหย่อนส่วนบุคคลมาตรฐาน (รอบแรกของระบบ — ยังไม่รองรับค่าลดหย่อนอื่น ดู backlog 9b ข้อ 1) */
export const PERSONAL_ALLOWANCE_STANDARD = 60000;

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
