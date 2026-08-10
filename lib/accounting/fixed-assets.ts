/**
 * ทะเบียนทรัพย์สินถาวร + ค่าเสื่อมราคาอัตโนมัติแบบเส้นตรง (Straight-line Depreciation) — data layer
 *   (DB) + validate + orchestrator สร้างรายการค่าเสื่อมอัตโนมัติ
 *
 * บริบท: เฟส 7 ส่วน V (docs/06-accounting-features-roadmap.md, หมวด 0.1–0.6/0.9/0.11–0.14) — ต่อยอด
 *   pattern ของ `recurring-journal.ts` (เฟส 6 ส่วน R: atomic RPC claim + cron + ปุ่ม "สร้างตอนนี้" +
 *   สร้าง manual JE เป็น draft เสมอ) แต่ต่างกันตรงที่ยอดต่อรอบ **ไม่คงที่ตลอดไป** — งวดสุดท้ายเป็น "plug"
 *   กันเศษสตางค์ค้าง และ**หยุดเองอัตโนมัติ**เมื่อค่าเสื่อมสะสมครบมูลค่าที่ต้องตัด (0.5/0.6)
 *
 * ★ 0.1 วิธีคำนวณ — เส้นตรงเท่านั้น: ค่าเสื่อมต่อเดือน = (ราคาทุน − มูลค่าซาก) ÷ อายุการใช้งาน (เดือน)
 * ★ 0.2 full-month convention — ค่าเสื่อมเดือนแรกคิดเต็มเดือนตั้งแต่เดือนของ acquisition_date ไม่ prorate
 * ★ 0.3 ห้าม auto-confirm เด็ดขาด — occurrence ค่าเสื่อมที่สร้างผ่าน upsertManualEntry เป็น status='draft'
 *   เสมอ (upsertManualEntry เดิม insert ใหม่เป็น draft เสมออยู่แล้ว — ไฟล์นี้ไม่เรียก confirmManualEntry เลย)
 * ★ 0.4 trigger การสร้างค่าเสื่อม (cron รายวัน + ปุ่ม "สร้างตอนนี้") ต้องผ่าน RPC
 *   `claim_fixed_asset_depreciation` (atomic, for update skip locked) เท่านั้น — กัน cron/ปุ่มมือชนกัน
 *   ถ้า claim ไม่ติด (ยังไม่ถึงรอบ/ไม่ active/ถูกลบ) คืน claimed:false เฉย ๆ ไม่ throw
 * ★ 0.5 งวดสุดท้ายเป็น plug (คำนวณโดย RPC ฝั่ง DB เป็นแหล่งความจริง) — รับประกันว่าค่าเสื่อมสะสมรวมทุกงวด
 *   ของทรัพย์สินหนึ่งชิ้นเท่ากับ cost−salvage เป๊ะเสมอ ไม่มีเศษสตางค์ตกค้างจากการปัดเศษสะสม
 * ★ 0.6 ทรัพย์สินที่ตัดค่าเสื่อมครบแล้ว — next_dep_date=null แต่ status ยังเป็น 'active' (ยังไม่จำหน่าย)
 * ★ 0.9 fixed_asset_id บน manual_journal_entries เป็น metadata ล้วน — ไม่กระทบ mapper
 *   toJournalLines/toJournalPosting เดิมเลย (ไม่แก้ manual-journal.ts แม้แต่บรรทัดเดียว)
 * ★ ★★ generateOne ต้องแยก "RPC error จริง" (claimErr ≠ null) ออกจาก "ยังไม่ถึงรอบ" (claimErr=null,
 *   claimed=false) ให้ถูกตั้งแต่ต้น — บั๊กเดียวกันที่เคยเกิดจริงใน recurring-journal.ts::generateOne มาก่อน
 *   แล้วถูกแก้ (ดู tests/accounting/recurring-journal.test.ts เป็นต้นแบบ) ห้ามพลาดซ้ำในไฟล์นี้
 * ★ ทุก query/write กรอง tenant_id (จาก session) + customer_id (assertCustomerInScope ทำที่ actions.ts ชั้นบน)
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า
 *
 * ★ 0.7 การจำหน่ายทรัพย์สิน (disposeAsset) — ไม่คิดค่าเสื่อมของเดือนที่จำหน่ายเพิ่มก่อน (ใช้
 *   accumulated_depreciation ณ ปัจจุบันตรง ๆ เป็นฐานคำนวณ NBV) สร้าง manual JE ปิดบัญชีทรัพย์สิน/
 *   ค่าเสื่อมสะสม + ปรับสมดุลด้วยกำไร/ขาดทุน (ข้ามบรรทัดที่ยอด=0 ทั้งคู่ เพราะ validateManualEntryInput
 *   เดิมปฏิเสธบรรทัด debit=credit=0 — ดู MIN_LINES/nonZero ของ manual-journal.ts)
 * ★ 0.8 undisposeAsset — undo ได้เฉพาะ disposal JE ที่ยัง draft (ยังไม่ confirm) เท่านั้น คืน
 *   next_dep_date เป็นเดือนถัดไปจาก "งวดค่าเสื่อมที่ generate ล่าสุดจริง" (จาก
 *   fixed_asset_depreciation_log) ไม่ใช่ accumulated_depreciation ตรง ๆ (ค่านั้นไม่มีข้อมูลวันที่)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { round2 } from "@/lib/accounting/queries";
import { isValidCalendarDate } from "@/lib/accounting/bank-reconciliation";
import { addMonthsClamped } from "@/lib/accounting/recurring-journal";
import {
  upsertManualEntry,
  getManualEntryScope,
  softDeleteManualEntry,
  ACCOUNT_CODE_MAX,
  type ManualEntryInput,
  type ManualEntryLineInput,
  type ManualEntryStatus,
} from "@/lib/accounting/manual-journal";

type DB = SupabaseClient;

export type FixedAssetStatus = "active" | "disposed";

/** เพดานความยาว (กัน payload ใหญ่ผิดปกติ) */
export const ASSET_NAME_MAX = 200;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIST_LIMIT = 500;
const LOG_LIMIT = 200;
const CANDIDATE_LIMIT = 2000;

// ---------------------------------------------------------------------
// helper เล็ก ๆ (private — มิเรอร์ manual-journal.ts/recurring-journal.ts)
// ---------------------------------------------------------------------

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** แปลงเป็นตัวเลข ปัด 2 ตำแหน่ง — ต่างจาก asAmount ของ manual-journal.ts ที่บังคับ >0 (ที่นี่ 0/ลบผ่านมาได้
 *  ให้ชั้น validate ตัดสินเอง เพราะ salvage_value/accumulated_depreciation ที่ 0 เป็นค่าปกติที่ถูกต้อง) */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? round2(n) : 0;
}

