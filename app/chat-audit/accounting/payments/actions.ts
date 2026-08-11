"use server";

/**
 * Server actions ของหน้า "รับ/จ่ายเงินแยกจากบิล" (/chat-audit/accounting/payments) — เฟส 2 ส่วน F
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ journal-entry/actions.ts เฟส 1 ส่วน C):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess + tenantId จาก session (ไม่เชื่อ client)
 *   2) โหลดสโคปจริงจาก DB แล้ว assertCustomerInScope ทุกครั้งก่อนอ่าน/เขียน — ★ ต้อง derive สโคปจาก
 *      "resource ที่กำลังจะเขียนจริง" เท่านั้น (paymentId เมื่อมี payment อยู่แล้ว — ผ่าน getPaymentScope,
 *      หรือ entryId ของบิลต้นทางเมื่อยังไม่มี payment — ผ่าน getBillPaymentScope) ★ ห้ามรับ entryId
 *      คู่แยกจาก client มาตรวจสโคปแทน paymentId ที่จะเขียน (เคยเป็นช่องโหว่ IDOR)
 *   3) validate ซ้ำฝั่ง server เสมอ (lib/accounting/bill-payments.ts::validatePaymentInput —
 *      ปฏิเสธ overpay/method ผิด/บิลไม่ eligible ทุกครั้ง re-fetch ยอดค้างจาก DB — ไม่เชื่อ client)
 *   4) revalidatePath('/chat-audit/accounting/payments')
 *
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า (ไม่มี console.* ที่นี่)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import {
  recordBillPayment,
  voidBillPayment,
  getBillPaymentScope,
  getPaymentScope,
  getBillPaymentById,
  claimFxGainLossNote,
  resetFxGainLossNote,
  type BillPaymentInput,
} from "@/lib/accounting/bill-payments";
import { getManualEntryScope, upsertManualEntry } from "@/lib/accounting/manual-journal";
import { suggestFxGainLossEntryInput } from "@/lib/accounting/fx";
import { DEFAULT_FX_GAIN_LOSS_ACCOUNT_CODE } from "@/lib/accounting/currency";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { assertReversalConfirmedForPayment } from "@/lib/accounting/fx-revaluation";

const PATH = "/chat-audit/accounting/payments";
const JOURNAL_PATH = "/chat-audit/accounting/journal-entry";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type PaymentSaveResult = { ok: boolean; message: string; id?: string };

export type RecordBillPaymentActionInput = {
  entryId: string;
  payDate: unknown;
  amount: unknown;
  method: unknown;
  bankAccountId?: unknown;
  notes?: unknown;
  /** เฟส 10 ส่วน AA — จำนวนเงินตราต่างประเทศงวดนี้ (มีความหมายเฉพาะบิล FX) */
  fxAmount?: unknown;
  /** เฟส 10 ส่วน AA — อัตราแลกเปลี่ยนวันชำระของงวดนี้ (มีความหมายเฉพาะบิล FX) */
  fxRate?: unknown;
};

