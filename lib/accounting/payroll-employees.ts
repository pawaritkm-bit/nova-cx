/**
 * ทะเบียนพนักงานของ "บริษัทลูกค้า" (Payroll) — data layer (DB) + validate + CRUD
 *
 * บริบท: เฟส 9 ส่วน AC (docs/06-accounting-features-roadmap.md, หมวด 0.2/0.12) — ต่างจาก
 *   `public.employees` (พนักงานภายใน Finovas) โดยสิ้นเชิง ดูคอมเมนต์เต็มใน migration 0080
 *
 * ★★★ 0.2 ตั้งใจสะกด `PayrollEmployee`/`payroll_employees` ต่างจาก `employee`/`employees` ชัดเจน —
 *   ไฟล์นี้เป็นจุดเดียวที่คุย DB ตาราง payroll_employees ทั้งระบบ ไม่มีจุดไหน query ตาราง `employees`
 *   ปนกันในไฟล์นี้เลย (ห้าม import จาก accountant-scope.ts/lib อื่นที่ query employees ในไฟล์นี้)
 * ★ ทุก query/write กรอง tenant_id (จาก session) + customer_id เสมอทั้งคู่ (ต่างจาก employees เดิมที่ไม่มี
 *   customer_id ให้กรอง) — assertCustomerInScope ทำที่ actions.ts ชั้นบน
 * ★ 0.12 id_card_no: normalize ด้วย normalizeTaxId/isValidTaxId (lib/accounting/tax-id.ts) ตรง ๆ ไม่เขียน
 *   validator ซ้ำ — PDPA: ไม่ log เลขบัตร/ชื่อพนักงาน/เงินเดือนที่ไหนในไฟล์นี้
 * ★ soft-delete (deleted_at) — ไม่ลบจริง (pattern เดิมทั้งระบบ)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/accounting/queries";
import { isValidCalendarDate } from "@/lib/accounting/bank-reconciliation";
import { normalizeTaxId } from "@/lib/accounting/tax-id";

type DB = SupabaseClient;

/** เพดานความยาว (กัน payload ใหญ่ผิดปกติ) */
export const FULL_NAME_MAX = 200;
export const EMPLOYEE_CODE_MAX = 50;
export const PASSPORT_NO_MAX = 30;
export const POSITION_MAX = 100;
const LIST_LIMIT = 5000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function parseMoney(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? round2(n) : null;
}

/** ★ BD (0.4) — nullable ตัวเลขไม่ติดลบ: ไม่กรอกเลย (null/undefined/"") → null (ไม่มี YTD นายจ้างเดิม)
 *   ผิดรูปแบบ/ติดลบ → { ok: false } */
function parseMoneyOrNullField(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: round2(n) };
}

function parseDateOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  if (typeof v !== "string" || !DATE_RE.test(v) || !isValidCalendarDate(v)) return { ok: false };
  return { ok: true, value: v };
}

// ---------------------------------------------------------------------
// ชนิดข้อมูล
// ---------------------------------------------------------------------

/** พนักงานของบริษัทลูกค้า 1 คน — ★ อย่าสับสนกับ employees (พนักงานภายใน Finovas, 0.2) */
export type PayrollEmployee = {
  id: string;
  tenantId: string;
  customerId: string;
  employeeCode: string | null;
  fullName: string;
  /** เลขบัตรประชาชน 13 หลัก (normalize แล้ว) — null ถ้าใช้ passportNo แทน */
  idCardNo: string | null;
  passportNo: string | null;
  position: string | null;
  baseSalary: number;
  /** YYYY-MM-DD */
  startDate: string | null;
  resignDate: string | null;
  isActive: boolean;
  /** ★ เฟส 9b กลุ่ม BA (0.3) — ยกเว้นเงินสมทบประกันสังคมรายพนักงาน นักบัญชีพิจารณาเงื่อนไขเอง ไม่ผูก
   *   เหตุผลทางกฎหมายในระบบ (reframe จาก "ม.39/40" เดิมที่เข้าใจผิดข้อเท็จจริง) */
  ssoExempt: boolean;
  /** ★ เฟส 9b กลุ่ม BD (0.4) — ยอดยกมาจากนายจ้างเดิม (ข้อมูลอ้างอิงเพื่อพิมพ์ 50 ทวิเท่านั้น ห้ามใช้ในสูตร
   *   คำนวณภาษีหัก ณ ที่จ่ายรายเดือนเด็ดขาด) */
  priorEmployerYtdGross: number | null;
  priorEmployerYtdPitWithheld: number | null;
  priorEmployerYtdSsoEmployee: number | null;
  priorEmployerNote: string | null;
  createdAt: string;
  updatedAt: string;
};

