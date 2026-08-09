"use server";

/**
 * Server actions ของหน้า "กระทบยอดธนาคาร" (/chat-audit/accounting/bank-reconciliation — เฟส 6 ส่วน T)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ recurring-journal/budget actions.ts):
 *   1) requireAccountingAccess (admin/lead เห็นทุกลูกค้า · accountant เฉพาะลูกค้าที่ตัวเองดูแล) +
 *      tenantId จาก session (ไม่เชื่อ client)
 *   2) assertCustomerInScope ทุกครั้งก่อนอ่าน/เขียน (ทั้ง customerId ที่ client ส่งมา และ customerId จริง
 *      ที่โหลดจาก DB ของ batch/statement line/บัญชีเงินฝากเดิม — กัน client ปลอมทั้งสองทาง)
 *   3) resolveBankAccount ยืนยันว่า bankAccountId เป็นของลูกค้ารายนี้จริง (ไม่เชื่อ accountCode จาก client
 *      — ดึงจาก customer_bank_accounts ตรง ๆ เสมอ)
 *   4) confirmMatchAction re-compute bookLines สดจาก server เสมอ (ไม่เชื่อ amount/date ที่ client แนบมากับ
 *      bookLineKey) — ต้องหา key ตรงกับที่คำนวณสดได้จริงเท่านั้นถึงจะเขียน snapshot ★ กัน client ปลอม
 *      snapshot (0.15/0.17)
 *   5) revalidatePath('/chat-audit/accounting/bank-reconciliation')
 *
 * ★ 0.17/0.18 ไม่มี action ไหน auto-confirm/auto-post — ทุกจับคู่ต้องมาจากผู้ใช้กดยืนยันทีละคู่เท่านั้น
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า/รายละเอียด statement (ไม่มี console.* ในไฟล์นี้)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { listCustomerBankAccounts, type CustomerBankAccount } from "@/lib/accounting/bank-accounts";
import type { ReportPeriod } from "@/lib/accounting/report-filter";
import {
  parseBankStatementCsv,
  importBatchFromCsv,
  addManualStatementLine,
  deleteStatementLine,
  deleteBatch,
  confirmMatch,
  unmatch,
  listBookLines,
  getBatchScope,
  getStatementLineScope,
} from "@/lib/accounting/bank-reconciliation";
import type { SupabaseClient } from "@supabase/supabase-js";

const PATH = "/chat-audit/accounting/bank-reconciliation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

const MONTH_RE = /^\d{4}-\d{2}$/;
function isMonth(v: unknown): v is string {
  return typeof v === "string" && MONTH_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type BankRecoActionResult = { ok: true; message?: string; id?: string } | { ok: false; message: string };

/** ยืนยันว่า bankAccountId เป็นบัญชีเงินฝากของลูกค้ารายนี้จริง — ไม่เชื่อ accountCode จาก client เด็ดขาด */
async function resolveBankAccount(
  service: SupabaseClient,
  tenantId: string,
  customerId: string,
  bankAccountId: string
): Promise<CustomerBankAccount | null> {
  const accounts = await listCustomerBankAccounts(service, tenantId, customerId);
  return accounts.find((a) => a.id === bankAccountId) ?? null;
}

// ---------------------------------------------------------------------
// นำเข้า CSV (T51/T52)
// ---------------------------------------------------------------------

export type ImportCsvActionInput = {
  customerId: string;
  bankAccountId: string;
  fileName?: string | null;
  csvText: string;
};

export async function importCsvAction(input: ImportCsvActionInput): Promise<BankRecoActionResult> {
  if (!isUuid(input.customerId) || !isUuid(input.bankAccountId)) {
    return { ok: false, message: "ไม่พบลูกค้า/บัญชีเงินฝากที่เลือก" };
  }
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, input.customerId);

    const account = await resolveBankAccount(service, ctx.tenantId, input.customerId, input.bankAccountId);
    if (!account) return { ok: false, message: "ไม่พบบัญชีเงินฝากของลูกค้ารายนี้" };

    const csvText = typeof input.csvText === "string" ? input.csvText : "";
    if (!csvText.trim()) return { ok: false, message: "ไฟล์ไม่มีข้อมูล" };

    const parsed = parseBankStatementCsv(csvText);
    if (!parsed.ok) {
      const preview = parsed.errors.slice(0, 5).map((e) => e.message).join(" · ");
      const more = parsed.errors.length > 5 ? ` (และอีก ${parsed.errors.length - 5} บรรทัด)` : "";
      return { ok: false, message: `ไฟล์มีบรรทัดผิดรูปแบบ — ${preview}${more}` };
    }

    const fileName = typeof input.fileName === "string" ? input.fileName.slice(0, 200) : null;
    const res = await importBatchFromCsv(service, ctx.tenantId, input.customerId, input.bankAccountId, fileName, parsed.rows);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: `นำเข้าสำเร็จ ${res.lineCount} รายการ`, id: res.batchId };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "นำเข้าไฟล์ไม่สำเร็จ กรุณาลองใหม่" };
  }
}

// ---------------------------------------------------------------------
// กรอกมือ (T51/T52)
// ---------------------------------------------------------------------

export type AddManualLineInput = {
  customerId: string;
  bankAccountId: string;
  date: unknown;
  description?: unknown;
  amount: unknown;
};

