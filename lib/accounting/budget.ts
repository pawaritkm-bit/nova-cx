/**
 * งบประมาณ (Budget) — ตั้งงบต่อรหัสบัญชี/เดือน/ปี + เทียบกับยอดเคลื่อนไหวจริงจากงบทดลอง
 *
 * บริบท: เฟส 6 ส่วน S (docs/06-accounting-features-roadmap.md, หมวด 0.9–0.12) — read-only เทียบยอด
 *   ล้วน (ไม่มี write path ที่กระทบบัญชีจริงแม้แต่จุดเดียว) ต่อยอด trial-balance.ts/report-filter.ts เดิม
 *
 * ★ 0.9 ตั้งงบเป็นตัวเลขเดียวต่อ "รหัสบัญชี + ปี + เดือน" ของลูกค้า 1 ราย — เดือน/บัญชีที่ไม่ได้ตั้งงบ = 0
 *   (ไม่บังคับกรอกครบทุกเดือน/ทุกบัญชี)
 * ★ 0.10 ยอดจริง = อ่านจาก TrialBalanceRow.debit/credit ตรง ๆ (เคลื่อนไหวงวดที่ pipeline เดิมคำนวณแล้ว)
 *   ไม่มีสูตรคำนวณยอดเคลื่อนไหวคู่ขนานใหม่แม้แต่บรรทัดเดียวในไฟล์นี้
 * ★ 0.11 ทิศทางเทียบงบตามหมวดบัญชี (natural balance) เป็นค่าเริ่มต้นเสมอ ไม่ให้ผู้ใช้เลือกฝั่งเอง:
 *   - หมวด 4 (รายได้)      → เทียบเครดิตเคลื่อนไหว
 *   - หมวด 5 (ค่าใช้จ่าย)   → เทียบเดบิตเคลื่อนไหว
 *   - หมวดอื่น (1/2/3/6)    → เทียบยอดเคลื่อนไหวสุทธิ (debit − credit)
 * ★ 0.12 กรอกงบเป็นกริด 12 เดือนต่อ 1 ปี บันทึกทีเดียวทั้งชุด (upsert แบบ batch ไม่ใช่ทีละเดือน)
 * ★ ทุก query/write กรอง tenant_id (จาก session) + customer_id (assertCustomerInScope ที่ actions.ts ชั้นบน)
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildChartByCode,
  categoryDigitOf,
  CATEGORY_BY_DIGIT,
  type ChartAccount,
} from "@/lib/accounting/chart-of-accounts";
import type { TrialBalanceRow } from "@/lib/accounting/trial-balance";
import { type ReportPeriod, validMonth } from "@/lib/accounting/report-filter";
import { round2 } from "@/lib/accounting/queries";
import { EPSILON } from "@/lib/accounting/statement-config";

type DB = SupabaseClient;

// ---------------------------------------------------------------------
// ชนิดข้อมูล
// ---------------------------------------------------------------------

/** เพดานความยาวรหัสบัญชี (มิเรอร์ manual-journal.ts::ACCOUNT_CODE_MAX) */
export const ACCOUNT_CODE_MAX = 20;

export const YEAR_MIN = 2000;
export const YEAR_MAX = 2100;

/** งบประมาณ 1 บัญชี 1 เดือน (แถวจริงจาก DB) */
export type AccountBudget = {
  id: string;
  tenantId: string;
  customerId: string;
  accountCode: string;
  year: number;
  month: number;
  amount: number;
};

// ---------------------------------------------------------------------
// validate (pure) — T45
// ---------------------------------------------------------------------

export type ValidatedBudgetRow = { year: number; month: number; amount: number };
export type BudgetRowValidationResult =
  | { ok: true; value: ValidatedBudgetRow }
  | { ok: false; message: string };

/**
 * validate ปี/เดือน/จำนวนเงินของ 1 แถวงบ — ปฏิเสธเสมอถ้า:
 *   - ปีนอกช่วง 2000–2100 (ตรงกับ check constraint ของ migration 0074)
 *   - เดือนนอกช่วง 1–12
 *   - จำนวนเงินไม่ใช่ตัวเลข หรือติดลบ (งบประมาณต้องไม่ติดลบ)
 */
export function validateBudgetRowInput(input: {
  year: unknown;
  month: unknown;
  amount: unknown;
}): BudgetRowValidationResult {
  const year = typeof input.year === "number" ? input.year : Number(input.year);
  if (!Number.isInteger(year) || year < YEAR_MIN || year > YEAR_MAX) {
    return { ok: false, message: `ปีต้องเป็นจำนวนเต็มระหว่าง ${YEAR_MIN}-${YEAR_MAX}` };
  }
  const month = typeof input.month === "number" ? input.month : Number(input.month);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { ok: false, message: "เดือนต้องอยู่ระหว่าง 1-12" };
  }
  const amount = typeof input.amount === "number" ? input.amount : Number(input.amount);
  if (!Number.isFinite(amount)) return { ok: false, message: "จำนวนเงินงบประมาณไม่ถูกต้อง" };
  if (amount < 0) return { ok: false, message: "จำนวนเงินงบประมาณต้องไม่ติดลบ" };
  return { ok: true, value: { year, month, amount: round2(amount) } };
}

