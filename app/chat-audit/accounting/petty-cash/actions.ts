"use server";

/**
 * Server actions ของหน้า "เงินสดย่อย" (/chat-audit/accounting/petty-cash — wishlist ข้อ 3)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ payroll-employees/actions.ts):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess + tenantId จาก session
 *   2) assertCustomerInScope ทุกครั้งก่อนอ่าน/เขียน — derive scope จาก resource id ที่กำลังเขียนจริง
 *      (getVoucherScope) ไม่เชื่อ customerId ที่ client ส่งมาลำพัง
 *   3) validate ซ้ำฝั่ง server เสมอ (petty-cash.ts)
 *   4) revalidatePath('/chat-audit/accounting/petty-cash')
 *
 * ★ settleVouchersAction สร้าง manual JE เป็น "ดราฟต์" เสมอ ไม่เคย auto-ยืนยัน (mirror
 *   platform-report-actions.ts::createPlatformReportDraftJournalEntryAction) — นักบัญชีต้องไปตรวจสอบ/
 *   ยืนยันเองที่หน้า "ลงบันทึกบัญชีเอง" ก่อนจึงมีผลกับยอดบัญชีจริง
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import {
  upsertFund,
  getOrCreateDefaultFund,
  createVoucher,
  softDeleteVoucher,
  getVoucherScope,
  listVouchers,
  buildSettlementJournalEntryInput,
  type PettyCashFundInput,
  type PettyCashVoucherInput,
} from "@/lib/accounting/petty-cash";
import { upsertManualEntry } from "@/lib/accounting/manual-journal";

const PATH = "/chat-audit/accounting/petty-cash";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export type PettyCashSaveResult = { ok: boolean; message: string; id?: string };

export type SaveFundInput = { customerId: string } & PettyCashFundInput;

/** บันทึกตั้งค่ากองทุนเงินสดย่อย (upsert ตาม unique tenant+customer) */
export async function upsertFundAction(input: SaveFundInput): Promise<PettyCashSaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    const res = await upsertFund(service, ctx.tenantId, input.customerId, input, chartByCode);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "บันทึกตั้งค่ากองทุนแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

export type SaveVoucherInput = { customerId: string; fundId: string } & PettyCashVoucherInput;