export async function addManualLineAction(input: AddManualLineInput): Promise<BankRecoActionResult> {
  if (!isUuid(input.customerId) || !isUuid(input.bankAccountId)) {
    return { ok: false, message: "ไม่พบลูกค้า/บัญชีเงินฝากที่เลือก" };
  }
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, input.customerId);

    const account = await resolveBankAccount(service, ctx.tenantId, input.customerId, input.bankAccountId);
    if (!account) return { ok: false, message: "ไม่พบบัญชีเงินฝากของลูกค้ารายนี้" };

    const res = await addManualStatementLine(service, ctx.tenantId, input.customerId, input.bankAccountId, {
      date: input.date,
      description: input.description,
      amount: input.amount,
    });
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "เพิ่มรายการแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "เพิ่มรายการไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ลบ statement line 1 แถว (soft-delete — แก้ typo/ลบรายการกรอกมือผิด ตาม 0.13) */
export async function deleteStatementLineAction(
  lineId: string,
  customerId: string
): Promise<BankRecoActionResult> {
  if (!isUuid(lineId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getStatementLineScope(service, ctx.tenantId, lineId);
    if (!scope) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับรายการเดิม" };

    const res = await deleteStatementLine(service, ctx.tenantId, lineId);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "ลบรายการแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบรายการไม่สำเร็จ กรุณาลองใหม่" };
  }
}

// ---------------------------------------------------------------------
// ลบ batch นำเข้า (T49/T51/T52) — hard-delete cascade
// ---------------------------------------------------------------------

export async function deleteBatchAction(batchId: string, customerId: string): Promise<BankRecoActionResult> {
  if (!isUuid(batchId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบชุดที่นำเข้าที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getBatchScope(service, ctx.tenantId, batchId);
    if (!scope) return { ok: false, message: "ไม่พบชุดที่นำเข้า (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับชุดที่นำเข้าเดิม" };

    const res = await deleteBatch(service, ctx.tenantId, batchId);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "ลบชุดที่นำเข้าแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบชุดที่นำเข้าไม่สำเร็จ กรุณาลองใหม่" };
  }
}

// ---------------------------------------------------------------------
// จับคู่ (T51/T52, 0.15/0.17/0.18) — ★ ไม่ auto-confirm เด็ดขาด ต้องเรียกทีละคู่จากการกดของผู้ใช้เท่านั้น
// ---------------------------------------------------------------------

export type ConfirmMatchInput = {
  customerId: string;
  bankAccountId: string;
  statementLineId: string;
  bookLineKey: string;
  /** งวดเดียวกับที่หน้าจอกำลังแสดง — ใช้ re-compute bookLines สดฝั่ง server (ไม่เชื่อ amount/date จาก client) */
  month: string;
  includeDraft: boolean;
};

export async function confirmMatchAction(input: ConfirmMatchInput): Promise<BankRecoActionResult> {
  if (!isUuid(input.customerId) || !isUuid(input.bankAccountId) || !isUuid(input.statementLineId)) {
    return { ok: false, message: "ไม่พบรายการที่เลือก" };
  }
  if (!isMonth(input.month)) return { ok: false, message: "งวดไม่ถูกต้อง" };
  if (typeof input.bookLineKey !== "string" || !input.bookLineKey) {
    return { ok: false, message: "ไม่พบรายการฝั่งบัญชีที่เลือก" };
  }
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, input.customerId);

    const account = await resolveBankAccount(service, ctx.tenantId, input.customerId, input.bankAccountId);
    if (!account) return { ok: false, message: "ไม่พบบัญชีเงินฝากของลูกค้ารายนี้" };

    const stmtScope = await getStatementLineScope(service, ctx.tenantId, input.statementLineId);
    if (!stmtScope) return { ok: false, message: "ไม่พบรายการ statement (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, stmtScope.customerId);
    if (stmtScope.customerId !== input.customerId || stmtScope.bankAccountId !== input.bankAccountId) {
      return { ok: false, message: "ลูกค้า/บัญชีไม่ตรงกับรายการ statement เดิม" };
    }

    // ★ re-compute bookLines สดจาก server เสมอ (ไม่เชื่อ amount/date ที่ client แนบมา) — หา key ต้องตรงเป๊ะ
    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);
    const period: ReportPeriod = { from: input.month, to: input.month, includeDraft: input.includeDraft };
    const bookLines = await listBookLines(service, ctx.tenantId, input.customerId, account.accountCode, period, chartByCode);
    const bookLine = bookLines.find((b) => b.key === input.bookLineKey);
    if (!bookLine) {
      return { ok: false, message: "ไม่พบรายการฝั่งบัญชีนี้แล้ว (ข้อมูลอาจเปลี่ยนไป) กรุณาโหลดหน้าใหม่" };
    }

    const res = await confirmMatch(service, ctx.tenantId, input.statementLineId, bookLine);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "ยืนยันจับคู่แล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยืนยันจับคู่ไม่สำเร็จ กรุณาลองใหม่" };
  }
}

export async function unmatchAction(
  statementLineId: string,
  customerId: string,
  bankAccountId: string
): Promise<BankRecoActionResult> {
  if (!isUuid(statementLineId) || !isUuid(customerId) || !isUuid(bankAccountId)) {
    return { ok: false, message: "ไม่พบรายการที่เลือก" };
  }
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const stmtScope = await getStatementLineScope(service, ctx.tenantId, statementLineId);
    if (!stmtScope) return { ok: false, message: "ไม่พบรายการ statement (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, stmtScope.customerId);
    if (stmtScope.customerId !== customerId || stmtScope.bankAccountId !== bankAccountId) {
      return { ok: false, message: "ลูกค้า/บัญชีไม่ตรงกับรายการ statement เดิม" };
    }

    const res = await unmatch(service, ctx.tenantId, statementLineId);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "ยกเลิกจับคู่แล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยกเลิกจับคู่ไม่สำเร็จ กรุณาลองใหม่" };
  }
}
