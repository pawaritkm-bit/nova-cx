/**
 * ใบแจ้งหนี้ลูกค้าแบบวนซ้ำ (Recurring Customer Invoicing — wishlist ข้อ 4) — เทมเพลต + ตัวสร้าง
 *   occurrence + data layer (DB)
 *
 * บริบท: มิเรอร์สถาปัตยกรรมของ lib/accounting/recurring-journal.ts (เฟส 6 ส่วน R) 100% แต่
 *   occurrence ที่สร้างเป็น "ใบแจ้งหนี้จริง" (bill_entries, entry_type='sale') ไม่ใช่ manual JE —
 *   ★ ต่างจาก recurring-journal.ts ตรงที่ bill_entries ไม่มีฟังก์ชัน "สร้างทั้งใบทีเดียว" แบบ
 *   upsertManualEntry — ต้องเรียก upsertEntry (หัว) แล้ววน addLine (บรรทัด) จาก actions-lib.ts เดิม
 *   ไฟล์นี้ไม่แก้ actions-lib.ts เลยแม้แต่บรรทัดเดียว (เรียกตรง ๆ)
 *
 * ★ ห้าม auto-confirm เด็ดขาด — occurrence ที่สร้างผ่าน upsertEntry เป็น status='draft' เสมอ
 *   (upsertEntry insert ใหม่เป็น draft เสมออยู่แล้ว — ไฟล์นี้ไม่เรียก confirmEntry เลย)
 * ★ การสร้าง occurrence (ทั้ง cron รายวันและปุ่ม "สร้างตอนนี้") ต้องผ่าน RPC
 *   `claim_recurring_invoice_occurrence` (atomic, for update skip locked) เท่านั้น — กัน cron/ปุ่มมือ
 *   ชนกันสร้างซ้ำ ถ้า claim ไม่ติด (ยังไม่ถึงรอบ/ไม่ active/ถูกลบ/มีคนอื่นทำอยู่) คืน skipped เฉย ๆ ไม่ throw
 * ★ ยอดต่อบรรทัดคงที่เสมอ (quantity × unit_price เก็บในเทมเพลต) — ไม่มีสูตร/ตัวแปรผันแปร
 * ★ recurring_invoice_template_id บน bill_entries เป็น metadata ล้วน (ใช้แค่แสดง badge/ลิงก์กลับ)
 * ★ บัญชี/รหัสในเทมเพลตถูกลบ/ปิดใช้งานก่อนถึงรอบ generate → validate ปฏิเสธตามปกติ (ไม่อยู่ในผัง) → ไม่
 *   throw ทั้ง batch แต่บันทึกลง recurring_invoice_generation_log (status='failed') ให้เห็นชัดเจน
 *   เทมเพลตอื่นของ tenant/ลูกค้าอื่นต้อง generate ต่อได้เสมอ (ครอบ try/catch ต่อเทมเพลต)
 * ★ ทุก query/write กรอง tenant_id (จาก session) + customer_id (assertCustomerInScope ทำที่ actions.ts ชั้นบน)
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า/ชื่อคู่ค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { round2 } from "@/lib/accounting/queries";
import { calcVat } from "@/lib/accounting/calc";
import { isValidCalendarDate } from "@/lib/accounting/bank-reconciliation";
import { upsertEntry, addLine, type UpsertEntryInput, type LineInput } from "@/lib/accounting/actions-lib";
import {
  type Frequency,
  FREQUENCY_LABELS,
  addMonthsClamped,
  nextRunDateAfter,
  todayIsoThai,
} from "@/lib/accounting/recurring-journal";

export { FREQUENCY_LABELS, addMonthsClamped, nextRunDateAfter, todayIsoThai };
export type { Frequency };

type DB = SupabaseClient;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const COUNTERPARTY_NAME_MAX = 200;
export const COUNTERPARTY_TAX_ID_MAX = 20;
export const NOTES_MAX = 500;
export const DESCRIPTION_MAX = 200;
export const ACCOUNT_CODE_MAX = 20;
export const ACCOUNT_NAME_MAX = 200;
export const INVOICE_MIN_LINES = 1;
export const INVOICE_MAX_LINES = 50;
export const DEFAULT_DUE_DAYS = 30;
export const MAX_DUE_DAYS = 3650;

// ---------------------------------------------------------------------
// ชนิดข้อมูล
// ---------------------------------------------------------------------

/** 1 บรรทัดของเทมเพลต (id มีเมื่อโหลดจาก DB แล้ว — ไม่มีตอนสร้างใหม่) — ยอดต่อบรรทัดคงที่ทุกรอบ */
export type RecurringInvoiceTemplateLine = {
  id?: string;
  lineNo: number;
  description: string | null;
  accountCode: string;
  accountName: string | null;
  vatType: "vat" | "novat";
  quantity: number;
  unitPrice: number;
};

