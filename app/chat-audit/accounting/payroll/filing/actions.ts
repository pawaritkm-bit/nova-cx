"use server";

/**
 * Server actions ของหน้า "สรุปการยื่นรายเดือน" (/chat-audit/accounting/payroll/filing — เฟส 9b กลุ่ม BC)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ payroll/actions.ts เดิม, IDOR-safe 0.15):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess + tenantId จาก session (ไม่เชื่อ client)
 *   2) assertCustomerInScope ทุกครั้งก่อนอ่าน/เขียน — derive scope จาก resource id ที่กำลังเขียนจริง
 *      (getFilingPeriodById) ไม่เชื่อ customerId ที่ client ส่งมาลำพัง
 *   3) validate ซ้ำฝั่ง server เสมอ (lib/accounting/payroll-monthly-filing.ts)
 *   4) revalidatePath ทั้งหน้านี้และหน้ารอบเงินเดือนเดิม (แสดงสถานะยื่นแบบ read-only ที่นั่นด้วย, T141)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import {
  markPitFiled,
  unmarkPitFiled,
  markSsoFiled,
  unmarkSsoFiled,
  getFilingPeriodById,
} from "@/lib/accounting/payroll-monthly-filing";

const PATH = "/chat-audit/accounting/payroll/filing";
const RUN_PATH = "/chat-audit/accounting/payroll";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export type FilingActionResult = { ok: boolean; message: string };

type FilingKind = "pit" | "sso";

/** บันทึกว่ายื่น ภ.ง.ด.1/สปส.1-10 แล้ว 1 ชุด/เดือน (T139) — เฉพาะเดือนที่มีอย่างน้อย 1 รอบสร้าง JE แล้ว */
export async function markFilingAction(filingPeriodId: string, customerId: string, kind: FilingKind): Promise<FilingActionResult> {
  if (!isUuid(filingPeriodId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบหน่วยยื่นที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const period = await getFilingPeriodById(service, ctx.tenantId, filingPeriodId);
    if (!period) return { ok: false, message: "ไม่พบหน่วยยื่น (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, period.customerId);
    if (period.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับหน่วยยื่นนี้" };

    const res =
      kind === "pit"
        ? await markPitFiled(service, ctx.tenantId, filingPeriodId, ctx.employeeId)
        : await markSsoFiled(service, ctx.tenantId, filingPeriodId, ctx.employeeId);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    revalidatePath(RUN_PATH);
    return { ok: true, message: kind === "pit" ? "บันทึกว่ายื่น ภ.ง.ด.1 แล้ว" : "บันทึกว่ายื่น สปส.1-10 แล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ยกเลิกสถานะยื่น (undo) */
export async function unmarkFilingAction(filingPeriodId: string, customerId: string, kind: FilingKind): Promise<FilingActionResult> {
  if (!isUuid(filingPeriodId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบหน่วยยื่นที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const period = await getFilingPeriodById(service, ctx.tenantId, filingPeriodId);
    if (!period) return { ok: false, message: "ไม่พบหน่วยยื่น (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, period.customerId);
    if (period.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับหน่วยยื่นนี้" };

    const res =
      kind === "pit"
        ? await unmarkPitFiled(service, ctx.tenantId, filingPeriodId)
        : await unmarkSsoFiled(service, ctx.tenantId, filingPeriodId);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    revalidatePath(RUN_PATH);
    return { ok: true, message: "ยกเลิกสถานะยื่นแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยกเลิกไม่สำเร็จ กรุณาลองใหม่" };
  }
}
