"use server";

/**
 * Server actions ของหน้า "งบประมาณ" (/chat-audit/accounting/budget — เฟส 6 ส่วน S)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับหน้าอื่นในเฟส 6):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess + tenantId จาก session (ไม่เชื่อ client)
 *   2) assertCustomerInScope ก่อนอ่าน/เขียนเสมอ
 *   3) validate ซ้ำฝั่ง server เสมอ (budget.ts::validateBudgetRowInput ผ่าน upsertBudgetYear)
 *   4) revalidatePath('/chat-audit/accounting/budget')
 *
 * ★ S ทั้งหมดเป็น read-only เทียบยอด — ที่นี่มี write path เดียวคือ "บันทึกค่างบประมาณ" (config)
 *   ไม่กระทบบัญชีจริง/สมุดรายวัน/งบการเงินแม้แต่จุดเดียว
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAccountingAccess, assertCustomerInScope, AccountingAuthError } from "@/lib/accounting/access";
import { upsertBudgetYear, YEAR_MIN, YEAR_MAX, type BudgetRowInput } from "@/lib/accounting/budget";

const PATH = "/chat-audit/accounting/budget";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type BudgetSaveActionResult = { ok: boolean; message: string };

export type SaveBudgetYearInput = {
  customerId: string;
  year: number;
  rows: BudgetRowInput[];
};

/** บันทึกงบประมาณทั้งปีของลูกค้า 1 ราย "ทีเดียวทั้งชุด" (0.12) — batch upsert ทับของเดิม ไม่ insert ซ้ำ */
export async function saveBudgetYearAction(input: SaveBudgetYearInput): Promise<BudgetSaveActionResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    const year = typeof input.year === "number" ? input.year : Number(input.year);
    if (!Number.isInteger(year) || year < YEAR_MIN || year > YEAR_MAX) {
      return { ok: false, message: `ปีต้องเป็นจำนวนเต็มระหว่าง ${YEAR_MIN}-${YEAR_MAX}` };
    }

    const res = await upsertBudgetYear(service, ctx.tenantId, input.customerId, year, input.rows ?? []);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath(PATH);
    return { ok: true, message: `บันทึกงบประมาณแล้ว (${res.count.toLocaleString("th-TH")} ช่อง)` };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกงบประมาณไม่สำเร็จ กรุณาลองใหม่" };
  }
}
