"use server";

/**
 * ปิดบัญชีสิ้นงวด (ขั้น 8 — ★ 2026-09-02 ผู้ใช้: "จัดทำและปิดงบ ทำให้ครบ")
 *
 * โอนยอดสะสมรายได้/ค่าใช้จ่าย (หมวด 4/5/6) ณ สิ้นงวด เข้า "กำไรสะสม" (3020) เป็น
 * manual JE (JV, ยืนยันทันที) ผ่านกลไก manual-journal เดิม → เข้าเล่มทั่วไป/แยกประเภท/งบเอง
 *
 * ★ กติกาสำคัญที่นักบัญชีต้องรู้ (แสดงบน UI ด้วย):
 *   หลังปิดงวด งบกำไรขาดทุน "ของงวดที่ปิด" จะเป็นศูนย์ (ยอดถูกโอนเข้ากำไรสะสมแล้ว —
 *   เหมือนสมุดจริง) → พิมพ์/เก็บงบของงวดนั้นให้เสร็จก่อนปิด · ยกเลิกการปิดได้เสมอ
 * ★ idempotent: 1 งวด (ลูกค้า+เดือนสิ้นงวด) ปิดได้ครั้งเดียว — คีย์ ⚙close|YYYY-MM ใน memo
 */
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  customerInScope,
  AccountingAuthError,
} from "@/lib/accounting/access";
import { listEntries } from "@/lib/accounting/queries";
import { listOpeningBalances } from "@/lib/accounting/opening-balance";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { filterEntriesForReport } from "@/lib/accounting/report-filter";
import { buildStatements } from "@/lib/accounting/statements";
import { loadCombinedJournalLines, flattenCombinedJournalLines } from "@/lib/accounting/statement-inputs";
import { buildClosingEntryLines, CLOSE_MARK } from "@/lib/accounting/equity-change";
import { RETAINED_EARNINGS } from "@/lib/accounting/statement-config";
import {
  listManualEntries,
  upsertManualEntry,
  confirmManualEntry,
  unconfirmManualEntry,
  softDeleteManualEntry,
  type ManualJournalEntry,
} from "@/lib/accounting/manual-journal";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** วันสุดท้ายของเดือน YYYY-MM */
function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

function findClosing(entries: ManualJournalEntry[], month: string): ManualJournalEntry | null {
  return entries.find((e) => (e.memo ?? "").includes(`${CLOSE_MARK}${month}`)) ?? null;
}

export type CloseStatus = {
  closed: boolean;
  entryId: string | null;
  docDate: string | null;
};

/** สถานะการปิดงวด (สำหรับ UI) */
export async function getCloseStatusAction(input: {
  customerId: string;
  month: string;
}): Promise<{ ok: true; status: CloseStatus } | { ok: false; message: string }> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!isValid(input, ctx)) return { ok: false, message: "ข้อมูลไม่ถูกต้อง" };
    const all = await listManualEntries(service, ctx.tenantId, input.customerId);
    const hit = findClosing(all, input.month);
    return {
      ok: true,
      status: { closed: !!hit, entryId: hit?.id ?? null, docDate: hit?.docDate ?? null },
    };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "อ่านสถานะไม่สำเร็จ" };
  }
}

function isValid(
  input: { customerId: string; month: string },
  ctx: { tenantId: string } & Parameters<typeof customerInScope>[0]
): boolean {
  return UUID_RE.test(input.customerId) && MONTH_RE.test(input.month) && customerInScope(ctx, input.customerId);
}

