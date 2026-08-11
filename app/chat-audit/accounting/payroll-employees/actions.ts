"use server";

/**
 * Server actions ของหน้า "ทะเบียนพนักงาน/ตั้งค่าเงินเดือน" (/chat-audit/accounting/payroll-employees —
 *   เฟส 9 ส่วน AC)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ fixed-assets/actions.ts, IDOR-safe 0.15):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess + tenantId จาก session (ไม่เชื่อ client)
 *   2) assertCustomerInScope ทุกครั้งก่อนอ่าน/เขียน — derive scope จาก resource id ที่กำลังเขียนจริง
 *      (getEmployeeScope) ไม่เชื่อ customerId ที่ client ส่งมาลำพัง
 *   3) validate ซ้ำฝั่ง server เสมอ (payroll-employees.ts/payroll-settings.ts)
 *   4) revalidatePath('/chat-audit/accounting/payroll-employees')
 *
 * ★ 0.12 PDPA: revealIdCardAction เป็นจุดเดียวที่คืนเลขบัตรประชาชนเต็มให้ client (กดปุ่ม "เผยเลขเต็ม"
 *   ต่อแถวเอง) — ไม่ auto-reveal ทั้งตาราง, ไม่ log เลขเต็มที่ไหนในไฟล์นี้
 * ★ 0.2 ทุก import พนักงานในไฟล์นี้มาจาก payroll-employees.ts เท่านั้น (ไม่ปนกับ employees เดิม)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import {
  upsertEmployee,
  softDeleteEmployee,
  getEmployeeScope,
  getEmployeeById,
  type PayrollEmployeeInput,
} from "@/lib/accounting/payroll-employees";
import { upsertSettings, type PayrollSettingsInput } from "@/lib/accounting/payroll-settings";

const PATH = "/chat-audit/accounting/payroll-employees";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type PayrollSaveResult = { ok: boolean; message: string; id?: string };

export type SaveEmployeeInput = {
  /** มี id = แก้ทะเบียนเดิม · ไม่มี = สร้างใหม่ */
  id?: string;
  customerId: string;
  employeeCode: unknown;
  fullName: unknown;
  /** ★ ปล่อยว่างตอนแก้ไข = คงเลขบัตรเดิมไว้ (ไม่ต้องพิมพ์ซ้ำทุกครั้งที่แก้ข้อมูลอื่น, 0.12) */
  idCardNo: unknown;
  /** ★ ปล่อยว่างตอนแก้ไข = คง passport เดิมไว้ */
  passportNo: unknown;
  position: unknown;
  baseSalary: unknown;
  startDate: unknown;
  resignDate: unknown;
  isActive: unknown;
};

