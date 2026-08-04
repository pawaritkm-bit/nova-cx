"use server";

/**
 * Server actions "จัดการลูกค้า (admin เท่านั้น)" ของหน้าลงบันทึกบัญชี
 *   1) reassignCustomerAction  — เปลี่ยนนักบัญชี/ทีมงานที่ดูแลลูกค้ารายนั้น
 *   2) updateCustomerFieldsAction — แก้ ชื่อ / รหัสลูกค้า / เลขภาษี ของลูกค้า
 *
 * flow ความปลอดภัย (ยึดมาตรฐาน write path เดียวกับ actions.ts/share-circle-actions.ts):
 *   1) requireAccountingAccess (สิทธิ์จาก session จริง) + tenantId จาก session
 *   2) ★ admin เท่านั้น (ctx.mode === "admin") — นักบัญชี/หัวหน้าทำไม่ได้ (defense-in-depth
 *      นอกเหนือจากการที่ปุ่ม render เฉพาะ admin)
 *   3) validate อินพุตทุกตัว (uuid / 13 หลัก / ความยาว) ก่อนเขียน
 *   4) ยืนยัน customer + employee อยู่ใน tenant เดียวกัน (กันยิงข้ามเทแนนต์)
 *   5) เขียนผ่าน service-role client + tenantId จาก session → revalidatePath
 *
 * ★ ไม่แตะ scope logic เดิม: reassign เขียนที่ chat_groups.responsible_employee_id
 *   (source of truth เดียวกับที่ customerIdsForAccountant/สโคปนักบัญชีใช้)
 * ★ PDPA: ไม่ log ชื่อ/รหัส/เลขภาษีลูกค้า (ไม่มี console.* ที่นี่)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  AccountingAuthError,
  type AccountingAccess,
} from "@/lib/accounting/access";
import {
  reassignCustomerAccountant,
} from "@/lib/accounting/accountant-scope";
import { normalizeTaxId } from "@/lib/accounting/tax-id";
import { redecideExistingEntries } from "@/lib/line/bill-extract-worker";
import { pushCustomerTaxId } from "@/lib/integrations/nova-sales-outbound";

const PATH = "/chat-audit/accounting";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ตัด/trim ข้อความ + จำกัดความยาว — คืน null ถ้าว่าง */
function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

export type SaveResult = {
  ok: boolean;
  message: string;
  id?: string;
};

/** guard: ต้องเป็น admin จริง (ไม่ใช่นักบัญชี/หัวหน้า) — คืน access หรือ throw */
async function requireAdmin(): Promise<{
  ctx: AccountingAccess;
  service: ReturnType<typeof createServiceRoleClient>;
}> {
  const authed = await createClient();
  const service = createServiceRoleClient();
  const ctx = await requireAccountingAccess(authed, service);
  if (ctx.mode !== "admin") {
    throw new AccountingAuthError("เฉพาะผู้ดูแลระบบเท่านั้นที่ทำรายการนี้ได้");
  }
  return { ctx, service };
}

/** ยืนยันลูกค้าอยู่ใน tenant นี้จริง (defense-in-depth — admin scope ผ่านทุก uuid) */
async function customerBelongsToTenant(
  service: ReturnType<typeof createServiceRoleClient>,
  tenantId: string,
  customerId: string
): Promise<boolean> {
  const { data } = await service
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  return !!data;
}

/** ยืนยัน employee เป็น "นักบัญชี active" ใน tenant นี้ (กัน reassign ให้คนนอก/คนถูกปิด) */
async function accountantBelongsToTenant(
  service: ReturnType<typeof createServiceRoleClient>,
  tenantId: string,
  employeeId: string
): Promise<boolean> {
  const { data } = await service
    .from("employees")
    .select("id")
    .eq("id", employeeId)
    .eq("tenant_id", tenantId)
    .eq("employee_type", "accountant")
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();
  return !!data;
}

// ---------------------------------------------------------------------
// (1) reassign ผู้ดูแลลูกค้า → นักบัญชีคนใหม่
// ---------------------------------------------------------------------

/**
 * เปลี่ยนนักบัญชีที่ดูแลลูกค้ารายนี้ (admin)
 *   → อัปเดต responsible_employee_id ของทุกกลุ่มไลน์ของลูกค้ารายนั้น
 *   ★ ลูกค้าที่ยังไม่มีกลุ่มไลน์ผูก → เปลี่ยนผู้ดูแลไม่ได้ (แจ้งสุภาพ)
 */
export async function reassignCustomerAction(
  customerId: string,
  employeeId: string
): Promise<SaveResult> {
  try {
    const { ctx, service } = await requireAdmin();

    if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    if (!isUuid(employeeId)) return { ok: false, message: "กรุณาเลือกนักบัญชีที่จะมอบหมาย" };

    if (!(await customerBelongsToTenant(service, ctx.tenantId, customerId))) {
      return { ok: false, message: "ไม่พบลูกค้าในสำนักงานนี้" };
    }
    if (!(await accountantBelongsToTenant(service, ctx.tenantId, employeeId))) {
      return { ok: false, message: "นักบัญชีที่เลือกไม่ถูกต้อง (ไม่ใช่นักบัญชีที่ใช้งานอยู่)" };
    }

    const res = await reassignCustomerAccountant(service, ctx.tenantId, customerId, employeeId);
    if (!res.ok) {
      return { ok: false, message: "เปลี่ยนผู้ดูแลไม่สำเร็จ กรุณาลองใหม่" };
    }
    if (res.updated === 0) {
      return {
        ok: false,
        message: "ลูกค้ารายนี้ยังไม่มีกลุ่มไลน์ที่ผูกไว้ จึงกำหนดผู้ดูแลไม่ได้",
      };
    }

    revalidatePath(PATH);
    return {
      ok: true,
      message: `เปลี่ยนผู้ดูแลแล้ว (${res.updated.toLocaleString("th-TH")} กลุ่ม)`,
      id: customerId,
    };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "เปลี่ยนผู้ดูแลไม่สำเร็จ กรุณาลองใหม่" };
  }
}

