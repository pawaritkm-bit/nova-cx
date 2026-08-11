/**
 * ค่าลดหย่อนภาษีอื่นของพนักงาน (คู่สมรสไม่มีเงินได้/บุตร/ประกันชีวิต/PVD-RMF-กบข/ดอกเบี้ยกู้บ้าน) —
 *   data layer (DB) + validate + CRUD + ★ pure `sumAndCapDeductions` (T150-T152)
 *
 * บริบท: เฟส 9b กลุ่ม BE (docs/06-accounting-features-roadmap.md, หมวด 0.2 ★★★ gate) — ตารางนี้เก็บ
 *   "ข้อมูลดิบ" ที่นักบัญชีกรอกเท่านั้น cap/สูตรทั้งหมดอยู่ใน `sumAndCapDeductions` ล้วน (pure, ไม่แตะ DB)
 *   — ผลลัพธ์จากไฟล์นี้**ไม่กระทบยอดภาษีหัก ณ ที่จ่ายจริง**ของลูกค้าจนกว่า
 *   `ENABLE_EXTRA_DEDUCTIONS_IN_PIT` (payroll-tax.ts) จะเปิดเป็น true พร้อม golden test ที่ verify แล้ว
 *   เท่านั้น (0.2 ★★★ ข้อบังคับ, mirror T112) — ก่อนหน้านั้นเป็นแค่ "preview" ที่ payroll.ts คำนวณแสดง
 *   ในหน้าจอ ไม่ถูกใช้จริงในการคำนวณ pit_withheld
 *
 * ★ scope tenant + payroll_employee_id เสมอ (IDOR-safe, 0.15) — ตารางนี้ไม่มีคอลัมน์ customer_id ของตัวเอง
 *   (denormalized ตั้งใจ mirror payroll_run_lines ที่ไม่มี customer_id เช่นกัน) — ทุก CRUD ต้อง derive
 *   scope ลูกค้าจาก `getEmployeeScope` (payroll-employees.ts) ก่อนอ่าน/เขียนเสมอ ไม่เชื่อ customerId ที่
 *   client ส่งมาลำพัง
 * ★ PDPA: ไม่ log ยอดเงิน/ประเภทค่าลดหย่อนที่ไหนในไฟล์นี้
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/accounting/queries";
import { chunkIds } from "@/lib/accounting/id-chunk";
import { getEmployeeScope } from "@/lib/accounting/payroll-employees";

type DB = SupabaseClient;

const LIST_LIMIT = 5000;
const NOTE_MAX = 300;

/** ประเภทค่าลดหย่อนที่ระบบรองรับ (closed list — ตรงกับ check constraint ของ migration 0097) */
export const DEDUCTION_TYPES = [
  "spouse_no_income",
  "child",
  "life_insurance",
  "provident_fund",
  "mortgage_interest",
] as const;
export type DeductionType = (typeof DEDUCTION_TYPES)[number];

/** ★ T152 — dropdown สำหรับ `child` เท่านั้น (30,000 บุตรทั่วไป / 60,000 บุตรคนที่ 2 เป็นต้นไปที่เกิดตั้งแต่
 *   ปี พ.ศ. 2561 — กติกาปีเกิด/ลำดับบุตรให้นักบัญชีเลือกเองตามที่ระบุใน 0.2/T152 ระบบไม่ auto-derive) */
export const CHILD_ALLOWANCE_AMOUNTS = [30000, 60000] as const;

function isDeductionType(v: unknown): v is DeductionType {
  return typeof v === "string" && (DEDUCTION_TYPES as readonly string[]).includes(v);
}

function parseMoney(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? round2(n) : null;
}

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

// ---------------------------------------------------------------------
// ชนิดข้อมูล
// ---------------------------------------------------------------------