/** ปิดงวด: สร้าง JE ปิดบัญชี (ยืนยันทันที) — คืนกำไรสุทธิที่โอนเข้ากำไรสะสม */
export async function closePeriodAction(input: {
  customerId: string;
  /** เดือนสิ้นงวด YYYY-MM — JE ลงวันที่วันสุดท้ายของเดือนนี้ */
  month: string;
}): Promise<{ ok: true; message: string; netProfit: number } | { ok: false; message: string }> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!isValid(input, ctx)) return { ok: false, message: "ลูกค้า/เดือนไม่ถูกต้อง" };

    // กันปิดซ้ำ
    const existing = findClosing(await listManualEntries(service, ctx.tenantId, input.customerId), input.month);
    if (existing) return { ok: false, message: "งวดนี้ปิดแล้ว — ยกเลิกการปิดก่อนถ้าต้องการปิดใหม่" };

    // งบทดลองสะสม ณ สิ้นงวด (เฉพาะยืนยันแล้ว — ปิดจากตัวเลขจริง)
    const period = { from: "", to: input.month, includeDraft: false };
    const [{ entries }, opening, chart] = await Promise.all([
      listEntries(service, ctx.tenantId, { customerId: input.customerId }),
      listOpeningBalances(service, ctx.tenantId, input.customerId),
      listChartOfAccounts(service, ctx.tenantId),
    ]);
    const chartByCode = buildChartByCode(chart);
    const combined = await loadCombinedJournalLines(service, ctx.tenantId, entries, period, chartByCode);
    const stmts = buildStatements(
      filterEntriesForReport(entries, period),
      opening,
      chartByCode,
      flattenCombinedJournalLines(combined)
    );

    const plan = buildClosingEntryLines(stmts.trialBalance, {
      code: RETAINED_EARNINGS,
      name: chartByCode[RETAINED_EARNINGS]?.name ?? "กำไรสะสม",
    });
    if (!plan) return { ok: false, message: "ไม่มียอดรายได้/ค่าใช้จ่ายให้ปิดในงวดนี้ (เป็นศูนย์หมดแล้ว)" };
    if (plan.lines.length > 50) {
      return { ok: false, message: `บัญชีที่ต้องปิดมี ${plan.lines.length} บรรทัด เกินเพดาน JE (50) — แจ้งผู้ดูแลระบบ` };
    }

    const docDate = lastDayOf(input.month);
    const saved = await upsertManualEntry(
      service,
      ctx.tenantId,
      input.customerId,
      {
        docType: "JV",
        docDate,
        docNo: `CLS-${input.month}`,
        memo: `ปิดบัญชีรายได้-ค่าใช้จ่ายเข้ากำไรสะสม งวดสิ้นสุด ${docDate}\n${CLOSE_MARK}${input.month}`,
        lines: plan.lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.accountName,
          description: "ปิดบัญชีสิ้นงวด",
          debit: l.debit,
          credit: l.credit,
        })),
      },
      chartByCode
    );
    if (!saved.ok) return { ok: false, message: saved.message ?? "สร้างรายการปิดไม่สำเร็จ" };
    const confirmed = await confirmManualEntry(service, ctx.tenantId, saved.id!);
    if (!confirmed.ok) return { ok: false, message: confirmed.message ?? "ยืนยันรายการปิดไม่สำเร็จ" };

    const label = plan.netProfit >= 0 ? "กำไรสุทธิ" : "ขาดทุนสุทธิ";
    return {
      ok: true,
      netProfit: plan.netProfit,
      message: `ปิดงวดแล้ว — โอน${label} ${Math.abs(plan.netProfit).toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท เข้ากำไรสะสม (${plan.lines.length.toLocaleString("th-TH")} บรรทัด)`,
    };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ปิดงวดไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** ยกเลิกการปิดงวด — ถอนยืนยันแล้วลบ JE ปิด (กู้กลับสถานะก่อนปิด) */
export async function cancelClosePeriodAction(input: {
  customerId: string;
  month: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!isValid(input, ctx)) return { ok: false, message: "ลูกค้า/เดือนไม่ถูกต้อง" };

    const hit = findClosing(await listManualEntries(service, ctx.tenantId, input.customerId), input.month);
    if (!hit) return { ok: false, message: "งวดนี้ยังไม่ได้ปิด" };
    if (hit.status === "confirmed") {
      const un = await unconfirmManualEntry(service, ctx.tenantId, hit.id);
      if (!un.ok) return { ok: false, message: un.message ?? "ถอนยืนยันไม่สำเร็จ" };
    }
    const del = await softDeleteManualEntry(service, ctx.tenantId, hit.id);
    if (!del.ok) return { ok: false, message: del.message ?? "ลบรายการปิดไม่สำเร็จ" };
    return { ok: true, message: "ยกเลิกการปิดงวดแล้ว — รายได้/ค่าใช้จ่ายกลับมาแสดงตามเดิม" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ยกเลิกไม่สำเร็จ กรุณาลองใหม่" };
  }
}
