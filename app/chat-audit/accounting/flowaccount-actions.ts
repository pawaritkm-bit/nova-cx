"use server";

/**
 * server action ปุ่ม "ส่งไป FlowAccount" (M2 — credential ต่อลูกค้า, ดู docs/05-flowaccount-integration.md)
 *
 * flow ความปลอดภัย (ยึด pattern เดียวกับ actions.ts):
 *   1) requireAccountingAccess (admin/lead เห็นทุกลูกค้า · accountant เฉพาะลูกค้าที่ดูแล) + tenantId จาก session
 *   2) validate entryId (uuid)
 *   3) โหลด customer_id ของบิล (scope tenant) → assertCustomerInScope (ห้ามส่งบิลลูกค้านอกสโคป)
 *   4) เรียก syncSaleEntryToFlowAccount (claim atomic → โหลด+ถอดรหัส credential ต่อลูกค้า → map →
 *      เรียก client → เขียนผล+log)
 *   5) revalidatePath หน้าบัญชี → คืนข้อความไทยสุภาพ (ไม่หลุด error ดิบ/payload/PII)
 *
 * ★ M2: ไม่มี allowlist FLOWACCOUNT_CUSTOMER_ID อีกต่อไป (ดู decision 0.5 ของ M2) — ลูกค้าที่ไม่มี
 *   credential เอง sync ไม่ได้อยู่แล้ว (reason `customer_not_configured` มาจาก flowaccount-sync.ts)
 * ★ ไม่แตะ backend contract — import flowaccount-sync ไปใช้/ห่อเท่านั้น
 * ★ PDPA: ไม่ log เนื้อบิล/ตัวเลข/ชื่อลูกค้า (ไม่มี console.* ที่นี่)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  assertCustomerInScope,
  loadEntryCustomerId,
  AccountingAuthError,
} from "@/lib/accounting/access";
import { syncSaleEntryToFlowAccount, type SyncRejectReason } from "@/lib/accounting/flowaccount-sync";

const PATH = "/chat-audit/accounting";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดงผล (ไม่หลุด internal) */
export type SendToFlowAccountResult =
  | { ok: true; message: string; docNo: string | null }
  | { ok: false; message: string };

/** ข้อความไทยสุภาพต่อ reason ที่ปฏิเสธ/ล้ม — ไม่มี payload/PII */
const REASON_MESSAGE: Partial<Record<SyncRejectReason, string>> = {
  not_found: "ไม่พบบิลนี้ (อาจถูกลบไปแล้ว)",
  not_sale: "ส่งได้เฉพาะบิลขาย",
  not_confirmed: "บิลต้องยืนยันก่อนถึงจะส่งได้",
  missing_customer: "บิลนี้ยังไม่ผูกลูกค้า",
  already_syncing: "มีการส่งบิลนี้อยู่แล้ว กรุณารอสักครู่แล้วรีเฟรชหน้า",
  customer_not_configured: "ลูกค้ารายนี้ยังไม่เปิดใช้การเชื่อมต่อ FlowAccount",
  missing_customer_tax_id: "ลูกค้ายังไม่มีเลขประจำตัวผู้เสียภาษี กรุณาเพิ่มก่อนส่ง",
  no_value_lines: "บิลนี้ไม่มีรายการที่มีมูลค่า",
  missing_doc_date: "บิลนี้ยังไม่มีวันที่เอกสาร",
  not_configured: "ยังไม่เปิดการเชื่อมต่อ FlowAccount",
  auth_failed: "ยืนยันตัวตนกับ FlowAccount ไม่สำเร็จ กรุณาติดต่อผู้ดูแลระบบ",
  validation_error: "FlowAccount ปฏิเสธข้อมูลที่ส่งไป กรุณาตรวจสอบข้อมูลบิลอีกครั้ง",
  timeout: "เชื่อมต่อ FlowAccount หมดเวลา กรุณาลองใหม่",
  network: "เชื่อมต่อ FlowAccount ไม่ได้ กรุณาลองใหม่",
  server_error: "FlowAccount ขัดข้อง กรุณาลองใหม่อีกครั้งในอีกสักครู่",
};

function friendlyReason(reason: SyncRejectReason): string {
  return REASON_MESSAGE[reason] ?? "ส่งไป FlowAccount ไม่สำเร็จ กรุณาลองใหม่";
}

/**
 * ส่งบิลขาย 1 ใบไป FlowAccount (กดทีละใบ) — ★ ไม่ throw ทุก error จับแล้วคืนข้อความสุภาพ
 */
export async function sendToFlowAccountAction(entryId: string): Promise<SendToFlowAccountResult> {
  if (!isUuid(entryId)) return { ok: false, message: "ไม่พบรายการที่เลือก" };

  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    // ★ สโคปนักบัญชี: ส่งได้เฉพาะบิลของลูกค้าที่ตัวเองดูแล (admin/lead ผ่าน)
    const customerId = await loadEntryCustomerId(service, ctx.tenantId, entryId);
    if (customerId === undefined) {
      return { ok: false, message: "ไม่พบบิลนี้ (อาจถูกลบไปแล้ว)" };
    }
    assertCustomerInScope(ctx, customerId);

    const result = await syncSaleEntryToFlowAccount(service, ctx.tenantId, entryId, {
      requestedBy: ctx.employeeId,
    });

    revalidatePath(PATH);

    if (!result.ok) {
      return { ok: false, message: friendlyReason(result.reason) };
    }
    return {
      ok: true,
      message: result.docNo ? `ส่งไป FlowAccount แล้ว — เลขที่ ${result.docNo}` : "ส่งไป FlowAccount แล้ว",
      docNo: result.docNo,
    };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ส่งไป FlowAccount ไม่สำเร็จ กรุณาลองใหม่" };
  }
}
