"use server";

/**
 * Server actions ของหน้า "ใบลดหนี้/ใบเพิ่มหนี้" (/chat-audit/accounting/credit-debit-notes) — เฟส 3 ส่วน J
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ payments/actions.ts เฟส 2 ส่วน F):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess + tenantId จาก session (ไม่เชื่อ client)
 *   2) โหลดสโคปจริงจาก DB แล้ว assertCustomerInScope ทุกครั้งก่อนอ่าน/เขียน — ★ ต้อง derive สโคปจาก
 *      "resource ที่กำลังจะเขียนจริง" เท่านั้น (id ของ note เมื่อมีอยู่แล้ว — ผ่าน getNoteScope, หรือ
 *      entryId ของบิลต้นทางเมื่อยังไม่มี note object — ผ่าน getNoteEntryScope) ★ ห้ามรับ entryId
 *      คู่แยกจาก client มาตรวจสโคปแทน id ของ resource ที่จะเขียน (เคยเป็นช่องโหว่ IDOR: client ส่ง
 *      entryId ของบิลที่ตัวเองมีสิทธิ์มาผ่านสโคป แต่ id ที่เขียนจริงเป็นของลูกค้าอื่น)
 *   3) validate ซ้ำฝั่ง server เสมอ (lib/accounting/credit-debit-notes.ts::validateNoteInput —
 *      ปฏิเสธบิลไม่ eligible/เหตุผลว่าง/บรรทัดไม่ครบทุกครั้ง)
 *   4) revalidatePath('/chat-audit/accounting/credit-debit-notes')
 *
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า (ไม่มี console.* ที่นี่)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import {
  createDraftNote,
  updateDraftNote,
  confirmNote,
  softDeleteNote,
  getNoteEntryScope,
  getNoteScope,
  type NoteInput,
} from "@/lib/accounting/credit-debit-notes";

const PATH = "/chat-audit/accounting/credit-debit-notes";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type NoteSaveResult = { ok: boolean; message: string; id?: string };

export type UpsertNoteLineActionInput = {
  description?: unknown;
  accountCode: unknown;
  accountName?: unknown;
  amount: unknown;
  vatAmount?: unknown;
};

export type UpsertNoteActionInput = {
  /** มี id = แก้ไขรายการเดิม (ต้องเป็น draft เท่านั้น) · ไม่มี = สร้างใหม่ */
  id?: string;
  entryId: string;
  docType: unknown;
  docDate: unknown;
  docNo?: unknown;
  reason: unknown;
  lines: UpsertNoteLineActionInput[];
};

/**
 * สร้าง/แก้ไข CN/DN 1 ใบ — ปฏิเสธถ้าบิลไม่ eligible/ลูกค้านอกสโคป (server-side, validate ที่ credit-debit-notes.ts)
 *   ★ มี input.id (แก้ไข draft เดิม) — ต้องตรวจสโคปจาก "note ที่มีอยู่จริง" ผ่าน getNoteScope(id) เท่านั้น
 *     ไม่เชื่อ input.entryId ที่ client ส่งมา (อาจไม่ตรงกับ note ตัวจริงที่ id ระบุ — กัน IDOR)
 *   ★ ไม่มี input.id (สร้างใหม่) — ยังไม่มี note object ให้ derive สโคป ต้องอิง entryId ของบิลต้นทางแทน
 */
export async function upsertNoteAction(input: UpsertNoteActionInput): Promise<NoteSaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const noteInput: NoteInput = {
      docType: input.docType,
      docDate: input.docDate,
      docNo: input.docNo,
      reason: input.reason,
      lines: input.lines,
    };

    if (input.id) {
      if (!isUuid(input.id)) return { ok: false, message: "ไม่พบรายการที่เลือก" };

      const scope = await getNoteScope(service, ctx.tenantId, input.id);
      if (!scope) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
      assertCustomerInScope(ctx, scope.customerId);

      const res = await updateDraftNote(service, ctx.tenantId, input.id, noteInput);
      if (!res.ok) return { ok: false, message: res.message };
      revalidatePath(PATH);
      return { ok: true, message: "บันทึกแล้ว", id: res.id };
    }

    if (!isUuid(input.entryId)) return { ok: false, message: "ไม่พบบิลที่เลือก" };

    const scope = await getNoteEntryScope(service, ctx.tenantId, input.entryId);
    if (!scope) return { ok: false, message: "ไม่พบบิล (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    const res = await createDraftNote(service, ctx.tenantId, input.entryId, noteInput);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "บันทึกร่างแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * ยืนยัน CN/DN (draft → confirmed) — เข้ายอดค้างชำระ/รายงานทันที
 *   ★ ตรวจสโคปผ่าน getNoteScope(id) เท่านั้น (derive จาก note ที่กำลังจะเขียนจริงตรง ๆ) — ไม่รับ entryId
 *     คู่แยกจาก client เหมือนเดิม (เคยเป็นช่องโหว่ IDOR: entryId ที่ผ่านสโคปอาจเป็นของบิลอื่น ไม่ตรงกับ
 *     note ตัวจริงที่ id ระบุ)
 */
export async function confirmNoteAction(id: string): Promise<NoteSaveResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const scope = await getNoteScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    const res = await confirmNote(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ยืนยันแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยืนยันไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * ยกเลิก CN/DN (soft-delete) — ผิดพลาดต้องยกเลิกแล้วออกใบใหม่ที่ถูกต้อง
 *   ★ ตรวจสโคปผ่าน getNoteScope(id) เท่านั้น (เหตุผลเดียวกับ confirmNoteAction ด้านบน)
 */
export async function voidNoteAction(id: string): Promise<NoteSaveResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const scope = await getNoteScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    const res = await softDeleteNote(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ยกเลิกรายการแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยกเลิกไม่สำเร็จ กรุณาลองใหม่" };
  }
}
