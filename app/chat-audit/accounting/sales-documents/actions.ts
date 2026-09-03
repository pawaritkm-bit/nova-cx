"use server";

/**
 * Server actions ของหน้า "ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล" (/chat-audit/accounting/sales-documents) — เฟส 3 ส่วน K
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ credit-debit-notes/actions.ts เฟส 3 ส่วน J):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess + tenantId จาก session (ไม่เชื่อ client)
 *   2) createDraftAction: assertCustomerInScope(customerId ที่ client ส่งมา) ก่อนสร้าง
 *      update/delete/issue/void: โหลดสโคปจริงผ่าน getDocumentScope(id) จาก DB แล้ว assertCustomerInScope
 *      ทุกครั้งก่อนอ่าน/เขียน (กัน client ปลอม id ข้ามลูกค้า/ข้าม tenant)
 *   3) validate ซ้ำฝั่ง server เสมอ (lib/accounting/sales-documents.ts::validateDocumentInput —
 *      ปฏิเสธ document_type ผิด/lines ว่าง/amount ไม่ถูกต้องทุกครั้ง)
 *   4) revalidatePath('/chat-audit/accounting/sales-documents')
 *
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อลูกค้า/คู่ค้า (ไม่มี console.* ที่นี่)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import {
  createDraftDocument,
  updateDraftDocument,
  softDeleteDraft,
  softDeleteDocument,
  issueDocument,
  voidDocument,
  getDocumentScope,
  type SalesDocumentInput,
} from "@/lib/accounting/sales-documents";

const PATH = "/chat-audit/accounting/sales-documents";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type SalesDocSaveResult = { ok: boolean; message: string; id?: string };
export type SalesDocIssueResult = { ok: boolean; message: string; docNo?: string };

export type UpsertSalesDocLineActionInput = {
  description?: unknown;
  productId?: unknown;
  sourceBillEntryId?: unknown;
  quantity?: unknown;
  unit?: unknown;
  unitPrice?: unknown;
  amount: unknown;
  vatAmount?: unknown;
};

export type UpsertSalesDocActionInput = {
  documentType: unknown;
  docDate: unknown;
  validUntil?: unknown;
  counterpartyName?: unknown;
  counterpartyTaxId?: unknown;
  counterpartyAddress?: unknown;
  notes?: unknown;
  lines: UpsertSalesDocLineActionInput[];
};

function toDocInput(input: UpsertSalesDocActionInput): SalesDocumentInput {
  return {
    documentType: input.documentType,
    docDate: input.docDate,
    validUntil: input.validUntil,
    counterpartyName: input.counterpartyName,
    counterpartyTaxId: input.counterpartyTaxId,
    counterpartyAddress: input.counterpartyAddress,
    notes: input.notes,
    lines: input.lines,
  };
}

/** สร้างเอกสารร่างใหม่ (draft) ของลูกค้ารายหนึ่ง — ปฏิเสธถ้าลูกค้านอกสโคป/input ไม่ผ่าน validate */
export async function createDraftAction(
  customerId: string,
  input: UpsertSalesDocActionInput
): Promise<SalesDocSaveResult> {
  if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้า" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const res = await createDraftDocument(service, ctx.tenantId, customerId, toDocInput(input));
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "บันทึกร่างแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** แก้ไขเอกสารร่าง (เฉพาะ status='draft') */
export async function updateDraftAction(
  id: string,
  input: UpsertSalesDocActionInput
): Promise<SalesDocSaveResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบเอกสาร" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const scope = await getDocumentScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบเอกสาร (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    const res = await updateDraftDocument(service, ctx.tenantId, id, toDocInput(input));
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "บันทึกการแก้ไขแล้ว", id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ลบเอกสารร่าง (soft-delete) — เฉพาะ draft (ไม่เสียเลขเพราะยังไม่มีเลข) */
export async function deleteDraftAction(id: string): Promise<SalesDocSaveResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบเอกสาร" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const scope = await getDocumentScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบเอกสาร (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    const res = await softDeleteDraft(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ลบร่างแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * ลบเอกสาร "ทุกสถานะ" — ★ 2026-09-03 ผู้ใช้: "ตั้งให้ใบวางบิลที่ออกแล้วสามารถกดลบได้"
 *   ร่าง/ออกเลขแล้ว/ยกเลิกแล้ว ลบได้หมด (soft delete) — เลขที่ที่ออกไปแล้วไม่ถูกนำกลับมาใช้ซ้ำ
 */
export async function deleteDocumentAction(id: string): Promise<SalesDocSaveResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบเอกสาร" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const scope = await getDocumentScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบเอกสาร (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    const res = await softDeleteDocument(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ลบเอกสารแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ออกเอกสาร (draft → issued) — ได้เลขที่จริงจาก RPC atomic แล้วล็อกแก้ไม่ได้อีก */
export async function issueDocumentAction(id: string): Promise<SalesDocIssueResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบเอกสาร" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const scope = await getDocumentScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบเอกสาร (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    const res = await issueDocument(service, ctx.tenantId, id, scope.documentType);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: `ออกเอกสารเลขที่ ${res.docNo} แล้ว`, docNo: res.docNo };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ออกเอกสารไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ยกเลิกเอกสาร (เฉพาะจาก status='issued') — ผิดพลาดต้องยกเลิกแล้วออกใบใหม่ (เลขเดิมไม่ reuse) */
export async function voidDocumentAction(id: string): Promise<SalesDocSaveResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบเอกสาร" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const scope = await getDocumentScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบเอกสาร (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    const res = await voidDocument(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ยกเลิกเอกสารแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยกเลิกไม่สำเร็จ กรุณาลองใหม่" };
  }
}
