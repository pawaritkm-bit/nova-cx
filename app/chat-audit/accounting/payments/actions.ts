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
  type BillPaymentInput,
} from "@/lib/accounting/bill-payments";

const PATH = "/chat-audit/accounting/payments";

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