/** หัว + บรรทัด เทมเพลตใบแจ้งหนี้วนซ้ำ 1 ใบ */
export type RecurringInvoiceTemplate = {
  id: string;
  tenantId: string;
  customerId: string;
  counterpartyName: string;
  counterpartyTaxId: string | null;
  notes: string | null;
  frequency: Frequency;
  /** YYYY-MM-DD — วันที่เริ่มต้นของรอบแรก */
  startDate: string;
  /** YYYY-MM-DD — วันที่ที่จะสร้าง occurrence ถัดไป (advance โดย RPC claim เท่านั้น) */
  nextRunDate: string;
  /** YYYY-MM-DD — null = ไม่มีวันสิ้นสุด */
  endDate: string | null;
  dueDays: number;
  isActive: boolean;
  lastGeneratedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: RecurringInvoiceTemplateLine[];
};

export type RecurringInvoiceTemplateLineInput = {
  description?: unknown;
  accountCode: unknown;
  accountName?: unknown;
  vatType?: unknown;
  quantity: unknown;
  unitPrice: unknown;
};

export type RecurringInvoiceTemplateInput = {
  counterpartyName: unknown;
  counterpartyTaxId?: unknown;
  notes?: unknown;
  frequency: unknown;
  /** YYYY-MM-DD */
  startDate: unknown;
  /** YYYY-MM-DD — ไม่ระบุ/null/ว่าง = ไม่มีวันสิ้นสุด */
  endDate?: unknown;
  dueDays?: unknown;
  lines: RecurringInvoiceTemplateLineInput[];
};

export type ValidatedRecurringInvoiceTemplate = {
  counterpartyName: string;
  counterpartyTaxId: string | null;
  notes: string | null;
  frequency: Frequency;
  startDate: string;
  endDate: string | null;
  dueDays: number;
  lines: RecurringInvoiceTemplateLine[];
};

export type TemplateValidationResult =
  | { ok: true; value: ValidatedRecurringInvoiceTemplate }
  | { ok: false; message: string };

// ---------------------------------------------------------------------
// helper เล็ก ๆ
// ---------------------------------------------------------------------

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function asFrequency(v: unknown): Frequency | null {
  return v === "monthly" || v === "quarterly" || v === "yearly" ? v : null;
}

function asVatType(v: unknown): "vat" | "novat" {
  return v === "novat" ? "novat" : "vat";
}

