/**
 * รับ/จ่ายเงินแยกจากบิล (bill_payments) — data layer (DB) + validate + pure mapper
 *
 * บริบท: เฟส 2 ส่วน E (docs/06-accounting-features-roadmap.md) — บิลเชื่อ (payment_method='credit')
 *   ที่ตั้ง AR (1140)/AP (2010) ค้างไว้ตอนยืนยันบิล ต้องมีกลไก "ทยอยรับ/จ่ายเงินจริง" ทีหลัง แยกตารางใหม่
 *   ทั้งหมด (ไม่ขยาย bill_entries — จะพังแนวคิด 1 แถว = 1 บิล และไม่ใช้ manual_journal_entries — นั่นคือ
 *   รายการปรับปรุงอิสระ ไม่ผูกบิลต้นทาง) ต่อเข้า engine บัญชีด้วย mapper 2 ตัว (ไม่แก้ตรรกะ ledger/
 *   trial-balance/journal-books เลย) — mirror ของ lib/accounting/manual-journal.ts (เฟส 1 ส่วน C)
 *
 * ★ ยอดเต็มของบิล/ยอดค้างชำระ — reuse `summarizeEntry` (queries.ts) + `contraAccountFor` (payment.ts)
 *   ตรง ๆ ไม่มีสูตรคู่ขนาน (0.3/0.4) — `PaymentEntryInfo` เป็นแค่ Pick ของ BillEntry ที่ใช้จริง
 *   (BillEntry ที่โหลดจาก listEntries() ผ่านเข้าฟังก์ชันเหล่านี้ได้ตรง ๆ โดยไม่ต้องแปลง)
 * ★ bill_payments ไม่มีสถานะ draft/confirmed (0.2) — บันทึกแล้วถือว่าเงินเข้า/ออกจริง แก้ไม่ได้
 *   ผิดพลาดต้อง void (soft-delete) แล้วบันทึกใหม่ที่ถูกต้อง
 * ★ ปฏิเสธยอดชำระเกินยอดค้างเสมอที่ server (0.8) — re-fetch ยอดค้างจาก DB ก่อน insert ทุกครั้ง
 *   (ไม่เชื่อค่าจากฝั่ง client)
 * ★ ทุก query/write กรอง tenant_id (จาก session) — assertCustomerInScope ทำที่ actions.ts ชั้นบน
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { contraAccountFor, asPaymentMethod } from "@/lib/accounting/payment";
import { chunkIds } from "@/lib/accounting/id-chunk";
import { validateFxRate, deriveThbAmount } from "@/lib/accounting/currency";
import {
  round2,
  summarizeEntry,
  type BillEntry,
  type BillEntryLine,
  type EntryType,
  type EntryStatus,
  type PaymentMethod,
} from "@/lib/accounting/queries";
import { AR, AP, EPSILON } from "@/lib/accounting/statement-config";
import type { JournalLine } from "@/lib/accounting/journal";
import type { JournalPosting, PostingLeg } from "@/lib/accounting/journal-books";

type DB = SupabaseClient;

/** วิธีรับ/จ่ายเงินจริง — ตัด 'credit' ออก (0.2: การชำระจริงไม่มีทาง "เชื่อ" ต่อการเชื่อได้อีก) */
export type BillPaymentMethod = "cash" | "cheque" | "transfer";

/** เพดานความยาว (กัน payload ใหญ่ผิดปกติ) */
export const NOTES_MAX = 500;

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function nonZero(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) >= EPSILON;
}

