"use server";

/**
 * Server actions ของหน้า "สต็อกสินค้าคงเหลือ" (/chat-audit/accounting/inventory — เฟส 8 ส่วน X, T72)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ fixed-assets/actions.ts):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess + tenantId จาก session (ไม่เชื่อ client)
 *   2) assertCustomerInScope ก่อนอ่าน/เขียนเสมอ
 *   3) deleteMovementAction — ★ derive scope จาก movement id ที่กำลังเขียนจริงเสมอ (getMovementScope ก่อน
 *      แตะ DB — ไม่เชื่อ customerId ที่ client ส่งมาแยกลำพัง ตาม pattern IDOR-safe ตั้งแต่เฟส 3 — ห้ามเกิดซ้ำ)
 *   4) productId — ★ ต้องยืนยันว่าเป็นสินค้าของ tenant นี้จริงเสมอ (assertProductInTenant) เพราะ
 *      product_stock_movements/product_opening_balances ผูก product_id เป็น FK ตรง ไม่ได้กรอง tenant ในตัว
 *      เอง (products ใช้ร่วมทุกลูกค้าในสำนักงาน แต่ต้องเป็น tenant เดียวกันเท่านั้น — กัน IDOR ข้าม tenant)
 *   5) validate ซ้ำฝั่ง server เสมอ (product-stock.ts::validateMovementInput/validateOpeningBalanceInput
 *      ผ่าน createManualAdjustment/upsertProductOpeningBalance)
 *   6) revalidatePath('/chat-audit/accounting/inventory')
 *
 * ★ 0.6 ไม่มี write path ใดกระทบบัญชีแยกประเภท/งบการเงินเลย (ชั้นติดตามจำนวน+มูลค่าคงเหลือคู่ขนานเท่านั้น)
 * ★ PDPA: ไม่ log จำนวน/มูลค่า/ชื่อสินค้า/ชื่อลูกค้า
 */
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import {
  createManualAdjustment,
  softDeleteMovement,
  getMovementScope,
  upsertProductOpeningBalance,
  listWarehouses,
  getWarehouseScope,
  getOrCreateDefaultWarehouse,
  createWarehouse,
  renameWarehouse,
  setWarehouseActive,
  createStockTransfer,
} from "@/lib/accounting/product-stock";

const PATH = "/chat-audit/accounting/inventory";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type InventorySaveResult = { ok: boolean; message: string; id?: string };

/**
 * ยืนยันว่า product_id เป็นสินค้าของ tenant นี้จริง — products ใช้ร่วมทุกลูกค้าในสำนักงานเดียวกัน (ไม่ผูก
 * customer_id) แต่ต้องเป็น tenant เดียวกันเสมอ (กัน IDOR ข้าม tenant ผ่าน product_id ที่เป็น FK ตรงไม่กรอง
 * tenant ในตัวเอง)
 */
async function assertProductInTenant(
  service: SupabaseClient,
  tenantId: string,
  productId: string
): Promise<boolean> {
  const { data } = await service
    .from("products")
    .select("id")
    .eq("id", productId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  return !!data;
}

export type CreateAdjustmentInput = {
  customerId: string;
  productId: string;
  movementType: "adjustment_in" | "adjustment_out";
  quantity: unknown;
  unitCost?: unknown;
  movementDate: unknown;
  memo?: unknown;
  /** wishlist ข้อ 8 — ไม่ระบุ/ไม่ใช่ของลูกค้ารายนี้ → fallback เป็นคลังหลักของลูกค้าอัตโนมัติ */
  warehouseId?: unknown;
};

/** บันทึกปรับปรุงสต็อกมือ (สินค้าเสียหาย/นับสต็อกจริงต่างจากระบบ ฯลฯ) */
export async function createAdjustmentAction(input: CreateAdjustmentInput): Promise<InventorySaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    if (!isUuid(input.productId)) return { ok: false, message: "ไม่พบสินค้าที่เลือก" };
    if (!(await assertProductInTenant(service, ctx.tenantId, input.productId))) {
      return { ok: false, message: "ไม่พบสินค้าที่เลือก" };
    }

    // ★ ไม่เชื่อ warehouseId ที่ client ส่งมาลำพัง — ต้องเป็นคลังของลูกค้ารายนี้จริงเสมอ (0.13)
    let warehouseId: string | null = null;
    if (isUuid(input.warehouseId)) {
      const scope = await getWarehouseScope(service, ctx.tenantId, input.warehouseId);
      if (scope && scope.customerId === input.customerId) warehouseId = input.warehouseId;
    }
    if (!warehouseId) {
      warehouseId = await getOrCreateDefaultWarehouse(service, ctx.tenantId, input.customerId);
      if (!warehouseId) return { ok: false, message: "สร้างคลังหลักของลูกค้าไม่สำเร็จ กรุณาลองใหม่" };
    }

    const res = await createManualAdjustment(service, ctx.tenantId, input.customerId, input.productId, {
      movementType: input.movementType,
      quantity: input.quantity,
      unitCost: input.unitCost,
      movementDate: input.movementDate,
      memo: input.memo,
      warehouseId,
    });
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "บันทึกปรับปรุงสต็อกแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * ยกเลิกรายการเคลื่อนไหวสต็อก (soft-delete — 0.9 ใช้ตอนบิลต้นทางถูกแก้/ยกเลิกยืนยันหลังสร้าง movement
 *   ไปแล้ว หรือปรับปรุงมือผิด) — ★ derive scope จาก movement id ที่กำลังเขียนจริงเสมอ (0.13)
 */
