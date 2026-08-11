"use server";

/**
 * Server actions ของหน้า "ปรับปรุงอัตราแลกเปลี่ยนปลายงวด" (/chat-audit/accounting/fx-revaluation) — เฟส 10b
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ journal-entry/actions.ts, payments/actions.ts):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess + tenantId จาก session (ไม่เชื่อ client)
 *   2) assertCustomerInScope ทั้ง customerId ที่ client ส่งมา และ customerId จริงของแถวเดิม (โหลดจาก DB ผ่าน
 *      getFxPeriodRevaluationCustomerId) — กัน client ปลอมทั้งสองทาง (IDOR-safe, 0.17)
 *   3) validate ซ้ำฝั่ง server เสมอ (lib/accounting/fx-revaluation.ts — guard #1/#2 + validateFxRate/
 *      isValidCurrencyCode เดิม)
 *   4) revalidatePath ทั้งหน้านี้และหน้า journal-entry (JV ที่สร้าง/ยืนยันไปโผล่ที่นั่นด้วย)
 *
 * ★ PDPA: ไม่ log ตัวเลข/อัตราแลกเปลี่ยน/ชื่อลูกค้า (ไม่มี console.* ที่นี่)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { isValidCurrencyCode } from "@/lib/accounting/currency";
import { fetchBotReferenceRate, type BotRateResult } from "@/lib/integrations/bot-exchange-rate";
import type { FxEligibleEntryType } from "@/lib/accounting/fx";
import {
  createFxRevaluationDraft,
  confirmFxRevaluation,
  confirmFxReversing,
  unconfirmFxReversing,
  getFxPeriodRevaluationCustomerId,
  type FxActionResult as LibFxActionResult,
} from "@/lib/accounting/fx-revaluation";

const PATH = "/chat-audit/accounting/fx-revaluation";
const JOURNAL_PATH = "/chat-audit/accounting/journal-entry";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function asEntryType(v: unknown): FxEligibleEntryType | null {
  return v === "sale" || v === "purchase" ? v : null;
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type FxActionResult = { ok: boolean; message: string; id?: string };

export type CreateFxRevaluationInput = {
  customerId: string;
  entryType: unknown;
  currency: unknown;
  periodEndDate: unknown;
  closingRate: unknown;
  /** 'bot' เมื่อดึงจาก ธปท. สำเร็จและไม่ถูกแก้ทับ · 'manual' เมื่อกรอกเอง/แก้ทับค่าที่ดึงมา (0.15) */
  source: unknown;
  gainLossAccountCode?: unknown;
};

/** สร้าง JV ปรับปรุงอัตราแลกเปลี่ยนปลายงวด (draft) — guard #1 ถูกเรียกจาก createFxRevaluationDraft เสมอ */
export async function createFxRevaluationDraftAction(input: CreateFxRevaluationInput): Promise<FxActionResult> {
  if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
  const entryType = asEntryType(input.entryType);
  if (!entryType) return { ok: false, message: "ต้องระบุฝั่งบัญชี (ขาย/ซื้อ)" };
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (!isValidCurrencyCode(currency)) return { ok: false, message: "สกุลเงินไม่ถูกต้อง" };
  const periodEndDate = typeof input.periodEndDate === "string" ? input.periodEndDate.trim() : "";
  const closingRate =
    typeof input.closingRate === "number" ? input.closingRate : Number(input.closingRate);
  const gainLossAccountCode =
    typeof input.gainLossAccountCode === "string" && input.gainLossAccountCode.trim()
      ? input.gainLossAccountCode.trim()
      : undefined;
  const source = input.source === "bot" ? "bot" : "manual";

  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, input.customerId);

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    const res = await createFxRevaluationDraft(
      service,
      ctx.tenantId,
      input.customerId,
      entryType,
      currency,
      periodEndDate,
      closingRate,
      source,
      chartByCode,
      gainLossAccountCode
    );
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "สร้าง JV ปรับปรุง (ร่าง) แล้ว — ตรวจสอบก่อนกดยืนยันที่หน้านี้", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "สร้างรายการไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ตรวจสโคป (ทั้งที่ client ส่งมาและของแถวจริงใน DB) แล้วเรียก fn ของ fx-revaluation.ts — ใช้ร่วม 3 action ยืนยันด้านล่าง */
async function runScopedFxAction(
  revaluationId: string,
  customerId: string,
  fn: (service: ReturnType<typeof createServiceRoleClient>, tenantId: string, id: string) => Promise<LibFxActionResult>,
  successMessage: string
): Promise<FxActionResult> {
  if (!isUuid(revaluationId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const realCustomerId = await getFxPeriodRevaluationCustomerId(service, ctx.tenantId, revaluationId);
    if (!realCustomerId) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, realCustomerId);
    if (realCustomerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับรายการเดิม" };

    const res = await fn(service, ctx.tenantId, revaluationId);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    revalidatePath(JOURNAL_PATH);
    return { ok: true, message: successMessage, id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ทำรายการไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ยืนยัน JV ปรับปรุง → ระบบสร้าง JV กลับรายการ (draft) ให้อัตโนมัติทันที (0.9) */
export async function confirmFxRevaluationAction(revaluationId: string, customerId: string): Promise<FxActionResult> {
  return runScopedFxAction(
    revaluationId,
    customerId,
    confirmFxRevaluation,
    "ยืนยัน JV ปรับปรุงแล้ว — ระบบสร้างรายการกลับรายการ (ร่าง) ให้อัตโนมัติ ตรวจสอบและยืนยันที่นี่อีกครั้ง"
  );
}

/** ยืนยัน JV กลับรายการ — งวดนี้ปิดสมบูรณ์ (ปลดล็อกให้สร้าง JV ปรับปรุงงวดถัดไปได้) */
export async function confirmFxReversingAction(revaluationId: string, customerId: string): Promise<FxActionResult> {
  return runScopedFxAction(revaluationId, customerId, confirmFxReversing, "ยืนยันรายการกลับรายการแล้ว — งวดนี้ปิดสมบูรณ์");
}

/** ยกเลิกการยืนยัน JV กลับรายการ (0.13 — ทางเข้าที่ถูกต้องทางเดียวสำหรับ reversing_je_id นี้) */
export async function unconfirmFxReversingAction(revaluationId: string, customerId: string): Promise<FxActionResult> {
  return runScopedFxAction(revaluationId, customerId, unconfirmFxReversing, "ยกเลิกการยืนยันรายการกลับรายการแล้ว");
}

/**
 * ดึงอัตราอ้างอิง ธปท. ของสกุล+วันที่ (best-effort prefill, 0.15) — ไม่ผูกกับลูกค้ารายใด (ไม่มีข้อมูลอ่อนไหว)
 *   แต่ยังคงต้องผ่าน requireAccountingAccess กันใช้เป็น proxy โดยคนนอกระบบ
 */
export async function fetchBotRateAction(currency: string, date: string): Promise<BotRateResult> {
  if (!isValidCurrencyCode(currency)) return { ok: false };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    await requireAccountingAccess(authed, service);
  } catch {
    return { ok: false };
  }
  return fetchBotReferenceRate(currency, date);
}
