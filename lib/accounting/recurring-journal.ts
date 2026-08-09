/**
 * รายการบันทึกซ้ำ (Recurring Journal Entry) — เทมเพลต + ตัวสร้าง occurrence + data layer (DB)
 *
 * บริบท: เฟส 6 ส่วน R (docs/06-accounting-features-roadmap.md, หมวด 0.2–0.8) — ตั้ง manual JE
 *   (JV/PV/RV) ให้สร้างซ้ำอัตโนมัติทุกเดือน/ไตรมาส/ปี (เช่น ค่าเช่า, ค่าบริการรายเดือน)
 *   ต่อยอด lib/accounting/manual-journal.ts เดิม 100% — ไฟล์นี้ไม่แก้ manual-journal.ts เลยแม้แต่บรรทัดเดียว
 *   (เรียก isBalanced/upsertManualEntry ตรง ๆ)
 *
 * ★ 0.3 ห้าม auto-confirm เด็ดขาด — occurrence ที่สร้างผ่าน upsertManualEntry เป็น status='draft' เสมอ
 *   (upsertManualEntry เดิม insert ใหม่เป็น draft เสมออยู่แล้ว — ไฟล์นี้ไม่เรียก confirmManualEntry เลย)
 * ★ 0.5 กับดัก date arithmetic ของ Postgres: `nextRunDateAfter`/`addMonthsClamped` (pure TS) ต้องให้ผลลัพธ์
 *   ตรงกับ SQL `public.add_months_clamped()` (migration 0073) เป๊ะทุก edge case — ใช้เป็น preview UI
 *   เท่านั้น (ไม่ใช่แหล่งความจริง — RPC `claim_recurring_je_occurrence` ที่ฝั่ง DB คือแหล่งความจริงจริง
 *   ตอน advance next_run_date)
 * ★ 0.4 การสร้าง occurrence (ทั้ง cron รายวันและปุ่ม "สร้างตอนนี้") ต้องผ่าน RPC
 *   `claim_recurring_je_occurrence` (atomic, for update skip locked) เท่านั้น — กัน cron/ปุ่มมือชนกัน
 *   สร้างซ้ำ ถ้า claim ไม่ติด (ยังไม่ถึงรอบ/ไม่ active/ถูกลบ/มีคนอื่นทำอยู่) คืน skipped เฉย ๆ ไม่ throw
 * ★ 0.6 ยอดต่อรอบคงที่เสมอ (เก็บใน recurring_journal_template_lines) — ไม่มีสูตร/ตัวแปรผันแปร
 * ★ 0.7 recurring_template_id บน manual_journal_entries เป็น metadata ล้วน (ใช้แค่แสดง badge/ลิงก์กลับ)
 * ★ 0.8 บัญชี/รหัสในเทมเพลตถูกลบ/ปิดใช้งานก่อนถึงรอบ generate → upsertManualEntry ปฏิเสธตามปกติ (ไม่อยู่ใน
 *   ผัง) → ไม่ throw ทั้ง batch แต่บันทึกลง recurring_journal_generation_log (status='failed') ให้เห็นชัดเจน
 *   เทมเพลตอื่นของ tenant/ลูกค้าอื่นต้อง generate ต่อได้เสมอ (ครอบ try/catch ต่อเทมเพลต)
 * ★ ทุก query/write กรอง tenant_id (จาก session) + customer_id (assertCustomerInScope ทำที่ actions.ts ชั้นบน)
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { round2 } from "@/lib/accounting/queries";
import { EPSILON } from "@/lib/accounting/statement-config";
import { isValidCalendarDate } from "@/lib/accounting/bank-reconciliation";
import {
  isBalanced,
  upsertManualEntry,
  MIN_LINES,
  MAX_LINES,
  ACCOUNT_CODE_MAX,
  ACCOUNT_NAME_MAX,
  DESCRIPTION_MAX,
  MEMO_MAX,
  type ManualDocType,
  type ManualEntryInput,
  type ManualJournalLine,
  type ManualEntryStatus,
} from "@/lib/accounting/manual-journal";

type DB = SupabaseClient;

export type Frequency = "monthly" | "quarterly" | "yearly";

/** ป้ายความถี่ (ไทย) — ใช้ในตัวเลือก/แสดงผล */
export const FREQUENCY_LABELS: Record<Frequency, string> = {
  monthly: "ทุกเดือน",
  quarterly: "ทุกไตรมาส",
  yearly: "ทุกปี",
};

