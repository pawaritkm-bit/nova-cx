/**
 * ตั้งค่าบัญชีที่ใช้เมื่อสร้างรายการบัญชี (JE) จากรอบเงินเดือน — data layer (DB) + validate + upsert
 *
 * บริบท: เฟส 9 ส่วน AC (docs/06-accounting-features-roadmap.md, หมวด 0.11) — mirror
 *   `fixed-assets.ts::validateFixedAssetInput` (รหัสบัญชีไม่ hardcode FK, validate หมวดให้ถูกต้องตามชนิด,
 *   เลือกผ่าน AccountCombobox เท่านั้น) — 1 แถวต่อ (tenant, customer)
 *
 * ★ ทุก query/write กรอง tenant_id + customer_id เสมอ
 * ★ PDPA: ไม่ log รหัสบัญชี/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { ACCOUNT_CODE_MAX } from "@/lib/accounting/manual-journal";

type DB = SupabaseClient;

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

// ★ ค่าที่แนะนำเป็นค่าเริ่มต้น (0.11) — 5310/2910 มีอยู่แล้วจาก migration 0063, 5311/2050 seed ใหม่ (0084)
export const DEFAULT_SALARY_EXPENSE_CODE = "5310";
export const DEFAULT_SSO_EMPLOYER_EXPENSE_CODE = "5311";
export const DEFAULT_SSO_PAYABLE_CODE = "2050";
export const DEFAULT_PIT_PAYABLE_CODE = "2910";

export type PayrollSettings = {
  id: string;
  tenantId: string;
  customerId: string;
  salaryExpenseAccountCode: string;
  ssoEmployerExpenseAccountCode: string;
  ssoPayableAccountCode: string;
  pitPayableAccountCode: string;
  otherDeductionsAccountCode: string | null;
  netPayAccountCode: string | null;
  netPayIsPaidImmediately: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PayrollSettingsInput = {
  salaryExpenseAccountCode: unknown;
  ssoEmployerExpenseAccountCode: unknown;
  ssoPayableAccountCode: unknown;
  pitPayableAccountCode: unknown;
  otherDeductionsAccountCode?: unknown;
  netPayAccountCode?: unknown;
  netPayIsPaidImmediately?: unknown;
};

type ValidatedPayrollSettings = {
  salaryExpenseAccountCode: string;
  ssoEmployerExpenseAccountCode: string;
  ssoPayableAccountCode: string;
  pitPayableAccountCode: string;
  otherDeductionsAccountCode: string | null;
  netPayAccountCode: string | null;
  netPayIsPaidImmediately: boolean;
};

export type PayrollSettingsValidationResult =
  | { ok: true; value: ValidatedPayrollSettings }
  | { ok: false; message: string };

export type PayrollSettingsActionResult = { ok: true; id: string } | { ok: false; message: string };

/** ตรวจ 1 รหัสบัญชี ต้องอยู่ในผังจริง + อยู่หมวดที่กำหนด (allowedCategories) */
function requireAccountInCategory(
  code: string | null,
  label: string,
  chartByCode: ChartByCode,
  allowedCategories: string[]
): { ok: true } | { ok: false; message: string } {
  if (!code) return { ok: false, message: `ต้องเลือก${label}` };
  const acc = chartByCode[code];
  if (!acc) return { ok: false, message: `รหัสบัญชี "${code}" (${label}) ไม่อยู่ในผังบัญชี` };
  if (!allowedCategories.includes(acc.category)) {
    return { ok: false, message: `${label} ต้องอยู่ในหมวด ${allowedCategories.join("/")}` };
  }
  return { ok: true };
}

/** ตรวจรหัสบัญชี optional (nullable) — ถ้ากรอกมาต้องอยู่ในผังจริง + หมวดที่กำหนด, ไม่กรอก = ผ่าน (null) */
function requireOptionalAccountInCategory(
  code: string | null,
  label: string,
  chartByCode: ChartByCode,
  allowedCategories: string[]
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (!code) return { ok: true, value: null };
  const acc = chartByCode[code];
  if (!acc) return { ok: false, message: `รหัสบัญชี "${code}" (${label}) ไม่อยู่ในผังบัญชี` };
  if (!allowedCategories.includes(acc.category)) {
    return { ok: false, message: `${label} ต้องอยู่ในหมวด ${allowedCategories.join("/")}` };
  }
  return { ok: true, value: code };
}