/** เหมือน num() แต่คืน null เมื่อค่าไม่ใช่ตัวเลขจริง ๆ (แยก "0 ที่ถูกต้อง" ออกจาก "ค่าไม่ถูกต้อง" ตอน validate) */
function parseMoney(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? round2(n) : null;
}

// ---------------------------------------------------------------------
// ชนิดข้อมูล
// ---------------------------------------------------------------------

/** ทะเบียนทรัพย์สินถาวร 1 ชิ้น */
export type FixedAsset = {
  id: string;
  tenantId: string;
  customerId: string;
  name: string;
  assetAccountCode: string;
  accumDepAccountCode: string;
  depExpenseAccountCode: string;
  /** YYYY-MM-DD */
  acquisitionDate: string;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  monthlyDepreciation: number;
  accumulatedDepreciation: number;
  /** null = ไม่มีรอบถัดไปให้สร้าง (ตัดค่าเสื่อมครบแล้ว 0.6 หรือจำหน่ายแล้ว) — advance โดย RPC claim เท่านั้น */
  nextDepDate: string | null;
  status: FixedAssetStatus;
  disposalDate: string | null;
  disposalProceeds: number | null;
  disposalEntryId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** input ดิบจาก client */
export type FixedAssetInput = {
  name: unknown;
  assetAccountCode: unknown;
  accumDepAccountCode: unknown;
  depExpenseAccountCode: unknown;
  /** YYYY-MM-DD */
  acquisitionDate: unknown;
  cost: unknown;
  salvageValue: unknown;
  usefulLifeMonths: unknown;
};

export type ValidatedFixedAssetInput = {
  name: string;
  assetAccountCode: string;
  accumDepAccountCode: string;
  depExpenseAccountCode: string;
  acquisitionDate: string;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  monthlyDepreciation: number;
};

export type FixedAssetValidationResult =
  | { ok: true; value: ValidatedFixedAssetInput }
  | { ok: false; message: string };

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline (มิเรอร์ ManualActionResult/RecurringActionResult) */
export type FixedAssetActionResult = { ok: true; id: string } | { ok: false; message: string };

/** ประวัติค่าเสื่อม 1 งวด (fixed_asset_depreciation_log) — โชว์เหตุผลที่ล้มเหลว ให้เห็นชัดเจนไม่เงียบหาย */
export type DepreciationLogEntry = {
  id: string;
  assetId: string;
  /** YYYY-MM-DD */
  period: string;
  amount: number | null;
  status: "generated" | "failed";
  message: string | null;
  manualEntryId: string | null;
  createdAt: string;
};

/** occurrence (manual_journal_entries) ที่ผูกกับทรัพย์สินต้นทาง (0.9) */
export type FixedAssetOccurrence = {
  id: string;
  assetId: string;
  docDate: string;
  docNo: string | null;
  status: ManualEntryStatus;
};

// ---------------------------------------------------------------------
// validate (pure) — server ต้อง re-validate เสมอ ไม่เชื่อ client (0.11)
// ---------------------------------------------------------------------

/**
 * validate + sanitize ทะเบียนทรัพย์สินจาก client — ปฏิเสธเสมอถ้า:
 *   - ไม่มีชื่อ
 *   - asset_account_code/accum_dep_account_code ไม่อยู่ในผัง หรือไม่ใช่หมวด "สินทรัพย์"
 *   - dep_expense_account_code ไม่อยู่ในผัง หรือไม่ใช่หมวด "ค่าใช้จ่าย"
 *   - cost ไม่ใช่ตัวเลข/ ≤ 0
 *   - salvage_value ไม่ใช่ตัวเลข/ < 0 / >= cost (0.11 ต้อง salvage < cost เป๊ะ)
 *   - useful_life_months ไม่ใช่จำนวนเต็ม/ ≤ 0
 *   - acquisition_date ผิดรูปแบบ หรือไม่มีวันที่นี้จริงในปฏิทิน (reuse isValidCalendarDate)
 */
export function validateFixedAssetInput(
  input: FixedAssetInput,
  chartByCode: ChartByCode
): FixedAssetValidationResult {
  const name = clampText(input.name, ASSET_NAME_MAX);
  if (!name) return { ok: false, message: "ต้องระบุชื่อทรัพย์สิน" };

  const assetAccountCode = clampText(input.assetAccountCode, ACCOUNT_CODE_MAX);
  if (!assetAccountCode) return { ok: false, message: "ต้องเลือกรหัสบัญชีสินทรัพย์" };
  const assetAcc = chartByCode[assetAccountCode];
  if (!assetAcc) return { ok: false, message: `รหัสบัญชี "${assetAccountCode}" ไม่อยู่ในผังบัญชี` };
  if (assetAcc.category !== "สินทรัพย์") {
    return { ok: false, message: "รหัสบัญชีสินทรัพย์ต้องอยู่ในหมวดสินทรัพย์" };
  }

  const accumDepAccountCode = clampText(input.accumDepAccountCode, ACCOUNT_CODE_MAX);
  if (!accumDepAccountCode) return { ok: false, message: "ต้องเลือกรหัสบัญชีค่าเสื่อมสะสม" };
  const accumAcc = chartByCode[accumDepAccountCode];
  if (!accumAcc) return { ok: false, message: `รหัสบัญชี "${accumDepAccountCode}" ไม่อยู่ในผังบัญชี` };
  if (accumAcc.category !== "สินทรัพย์") {
    return { ok: false, message: "รหัสบัญชีค่าเสื่อมสะสมต้องอยู่ในหมวดสินทรัพย์" };
  }

  const depExpenseAccountCode = clampText(input.depExpenseAccountCode, ACCOUNT_CODE_MAX);
  if (!depExpenseAccountCode) return { ok: false, message: "ต้องเลือกรหัสบัญชีค่าเสื่อมราคา" };
  const depExpAcc = chartByCode[depExpenseAccountCode];
  if (!depExpAcc) return { ok: false, message: `รหัสบัญชี "${depExpenseAccountCode}" ไม่อยู่ในผังบัญชี` };
  if (depExpAcc.category !== "ค่าใช้จ่าย") {
    return { ok: false, message: "รหัสบัญชีค่าเสื่อมราคาต้องอยู่ในหมวดค่าใช้จ่าย" };
  }

  const acquisitionDate =
    typeof input.acquisitionDate === "string" && DATE_RE.test(input.acquisitionDate)
      ? input.acquisitionDate
      : "";
  if (!acquisitionDate) return { ok: false, message: "ต้องระบุวันที่ซื้อให้ถูกรูปแบบ (YYYY-MM-DD)" };
  // ★ กัน bug จริง: regex ผ่านแต่ไม่มีวันที่นี้จริงในปฏิทิน (เช่น 2026-02-30) — reuse isValidCalendarDate
  //   ของ bank-reconciliation.ts ตรง ๆ (ไม่ duplicate)
  if (!isValidCalendarDate(acquisitionDate)) {
    return { ok: false, message: "วันที่ซื้อไม่ถูกต้อง (ไม่มีวันที่นี้จริงในปฏิทิน)" };
  }

  const cost = parseMoney(input.cost);
  if (cost === null || cost <= 0) return { ok: false, message: "ราคาทุนต้องเป็นตัวเลขมากกว่า 0" };

  const salvageValue = parseMoney(input.salvageValue);
  if (salvageValue === null || salvageValue < 0) {
    return { ok: false, message: "มูลค่าซากต้องเป็นตัวเลขไม่ติดลบ" };
  }
  if (salvageValue >= cost) {
    return { ok: false, message: "มูลค่าซากต้องน้อยกว่าราคาทุน" };
  }

  const rawLife = typeof input.usefulLifeMonths === "number" ? input.usefulLifeMonths : Number(input.usefulLifeMonths);
  if (!Number.isFinite(rawLife) || !Number.isInteger(rawLife) || rawLife <= 0) {
    return { ok: false, message: "อายุการใช้งานต้องเป็นจำนวนเต็มเดือนมากกว่า 0" };
  }
  const usefulLifeMonths = rawLife;

  const monthlyDepreciation = monthlyDepreciationAmount(cost, salvageValue, usefulLifeMonths);

  return {
    ok: true,
    value: {
      name,
      assetAccountCode,
      accumDepAccountCode,
      depExpenseAccountCode,
      acquisitionDate,
      cost,
      salvageValue,
      usefulLifeMonths,
      monthlyDepreciation,
    },
  };
}

// ---------------------------------------------------------------------
// สูตรคำนวณ (pure) — 0.1/0.5
// ---------------------------------------------------------------------

/** ค่าเสื่อมต่อเดือน (เส้นตรง) = (ราคาทุน − มูลค่าซาก) ÷ อายุการใช้งาน (เดือน) ปัด 2 ตำแหน่ง (0.1)
 *   ★ นี่คือค่า "คงที่" ที่เก็บไว้ตอนสร้างทะเบียน — งวดสุดท้ายจะถูกปรับเป็น "plug" โดย RPC ฝั่ง DB เอง (0.5)
 *   ไม่ใช่ค่านี้ตรง ๆ ทุกงวด (RPC เป็นแหล่งความจริงของยอดจริงต่องวด)
 */
export function monthlyDepreciationAmount(cost: number, salvageValue: number, usefulLifeMonths: number): number {
  if (
    !Number.isFinite(cost) ||
    !Number.isFinite(salvageValue) ||
    !Number.isInteger(usefulLifeMonths) ||
    usefulLifeMonths <= 0
  ) {
    return 0;
  }
  return round2((cost - salvageValue) / usefulLifeMonths);
}

/** มูลค่าตามบัญชี (Net Book Value) ปัจจุบัน = ราคาทุน − ค่าเสื่อมสะสม */
export function netBookValue(asset: { cost: number; accumulatedDepreciation: number }): number {
  return round2(asset.cost - asset.accumulatedDepreciation);
}

// ---------------------------------------------------------------------
// data layer (DB) — CRUD ทะเบียนทรัพย์สิน (T58) — ล็อกแก้/ลบเมื่อมีประวัติค่าเสื่อมแล้ว (0.12)
// ---------------------------------------------------------------------

type RawAssetRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  name: string;
  asset_account_code: string;
  accum_dep_account_code: string;
  dep_expense_account_code: string;
  acquisition_date: string;
  cost: number | string;
  salvage_value: number | string;
  useful_life_months: number;
  monthly_depreciation: number | string;
  accumulated_depreciation: number | string;
  next_dep_date: string | null;
  status: string;
  disposal_date: string | null;
  disposal_proceeds: number | string | null;
  disposal_entry_id: string | null;
  created_at: string;
  updated_at: string;
};