function numLocal(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** cast ค่าใด ๆ → BillPaymentMethod | null (ปฏิเสธ 'credit' และค่าอื่นที่ไม่รู้จักเสมอ) */
export function asBillPaymentMethod(v: unknown): BillPaymentMethod | null {
  return v === "cash" || v === "cheque" || v === "transfer" ? v : null;
}

// ---------------------------------------------------------------------
// 1 รายการรับ/จ่ายเงิน (โหลดจาก DB แล้ว)
// ---------------------------------------------------------------------

/** 1 รายการรับ/จ่ายเงิน (ต่อบิล 1 ใบ มีได้หลายรายการ — ทยอยรับ/จ่าย) */
export type BillPayment = {
  id: string;
  tenantId: string;
  entryId: string;
  /** สำเนาจาก bill_entries.customer_id ตอนบันทึก — ใช้แค่ "กรองเร็ว" ไม่ใช่แหล่งความจริงของสิทธิ์
   *  (recordBillPayment/voidBillPayment เช็คสโคปจริงผ่าน getBillPaymentScope เสมอ) */
  customerId: string | null;
  /** YYYY-MM-DD */
  payDate: string;
  amount: number;
  method: BillPaymentMethod;
  bankAccountId: string | null;
  /** รหัสผังบัญชีเงินฝากของ bankAccountId (join จาก customer_bank_accounts) — ใช้คำนวณบัญชีคู่ (0.4) */
  bankAccountCode: string | null;
  notes: string | null;
  createdAt: string;
  /**
   * เฟส 10 ส่วน AA — สกุลเงินต่างประเทศของงวดนี้ (สำเนาจากบิลต้นทางเสมอ ไม่รับจาก client) · null = งวด THB ปกติ
   */
  currency: string | null;
  /** เฟส 10 ส่วน AA — อัตราแลกเปลี่ยน "วันชำระ/settlement" ของงวดนี้ (คนละอัตรากับ bill_entries.fx_rate, 0.8) */
  fxRate: number | null;
  /** เฟส 10 ส่วน AA — จำนวนเงินตราต่างประเทศที่ได้รับ/จ่ายจริงงวดนี้ */
  fxAmount: number | null;
  /**
   * เฟส 10 ส่วน AA (0.14) — id ของ manual JE (draft) ที่ "แนะนำ" กำไร/ขาดทุนจากอัตราแลกเปลี่ยนของงวดนี้ไปแล้ว
   *   null = ยังไม่เคยแนะนำ (หรือ JV เดิมถูกลบไปแล้ว — เช็คสถานะจริงผ่าน getManualEntryScope ก่อนตัดสินใจ)
   */
  fxGainLossNoteId: string | null;
};

// ---------------------------------------------------------------------
// pure — ยอดเต็ม/ยอดค้างชำระ/สิทธิ์รับ-จ่ายเงิน (0.1/0.3)
// ---------------------------------------------------------------------

/** ข้อมูลบิลเท่าที่ฟังก์ชัน pure ในไฟล์นี้ต้องใช้ — BillEntry (จาก listEntries) ผ่านเข้าได้ตรง ๆ */
export type PaymentEntryInfo = {
  entryType: EntryType;
  paymentMethod: PaymentMethod | null;
  status: EntryStatus;
  lines: Pick<BillEntryLine, "amount" | "vatAmount" | "whtAmount">[];
  /** เฟส 10 ส่วน AA — สกุลเงินของบิลต้นทาง (optional, undefined/null = บิล THB ปกติ — backward-compat) */
  currency?: string | null;
  /** เฟส 10 ส่วน AA — อัตราแลกเปลี่ยน "ตอนออกบิล" (invoice rate, ใช้ derive `amount` ของงวดชำระ, 0.8) */
  fxRate?: number | null;
};

/** ยอดเต็มของบิล (มูลค่าที่ตั้ง AR/AP ไว้ตอนยืนยัน) = amount + vat − wht รวมทุกบรรทัด (0.3, reuse summarizeEntry) */
export function billNetTotal(entry: Pick<PaymentEntryInfo, "lines">): number {
  return summarizeEntry(entry.lines).net;
}

/**
 * ยอดค้างชำระ = ยอดเต็ม + netAdjustment − Σ(การรับ/จ่ายเงินที่ยังไม่ยกเลิกของบิลนั้น) (0.3, 0.6 เฟส 3)
 *   @param netAdjustment ผลรวมสัญญาณของ CN/DN ที่ "confirmed" แล้วของบิลนั้น (credit_note=ลบ, debit_note=บวก)
 *     default 0 = backward-compat ระดับ compile (พฤติกรรมเดิมเป๊ะเมื่อไม่มี CN/DN — credit-debit-notes.ts::
 *     netAdjustmentByEntry คำนวณค่านี้ให้)
 *   @param asOfDate เฟส 10b (0.5) — YYYY-MM-DD, optional · ไม่ส่ง = ไม่กรอง = พฤติกรรมเดิม 100%
 *     (backward-compat) · ส่งมา = ตัด payments ที่ payDate > asOfDate ออกก่อนคำนวณ (กัน payment วันที่ในอนาคต/
 *     รายงานตั้งวันที่ย้อนหลังไปหักยอดที่ยังไม่เกิดขึ้นจริง ณ วันนั้น) — เทียบ string 'YYYY-MM-DD' ด้วย `<=`
 *     ตรง ๆ ปลอดภัย (ISO lexicographic order, format คงที่เสมอจาก DATE_RE ที่ validate ไว้ทุกจุดที่เขียนลง DB)
 */
export function billOutstanding(
  entry: Pick<PaymentEntryInfo, "lines">,
  payments: Pick<BillPayment, "amount" | "payDate">[],
  netAdjustment = 0,
  asOfDate?: string
): number {
  const net = billNetTotal(entry);
  const eligible = asOfDate ? payments.filter((p) => p.payDate <= asOfDate) : payments;
  const paid = round2(eligible.reduce((s, p) => s + numLocal(p.amount), 0));
  return round2(net + numLocal(netAdjustment) - paid);
}

/** บิลนี้บันทึกรับ/จ่ายเงินแยกได้ไหม — เฉพาะซื้อ/ขาย + วิธีจ่าย 'credit' + ยืนยันแล้วเท่านั้น (0.1) */
export function isCreditEligibleForPayment(
  entry: Pick<PaymentEntryInfo, "entryType" | "paymentMethod" | "status">
): boolean {
  // ★ 2026-09-04 ผู้ใช้เจอ (หน้า aging ว่างทั้งที่แยกประเภทมีลูกหนี้ค้าง): บิลที่ "ยังไม่ระบุ
  //   วิธีชำระ" (null) สมุดรายวันถือเป็นเชื่อ (ตั้งลูกหนี้/เจ้าหนี้ — journal.ts ใช้ method ?? 'credit')
  //   → aging/รับจ่ายเงิน ต้องนับเป็นเชื่อเหมือนกัน ไม่งั้นลูกหนี้ในแยกประเภทกับรายงานค้างชำระไม่ตรงกัน
  return (
    (entry.entryType === "sale" || entry.entryType === "purchase") &&
    (entry.paymentMethod === "credit" || entry.paymentMethod == null) &&
    entry.status === "confirmed"
  );
}

// ---------------------------------------------------------------------
// validate (pure) — server ต้อง re-validate เสมอ ไม่เชื่อ client
// ---------------------------------------------------------------------

/** input ดิบ จาก client */
export type BillPaymentInput = {
  payDate: unknown;
  /** ยอด THB ต่องวด — มีความหมายเฉพาะบิล THB ปกติ (currency=null); บิล FX ไม่ใช้ค่านี้ (ดู fxAmount) */
  amount: unknown;
  method: unknown;
  bankAccountId?: unknown;
  notes?: unknown;
  /**
   * เฟส 10 ส่วน AA (0.8) — จำนวนเงินตราต่างประเทศที่ได้รับ/จ่ายจริงงวดนี้ — บังคับกรอกเมื่อบิลต้นทางเป็น FX
   *   (entry.currency ไม่ null) เท่านั้น · ไม่มีความหมายกับบิล THB ปกติ
   */
  fxAmount?: unknown;
  /**
   * เฟส 10 ส่วน AA (0.8) — อัตราแลกเปลี่ยน "วันชำระ/settlement" ของงวดนี้ — คนละอัตรากับ bill_entries.fx_rate
   *   (อัตราตอนออกบิล) บังคับกรอกเมื่อบิลต้นทางเป็น FX เท่านั้น
   */
  fxRate?: unknown;
};

export type ValidatedBillPayment = {
  payDate: string;
  amount: number;
  method: BillPaymentMethod;
  bankAccountId: string | null;
  notes: string | null;
  /** สำเนาจากบิลต้นทางเสมอ (ไม่รับจาก client) — null = งวด THB ปกติ */
  currency: string | null;
  /** อัตราวันชำระของงวดนี้ — null = งวด THB ปกติ */
  fxRate: number | null;
  /** จำนวนเงินตราต่างประเทศงวดนี้ — null = งวด THB ปกติ */
  fxAmount: number | null;
};

export type PaymentValidationResult =
  | { ok: true; value: ValidatedBillPayment }
  | { ok: false; message: string };

/**
 * validate + sanitize input การรับ/จ่ายเงิน — ปฏิเสธเสมอถ้า:
 *   - บิลไม่ eligible (ไม่ใช่ซื้อ/ขาย, ไม่ใช่ payment_method='credit', หรือยังไม่ confirmed) (0.1)
 *   - วิธีรับ/จ่ายเงินไม่ใช่ cash/cheque/transfer (โดยเฉพาะ 'credit' ต้องถูกปฏิเสธเสมอ ตาม 0.2)
 *   - วันที่รับ/จ่ายเงินผิดรูปแบบ / จำนวนเงินไม่มากกว่า 0
 *   - จำนวนเงินเกินยอดค้างชำระ (0.8 — คำนวณจาก existingPayments ที่ caller re-fetch จาก DB มาแล้ว)
 */
export function validatePaymentInput(
  input: BillPaymentInput,
  entry: PaymentEntryInfo,
  existingPayments: Pick<BillPayment, "amount" | "payDate">[],
  netAdjustment = 0
): PaymentValidationResult {
  if (!isCreditEligibleForPayment(entry)) {
    return { ok: false, message: "บันทึกรับ/จ่ายเงินแยกได้เฉพาะบิลเชื่อที่ยืนยันแล้วเท่านั้น" };
  }

  const method = asBillPaymentMethod(input.method);
  if (!method) {
    return { ok: false, message: "วิธีรับ/จ่ายเงินไม่ถูกต้อง (ต้องเป็นเงินสด/เช็ค/เงินโอน)" };
  }

  const payDate = typeof input.payDate === "string" && DATE_RE.test(input.payDate) ? input.payDate : "";
  if (!payDate) return { ok: false, message: "ต้องระบุวันที่รับ/จ่ายเงินให้ถูกรูปแบบ" };

  // ★ เฟส 10 ส่วน AA (0.8) — บิลต้นทาง FX (entry.currency ไม่ null): ยอดที่ตัด AR/AP ต้อง derive จาก
  //   fxAmount × entry.fxRate (อัตราตอนออกบิล — ไม่ใช่อัตรา settlement ของงวดนี้) — ไม่ใช้ input.amount ตรง ๆ
  const isFx = !!entry.currency;
  let amount: number;
  let fxAmount: number | null = null;
  let fxRateSettle: number | null = null;
  if (isFx) {
    const rawFxAmount = numLocal(input.fxAmount);
    if (!(rawFxAmount > 0)) {
      return { ok: false, message: "ต้องระบุจำนวนเงินตราต่างประเทศ (fxAmount) มากกว่า 0" };
    }
    const rateCheck = validateFxRate(input.fxRate);
    if (!rateCheck.ok) return { ok: false, message: rateCheck.message };
    fxAmount = round2(rawFxAmount);
    fxRateSettle = rateCheck.value;
    amount = deriveThbAmount(fxAmount, numLocal(entry.fxRate));
    if (!nonZero(amount)) return { ok: false, message: "ต้องระบุจำนวนเงินมากกว่า 0" };
  } else {
    const rawAmount = numLocal(input.amount);
    amount = rawAmount > 0 ? round2(rawAmount) : 0;
    if (!nonZero(amount)) return { ok: false, message: "ต้องระบุจำนวนเงินมากกว่า 0" };
  }

  // บัญชีเงินฝากใช้เฉพาะโอน (pattern เดียวกับ bill_entries.payment_bank_account_id)
  const bankAccountId =
    method === "transfer" && typeof input.bankAccountId === "string" && input.bankAccountId.trim()
      ? input.bankAccountId.trim()
      : null;
  const notes = clampText(input.notes, NOTES_MAX);

  const outstanding = billOutstanding(entry, existingPayments, netAdjustment);
  if (amount > outstanding + EPSILON) {
    return {
      ok: false,
      message: `จำนวนเงินเกินยอดค้างชำระ (คงค้าง ${outstanding.toFixed(2)} บาท)`,
    };
  }

  return {
    ok: true,
    value: {
      payDate,
      amount,
      method,
      bankAccountId,
      notes,
      currency: isFx ? entry.currency ?? null : null,
      fxRate: fxRateSettle,
      fxAmount,
    },
  };
}

// ---------------------------------------------------------------------
// pure mapper — ต่อเข้า engine บัญชี (0.4/0.5, reuse contraAccountFor เดิม — ไม่แก้ตรรกะ)
// ---------------------------------------------------------------------

/** ข้อมูลบิลเท่าที่ mapper ต้องใช้ — BillEntry ผ่านเข้าได้ตรง ๆ */
export type PaymentJournalEntry = Pick<
  BillEntry,
  "id" | "entryType" | "docNo" | "customerId" | "counterpartyName"
> & {
  /** ★ 2026-09-02 optional — ใช้ fallback คำอธิบายเมื่อบิลไม่มีชื่อคู่ค้า (caller ส่ง BillEntry เต็มอยู่แล้ว) */
  lines?: { description: string | null }[];
};

/** คำอธิบายบิล: ชื่อคู่ค้า → fallback คำอธิบายบรรทัดแรก (บิลไม่มีชื่อผู้โอน 2026-09-02) */
function entryDescOf(entry: PaymentJournalEntry): string | null {
  return (
    (entry.counterpartyName ?? "").trim() ||
    ((entry.lines ?? []).find((l) => (l.description ?? "").trim())?.description?.trim() ?? null)
  );
}

/** ข้อมูลการรับ/จ่ายเงินเท่าที่ mapper ต้องใช้ — BillPayment ผ่านเข้าได้ตรง ๆ */
export type PaymentJournalInput = Pick<BillPayment, "payDate" | "amount" | "method" | "bankAccountCode">;

/**
 * แปลงการรับ/จ่ายเงิน 1 รายการ → JournalLine[] (0.4/0.5) — 2 บรรทัดเสมอ สมดุลเสมอ:
 *   - บิลขาย (ลด AR): Dr บัญชีคู่ (จาก contraAccountFor) = amount · Cr 1140 (AR) = amount
 *   - บิลซื้อ (ลด AP): Dr 2010 (AP) = amount · Cr บัญชีคู่ (จาก contraAccountFor) = amount
 *   ★ caller ควรกรอง eligible (isCreditEligibleForPayment) ก่อนเรียกเสมอ — entryType อื่นนอกเหนือ
 *     sale/purchase จะคืน [] เฉย ๆ (defensive, ไม่ควรเกิดจาก flow จริง)
 */
export function toJournalLines(
  payment: PaymentJournalInput,
  entry: PaymentJournalEntry,
  chartByCode: ChartByCode
): JournalLine[] {
  if (entry.entryType !== "sale" && entry.entryType !== "purchase") return [];
  const amount = round2(payment.amount);
  if (!nonZero(amount)) return [];

  const contra = contraAccountFor(chartByCode, payment.method, entry.entryType, payment.bankAccountCode);
  if (!contra || !contra.code.trim()) return []; // defensive — cash/cheque/transfer + sale/purchase คำนวณได้เสมอ

  const arApCode = entry.entryType === "sale" ? AR : AP;
  const arApFallback = entry.entryType === "sale" ? "ลูกหนี้การค้า" : "เจ้าหนี้การค้า";
  const arApName = chartByCode[arApCode]?.name ?? arApFallback;

  const base = {
    entryId: entry.id,
    date: payment.payDate,
    docNo: entry.docNo,
    customerId: entry.customerId,
    counterparty: entryDescOf(entry),
  };

  if (entry.entryType === "sale") {
    return [
      { ...base, accountCode: contra.code, accountName: contra.name, debit: amount, credit: 0, side: "debit" as const },
      { ...base, accountCode: arApCode, accountName: arApName, debit: 0, credit: amount, side: "credit" as const },
    ];
  }
  return [
    { ...base, accountCode: arApCode, accountName: arApName, debit: amount, credit: 0, side: "debit" as const },
    { ...base, accountCode: contra.code, accountName: contra.name, debit: 0, credit: amount, side: "credit" as const },
  ];
}

/** ข้อมูลการรับ/จ่ายเงินเท่าที่ toJournalPosting ต้องใช้เพิ่ม (notes ใช้เป็นคำอธิบาย) */
export type PaymentJournalPostingInput = PaymentJournalInput & Pick<BillPayment, "notes">;

/**
 * แปลงการรับ/จ่ายเงิน 1 รายการ → JournalPosting (0.5) — book: บิลขาย → 'receipt' (เล่มรับเงิน),
 *   บิลซื้อ → 'payment' (เล่มจ่ายเงิน) — ผสมเข้าพารามิเตอร์ manualPostings เดิมของ buildJournalBooks()
 */
export function toJournalPosting(
  payment: PaymentJournalPostingInput,
  entry: PaymentJournalEntry,
  chartByCode: ChartByCode
): JournalPosting {
  const lines = toJournalLines(payment, entry, chartByCode);
  const debits: PostingLeg[] = lines
    .filter((l) => l.side === "debit")
    .map((l) => ({ accountCode: l.accountCode, accountName: l.accountName, amount: l.debit }));
  const credits: PostingLeg[] = lines
    .filter((l) => l.side === "credit")
    .map((l) => ({ accountCode: l.accountCode, accountName: l.accountName, amount: l.credit }));
  const totalDebit = round2(debits.reduce((s, d) => s + d.amount, 0));
  const totalCredit = round2(credits.reduce((s, c) => s + c.amount, 0));

  return {
    entryId: entry.id,
    date: payment.payDate,
    docNo: entry.docNo,
    description: (payment.notes && payment.notes.trim()) || entryDescOf(entry) || "",
    debits,
    credits,
    totalDebit,
    totalCredit,
    book: entry.entryType === "sale" ? "receipt" : "payment",
  };
}

// ---------------------------------------------------------------------
// data layer (DB) — ทุก query/write กรอง tenant_id เสมอ
// ---------------------------------------------------------------------

const LIST_LIMIT = 500;
const BULK_LIST_LIMIT = 5000;

/** สโคป + สิทธิ์ของบิลต้นทาง (mirror getManualEntryScope ของ manual-journal.ts) */
export type BillPaymentScope = {
  customerId: string | null;
  entryType: EntryType;
  paymentMethod: PaymentMethod | null;
  status: EntryStatus;
  docNo: string | null;
  /** เฟส 10 ส่วน AA — สกุลเงินของบิลต้นทาง (null = บิล THB ปกติ, best-effort ถ้า migration ยังไม่ apply) */
  currency: string | null;
  /** เฟส 10 ส่วน AA — อัตราแลกเปลี่ยน "ตอนออกบิล" (null = บิล THB ปกติ) */
  fxRate: number | null;
};

type RawScope = {
  customer_id: string | null;
  entry_type: string;
  payment_method: string | null;
  status: string;
  doc_no?: string | null;
  currency?: string | null;
  fx_rate?: number | string | null;
};

/** โหลดสโคป + สิทธิ์รับ-จ่ายเงินของบิล 1 ใบ (scope tenant) — ใช้ตรวจก่อนบันทึก/ยกเลิกทุกครั้ง
 *   ★ เฟส 10: เพิ่ม currency/fx_rate เข้า select เดียวกัน (best-effort — ถ้า migration 0085 ยังไม่ apply
 *   select ทั้งคำสั่งจะ error → คืน null ทั้งฟังก์ชัน เหมือนไม่พบบิล — ยอมรับความเสี่ยงนี้เพราะ 3 คอลัมน์เดิม
 *   ก็อยู่ในคำสั่งเดียวกันมาตั้งแต่ต้นอยู่แล้ว ไม่ใช่จุดใหม่ที่เพิ่มความเสี่ยง degrade) */
export async function getBillPaymentScope(
  db: DB,
  tenantId: string,
  entryId: string
): Promise<BillPaymentScope | null> {
  const { data } = await db
    .from("bill_entries")
    .select("customer_id, entry_type, payment_method, status, doc_no, currency, fx_rate")
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as RawScope;
  return {
    customerId: r.customer_id,
    entryType: r.entry_type === "sale" ? "sale" : r.entry_type === "purchase" ? "purchase" : "unspecified",
    paymentMethod: asPaymentMethod(r.payment_method),
    status: r.status === "confirmed" ? "confirmed" : "draft",
    docNo: r.doc_no ?? null,
    currency: r.currency ?? null,
    fxRate: r.fx_rate === null || r.fx_rate === undefined ? null : numLocal(r.fx_rate),
  };
}

type RawLineAmount = {
  amount: number | string | null;
  vat_amount: number | string | null;
  wht_amount: number | string | null;
};

/** โหลด amount/vat/wht ต่อบรรทัดของบิล (ใช้คำนวณยอดเต็มผ่าน billNetTotal — ไม่ query full BillEntry ทั้งก้อน) */
async function loadEntryLineAmounts(
  db: DB,
  tenantId: string,
  entryId: string
): Promise<Pick<BillEntryLine, "amount" | "vatAmount" | "whtAmount">[]> {
  const { data } = await db
    .from("bill_entry_lines")
    .select("amount, vat_amount, wht_amount")
    .eq("tenant_id", tenantId)
    .eq("entry_id", entryId);
  return ((data ?? []) as RawLineAmount[]).map((r) => ({
    amount: numLocal(r.amount),
    vatAmount: numLocal(r.vat_amount),
    whtAmount: numLocal(r.wht_amount),
  }));
}

type RawPayment = {
  id: string;
  tenant_id: string;
  entry_id: string;
  customer_id: string | null;
  pay_date: string;
  amount: number | string;
  method: string;
  bank_account_id: string | null;
  notes: string | null;
  created_at: string;
  currency?: string | null;
  fx_rate?: number | string | null;
  fx_amount?: number | string | null;
  fx_gain_loss_note_id?: string | null;
};

/** join รหัสผังบัญชีเงินฝาก (customer_bank_accounts.account_code) ของชุด bank_account_id ที่ต้องใช้ */
async function resolveBankAccountCodes(
  db: DB,
  tenantId: string,
  bankAccountIds: string[]
): Promise<Map<string, string | null>> {
  const codeByBankAccount = new Map<string, string | null>();
  if (bankAccountIds.length === 0) return codeByBankAccount;
  const { data } = await db
    .from("customer_bank_accounts")
    .select("id, account_code")
    .eq("tenant_id", tenantId)
    .in("id", bankAccountIds);
  for (const b of (data ?? []) as { id: string; account_code: string | null }[]) {
    codeByBankAccount.set(b.id, b.account_code);
  }
  return codeByBankAccount;
}

function mapPayment(r: RawPayment, codeByBankAccount: Map<string, string | null>): BillPayment {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    entryId: r.entry_id,
    customerId: r.customer_id,
    payDate: r.pay_date,
    amount: numLocal(r.amount),
    // DB check constraint กันค่าอื่นอยู่แล้ว (method in cash/cheque/transfer) — fallback 'cash' กันพลาดเงียบ ๆ
    method: asBillPaymentMethod(r.method) ?? "cash",
    bankAccountId: r.bank_account_id,
    bankAccountCode: r.bank_account_id ? codeByBankAccount.get(r.bank_account_id) ?? null : null,
    notes: r.notes,
    createdAt: r.created_at,
    currency: r.currency ?? null,
    fxRate: r.fx_rate === null || r.fx_rate === undefined ? null : numLocal(r.fx_rate),
    fxAmount: r.fx_amount === null || r.fx_amount === undefined ? null : numLocal(r.fx_amount),
    fxGainLossNoteId: r.fx_gain_loss_note_id ?? null,
  };
}