/** บันทึกทะเบียนพนักงาน (สร้างใหม่/แก้ไข) */
export async function upsertEmployeeAction(input: SaveEmployeeInput): Promise<PayrollSaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    let idCardNo = input.idCardNo;
    let passportNo = input.passportNo;

    if (input.id) {
      if (!isUuid(input.id)) return { ok: false, message: "ไม่พบพนักงานที่เลือก" };
      // ★ derive scope จาก employee id ที่กำลังเขียนจริงเสมอ (ไม่เชื่อ customerId จาก client ลำพัง, 0.15)
      const scope = await getEmployeeScope(service, ctx.tenantId, input.id);
      if (!scope) return { ok: false, message: "ไม่พบพนักงาน (อาจถูกลบไปแล้ว)" };
      assertCustomerInScope(ctx, scope.customerId);
      if (scope.customerId !== input.customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับพนักงานเดิม" };

      // ★ 0.12: ปล่อยช่องเลขบัตร/passport ว่างตอนแก้ไข = คงค่าเดิมไว้ (ไม่บังคับพิมพ์ซ้ำทุกครั้ง)
      const idCardBlank = typeof idCardNo !== "string" || idCardNo.trim() === "";
      const passportBlank = typeof passportNo !== "string" || passportNo.trim() === "";
      if (idCardBlank && passportBlank) {
        const current = await getEmployeeById(service, ctx.tenantId, input.id);
        if (current) {
          idCardNo = current.idCardNo ?? idCardNo;
          passportNo = current.passportNo ?? passportNo;
        }
      }
    }

    const employeeInput: PayrollEmployeeInput = {
      employeeCode: input.employeeCode,
      fullName: input.fullName,
      idCardNo,
      passportNo,
      position: input.position,
      baseSalary: input.baseSalary,
      startDate: input.startDate,
      resignDate: input.resignDate,
      isActive: input.isActive,
    };

    const res = await upsertEmployee(service, ctx.tenantId, input.customerId, employeeInput, input.id);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: "บันทึกทะเบียนพนักงานแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ลบทะเบียนพนักงาน (soft-delete) */
export async function deleteEmployeeAction(id: string, customerId: string): Promise<PayrollSaveResult> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบพนักงานที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getEmployeeScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบพนักงาน (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับพนักงานเดิม" };

    const res = await softDeleteEmployee(service, ctx.tenantId, id);
    if (!res.ok) return { ok: false, message: res.message };
    revalidatePath(PATH);
    return { ok: true, message: "ลบทะเบียนพนักงานแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * เผยเลขบัตรประชาชนเต็มของพนักงาน 1 คน (ปุ่ม "เผยเลขเต็ม" ต่อแถว, 0.12) — ★ ไม่ log ค่าที่คืนที่ไหน
 *   คืน passport_no ด้วยถ้าไม่มี id_card_no (พนักงานต่างชาติ — passport ไม่มาสก์อยู่แล้วแต่คงจุดเดียวไว้)
 */
export async function revealIdCardAction(
  id: string,
  customerId: string
): Promise<{ ok: true; idCardNo: string | null; passportNo: string | null } | { ok: false; message: string }> {
  if (!isUuid(id) || !isUuid(customerId)) return { ok: false, message: "ไม่พบพนักงานที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    assertCustomerInScope(ctx, customerId);

    const scope = await getEmployeeScope(service, ctx.tenantId, id);
    if (!scope) return { ok: false, message: "ไม่พบพนักงาน (อาจถูกลบไปแล้ว)" };
    assertCustomerInScope(ctx, scope.customerId);
    if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับพนักงานเดิม" };

    const full = await getEmployeeById(service, ctx.tenantId, id);
    if (!full) return { ok: false, message: "ไม่พบพนักงาน (อาจถูกลบไปแล้ว)" };
    return { ok: true, idCardNo: full.idCardNo, passportNo: full.passportNo };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ดึงข้อมูลไม่สำเร็จ กรุณาลองใหม่" };
  }
}

export type SaveSettingsInput = {
  customerId: string;
  salaryExpenseAccountCode: unknown;
  ssoEmployerExpenseAccountCode: unknown;
  ssoPayableAccountCode: unknown;
  pitPayableAccountCode: unknown;
  otherDeductionsAccountCode: unknown;
  netPayAccountCode: unknown;
  netPayIsPaidImmediately: unknown;
};

/** บันทึกตั้งค่าบัญชี 6 ช่องของลูกค้า 1 ราย (0.11) */
export async function upsertSettingsAction(input: SaveSettingsInput): Promise<PayrollSaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    const settingsInput: PayrollSettingsInput = {
      salaryExpenseAccountCode: input.salaryExpenseAccountCode,
      ssoEmployerExpenseAccountCode: input.ssoEmployerExpenseAccountCode,
      ssoPayableAccountCode: input.ssoPayableAccountCode,
      pitPayableAccountCode: input.pitPayableAccountCode,
      otherDeductionsAccountCode: input.otherDeductionsAccountCode,
      netPayAccountCode: input.netPayAccountCode,
      netPayIsPaidImmediately: input.netPayIsPaidImmediately,
    };

    const res = await upsertSettings(service, ctx.tenantId, input.customerId, settingsInput, chartByCode);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    revalidatePath("/chat-audit/accounting/payroll");
    return { ok: true, message: "บันทึกตั้งค่าบัญชีแล้ว", id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}
