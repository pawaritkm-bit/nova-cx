"use server";

/**
 * Server actions ของหน้า "ทะเบียนทรัพย์สินถาวร" (/chat-audit/accounting/fixed-assets — เฟส 7 ส่วน V)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ recurring-journal/actions.ts):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess (admin/lead เห็นทุกลูกค้า ·
 *      accountant เฉพาะลูกค้าที่ตัวเองดูแล) + tenantId จาก session (ไม่เชื่อ client)
 *   2) assertCustomerInScope ทุกครั้งก่อนอ่าน/เขียน (ทั้ง customerId ที่ client ส่งมา และ customerId
 *      จริงของทรัพย์สินเดิมที่โหลดจาก DB ผ่าน getAssetScope — derive scope จาก resource id ที่กำลังเขียน
 *      จริงเสมอ ตาม pattern IDOR-safe ที่ใช้มาตั้งแต่เฟส 3 — ห้ามเชื่อ customerId ที่ client ส่งมาแยกลำพัง)
 *   3) validate ซ้ำฝั่ง server เสมอ (fixed-assets.ts::validateFixedAssetInput ผ่าน upsertAsset)
 *   4) revalidatePath('/chat-audit/accounting/fixed-assets')
 *
 * ★ 0.3/0.4 ปุ่ม "สร้างค่าเสื่อมตอนนี้" (generateNowAction) — บังคับ `today` = todayIsoThai() ฝั่ง server
 *   เสมอ ไม่มีทางรับค่าจาก client input เด็ดขาด (กันแก้วันที่เครื่อง/ปลอมวันที่แล้วสร้างย้อนหลัง/ล่วงหน้า)
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า (ไม่มี console.* ที่นี่)
 *
 * หมายเหตุสโคป: disposeAssetAction/undisposeAssetAction (เฟส 7-W, 0.7/0.8) — derive scope จาก asset id
 *   ที่กำลังเขียนจริงเสมอเหมือน action อื่น ๆ ในไฟล์นี้ (getAssetScope ก่อนแตะ DB เสมอ)
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
  upsertAsset,
  softDeleteAsset,
  getAssetScope,
  generateOne,
  disposeAsset,
  undisposeAsset,
  type FixedAssetInput,
  type DisposeAssetInput,
} from "@/lib/accounting/fixed-assets";
import { todayIsoThai } from "@/lib/accounting/recurring-journal";

const PATH = "/chat-audit/accounting/fixed-assets";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type FixedAssetSaveResult = { ok: boolean; message: string; id?: string };

export type SaveAssetInput = {
  /** มี id = แก้ทะเบียนเดิม · ไม่มี = สร้างใหม่ */
  id?: string;
  customerId: string;
  name: unknown;
  assetAccountCode: unknown;
  accumDepAccountCode: unknown;
  depExpenseAccountCode: unknown;
  acquisitionDate: unknown;
  cost: unknown;
  salvageValue: unknown;
  usefulLifeMonths: unknown;
};

/** บันทึกทะเบียนทรัพย์สิน (สร้างใหม่/แก้ไข) — validate ผิด/หมวดบัญชีผิด/ล็อกแก้ (มีประวัติแล้ว) → ปฏิเสธ */
export async function upsertAssetAction(input: SaveAssetInput): Promise<FixedAssetSaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    if (input.id) {
      if (!isUuid(input.id)) return { ok: false, message: "ไม่พบทรัพย์สินที่เลือก" };
      // ★ derive scope จาก asset id ที่กำลังเขียนจริงเสมอ (ไม่เชื่อ customerId จาก client ลำพัง — 0.13)
      const scope = await getAssetScope(service, ctx.tenantId, input.id);
      if (!scope) return { ok: false, message: "ไม่พบทรัพย์สิน (อาจถูกลบไปแล้ว)" };
      assertCustomerInScope(ctx, scope.customerId);
      if (scope.customerId !== input.customerId) {
        return { ok: false, message: "ลูกค้าไม่ตรงกับทรัพย์สินเดิม" };
      }
    }

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    const assetInput: FixedAssetInput = {
      name: input.name,
      assetAccountCode: input.assetAccountCode,
      accumDepAccountCode: input.accumDepAccountCode,
      depExpenseAccountCode: input.depExpenseAccountCode,
      acquisitionDate: input.acquisitionDate,
      cost: input.cost,
      salvageValue: input.salvageValue,
      usefulLifeMonths: input.usefulLifeMonths,
    };

    const res = await upsertAsset(service, ctx.tenantId, input.customerId, assetInput, chartByCode, input.id);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "บันทึกทะเบียนทรัพย์สินแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ลบทะเบียนทรัพย์สิน (soft-delete) — ปฏิเสธถ้ามีประวัติค่าเสื่อมแล้ว (0.12) */