/** input ดิบจาก client */
export type PayrollEmployeeInput = {
  employeeCode?: unknown;
  fullName: unknown;
  idCardNo?: unknown;
  passportNo?: unknown;
  position?: unknown;
  baseSalary: unknown;
  startDate?: unknown;
  resignDate?: unknown;
  isActive?: unknown;
  /** ★ BA (0.3) — undefined จาก input เก่า/ฟอร์มที่ยังไม่มีช่องนี้ → default false (ไม่ throw) */
  ssoExempt?: unknown;
  /** ★ BD (0.4) — nullable ทั้งหมด ไม่กรอก = ไม่มี YTD นายจ้างเดิม */
  priorEmployerYtdGross?: unknown;
  priorEmployerYtdPitWithheld?: unknown;
  priorEmployerYtdSsoEmployee?: unknown;
  priorEmployerNote?: unknown;
};

type ValidatedPayrollEmployee = {
  employeeCode: string | null;
  fullName: string;
  idCardNo: string | null;
  passportNo: string | null;
  position: string | null;
  baseSalary: number;
  startDate: string | null;
  resignDate: string | null;
  isActive: boolean;
  ssoExempt: boolean;
  priorEmployerYtdGross: number | null;
  priorEmployerYtdPitWithheld: number | null;
  priorEmployerYtdSsoEmployee: number | null;
  priorEmployerNote: string | null;
};

export type PayrollEmployeeValidationResult =
  | { ok: true; value: ValidatedPayrollEmployee }
  | { ok: false; message: string };

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline */
export type PayrollEmployeeActionResult = { ok: true; id: string } | { ok: false; message: string };

/**
 * validate + sanitize input จาก client (0.12) — ปฏิเสธเสมอถ้า:
 *   - ไม่มีชื่อ
 *   - มี id_card_no แต่รูปแบบผิด (ไม่ใช่ 13 หลักตามเช็คของ isValidTaxId/normalizeTaxId)
 *   - ไม่มีทั้ง id_card_no และ passport_no
 *   - base_salary ไม่ใช่ตัวเลข/ติดลบ
 *   - start_date/resign_date ผิดรูปแบบ (ให้ผ่านได้ถ้าไม่กรอกเลย — nullable)
 */
export function validatePayrollEmployeeInput(input: PayrollEmployeeInput): PayrollEmployeeValidationResult {
  const fullName = clampText(input.fullName, FULL_NAME_MAX);
  if (!fullName) return { ok: false, message: "ต้องระบุชื่อพนักงาน" };

  const employeeCode = clampText(input.employeeCode, EMPLOYEE_CODE_MAX);

  let idCardNo: string | null = null;
  const rawIdCard = clampText(input.idCardNo, 30);
  if (rawIdCard) {
    idCardNo = normalizeTaxId(rawIdCard);
    if (!idCardNo) return { ok: false, message: "เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก" };
  }

  const passportNo = clampText(input.passportNo, PASSPORT_NO_MAX);

  if (!idCardNo && !passportNo) {
    return { ok: false, message: "ต้องระบุเลขบัตรประชาชน (13 หลัก) หรือเลข Passport อย่างน้อย 1 อย่าง" };
  }

  const position = clampText(input.position, POSITION_MAX);

  const baseSalary = parseMoney(input.baseSalary);
  if (baseSalary === null || baseSalary < 0) {
    return { ok: false, message: "เงินเดือนฐานต้องเป็นตัวเลขไม่ติดลบ" };
  }

  const startRes = parseDateOrNull(input.startDate);
  if (!startRes.ok) return { ok: false, message: "วันที่เริ่มงานไม่ถูกต้อง (YYYY-MM-DD)" };
  const resignRes = parseDateOrNull(input.resignDate);
  if (!resignRes.ok) return { ok: false, message: "วันที่ลาออกไม่ถูกต้อง (YYYY-MM-DD)" };

  const isActive = input.isActive === undefined ? true : !!input.isActive;

  // ★ BA (0.3) — undefined (input เก่า/ฟอร์มที่ยังไม่มีช่องนี้) → default false เสมอ ไม่ throw
  const ssoExempt = input.ssoExempt === undefined ? false : !!input.ssoExempt;

  // ★ BD (0.4) — ยอด YTD นายจ้างเดิม (nullable, ตัวเลขไม่ติดลบถ้ากรอก) — ใช้แค่พิมพ์ 50 ทวิเท่านั้น
  const ytdGrossRes = parseMoneyOrNullField(input.priorEmployerYtdGross);
  if (!ytdGrossRes.ok) return { ok: false, message: "ยอดเงินได้ยกมาจากนายจ้างเดิมต้องเป็นตัวเลขไม่ติดลบ" };
  const ytdPitRes = parseMoneyOrNullField(input.priorEmployerYtdPitWithheld);
  if (!ytdPitRes.ok) return { ok: false, message: "ยอดภาษีหัก ณ ที่จ่ายยกมาจากนายจ้างเดิมต้องเป็นตัวเลขไม่ติดลบ" };
  const ytdSsoRes = parseMoneyOrNullField(input.priorEmployerYtdSsoEmployee);
  if (!ytdSsoRes.ok) return { ok: false, message: "ยอดประกันสังคมยกมาจากนายจ้างเดิมต้องเป็นตัวเลขไม่ติดลบ" };
  const priorEmployerNote = clampText(input.priorEmployerNote, 500);

  return {
    ok: true,
    value: {
      employeeCode,
      fullName,
      idCardNo,
      passportNo,
      position,
      baseSalary,
      startDate: startRes.value,
      resignDate: resignRes.value,
      isActive,
      ssoExempt,
      priorEmployerYtdGross: ytdGrossRes.value,
      priorEmployerYtdPitWithheld: ytdPitRes.value,
      priorEmployerYtdSsoEmployee: ytdSsoRes.value,
      priorEmployerNote,
    },
  };
}