/** บันทึกรับ/จ่ายเงิน 1 รายการ ต่อบิลเชื่อที่ยืนยันแล้ว — ปฏิเสธ overpay/บิลไม่ eligible เสมอ (server-side) */
export async function recordBillPaymentAction(
  input: RecordBillPaymentActionInput
): Promise<PaymentSaveResult> {
  if (!isUuid(input.entryId)) return { ok: false, message: "ไม่พบบิลที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const scope = await getBillPaymentScope(service, ctx.tenantId, input.entryId);
    if (!scope) return { ok: false, message: "ไม่พบบิล (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    const paymentInput: BillPaymentInput = {
      payDate: input.payDate,
      amount: input.amount,
      method: input.method,
      bankAccountId: input.bankAccountId,
      notes: input.notes,
      fxAmount: input.fxAmount,
      fxRate: input.fxRate,
    };
    const res = await recordBillPayment(service, ctx.tenantId, input.entryId, paymentInput);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "บันทึกแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * ยกเลิกการรับ/จ่ายเงิน (soft-delete) — ยอดค้างชำระของบิลกลับมาเหมือนไม่เคยมีรายการนี้
 *   ★ ตรวจสโคปผ่าน getPaymentScope(paymentId) เท่านั้น (derive จาก payment ที่กำลังจะเขียนจริงตรง ๆ) —
 *     ไม่รับ entryId คู่แยกจาก client เหมือนเดิม (เคยเป็นช่องโหว่ IDOR: entryId ที่ผ่านสโคปอาจเป็น
 *     ของบิลอื่น ไม่ตรงกับ payment ตัวจริงที่ paymentId ระบุ)
 */
export async function voidBillPaymentAction(paymentId: string): Promise<PaymentSaveResult> {
  if (!isUuid(paymentId)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const scope = await getPaymentScope(service, ctx.tenantId, paymentId);
    if (!scope) return { ok: false, message: "ไม่พบรายการ (อาจถูกยกเลิกไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    const res = await voidBillPayment(service, ctx.tenantId, paymentId);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "ยกเลิกรายการแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยกเลิกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * "แนะนำ" กำไร/ขาดทุนจากอัตราแลกเปลี่ยนที่รับรู้แล้วของงวดชำระ 1 งวด (เฟส 10 ส่วน AA, 0.5/0.8/0.14)
 *   ★ Never-auto-confirm (0.5): สร้างได้แค่ manual JE แบบ **draft** เท่านั้น ผ่าน `upsertManualEntry`
 *     เดิม — นักบัญชีต้องเข้าไปตรวจ/แก้/กด "ยืนยัน" เองที่หน้า journal-entry เดิมเสมอ
 *   ★ IDOR-safe: ตรวจสโคปผ่าน getPaymentScope(paymentId) เท่านั้น (derive จาก payment ที่กำลังจะอ่าน/เขียนจริง)
 *   ★ dedupe (0.14): ปฏิเสธถ้างวดนี้เคยแนะนำไปแล้ว (fx_gain_loss_note_id ชี้ JV ที่ยังไม่ถูกลบ) — ถ้า JV
 *     เดิมถูกลบไปแล้ว reset แล้วให้แนะนำใหม่ได้
 */
export async function suggestFxGainLossNoteAction(
  paymentId: string,
  gainLossAccountCode?: string
): Promise<PaymentSaveResult> {
  if (!isUuid(paymentId)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const scope = await getPaymentScope(service, ctx.tenantId, paymentId);
    if (!scope) return { ok: false, message: "ไม่พบรายการ (อาจถูกยกเลิกไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (!scope.customerId) return { ok: false, message: "ไม่พบลูกค้าของบิลนี้" };

    const payment = await getBillPaymentById(service, ctx.tenantId, paymentId);
    if (!payment) return { ok: false, message: "ไม่พบรายการ (อาจถูกยกเลิกไปแล้ว)" };
    if (!payment.currency || payment.fxRate == null || payment.fxAmount == null) {
      return { ok: false, message: "งวดนี้ไม่ใช่การรับ/จ่ายเงินสกุลต่างประเทศ — ไม่มีอะไรให้แนะนำ" };
    }

    // dedupe (0.14) — เคยแนะนำไปแล้วและ JV เป้าหมายยังไม่ถูกลบ → ปฏิเสธ (ให้ไปดู/ยืนยัน JV เดิมแทน)
    if (payment.fxGainLossNoteId) {
      const targetScope = await getManualEntryScope(service, ctx.tenantId, payment.fxGainLossNoteId);
      if (targetScope) {
        return { ok: false, message: "งวดนี้แนะนำกำไร/ขาดทุนจากอัตราแลกเปลี่ยนไปแล้ว", id: payment.fxGainLossNoteId };
      }
      // JV เดิมถูกลบไปแล้ว (นักบัญชีลบทิ้ง) → reset แล้วให้แนะนำใหม่ได้ต่อด้านล่าง
      await resetFxGainLossNote(service, ctx.tenantId, paymentId);
    }

    const entryScope = await getBillPaymentScope(service, ctx.tenantId, payment.entryId);
    if (!entryScope || (entryScope.entryType !== "sale" && entryScope.entryType !== "purchase")) {
      return { ok: false, message: "ไม่พบบิลต้นทาง (อาจถูกลบไปแล้ว)" };
    }
    if (entryScope.fxRate == null) {
      return { ok: false, message: "ไม่พบอัตราแลกเปลี่ยนตอนออกบิลของบิลต้นทาง" };
    }

    // ⚠️ เฟส 10b (0.11) — hard-block guard #2: ห้าม "แนะนำ realized FX" ถ้า reversing ของงวดที่เกี่ยวข้อง
    //   ยังไม่ confirm (สูตร realized เดิมสมมติว่า AR/AP ถูก reverse กลับไปที่ invoice rate แล้ว — ถ้ายังไม่
    //   reverse จริง จะเกิด double-count FX gain/loss ที่ตรวจจับยากมากภายหลัง ดูหมวด 5 ของแผนเฟส 10b)
    const guard2 = await assertReversalConfirmedForPayment(
      service,
      ctx.tenantId,
      scope.customerId,
      payment.currency,
      entryScope.entryType,
      payment.payDate
    );
    if (!guard2.ok) return { ok: false, message: guard2.message };

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);
    const accountCode =
      typeof gainLossAccountCode === "string" && gainLossAccountCode.trim()
        ? gainLossAccountCode.trim()
        : DEFAULT_FX_GAIN_LOSS_ACCOUNT_CODE;

    const suggestion = suggestFxGainLossEntryInput(
      {
        payDate: payment.payDate,
        fxAmount: payment.fxAmount,
        fxRate: payment.fxRate,
        currency: payment.currency,
        docNo: entryScope.docNo,
        // ★ QC เฟส 10 (fix): บัญชีคู่ของ JV แนะนำต้องเป็นเงินสด/ธนาคารจริงของงวดนี้ (ไม่ใช่ AR/AP) — derive จาก
        //   วิธีรับ/จ่ายเงิน + บัญชีเงินฝากจริงของงวดนี้ (เดียวกับที่ toJournalLines ใช้ตัดบัญชีคู่ตอนบันทึกงวดนี้)
        method: payment.method,
        bankAccountCode: payment.bankAccountCode,
      },
      { entryType: entryScope.entryType, fxRate: entryScope.fxRate },
      accountCode,
      chartByCode
    );
    if (!suggestion) {
      return { ok: false, message: "อัตราวันชำระเท่ากับอัตราตอนออกบิลพอดี — ไม่มีผลต่างจากอัตราแลกเปลี่ยน" };
    }

    const created = await upsertManualEntry(service, ctx.tenantId, scope.customerId, suggestion, chartByCode);
    if (!created.ok) return { ok: false, message: created.message };

    const claimed = await claimFxGainLossNote(service, ctx.tenantId, paymentId, created.id);
    if (!claimed) {
      // แข่งกันกดปุ่มพร้อมกัน (race, ยอมรับความเสี่ยงนี้เหมือน posture เดิมทั้งระบบ — ดูหมวด 5 ของแผนเฟส 10)
      return { ok: false, message: "มีการแนะนำรายการนี้ไปพร้อมกันแล้ว กรุณารีเฟรชหน้าจอ" };
    }

    revalidatePath(PATH);
    revalidatePath(JOURNAL_PATH);
    return { ok: true, message: "สร้างรายการแนะนำ (ร่าง) แล้ว — ไปตรวจ/ยืนยันที่หน้าลงบัญชีเอง", id: created.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ทำรายการไม่สำเร็จ กรุณาลองใหม่" };
  }
}