/** จำนวนเดือนต่อรอบของแต่ละความถี่ (0.2) — ใช้ทั้ง nextRunDateAfter (TS) และ RPC (SQL, migration 0073) */
const MONTHS_BY_FREQUENCY: Record<Frequency, number> = { monthly: 1, quarterly: 3, yearly: 12 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------
// ชนิดข้อมูล
// ---------------------------------------------------------------------

/** 1 บรรทัดของเทมเพลต (id มีเมื่อโหลดจาก DB แล้ว — ไม่มีตอนสร้างใหม่) — ยอดคงที่ทุกรอบ (0.6) */
export type RecurringTemplateLine = {
  id?: string;
  lineNo: number;
  accountCode: string;
  accountName: string | null;
  description: string | null;
  debit: number;
  credit: number;
};

/** หัว + บรรทัด เทมเพลตรายการบันทึกซ้ำ 1 ใบ */
export type RecurringTemplate = {
  id: string;
  tenantId: string;
  customerId: string;
  docType: ManualDocType;
  memo: string | null;
  frequency: Frequency;
  /** YYYY-MM-DD — วันที่เริ่มต้นของรอบแรก */
  startDate: string;
  /** YYYY-MM-DD — วันที่ที่จะสร้าง occurrence ถัดไป (advance โดย RPC claim เท่านั้น) */
  nextRunDate: string;
  /** YYYY-MM-DD — null = ไม่มีวันสิ้นสุด (สร้างซ้ำต่อไปเรื่อย ๆ) */
  endDate: string | null;
  isActive: boolean;
  lastGeneratedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: RecurringTemplateLine[];
};

/** input ดิบ 1 บรรทัด จาก client (ชนิดเดียวกับ manual-journal.ts::ManualEntryLineInput) */
export type RecurringTemplateLineInput = {
  accountCode: unknown;
  accountName?: unknown;
  description?: unknown;
  debit: unknown;
  credit: unknown;
};

/** input ดิบทั้งเทมเพลต จาก client */
export type RecurringTemplateInput = {
  docType: unknown;
  memo?: unknown;
  frequency: unknown;
  /** YYYY-MM-DD */
  startDate: unknown;
  /** YYYY-MM-DD — ไม่ระบุ/null/ว่าง = ไม่มีวันสิ้นสุด */
  endDate?: unknown;
  lines: RecurringTemplateLineInput[];
};

export type ValidatedRecurringTemplate = {
  docType: ManualDocType;
  memo: string | null;
  frequency: Frequency;
  startDate: string;
  endDate: string | null;
  lines: ManualJournalLine[];
};

export type TemplateValidationResult =
  | { ok: true; value: ValidatedRecurringTemplate }
  | { ok: false; message: string };

// ---------------------------------------------------------------------
// helper เล็ก ๆ (private — มิเรอร์ manual-journal.ts แต่ไม่ export ซ้ำ ยกเว้น isBalanced ที่ reuse ตรง ๆ)
// ---------------------------------------------------------------------

function nonZero(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) >= EPSILON;
}

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function asDocType(v: unknown): ManualDocType | null {
  return v === "JV" || v === "PV" || v === "RV" ? v : null;
}

function asFrequency(v: unknown): Frequency | null {
  return v === "monthly" || v === "quarterly" || v === "yearly" ? v : null;
}

/** ยอดเงิน → number (>=0 ปัด 2 ตำแหน่ง) — ค่าติดลบ/ไม่ใช่ตัวเลข = 0 (ห้ามยอดติดลบต่อบรรทัด) */
function asAmount(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}

// ---------------------------------------------------------------------
// validate (pure) — server ต้อง re-validate เสมอ ไม่เชื่อ client (T39)
// ---------------------------------------------------------------------

/**
 * validate + sanitize input เทมเพลตจาก client — ปฏิเสธเสมอถ้า:
 *   - doc_type ผิดรูป / frequency ไม่รู้จัก (ไม่ใช่ monthly/quarterly/yearly — 0.2) / start_date ผิดรูป
 *   - end_date ผิดรูป หรืออยู่ก่อน start_date
 *   - จำนวนบรรทัด < MIN_LINES หรือ > MAX_LINES (มิเรอร์กติกาเดียวกับ manual-journal.ts)
 *   - บรรทัดใดไม่ระบุรหัสบัญชี / รหัสไม่อยู่ในผังที่ส่งเข้ามา (chartByCode)
 *   - บรรทัดใดมีทั้งเดบิตและเครดิต หรือไม่มีทั้งสองฝั่ง
 *   - เดบิตรวม ≠ เครดิตรวมทั้งใบ (ไม่สมดุล) — ★ reuse isBalanced จาก manual-journal.ts ตรง ๆ ไม่เขียนใหม่
 */
