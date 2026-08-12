/**
 * ตั้งค่าบัญชีที่ใช้เมื่อ auto-สร้างสมุดรายวัน (draft JE) จากรายงานแพลตฟอร์ม — data layer (DB) + validate + upsert
 *
 * บริบท: ข้อ C ต่อเนื่อง — mirror `payroll-settings.ts` ทุกจุด (รหัสบัญชีไม่ hardcode FK, validate หมวด
 *   ให้ถูกต้องตามชนิด, เลือกผ่าน AccountCombobox เท่านั้น) — 1 แถวต่อ (tenant, customer)
 *   ★ ต่างจาก payroll-settings.ts ตรงที่ทุกฟิลด์ required เสมอ (ไม่มีเคส "ยังไม่ตั้งได้ตอนเริ่มต้น" —
 *   ทุกประเภทของรายงานแพลตฟอร์มต้องมีบัญชีลงให้ครบก่อนสร้าง JE ได้จริง) — ใช้ค่า default ที่สมเหตุสมผล
 *   จากผังบัญชีมาตรฐาน (migration 0063) แทน
 *
 * ★ ทุก query/write กรอง tenant_id + customer_id เสมอ
 * ★ PDPA: ไม่ log รหัสบัญชี/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { ACCOUNT_CODE_MAX } from "@/lib/accounting/manual-journal";
import type { PlatformCategory } from "@/lib/accounting/platform-report-analyze";

type DB = SupabaseClient;

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

// ★ ค่าที่แนะนำเป็นค่าเริ่มต้น — อ้างจากผังบัญชีมาตรฐานที่ seed ไว้แล้ว (migration 0063)
export const DEFAULT_SALES_ACCOUNT_CODE = "4010"; // ขายสินค้า
export const DEFAULT_COMMISSION_FEE_ACCOUNT_CODE = "5344"; // ค่าบริการแพลตฟอร์ม
export const DEFAULT_PAYMENT_FEE_ACCOUNT_CODE = "5355"; // ค่าธรรมเนียมอื่น ๆ
export const DEFAULT_SHIPPING_FEE_ACCOUNT_CODE = "5341"; // ค่าขนส่ง
export const DEFAULT_ADS_FEE_ACCOUNT_CODE = "5315"; // ค่าโฆษณา
export const DEFAULT_PENALTY_ACCOUNT_CODE = "5365"; // ค่าใช้จ่ายเบ็ดเตล็ด
export const DEFAULT_REFUND_ACCOUNT_CODE = "4010"; // หักคืนจากยอดขายบัญชีเดียวกัน (ไม่มีบัญชี "รับคืน" แยกในผังมาตรฐาน)
export const DEFAULT_OTHER_ACCOUNT_CODE = "5365"; // ค่าใช้จ่ายเบ็ดเตล็ด
export const DEFAULT_CLEARING_ACCOUNT_CODE = "1020"; // เงินฝากธนาคาร #1 (เงินที่ได้รับจริงหลังหักทุกอย่าง)

export type PlatformReportSettings = {
  id: string;
  tenantId: string;
  customerId: string;
  salesAccountCode: string;
  commissionFeeAccountCode: string;
  paymentFeeAccountCode: string;
  shippingFeeAccountCode: string;
  adsFeeAccountCode: string;
  penaltyAccountCode: string;
  refundAccountCode: string;
  otherAccountCode: string;
  clearingAccountCode: string;
  createdAt: string;
  updatedAt: string;
};

export type PlatformReportSettingsInput = {
  salesAccountCode: unknown;
  commissionFeeAccountCode: unknown;
  paymentFeeAccountCode: unknown;
  shippingFeeAccountCode: unknown;
  adsFeeAccountCode: unknown;
  penaltyAccountCode: unknown;
  refundAccountCode: unknown;
  otherAccountCode: unknown;
  clearingAccountCode: unknown;
};

type ValidatedPlatformReportSettings = {
  salesAccountCode: string;
  commissionFeeAccountCode: string;
  paymentFeeAccountCode: string;
  shippingFeeAccountCode: string;
  adsFeeAccountCode: string;
  penaltyAccountCode: string;
  refundAccountCode: string;
  otherAccountCode: string;
  clearingAccountCode: string;
};

export type PlatformReportSettingsValidationResult =
  | { ok: true; value: ValidatedPlatformReportSettings }
  | { ok: false; message: string };

export type PlatformReportSettingsActionResult = { ok: true; id: string } | { ok: false; message: string };

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

/**
 * validate + sanitize input จาก client — ปฏิเสธเสมอถ้า:
 *   - sales/refund ไม่อยู่ในผัง หรือไม่ใช่หมวด "รายได้"
 *   - commission_fee/payment_fee/shipping_fee/ads_fee/penalty/other ไม่อยู่ในผัง หรือไม่ใช่หมวด "ค่าใช้จ่าย"
 *   - clearing ไม่อยู่ในผัง หรือไม่ใช่หมวด "สินทรัพย์" (เงินสด/ธนาคารที่รับเงินสุทธิเข้ามา)
 */
