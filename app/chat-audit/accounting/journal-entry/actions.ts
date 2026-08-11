"use server";

/**
 * Server actions ของหน้า "ลงบันทึกบัญชีเอง" (/chat-audit/accounting/journal-entry) — เฟส 1 ส่วน C
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ opening-balance actions ใน ../actions.ts):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess (admin/lead เห็นทุกลูกค้า ·
 *      accountant เฉพาะลูกค้าที่ตัวเองดูแล) + tenantId จาก session (ไม่เชื่อ client)
 *   2) assertCustomerInScope ทุกครั้งก่อนอ่าน/เขียน (ทั้ง customerId ที่ client ส่งมา และ customerId
 *      จริงของรายการเดิมที่โหลดจาก DB — กัน client ปลอมทั้งสองทาง)
 *   3) validate ซ้ำฝั่ง server เสมอ (lib/accounting/manual-journal.ts::validateManualEntryInput —
 *      ต้องอยู่ในผังบัญชี + สมดุลเดบิต=เครดิต ไม่งั้นปฏิเสธ ไม่มีทางบันทึกรายการไม่สมดุลได้)
 *   4) revalidatePath('/chat-audit/accounting/journal-entry')
 *
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า (ไม่มี console.* ที่นี่)
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
  upsertManualEntry,
  confirmManualEntry,
  unconfirmManualEntry,
  softDeleteManualEntry,
  getManualEntryScope,
  type ManualEntryInput,
} from "@/lib/accounting/manual-journal";
import { isRevaluationOrReversingJeId, isFxCycleConfirmedForJe } from "@/lib/accounting/fx-revaluation";

/** ข้อความปฏิเสธเมื่อ id เป็น revaluation_je_id/reversing_je_id ของ fx_period_revaluations ที่ยังไม่จบ cycle */
const FX_LOCKED_MESSAGE =
  "รายการนี้ผูกกับ 'ปรับปรุงอัตราแลกเปลี่ยนปลายงวด' — จัดการยืนยัน/ยกเลิกยืนยันผ่านหน้านั้นเท่านั้น";

/** ข้อความปฏิเสธเมื่อพยายามลบ JE ที่ revaluation JE ของ cycle เดียวกันยัง confirmed อยู่จริง (เฟส 10b QC fix) */
const FX_LOCKED_DELETE_MESSAGE =
  "รายการนี้ผูกกับ 'ปรับปรุงอัตราแลกเปลี่ยนปลายงวด' ที่ยืนยันแล้ว — ต้องยกเลิกยืนยันที่หน้าปรับปรุงอัตราแลกเปลี่ยนก่อน ไม่สามารถลบ JV นี้ตรงๆได้";

const PATH = "/chat-audit/accounting/journal-entry";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type ManualSaveResult = {
  ok: boolean;
  message: string;
  id?: string;
};

export type SaveManualEntryLineInput = {
  accountCode: unknown;
  accountName?: unknown;
  description?: unknown;
  debit: unknown;
  credit: unknown;
};

export type SaveManualEntryInput = {
  /** มี id = update รายการเดิม (ต้องเป็น draft เท่านั้น) · ไม่มี = สร้างใหม่ */
  id?: string;
  customerId: string;
  docType: unknown;
  docDate: unknown;
  docNo?: unknown;
  memo?: unknown;
  lines: SaveManualEntryLineInput[];
  /** true = บันทึกแล้วยืนยันทันที (ต้องสมดุล — validate ซ้ำอีกครั้งก่อนยืนยันจริง) */
  confirm?: boolean;
};