export async function deleteAssetAction(id: string, customerId: string): Promise<FixedAssetSaveResult> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบทรัพย์สินที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    // ★ derive scope จาก asset id ที่กำลังเขียนจริงเสมอ (0.13)
    const scope = await getAssetScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบทรัพย์สิน (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับทรัพย์สินเดิม" };

    const res = await softDeleteAsset(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ลบทะเบียนทรัพย์สินแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * สร้างค่าเสื่อม "ตอนนี้" ของทรัพย์สิน 1 ชิ้น (ปุ่ม "สร้างค่าเสื่อมตอนนี้")
 *   ★ 0.3/0.4 DoD: `today` = todayIsoThai() เสมอ (คำนวณฝั่ง server เท่านั้น) — ไม่รับจาก client
 *   ทรัพย์สินยังไม่ถึงรอบ (next_dep_date > today) → claim ไม่ติด → คืน skipped (แจ้งผู้ใช้เฉย ๆ ไม่ throw)
 */
export async function generateNowAction(id: string, customerId: string): Promise<FixedAssetSaveResult> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบทรัพย์สินที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    // ★ derive scope จาก asset id ที่กำลังเขียนจริงเสมอ (0.13)
    const scope = await getAssetScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบทรัพย์สิน (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับทรัพย์สินเดิม" };

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    // ★ วันที่ปัจจุบันจริงเสมอ — ไม่รับ "today" จาก client input เด็ดขาด (ป้องกันสร้างย้อนหลัง/ล่วงหน้าผิดปกติ)
    const today = todayIsoThai();
    const res = await generateOne(service, ctx.tenantId, id, today, chartByCode);

    revalidatePath(PATH);
    if (res.status === "generated") {
      return { ok: true, message: "สร้างรายการค่าเสื่อม (ร่าง) สำเร็จ — ไปยืนยันที่หน้าลงบันทึกบัญชีเอง" };
    }
    if (res.status === "failed") {
      return { ok: false, message: res.message };
    }
    return { ok: false, message: "ทรัพย์สินนี้ยังไม่ถึงกำหนดรอบถัดไป (หรือตัดค่าเสื่อมครบแล้ว) — ยังไม่สร้างอะไร" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "สร้างรายการไม่สำเร็จ กรุณาลองใหม่" };
  }
}

export type DisposeAssetPayload = {
  disposalDate: unknown;
  proceeds: unknown;
  cashAccountCode: unknown;
  gainLossAccountCode: unknown;
};

/**
 * จำหน่ายทรัพย์สิน (เฟส 7 ส่วน W, 0.7) — คำนวณ NBV+กำไร/ขาดทุน สร้าง manual JE (draft เสมอ) แล้วตั้ง
 *   status='disposed' ★ derive scope จาก asset id ที่กำลังเขียนจริงเสมอ (ไม่เชื่อ customerId จาก client
 *   ลำพัง — 0.13) เหมือน action อื่น ๆ ในไฟล์นี้
 */
export async function disposeAssetAction(
  id: string,
  customerId: string,
  input: DisposeAssetPayload
): Promise<FixedAssetSaveResult> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบทรัพย์สินที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    // ★ derive scope จาก asset id ที่กำลังเขียนจริงเสมอ (0.13)
    const scope = await getAssetScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบทรัพย์สิน (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับทรัพย์สินเดิม" };

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    const disposeInput: DisposeAssetInput = {
      disposalDate: input.disposalDate,
      proceeds: input.proceeds,
      cashAccountCode: input.cashAccountCode,
      gainLossAccountCode: input.gainLossAccountCode,
    };

    const res = await disposeAsset(service, ctx.tenantId, customerId, id, disposeInput, chartByCode);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "จำหน่ายทรัพย์สินแล้ว (ร่าง) — ไปยืนยันที่หน้าลงบันทึกบัญชีเอง", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "จำหน่ายทรัพย์สินไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * ยกเลิกการจำหน่ายทรัพย์สิน (เฟส 7 ส่วน W, 0.8) — ทำได้เฉพาะ manual JE ที่สร้างไว้ตอนจำหน่ายยัง draft
 *   (ยังไม่ confirm) — ปฏิเสธชัดเจนถ้า confirmed แล้ว (ต้องยกเลิกยืนยัน JE ก่อน)
 */
export async function undisposeAssetAction(id: string, customerId: string): Promise<FixedAssetSaveResult> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบทรัพย์สินที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    // ★ derive scope จาก asset id ที่กำลังเขียนจริงเสมอ (0.13)
    const scope = await getAssetScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบทรัพย์สิน (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับทรัพย์สินเดิม" };

    const res = await undisposeAsset(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "ยกเลิกการจำหน่ายทรัพย์สินแล้ว — กลับเป็นใช้งานอยู่ปกติ", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยกเลิกการจำหน่ายไม่สำเร็จ กรุณาลองใหม่" };
  }
}