export function validatePlatformReportSettingsInput(
  input: PlatformReportSettingsInput,
  chartByCode: ChartByCode
): PlatformReportSettingsValidationResult {
  const checks: { key: keyof ValidatedPlatformReportSettings; label: string; categories: string[] }[] = [
    { key: "salesAccountCode", label: "รหัสบัญชียอดขาย", categories: ["รายได้"] },
    { key: "commissionFeeAccountCode", label: "รหัสบัญชีค่าคอมมิชชั่นแพลตฟอร์ม", categories: ["ค่าใช้จ่าย"] },
    { key: "paymentFeeAccountCode", label: "รหัสบัญชีค่าธรรมเนียมการรับเงิน", categories: ["ค่าใช้จ่าย"] },
    { key: "shippingFeeAccountCode", label: "รหัสบัญชีค่าส่ง/ค่าขนส่ง", categories: ["ค่าใช้จ่าย"] },
    { key: "adsFeeAccountCode", label: "รหัสบัญชีค่าโฆษณา/โปรโมท", categories: ["ค่าใช้จ่าย"] },
    { key: "penaltyAccountCode", label: "รหัสบัญชีค่าปรับ", categories: ["ค่าใช้จ่าย"] },
    { key: "refundAccountCode", label: "รหัสบัญชีเงินคืน/ยกเลิกออเดอร์", categories: ["รายได้"] },
    { key: "otherAccountCode", label: "รหัสบัญชีอื่นๆ", categories: ["ค่าใช้จ่าย"] },
    { key: "clearingAccountCode", label: "รหัสบัญชีเงินที่ได้รับจริง (เงินสด/ธนาคาร)", categories: ["สินทรัพย์"] },
  ];

  const value: Partial<ValidatedPlatformReportSettings> = {};
  for (const c of checks) {
    const code = clampText(input[c.key], ACCOUNT_CODE_MAX);
    const r = requireAccountInCategory(code, c.label, chartByCode, c.categories);
    if (!r.ok) return r;
    value[c.key] = code as string;
  }

  return { ok: true, value: value as ValidatedPlatformReportSettings };
}

// ---------------------------------------------------------------------
// data layer (DB)
// ---------------------------------------------------------------------

type RawRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  sales_account_code: string;
  commission_fee_account_code: string;
  payment_fee_account_code: string;
  shipping_fee_account_code: string;
  ads_fee_account_code: string;
  penalty_account_code: string;
  refund_account_code: string;
  other_account_code: string;
  clearing_account_code: string;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  "id, tenant_id, customer_id, sales_account_code, commission_fee_account_code, payment_fee_account_code, shipping_fee_account_code, ads_fee_account_code, penalty_account_code, refund_account_code, other_account_code, clearing_account_code, created_at, updated_at";

