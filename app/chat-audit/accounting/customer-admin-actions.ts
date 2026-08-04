"use server";

/**
 * Server actions "จัดการลูกค้า" ของหน้าลงบันทึกบัญชี
 *   1) reassignCustomerAction  — เปลี่ยนนักบัญชี/ทีมงานที่ดูแลลูกค้ารายนั้น (★ admin เท่านั้น)
 *   2) updateCustomerFieldsAction — แก้ ชื่อ / รหัสลูกค้า / เลขภาษี / ที่อยู่ (★ admin หรือ
 *      นักบัญชี/หัวหน้าที่ดูแลลูกค้ารายนั้น — assertCustomerInScope)
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
  assertCustomerInScope,
  AccountingAuthError,
  type AccountingAccess,
} from "@/lib/accounting/access";
import {
  reassignCustomerAccountant,
} from "@/lib/accounting/accountant-scope";
import { normalizeTaxId } from "@/lib/accounting/tax-id";
import { redecideExistingEntries } from "@/lib/line/bill-extract-worker";
import { pushCustomerTaxId } from "@/lib/integrations/nova-sales-outbound";
import {
  fetchCustomerFromNovaSales,
  type NovaSalesCustomerInfo,
} from "@/lib/integrations/nova-sales-query";

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
  /** ที่อยู่บริษัทลูกค้า (customers.address — migration 0058) · "" = ล้าง */
  address?: string | null;
  /** เบอร์โทรติดต่อ (customers.phone — migration 0059) · "" = ล้าง */
  phone?: string | null;
};

/**
 * แก้ไขข้อมูลลูกค้า (admin หรือ นักบัญชี/หัวหน้าที่ดูแลลูกค้ารายนั้น): ชื่อ / รหัสลูกค้า / เลขภาษี / ที่อยู่
 *   - name: ห้ามว่าง (คอลัมน์ NOT NULL)
 *   - code: unique (tenant_id, customer_code) — ชนซ้ำ → แจ้งสุภาพ (จับ error 23505)
 *   - taxId: 13 หลัก (strip ตัวคั่น) — เปลี่ยนแล้ว re-decide บิล 'รอระบุ' + ส่งกลับ NOVA Sale (best-effort)
 *   ★ อัปเดตเฉพาะช่องที่ส่งมา (undefined = ไม่แตะ)
 *   ★ สิทธิ์: admin เห็นทุกลูกค้า · นักบัญชี/หัวหน้าแก้ได้เฉพาะลูกค้าที่ตัวเองดูแล (assertCustomerInScope)
 *     — reassign ผู้ดูแล ยังเป็น admin เท่านั้น (แยก action)
 */
export async function updateCustomerFieldsAction(
  customerId: string,
  fields: UpdateCustomerFieldsInput
): Promise<SaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    if (!(await customerBelongsToTenant(service, ctx.tenantId, customerId))) {
      return { ok: false, message: "ไม่พบลูกค้าในสำนักงานนี้" };
    }
    // ★ สโคป: นักบัญชี/หัวหน้าแก้ได้เฉพาะลูกค้าที่ตัวเองดูแล (admin ผ่านทุกราย) — กันแก้ลูกค้าคนอื่น
    assertCustomerInScope(ctx, customerId);

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

    // ที่อยู่ (customers.address) — เขียนแยกแบบ best-effort (คอลัมน์เพิ่งเพิ่ม 0058)
    //   ส่ง "" = ล้างเป็น null · undefined = ไม่แตะ
    let addressProvided = false;
    let addressToWrite: string | null = null;
    if (fields.address !== undefined) {
      addressProvided = true;
      addressToWrite = fields.address === null ? null : clampText(fields.address, 500);
    }

    // เบอร์โทร (customers.phone) — เขียนแยกแบบ best-effort (คอลัมน์เพิ่งเพิ่ม 0059)
    //   ส่ง "" = ล้างเป็น null · undefined = ไม่แตะ
    let phoneProvided = false;
    let phoneToWrite: string | null = null;
    if (fields.phone !== undefined) {
      phoneProvided = true;
      phoneToWrite = fields.phone === null ? null : clampText(fields.phone, 60);
    }

    if (Object.keys(patch).length === 0 && !addressProvided && !phoneProvided) {
      return { ok: false, message: "ไม่มีข้อมูลที่ต้องบันทึก" };
    }

    // ---- อัปเดตช่องหลัก (ชื่อ/รหัส/เลขภาษี) ถ้ามี ----
    let cust: { id: string; external_ref: string | null; customer_code: string | null } | null = null;
    if (Object.keys(patch).length > 0) {
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
      cust = updated as { id: string; external_ref: string | null; customer_code: string | null };
    }

    // ---- อัปเดตที่อยู่ (best-effort — คอลัมน์ยังไม่ apply migration → จับ error เงียบ ไม่ crash) ----
    let addressFailed = false;
    if (addressProvided) {
      try {
        const { error: addrErr } = await service
          .from("customers")
          .update({ address: addressToWrite })
          .eq("id", customerId)
          .eq("tenant_id", ctx.tenantId)
          .is("deleted_at", null);
        if (addrErr) addressFailed = true;
      } catch {
        addressFailed = true; // คอลัมน์ address ยังไม่มี (ยังไม่ apply 0058)
      }
    }

    // ---- อัปเดตเบอร์โทร (best-effort — คอลัมน์ยังไม่ apply migration 0059 → จับ error เงียบ ไม่ crash) ----
    let phoneFailed = false;
    if (phoneProvided) {
      try {
        const { error: phoneErr } = await service
          .from("customers")
          .update({ phone: phoneToWrite })
          .eq("id", customerId)
          .eq("tenant_id", ctx.tenantId)
          .is("deleted_at", null);
        if (phoneErr) phoneFailed = true;
      } catch {
        phoneFailed = true; // คอลัมน์ phone ยังไม่มี (ยังไม่ apply 0059)
      }
    }

    // เลขภาษีเปลี่ยน → รักษา loop เดิม: re-decide บิล 'รอระบุ' + ส่งกลับ NOVA Sale (best-effort)
    let redecided = 0;
    if (taxIdToWrite && cust) {
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
    // ที่อยู่/เบอร์บันทึกไม่สำเร็จ (คอลัมน์ยังไม่ apply) → แจ้งเตือน แต่ช่องอื่นบันทึกแล้ว
    const addrNote = addressFailed ? " (ยังบันทึกที่อยู่ไม่ได้ — โปรด apply migration 0058)" : "";
    const phoneNote = phoneFailed ? " (ยังบันทึกเบอร์โทรไม่ได้ — โปรด apply migration 0059)" : "";
    return {
      ok: true,
      message: `บันทึกข้อมูลลูกค้าแล้ว${suffix}${addrNote}${phoneNote}`,
      id: customerId,
    };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกข้อมูลลูกค้าไม่สำเร็จ กรุณาลองใหม่" };
  }
}