/** เพิ่มใบเบิกเงินสดย่อย 1 ใบ (status='pending' เสมอ) */
export async function createVoucherAction(input: SaveVoucherInput): Promise<PettyCashSaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!isUuid(input.customerId) || !isUuid(input.fundId)) return { ok: false, message: "ไม่พบกองทุนที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    const res = await createVoucher(service, ctx.tenantId, input.customerId, input.fundId, input, chartByCode);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "เพิ่มใบเบิกแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "เพิ่มใบเบิกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ลบใบเบิก (soft-delete) — เฉพาะที่ยัง pending เท่านั้น (validate ซ้ำใน softDeleteVoucher) */
export async function deleteVoucherAction(id: string, customerId: string): Promise<PettyCashSaveResult> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบใบเบิกที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    // ★ derive scope จาก voucher id ที่กำลังเขียนจริงเสมอ (ไม่เชื่อ customerId จาก client ลำพัง, IDOR-safe)
    const scope = await getVoucherScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบใบเบิก (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับใบเบิกเดิม" };

    const res = await softDeleteVoucher(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ลบใบเบิกแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * เคลียร์เงินสดย่อย — รวมใบเบิกที่เลือก (ต้อง pending + อยู่ในกองทุน/ลูกค้าเดียวกันเท่านั้น) เป็น manual JE
 *   เดียว (ดราฟต์เสมอ ไม่เคย auto-ยืนยัน) แล้วเปลี่ยนสถานะใบเบิกเป็น 'settled' ผูกกับ JE ที่สร้าง
 */
export async function settleVouchersAction(input: {
  customerId: string;
  fundId: string;
  voucherIds: string[];
  docDate: string;
}): Promise<PettyCashSaveResult> {
  if (!isUuid(input.customerId) || !isUuid(input.fundId)) return { ok: false, message: "ไม่พบกองทุนที่เลือก" };
  if (!Array.isArray(input.voucherIds) || input.voucherIds.length === 0) {
    return { ok: false, message: "กรุณาเลือกใบเบิกอย่างน้อย 1 ใบ" };
  }
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, input.customerId);

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    // ★ โหลดกองทุนจริงจาก DB ตรง ๆ (ไม่เชื่อ float/บัญชีที่ client อาจส่งมา) — ถ้ามีอยู่แล้วคืนของจริงเสมอ
    const fund = await getOrCreateDefaultFund(service, ctx.tenantId, input.customerId);
    if (fund.id !== input.fundId) return { ok: false, message: "กองทุนไม่ตรงกับที่เลือก กรุณาลองใหม่" };

    // ★ โหลดใบเบิกจริงจาก DB (ไม่เชื่อยอด/สถานะที่ client อาจส่งมาพร้อม voucherIds) — กรองเฉพาะที่ระบุ +
    //   ต้อง pending จริง (ป้องกันเคลียร์ใบที่ settled ไปแล้วซ้ำ)
    const allPending = await listVouchers(service, ctx.tenantId, input.customerId, input.fundId, chartByCode, {
      status: "pending",
    });
    const selectedIds = new Set(input.voucherIds);
    const selected = allPending.filter((v) => selectedIds.has(v.id));
    if (selected.length === 0) {
      return { ok: false, message: "ใบเบิกที่เลือกไม่พบ หรือถูกเคลียร์ไปแล้ว กรุณาลองใหม่" };
    }

    const built = buildSettlementJournalEntryInput(fund, selected, input.docDate);
    if (!built.ok) return { ok: false, message: built.message };

    const jeRes = await upsertManualEntry(service, ctx.tenantId, input.customerId, built.value, chartByCode);
    if (!jeRes.ok) return { ok: false, message: jeRes.message };

    const nowIso = new Date().toISOString();
    const { data: updatedRows, error: updateErr } = await service
      .from("petty_cash_vouchers")
      .update({ status: "settled", settled_je_id: jeRes.id, settled_at: nowIso })
      .in(
        "id",
        selected.map((v) => v.id)
      )
      .eq("tenant_id", ctx.tenantId)
      .eq("status", "pending") // ★ กัน TOCTOU — re-assert pending ตรง statement UPDATE เอง
      .is("deleted_at", null)
      .select("id");
    if (updateErr) {
      return {
        ok: false,
        message: `สร้างสมุดรายวันสำเร็จแล้ว (เลขที่อ้างอิง ${jeRes.id}) แต่อัปเดตสถานะใบเบิกไม่สำเร็จ — กรุณาไปตรวจสอบที่หน้าลงบันทึกบัญชีเอง`,
      };
    }

    // ★ จำนวนแถวที่ถูกอัปเดตจริงต้องตรงกับที่เลือกทั้งหมดเท่านั้น — ยอด Dr/Cr ใน JE ที่สร้างไปแล้วข้างบน
    //   ถูกคำนวณจาก `selected` ทั้งชุดตายตัว (baked in ก่อน UPDATE) ถ้าอัปเดตได้ไม่ครบ (ไม่ว่า 0 หรือบางส่วน
    //   — เช่นมีอีกรีเควสต์มา settle ใบที่ทับกันไปก่อนระหว่างนี้) แสดงว่ามีใบเบิกบางใบถูกผูกกับ JE อื่นไปแล้ว
    //   แต่ยอดของใบนั้นยังถูกรวมอยู่ใน JE นี้ด้วย — เกิด double-count ถ้าถือว่าสำเร็จบางส่วน จึงต้องถือว่า
    //   ล้มเหลวทั้งหมดเสมอเมื่อไม่ครบ ไม่มี "สำเร็จบางส่วน" ให้ผู้ใช้ไปตรวจ/ลบดราฟต์ที่สร้างไปแล้วเอง
    const settledCount = (updatedRows ?? []).length;
    if (settledCount !== selected.length) {
      return {
        ok: false,
        message: `ใบเบิกบางส่วนที่เลือกถูกเคลียร์ไปแล้วโดยการทำรายการอื่นระหว่างนี้ — สร้างดราฟต์ JE ขึ้นมาแล้วแต่ยอดไม่ตรง (เลขที่อ้างอิง ${jeRes.id}) กรุณาไปตรวจสอบและลบดราฟต์นี้ที่หน้าลงบันทึกบัญชีเอง แล้วลองเคลียร์ใหม่`,
      };
    }

    revalidatePath(PATH);
    revalidatePath("/chat-audit/accounting/journal-entry");
    return {
      ok: true,
      message: `เคลียร์เงินสดย่อย ${settledCount} ใบแล้ว (สร้างดราฟต์ JE รอยืนยัน)`,
      id: jeRes.id,
    };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "เคลียร์เงินสดย่อยไม่สำเร็จ กรุณาลองใหม่" };
  }
}