function mapRow(r: RawRow): PlatformReportSettings {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    salesAccountCode: r.sales_account_code,
    commissionFeeAccountCode: r.commission_fee_account_code,
    paymentFeeAccountCode: r.payment_fee_account_code,
    shippingFeeAccountCode: r.shipping_fee_account_code,
    adsFeeAccountCode: r.ads_fee_account_code,
    penaltyAccountCode: r.penalty_account_code,
    refundAccountCode: r.refund_account_code,
    otherAccountCode: r.other_account_code,
    clearingAccountCode: r.clearing_account_code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** โหลดตั้งค่าบัญชีของลูกค้า 1 ราย — คืน null ถ้ายังไม่มีแถว (ใช้ getOrCreateDefaultSettings สร้างให้) */
export async function getSettings(db: DB, tenantId: string, customerId: string): Promise<PlatformReportSettings | null> {
  const { data } = await db
    .from("platform_report_settings")
    .select(COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!data) return null;
  return mapRow(data as unknown as RawRow);
}

/** โหลดตั้งค่าบัญชีของลูกค้า 1 ราย — ถ้ายังไม่มีแถว สร้างให้ทันทีด้วยค่าแนะนำเริ่มต้น */
export async function getOrCreateDefaultSettings(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<PlatformReportSettings> {
  const existing = await getSettings(db, tenantId, customerId);
  if (existing) return existing;

  const defaults = {
    tenant_id: tenantId,
    customer_id: customerId,
    sales_account_code: DEFAULT_SALES_ACCOUNT_CODE,
    commission_fee_account_code: DEFAULT_COMMISSION_FEE_ACCOUNT_CODE,
    payment_fee_account_code: DEFAULT_PAYMENT_FEE_ACCOUNT_CODE,
    shipping_fee_account_code: DEFAULT_SHIPPING_FEE_ACCOUNT_CODE,
    ads_fee_account_code: DEFAULT_ADS_FEE_ACCOUNT_CODE,
    penalty_account_code: DEFAULT_PENALTY_ACCOUNT_CODE,
    refund_account_code: DEFAULT_REFUND_ACCOUNT_CODE,
    other_account_code: DEFAULT_OTHER_ACCOUNT_CODE,
    clearing_account_code: DEFAULT_CLEARING_ACCOUNT_CODE,
  };
  const { data, error } = await db
    .from("platform_report_settings")
    .insert(defaults)
    .select(COLUMNS)
    .maybeSingle();
  if (error || !data) {
    // ★ race เผื่อมีคนอื่นสร้างพร้อมกันพอดี (unique tenant+customer) — โหลดของจริงกลับมาแทน throw
    const retry = await getSettings(db, tenantId, customerId);
    if (retry) return retry;
    return mapRow({ id: "", ...defaults } as unknown as RawRow);
  }
  return mapRow(data as unknown as RawRow);
}

/** สร้าง/แก้ตั้งค่าบัญชี (upsert ตาม unique tenant+customer) — validate ซ้ำฝั่ง server เสมอ */
export async function upsertSettings(
  db: DB,
  tenantId: string,
  customerId: string,
  input: PlatformReportSettingsInput,
  chartByCode: ChartByCode
): Promise<PlatformReportSettingsActionResult> {
  const v = validatePlatformReportSettingsInput(input, chartByCode);
  if (!v.ok) return { ok: false, message: v.message };

  const payload = {
    sales_account_code: v.value.salesAccountCode,
    commission_fee_account_code: v.value.commissionFeeAccountCode,
    payment_fee_account_code: v.value.paymentFeeAccountCode,
    shipping_fee_account_code: v.value.shippingFeeAccountCode,
    ads_fee_account_code: v.value.adsFeeAccountCode,
    penalty_account_code: v.value.penaltyAccountCode,
    refund_account_code: v.value.refundAccountCode,
    other_account_code: v.value.otherAccountCode,
    clearing_account_code: v.value.clearingAccountCode,
  };

  const existing = await getSettings(db, tenantId, customerId);
  if (existing) {
    const { error } = await db
      .from("platform_report_settings")
      .update(payload)
      .eq("id", existing.id)
      .eq("tenant_id", tenantId);
    if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, id: existing.id };
  }

  const { data, error } = await db
    .from("platform_report_settings")
    .insert({ tenant_id: tenantId, customer_id: customerId, ...payload })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: (data as { id: string }).id };
}

/** map ประเภทรายงานแพลตฟอร์ม → รหัสบัญชีค่าใช้จ่ายตามตั้งค่า (ใช้ตอนสร้าง JE — ดู platform-report-je.ts) */
export function accountCodeForDeductionCategory(settings: PlatformReportSettings, category: PlatformCategory): string {
  switch (category) {
    case "commission_fee":
      return settings.commissionFeeAccountCode;
    case "payment_fee":
      return settings.paymentFeeAccountCode;
    case "shipping_fee":
      return settings.shippingFeeAccountCode;
    case "ads_fee":
      return settings.adsFeeAccountCode;
    case "penalty":
      return settings.penaltyAccountCode;
    case "refund":
      return settings.refundAccountCode;
    case "sales":
    case "other":
    default:
      return settings.otherAccountCode;
  }
}