const ASSET_COLUMNS =
  "id, tenant_id, customer_id, name, asset_account_code, accum_dep_account_code, dep_expense_account_code, " +
  "acquisition_date, cost, salvage_value, useful_life_months, monthly_depreciation, accumulated_depreciation, " +
  "next_dep_date, status, disposal_date, disposal_proceeds, disposal_entry_id, created_at, updated_at";

function mapAssetRow(r: RawAssetRow): FixedAsset {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    name: r.name,
    assetAccountCode: r.asset_account_code,
    accumDepAccountCode: r.accum_dep_account_code,
    depExpenseAccountCode: r.dep_expense_account_code,
    acquisitionDate: r.acquisition_date,
    cost: num(r.cost),
    salvageValue: num(r.salvage_value),
    usefulLifeMonths: r.useful_life_months,
    monthlyDepreciation: num(r.monthly_depreciation),
    accumulatedDepreciation: num(r.accumulated_depreciation),
    nextDepDate: r.next_dep_date,
    status: (r.status as FixedAssetStatus) ?? "active",
    disposalDate: r.disposal_date,
    disposalProceeds: r.disposal_proceeds === null || r.disposal_proceeds === undefined ? null : num(r.disposal_proceeds),
    disposalEntryId: r.disposal_entry_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** ดึงทะเบียนทรัพย์สินทั้งหมด (active+disposed) ของลูกค้า 1 ราย เรียงสร้างล่าสุดก่อน */
export async function listAssets(db: DB, tenantId: string, customerId: string): Promise<FixedAsset[]> {
  const { data, error } = await db
    .from("fixed_assets")
    .select(ASSET_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error || !data) return [];
  return (data as unknown as RawAssetRow[]).map(mapAssetRow);
}

/** โหลด customer_id + สถานะประวัติค่าเสื่อมของทรัพย์สิน 1 ชิ้น (scope tenant) — ใช้ตรวจสโคปก่อนแก้/ลบ (0.13) */
export type FixedAssetScope = {
  customerId: string;
  accumulatedDepreciation: number;
  status: FixedAssetStatus;
};

export async function getAssetScope(db: DB, tenantId: string, id: string): Promise<FixedAssetScope | null> {
  const { data } = await db
    .from("fixed_assets")
    .select("customer_id, accumulated_depreciation, status")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as { customer_id: string; accumulated_depreciation: number | string; status: string };
  return {
    customerId: r.customer_id,
    accumulatedDepreciation: num(r.accumulated_depreciation),
    status: (r.status as FixedAssetStatus) ?? "active",
  };
}

/**
 * สร้าง/แก้ทะเบียนทรัพย์สิน — validate ซ้ำฝั่ง server เสมอ
 *   - id ระบุ = update ทะเบียนเดิม (ต้องยัง status='active' — 0.7 จำหน่ายแล้วแก้ไม่ได้)
 *     ★ 0.12: ถ้ามีประวัติค่าเสื่อมแล้ว (accumulated_depreciation>0) ห้ามแก้ราคาทุน/มูลค่าซาก/
 *     อายุการใช้งาน/วันที่ซื้อ — อนุญาตแก้ได้แค่ชื่อ/รหัสบัญชี 3 ตัว
 *   - id ไม่ระบุ = สร้างใหม่ (accumulated_depreciation=0, next_dep_date=acquisition_date เสมอ —
 *     รอบแรกตรงเดือนที่ซื้อพอดี ตาม full-month convention 0.2)
 */
export async function upsertAsset(
  db: DB,
  tenantId: string,
  customerId: string,
  input: FixedAssetInput,
  chartByCode: ChartByCode,
  id?: string
): Promise<FixedAssetActionResult> {
  const v = validateFixedAssetInput(input, chartByCode);
  if (!v.ok) return { ok: false, message: v.message };

  if (id) {
    const { data } = await db
      .from("fixed_assets")
      .select("customer_id, status, cost, salvage_value, useful_life_months, acquisition_date, accumulated_depreciation")
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data) return { ok: false, message: "ไม่พบทรัพย์สิน (อาจถูกลบไปแล้ว)" };
    const cur = data as {
      customer_id: string;
      status: string;
      cost: number | string;
      salvage_value: number | string;
      useful_life_months: number;
      acquisition_date: string;
      accumulated_depreciation: number | string;
    };
    if (cur.customer_id !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับทรัพย์สินเดิม" };
    if (cur.status !== "active") return { ok: false, message: "ทรัพย์สินนี้ถูกจำหน่ายไปแล้ว — แก้ไขไม่ได้" };

    const accumulated = num(cur.accumulated_depreciation);
    if (accumulated > 0) {
      const costChanged = num(cur.cost) !== v.value.cost;
      const salvageChanged = num(cur.salvage_value) !== v.value.salvageValue;
      const lifeChanged = cur.useful_life_months !== v.value.usefulLifeMonths;
      const dateChanged = cur.acquisition_date !== v.value.acquisitionDate;
      if (costChanged || salvageChanged || lifeChanged || dateChanged) {
        return {
          ok: false,
          message:
            "ทรัพย์สินนี้มีประวัติค่าเสื่อมแล้ว — แก้ไขราคาทุน/มูลค่าซาก/อายุการใช้งาน/วันที่ซื้อไม่ได้ (แก้ได้แค่ชื่อ/รหัสบัญชี)",
        };
      }
    }

    const { error } = await db
      .from("fixed_assets")
      .update({
        name: v.value.name,
        asset_account_code: v.value.assetAccountCode,
        accum_dep_account_code: v.value.accumDepAccountCode,
        dep_expense_account_code: v.value.depExpenseAccountCode,
        acquisition_date: v.value.acquisitionDate,
        cost: v.value.cost,
        salvage_value: v.value.salvageValue,
        useful_life_months: v.value.usefulLifeMonths,
        monthly_depreciation: v.value.monthlyDepreciation,
      })
      .eq("id", id)
      .eq("tenant_id", tenantId);
    if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, id };
  }

  // insert ใหม่ — next_dep_date = acquisition_date เสมอ (รอบแรกตรงเดือนที่ซื้อ — 0.2)
  const { data, error } = await db
    .from("fixed_assets")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      name: v.value.name,
      asset_account_code: v.value.assetAccountCode,
      accum_dep_account_code: v.value.accumDepAccountCode,
      dep_expense_account_code: v.value.depExpenseAccountCode,
      acquisition_date: v.value.acquisitionDate,
      cost: v.value.cost,
      salvage_value: v.value.salvageValue,
      useful_life_months: v.value.usefulLifeMonths,
      monthly_depreciation: v.value.monthlyDepreciation,
      accumulated_depreciation: 0,
      next_dep_date: v.value.acquisitionDate,
      status: "active",
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "เพิ่มทรัพย์สินไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: (data as { id: string }).id };
}