export async function deleteMovementAction(movementId: string, customerId: string): Promise<InventorySaveResult> {
  if (!isUuid(movementId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    // ★ ไม่เชื่อ customerId ที่ client ส่งมาลำพัง — โหลด scope จริงของ movement นี้จาก DB ก่อนเสมอ (0.13)
    const scope = await getMovementScope(service, ctx.tenantId, movementId);
    if (!scope) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับรายการเดิม" };

    const res = await softDeleteMovement(service, ctx.tenantId, movementId);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "ยกเลิกรายการสต็อกแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยกเลิกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

export type UpsertOpeningBalanceInput = {
  customerId: string;
  productId: string;
  quantity: unknown;
  unitCost: unknown;
  note?: unknown;
};

/** ตั้ง/แก้ยอดยกมาสต็อกของสินค้า 1 ตัวของลูกค้า (0.11) */
export async function upsertOpeningBalanceAction(input: UpsertOpeningBalanceInput): Promise<InventorySaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    if (!isUuid(input.productId)) return { ok: false, message: "ไม่พบสินค้าที่เลือก" };
    if (!(await assertProductInTenant(service, ctx.tenantId, input.productId))) {
      return { ok: false, message: "ไม่พบสินค้าที่เลือก" };
    }

    const res = await upsertProductOpeningBalance(service, ctx.tenantId, input.customerId, input.productId, {
      quantity: input.quantity,
      unitCost: input.unitCost,
      note: input.note,
    });
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "บันทึกยอดยกมาแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

// =========================================================================
// คลังสินค้า (Warehouses) — wishlist ข้อ 8
// =========================================================================

/** สร้างคลังใหม่ของลูกค้า 1 ราย */
export async function createWarehouseAction(customerId: string, name: unknown): Promise<InventorySaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, customerId);

    const res = await createWarehouse(service, ctx.tenantId, customerId, { name });
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "เพิ่มคลังแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "เพิ่มคลังไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** เปลี่ยนชื่อคลัง — ★ derive scope จาก warehouse id ที่กำลังเขียนจริงเสมอ (0.13) */
export async function renameWarehouseAction(warehouseId: string, customerId: string, name: unknown): Promise<InventorySaveResult> {
  if (!isUuid(warehouseId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบคลังที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getWarehouseScope(service, ctx.tenantId, warehouseId);
    if (!scope) return { ok: false, message: "ไม่พบคลัง (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับคลังเดิม" };

    const res = await renameWarehouse(service, ctx.tenantId, warehouseId, { name });
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "เปลี่ยนชื่อคลังแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "เปลี่ยนชื่อไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** เปิด/ปิดใช้งานคลัง — ★ derive scope จาก warehouse id ที่กำลังเขียนจริงเสมอ (0.13) */
export async function setWarehouseActiveAction(
  warehouseId: string,
  customerId: string,
  isActive: boolean
): Promise<InventorySaveResult> {
  if (!isUuid(warehouseId) || !isUuid(customerId)) return { ok: false, message: "ไม่พบคลังที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getWarehouseScope(service, ctx.tenantId, warehouseId);
    if (!scope) return { ok: false, message: "ไม่พบคลัง (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับคลังเดิม" };

    const res = await setWarehouseActive(service, ctx.tenantId, warehouseId, isActive);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: isActive ? "เปิดใช้งานคลังแล้ว" : "ปิดใช้งานคลังแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

export type CreateTransferInput = {
  customerId: string;
  productId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: unknown;
  movementDate: unknown;
  memo?: unknown;
};

/** โอนสินค้าระหว่างคลัง 1 สินค้า (wishlist ข้อ 8) — ต้นทุนเฉลี่ยรวมของสินค้าไม่เปลี่ยน (ดู product-stock.ts) */
export async function createTransferAction(input: CreateTransferInput): Promise<InventorySaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    if (!isUuid(input.productId)) return { ok: false, message: "ไม่พบสินค้าที่เลือก" };
    if (!(await assertProductInTenant(service, ctx.tenantId, input.productId))) {
      return { ok: false, message: "ไม่พบสินค้าที่เลือก" };
    }

    if (!isUuid(input.fromWarehouseId) || !isUuid(input.toWarehouseId)) {
      return { ok: false, message: "กรุณาเลือกคลังต้นทางและปลายทาง" };
    }
    // ★ ไม่เชื่อ warehouse id ที่ client ส่งมาลำพัง — ต้องเป็นคลังของลูกค้ารายนี้จริงทั้งคู่ (0.13)
    const [fromScope, toScope] = await Promise.all([
      getWarehouseScope(service, ctx.tenantId, input.fromWarehouseId),
      getWarehouseScope(service, ctx.tenantId, input.toWarehouseId),
    ]);
    if (!fromScope || fromScope.customerId !== input.customerId) {
      return { ok: false, message: "ไม่พบคลังต้นทางที่เลือก" };
    }
    if (!toScope || toScope.customerId !== input.customerId) {
      return { ok: false, message: "ไม่พบคลังปลายทางที่เลือก" };
    }

    const res = await createStockTransfer(service, ctx.tenantId, input.customerId, input.productId, {
      fromWarehouseId: input.fromWarehouseId,
      toWarehouseId: input.toWarehouseId,
      quantity: input.quantity,
      movementDate: input.movementDate,
      memo: input.memo,
    });
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "โอนสินค้าระหว่างคลังแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "โอนสินค้าไม่สำเร็จ กรุณาลองใหม่" };
  }
}