function clampCode(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, ACCOUNT_CODE_MAX);
}

// ---------------------------------------------------------------------
// data layer (DB) — CRUD (T45)
// ---------------------------------------------------------------------

const LIST_LIMIT = 5000;

type RawBudgetRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  account_code: string;
  year: number;
  month: number;
  amount: number | string;
};

function asAmount(v: number | string): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? round2(n) : 0;
}

/** ดึงงบประมาณทั้งปีของลูกค้า 1 ราย (ทุกบัญชีที่เคยตั้งไว้) — คืน [] ถ้าไม่มี/ผิดพลาด */
export async function listBudgetYear(
  db: DB,
  tenantId: string,
  customerId: string,
  year: number
): Promise<AccountBudget[]> {
  const { data, error } = await db
    .from("account_budgets")
    .select("id, tenant_id, customer_id, account_code, year, month, amount")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("year", year)
    .order("account_code", { ascending: true })
    .order("month", { ascending: true })
    .limit(LIST_LIMIT);
  if (error || !data) return [];
  return (data as RawBudgetRow[]).map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    accountCode: r.account_code,
    year: r.year,
    month: r.month,
    amount: asAmount(r.amount),
  }));
}

/** input ดิบ 1 แถวจาก client (ก่อน validate) */
export type BudgetRowInput = {
  accountCode: unknown;
  month: unknown;
  amount: unknown;
};

export type BudgetSaveResult = { ok: true; count: number } | { ok: false; message: string };

/**
 * บันทึกงบทั้งปีของลูกค้า 1 ราย "ทีเดียวทั้งชุด" (0.12) — validate ทุกแถวก่อนเขียนจริง (all-or-nothing)
 *   - dedupe (accountCode+month) แถวหลังทับแถวก่อนถ้าซ้ำกันในชุดเดียวกัน
 *   - เขียนแบบ "ลบของเดิมเฉพาะรหัสบัญชีที่อยู่ในชุดนี้ของปีนี้ แล้ว insert ใหม่ทั้งหมด" (ทับของเดิมถ้ามี
 *     ไม่ insert ซ้ำ ไม่ชน unique index tenant+customer+account_code+year+month) — รหัสบัญชีอื่นที่ไม่ได้อยู่
 *     ในชุดนี้ (ไม่ได้แก้รอบนี้) ไม่ถูกแตะต้อง
 */