function requireRevenueAccount(
  code: string | null,
  chartByCode: ChartByCode
): { ok: true } | { ok: false; message: string } {
  if (!code) return { ok: false, message: "ต้องเลือกรหัสบัญชีรายได้" };
  const acc = chartByCode[code];
  if (!acc) return { ok: false, message: `รหัสบัญชี "${code}" ไม่อยู่ในผังบัญชี` };
  if (acc.category !== "รายได้") {
    return { ok: false, message: `รหัสบัญชี "${code}" ต้องอยู่ในหมวดรายได้` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------
// validate (pure) — server ต้อง re-validate เสมอ ไม่เชื่อ client
// ---------------------------------------------------------------------

export function validateTemplateInput(
  input: RecurringInvoiceTemplateInput,
  chartByCode: ChartByCode
): TemplateValidationResult {
  const counterpartyName = clampText(input.counterpartyName, COUNTERPARTY_NAME_MAX);
  if (!counterpartyName) return { ok: false, message: "ต้องระบุชื่อคู่ค้าที่จะออกใบแจ้งหนี้ให้" };

  const counterpartyTaxId = clampText(input.counterpartyTaxId, COUNTERPARTY_TAX_ID_MAX);
  const notes = clampText(input.notes, NOTES_MAX);

  const frequency = asFrequency(input.frequency);
  if (!frequency) return { ok: false, message: "ต้องระบุความถี่ (ทุกเดือน/ทุกไตรมาส/ทุกปี)" };

  const startDate =
    typeof input.startDate === "string" && DATE_RE.test(input.startDate) ? input.startDate : "";
  if (!startDate) return { ok: false, message: "ต้องระบุวันที่เริ่มต้นให้ถูกรูปแบบ (YYYY-MM-DD)" };
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

  const dueDaysNum =
    typeof input.dueDays === "number" ? input.dueDays : Number(input.dueDays ?? DEFAULT_DUE_DAYS);
  if (!Number.isFinite(dueDaysNum) || dueDaysNum < 0 || dueDaysNum > MAX_DUE_DAYS || !Number.isInteger(dueDaysNum)) {
    return { ok: false, message: `จำนวนวันครบกำหนดชำระต้องเป็นจำนวนเต็ม 0-${MAX_DUE_DAYS}` };
  }

  if (!Array.isArray(input.lines) || input.lines.length < INVOICE_MIN_LINES) {
    return { ok: false, message: `ต้องมีอย่างน้อย ${INVOICE_MIN_LINES} บรรทัดรายการ` };
  }
  if (input.lines.length > INVOICE_MAX_LINES) {
    return { ok: false, message: `บรรทัดมากเกินไป (สูงสุด ${INVOICE_MAX_LINES} บรรทัด)` };
  }

  const lines: RecurringInvoiceTemplateLine[] = [];
  let totalAmount = 0;
  for (let i = 0; i < input.lines.length; i++) {
    const raw = input.lines[i];
    const accountCode = clampText(raw.accountCode, ACCOUNT_CODE_MAX);
    const accCheck = requireRevenueAccount(accountCode, chartByCode);
    if (!accCheck.ok) return { ok: false, message: `บรรทัดที่ ${i + 1}: ${accCheck.message}` };

    const quantityNum = typeof raw.quantity === "number" ? raw.quantity : Number(raw.quantity);
    if (!Number.isFinite(quantityNum) || quantityNum <= 0) {
      return { ok: false, message: `บรรทัดที่ ${i + 1}: จำนวนต้องเป็นตัวเลขมากกว่า 0` };
    }
    const unitPriceNum = typeof raw.unitPrice === "number" ? raw.unitPrice : Number(raw.unitPrice);
    if (!Number.isFinite(unitPriceNum) || unitPriceNum < 0) {
      return { ok: false, message: `บรรทัดที่ ${i + 1}: ราคาต่อหน่วยต้องเป็นตัวเลขไม่ติดลบ` };
    }

    const chartAcc = chartByCode[accountCode as string];
    const accountName = clampText(raw.accountName, ACCOUNT_NAME_MAX) ?? chartAcc?.name ?? null;
    const description = clampText(raw.description, DESCRIPTION_MAX);
    const vatType = asVatType(raw.vatType);

    const quantity = round2(quantityNum);
    const unitPrice = round2(unitPriceNum);
    totalAmount = round2(totalAmount + round2(quantity * unitPrice));

    lines.push({ lineNo: i + 1, description, accountCode: accountCode as string, accountName, vatType, quantity, unitPrice });
  }

  if (totalAmount <= 0) {
    return { ok: false, message: "ยอดรวมใบแจ้งหนี้ต้องมากกว่า 0" };
  }

  return {
    ok: true,
    value: {
      counterpartyName,
      counterpartyTaxId,
      notes,
      frequency,
      startDate,
      endDate,
      dueDays: Math.round(dueDaysNum),
      lines,
    },
  };
}

// ---------------------------------------------------------------------
// date arithmetic (pure) — บวกวัน (ไม่มีปัญหา clamp วันสิ้นเดือนแบบเดือน — ใช้บวกวันตรง ๆ ได้)
// ---------------------------------------------------------------------

/** วันที่ครบกำหนดชำระ = docDate + dueDays วัน (UTC-safe, ไม่พึ่ง timezone ของเครื่อง) */
export function addDays(dateIso: string, days: number): string {
  const m = DATE_RE.exec(dateIso);
  if (!m) return dateIso;
  const y = Number(dateIso.slice(0, 4));
  const mo = Number(dateIso.slice(5, 7));
  const d = Number(dateIso.slice(8, 10));
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yStr = String(dt.getUTCFullYear()).padStart(4, "0");
  const moStr = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dStr = String(dt.getUTCDate()).padStart(2, "0");
  return `${yStr}-${moStr}-${dStr}`;
}

// ---------------------------------------------------------------------
// pure mapper — เทมเพลต + วันที่รอบ → header + lines (เข้า upsertEntry/addLine เดิมตรง ๆ)
// ---------------------------------------------------------------------

export type InvoiceOccurrenceLine = Pick<LineInput, "vatType" | "description" | "accountCode" | "accountName" | "quantity" | "amount" | "vatAmount">;

/**
 * แปลงเทมเพลต + วันที่รอบ (runDate จาก RPC claim) → header (UpsertEntryInput) + lines (LineInput[])
 *   ที่ป้อนเข้า upsertEntry แล้ววน addLine ของ actions-lib.ts ได้ตรง ๆ (docNo ปล่อยว่าง — ให้นักบัญชี
 *   กรอกเองถ้าต้องการ, mirror recurring-journal.ts::buildOccurrenceInput)
 */
export function buildInvoiceOccurrenceInput(
  template: Pick<RecurringInvoiceTemplate, "customerId" | "counterpartyName" | "counterpartyTaxId" | "notes" | "dueDays" | "lines">,
  runDate: string
): { header: UpsertEntryInput; lines: InvoiceOccurrenceLine[] } {
  const header: UpsertEntryInput = {
    entryType: "sale",
    customerId: template.customerId,
    docDate: runDate,
    docNo: null,
    counterpartyName: template.counterpartyName,
    counterpartyTaxId: template.counterpartyTaxId,
    dueDate: addDays(runDate, template.dueDays),
    notes: template.notes,
  };
  const lines: InvoiceOccurrenceLine[] = template.lines.map((l) => {
    const amount = round2(l.quantity * l.unitPrice);
    return {
      vatType: l.vatType,
      description: l.description,
      accountCode: l.accountCode,
      accountName: l.accountName,
      quantity: l.quantity,
      amount,
      vatAmount: calcVat(amount, l.vatType),
    };
  });
  return { header, lines };
}

// ---------------------------------------------------------------------
// data layer (DB) — CRUD เทมเพลต
// ---------------------------------------------------------------------

const LIST_LIMIT = 500;
const LOG_LIMIT = 200;
const CANDIDATE_LIMIT = 2000;

type RawTemplateHead = {
  id: string;
  tenant_id: string;
  customer_id: string;
  counterparty_name: string;
  counterparty_tax_id: string | null;
  notes: string | null;
  frequency: string;
  start_date: string;
  next_run_date: string;
  end_date: string | null;
  due_days: number;
  is_active: boolean;
  last_generated_at: string | null;
  created_at: string;
  updated_at: string;
};

type RawTemplateLine = {
  id: string;
  template_id: string;
  line_no: number;
  description: string | null;
  account_code: string;
  account_name: string | null;
  vat_type: string;
  quantity: number | string;
  unit_price: number | string;
};

function mapLine(r: RawTemplateLine): RecurringInvoiceTemplateLine {
  return {
    id: r.id,
    lineNo: r.line_no,
    description: r.description,
    accountCode: r.account_code,
    accountName: r.account_name,
    vatType: r.vat_type === "novat" ? "novat" : "vat",
    quantity: round2(Number(r.quantity)),
    unitPrice: round2(Number(r.unit_price)),
  };
}

/** ดึงเทมเพลตทั้งหมด (active+inactive) ของลูกค้า 1 ราย เรียงสร้างล่าสุดก่อน */
export async function listTemplates(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<RecurringInvoiceTemplate[]> {
  const { data: heads, error } = await db
    .from("recurring_invoice_templates")
    .select(
      "id, tenant_id, customer_id, counterparty_name, counterparty_tax_id, notes, frequency, start_date, next_run_date, end_date, due_days, is_active, last_generated_at, created_at, updated_at"
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
    .from("recurring_invoice_template_lines")
    .select("id, template_id, line_no, description, account_code, account_name, vat_type, quantity, unit_price")
    .eq("tenant_id", tenantId)
    .in("template_id", ids)
    .order("line_no", { ascending: true });

  const linesByTemplate = new Map<string, RecurringInvoiceTemplateLine[]>();
  for (const r of (lineData ?? []) as unknown as RawTemplateLine[]) {
    const arr = linesByTemplate.get(r.template_id) ?? [];
    arr.push(mapLine(r));
    linesByTemplate.set(r.template_id, arr);
  }

  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    counterpartyName: r.counterparty_name,
    counterpartyTaxId: r.counterparty_tax_id,
    notes: r.notes,
    frequency: (r.frequency as Frequency) ?? "monthly",
    startDate: r.start_date,
    nextRunDate: r.next_run_date,
    endDate: r.end_date,
    dueDays: r.due_days,
    isActive: r.is_active,
    lastGeneratedAt: r.last_generated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lines: linesByTemplate.get(r.id) ?? [],
  }));
}

export type RecurringActionResult = { ok: true; id: string } | { ok: false; message: string };

/** โหลด customer_id + สถานะการ generate ของเทมเพลต 1 ใบ (scope tenant) — ใช้ตรวจสโคปลูกค้าก่อนแก้/ลบ */
export async function getTemplateScope(
  db: DB,
  tenantId: string,
  id: string
): Promise<{ customerId: string; lastGeneratedAt: string | null } | null> {
  const { data } = await db
    .from("recurring_invoice_templates")
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
 *   ★ แก้ startDate ของเทมเพลตที่ "ยังไม่เคย generate เลย" → recompute next_run_date ตามไปด้วย
 *     แต่ถ้า generate ไปแล้วอย่างน้อย 1 รอบ → next_run_date เดิมคงอยู่เสมอ (mirror recurring-journal.ts)
 */
export async function upsertTemplate(
  db: DB,
  tenantId: string,
  customerId: string,
  input: RecurringInvoiceTemplateInput,
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
      counterparty_name: v.value.counterpartyName,
      counterparty_tax_id: v.value.counterpartyTaxId,
      notes: v.value.notes,
      frequency: v.value.frequency,
      start_date: v.value.startDate,
      end_date: v.value.endDate,
      due_days: v.value.dueDays,
    };
    if (!cur.lastGeneratedAt) {
      updatePayload.next_run_date = v.value.startDate;
    }

    const { error } = await db
      .from("recurring_invoice_templates")
      .update(updatePayload)
      .eq("id", id)
      .eq("tenant_id", tenantId);
    if (error) return { ok: false, message: "บันทึกเทมเพลตไม่สำเร็จ กรุณาลองใหม่" };

    await db.from("recurring_invoice_template_lines").delete().eq("template_id", id).eq("tenant_id", tenantId);
    const { error: lineErr } = await db.from("recurring_invoice_template_lines").insert(
      v.value.lines.map((l) => ({
        template_id: id,
        tenant_id: tenantId,
        line_no: l.lineNo,
        description: l.description,
        account_code: l.accountCode,
        account_name: l.accountName,
        vat_type: l.vatType,
        quantity: l.quantity,
        unit_price: l.unitPrice,
      }))
    );
    if (lineErr) return { ok: false, message: "บันทึกบรรทัดเทมเพลตไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, id };
  }

  const { data, error } = await db
    .from("recurring_invoice_templates")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      counterparty_name: v.value.counterpartyName,
      counterparty_tax_id: v.value.counterpartyTaxId,
      notes: v.value.notes,
      frequency: v.value.frequency,
      start_date: v.value.startDate,
      next_run_date: v.value.startDate,
      end_date: v.value.endDate,
      due_days: v.value.dueDays,
      is_active: true,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "เพิ่มเทมเพลตไม่สำเร็จ กรุณาลองใหม่" };
  const newId = (data as { id: string }).id;

  const { error: lineErr } = await db.from("recurring_invoice_template_lines").insert(
    v.value.lines.map((l) => ({
      template_id: newId,
      tenant_id: tenantId,
      line_no: l.lineNo,
      description: l.description,
      account_code: l.accountCode,
      account_name: l.accountName,
      vat_type: l.vatType,
      quantity: l.quantity,
      unit_price: l.unitPrice,
    }))
  );
  if (lineErr) {
    await db.from("recurring_invoice_templates").delete().eq("id", newId).eq("tenant_id", tenantId);
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
    .from("recurring_invoice_templates")
    .update({ is_active: isActive })
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "เปลี่ยนสถานะไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

/** ลบเทมเพลต (soft-delete) — occurrence ที่สร้างไปแล้วยังอยู่เหมือนเดิม */
export async function softDeleteTemplate(db: DB, tenantId: string, id: string): Promise<RecurringActionResult> {
  const cur = await getTemplateScope(db, tenantId, id);
  if (!cur) return { ok: false, message: "ไม่พบเทมเพลต (อาจถูกลบไปแล้ว)" };
  const { error } = await db
    .from("recurring_invoice_templates")
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
  billEntryId: string | null;
  createdAt: string;
};

/** ประวัติการ generate ของเทมเพลต 1 ใบ (ล่าสุดก่อน) — ใช้โชว์ว่ารอบไหนสำเร็จ/ล้มเหลว+เหตุผล */
export async function listGenerationLog(
  db: DB,
  tenantId: string,
  templateId: string
): Promise<GenerationLogEntry[]> {
  const { data } = await db
    .from("recurring_invoice_generation_log")
    .select("id, template_id, run_date, status, message, bill_entry_id, created_at")
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
    bill_entry_id: string | null;
    created_at: string;
  }[]).map((r) => ({
    id: r.id,
    templateId: r.template_id,
    runDate: r.run_date,
    status: (r.status as "generated" | "failed") ?? "failed",
    message: r.message,
    billEntryId: r.bill_entry_id,
    createdAt: r.created_at,
  }));
}

export type RecurringInvoiceOccurrence = {
  id: string;
  templateId: string;
  docDate: string | null;
  docNo: string | null;
  status: "draft" | "confirmed";
};

/**
 * occurrence (bill_entries) ที่ผูกกับเทมเพลตของลูกค้ารายนี้ทั้งหมด — โหลดครั้งเดียว (ไม่วน N+1
 *   ต่อเทมเพลต) แล้วให้ผู้เรียกจัดกลุ่มตาม templateId เอง (badge เชื่อมเทมเพลต + ลิงก์ไปหน้าลงบันทึกบัญชี)
 */
export async function listOccurrencesByTemplateIds(
  db: DB,
  tenantId: string,
  customerId: string,
  templateIds: string[]
): Promise<RecurringInvoiceOccurrence[]> {
  if (templateIds.length === 0) return [];
  const { data } = await db
    .from("bill_entries")
    .select("id, doc_date, doc_no, status, recurring_invoice_template_id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .in("recurring_invoice_template_id", templateIds)
    .is("deleted_at", null)
    .order("doc_date", { ascending: false })
    .limit(LIST_LIMIT);
  return ((data ?? []) as {
    id: string;
    doc_date: string | null;
    doc_no: string | null;
    status: string;
    recurring_invoice_template_id: string | null;
  }[])
    .filter((r) => !!r.recurring_invoice_template_id)
    .map((r) => ({
      id: r.id,
      templateId: r.recurring_invoice_template_id as string,
      docDate: r.doc_date,
      docNo: r.doc_no,
      status: (r.status as "draft" | "confirmed") ?? "draft",
    }));
}

// ---------------------------------------------------------------------
// orchestrator — generate occurrence จริง ★ จุดสำคัญที่สุดของฟีเจอร์นี้
// ---------------------------------------------------------------------

export type GenerateOccurrenceResult =
  | { status: "generated"; templateId: string; billEntryId: string }
  | { status: "failed"; templateId: string; message: string }
  | { status: "skipped"; templateId: string };

type RawClaimResult = {
  claimed: boolean;
  run_date?: string;
  customer_id?: string;
  counterparty_name?: string | null;
  counterparty_tax_id?: string | null;
  notes?: string | null;
  due_days?: number;
};

/** core: claim 1 เทมเพลต (atomic RPC) → สร้าง occurrence (draft เสมอ) + เขียน log — ไม่ throw ออกนอก */
async function generateOne(
  db: DB,
  tenantId: string,
  templateId: string,
  today: string,
  chartByCode: ChartByCode
): Promise<GenerateOccurrenceResult> {
  const { data: claimData, error: claimErr } = await db.rpc("claim_recurring_invoice_occurrence", {
    p_tenant_id: tenantId,
    p_template_id: templateId,
    p_today: today,
  });
  if (claimErr) {
    const message = claimErr.message || "เรียก RPC claim_recurring_invoice_occurrence ไม่สำเร็จ";
    await db.from("recurring_invoice_generation_log").insert({
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
  const counterpartyName = claim.counterparty_name ?? "";
  const counterpartyTaxId = claim.counterparty_tax_id ?? null;
  const notes = claim.notes ?? null;
  const dueDays = typeof claim.due_days === "number" ? claim.due_days : DEFAULT_DUE_DAYS;

  const { data: lineData } = await db
    .from("recurring_invoice_template_lines")
    .select("account_code, account_name, description, vat_type, quantity, unit_price")
    .eq("tenant_id", tenantId)
    .eq("template_id", templateId)
    .order("line_no", { ascending: true });
  const lines: RecurringInvoiceTemplateLine[] = ((lineData ?? []) as {
    account_code: string;
    account_name: string | null;
    description: string | null;
    vat_type: string;
    quantity: number | string;
    unit_price: number | string;
  }[]).map((l, idx) => ({
    lineNo: idx + 1,
    accountCode: l.account_code,
    accountName: l.account_name,
    description: l.description,
    vatType: l.vat_type === "novat" ? "novat" : "vat",
    quantity: round2(Number(l.quantity)),
    unitPrice: round2(Number(l.unit_price)),
  }));

  // ★ defense-in-depth: เทมเพลตไม่มีบรรทัดเลย (เช่น upsertTemplate ลบ-แล้ว-ใส่ใหม่เป็น 2 statement
  //   แยกกันไม่มี transaction คร่อม — ถ้า claim+SELECT lines มาตรงช่วง delete/insert ทับกันพอดี lines
  //   อาจว่างเปล่าชั่วคราว) ห้ามสร้างใบแจ้งหนี้หัวเปล่าไม่มีเนื้อหาแล้ว mark ว่า generated สำเร็จเงียบ ๆ
  if (lines.length === 0) {
    const message = "เทมเพลตนี้ไม่มีบรรทัดรายการให้สร้างใบแจ้งหนี้ (อาจกำลังถูกแก้ไขพร้อมกัน) — ลองใหม่อีกครั้ง";
    await db.from("recurring_invoice_generation_log").insert({
      tenant_id: tenantId,
      template_id: templateId,
      run_date: runDate,
      status: "failed",
      message,
    });
    return { status: "failed", templateId, message };
  }

  const built = buildInvoiceOccurrenceInput(
    { customerId, counterpartyName, counterpartyTaxId, notes, dueDays, lines },
    runDate
  );

  // ★ validate ซ้ำก่อนเขียนจริง — บัญชีถูกลบ/ปิดใช้งานหลังตั้งเทมเพลต ต้องปฏิเสธแบบเดียวกับตอนสร้างเทมเพลต
  for (const l of lines) {
    const acc = chartByCode[l.accountCode];
    if (!acc || acc.category !== "รายได้") {
      const message = `รหัสบัญชี "${l.accountCode}" ไม่อยู่ในผังบัญชี หรือไม่ใช่หมวดรายได้อีกต่อไป`;
      await db.from("recurring_invoice_generation_log").insert({
        tenant_id: tenantId,
        template_id: templateId,
        run_date: runDate,
        status: "failed",
        message,
      });
      return { status: "failed", templateId, message };
    }
  }

  const headRes = await upsertEntry(db, tenantId, built.header);
  if (!headRes.ok) {
    const message = "สร้างหัวใบแจ้งหนี้ไม่สำเร็จ";
    await db.from("recurring_invoice_generation_log").insert({
      tenant_id: tenantId,
      template_id: templateId,
      run_date: runDate,
      status: "failed",
      message,
    });
    return { status: "failed", templateId, message };
  }
  const billEntryId = headRes.data.id;

  for (let i = 0; i < built.lines.length; i++) {
    const l = built.lines[i];
    const lineRes = await addLine(db, tenantId, billEntryId, { ...l, lineNo: i + 1 });
    if (!lineRes.ok) {
      // ★ เขียนบรรทัดไม่ครบ — ลบหัวที่เพิ่งสร้างทิ้ง (กัน invoice เปล่า/ไม่ครบค้างใน DB) แล้ว log failed
      await db.from("bill_entries").delete().eq("id", billEntryId).eq("tenant_id", tenantId);
      const message = "สร้างบรรทัดใบแจ้งหนี้ไม่สำเร็จ";
      await db.from("recurring_invoice_generation_log").insert({
        tenant_id: tenantId,
        template_id: templateId,
        run_date: runDate,
        status: "failed",
        message,
      });
      return { status: "failed", templateId, message };
    }
  }

  // ★ ผูก occurrence → เทมเพลตต้นทาง (metadata ล้วน ไม่กระทบ mapper บัญชีใด ๆ)
  await db
    .from("bill_entries")
    .update({ recurring_invoice_template_id: templateId })
    .eq("id", billEntryId)
    .eq("tenant_id", tenantId);

  await db.from("recurring_invoice_generation_log").insert({
    tenant_id: tenantId,
    template_id: templateId,
    run_date: runDate,
    status: "generated",
    bill_entry_id: billEntryId,
  });

  return { status: "generated", templateId, billEntryId };
}

/**
 * สร้าง occurrence ของเทมเพลต "เดียว" ทันที (ปุ่ม "สร้างตอนนี้") — เรียก logic เดียวกับ cron
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
 * สแกนทุกเทมเพลต active ของ tenant ที่ next_run_date <= today → claim + generate ทีละใบ
 *   ★ ครอบ try/catch ต่อเทมเพลต — เทมเพลตหนึ่งพัง (เช่น account_code ถูกลบ, DB error ไม่คาดคิด) ต้องไม่ทำให้
 *     เทมเพลตอื่นของ tenant เดียวกันหยุด generate ตามไปด้วย (ไม่ throw ทั้ง batch)
 *   ★ เทมเพลตที่ claim ไม่ติด (ยังไม่ถึงรอบจริง/ถูกคนอื่น claim ไปแล้ว) → skip เงียบ ๆ ไม่เขียน log
 */
export async function generateDueOccurrences(
  db: DB,
  tenantId: string,
  today: string
): Promise<GenerateDueOccurrencesSummary> {
  const { data } = await db
    .from("recurring_invoice_templates")
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
      try {
        await db.from("recurring_invoice_generation_log").insert({
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
