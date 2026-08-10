"use server";

/**
 * server action ปุ่ม "บันทึกรับ/จ่ายสต็อก" ต่อแถวบิล (เฟส 8 ส่วน Y — docs/06-accounting-features-roadmap.md
 *   หมวด 0.7/0.8, T71) — เชื่อมกับบิลที่ยืนยันแล้ว (สร้าง product_stock_movements จากบรรทัดที่ผูก
 *   product_id+quantity ครบ)
 *
 * flow ความปลอดภัย (ยึด pattern เดียวกับ flowaccount-actions.ts::sendToFlowAccountAction):
 *   1) requireAccountingAccess (admin/lead เห็นทุกลูกค้า · accountant เฉพาะลูกค้าที่ดูแล) + tenantId จาก session
 *   2) validate entryId (uuid)
 *   3) โหลด customer_id ของบิล (scope tenant) → assertCustomerInScope (★ derive scope จาก entry จริง
 *      ที่โหลดจาก DB ก่อนเขียนเสมอ — ไม่รับ customerId เป็นพารามิเตอร์แยกที่ไม่ผูกกับ entryId, IDOR-safe
 *      pattern ตั้งแต่เฟส 3, 0.13)
 *   4) เรียก createMovementsFromBill (guard ธุรกิจ confirmed/entry_type/มีวันที่เอกสาร + atomic claim
 *      กันกดซ้ำสร้างซ้ำสอง (0.8) → สร้าง movement เฉพาะบรรทัดที่ product_id+quantity ครบ)
 *   5) revalidatePath หน้าบัญชี → คืนข้อความไทยสุภาพ (ไม่หลุด error ดิบ/payload/PII)
 *
 * ★ 0.8 — ไม่แก้ `app/chat-audit/accounting/actions.ts`/`saveEntryAction` เลยแม้แต่บรรทัดเดียว (ไฟล์นี้
 *   เป็นไฟล์แยกทั้งหมด)
 * ★ ไม่แตะ backend contract อื่น — import createMovementsFromBill ไปใช้/ห่อเท่านั้น
 * ★ PDPA: ไม่ log เนื้อบิล/จำนวน/มูลค่า/ชื่อลูกค้า (ไม่มี console.* ที่นี่)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  assertCustomerInScope,
  loadEntryCustomerId,
  AccountingAuthError,
} from "@/lib/accounting/access";
import { createMovementsFromBill } from "@/lib/accounting/product-stock";

const PATH = "/chat-audit/accounting";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดงผล (ไม่หลุด internal) */
export type SyncStockFromBillResult =
  | { ok: true; message: string; created: number; skipped: number }
  | { ok: false; message: string };

/**
 * สร้างรายการรับ/จ่ายสต็อกจากบิล 1 ใบที่ยืนยันแล้ว (กดทีละใบ — ขาย/ซื้อ) — ★ ไม่ throw ทุก error จับแล้ว
 *   คืนข้อความไทยสุภาพ
 */
export async function syncStockFromBillAction(entryId: string): Promise<SyncStockFromBillResult> {
  if (!isUuid(entryId)) return { ok: false, message: "ไม่พบรายการที่เลือก" };

  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    // ★ สโคปนักบัญชี: derive จาก entry จริง (0.13, IDOR-safe) — ไม่รับ customerId จาก client
    const customerId = await loadEntryCustomerId(service, ctx.tenantId, entryId);
    if (customerId === undefined) {
      return { ok: false, message: "ไม่พบบิลนี้ (อาจถูกลบไปแล้ว)" };
    }
    assertCustomerInScope(ctx, customerId);

    const result = await createMovementsFromBill(service, ctx.tenantId, entryId);

    revalidatePath(PATH);

    if (!result.ok) {
      return { ok: false, message: result.message };
    }
    return {
      ok: true,
      message: `บันทึกรายการสต็อกสำเร็จ ${result.created} รายการ`,
      created: result.created,
      skipped: result.skippedLineIds.length,
    };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกรายการสต็อกไม่สำเร็จ กรุณาลองใหม่" };
  }
}