// ---------------------------------------------------------------------
// data layer (DB)
// ---------------------------------------------------------------------

type RawRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  employee_code: string | null;
  full_name: string;
  id_card_no: string | null;
  passport_no: string | null;
  position: string | null;
  base_salary: number | string;
  start_date: string | null;
  resign_date: string | null;
  is_active: boolean;
  /** ★ BA — undefined ถ้า migration 0091 ยังไม่ apply บน DB นี้ (defensive, ไม่ควรเกิดในโปรดักชัน) */
  sso_exempt?: boolean | null;
  prior_employer_ytd_gross?: number | string | null;
  prior_employer_ytd_pit_withheld?: number | string | null;
  prior_employer_ytd_sso_employee?: number | string | null;
  prior_employer_note?: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  "id, tenant_id, customer_id, employee_code, full_name, id_card_no, passport_no, position, base_salary, start_date, resign_date, is_active, sso_exempt, prior_employer_ytd_gross, prior_employer_ytd_pit_withheld, prior_employer_ytd_sso_employee, prior_employer_note, created_at, updated_at";

/** ตัวเลข nullable จาก DB (numeric อาจมาเป็น string) → number | null */
function numOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? round2(n) : null;
}

function mapRow(r: RawRow): PayrollEmployee {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    employeeCode: r.employee_code,
    fullName: r.full_name,
    idCardNo: r.id_card_no,
    passportNo: r.passport_no,
    position: r.position,
    baseSalary: round2(Number(r.base_salary)),
    startDate: r.start_date,
    resignDate: r.resign_date,
    isActive: r.is_active,
    ssoExempt: !!r.sso_exempt,
    priorEmployerYtdGross: numOrNull(r.prior_employer_ytd_gross),
    priorEmployerYtdPitWithheld: numOrNull(r.prior_employer_ytd_pit_withheld),
    priorEmployerYtdSsoEmployee: numOrNull(r.prior_employer_ytd_sso_employee),
    priorEmployerNote: r.prior_employer_note ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** ทะเบียนพนักงานของลูกค้า 1 ราย (ทั้ง active/inactive) เรียงชื่อ (ไทย) */
export async function listEmployees(
  db: DB,
  tenantId: string,
  customerId: string,
  opts: { activeOnly?: boolean } = {}
): Promise<PayrollEmployee[]> {
  let q = db
    .from("payroll_employees")
    .select(COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null);
  if (opts.activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q.order("full_name", { ascending: true }).limit(LIST_LIMIT);
  if (error || !data) return [];
  return (data as unknown as RawRow[]).map(mapRow);
}

/** โหลด customer_id ปัจจุบันของพนักงาน 1 คน (scope tenant) — ใช้ตรวจสโคปก่อนแก้/ลบ (IDOR-safe, 0.15) */
export async function getEmployeeScope(db: DB, tenantId: string, id: string): Promise<{ customerId: string } | null> {
  const { data } = await db
    .from("payroll_employees")
    .select("customer_id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  return { customerId: (data as { customer_id: string }).customer_id };
}

/**
 * โหลดพนักงาน 1 คนแบบเต็ม (มี id_card_no/passport_no เต็ม — ★ ใช้เฉพาะฝั่ง server เท่านั้น เช่น
 *   action ต้องรู้ค่าเดิมตอนแก้ไข "ไม่เปลี่ยนเลขบัตร" (ปล่อยช่องว่างไว้ = คงค่าเดิม) หรือปุ่ม "เผยเลขเต็ม"
 *   (0.12, PDPA) — ห้ามส่งค่าที่ได้จากฟังก์ชันนี้ลง client component เป็น default prop ทั่วไปเด็ดขาด)
 */
export async function getEmployeeById(db: DB, tenantId: string, id: string): Promise<PayrollEmployee | null> {
  const { data } = await db
    .from("payroll_employees")
    .select(COLUMNS)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  return mapRow(data as unknown as RawRow);
}

/** map error code ของ unique index (id_card_no ซ้ำในลูกค้าเดียวกัน) → ข้อความไทยที่เข้าใจง่าย */
function friendlyDbErrorMessage(errCode: string | undefined, fallback: string): string {
  if (errCode === "23505") {
    return "เลขบัตรประชาชนนี้มีอยู่แล้วในทะเบียนพนักงานของลูกค้ารายนี้";
  }
  return fallback;
}

/**
 * สร้าง/แก้ทะเบียนพนักงาน — validate ซ้ำฝั่ง server เสมอ (0.12)
 *   - id ระบุ = update (ต้อง customer_id ตรงกับของเดิม)
 *   - id ไม่ระบุ = สร้างใหม่
 */
export async function upsertEmployee(
  db: DB,
  tenantId: string,
  customerId: string,
  input: PayrollEmployeeInput,
  id?: string
): Promise<PayrollEmployeeActionResult> {
  const v = validatePayrollEmployeeInput(input);
  if (!v.ok) return { ok: false, message: v.message };

  const payload = {
    employee_code: v.value.employeeCode,
    full_name: v.value.fullName,
    id_card_no: v.value.idCardNo,
    passport_no: v.value.passportNo,
    position: v.value.position,
    base_salary: v.value.baseSalary,
    start_date: v.value.startDate,
    resign_date: v.value.resignDate,
    is_active: v.value.isActive,
    sso_exempt: v.value.ssoExempt,
    prior_employer_ytd_gross: v.value.priorEmployerYtdGross,
    prior_employer_ytd_pit_withheld: v.value.priorEmployerYtdPitWithheld,
    prior_employer_ytd_sso_employee: v.value.priorEmployerYtdSsoEmployee,
    prior_employer_note: v.value.priorEmployerNote,
  };

  if (id) {
    const scope = await getEmployeeScope(db, tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบพนักงาน (อาจถูกลบไปแล้ว)" };
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับพนักงานเดิม" };

    const { error } = await db.from("payroll_employees").update(payload).eq("id", id).eq("tenant_id", tenantId);
    if (error) return { ok: false, message: friendlyDbErrorMessage(error.code, "บันทึกไม่สำเร็จ กรุณาลองใหม่") };
    return { ok: true, id };
  }

  const { data, error } = await db
    .from("payroll_employees")
    .insert({ tenant_id: tenantId, customer_id: customerId, ...payload })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    return { ok: false, message: friendlyDbErrorMessage(error?.code, "เพิ่มพนักงานไม่สำเร็จ กรุณาลองใหม่") };
  }
  return { ok: true, id: (data as { id: string }).id };
}

/** ลบทะเบียนพนักงาน (soft-delete) */
export async function softDeleteEmployee(db: DB, tenantId: string, id: string): Promise<PayrollEmployeeActionResult> {
  const scope = await getEmployeeScope(db, tenantId, id);
  if (!scope) return { ok: false, message: "ไม่พบพนักงาน (อาจถูกลบไปแล้ว)" };
  const { error } = await db
    .from("payroll_employees")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

/** มาสก์เลขบัตรประชาชน (PDPA, 0.12) — โชว์ 4 ตัวท้ายเท่านั้น เช่น "x-xxxx-xxxxx-xx-3" */
export function maskIdCardNo(idCardNo: string | null): string | null {
  if (!idCardNo || idCardNo.length !== 13) return idCardNo;
  const last = idCardNo.slice(-1);
  return `x-xxxx-xxxxx-xx-${last}`;
}
