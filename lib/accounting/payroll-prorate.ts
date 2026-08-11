/**
 * Auto-prorate เงินเดือนตามวันทำงานจริง — ★ pure ล้วน ไม่แตะ DB
 *
 * บริบท: เฟส 9b กลุ่ม BB (docs/06-accounting-features-roadmap.md, บรรทัด 5303-5311) — ใช้แค่ตอน
 *   prefill ยอดเงินเดือนของบรรทัดใหม่ตอนสร้างรอบ (`payroll.ts::createDraftRun`) เท่านั้น — ★ ไม่แตะ
 *   `calcMonthlyPitForRegularIncome`/`calcSsoContribution`/`calcMonthlyPitWithBonus` เลย (คำนวณภาษี/
 *   ประกันสังคมยังใช้ยอด gross_salary ที่บันทึกจริงในบรรทัด ไม่ว่าจะมาจาก prorate หรือนักบัญชีแก้ทับเอง) —
 *   นักบัญชียังแก้ทับค่า prefill ได้เสมอ (mirror หลักการ 0.13 เดิมของ gross_salary)
 *
 * สูตร: prorated = baseSalary / daysInMonth × daysWorked (ปัดเศษ 2 ตำแหน่งด้วย round2 เหมือนเงินทุกจุดในระบบ)
 *
 * ★ [⚠️ FLAG] SSO floor (บรรทัด 5303-5311 ของแผน): ถ้า prorate แล้วต่ำกว่า floor 1,650 บาท ฟังก์ชันนี้
 *   **ไม่ clamp ขึ้น floor เอง** — คืนค่า prorated ตามสัดส่วนวันทำงานจริงเสมอ (ไม่ผสม business rule ของ
 *   ประกันสังคมเข้ามาในฟังก์ชัน prefill เงินเดือน) แล้วให้ UI แสดง badge "prorate อัตโนมัติ" ชัดเจนให้
 *   นักบัญชีเห็นและตัดสินใจเอง (recalcRunLines/calcSsoContribution เดิมยัง clamp ขึ้น floor ตามปกติทุกกรณี
 *   อยู่แล้วไม่ว่ายอด gross ต่ำเพราะ prorate หรือเหตุผลอื่น — ไม่ใช่พฤติกรรมใหม่ที่ต้องแก้ตรงนี้)
 */
import { round2 } from "@/lib/accounting/queries";

export type ProrateResult = {
  /** ยอดเงินเดือนหลัง prorate (round2) — เท่ากับ baseSalary เป๊ะถ้า isProrated=false (ไม่มีการปัดเศษเพี้ยน) */
  prorated: number;
  /** จำนวนวันทั้งหมดในเดือนของงวดนี้ (ตามปฏิทิน ค.ศ. จริง รวมปีอธิกสุรทิน) */
  daysInMonth: number;
  /** จำนวนวันที่ทำงานจริงในเดือนนี้ (1..daysInMonth) */
  daysWorked: number;
  /** true ถ้า start_date/resign_date ตกอยู่ในช่วงเดือนของรอบนี้ (เข้า/ออกกลางเดือน) */
  isProrated: boolean;
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDate(v: string | null): { year: number; month: number; day: number } | null {
  if (!v) return null;
  const m = DATE_RE.exec(v);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** จำนวนวันในเดือน (ค.ศ.) — รองรับปีอธิกสุรทินถูกต้องผ่าน Date object ของ JS ตรง ๆ */
function daysInMonthOf(gregorianYear: number, month: number): number {
  return new Date(gregorianYear, month, 0).getDate();
}

/**
 * คำนวณเงินเดือน prorate ตามวันทำงานจริงของงวด — payPeriodYear เป็น **พ.ศ.** (ตาม convention เดิมทั้งระบบ
 *   ของ payroll_runs.pay_period_year) แปลงเป็น ค.ศ. ก่อนคำนวณปฏิทิน (-543)
 *
 *   - ไม่มี start_date และไม่มี resign_date ตกอยู่ในเดือนนี้เลย → isProrated=false, prorated=baseSalary เป๊ะ
 *   - start_date ตกอยู่ในเดือนนี้ (เข้าใหม่กลางเดือน) → daysWorked = daysInMonth − day(start_date) + 1
 *   - resign_date ตกอยู่ในเดือนนี้ (ลาออกกลางเดือน) → daysWorked = day(resign_date)
 *   - ทั้งเข้า+ออกในเดือนเดียวกัน → daysWorked = day(resign_date) − day(start_date) + 1 (อย่างน้อย 1 วัน)
 *   - resign_date ก่อนหน้าเดือนนี้ทั้งเดือน (ข้อมูลผิดปกติ — ไม่ควรมีบรรทัดของพนักงานคนนี้อยู่แล้ว) → fallback
 *     ไม่ prorate (isProrated=false) กันค่าติดลบ/ผิดเพี้ยนจากข้อมูลที่ไม่สอดคล้องกัน
 */
export function calcProratedGrossSalary(
  baseSalary: number,
  payPeriodYear: number,
  payPeriodMonth: number,
  startDate: string | null,
  resignDate: string | null
): ProrateResult {
  const gYear = payPeriodYear - 543;
  const daysInMonth = daysInMonthOf(gYear, payPeriodMonth);
  const base = Number.isFinite(baseSalary) && baseSalary > 0 ? baseSalary : 0;

  const start = parseIsoDate(startDate);
  const resign = parseIsoDate(resignDate);

  const startInMonth = start !== null && start.year === gYear && start.month === payPeriodMonth;
  const resignInMonth = resign !== null && resign.year === gYear && resign.month === payPeriodMonth;

  // ★ resign_date อยู่ก่อนเดือนนี้ทั้งเดือน (ข้อมูลผิดปกติ) → ไม่ prorate กันค่าติดลบ/ผิดเพี้ยน
  const resignBeforeMonth =
    resign !== null && (resign.year < gYear || (resign.year === gYear && resign.month < payPeriodMonth));
  if (resignBeforeMonth) {
    return { prorated: round2(base), daysInMonth, daysWorked: daysInMonth, isProrated: false };
  }

  if (!startInMonth && !resignInMonth) {
    return { prorated: round2(base), daysInMonth, daysWorked: daysInMonth, isProrated: false };
  }

  const fromDay = startInMonth ? start!.day : 1;
  const toDay = resignInMonth ? resign!.day : daysInMonth;
  const daysWorked = Math.max(1, Math.min(daysInMonth, toDay - fromDay + 1));

  const prorated = round2((base / daysInMonth) * daysWorked);
  return { prorated, daysInMonth, daysWorked, isProrated: true };
}