export function validateTemplateInput(
  input: RecurringTemplateInput,
  chartByCode: ChartByCode
): TemplateValidationResult {
  const docType = asDocType(input.docType);
  if (!docType) return { ok: false, message: "ต้องระบุประเภทเอกสาร (JV/PV/RV)" };

  const frequency = asFrequency(input.frequency);
  if (!frequency) return { ok: false, message: "ต้องระบุความถี่ (ทุกเดือน/ทุกไตรมาส/ทุกปี)" };

  const startDate =
    typeof input.startDate === "string" && DATE_RE.test(input.startDate) ? input.startDate : "";
  if (!startDate) return { ok: false, message: "ต้องระบุวันที่เริ่มต้นให้ถูกรูปแบบ (YYYY-MM-DD)" };
  // ★ กัน bug จริง: regex ผ่านแต่ไม่มีวันที่นี้จริงในปฏิทิน (เช่น 2026-02-30) — reuse isValidCalendarDate
  //   ของ bank-reconciliation.ts ตรง ๆ (ไม่ duplicate) กันหลุดไปถึง DB insert ที่ Postgres จะ reject
  if (!isValidCalendarDate(startDate)) {
    return { ok: false, message: "วันที่เริ่มต้นไม่ถูกต้อง (ไม่มีวันที่นี้จริงในปฏิทิน)" };
  }

  let endDate: string | null = null;
  if (input.endDate !== undefined && input.endDate !== null && input.endDate !== "") {
    if (typeof input.endDate !== "string" || !DATE_RE.test(input.endDate)) {
      return { ok: false, message: "วันที่สิ้นสุดไม่ถูกรูปแบบ (YYYY-MM-DD)" };
    }
    if (!isValidCalendarDate(input.endDate)) {
      return { ok: false, message: "วันที่สิ้นสุดไม่ถูกต้อง (ไม่มีวันที่นี้จริงในปฏิทิน)" };
    }
    if (input.endDate < startDate) {
      return { ok: false, message: "วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น" };
    }
    endDate = input.endDate;
  }

  const memo = clampText(input.memo, MEMO_MAX);

  if (!Array.isArray(input.lines) || input.lines.length < MIN_LINES) {
    return { ok: false, message: `ต้องมีอย่างน้อย ${MIN_LINES} บรรทัด (เดบิตและเครดิต)` };
  }
  if (input.lines.length > MAX_LINES) {
    return { ok: false, message: `บรรทัดมากเกินไป (สูงสุด ${MAX_LINES} บรรทัด)` };
  }

  const lines: ManualJournalLine[] = [];
  for (let i = 0; i < input.lines.length; i++) {
    const raw = input.lines[i];
    const accountCode = clampText(raw.accountCode, ACCOUNT_CODE_MAX);
    if (!accountCode) return { ok: false, message: `บรรทัดที่ ${i + 1}: ต้องเลือกรหัสบัญชี` };
    const chartAcc = chartByCode[accountCode];
    if (!chartAcc) {
      return { ok: false, message: `บรรทัดที่ ${i + 1}: รหัสบัญชี "${accountCode}" ไม่อยู่ในผังบัญชี` };
    }

    const debit = asAmount(raw.debit);
    const credit = asAmount(raw.credit);
    if (nonZero(debit) && nonZero(credit)) {
      return { ok: false, message: `บรรทัดที่ ${i + 1}: ระบุได้แค่ฝั่งเดบิตหรือเครดิต ไม่ใช่ทั้งสองฝั่ง` };
    }
    if (!nonZero(debit) && !nonZero(credit)) {
      return { ok: false, message: `บรรทัดที่ ${i + 1}: ต้องระบุยอดเดบิตหรือเครดิต` };
    }

    const accountName = clampText(raw.accountName, ACCOUNT_NAME_MAX) ?? chartAcc.name;
    const description = clampText(raw.description, DESCRIPTION_MAX);
    lines.push({ lineNo: i + 1, accountCode, accountName, description, debit, credit });
  }

  if (!isBalanced(lines)) {
    return { ok: false, message: "เดบิตรวมต้องเท่ากับเครดิตรวม — ไม่สมดุล บันทึกไม่ได้" };
  }

  return { ok: true, value: { docType, memo, frequency, startDate, endDate, lines } };
}

// ---------------------------------------------------------------------
// date arithmetic (pure) — 0.5 ★ ต้องตรงกับ SQL public.add_months_clamped() เป๊ะทุก edge case
// ---------------------------------------------------------------------

