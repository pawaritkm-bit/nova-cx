"use server";

/**
 * Server actions ของหน้า "รอบเงินเดือน" (/chat-audit/accounting/payroll — เฟส 9 ส่วน AD/AE)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ fixed-assets/actions.ts, IDOR-safe 0.15):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess + tenantId จาก session (ไม่เชื่อ client)
 *   2) assertCustomerInScope ทุกครั้งก่อนอ่าน/เขียน — derive scope จาก resource id ที่กำลังเขียนจริง
 *      (getRunScope) ไม่เชื่อ customerId ที่ client ส่งมาลำพัง
 *   3) validate ซ้ำฝั่ง server เสมอ (lib/accounting/payroll.ts)
 *   4) revalidatePath('/chat-audit/accounting/payroll')
 *
 * ★ 0.7 generateJournalEntryAction สร้าง JE เป็น draft เสมอ — ไม่มีทาง auto-confirm
 * ★ 0.9 generateJournalEntryAction ผ่าน atomic claim ใน lib/accounting/payroll.ts::generateRunJournalEntry
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import {
  createDraftRun,
  recalcRunLines,
  generateRunJournalEntry,
  softDeleteRun,
  getRunScope,
  type CreateRunInput,
  type LineAmountEdit,
} from "@/lib/accounting/payroll";
import { markPitFiled, unmarkPitFiled, markSsoFiled, unmarkSsoFiled } from "@/lib/accounting/payroll-monthly-filing";

const PATH = "/chat-audit/accounting/payroll";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type PayrollRunActionResult = { ok: boolean; message: string; id?: string; existingManualEntryId?: string | null };

/** สร้างรอบเงินเดือนใหม่ (draft) + prefill พนักงาน active ทั้งหมด (0.13) */
export async function createRunAction(customerId: string, input: CreateRunInput): Promise<PayrollRunActionResult> {
  if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const res = await createDraftRun(service, ctx.tenantId, customerId, input);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "สร้างรอบเงินเดือนใหม่แล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "สร้างรอบเงินเดือนไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** คำนวณภาษีหัก ณ ที่จ่าย + ประกันสังคม + เงินเดือนสุทธิใหม่ทุกบรรทัด (idempotent, T114) — บันทึกยอดที่แก้ก่อนคำนวณ */
export async function recalcRunAction(
  runId: string,
  customerId: string,
  lineEdits: LineAmountEdit[]
): Promise<PayrollRunActionResult> {
  if (!isUuid(runId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบรอบเงินเดือนที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    // ★ derive scope จาก run id ที่กำลังเขียนจริงเสมอ (0.15)
    const scope = await getRunScope(service, ctx.tenantId, runId);
    if (!scope) return { ok: false, message: "ไม่พบรอบเงินเดือน (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับรอบเงินเดือนนี้" };

    const res = await recalcRunLines(service, ctx.tenantId, customerId, runId, lineEdits);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: `คำนวณสำเร็จ (${res.lineCount} คน)` };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "คำนวณไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** สร้างรายการบัญชี (JE) ของทั้งรอบเป็นยอดรวม — draft เสมอ (0.7), กันกดซ้ำสอง (0.9) */
export async function generateJournalEntryAction(runId: string, customerId: string): Promise<PayrollRunActionResult> {
  if (!isUuid(runId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบรอบเงินเดือนที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getRunScope(service, ctx.tenantId, runId);
    if (!scope) return { ok: false, message: "ไม่พบรอบเงินเดือน (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับรอบเงินเดือนนี้" };

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    const res = await generateRunJournalEntry(service, ctx.tenantId, customerId, runId, chartByCode);
    revalidatePath(PATH);
    if (!res.ok) return { ok: false, message: res.message, existingManualEntryId: res.existingManualEntryId ?? null };
    return { ok: true, message: "สร้างรายการบัญชี (ร่าง) สำเร็จ — ไปยืนยันที่หน้าลงบันทึกบัญชีเอง", id: res.manualEntryId };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "สร้างรายการบัญชีไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ลบรอบเงินเดือน (soft-delete) — เฉพาะรอบที่ยัง draft (0.14) */
export async function deleteRunAction(runId: string, customerId: string): Promise<PayrollRunActionResult> {
  if (!isUuid(runId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบรอบเงินเดือนที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getRunScope(service, ctx.tenantId, runId);
    if (!scope) return { ok: false, message: "ไม่พบรอบเงินเดือน (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับรอบเงินเดือนนี้" };

    const res = await softDeleteRun(service, ctx.tenantId, runId);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ลบรอบเงินเดือนแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  }
}

type FilingKind = "pit" | "sso";

/**
 * บันทึกว่ายื่น ภ.ง.ด.1/สปส.1-10 แล้ว — เฉพาะรอบที่ status='finalized' (0.3)
 *   ★★★ เฟส 9b กลุ่ม BC (T137/T138) — สถานะยื่นตัวจริงย้ายไปอยู่ที่ระดับ "หน่วยยื่นรายเดือน"
 *   (payroll_monthly_filings) แล้ว ไม่ใช่ระดับรอบจ่ายตรง ๆ — resolve `scope.filingPeriodId` จาก run ที่กำลัง
 *   เขียนจริงก่อนเสมอ (derive จาก resource, 0.15) แล้วค่อยเรียก markPitFiled/markSsoFiled ระดับหน่วยยื่น —
 *   สำหรับลูกค้า monthly (1 รอบ = 1 เดือนเป๊ะ) ผลลัพธ์เหมือนเดิมทุกประการจากมุมมอง UX (T141)
 */
export async function markFiledAction(runId: string, customerId: string, kind: FilingKind): Promise<PayrollRunActionResult> {
  if (!isUuid(runId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบรอบเงินเดือนที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getRunScope(service, ctx.tenantId, runId);
    if (!scope) return { ok: false, message: "ไม่พบรอบเงินเดือน (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับรอบเงินเดือนนี้" };
    if (scope.status !== "finalized") {
      return { ok: false, message: "รอบนี้ยังไม่สร้างรายการบัญชี (JE) — บันทึกสถานะยื่นได้เฉพาะรอบที่สร้าง JE แล้ว" };
    }
    if (!scope.filingPeriodId) {
      return { ok: false, message: "รอบนี้ยังไม่ผูกกับหน่วยยื่นภาษีรายเดือน (ข้อมูลเก่าก่อนอัปเดตระบบ) — กรุณาติดต่อผู้ดูแลระบบ" };
    }

    const res =
      kind === "pit"
        ? await markPitFiled(service, ctx.tenantId, scope.filingPeriodId, ctx.employeeId)
        : await markSsoFiled(service, ctx.tenantId, scope.filingPeriodId, ctx.employeeId);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: kind === "pit" ? "บันทึกว่ายื่น ภ.ง.ด.1 แล้ว" : "บันทึกว่ายื่น สปส.1-10 แล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ยกเลิกสถานะยื่น (undo, 0.3) — ดูคอมเมนต์เต็มใน markFiledAction (เฟส 9b กลุ่ม BC) */
export async function unmarkFiledAction(runId: string, customerId: string, kind: FilingKind): Promise<PayrollRunActionResult> {
  if (!isUuid(runId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบรอบเงินเดือนที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getRunScope(service, ctx.tenantId, runId);
    if (!scope) return { ok: false, message: "ไม่พบรอบเงินเดือน (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับรอบเงินเดือนนี้" };
    if (!scope.filingPeriodId) {
      return { ok: false, message: "รอบนี้ยังไม่ผูกกับหน่วยยื่นภาษีรายเดือน (ข้อมูลเก่าก่อนอัปเดตระบบ) — กรุณาติดต่อผู้ดูแลระบบ" };
    }

    const res =
      kind === "pit"
        ? await unmarkPitFiled(service, ctx.tenantId, scope.filingPeriodId)
        : await unmarkSsoFiled(service, ctx.tenantId, scope.filingPeriodId);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ยกเลิกสถานะยื่นแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยกเลิกไม่สำเร็จ กรุณาลองใหม่" };
  }
}