/** บันทึก manual JE (สร้างใหม่/แก้ไข) — ไม่สมดุล/รหัสบัญชีไม่อยู่ในผัง → ปฏิเสธ (validate ที่ manual-journal.ts) */
export async function saveManualEntryAction(input: SaveManualEntryInput): Promise<ManualSaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    if (input.id) {
      if (!isUuid(input.id)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
      const scope = await getManualEntryScope(service, ctx.tenantId, input.id);
      if (!scope) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
      assertCustomerInScope(ctx, scope.customerId);
      if (scope.customerId !== input.customerId) {
        return { ok: false, message: "ลูกค้าไม่ตรงกับรายการเดิม" };
      }
    }

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    const manualInput: ManualEntryInput = {
      docType: input.docType,
      docDate: input.docDate,
      docNo: input.docNo,
      memo: input.memo,
      lines: input.lines,
    };

    const res = await upsertManualEntry(service, ctx.tenantId, input.customerId, manualInput, chartByCode, input.id);
    if (!res.ok) return { ok: false, message: res.message };

    if (input.confirm) {
      const confirmRes = await confirmManualEntry(service, ctx.tenantId, res.id);
      if (!confirmRes.ok) {
        revalidatePath(PATH);
        return { ok: false, message: confirmRes.message, id: res.id };
      }
    }

    revalidatePath(PATH);
    return { ok: true, message: input.confirm ? "บันทึกและยืนยันแล้ว" : "บันทึกร่างแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ยืนยัน manual JE (draft → confirmed) — เช็คสมดุลจาก DB อีกครั้งก่อนยืนยัน */
export async function confirmManualEntryAction(id: string, customerId: string): Promise<ManualSaveResult> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getManualEntryScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    // ⚠️ เฟส 10b (0.13) — defense-in-depth: ปฏิเสธ id ที่ผูกกับ fx revaluation (best-effort, ไม่ throw ถ้า
    //   query ล้ม — กันปุ่ม generic นี้ข้าม side-effect ที่จำเป็น เช่น สร้าง reversing อัตโนมัติตอนยืนยัน)
    try {
      if (await isRevaluationOrReversingJeId(service, ctx.tenantId, id)) {
        return { ok: false, message: FX_LOCKED_MESSAGE };
      }
    } catch {
      // query ล้ม — ปล่อยผ่าน (best-effort, ไม่ block การยืนยัน JE ปกติเพราะ query เสริมนี้พัง)
    }

    const res = await confirmManualEntry(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ยืนยันแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยืนยันไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ยกเลิกการยืนยัน (confirmed → draft) — ให้แก้ไขได้อีกครั้ง */
export async function unconfirmManualEntryAction(id: string, customerId: string): Promise<ManualSaveResult> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getManualEntryScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    // ⚠️ เฟส 10b (0.13) — เหมือน confirmManualEntryAction ข้างบน (best-effort, defense-in-depth)
    try {
      if (await isRevaluationOrReversingJeId(service, ctx.tenantId, id)) {
        return { ok: false, message: FX_LOCKED_MESSAGE };
      }
    } catch {
      // query ล้ม — ปล่อยผ่าน (best-effort)
    }

    const res = await unconfirmManualEntry(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ยกเลิกการยืนยันแล้ว — แก้ไขได้อีกครั้ง" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยกเลิกการยืนยันไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ลบ manual JE (soft-delete) — ลบได้ทั้ง draft/confirmed */
export async function deleteManualEntryAction(id: string, customerId: string): Promise<ManualSaveResult> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getManualEntryScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);

    // ⚠️ QC fix เฟส 10b — defense-in-depth (เหมือนปุ่มยืนยัน/ยกเลิกยืนยันข้างบน): ปฏิเสธการลบถ้า revaluation JE
    //   ของ cycle เดียวกันยัง confirmed อยู่จริง (ไม่ว่า id นี้จะเป็น revaluation หรือ reversing JE ของ cycle
    //   นั้น) — กันช่องโหว่ "ลบเฉพาะ reversing JE (draft) เดี่ยวๆ" ที่ทำให้ revaluation JE ตกค้างไม่ถูกกลับ
    //   รายการ (best-effort, ไม่ throw ถ้า query ล้ม — กันปุ่มลบ JE ปกติพังเพราะ query เสริมนี้ล้ม)
    try {
      if (await isFxCycleConfirmedForJe(service, ctx.tenantId, id)) {
        return { ok: false, message: FX_LOCKED_DELETE_MESSAGE };
      }
    } catch {
      // query ล้ม — ปล่อยผ่าน (best-effort)
    }

    const res = await softDeleteManualEntry(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ลบรายการแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  }
}