/** จำนวนวันของเดือน (1-12) ในปีนั้น — คำนวณด้วย UTC เสมอ (กัน timezone ของเครื่อง server เพี้ยน) */
function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/**
 * บวก n เดือนแบบ "clamp วันสิ้นเดือน" (มิเรอร์ SQL public.add_months_clamped() ใน migration 0073 เป๊ะ) —
 *   เอาปี/เดือนของ d บวก n เดือน แล้ว clamp วันที่ให้ไม่เกินวันสุดท้ายของเดือนปลายทาง
 *   (ต่างจาก JS `Date` บวกวันตรง ๆ ที่ overflow ข้ามเดือนเหมือนปัญหาเดียวกับ Postgres `date + interval`)
 * ★ ใช้แสดง preview UI เท่านั้น — ไม่ใช่แหล่งความจริง (RPC claim_recurring_je_occurrence ที่ฝั่ง DB
 *   เป็นแหล่งความจริงจริงตอน advance next_run_date — ดู 0.5)
 */
export function addMonthsClamped(dateIso: string, months: number): string {
  const m = DATE_RE.exec(dateIso);
  if (!m) return dateIso;
  const y = Number(dateIso.slice(0, 4));
  const mo = Number(dateIso.slice(5, 7));
  const d = Number(dateIso.slice(8, 10));

  const totalMonths = y * 12 + (mo - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth1 = (((totalMonths % 12) + 12) % 12) + 1; // 1..12 (กัน modulo ติดลบเผื่อ months ติดลบในอนาคต)
  const lastDay = daysInMonth(targetYear, targetMonth1);
  const targetDay = Math.min(d, lastDay);

  const yStr = String(targetYear).padStart(4, "0");
  const moStr = String(targetMonth1).padStart(2, "0");
  const dStr = String(targetDay).padStart(2, "0");
  return `${yStr}-${moStr}-${dStr}`;
}

/**
 * วันที่รอบถัดไปหลัง date ตามความถี่ (0.5) — ใช้แสดง "รอบถัดไปจะสร้างวันที่..." ใน UI preview เท่านั้น
 *   ★ ไม่ใช่แหล่งความจริง — ตอน generate จริง RPC ฝั่ง DB เป็นคนคำนวณ/advance next_run_date เอง
 */
export function nextRunDateAfter(dateIso: string, frequency: Frequency): string {
  return addMonthsClamped(dateIso, MONTHS_BY_FREQUENCY[frequency]);
}

/**
 * วันนี้ (เวลาไทย) → "YYYY-MM-DD" (mirror `todayThai()` ของ app/chat-audit/accounting/payments/page.tsx)
 *   ★ ใช้เป็น "แหล่งความจริง" ของ `today` ฝั่ง server เท่านั้น — cron (T41) และปุ่ม "สร้างตอนนี้" (T42)
 *   ต้องเรียกฟังก์ชันนี้เสมอ ห้ามรับค่า `today` จาก client input เด็ดขาด (กันแก้วันที่เครื่อง/ปลอมวันที่
 *   แล้วสร้างย้อนหลัง/ล่วงหน้าผิดปกติ)
 */
export function todayIsoThai(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------
// pure mapper — เทมเพลต + วันที่รอบ → ManualEntryInput (เข้า upsertManualEntry เดิมตรง ๆ)
// ---------------------------------------------------------------------

/**
 * แปลงเทมเพลต + วันที่รอบ (runDate จาก RPC claim) → ManualEntryInput ที่ป้อนเข้า
 *   upsertManualEntry ของ manual-journal.ts ได้ตรง ๆ (docNo ปล่อยว่าง — ให้นักบัญชีกรอกเองถ้าต้องการ)
 */
export function buildOccurrenceInput(
  template: Pick<RecurringTemplate, "docType" | "memo" | "lines">,
  runDate: string
): ManualEntryInput {
  return {
    docType: template.docType,
    docDate: runDate,
    docNo: null,
    memo: template.memo,
    lines: template.lines.map((l) => ({
      accountCode: l.accountCode,
      accountName: l.accountName,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
    })),
  };
}

// ---------------------------------------------------------------------
// data layer (DB) — CRUD เทมเพลต (T39)
// ---------------------------------------------------------------------

const LIST_LIMIT = 500;
const LOG_LIMIT = 200;
const CANDIDATE_LIMIT = 2000;

type RawTemplateHead = {
  id: string;
  tenant_id: string;
  customer_id: string;
  doc_type: string;
  memo: string | null;
  frequency: string;
  start_date: string;
  next_run_date: string;
  end_date: string | null;
  is_active: boolean;
  last_generated_at: string | null;
  created_at: string;
  updated_at: string;
};

type RawTemplateLine = {
  id: string;
  template_id: string;
  line_no: number;
  account_code: string;
  account_name: string | null;
  description: string | null;
  debit: number | string;
  credit: number | string;
};

/** ดึงเทมเพลตทั้งหมด (active+inactive) ของลูกค้า 1 ราย เรียงสร้างล่าสุดก่อน */
export async function listTemplates(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<RecurringTemplate[]> {
  const { data: heads, error } = await db
    .from("recurring_journal_templates")
    .select(
      "id, tenant_id, customer_id, doc_type, memo, frequency, start_date, next_run_date, end_date, is_active, last_generated_at, created_at, updated_at"
    )
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error || !heads) return [];
  const rows = heads as unknown as RawTemplateHead[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { data: lineData } = await db
    .from("recurring_journal_template_lines")
    .select("id, template_id, line_no, account_code, account_name, description, debit, credit")
    .eq("tenant_id", tenantId)
    .in("template_id", ids)
    .order("line_no", { ascending: true });

  const linesByTemplate = new Map<string, RecurringTemplateLine[]>();
  for (const r of (lineData ?? []) as unknown as RawTemplateLine[]) {
    const arr = linesByTemplate.get(r.template_id) ?? [];
    arr.push({
      id: r.id,
      lineNo: r.line_no,
      accountCode: r.account_code,
      accountName: r.account_name,
      description: r.description,
      debit: asAmount(r.debit),
      credit: asAmount(r.credit),
    });
    linesByTemplate.set(r.template_id, arr);
  }

  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    docType: (r.doc_type as ManualDocType) ?? "JV",
    memo: r.memo,
    frequency: (r.frequency as Frequency) ?? "monthly",
    startDate: r.start_date,
    nextRunDate: r.next_run_date,
    endDate: r.end_date,
    isActive: r.is_active,
    lastGeneratedAt: r.last_generated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lines: linesByTemplate.get(r.id) ?? [],
  }));
}

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline (มิเรอร์ ManualActionResult ของ manual-journal.ts) */
export type RecurringActionResult = { ok: true; id: string } | { ok: false; message: string };

