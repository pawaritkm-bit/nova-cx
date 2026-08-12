"use server";

/**
 * Server actions ของหน้า "ใบแจ้งหนี้ลูกค้าแบบวนซ้ำ" (/chat-audit/accounting/recurring-invoice — wishlist ข้อ 4)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ recurring-journal/actions.ts):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess (admin/lead เห็นทุกลูกค้า ·
 *      accountant เฉพาะลูกค้าที่ตัวเองดูแล) + tenantId จาก session (ไม่เชื่อ client)
 *   2) assertCustomerInScope ทุกครั้งก่อนอ่าน/เขียน (ทั้ง customerId ที่ client ส่งมา และ customerId
 *      จริงของเทมเพลตเดิมที่โหลดจาก DB — กัน client ปลอมทั้งสองทาง)
 *   3) validate ซ้ำฝั่ง server เสมอ (recurring-invoice.ts::validateTemplateInput ผ่าน upsertTemplate)
 *   4) revalidatePath('/chat-audit/accounting/recurring-invoice')
 *
 * ★ ปุ่ม "สร้างตอนนี้" (generateNowAction) — บังคับ `today` = todayIsoThai() ฝั่ง server เสมอ
 *   ไม่มีทางรับค่าจาก client input เด็ดขาด (กันแก้วันที่เครื่อง/ปลอมวันที่แล้วสร้างย้อนหลัง/ล่วงหน้า)
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า/ชื่อคู่ค้า (ไม่มี console.* ที่นี่)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  assertCustomerInScope,
  AccountingAuthError,
} from "@/lib/accounting/access";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import {
  upsertTemplate,
  toggleTemplateActive,
  softDeleteTemplate,
  getTemplateScope,
  generateOccurrenceForTemplate,
  todayIsoThai,
  type RecurringInvoiceTemplateInput,
} from "@/lib/accounting/recurring-invoice";

const PATH = "/chat-audit/accounting/recurring-invoice";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export type RecurringInvoiceSaveResult = { ok: boolean; message: string; id?: string };

export type SaveTemplateLineInput = {
  description?: unknown;
  accountCode: unknown;
  accountName?: unknown;
  vatType?: unknown;
  quantity: unknown;
  unitPrice: unknown;
};

export type SaveTemplateInput = {
  /** มี id = แก้เทมเพลตเดิม · ไม่มี = สร้างใหม่ */
  id?: string;
  customerId: string;
  counterpartyName: unknown;
  counterpartyTaxId?: unknown;
  notes?: unknown;
  frequency: unknown;
  startDate: unknown;
  endDate?: unknown;
  dueDays?: unknown;
  lines: SaveTemplateLineInput[];
};

/** บันทึกเทมเพลต (สร้างใหม่/แก้ไข) — ยอดรวม<=0/รหัสบัญชีไม่อยู่หมวดรายได้/frequency ไม่รู้จัก → ปฏิเสธ */
export async function saveTemplateAction(input: SaveTemplateInput): Promise<RecurringInvoiceSaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    if (input.id) {
      if (!isUuid(input.id)) return { ok: false, message: "ไม่พบเทมเพลตที่เลือก" };
      const scope = await getTemplateScope(service, ctx.tenantId, input.id);
      if (!scope) return { ok: false, message: "ไม่พบเทมเพลต (อาจถูกลบไปแล้ว)" };
      assertCustomerInScope(ctx, scope.customerId);
      if (scope.customerId !== input.customerId) {
        return { ok: false, message: "ลูกค้าไม่ตรงกับเทมเพลตเดิม" };
      }
    }

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    const templateInput: RecurringInvoiceTemplateInput = {
      counterpartyName: input.counterpartyName,
      counterpartyTaxId: input.counterpartyTaxId,
      notes: input.notes,
      frequency: input.frequency,
      startDate: input.startDate,
      endDate: input.endDate,
      dueDays: input.dueDays,
      lines: input.lines,
    };

    const res = await upsertTemplate(service, ctx.tenantId, input.customerId, templateInput, chartByCode, input.id);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "บันทึกเทมเพลตแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** เปิด/ปิดใช้งานเทมเพลต (is_active) — ปิดแล้ว cron/ปุ่ม "สร้างตอนนี้" จะไม่ claim อีก */
export async function toggleTemplateActiveAction(
  id: string,
  customerId: string,
  isActive: boolean
): Promise<RecurringInvoiceSaveResult> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบเทมเพลตที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getTemplateScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบเทมเพลต (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับเทมเพลตเดิม" };

    const res = await toggleTemplateActive(service, ctx.tenantId, id, isActive);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: isActive ? "เปิดใช้งานแล้ว" : "ปิดใช้งานแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "เปลี่ยนสถานะไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ลบเทมเพลต (soft-delete) — occurrence ที่สร้างไปแล้วยังอยู่เหมือนเดิม */
export async function deleteTemplateAction(id: string, customerId: string): Promise<RecurringInvoiceSaveResult> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบเทมเพลตที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getTemplateScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบเทมเพลต (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับเทมเพลตเดิม" };

    const res = await softDeleteTemplate(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ลบเทมเพลตแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * สร้าง occurrence ของเทมเพลต "เดียว" ทันที (ปุ่ม "สร้างตอนนี้")
 *   ★ `today` = todayIsoThai() เสมอ (คำนวณฝั่ง server เท่านั้น) — ไม่รับจาก client
 *   เทมเพลตยังไม่ถึงรอบ (next_run_date > today) → claim ไม่ติด → คืน skipped (แจ้งผู้ใช้เฉย ๆ ไม่ throw)
 */
export async function generateNowAction(id: string, customerId: string): Promise<RecurringInvoiceSaveResult> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบเทมเพลตที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getTemplateScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบเทมเพลต (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับเทมเพลตเดิม" };

    // ★ วันที่ปัจจุบันจริงเสมอ — ไม่รับ "today" จาก client input เด็ดขาด (ป้องกันสร้างย้อนหลัง/ล่วงหน้าผิดปกติ)
    const today = todayIsoThai();
    const res = await generateOccurrenceForTemplate(service, ctx.tenantId, id, today);

    revalidatePath(PATH);
    if (res.status === "generated") {
      return { ok: true, message: "สร้างใบแจ้งหนี้ (ร่าง) สำเร็จ — ไปตรวจสอบ/ยืนยันที่หน้าลงบันทึกบัญชี" };
    }
    if (res.status === "failed") {
      return { ok: false, message: res.message };
    }
    return { ok: false, message: "เทมเพลตนี้ยังไม่ถึงกำหนดรอบถัดไป — ยังไม่สร้างอะไร" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "สร้างใบแจ้งหนี้ไม่สำเร็จ กรุณาลองใหม่" };
  }
}