/**
 * validate + sanitize input จาก client (0.11) — ปฏิเสธเสมอถ้า:
 *   - salary_expense_account_code / sso_employer_expense_account_code ไม่อยู่ในผัง หรือไม่ใช่หมวด "ค่าใช้จ่าย"
 *   - sso_payable_account_code / pit_payable_account_code ไม่อยู่ในผัง หรือไม่ใช่หมวด "หนี้สิน"
 *   - other_deductions_account_code (ถ้ากรอก) ไม่อยู่ในผัง หรือไม่ใช่หมวด "หนี้สิน"
 *   - net_pay_account_code (ถ้ากรอก) ไม่อยู่ในผัง หรือไม่ใช่หมวด "หนี้สิน"/"สินทรัพย์" (ค้างจ่าย หรือจ่ายสด/
 *     โอนธนาคารทันที ตาม net_pay_is_paid_immediately)
 */
export function validatePayrollSettingsInput(
  input: PayrollSettingsInput,
  chartByCode: ChartByCode
): PayrollSettingsValidationResult {
  const salaryExpenseAccountCode = clampText(input.salaryExpenseAccountCode, ACCOUNT_CODE_MAX);
  const r1 = requireAccountInCategory(salaryExpenseAccountCode, "รหัสบัญชีเงินเดือน", chartByCode, ["ค่าใช้จ่าย"]);
  if (!r1.ok) return r1;

  const ssoEmployerExpenseAccountCode = clampText(input.ssoEmployerExpenseAccountCode, ACCOUNT_CODE_MAX);
  const r2 = requireAccountInCategory(
    ssoEmployerExpenseAccountCode,
    "รหัสบัญชีประกันสังคม (ส่วนนายจ้าง)",
    chartByCode,
    ["ค่าใช้จ่าย"]
  );
  if (!r2.ok) return r2;

  const ssoPayableAccountCode = clampText(input.ssoPayableAccountCode, ACCOUNT_CODE_MAX);
  const r3 = requireAccountInCategory(ssoPayableAccountCode, "รหัสบัญชีประกันสังคมค้างนำส่ง", chartByCode, ["หนี้สิน"]);
  if (!r3.ok) return r3;

  const pitPayableAccountCode = clampText(input.pitPayableAccountCode, ACCOUNT_CODE_MAX);
  const r4 = requireAccountInCategory(pitPayableAccountCode, "รหัสบัญชีภาษีหัก ณ ที่จ่ายค้างจ่าย", chartByCode, [
    "หนี้สิน",
  ]);
  if (!r4.ok) return r4;

  const otherDeductionsRaw = clampText(input.otherDeductionsAccountCode, ACCOUNT_CODE_MAX);
  const r5 = requireOptionalAccountInCategory(otherDeductionsRaw, "รหัสบัญชีหักอื่น ๆ ค้างจ่าย", chartByCode, [
    "หนี้สิน",
  ]);
  if (!r5.ok) return r5;

  const netPayRaw = clampText(input.netPayAccountCode, ACCOUNT_CODE_MAX);
  const r6 = requireOptionalAccountInCategory(netPayRaw, "รหัสบัญชีเงินเดือนสุทธิ", chartByCode, [
    "หนี้สิน",
    "สินทรัพย์",
  ]);
  if (!r6.ok) return r6;

  const netPayIsPaidImmediately = !!input.netPayIsPaidImmediately;

  return {
    ok: true,
    value: {
      // ผ่าน requireAccountInCategory มาแล้ว (ok:true) การันตีไม่เป็น null
      salaryExpenseAccountCode: salaryExpenseAccountCode as string,
      ssoEmployerExpenseAccountCode: ssoEmployerExpenseAccountCode as string,
      ssoPayableAccountCode: ssoPayableAccountCode as string,
      pitPayableAccountCode: pitPayableAccountCode as string,
      otherDeductionsAccountCode: r5.value,
      netPayAccountCode: r6.value,
      netPayIsPaidImmediately,
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
  salary_expense_account_code: string;
  sso_employer_expense_account_code: string;
  sso_payable_account_code: string;
  pit_payable_account_code: string;
  other_deductions_account_code: string | null;
  net_pay_account_code: string | null;
  net_pay_is_paid_immediately: boolean;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  "id, tenant_id, customer_id, salary_expense_account_code, sso_employer_expense_account_code, sso_payable_account_code, pit_payable_account_code, other_deductions_account_code, net_pay_account_code, net_pay_is_paid_immediately, created_at, updated_at";

function mapRow(r: RawRow): PayrollSettings {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    salaryExpenseAccountCode: r.salary_expense_account_code,
    ssoEmployerExpenseAccountCode: r.sso_employer_expense_account_code,
    ssoPayableAccountCode: r.sso_payable_account_code,
    pitPayableAccountCode: r.pit_payable_account_code,
    otherDeductionsAccountCode: r.other_deductions_account_code,
    netPayAccountCode: r.net_pay_account_code,
    netPayIsPaidImmediately: r.net_pay_is_paid_immediately,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** โหลดตั้งค่าบัญชีของลูกค้า 1 ราย — คืน null ถ้ายังไม่มีแถว (ใช้ getOrCreateDefaultSettings สร้างให้) */
export async function getSettings(db: DB, tenantId: string, customerId: string): Promise<PayrollSettings | null> {
  const { data } = await db
    .from("payroll_settings")
    .select(COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!data) return null;
  return mapRow(data as unknown as RawRow);
}

/**
 * โหลดตั้งค่าบัญชีของลูกค้า 1 ราย — ถ้ายังไม่มีแถว สร้างให้ทันทีด้วยค่าแนะนำเริ่มต้น (0.11):
 *   5310 (เงินเดือน) / 5311 (ประกันสังคมนายจ้าง) / 2050 (ประกันสังคมค้างนำส่ง) / 2910 (ภาษีหัก ณ ที่จ่าย)
 *   — other_deductions/net_pay ยังเป็น null (นักบัญชีต้องเลือกเองก่อนสร้าง JE ได้จริง)
 */
export async function getOrCreateDefaultSettings(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<PayrollSettings> {
  const existing = await getSettings(db, tenantId, customerId);
  if (existing) return existing;

  const defaults = {
    tenant_id: tenantId,
    customer_id: customerId,
    salary_expense_account_code: DEFAULT_SALARY_EXPENSE_CODE,
    sso_employer_expense_account_code: DEFAULT_SSO_EMPLOYER_EXPENSE_CODE,
    sso_payable_account_code: DEFAULT_SSO_PAYABLE_CODE,
    pit_payable_account_code: DEFAULT_PIT_PAYABLE_CODE,
    other_deductions_account_code: null,
    net_pay_account_code: null,
    net_pay_is_paid_immediately: false,
  };
  const { data, error } = await db
    .from("payroll_settings")
    .insert(defaults)
    .select(COLUMNS)
    .maybeSingle();
  if (error || !data) {
    // ★ race เผื่อมีคนอื่นสร้างพร้อมกันพอดี (unique tenant+customer) — โหลดของจริงกลับมาแทน throw
    const retry = await getSettings(db, tenantId, customerId);
    if (retry) return retry;
    // fallback สุดท้าย (ไม่ควรเกิดถ้า DB ปกติ) — คืนค่า in-memory (ยังไม่ persist) ให้หน้าจอไม่ล้ม
    return mapRow({ id: "", ...defaults } as unknown as RawRow);
  }
  return mapRow(data as unknown as RawRow);
}

/** สร้าง/แก้ตั้งค่าบัญชี (upsert ตาม unique tenant+customer) — validate ซ้ำฝั่ง server เสมอ */
export async function upsertSettings(
  db: DB,
  tenantId: string,
  customerId: string,
  input: PayrollSettingsInput,
  chartByCode: ChartByCode
): Promise<PayrollSettingsActionResult> {
  const v = validatePayrollSettingsInput(input, chartByCode);
  if (!v.ok) return { ok: false, message: v.message };

  const payload = {
    salary_expense_account_code: v.value.salaryExpenseAccountCode,
    sso_employer_expense_account_code: v.value.ssoEmployerExpenseAccountCode,
    sso_payable_account_code: v.value.ssoPayableAccountCode,
    pit_payable_account_code: v.value.pitPayableAccountCode,
    other_deductions_account_code: v.value.otherDeductionsAccountCode,
    net_pay_account_code: v.value.netPayAccountCode,
    net_pay_is_paid_immediately: v.value.netPayIsPaidImmediately,
  };

  const existing = await getSettings(db, tenantId, customerId);
  if (existing) {
    const { error } = await db
      .from("payroll_settings")
      .update(payload)
      .eq("id", existing.id)
      .eq("tenant_id", tenantId);
    if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, id: existing.id };
  }

  const { data, error } = await db
    .from("payroll_settings")
    .insert({ tenant_id: tenantId, customer_id: customerId, ...payload })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: (data as { id: string }).id };
}