/** โหลด customer_id + สถานะการ generate ของเทมเพลต 1 ใบ (scope tenant) — ใช้ตรวจสโคปลูกค้าก่อนแก้/ลบ */
export async function getTemplateScope(
  db: DB,
  tenantId: string,
  id: string
): Promise<{ customerId: string; lastGeneratedAt: string | null } | null> {
  const { data } = await db
    .from("recurring_journal_templates")
    .select("customer_id, last_generated_at")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as { customer_id: string; last_generated_at: string | null };
  return { customerId: r.customer_id, lastGeneratedAt: r.last_generated_at };
}

/**
 * สร้าง/แก้เทมเพลตทั้งใบ (header + แทนที่ lines ทั้งหมด) — validate ซ้ำฝั่ง server เสมอ
 *   - id ระบุ = update เทมเพลตเดิม
 *   - id ไม่ระบุ = สร้างใหม่ (next_run_date = start_date เสมอ — รอบแรกตรงวันที่เริ่มต้นพอดี)
 *   ★ แก้ startDate ของเทมเพลตที่ "ยังไม่เคย generate เลย" (last_generated_at is null) → recompute
 *     next_run_date = startDate ใหม่ตามไปด้วย (ยังไม่มีรอบไหนเดินหน้าไป ปรับตารางใหม่ได้ปลอดภัย)
 *     แต่ถ้า generate ไปแล้วอย่างน้อย 1 รอบ → next_run_date เดิมคงอยู่เสมอ (ไม่ทำให้ตารางที่เดินหน้าไปแล้วเพี้ยน)
 */