// ---------------------------------------------------------------------
// (3) ดึงข้อมูลลูกค้าจาก NOVA Sales (ที่อยู่/เบอร์/ชื่อ) ด้วยเลขภาษี
// ---------------------------------------------------------------------

export type PullFromNovaSalesResult = {
  ok: boolean;
  message: string;
  /** ข้อมูลที่ดึงมาได้ (ให้ฟอร์มเติมช่องให้ผู้ใช้ตรวจแล้วกดบันทึกเอง — ★ ไม่บันทึกอัตโนมัติ) */
  data?: NovaSalesCustomerInfo;
};

/**
 * ดึงข้อมูลลูกค้าจาก NOVA Sales มาเติมในฟอร์ม (admin หรือ นักบัญชี/หัวหน้าที่ดูแลลูกค้ารายนั้น)
 *   - จับคู่ลูกค้าด้วย tax_id ที่ CX เก็บไว้ → ยิง NOVA Sales External API v1 (query client)
 *   - คืน ที่อยู่ / เบอร์ / ชื่อ ให้ฟอร์มเติมช่อง → ★ ผู้ใช้ตรวจแล้วกด "บันทึกข้อมูล" เอง
 *     (เลือกทางปลอดภัย: ไม่เขียนทับอัตโนมัติ กันข้อมูลต้นทางเพี้ยนไปทับของที่นักบัญชีแก้ไว้)
 *   - degrade อย่างสุภาพ: ไม่มีเลขภาษี / ยังไม่เปิดการเชื่อม / ไม่เจอ → แจ้งข้อความ ไม่ crash
 *   ★ PDPA: ไม่ log เลขภาษี/ชื่อ/ที่อยู่/เบอร์
 */
export async function pullCustomerFromNovaSalesAction(
  customerId: string
): Promise<PullFromNovaSalesResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    if (!(await customerBelongsToTenant(service, ctx.tenantId, customerId))) {
      return { ok: false, message: "ไม่พบลูกค้าในสำนักงานนี้" };
    }
    // ★ สโคปเดียวกับการแก้ลูกค้า: นักบัญชี/หัวหน้าดึงได้เฉพาะลูกค้าที่ตัวเองดูแล (admin ผ่านทุกราย)
    assertCustomerInScope(ctx, customerId);

    // ดึงเลขภาษีของลูกค้าเป็นกุญแจจับคู่
    const { data: cust } = await service
      .from("customers")
      .select("tax_id")
      .eq("id", customerId)
      .eq("tenant_id", ctx.tenantId)
      .is("deleted_at", null)
      .maybeSingle();

    const taxId = (cust as { tax_id: string | null } | null)?.tax_id ?? null;
    if (!taxId) {
      return {
        ok: false,
        message: "ลูกค้ารายนี้ยังไม่มีเลขภาษี — กรอกเลขภาษีก่อนจึงจะดึงจาก NOVA Sales ได้",
      };
    }

    const res = await fetchCustomerFromNovaSales(taxId);
    if (res.ok) {
      return {
        ok: true,
        message: "ดึงข้อมูลจาก NOVA Sales แล้ว — ตรวจสอบความถูกต้องแล้วกด “บันทึกข้อมูล”",
        data: res.data,
      };
    }

    // แปลงเหตุผลเป็นข้อความสุภาพต่อผู้ใช้ (ไม่เปิดเผยรายละเอียดภายใน)
    const msg =
      res.reason === "not_configured"
        ? "ยังไม่ได้เปิดการเชื่อมกับ NOVA Sales (ผู้ดูแลระบบต้องตั้งค่า NOVA_SALES_QUERY_URL และ NOVA_SALES_QUERY_API_KEY)"
        : res.reason === "unauthorized"
          ? "เชื่อมต่อ NOVA Sales ไม่ได้ (คีย์ไม่ถูกต้อง) — โปรดแจ้งผู้ดูแลระบบ"
          : res.reason === "invalid_tax_id"
            ? "เลขภาษีของลูกค้าไม่ครบ 13 หลัก จึงค้นใน NOVA Sales ไม่ได้"
            : res.reason === "not_found"
              ? "ไม่พบข้อมูลลูกค้ารายนี้ใน NOVA Sales"
              : "ดึงข้อมูลจาก NOVA Sales ไม่สำเร็จ กรุณาลองใหม่";
    return { ok: false, message: msg };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ดึงข้อมูลจาก NOVA Sales ไม่สำเร็จ กรุณาลองใหม่" };
  }
}