// ---------------------------------------------------------------------
// (2) แก้ไขข้อมูลลูกค้า — ชื่อ / รหัส / เลขภาษี
// ---------------------------------------------------------------------

export type UpdateCustomerFieldsInput = {
  name?: string | null;
  /** รหัสลูกค้า (customer_code) — unique ต่อ tenant */
  code?: string | null;
  taxId?: string | null;
};

/**
 * แก้ไขข้อมูลลูกค้า (admin): ชื่อ / รหัสลูกค้า / เลขภาษี
 *   - name: ห้ามว่าง (คอลัมน์ NOT NULL)
 *   - code: unique (tenant_id, customer_code) — ชนซ้ำ → แจ้งสุภาพ (จับ error 23505)
 *   - taxId: 13 หลัก (strip ตัวคั่น) — เปลี่ยนแล้ว re-decide บิล 'รอระบุ' + ส่งกลับ NOVA Sale (best-effort)
 *   ★ อัปเดตเฉพาะช่องที่ส่งมา (undefined = ไม่แตะ)
 */
export async function updateCustomerFieldsAction(
  customerId: string,
  fields: UpdateCustomerFieldsInput
): Promise<SaveResult> {
  try {
    const { ctx, service } = await requireAdmin();

    if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    if (!(await customerBelongsToTenant(service, ctx.tenantId, customerId))) {
      return { ok: false, message: "ไม่พบลูกค้าในสำนักงานนี้" };
    }

    const patch: Record<string, unknown> = {};

    // ชื่อ (ถ้าส่งมา ต้องไม่ว่าง — คอลัมน์ NOT NULL)
    if (fields.name !== undefined) {
      const name = clampText(fields.name, 200);
      if (!name) return { ok: false, message: "ชื่อลูกค้าห้ามว่าง" };
      patch.name = name;
    }

    // รหัสลูกค้า (ส่ง "" = ล้างเป็น null ได้)
    if (fields.code !== undefined) {
      patch.customer_code = fields.code === null ? null : clampText(fields.code, 60);
    }

    // เลขภาษี — validate 13 หลัก; ค่าที่จะเขียน (null = ล้าง)
    let taxIdToWrite: string | null | undefined;
    if (fields.taxId !== undefined) {
      const raw = typeof fields.taxId === "string" ? fields.taxId.trim() : "";
      if (raw === "") {
        taxIdToWrite = null; // ล้างเลขภาษี
      } else {
        const norm = normalizeTaxId(raw);
        if (!norm) return { ok: false, message: "เลขภาษีต้องเป็นตัวเลข 13 หลัก" };
        taxIdToWrite = norm;
      }
      patch.tax_id = taxIdToWrite;
    }

    if (Object.keys(patch).length === 0) {
      return { ok: false, message: "ไม่มีข้อมูลที่ต้องบันทึก" };
    }

    const { data: updated, error } = await service
      .from("customers")
      .update(patch)
      .eq("id", customerId)
      .eq("tenant_id", ctx.tenantId)
      .is("deleted_at", null)
      .select("id, external_ref, customer_code")
      .maybeSingle();

    if (error) {
      // ชนรหัสซ้ำ (unique tenant_id, customer_code)
      if (error.code === "23505") {
        return { ok: false, message: "รหัสลูกค้านี้ถูกใช้กับลูกค้ารายอื่นแล้ว" };
      }
      return { ok: false, message: "บันทึกข้อมูลลูกค้าไม่สำเร็จ กรุณาลองใหม่" };
    }
    if (!updated) {
      return { ok: false, message: "ไม่พบลูกค้าที่จะแก้ไข" };
    }
    const cust = updated as {
      id: string;
      external_ref: string | null;
      customer_code: string | null;
    };

    // เลขภาษีเปลี่ยน → รักษา loop เดิม: re-decide บิล 'รอระบุ' + ส่งกลับ NOVA Sale (best-effort)
    let redecided = 0;
    if (taxIdToWrite) {
      try {
        const r = await redecideExistingEntries(service, ctx.tenantId, { customerId });
        redecided = r.updated;
      } catch {
        // ล้ม ไม่ให้ทั้ง action พัง — cron redecide รอบถัดไปตามเก็บ
      }
      await pushCustomerTaxId({
        externalRef: cust.external_ref,
        customerCode: cust.customer_code,
        taxId: taxIdToWrite,
      });
    }

    revalidatePath(PATH);
    const suffix = redecided > 0 ? ` · จับคู่ซื้อ/ขายให้ ${redecided} รายการแล้ว` : "";
    return { ok: true, message: `บันทึกข้อมูลลูกค้าแล้ว${suffix}`, id: customerId };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกข้อมูลลูกค้าไม่สำเร็จ กรุณาลองใหม่" };
  }
}