export async function upsertTemplate(
  db: DB,
  tenantId: string,
  customerId: string,
  input: RecurringTemplateInput,
  chartByCode: ChartByCode,
  id?: string
): Promise<RecurringActionResult> {
  const v = validateTemplateInput(input, chartByCode);
  if (!v.ok) return { ok: false, message: v.message };

  if (id) {
    const cur = await getTemplateScope(db, tenantId, id);
    if (!cur) return { ok: false, message: "ไม่พบเทมเพลต (อาจถูกลบไปแล้ว)" };
    if (cur.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับเทมเพลตเดิม" };

    const updatePayload: Record<string, unknown> = {
      doc_type: v.value.docType,
      memo: v.value.memo,
      frequency: v.value.frequency,
      start_date: v.value.startDate,
      end_date: v.value.endDate,
    };
    if (!cur.lastGeneratedAt) {
      // ยังไม่เคย generate — ปรับ next_run_date ตาม start_date ใหม่ได้ปลอดภัย
      updatePayload.next_run_date = v.value.startDate;
    }

    const { error } = await db
      .from("recurring_journal_templates")
      .update(updatePayload)
      .eq("id", id)
      .eq("tenant_id", tenantId);
    if (error) return { ok: false, message: "บันทึกเทมเพลตไม่สำเร็จ กรุณาลองใหม่" };

    await db.from("recurring_journal_template_lines").delete().eq("template_id", id).eq("tenant_id", tenantId);
    const { error: lineErr } = await db.from("recurring_journal_template_lines").insert(
      v.value.lines.map((l) => ({
        template_id: id,
        tenant_id: tenantId,
        line_no: l.lineNo,
        account_code: l.accountCode,
        account_name: l.accountName,
        description: l.description,
        debit: l.debit,
        credit: l.credit,
      }))
    );
    if (lineErr) return { ok: false, message: "บันทึกบรรทัดเทมเพลตไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, id };
  }

  // insert ใหม่ — next_run_date = start_date เสมอ (รอบแรกตรงวันที่เริ่มต้น)
  const { data, error } = await db
    .from("recurring_journal_templates")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      doc_type: v.value.docType,
      memo: v.value.memo,
      frequency: v.value.frequency,
      start_date: v.value.startDate,
      next_run_date: v.value.startDate,
      end_date: v.value.endDate,
      is_active: true,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "เพิ่มเทมเพลตไม่สำเร็จ กรุณาลองใหม่" };
  const newId = (data as { id: string }).id;

  const { error: lineErr } = await db.from("recurring_journal_template_lines").insert(
    v.value.lines.map((l) => ({
      template_id: newId,
      tenant_id: tenantId,
      line_no: l.lineNo,
      account_code: l.accountCode,
      account_name: l.accountName,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
    }))
  );
  if (lineErr) {
    // ใส่บรรทัดไม่สำเร็จ → ลบหัวที่เพิ่งสร้างทิ้ง (กันเทมเพลตเปล่าไม่มีบรรทัดค้างใน DB)
    await db.from("recurring_journal_templates").delete().eq("id", newId).eq("tenant_id", tenantId);
    return { ok: false, message: "เพิ่มบรรทัดเทมเพลตไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id: newId };
}

/** เปิด/ปิดใช้งานเทมเพลต (is_active) — ปิดแล้ว cron/ปุ่ม "สร้างตอนนี้" จะไม่ claim อีก (RPC เช็ค is_active) */
export async function toggleTemplateActive(
  db: DB,
  tenantId: string,
  id: string,
  isActive: boolean
): Promise<RecurringActionResult> {
  const cur = await getTemplateScope(db, tenantId, id);
  if (!cur) return { ok: false, message: "ไม่พบเทมเพลต (อาจถูกลบไปแล้ว)" };
  const { error } = await db
    .from("recurring_journal_templates")
    .update({ is_active: isActive })
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "เปลี่ยนสถานะไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

/** ลบเทมเพลต (soft-delete) — occurrence ที่สร้างไปแล้วยังอยู่เหมือนเดิม (recurring_template_id → set null ตาม FK) */
export async function softDeleteTemplate(db: DB, tenantId: string, id: string): Promise<RecurringActionResult> {
  const cur = await getTemplateScope(db, tenantId, id);
  if (!cur) return { ok: false, message: "ไม่พบเทมเพลต (อาจถูกลบไปแล้ว)" };
  const { error } = await db
    .from("recurring_journal_templates")
    .update({ deleted_at: new Date().toISOString(), is_active: false })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ลบเทมเพลตไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

// ---------------------------------------------------------------------
// log การ generate + occurrence ที่สร้างแล้ว — สำหรับหน้า UI (badge/ประวัติ)
// ---------------------------------------------------------------------

export type GenerationLogEntry = {
  id: string;
  templateId: string;
  runDate: string;
  status: "generated" | "failed";
  message: string | null;
  manualEntryId: string | null;
  createdAt: string;
};

/** ประวัติการ generate ของเทมเพลต 1 ใบ (ล่าสุดก่อน) — ใช้โชว์ว่ารอบไหนสำเร็จ/ล้มเหลว+เหตุผล (0.8) */
export async function listGenerationLog(
  db: DB,
  tenantId: string,
  templateId: string
): Promise<GenerationLogEntry[]> {
  const { data } = await db
    .from("recurring_journal_generation_log")
    .select("id, template_id, run_date, status, message, manual_entry_id, created_at")
    .eq("tenant_id", tenantId)
    .eq("template_id", templateId)
    .order("run_date", { ascending: false })
    .limit(LOG_LIMIT);
  return ((data ?? []) as {
    id: string;
    template_id: string;
    run_date: string;
    status: string;
    message: string | null;
    manual_entry_id: string | null;
    created_at: string;
  }[]).map((r) => ({
    id: r.id,
    templateId: r.template_id,
    runDate: r.run_date,
    status: (r.status as "generated" | "failed") ?? "failed",
    message: r.message,
    manualEntryId: r.manual_entry_id,
    createdAt: r.created_at,
  }));
}

export type RecurringOccurrence = {
  id: string;
  templateId: string;
  docDate: string;
  docNo: string | null;
  status: ManualEntryStatus;
};

/**
 * occurrence (manual_journal_entries) ที่ผูกกับเทมเพลตของลูกค้ารายนี้ทั้งหมด — โหลดครั้งเดียว (ไม่วน N+1
 *   ต่อเทมเพลต) แล้วให้ผู้เรียกจัดกลุ่มตาม templateId เอง (badge เชื่อมเทมเพลต + ลิงก์ไปหน้า journal-entry)
 */
export async function listOccurrencesByTemplateIds(
  db: DB,
  tenantId: string,
  customerId: string,
  templateIds: string[]
): Promise<RecurringOccurrence[]> {
  if (templateIds.length === 0) return [];
  const { data } = await db
    .from("manual_journal_entries")
    .select("id, doc_date, doc_no, status, recurring_template_id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .in("recurring_template_id", templateIds)
    .is("deleted_at", null)
    .order("doc_date", { ascending: false })
    .limit(LIST_LIMIT);
  return ((data ?? []) as {
    id: string;
    doc_date: string;
    doc_no: string | null;
    status: string;
    recurring_template_id: string | null;
  }[])
    .filter((r) => !!r.recurring_template_id)
    .map((r) => ({
      id: r.id,
      templateId: r.recurring_template_id as string,
      docDate: r.doc_date,
      docNo: r.doc_no,
      status: (r.status as ManualEntryStatus) ?? "draft",
    }));
}

// ---------------------------------------------------------------------
// orchestrator — generate occurrence จริง (T40) ★ จุดสำคัญที่สุดของ R
// ---------------------------------------------------------------------

export type GenerateOccurrenceResult =
  | { status: "generated"; templateId: string; manualEntryId: string }
  | { status: "failed"; templateId: string; message: string }
  | { status: "skipped"; templateId: string };

type RawClaimResult = {
  claimed: boolean;
  run_date?: string;
  doc_type?: string;
  memo?: string | null;
  customer_id?: string;
};

/** core: claim 1 เทมเพลต (atomic RPC) → สร้าง occurrence (draft เสมอ, 0.3) + เขียน log — ไม่ throw ออกนอก */
async function generateOne(
  db: DB,
  tenantId: string,
  templateId: string,
  today: string,
  chartByCode: ChartByCode
): Promise<GenerateOccurrenceResult> {
  const { data: claimData, error: claimErr } = await db.rpc("claim_recurring_je_occurrence", {
    p_tenant_id: tenantId,
    p_template_id: templateId,
    p_today: today,
  });
  if (claimErr) {
    // ★ RPC error จริง (เช่น migration ไม่ครบ/DB connection พัง) — ต่างจากกรณี "ยังไม่ถึงรอบ" ด้านล่าง
    //   (claim.claimed=false, claimErr=null) ที่ skip เงียบตามปกติ (0.4) — error จริงต้อง log เป็น failed
    //   ให้เห็นชัดเจนเสมอ ไม่เงียบหายไปเหมือนกรณีปกติ (0.8)
    const message = claimErr.message || "เรียก RPC claim_recurring_je_occurrence ไม่สำเร็จ";
    await db.from("recurring_journal_generation_log").insert({
      tenant_id: tenantId,
      template_id: templateId,
      run_date: today,
      status: "failed",
      message,
    });
    return { status: "failed", templateId, message };
  }
  if (!claimData) return { status: "skipped", templateId };

  const claim = claimData as RawClaimResult;
  if (!claim.claimed) return { status: "skipped", templateId };

  const runDate = claim.run_date ?? today;
  const customerId = claim.customer_id ?? "";
  const docType: ManualDocType = claim.doc_type === "PV" || claim.doc_type === "RV" ? claim.doc_type : "JV";
  const memo = claim.memo ?? null;

  const { data: lineData } = await db
    .from("recurring_journal_template_lines")
    .select("account_code, account_name, description, debit, credit")
    .eq("tenant_id", tenantId)
    .eq("template_id", templateId)
    .order("line_no", { ascending: true });
  const lines = ((lineData ?? []) as {
    account_code: string;
    account_name: string | null;
    description: string | null;
    debit: number | string;
    credit: number | string;
  }[]).map((l, idx) => ({
    lineNo: idx + 1,
    accountCode: l.account_code,
    accountName: l.account_name,
    description: l.description,
    debit: asAmount(l.debit),
    credit: asAmount(l.credit),
  }));

  const manualInput: ManualEntryInput = buildOccurrenceInput({ docType, memo, lines }, runDate);

  const res = await upsertManualEntry(db, tenantId, customerId, manualInput, chartByCode);
  if (!res.ok) {
    // ★ 0.8: บัญชีถูกลบ/ไม่ครบ ฯลฯ → validate ปฏิเสธตามปกติ ไม่ throw — log แล้วให้เทมเพลตอื่นทำต่อ
    await db.from("recurring_journal_generation_log").insert({
      tenant_id: tenantId,
      template_id: templateId,
      run_date: runDate,
      status: "failed",
      message: res.message,
    });
    return { status: "failed", templateId, message: res.message };
  }

  // ★ 0.7: ผูก occurrence → เทมเพลตต้นทาง (metadata ล้วน ไม่กระทบ mapper บัญชีใด ๆ)
  await db
    .from("manual_journal_entries")
    .update({ recurring_template_id: templateId })
    .eq("id", res.id)
    .eq("tenant_id", tenantId);

  await db.from("recurring_journal_generation_log").insert({
    tenant_id: tenantId,
    template_id: templateId,
    run_date: runDate,
    status: "generated",
    manual_entry_id: res.id,
  });

  return { status: "generated", templateId, manualEntryId: res.id };
}

/**
 * สร้าง occurrence ของเทมเพลต "เดียว" ทันที (ปุ่ม "สร้างตอนนี้" — T42) — เรียก logic เดียวกับ cron
 *   ★ today ต้องเป็นวันที่ปัจจุบันจริงเสมอ (caller ชั้น action ห้ามรับจาก client — บังคับที่ actions.ts)
 */
export async function generateOccurrenceForTemplate(
  db: DB,
  tenantId: string,
  templateId: string,
  today: string
): Promise<GenerateOccurrenceResult> {
  const chart = await listChartOfAccounts(db, tenantId);
  return generateOne(db, tenantId, templateId, today, buildChartByCode(chart));
}

export type GenerateDueOccurrencesSummary = {
  scanned: number;
  generated: number;
  failed: number;
  skipped: number;
  results: GenerateOccurrenceResult[];
};

/**
 * สแกนทุกเทมเพลต active ของ tenant ที่ next_run_date <= today → claim + generate ทีละใบ (T40)
 *   ★ ครอบ try/catch ต่อเทมเพลต — เทมเพลตหนึ่งพัง (เช่น account_code ถูกลบ, DB error ไม่คาดคิด) ต้องไม่ทำให้
 *     เทมเพลตอื่นของ tenant เดียวกันหยุด generate ตามไปด้วย (0.8, ไม่ throw ทั้ง batch)
 *   ★ เทมเพลตที่ claim ไม่ติด (ยังไม่ถึงรอบจริง/ถูกคนอื่น claim ไปแล้ว) → skip เงียบ ๆ ไม่เขียน log (0.4)
 */
export async function generateDueOccurrences(
  db: DB,
  tenantId: string,
  today: string
): Promise<GenerateDueOccurrencesSummary> {
  const { data } = await db
    .from("recurring_journal_templates")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .lte("next_run_date", today)
    .limit(CANDIDATE_LIMIT);
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);

  const chart = await listChartOfAccounts(db, tenantId);
  const chartByCode = buildChartByCode(chart);

  const results: GenerateOccurrenceResult[] = [];
  let generated = 0;
  let failed = 0;
  let skipped = 0;

  for (const templateId of ids) {
    try {
      const r = await generateOne(db, tenantId, templateId, today, chartByCode);
      results.push(r);
      if (r.status === "generated") generated++;
      else if (r.status === "failed") failed++;
      else skipped++;
    } catch {
      // ★ error ไม่คาดคิด (เช่น DB blip กลางคัน) — log แล้วไปเทมเพลตถัดไปต่อ ไม่ throw ทั้ง batch
      try {
        await db.from("recurring_journal_generation_log").insert({
          tenant_id: tenantId,
          template_id: templateId,
          run_date: today,
          status: "failed",
          message: "เกิดข้อผิดพลาดไม่ทราบสาเหตุขณะสร้างรายการ",
        });
      } catch {
        // เขียน log ไม่ได้ก็ยังต้อง continue เทมเพลตถัดไป
      }
      results.push({ status: "failed", templateId, message: "เกิดข้อผิดพลาดไม่ทราบสาเหตุ" });
      failed++;
    }
  }

  return { scanned: ids.length, generated, failed, skipped, results };
}
