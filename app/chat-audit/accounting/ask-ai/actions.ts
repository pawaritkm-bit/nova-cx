"use server";

/**
 * Server action ของหน้า "ถาม AI เรื่องข้อมูลธุรกิจ" (/chat-audit/accounting/ask-ai — wishlist backlog ข้อ 3)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับทุกฟีเจอร์ในโปรเจกต์นี้):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess + assertCustomerInScope(customerId ที่
 *      client ส่งมา) ก่อนแตะข้อมูลลูกค้าเสมอ — tenantId มาจาก session (ไม่เชื่อ client)
 *   2) เขียน/อ่านผ่าน lib/ai/business-qa.ts (pure orchestration, ไม่ตรวจสิทธิ์เอง)
 *   3) ไม่ revalidatePath — หน้านี้ไม่มี state ฝั่ง server ให้ต้อง refresh (ประวัติแชตเก็บแค่ client)
 *
 * ★ PDPA: ไม่ log คำถาม/คำตอบ/ตัวเลข/ชื่อลูกค้า (ไม่มี console.* ที่นี่)
 */
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import { answerBusinessQuestion, QUESTION_MAX } from "@/lib/ai/business-qa";

export type AskAiResult = { ok: true; answer: string } | { ok: false; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ถามคำถามเกี่ยวกับข้อมูลธุรกิจของลูกค้า 1 ราย (ที่นักบัญชีกำลังดูอยู่) */
export async function askBusinessQuestionAction(customerId: string, question: string): Promise<AskAiResult> {
  if (!UUID_RE.test(customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
  if (typeof question !== "string" || !question.trim()) return { ok: false, message: "กรุณาพิมพ์คำถาม" };
  if (question.length > QUESTION_MAX) return { ok: false, message: `คำถามยาวเกินไป (สูงสุด ${QUESTION_MAX} ตัวอักษร)` };

  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const res = await answerBusinessQuestion(service, ctx.tenantId, customerId, question);
    if (!res.ok) return { ok: false, message: res.message };
    return { ok: true, answer: res.answer };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ตอบคำถามไม่สำเร็จ กรุณาลองใหม่" };
  }
}