/** ลบทะเบียนทรัพย์สิน (soft-delete) — ปฏิเสธถ้ามีประวัติค่าเสื่อมแล้ว (accumulated_depreciation>0, 0.12) */
export async function softDeleteAsset(db: DB, tenantId: string, id: string): Promise<FixedAssetActionResult> {
  const cur = await getAssetScope(db, tenantId, id);
  if (!cur) return { ok: false, message: "ไม่พบทรัพย์สิน (อาจถูกลบไปแล้ว)" };
  if (cur.status === "disposed") {
    return { ok: false, message: "ทรัพย์สินนี้จำหน่ายไปแล้ว — ลบไม่ได้ (ต้องยกเลิกการจำหน่ายก่อน)" };
  }
  if (cur.accumulatedDepreciation > 0) {
    return {
      ok: false,
      message: "ทรัพย์สินนี้มีประวัติค่าเสื่อมแล้ว — ลบไม่ได้ (ต้องยกเลิกยืนยัน JE ค่าเสื่อมทุกใบที่เกี่ยวข้องก่อน)",
    };
  }
  const { error } = await db
    .from("fixed_assets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

// ---------------------------------------------------------------------
// log การ generate + occurrence ที่สร้างแล้ว — สำหรับหน้า UI (ประวัติ/ลิงก์กลับ journal-entry)
// ---------------------------------------------------------------------

/** ประวัติค่าเสื่อมของทรัพย์สิน 1 ชิ้น (ล่าสุดก่อน) — โชว์ว่างวดไหนสำเร็จ/ล้มเหลว+เหตุผล */
export async function listDepreciationLog(db: DB, tenantId: string, assetId: string): Promise<DepreciationLogEntry[]> {
  const { data } = await db
    .from("fixed_asset_depreciation_log")
    .select("id, asset_id, period, amount, status, message, manual_entry_id, created_at")
    .eq("tenant_id", tenantId)
    .eq("asset_id", assetId)
    .order("period", { ascending: false })
    .limit(LOG_LIMIT);
  return ((data ?? []) as {
    id: string;
    asset_id: string;
    period: string;
    amount: number | string | null;
    status: string;
    message: string | null;
    manual_entry_id: string | null;
    created_at: string;
  }[]).map((r) => ({
    id: r.id,
    assetId: r.asset_id,
    period: r.period,
    amount: r.amount === null || r.amount === undefined ? null : num(r.amount),
    status: (r.status as "generated" | "failed") ?? "failed",
    message: r.message,
    manualEntryId: r.manual_entry_id,
    createdAt: r.created_at,
  }));
}

/**
 * occurrence (manual_journal_entries) ที่ผูกกับทรัพย์สินของลูกค้ารายนี้ทั้งหมด — โหลดครั้งเดียว (ไม่วน N+1
 *   ต่อทรัพย์สิน) แล้วให้ผู้เรียกจัดกลุ่มตาม assetId เอง (ลิงก์กลับหน้า journal-entry)
 */
export async function listOccurrencesByAssetIds(
  db: DB,
  tenantId: string,
  customerId: string,
  assetIds: string[]
): Promise<FixedAssetOccurrence[]> {
  if (assetIds.length === 0) return [];
  const { data } = await db
    .from("manual_journal_entries")
    .select("id, doc_date, doc_no, status, fixed_asset_id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .in("fixed_asset_id", assetIds)
    .is("deleted_at", null)
    .order("doc_date", { ascending: false })
    .limit(LIST_LIMIT);
  return ((data ?? []) as {
    id: string;
    doc_date: string;
    doc_no: string | null;
    status: string;
    fixed_asset_id: string | null;
  }[])
    .filter((r) => !!r.fixed_asset_id)
    .map((r) => ({
      id: r.id,
      assetId: r.fixed_asset_id as string,
      docDate: r.doc_date,
      docNo: r.doc_no,
      status: (r.status as ManualEntryStatus) ?? "draft",
    }));
}

// ---------------------------------------------------------------------
// orchestrator — generate ค่าเสื่อมจริง (T59) ★ จุดสำคัญที่สุดของเฟส 7-V
// ---------------------------------------------------------------------

export type GenerateDepreciationResult =
  | { status: "generated"; assetId: string; manualEntryId: string }
  | { status: "failed"; assetId: string; message: string }
  | { status: "skipped"; assetId: string };

type RawClaimResult = {
  claimed: boolean;
  period?: string;
  amount?: number | string;
  customer_id?: string;
  name?: string;
  dep_expense_account_code?: string;
  accum_dep_account_code?: string;
};

type FixedAssetPrecheckRow = {
  status: string;
  next_dep_date: string | null;
  dep_expense_account_code: string;
  accum_dep_account_code: string;
};

/**
 * core: claim ค่าเสื่อม 1 งวดของทรัพย์สิน 1 ชิ้น (atomic RPC) → สร้าง occurrence (draft เสมอ, 0.3) +
 *   เขียน log — ไม่ throw ออกนอก
 *
 * ★★★ จุดเสี่ยงสูงสุดของเฟสนี้ — ต้องแยก 2 กรณีให้ถูกตั้งแต่ต้น:
 *   1) `claimErr` ≠ null (RPC error จริง เช่น migration ไม่ครบ/DB connection พัง) → log status:'failed'
 *      ทันที คืน {status:'failed', message} — ห้ามรวมกับกรณีที่ 2
 *   2) `claimErr` = null แต่ `!claimData.claimed` (ยังไม่ถึงรอบ/ไม่ active/ถูกลบ/มีคนอื่น claim ไปแล้ว)
 *      → คืน {status:'skipped'} เงียบ ๆ ไม่ log — บั๊กเดียวกันนี้เคยเกิดจริงใน recurring-journal.ts
 *      มาก่อนแล้วถูกแก้ (ดู tests/accounting/recurring-journal.test.ts) ห้ามพลาดซ้ำ
 *
 * ★★★ บั๊กร้ายแรงที่เคยเกิดจริง (แก้แล้ว — code review): RPC `claim_fixed_asset_depreciation` เขียน
 *   accumulated_depreciation/next_dep_date ทันทีในทรานแซกชันของตัวเอง (คนละ statement กับ
 *   upsertManualEntry ที่ตามมา) — ถ้า upsertManualEntry ล้มเหลว (เช่น รหัสบัญชีถูกลบออกจากผังไปแล้ว)
 *   โดยไม่มีการป้องกันใด ๆ งวดนั้นจะ "หาย" ไปเลย: accumulated_depreciation เพิ่มไปแล้ว, next_dep_date
 *   เลื่อนไปแล้ว แต่ไม่มี manual JE ใด ๆ รองรับงวดนั้น และไม่มีทาง generate ซ้ำผ่าน UI ได้อีก (NBV ที่แสดง
 *   จะสูงเกินจริงเทียบกับค่าเสื่อมจริงใน GL อย่างเงียบ ๆ และกู้คืนไม่ได้ผ่านหน้าจอ) — ป้องกัน 2 ชั้น:
 *     ชั้น 1 (precheck): เช็ครหัสบัญชีของทรัพย์สินกับ chartByCode ก่อนเรียก RPC เลย — เฉพาะกรณีที่ตอนนี้
 *       "ถึงรอบจริง" ตาม gating เดียวกับที่ RPC ใช้ (status='active' && next_dep_date<=today) ไม่งั้น
 *       ทรัพย์สินที่ยังไม่ถึงรอบแต่บัญชีบังเอิญถูกลบจะถูกรายงานเป็น 'failed' ทั้งที่ควร skip เงียบ ๆ (0.4)
 *     ชั้น 2 (compensating rollback): เผื่อ upsertManualEntry ล้มเหลวด้วยเหตุอื่นที่ precheck ตรวจไม่พบ
 *       (เช่น DB error ชั่วคราว) — revert accumulated_depreciation/next_dep_date กลับเป็นค่าก่อน claim
 *       โดยอ่านค่าปัจจุบันสด ๆ ก่อน revert แล้วกันชนด้วย WHERE เช็คว่ายังตรงกับที่อ่านมาพอดี (ป้องกัน race
 *       กับ claim อื่นที่อาจเกิดขึ้นคาบเกี่ยวกันพอดีในช่องว่างเวลาสั้น ๆ นี้ — ถ้าไม่ตรง แปลว่ามี claim ใหม่
 *       เกิดขึ้นแล้ว ห้าม revert ไปทับ state ที่ถูกต้องของมัน)
 */
export async function generateOne(
  db: DB,
  tenantId: string,
  assetId: string,
  today: string,
  chartByCode: ChartByCode
): Promise<GenerateDepreciationResult> {
  // ★ ชั้น 1: precheck รหัสบัญชีก่อนเรียก RPC เลย (ดูคำอธิบายเต็มด้านบน) — ไม่ commit state ใด ๆ
  //   ก่อนรู้ว่าจะสร้าง JE สำเร็จหรือไม่
  const { data: precheckData } = await db
    .from("fixed_assets")
    .select("status, next_dep_date, dep_expense_account_code, accum_dep_account_code")
    .eq("id", assetId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (precheckData) {
    const p = precheckData as FixedAssetPrecheckRow;
    // ★ ต้องเลียนแบบ gating เดียวกับ RPC เป๊ะ (status='active' && next_dep_date<=today) — ไม่งั้น
    //   ทรัพย์สินที่ยังไม่ถึงรอบจะถูกรายงานเป็น 'failed' ผิด ๆ ทั้งที่ควร skip เงียบ ๆ (0.4)
    const isDueNow = p.status === "active" && !!p.next_dep_date && p.next_dep_date <= today;
    if (isDueNow) {
      const missing = [p.dep_expense_account_code, p.accum_dep_account_code].filter(
        (code) => !chartByCode[code]
      );
      if (missing.length > 0) {
        const message = `รหัสบัญชี "${missing.join(", ")}" ไม่อยู่ในผังบัญชีแล้ว (ถูกลบ/เปลี่ยนไป) — แก้ทะเบียนทรัพย์สินให้เลือกรหัสบัญชีที่ยังมีอยู่ก่อน จึงจะสร้างรายการค่าเสื่อมงวดนี้ได้`;
        await db.from("fixed_asset_depreciation_log").insert({
          tenant_id: tenantId,
          asset_id: assetId,
          period: p.next_dep_date,
          status: "failed",
          message,
        });
        return { status: "failed", assetId, message };
      }
    }
  }

  const { data: claimData, error: claimErr } = await db.rpc("claim_fixed_asset_depreciation", {
    p_tenant_id: tenantId,
    p_asset_id: assetId,
    p_today: today,
  });

  // ★ กรณีที่ 1: RPC error จริง — ต่างจากกรณี "ยังไม่ถึงรอบ" ด้านล่าง (claim.claimed=false, claimErr=null)
  //   ที่ skip เงียบตามปกติ (0.4) — error จริงต้อง log เป็น failed ให้เห็นชัดเจนเสมอ ไม่เงียบหายไป
  if (claimErr) {
    const message = claimErr.message || "เรียก RPC claim_fixed_asset_depreciation ไม่สำเร็จ";
    await db.from("fixed_asset_depreciation_log").insert({
      tenant_id: tenantId,
      asset_id: assetId,
      period: today,
      status: "failed",
      message,
    });
    return { status: "failed", assetId, message };
  }
  if (!claimData) return { status: "skipped", assetId };

  const claim = claimData as RawClaimResult;
  // ★ กรณีที่ 2: ยังไม่ถึงรอบ/ไม่ active/ถูกลบ/มีคนอื่น claim ไปแล้ว — skip เงียบ ๆ ไม่ log (0.4)
  if (!claim.claimed) return { status: "skipped", assetId };

  const period = claim.period ?? today;
  const customerId = claim.customer_id ?? "";
  const amount = num(claim.amount);
  const name = claim.name ?? "ทรัพย์สิน";
  const depExpenseCode = claim.dep_expense_account_code ?? "";
  const accumDepCode = claim.accum_dep_account_code ?? "";

  const manualInput: ManualEntryInput = {
    docType: "JV",
    docDate: period,
    docNo: null,
    memo: `ค่าเสื่อมราคา - ${name}`,
    lines: [
      { accountCode: depExpenseCode, accountName: null, description: null, debit: amount, credit: 0 },
      { accountCode: accumDepCode, accountName: null, description: null, debit: 0, credit: amount },
    ],
  };

  // ★ 0.3 upsertManualEntry เดิม insert ใหม่เป็น status='draft' เสมอ — ไม่เรียก confirmManualEntry ที่นี่เด็ดขาด
  const res = await upsertManualEntry(db, tenantId, customerId, manualInput, chartByCode);
  if (!res.ok) {
    // ★ ชั้น 2: compensating rollback — ถึงจุดนี้ RPC claim สำเร็จไปแล้ว (commit accumulated_depreciation/
    //   next_dep_date ไปแล้วในทรานแซกชันของตัวเอง) แต่สร้าง manual JE ไม่สำเร็จด้วยเหตุอื่นที่ precheck
    //   ชั้น 1 ด้านบนตรวจไม่พบ (เช่น DB error ชั่วคราวตอน insert) — ต้อง revert กลับเป็นค่าก่อน claim
    //   ไม่งั้นงวดนี้จะ "หาย" (เพิ่มค่าเสื่อมสะสม/เลื่อนรอบไปแล้วทั้งที่ไม่มี JE รองรับ กู้คืนผ่าน UI ไม่ได้อีก)
    const { data: freshData } = await db
      .from("fixed_assets")
      .select("accumulated_depreciation, next_dep_date")
      .eq("id", assetId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (freshData) {
      const fresh = freshData as { accumulated_depreciation: number | string; next_dep_date: string | null };
      const currentAccum = num(fresh.accumulated_depreciation);
      const revertedAccum = round2(currentAccum - amount);
      // ★ กันชนด้วย WHERE เช็คว่าค่าปัจจุบันยังตรงกับที่อ่านมาสด ๆ ก่อน revert พอดี (ป้องกัน race กับ claim
      //   อื่นที่อาจเกิดขึ้นคาบเกี่ยวกันพอดีในช่องว่างเวลาสั้น ๆ นี้ — ถ้าไม่ตรง ห้าม revert ไปทับ state ใหม่)
      if (fresh.next_dep_date === null) {
        await db
          .from("fixed_assets")
          .update({ accumulated_depreciation: revertedAccum, next_dep_date: period })
          .eq("id", assetId)
          .eq("tenant_id", tenantId)
          .eq("accumulated_depreciation", currentAccum)
          .is("next_dep_date", null);
      } else {
        await db
          .from("fixed_assets")
          .update({ accumulated_depreciation: revertedAccum, next_dep_date: period })
          .eq("id", assetId)
          .eq("tenant_id", tenantId)
          .eq("accumulated_depreciation", currentAccum)
          .eq("next_dep_date", fresh.next_dep_date);
      }
    }

    // ★ บัญชีถูกลบ/ไม่ครบ ฯลฯ → validate ปฏิเสธตามปกติ ไม่ throw — log แล้วให้ทรัพย์สินอื่นทำต่อ
    await db.from("fixed_asset_depreciation_log").insert({
      tenant_id: tenantId,
      asset_id: assetId,
      period,
      status: "failed",
      message: res.message,
    });
    return { status: "failed", assetId, message: res.message };
  }

  // ★ 0.9: ผูก occurrence → ทรัพย์สินต้นทาง (metadata ล้วน ไม่กระทบ mapper บัญชีใด ๆ)
  await db
    .from("manual_journal_entries")
    .update({ fixed_asset_id: assetId })
    .eq("id", res.id)
    .eq("tenant_id", tenantId);

  await db.from("fixed_asset_depreciation_log").insert({
    tenant_id: tenantId,
    asset_id: assetId,
    period,
    amount,
    status: "generated",
    manual_entry_id: res.id,
  });

  return { status: "generated", assetId, manualEntryId: res.id };
}

export type GenerateDueDepreciationSummary = {
  scanned: number;
  generated: number;
  failed: number;
  skipped: number;
  results: GenerateDepreciationResult[];
};

/**
 * สแกนทุกทรัพย์สิน active ของ tenant ที่ next_dep_date <= today → claim + generate ทีละชิ้น
 *   ★ ครอบ try/catch ต่อทรัพย์สิน — ชิ้นหนึ่งพัง (เช่น account_code ถูกลบ, DB error ไม่คาดคิด) ต้องไม่ทำให้
 *     ทรัพย์สินอื่นของ tenant เดียวกันหยุด generate ตามไปด้วย (ไม่ throw ทั้ง batch)
 *   ★ ทรัพย์สินที่ claim ไม่ติด (ยังไม่ถึงรอบจริง/ถูกคนอื่น claim ไปแล้ว) → skip เงียบ ๆ ไม่เขียน log
 */
export async function generateDueDepreciation(
  db: DB,
  tenantId: string,
  today: string,
  chartByCode: ChartByCode
): Promise<GenerateDueDepreciationSummary> {
  const { data } = await db
    .from("fixed_assets")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .is("deleted_at", null)
    .lte("next_dep_date", today)
    .limit(CANDIDATE_LIMIT);
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);

  const results: GenerateDepreciationResult[] = [];
  let generated = 0;
  let failed = 0;
  let skipped = 0;

  for (const assetId of ids) {
    try {
      const r = await generateOne(db, tenantId, assetId, today, chartByCode);
      results.push(r);
      if (r.status === "generated") generated++;
      else if (r.status === "failed") failed++;
      else skipped++;
    } catch {
      // ★ error ไม่คาดคิด (เช่น DB blip กลางคัน) — log แล้วไปทรัพย์สินถัดไปต่อ ไม่ throw ทั้ง batch
      try {
        await db.from("fixed_asset_depreciation_log").insert({
          tenant_id: tenantId,
          asset_id: assetId,
          period: today,
          status: "failed",
          message: "เกิดข้อผิดพลาดไม่ทราบสาเหตุขณะสร้างรายการ",
        });
      } catch {
        // เขียน log ไม่ได้ก็ยังต้อง continue ทรัพย์สินถัดไป
      }
      results.push({ status: "failed", assetId, message: "เกิดข้อผิดพลาดไม่ทราบสาเหตุ" });
      failed++;
    }
  }

  return { scanned: ids.length, generated, failed, skipped, results };
}

// ---------------------------------------------------------------------
// จำหน่ายทรัพย์สิน (T60, เฟส 7 ส่วน W, 0.7/0.8) — disposeAsset/undisposeAsset
// ---------------------------------------------------------------------

/** input ดิบจาก client สำหรับจำหน่ายทรัพย์สิน (0.7) */
export type DisposeAssetInput = {
  /** YYYY-MM-DD */
  disposalDate: unknown;
  /** ราคาที่ได้รับจริง (เงินสด/ธนาคาร/ลูกหนี้ — เลือกรหัสบัญชีเอง) */
  proceeds: unknown;
  cashAccountCode: unknown;
  gainLossAccountCode: unknown;
};

type ValidatedDisposeInput = {
  disposalDate: string;
  proceeds: number;
  cashAccountCode: string;
  gainLossAccountCode: string;
};

type DisposeValidationResult = { ok: true; value: ValidatedDisposeInput } | { ok: false; message: string };

/**
 * validate + sanitize input การจำหน่ายทรัพย์สินจาก client (0.7) — ปฏิเสธเสมอถ้า:
 *   - disposal_date ผิดรูปแบบ/ไม่มีวันที่นี้จริงในปฏิทิน (reuse isValidCalendarDate เหมือน acquisition_date)
 *   - proceeds ไม่ใช่ตัวเลข
 *   - ไม่ได้เลือกรหัสบัญชีที่รับเงิน/รหัสบัญชีกำไร-ขาดทุน (ความถูกต้องของหมวด/การมีอยู่จริงในผัง ให้
 *     upsertManualEntry ข้างล่าง validate ซ้ำผ่าน chartByCode อีกที — ไม่ duplicate logic ที่นี่)
 */
function validateDisposeAssetInput(input: DisposeAssetInput): DisposeValidationResult {
  const disposalDate =
    typeof input.disposalDate === "string" && DATE_RE.test(input.disposalDate) ? input.disposalDate : "";
  if (!disposalDate) return { ok: false, message: "ต้องระบุวันที่จำหน่ายให้ถูกรูปแบบ (YYYY-MM-DD)" };
  if (!isValidCalendarDate(disposalDate)) {
    return { ok: false, message: "วันที่จำหน่ายไม่ถูกต้อง (ไม่มีวันที่นี้จริงในปฏิทิน)" };
  }

  const proceeds = parseMoney(input.proceeds);
  if (proceeds === null) return { ok: false, message: "ราคาที่ได้รับต้องเป็นตัวเลข" };

  const cashAccountCode = clampText(input.cashAccountCode, ACCOUNT_CODE_MAX);
  if (!cashAccountCode) return { ok: false, message: "ต้องเลือกรหัสบัญชีที่รับเงิน" };

  const gainLossAccountCode = clampText(input.gainLossAccountCode, ACCOUNT_CODE_MAX);
  if (!gainLossAccountCode) {
    return { ok: false, message: "ต้องเลือกรหัสบัญชีกำไร/ขาดทุนจากการจำหน่ายทรัพย์สิน" };
  }

  return { ok: true, value: { disposalDate, proceeds, cashAccountCode, gainLossAccountCode } };
}

type RawDisposeAssetRow = {
  customer_id: string;
  name: string;
  status: string;
  cost: number | string;
  accumulated_depreciation: number | string;
  asset_account_code: string;
  accum_dep_account_code: string;
};

/**
 * จำหน่ายทรัพย์สิน 1 ชิ้น (0.7) — คำนวณ NBV+กำไร/ขาดทุน ณ วันจำหน่าย (ไม่ generate ค่าเสื่อมงวดปัจจุบัน
 *   เพิ่มก่อน — ใช้ accumulated_depreciation ปัจจุบันตรง ๆ) → สร้าง manual JE (draft เสมอ ตาม 0.3):
 *     Dr accum_dep_account_code = accumulated_depreciation (ล้างค่าเสื่อมสะสม — ข้ามบรรทัดถ้า =0)
 *     Dr/Cr cashAccountCode = proceeds (Dr ถ้า proceeds>0, Cr ถ้า proceeds<0 — ข้ามบรรทัดถ้า =0)
 *     Cr asset_account_code = cost (ตัดสินทรัพย์ที่ราคาทุน — เสมอ เพราะ cost>0 การันตีตั้งแต่สร้างทะเบียน)
 *     ปรับสมดุลด้วย gainLossAccountCode: กำไร (proceeds>NBV) → Cr, ขาดทุน (proceeds<NBV) → Dr,
 *     เท่ากันเป๊ะ (gainLoss=0) → ไม่เพิ่มบรรทัดนี้เลย (กัน debit=credit=0 ที่ validateManualEntryInput ปฏิเสธ)
 *   แล้ว update ทะเบียน status='disposed', disposal_date/proceeds/entry_id, next_dep_date=null
 */
export async function disposeAsset(
  db: DB,
  tenantId: string,
  customerId: string,
  assetId: string,
  input: DisposeAssetInput,
  chartByCode: ChartByCode
): Promise<FixedAssetActionResult> {
  const v = validateDisposeAssetInput(input);
  if (!v.ok) return v;

  const { data } = await db
    .from("fixed_assets")
    .select("customer_id, name, status, cost, accumulated_depreciation, asset_account_code, accum_dep_account_code")
    .eq("id", assetId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return { ok: false, message: "ไม่พบทรัพย์สิน (อาจถูกลบไปแล้ว)" };
  const row = data as RawDisposeAssetRow;

  if (row.customer_id !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับทรัพย์สินเดิม" };
  if (row.status !== "active") {
    return { ok: false, message: "ทรัพย์สินนี้ถูกจำหน่ายไปแล้ว — จำหน่ายซ้ำไม่ได้" };
  }

  const cost = num(row.cost);
  const accumulated = num(row.accumulated_depreciation);
  const nbv = netBookValue({ cost, accumulatedDepreciation: accumulated });
  const gainLoss = round2(v.value.proceeds - nbv);

  const lines: ManualEntryLineInput[] = [];
  if (accumulated > 0) {
    lines.push({ accountCode: row.accum_dep_account_code, accountName: null, description: null, debit: accumulated, credit: 0 });
  }
  if (v.value.proceeds > 0) {
    lines.push({ accountCode: v.value.cashAccountCode, accountName: null, description: null, debit: v.value.proceeds, credit: 0 });
  } else if (v.value.proceeds < 0) {
    lines.push({ accountCode: v.value.cashAccountCode, accountName: null, description: null, debit: 0, credit: -v.value.proceeds });
  }
  // ★ ขาสินทรัพย์ — เสมอ (cost > 0 ทุกทรัพย์สิน)
  lines.push({ accountCode: row.asset_account_code, accountName: null, description: null, debit: 0, credit: cost });
  if (gainLoss > 0) {
    // กำไรจากการจำหน่าย
    lines.push({ accountCode: v.value.gainLossAccountCode, accountName: null, description: null, debit: 0, credit: gainLoss });
  } else if (gainLoss < 0) {
    // ขาดทุนจากการจำหน่าย
    lines.push({ accountCode: v.value.gainLossAccountCode, accountName: null, description: null, debit: -gainLoss, credit: 0 });
  }
  // gainLoss === 0 → ไม่เพิ่มบรรทัดนี้เลย (0.7)

  const manualInput: ManualEntryInput = {
    docType: "JV",
    docDate: v.value.disposalDate,
    docNo: null,
    memo: `จำหน่ายทรัพย์สิน - ${row.name}`,
    lines,
  };

  const res = await upsertManualEntry(db, tenantId, customerId, manualInput, chartByCode);
  if (!res.ok) return { ok: false, message: res.message };

  // ★ 0.9: ผูก occurrence (JE จำหน่าย) → ทรัพย์สินต้นทาง (metadata ล้วน)
  await db
    .from("manual_journal_entries")
    .update({ fixed_asset_id: assetId })
    .eq("id", res.id)
    .eq("tenant_id", tenantId);

  const { error } = await db
    .from("fixed_assets")
    .update({
      status: "disposed",
      disposal_date: v.value.disposalDate,
      disposal_proceeds: v.value.proceeds,
      disposal_entry_id: res.id,
      next_dep_date: null,
    })
    .eq("id", assetId)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };

  return { ok: true, id: assetId };
}

/**
 * ยกเลิกการจำหน่ายทรัพย์สิน (0.8) — reset กลับเป็น 'active' ได้เฉพาะถ้า manual JE ที่สร้างไว้ตอนจำหน่าย
 *   ยัง 'draft' (ยังไม่ confirm) เท่านั้น — ถ้า confirmed แล้วต้องยกเลิกยืนยัน JE ก่อน (ข้อความชัดเจน)
 *   next_dep_date คืนเป็นเดือนถัดไปจาก "งวดค่าเสื่อมที่ generate สำเร็จล่าสุดจริง" (จาก
 *   fixed_asset_depreciation_log) — ไม่ใช่เดา, ถ้าตัดค่าเสื่อมครบแล้วก่อนจำหน่าย (remaining<=0) ยังคง null
 *   เหมือนก่อนจำหน่าย, ถ้ายังไม่เคย generate เลย (accumulated_depreciation=0) → กลับไปเป็น acquisition_date
 */
export async function undisposeAsset(
  db: DB,
  tenantId: string,
  assetId: string
): Promise<FixedAssetActionResult> {
  const { data } = await db
    .from("fixed_assets")
    .select("status, disposal_entry_id, acquisition_date, cost, salvage_value, accumulated_depreciation")
    .eq("id", assetId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return { ok: false, message: "ไม่พบทรัพย์สิน (อาจถูกลบไปแล้ว)" };
  const row = data as {
    status: string;
    disposal_entry_id: string | null;
    acquisition_date: string;
    cost: number | string;
    salvage_value: number | string;
    accumulated_depreciation: number | string;
  };

  if (row.status !== "disposed") {
    return { ok: false, message: "ทรัพย์สินนี้ยังไม่ถูกจำหน่าย — ยกเลิกการจำหน่ายไม่ได้" };
  }

  if (row.disposal_entry_id) {
    const entryScope = await getManualEntryScope(db, tenantId, row.disposal_entry_id);
    if (entryScope && entryScope.status === "confirmed") {
      return {
        ok: false,
        message: "รายการบัญชีจำหน่ายทรัพย์สินนี้ยืนยันแล้ว — ต้องยกเลิกการยืนยันรายการบัญชีก่อน แล้วค่อยยกเลิกการจำหน่าย",
      };
    }
    if (entryScope) {
      // ★ ต้องเช็คผลลัพธ์ก่อน short-circuit ถ้าลบไม่สำเร็จ (เช่น DB error ชั่วคราว) — ไม่งั้น draft JE
      //   ของการจำหน่ายจะยังค้างอยู่ (fixed_asset_id ยังผูกอยู่) ทั้งที่ทรัพย์สินถูก reset เป็น active ไปแล้ว
      const delRes = await softDeleteManualEntry(db, tenantId, row.disposal_entry_id);
      if (!delRes.ok) {
        return { ok: false, message: "ลบรายการบัญชีจำหน่ายทรัพย์สินเดิมไม่สำเร็จ กรุณาลองใหม่ (ยังไม่ยกเลิกการจำหน่าย)" };
      }
    }
  }

  const cost = num(row.cost);
  const salvage = num(row.salvage_value);
  const accumulated = num(row.accumulated_depreciation);
  const remaining = round2(cost - salvage - accumulated);

  let nextDepDate: string | null = null;
  if (remaining > 0) {
    const logs = await listDepreciationLog(db, tenantId, assetId);
    const lastGenerated = logs.find((l) => l.status === "generated");
    nextDepDate = lastGenerated ? addMonthsClamped(lastGenerated.period, 1) : row.acquisition_date;
  }

  const { error } = await db
    .from("fixed_assets")
    .update({
      status: "active",
      disposal_date: null,
      disposal_proceeds: null,
      disposal_entry_id: null,
      next_dep_date: nextDepDate,
    })
    .eq("id", assetId)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "ยกเลิกการจำหน่ายไม่สำเร็จ กรุณาลองใหม่" };

  return { ok: true, id: assetId };
}