export type PayrollEmployeeDeduction = {
  id: string;
  tenantId: string;
  payrollEmployeeId: string;
  /** พ.ศ. (ตาม convention เดิมของ payroll_runs.pay_period_year) */
  taxYear: number;
  deductionType: DeductionType;
  amount: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

/** input ดิบจาก client */
export type PayrollEmployeeDeductionInput = {
  taxYear: unknown;
  deductionType: unknown;
  amount: unknown;
  note?: unknown;
};

type ValidatedDeduction = {
  taxYear: number;
  deductionType: DeductionType;
  amount: number;
  note: string | null;
};

export type DeductionValidationResult = { ok: true; value: ValidatedDeduction } | { ok: false; message: string };

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline */
export type DeductionActionResult = { ok: true; id: string } | { ok: false; message: string };

/**
 * validate + sanitize input จาก client (T151) — ปฏิเสธเสมอถ้า:
 *   - taxYear ไม่ใช่ปี พ.ศ. ที่สมเหตุสมผล (2500-2700, mirror payroll_runs.pay_period_year)
 *   - deductionType ไม่อยู่ในรายการที่กำหนด (DEDUCTION_TYPES)
 *   - amount ไม่ใช่ตัวเลข/ติดลบ
 *   - deductionType='child' แต่ amount ไม่ใช่ 30,000 หรือ 60,000 เป๊ะ (0.2/T152 — UI มี dropdown 2 ค่านี้
 *     เท่านั้น กันนักบัญชีกรอกเลขอื่นที่ไม่มีฐานกฎหมายชัดเจนโดยไม่ตั้งใจ)
 */
export function validateDeductionInput(input: PayrollEmployeeDeductionInput): DeductionValidationResult {
  const taxYear = typeof input.taxYear === "number" ? input.taxYear : Number(input.taxYear);
  if (!Number.isFinite(taxYear) || !Number.isInteger(taxYear) || taxYear < 2500 || taxYear > 2700) {
    return { ok: false, message: "ปีภาษี (พ.ศ.) ไม่ถูกต้อง" };
  }

  if (!isDeductionType(input.deductionType)) {
    return { ok: false, message: "ประเภทค่าลดหย่อนไม่ถูกต้อง" };
  }
  const deductionType = input.deductionType;

  const amount = parseMoney(input.amount);
  if (amount === null || amount < 0) {
    return { ok: false, message: "จำนวนเงินต้องเป็นตัวเลขไม่ติดลบ" };
  }

  if (deductionType === "child" && !(CHILD_ALLOWANCE_AMOUNTS as readonly number[]).includes(amount)) {
    return { ok: false, message: "ค่าลดหย่อนบุตรต้องเป็น 30,000 หรือ 60,000 บาทเท่านั้น (เลือกตามกติกาปีเกิด/ลำดับบุตร)" };
  }

  const note = clampText(input.note, NOTE_MAX);

  return { ok: true, value: { taxYear, deductionType, amount, note } };
}

// ---------------------------------------------------------------------
// data layer (DB)
// ---------------------------------------------------------------------

type RawRow = {
  id: string;
  tenant_id: string;
  payroll_employee_id: string;
  tax_year: number;
  deduction_type: string;
  amount: number | string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS = "id, tenant_id, payroll_employee_id, tax_year, deduction_type, amount, note, created_at, updated_at";

function mapRow(r: RawRow): PayrollEmployeeDeduction {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    payrollEmployeeId: r.payroll_employee_id,
    taxYear: r.tax_year,
    deductionType: r.deduction_type as DeductionType,
    amount: round2(Number(r.amount)),
    note: r.note ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** ค่าลดหย่อนของพนักงาน 1 คน ในปีภาษีที่ระบุ — ★ IDOR-safe: ตรวจ scope ลูกค้าของพนักงานก่อนเสมอ
 *   (ไม่พบพนักงาน/ลูกค้าไม่ตรง → คืน [] แบบ fail-closed ไม่โยน error ให้เดาข้อมูลได้) */
export async function listDeductions(
  db: DB,
  tenantId: string,
  customerId: string,
  payrollEmployeeId: string,
  taxYear: number
): Promise<PayrollEmployeeDeduction[]> {
  const scope = await getEmployeeScope(db, tenantId, payrollEmployeeId);
  if (!scope || scope.customerId !== customerId) return [];

  const { data, error } = await db
    .from("payroll_employee_deductions")
    .select(COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("payroll_employee_id", payrollEmployeeId)
    .eq("tax_year", taxYear)
    .order("deduction_type", { ascending: true })
    .limit(LIST_LIMIT);
  if (error || !data) return [];
  return (data as unknown as RawRow[]).map(mapRow);
}

/**
 * ค่าลดหย่อนของพนักงานหลายคนพร้อมกัน ในปีภาษีที่ระบุ — ใช้โดย `payroll.ts::recalcRunLines`/
 *   `getRunWithLines` เท่านั้น (internal, ★ ไม่ตรวจสโคปลูกค้าซ้ำในฟังก์ชันนี้ — เรียกใช้เฉพาะกับ
 *   payrollEmployeeIds ที่ผู้เรียกยืนยันสโคปลูกค้ามาแล้วจาก payroll_run_lines ของรอบที่ผ่าน getRunScope
 *   แล้วเท่านั้น mirror pattern เดียวกับ payroll.ts::fetchEmployeeInfo) — chunkIds กัน `.in()` ยาวเกิน
 *   limit เมื่อลูกค้ามีพนักงาน 100+ คน (0.1)
 */
export async function listDeductionsForEmployees(
  db: DB,
  tenantId: string,
  payrollEmployeeIds: string[],
  taxYear: number
): Promise<Map<string, PayrollEmployeeDeduction[]>> {
  const map = new Map<string, PayrollEmployeeDeduction[]>();
  const uniqIds = [...new Set(payrollEmployeeIds)];
  if (uniqIds.length === 0) return map;

  const chunks = await Promise.all(
    chunkIds(uniqIds).map((chunk) =>
      db
        .from("payroll_employee_deductions")
        .select(COLUMNS)
        .eq("tenant_id", tenantId)
        .eq("tax_year", taxYear)
        .in("payroll_employee_id", chunk)
    )
  );
  for (const { data } of chunks) {
    for (const r of (data ?? []) as unknown as RawRow[]) {
      const row = mapRow(r);
      const arr = map.get(row.payrollEmployeeId) ?? [];
      arr.push(row);
      map.set(row.payrollEmployeeId, arr);
    }
  }
  return map;
}

/** โหลด scope (payroll_employee_id) ของแถวค่าลดหย่อน 1 แถว — ใช้ตรวจก่อนแก้/ลบ (IDOR-safe, 0.15) */
async function getDeductionRowScope(db: DB, tenantId: string, id: string): Promise<{ payrollEmployeeId: string } | null> {
  const { data } = await db
    .from("payroll_employee_deductions")
    .select("payroll_employee_id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!data) return null;
  return { payrollEmployeeId: (data as { payroll_employee_id: string }).payroll_employee_id };
}

/**
 * สร้าง/แก้ค่าลดหย่อน 1 แถว — validate ซ้ำฝั่ง server เสมอ + ตรวจสโคป tenant+customer+employee ก่อนเขียน
 *   ทุกครั้ง (IDOR-safe, 0.15):
 *   - id ระบุ = update (ต้อง payroll_employee_id ตรงกับของเดิม)
 *   - id ไม่ระบุ = สร้างใหม่
 */
export async function upsertDeduction(
  db: DB,
  tenantId: string,
  customerId: string,
  payrollEmployeeId: string,
  input: PayrollEmployeeDeductionInput,
  id?: string
): Promise<DeductionActionResult> {
  const scope = await getEmployeeScope(db, tenantId, payrollEmployeeId);
  if (!scope) return { ok: false, message: "ไม่พบพนักงาน (อาจถูกลบไปแล้ว)" };
  if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับพนักงานที่ระบุ" };

  const v = validateDeductionInput(input);
  if (!v.ok) return { ok: false, message: v.message };

  const payload = {
    tax_year: v.value.taxYear,
    deduction_type: v.value.deductionType,
    amount: v.value.amount,
    note: v.value.note,
  };

  if (id) {
    const rowScope = await getDeductionRowScope(db, tenantId, id);
    if (!rowScope) return { ok: false, message: "ไม่พบรายการค่าลดหย่อน (อาจถูกลบไปแล้ว)" };
    if (rowScope.payrollEmployeeId !== payrollEmployeeId) {
      return { ok: false, message: "รายการค่าลดหย่อนนี้ไม่ตรงกับพนักงานที่ระบุ" };
    }
    const { error } = await db.from("payroll_employee_deductions").update(payload).eq("id", id).eq("tenant_id", tenantId);
    if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, id };
  }

  const { data, error } = await db
    .from("payroll_employee_deductions")
    .insert({ tenant_id: tenantId, payroll_employee_id: payrollEmployeeId, ...payload })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "เพิ่มรายการค่าลดหย่อนไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: (data as { id: string }).id };
}

/** ลบค่าลดหย่อน 1 แถว — ตรวจสโคป tenant+customer+employee ก่อนลบเสมอ (IDOR-safe, 0.15) */
export async function deleteDeduction(
  db: DB,
  tenantId: string,
  customerId: string,
  payrollEmployeeId: string,
  id: string
): Promise<DeductionActionResult> {
  const scope = await getEmployeeScope(db, tenantId, payrollEmployeeId);
  if (!scope) return { ok: false, message: "ไม่พบพนักงาน (อาจถูกลบไปแล้ว)" };
  if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับพนักงานที่ระบุ" };

  const rowScope = await getDeductionRowScope(db, tenantId, id);
  if (!rowScope) return { ok: false, message: "ไม่พบรายการค่าลดหย่อน (อาจถูกลบไปแล้ว)" };
  if (rowScope.payrollEmployeeId !== payrollEmployeeId) {
    return { ok: false, message: "รายการค่าลดหย่อนนี้ไม่ตรงกับพนักงานที่ระบุ" };
  }

  const { error } = await db.from("payroll_employee_deductions").delete().eq("id", id).eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

// ---------------------------------------------------------------------
// sumAndCapDeductions (T152) — ★★★ pure ล้วน ไม่แตะ DB
// ---------------------------------------------------------------------

/** เพดานค่าลดหย่อนแต่ละประเภท (บาท) — อ้างอิงแหล่งที่มาเต็มด้านล่างฟังก์ชัน `sumAndCapDeductions` */
export const SPOUSE_NO_INCOME_CAP = 60000;
export const LIFE_INSURANCE_CAP = 100000;
/** ★ เพิ่มอีก 10,000 เมื่อมีคู่สมรสไม่มีเงินได้ (spouse_no_income>0 อยู่ในชุดข้อมูลเดียวกัน) รวมเป็น 110,000 */
export const LIFE_INSURANCE_CAP_WITH_SPOUSE = 110000;
export const PROVIDENT_FUND_ABS_CAP = 500000;
export const PROVIDENT_FUND_INCOME_RATIO = 0.3;
export const MORTGAGE_INTEREST_CAP = 100000;

export type DeductionRowForCalc = { deductionType: DeductionType; amount: number };

export type SumAndCapDeductionsResult = {
  /** ผลรวมค่าลดหย่อนอื่นทั้งหมดหลัง cap ทุกประเภทแล้ว (บวกเข้า PERSONAL_ALLOWANCE_STANDARD เพื่อได้
   *  personalAllowancePreview ใน payroll.ts) */
  totalOtherAllowance: number;
  /** ข้อความเตือนทุกจุดที่ถูกตัดยอดเพราะชนเพดาน (แสดงในหน้าจอให้นักบัญชีเห็น ไม่ใช่ error) */
  warnings: string[];
};

/**
 * รวม+ตัดเพดานค่าลดหย่อนภาษีอื่นตามประเภท (★★★ 0.2 gate — ผลลัพธ์จากฟังก์ชันนี้ยังเป็นแค่ "preview" จนกว่า
 *   ENABLE_EXTRA_DEDUCTIONS_IN_PIT จะเปิด, ดูคอมเมนต์หัวไฟล์) — กติกาต่อประเภท (T152):
 *
 *   - `spouse_no_income`: รวมทุกแถว แล้ว cap ที่ 60,000 บาท (เผื่อกรอกซ้ำ/ผิดพลาดหลายแถว)
 *   - `child`: รวมทุกแถวตรง ๆ **ไม่มี cap อัตโนมัติ** (นักบัญชี/หน้าจอเลือก 30,000 หรือ 60,000 ต่อคนเอง
 *     ตามกติกาปีเกิด/ลำดับบุตรที่ระบบไม่ auto-derive เพราะซับซ้อนเกินกว่าจะทำอัตโนมัติได้อย่างปลอดภัย)
 *   - `life_insurance`: รวมทุกแถว แล้ว cap ที่ 100,000 บาท — **ขยับเป็น 110,000 บาท** ถ้าในชุดข้อมูลเดียวกัน
 *     มีแถว `spouse_no_income` ที่ amount > 0 ด้วย (คู่สมรสไม่มีเงินได้ → มีสิทธิหักเบี้ยประกันชีวิตของคู่สมรส
 *     เพิ่มอีกไม่เกิน 10,000 บาท)
 *   - `provident_fund` (ครอบคลุม PVD + RMF + กบข รวมเป็นก้อนเดียวตามที่ระบบออกแบบไว้ ดู T152/migration 0097):
 *     รวมทุกแถว แล้ว cap ที่ `min(500,000, 30% ของ annualIncomeEstimate)` — annualIncomeEstimate ≤0/ไม่ใช่
 *     ตัวเลข → ถือเป็น 0 (cap เป็น 0 ทันที ไม่ throw)
 *   - `mortgage_interest`: รวมทุกแถว แล้ว cap ที่ 100,000 บาท
 *
 *   ★★★ แหล่งอ้างอิงที่ verify ตัวเลข cap ทุกประเภทข้างต้น (T157 — เอกสารทางการของกรมสรรพากรเอง ไม่ใช่
 *   บทความสรุปของเอกชน, เกณฑ์เดียวกับที่ 0.2/4 ของแผนกำหนด):
 *     1. "วิธีกรอกแบบแสดงรายการภาษีเงินได้บุคคลธรรมดา ปีภาษี 2568" (กรมสรรพากร, ปรับปรุง 2 ก.พ. 2569)
 *        https://www.rd.go.th/fileadmin/tax_pdf/pit/2568/Ins90_241268.pdf — หัวข้อ "การกรอกรายการในใบแนบ
 *        แสดงรายละเอียดรายการลดหย่อนและยกเว้นหลังจากหักค่าใช้จ่าย":
 *        - ข้อ 2 (คู่สมรส): "คู่สมรสไม่มีเงินได้ ผู้มีเงินได้หักลดหย่อนสำหรับผู้มีเงินได้ 60,000 บาท ผู้มีเงินได้
 *          หักลดหย่อนคู่สมรส 60,000 บาท" — ยืนยัน SPOUSE_NO_INCOME_CAP = 60,000
 *        - ข้อ 3 (บุตร): "บุตรชอบด้วยกฎหมาย...คนละ 30,000 บาท และสำหรับบุตรชอบด้วยกฎหมายตั้งแต่คนที่สองเป็น
 *          ต้นไปที่เกิดในหรือหลังปี พ.ศ. 2561 ให้หักลดหย่อนได้เพิ่มอีกคนละ 30,000 บาท" (=รวม 60,000) —
 *          ยืนยัน CHILD_ALLOWANCE_AMOUNTS = [30000, 60000]
 *        - ข้อ 7.2(2) + ตัวอย่างท้ายข้อ (ประกันชีวิต): "ให้ได้รับลดหย่อน...สำหรับผู้มีเงินได้เต็มจำนวนตามที่
 *          จ่ายจริงแต่ไม่เกิน 100,000 บาท...คู่สมรสซึ่งเป็นฝ่ายผู้มีเงินได้ มีสิทธิหักลดหย่อนสำหรับเบี้ยประกันชีวิต
 *          ของคู่สมรสฝ่ายที่ไม่มีเงินได้ตามจำนวนที่จ่ายจริงแต่ไม่เกิน 10,000 บาท" พร้อม ★ ตัวอย่างตัวเลขจริง:
 *          "ผู้มีเงินได้จ่ายเบี้ยประกันชีวิต 100,000 บาท คู่สมรสจ่ายเบี้ยประกันชีวิต 100,000 บาท ถ้าความเป็น
 *          คู่สมรสได้มีอยู่ตลอดปีภาษี ผู้มีเงินได้หักลดหย่อน...สำหรับผู้มีเงินได้ 100,000 บาท และผู้มีเงินได้หัก
 *          ลดหย่อนคู่สมรส 10,000 บาท" (รวม 110,000 บาท) — ยืนยัน LIFE_INSURANCE_CAP = 100,000 และ
 *          LIFE_INSURANCE_CAP_WITH_SPOUSE = 110,000 **ตรงเป๊ะกับตัวเลขที่ระบบคำนวณได้** (golden test ใน
 *          payroll-deductions.test.ts ใช้ตัวอย่างนี้ตรง ๆ)
 *        - ข้อ 10.4 (RMF): "ยกเว้นเท่าที่ได้จ่าย...ในอัตราไม่เกินร้อยละ 30 ของเงินได้พึงประเมิน...เฉพาะส่วนที่
 *          ไม่เกิน 500,000 บาทสำหรับปีภาษีนั้น...เมื่อรวมกับเงินสะสมที่จ่ายเข้ากองทุนสำรองเลี้ยงชีพ กองทุน
 *          บำเหน็จบำนาญข้าราชการ หรือกองทุนสงเคราะห์ ต้องไม่เกิน 500,000 บาท" — ยืนยัน
 *          PROVIDENT_FUND_ABS_CAP = 500,000 และ PROVIDENT_FUND_INCOME_RATIO = 0.3 (ใช้ min ของทั้งสอง)
 *     2. "เงินได้พึงประเมินอะไรบ้างที่ได้รับยกเว้นภาษี" (กรมสรรพากร)
 *        https://www.rd.go.th/fileadmin/user_upload/borkor/taxreturn23072567.pdf — ข้อ (73): "เงินได้เท่าที่
 *        ได้จ่ายเป็นดอกเบี้ยเงินกู้ยืม...เพื่อซื้อ เช่าซื้อ หรือสร้างอาคารที่อยู่อาศัย โดยจำนองอาคาร...เป็น
 *        ประกันการกู้ยืมนั้น ตามจำนวนที่จ่ายจริงแต่ไม่เกิน 100,000 บาท" — ยืนยัน MORTGAGE_INTEREST_CAP =
 *        100,000 (กฎกระทรวง ฉบับที่ 126 ข้อ 2(53) ตามที่แก้ไข)
 *   → เงื่อนไข 0.2 ข้อ 4 (golden test verify กับตัวอย่างคำนวณจากแหล่งที่เชื่อถือได้จริง) ผ่านครบทุกเพดานที่
 *   มีสูตร/เงื่อนไข — จึงเปิด ENABLE_EXTRA_DEDUCTIONS_IN_PIT = true ในคอมมิตเดียวกัน (payroll-tax.ts)
 */
export function sumAndCapDeductions(rows: DeductionRowForCalc[], annualIncomeEstimate: number): SumAndCapDeductionsResult {
  const warnings: string[] = [];
  const sumOf = (type: DeductionType): number =>
    round2(rows.filter((r) => r.deductionType === type).reduce((acc, r) => acc + (Number.isFinite(r.amount) ? r.amount : 0), 0));

  const hasSpouseNoIncome = rows.some((r) => r.deductionType === "spouse_no_income" && r.amount > 0);

  const spouseSum = sumOf("spouse_no_income");
  const spouseCapped = Math.min(spouseSum, SPOUSE_NO_INCOME_CAP);
  if (spouseSum > SPOUSE_NO_INCOME_CAP) {
    warnings.push(`ค่าลดหย่อนคู่สมรสไม่มีเงินได้เกินเพดาน ${SPOUSE_NO_INCOME_CAP.toLocaleString("th-TH")} บาท — ตัดยอดส่วนเกินออก`);
  }

  // ★ child ไม่มี cap อัตโนมัติ (T152) — รวมตรง ๆ
  const childSum = sumOf("child");

  const lifeInsuranceCap = hasSpouseNoIncome ? LIFE_INSURANCE_CAP_WITH_SPOUSE : LIFE_INSURANCE_CAP;
  const lifeSum = sumOf("life_insurance");
  const lifeCapped = Math.min(lifeSum, lifeInsuranceCap);
  if (lifeSum > lifeInsuranceCap) {
    warnings.push(`ค่าเบี้ยประกันชีวิตเกินเพดาน ${lifeInsuranceCap.toLocaleString("th-TH")} บาท — ตัดยอดส่วนเกินออก`);
  }

  const income = Number.isFinite(annualIncomeEstimate) && annualIncomeEstimate > 0 ? annualIncomeEstimate : 0;
  const pvdCapByIncome = round2(income * PROVIDENT_FUND_INCOME_RATIO);
  const pvdCap = Math.min(PROVIDENT_FUND_ABS_CAP, pvdCapByIncome);
  const pvdSum = sumOf("provident_fund");
  const pvdCapped = Math.min(pvdSum, pvdCap);
  if (pvdSum > pvdCap) {
    const reason = pvdCap === pvdCapByIncome && pvdCapByIncome < PROVIDENT_FUND_ABS_CAP ? "30% ของเงินได้ประมาณทั้งปี" : `${PROVIDENT_FUND_ABS_CAP.toLocaleString("th-TH")} บาท`;
    warnings.push(`เงินสะสมกองทุนสำรองเลี้ยงชีพ/RMF/กบข เกินเพดาน (${reason}) — ตัดยอดส่วนเกินออก`);
  }

  const mortgageSum = sumOf("mortgage_interest");
  const mortgageCapped = Math.min(mortgageSum, MORTGAGE_INTEREST_CAP);
  if (mortgageSum > MORTGAGE_INTEREST_CAP) {
    warnings.push(`ดอกเบี้ยเงินกู้ยืมที่อยู่อาศัยเกินเพดาน ${MORTGAGE_INTEREST_CAP.toLocaleString("th-TH")} บาท — ตัดยอดส่วนเกินออก`);
  }

  const totalOtherAllowance = round2(spouseCapped + childSum + lifeCapped + pvdCapped + mortgageCapped);
  return { totalOtherAllowance, warnings };
}
