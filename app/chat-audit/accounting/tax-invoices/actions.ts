"use server";

/**
 * Server actions ของหน้า "ใบกำกับภาษี" (/chat-audit/accounting/tax-invoices)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ sales-documents/actions.ts):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess + tenantId จาก session (ไม่เชื่อ client)
 *   2) issueTaxInvoiceAction: assertCustomerInScope(customerId ที่ client ส่งมา) ก่อนออกเอกสาร
 *      voidTaxInvoiceAction: โหลดสโคปจริงผ่าน getTaxInvoiceScope(id) จาก DB แล้ว assertCustomerInScope
 *      ทุกครั้งก่อนเขียน (กัน client ปลอม id ข้ามลูกค้า/ข้าม tenant)
 *   3) validate ซ้ำฝั่ง server เสมอ (lib/accounting/tax-invoice.ts::validateIssueInput)
 *   4) revalidatePath('/chat-audit/accounting/tax-invoices')
 *
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อลูกค้า/คู่ค้า (ไม่มี console.* ที่นี่)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import {
  issueTaxInvoice,
  voidTaxInvoice,
  getTaxInvoiceScope,
  type TaxInvoiceIssueInput,
} from "@/lib/accounting/tax-invoice";

const PATH = "/chat-audit/accounting/tax-invoices";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type TaxInvoiceSaveResult = { ok: boolean; message: string; id?: string };
export type TaxInvoiceIssueResult = { ok: boolean; message: string; docNo?: string; id?: string };

export type IssueTaxInvoiceActionInput = {
  customerId: string;
  billEntryId: string;
  formType: unknown;
  docDate: unknown;
  buyerName?: unknown;
  buyerTaxId?: unknown;
  buyerAddress?: unknown;
  buyerBranch?: unknown;
  sellerBranch?: unknown;
};

/** ออกใบกำกับภาษีจากบิลขายที่ยืนยันแล้ว 1 ใบ — ปฏิเสธถ้าลูกค้านอกสโคป/บิลไม่ผ่านเงื่อนไข/input ไม่ผ่าน validate */
export async function issueTaxInvoiceAction(input: IssueTaxInvoiceActionInput): Promise<TaxInvoiceIssueResult> {
  if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
  if (!isUuid(input.billEntryId)) return { ok: false, message: "ไม่พบบิลที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, input.customerId);

    const issueInput: TaxInvoiceIssueInput = {
      formType: input.formType,
      docDate: input.docDate,
      buyerName: input.buyerName,
      buyerTaxId: input.buyerTaxId,
      buyerAddress: input.buyerAddress,
      buyerBranch: input.buyerBranch,
      sellerBranch: input.sellerBranch,
    };
    const res = await issueTaxInvoice(service, ctx.tenantId, input.customerId, input.billEntryId, issueInput);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: `ออกใบกำกับภาษีเลขที่ ${res.docNo} แล้ว`, docNo: res.docNo, id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ออกใบกำกับภาษีไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ยกเลิกใบกำกับภาษี (เฉพาะจาก status='issued') — ★ derive scope จาก id ที่กำลังเขียนจริงเสมอ (0.13) */
export async function voidTaxInvoiceAction(id: string, reason?: unknown): Promise<TaxInvoiceSaveResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบใบกำกับภาษี" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const scope = await getTaxInvoiceScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบใบกำกับภาษี (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    const res = await voidTaxInvoice(service, ctx.tenantId, id, reason);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ยกเลิกใบกำกับภาษีแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยกเลิกไม่สำเร็จ กรุณาลองใหม่" };
  }
}