const PAYMENT_COLUMNS =
  "id, tenant_id, entry_id, customer_id, pay_date, amount, method, bank_account_id, notes, created_at, currency, fx_rate, fx_amount, fx_gain_loss_note_id";

/**
 * ประวัติการรับ/จ่ายเงินของบิล 1 ใบ (ไม่รวมรายการที่ยกเลิกแล้ว) เรียงวันที่เก่า→ใหม่
 *   @param asOfDate เฟส 10b (0.5) — YYYY-MM-DD, optional · ไม่ส่ง = query เดิมทุกประการ (regression-safe) ·
 *     ส่งมา = `.lte("pay_date", asOfDate)` กรองที่ query จริง (ลดปริมาณข้อมูลด้วย ไม่ใช่กรองหลัง fetch)
 */
export async function listBillPayments(
  db: DB,
  tenantId: string,
  entryId: string,
  asOfDate?: string
): Promise<BillPayment[]> {
  let q = db
    .from("bill_payments")
    .select(PAYMENT_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("entry_id", entryId)
    .is("deleted_at", null);
  if (asOfDate) q = q.lte("pay_date", asOfDate);
  const { data } = await q
    .order("pay_date", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(LIST_LIMIT);
  const rows = (data ?? []) as unknown as RawPayment[];
  if (rows.length === 0) return [];
  const bankIds = [...new Set(rows.map((r) => r.bank_account_id).filter((x): x is string => !!x))];
  const codeByBankAccount = await resolveBankAccountCodes(db, tenantId, bankIds);
  return rows.map((r) => mapPayment(r, codeByBankAccount));
}

/**
 * ประวัติการรับ/จ่ายเงินของหลายบิลพร้อมกัน (ใช้กับหน้ารายการ/รายงานอายุหนี้) → Map<entryId, BillPayment[]>
 *   @param asOfDate เฟส 10b (0.5) — เหมือน listBillPayments ข้างบน (optional, ไม่ส่ง = พฤติกรรมเดิม 100%)
 */
export async function listBillPaymentsForEntries(
  db: DB,
  tenantId: string,
  entryIds: string[],
  asOfDate?: string
): Promise<Map<string, BillPayment[]>> {
  const result = new Map<string, BillPayment[]>();
  if (entryIds.length === 0) return result;
  // ★ ตัดก้อน (chunkIds) กัน .in("entry_id", entryIds) ยาวเกิน limit ของ PostgREST เมื่อ tenant มีบิล
  //   สะสมมาก (พบจริงใน listEntries() — ดู commit 7ab9f91 และ lib/accounting/id-chunk.ts)
  const chunks = await Promise.all(
    chunkIds(entryIds).map((ids) => {
      let q = db
        .from("bill_payments")
        .select(PAYMENT_COLUMNS)
        .eq("tenant_id", tenantId)
        .in("entry_id", ids)
        .is("deleted_at", null);
      if (asOfDate) q = q.lte("pay_date", asOfDate);
      return q.order("pay_date", { ascending: true }).order("created_at", { ascending: true }).limit(BULK_LIST_LIMIT);
    })
  );
  const rows = chunks.flatMap(({ data }) => (data ?? []) as unknown as RawPayment[]);
  if (rows.length === 0) return result;
  const bankIds = [...new Set(rows.map((r) => r.bank_account_id).filter((x): x is string => !!x))];
  const codeByBankAccount = await resolveBankAccountCodes(db, tenantId, bankIds);
  for (const r of rows) {
    const p = mapPayment(r, codeByBankAccount);
    const arr = result.get(p.entryId) ?? [];
    arr.push(p);
    result.set(p.entryId, arr);
  }
  return result;
}

/**
 * เซตของ entryId ที่มี bill_payments ที่ยังไม่ถูกยกเลิกผูกอยู่ ≥1 แถว (เฟส 10, 0.9) — ใช้ที่ UI
 *   (EntryEditor.tsx) โชว์ badge ล็อกฟิลด์ currency/fx_rate โดยไม่ต้อง query ต่อบิลทีละใบ
 *   ★ นี่เป็นแค่ hint ของ UI เท่านั้น — guard ที่บังคับจริงอยู่ที่ actions-lib.ts::upsertEntry (0.9)
 */
export async function hasActiveBillPaymentsForEntries(
  db: DB,
  tenantId: string,
  entryIds: string[]
): Promise<Set<string>> {
  const result = new Set<string>();
  if (entryIds.length === 0) return result;
  const chunks = await Promise.all(
    chunkIds(entryIds).map((ids) =>
      db.from("bill_payments").select("entry_id").eq("tenant_id", tenantId).in("entry_id", ids).is("deleted_at", null)
    )
  );
  for (const { data } of chunks) {
    for (const r of (data ?? []) as { entry_id: string }[]) result.add(r.entry_id);
  }
  return result;
}

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline */
export type PaymentActionResult = { ok: true; id: string } | { ok: false; message: string };

/**
 * บันทึกรับ/จ่ายเงิน 1 รายการ — validate ซ้ำฝั่ง server เสมอ (ไม่เชื่อ client)
 *   ★ re-fetch สโคป + ยอดค้างชำระล่าสุดจาก DB ก่อน insert ทุกครั้ง (0.8 — กัน overpay จากข้อมูลเก่าฝั่ง client)
 *   ★ เฟส 3 ส่วน J (0.6): re-fetch CN/DN "confirmed" ของบิลนี้จาก DB ก่อนคำนวณยอดค้างชำระทุกครั้งด้วย
 *     (netAdjustment) — import แบบ dynamic กัน circular import กับ credit-debit-notes.ts (ไฟล์นั้น import
 *     isCreditEligibleForPayment/getBillPaymentScope จากไฟล์นี้อยู่แล้ว)
 */
export async function recordBillPayment(
  db: DB,
  tenantId: string,
  entryId: string,
  input: BillPaymentInput
): Promise<PaymentActionResult> {
  const scope = await getBillPaymentScope(db, tenantId, entryId);
  if (!scope) return { ok: false, message: "ไม่พบบิล (อาจถูกลบไปแล้ว)" };

  const lines = await loadEntryLineAmounts(db, tenantId, entryId);
  const existingPayments = await listBillPayments(db, tenantId, entryId);

  const { listNotes, netAdjustmentByEntry } = await import("@/lib/accounting/credit-debit-notes");
  const notes = await listNotes(db, tenantId, entryId);
  const netAdjustment = netAdjustmentByEntry(new Map([[entryId, notes]])).get(entryId) ?? 0;

  const v = validatePaymentInput(
    input,
    {
      entryType: scope.entryType,
      paymentMethod: scope.paymentMethod,
      status: scope.status,
      lines,
      currency: scope.currency,
      fxRate: scope.fxRate,
    },
    existingPayments,
    netAdjustment
  );
  if (!v.ok) return { ok: false, message: v.message };

  const { data, error } = await db
    .from("bill_payments")
    .insert({
      tenant_id: tenantId,
      entry_id: entryId,
      customer_id: scope.customerId,
      pay_date: v.value.payDate,
      amount: v.value.amount,
      method: v.value.method,
      bank_account_id: v.value.bankAccountId,
      notes: v.value.notes,
      currency: v.value.currency,
      fx_rate: v.value.fxRate,
      fx_amount: v.value.fxAmount,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: (data as { id: string }).id };
}

/** สโคปของการรับ/จ่ายเงิน 1 รายการ derive จาก id ของ payment โดยตรง — customerId อ่านสดผ่านบิลต้นทางเสมอ */
export type PaymentScope = { customerId: string | null; entryId: string };

/**
 * โหลดสโคปของการรับ/จ่ายเงิน 1 รายการ จาก id ของ payment นั้นเอง (ไม่รับ entryId คู่แยกจาก client) —
 * คืน null ถ้าไม่พบ/ถูกยกเลิกไปแล้ว/บิลต้นทางหาไม่เจอ
 *   ★ กัน IDOR: resource ที่กำลังจะเขียนจริงคือ `id` (payment) — สโคปต้อง derive จาก `id` นั้นตรง ๆ
 *     เท่านั้น ไม่ใช่จาก entryId ที่ client ส่งมาแยกต่างหาก (entryId นั้นอาจไม่ตรงกับ payment ตัวจริง
 *     ที่ id ระบุ) — mirror getNoteScope ของ credit-debit-notes.ts (เฟส 3 ส่วน J)
 *   ★ ต้องเรียกฟังก์ชันนี้ก่อนยกเลิก (void) ทุกครั้งที่มี id ของ payment อยู่แล้ว
 */
export async function getPaymentScope(db: DB, tenantId: string, id: string): Promise<PaymentScope | null> {
  const { data } = await db
    .from("bill_payments")
    .select("entry_id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const entryId = (data as { entry_id: string }).entry_id;
  const entryScope = await getBillPaymentScope(db, tenantId, entryId);
  if (!entryScope) return null;
  return { customerId: entryScope.customerId, entryId };
}

/**
 * โหลดแถวเต็มของการรับ/จ่ายเงิน 1 รายการ จาก id ตรง ๆ (scope tenant) — ใช้ตอน "แนะนำ" กำไร/ขาดทุนจากอัตรา
 *   แลกเปลี่ยน (เฟส 10 ส่วน AA, T91) ที่ต้องอ่าน fxAmount/fxRate/fxGainLossNoteId ของงวดนั้นเต็มรูป
 *   (ต่างจาก getPaymentScope ที่คืนแค่ scope บาง ๆ สำหรับ guard)
 */
export async function getBillPaymentById(db: DB, tenantId: string, id: string): Promise<BillPayment | null> {
  const { data } = await db
    .from("bill_payments")
    .select(PAYMENT_COLUMNS)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as RawPayment;
  const codeByBankAccount = row.bank_account_id
    ? await resolveBankAccountCodes(db, tenantId, [row.bank_account_id])
    : new Map<string, string | null>();
  return mapPayment(row, codeByBankAccount);
}

/**
 * ผูก JV (draft) ที่ "แนะนำ" กำไร/ขาดทุนจากอัตราแลกเปลี่ยนกลับเข้างวดชำระนี้ (เฟส 10 ส่วน AA, 0.14) —
 *   atomic check-and-write (`.is("fx_gain_loss_note_id", null)` ในคำสั่ง UPDATE จริง) กันแข่งกันกดปุ่ม
 *   "แนะนำ" ซ้ำ/สองแท็บพร้อมกัน (mirror `updateDraftNote` ของ credit-debit-notes.ts เฟส 3 ที่กัน TOCTOU
 *   แบบเดียวกัน) — คืน `true` เมื่อผูกสำเร็จ (แถวยังไม่เคยผูกมาก่อน) · `false` เมื่อมีคนผูกไปแล้วก่อนหน้า
 */
export async function claimFxGainLossNote(
  db: DB,
  tenantId: string,
  paymentId: string,
  noteId: string
): Promise<boolean> {
  const { data, error } = await db
    .from("bill_payments")
    .update({ fx_gain_loss_note_id: noteId })
    .eq("id", paymentId)
    .eq("tenant_id", tenantId)
    .is("fx_gain_loss_note_id", null)
    .select("id")
    .maybeSingle();
  return !error && !!data;
}

/**
 * รีเซ็ต fx_gain_loss_note_id กลับเป็น null (เฟส 10 ส่วน AA) — ใช้เมื่อพบว่า JV ที่เคยแนะนำไว้ถูกลบไปแล้ว
 *   (นักบัญชีลบ JV ที่แนะนำทิ้ง) เพื่อให้ปุ่ม "แนะนำ" ของงวดนั้นกลับมาใช้ได้ใหม่ (mirror ความเสี่ยงในหมวด 5
 *   ของแผนเฟส 10)
 */
export async function resetFxGainLossNote(db: DB, tenantId: string, paymentId: string): Promise<void> {
  await db
    .from("bill_payments")
    .update({ fx_gain_loss_note_id: null })
    .eq("id", paymentId)
    .eq("tenant_id", tenantId);
}

/** ยกเลิกการรับ/จ่ายเงิน (soft-delete) — ยอดค้างชำระของบิลจะกลับมาเหมือนไม่เคยมีรายการนี้ (0.2) */
export async function voidBillPayment(db: DB, tenantId: string, id: string): Promise<PaymentActionResult> {
  const { data } = await db
    .from("bill_payments")
    .select("id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return { ok: false, message: "ไม่พบรายการ (อาจถูกยกเลิกไปแล้ว)" };

  const { error } = await db
    .from("bill_payments")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ยกเลิกไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}