export async function upsertBudgetYear(
  db: DB,
  tenantId: string,
  customerId: string,
  year: number,
  rows: BudgetRowInput[]
): Promise<BudgetSaveResult> {
  if (!Array.isArray(rows)) return { ok: false, message: "ข้อมูลงบประมาณไม่ถูกต้อง" };
  if (rows.length > 5000) return { ok: false, message: "รายการมากเกินไป (สูงสุด 5000 แถวต่อครั้ง)" };

  const byKey = new Map<string, { accountCode: string; month: number; amount: number }>();
  for (const r of rows) {
    const accountCode = clampCode(r.accountCode);
    if (!accountCode) return { ok: false, message: "ต้องระบุรหัสบัญชีทุกแถว" };
    const v = validateBudgetRowInput({ year, month: r.month, amount: r.amount });
    if (!v.ok) return { ok: false, message: v.message };
    // ★ ไม่บันทึกงบ=0 ลง DB (0.9 — เดือน/บัญชีที่ไม่ได้ตั้งงบถือว่า 0 อยู่แล้ว ไม่ต้องมีแถวจริง)
    if (v.value.amount <= 0) continue;
    byKey.set(`${accountCode}:${v.value.month}`, { accountCode, month: v.value.month, amount: v.value.amount });
  }
  const finalRows = [...byKey.values()];

  const touchedCodes = [...new Set(rows.map((r) => clampCode(r.accountCode)).filter(Boolean))];
  if (touchedCodes.length === 0) return { ok: true, count: 0 };

  // ลบของเดิมทั้งหมด (ทุกเดือน) เฉพาะรหัสบัญชีที่อยู่ในชุดนี้ของปีนี้ — กันแถวเก่าที่ผู้ใช้ลบค่ากลับเป็น 0
  // (ไม่ส่งมาใน finalRows อีกแล้ว) ค้างอยู่ใน DB
  const { error: delErr } = await db
    .from("account_budgets")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("year", year)
    .in("account_code", touchedCodes);
  if (delErr) return { ok: false, message: "บันทึกงบประมาณไม่สำเร็จ กรุณาลองใหม่" };

  if (finalRows.length === 0) return { ok: true, count: 0 };

  const { error: insErr } = await db.from("account_budgets").insert(
    finalRows.map((r) => ({
      tenant_id: tenantId,
      customer_id: customerId,
      account_code: r.accountCode,
      year,
      month: r.month,
      amount: r.amount,
    }))
  );
  if (insErr) return { ok: false, message: "บันทึกงบประมาณไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, count: finalRows.length };
}

// ---------------------------------------------------------------------
// เทียบงบ vs จริง (pure) — T45 ★ จุดสำคัญที่สุดของ S
// ---------------------------------------------------------------------

export type BudgetComparisonRow = {
  accountCode: string;
  accountName: string;
  /** ชื่อหมวด (CATEGORY_BY_DIGIT) */
  category: string;
  /** เลขหลักแรกของรหัส (1-6) — ใช้กำหนดทิศทางเทียบ (0.11) */
  digit: string;
  budget: number;
  actual: number;
  /** จริง − งบ (บวก = จริงมากกว่างบ) */
  diff: number;
  /** (diff/budget)*100 — null = "N/A" (งบ=0 กันหารด้วยศูนย์) */
  diffPercent: number | null;
};

function monthKeyOf(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/**
 * เทียบงบประมาณ vs ยอดจริง (0.10/0.11) — pure ล้วน ไม่แตะ DB
 *   - budgetRows: งบทั้งหมดที่มี (เช่น ทั้งปีจาก listBudgetYear) — ฟังก์ชันนี้ sum เฉพาะเดือนที่อยู่ใน
 *     ช่วง `period` (from/to แบบ YYYY-MM เดียวกับ ReportPeriod — ใช้เดือนเดียวหรือช่วงหลายเดือน/ทั้งปีได้)
 *   - trialBalanceRows: ต้องเป็นผลลัพธ์จาก buildTrialBalance ของ pipeline เดิม (listEntries →
 *     filterEntriesForReport → loadCombinedJournalLines → buildLedger → buildTrialBalance) ที่กรองงวด
 *     ตรงกับ `period` เดียวกันเป๊ะ — ไม่คำนวณยอดเคลื่อนไหวใหม่ที่นี่แม้แต่บรรทัดเดียว (0.10)
 *   - chart: ผังบัญชีของ tenant (ใช้เติมชื่อบัญชีที่ตั้งงบไว้แต่ยังไม่มีความเคลื่อนไหวเดือนนั้น เช่น
 *     ตั้งงบไว้ล่วงหน้าแต่ยังไม่มีบิลจริง → ไม่โผล่ใน TrialBalanceRow ที่ตัดบัญชีศูนย์ล้วนออก)
 *   - งบ=0 (ไม่เคยตั้ง) → diffPercent เป็น null (แสดง "N/A" ฝั่ง UI) กันหารด้วยศูนย์
 */
export function buildBudgetComparison(
  budgetRows: AccountBudget[],
  trialBalanceRows: TrialBalanceRow[],
  chart: ChartAccount[],
  period: Pick<ReportPeriod, "from" | "to">
): BudgetComparisonRow[] {
  const from = validMonth(period.from);
  const to = validMonth(period.to);

  const budgetSumByCode = new Map<string, number>();
  for (const r of budgetRows) {
    const key = monthKeyOf(r.year, r.month);
    if (from && key < from) continue;
    if (to && key > to) continue;
    budgetSumByCode.set(r.accountCode, round2((budgetSumByCode.get(r.accountCode) ?? 0) + r.amount));
  }

  const chartByCode = buildChartByCode(chart);
  const tbByCode = new Map(trialBalanceRows.map((r) => [r.code, r]));
  const codes = new Set<string>([...tbByCode.keys(), ...budgetSumByCode.keys()]);

  const rows: BudgetComparisonRow[] = [];
  for (const code of codes) {
    const digit = categoryDigitOf(code);
    const category = CATEGORY_BY_DIGIT[digit] ?? "อื่น ๆ";
    const tb = tbByCode.get(code);
    const accountName = tb?.name || chartByCode[code]?.name || code;
    const budget = round2(budgetSumByCode.get(code) ?? 0);

    // ★ 0.11 ทิศทางตามหมวดบัญชี — ตรึงตัว ไม่ให้ผู้ใช้เลือกฝั่งเอง
    let actual: number;
    if (digit === "4") {
      actual = round2(tb?.credit ?? 0); // รายได้ → เครดิตเคลื่อนไหว
    } else if (digit === "5") {
      actual = round2(tb?.debit ?? 0); // ค่าใช้จ่าย → เดบิตเคลื่อนไหว
    } else {
      actual = round2((tb?.debit ?? 0) - (tb?.credit ?? 0)); // อื่น ๆ → ยอดเคลื่อนไหวสุทธิ
    }

    const diff = round2(actual - budget);
    const diffPercent = Math.abs(budget) < EPSILON ? null : round2((diff / budget) * 100);

    rows.push({ accountCode: code, accountName, category, digit, budget, actual, diff, diffPercent });
  }

  rows.sort((a, b) =>
    a.digit === b.digit ? a.accountCode.localeCompare(b.accountCode) : a.digit.localeCompare(b.digit)
  );
  return rows;
}
