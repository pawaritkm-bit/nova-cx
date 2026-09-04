"use server";

/**
 * รับ/จ่ายชำระจาก "สลิป" ตัดบิลเชื่อค้าง — ★ 2026-09-04 ผู้ใช้อนุมัติ ("ทำจริง")
 *   สลิปเงินเข้า (ขาย): Dr เงิน / Cr ลูกหนี้ — ตัดบิลขายเชื่อ · สลิปเงินออก (ซื้อ): Dr เจ้าหนี้ / Cr เงิน
 *
 * กลไก: สร้าง bill_payment บนบิลเป้าหมาย (recordBillPayment — validate ยอดค้าง/สิทธิ์/สถานะครบ)
 *   แล้ว soft-delete บิลสลิป (ร่าง) — สลิปกลายเป็น "การชำระ" ไม่ลงรายได้/ค่าใช้จ่ายซ้ำ
 *   (สมุดรายวันรับ/จ่ายเงินได้ใบสำคัญจาก payment posting เดิมอยู่แล้ว · ลบเป็น soft กู้คืนได้)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  customerInScope,
  AccountingAuthError,
} from "@/lib/accounting/access";
import { recordBillPayment, listBillPayments, billOutstanding } from "@/lib/accounting/bill-payments";
import { listNotes, netAdjustmentByEntry } from "@/lib/accounting/credit-debit-notes";
import { deleteEntry } from "@/lib/accounting/actions-lib";
import { round2 } from "@/lib/accounting/queries";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function settleSlipAgainstBillAction(input: {
  customerId: string;
  /** บิลสลิป (ร่าง) ที่จะแปลงเป็นการชำระ */
  slipEntryId: string;
  /** บิลเชื่อค้างชำระที่จะตัด */
  targetEntryId: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!UUID_RE.test(input.customerId) || !customerInScope(ctx, input.customerId)) {
      return { ok: false, message: "ลูกค้าไม่ถูกต้อง" };
    }
    if (!UUID_RE.test(input.slipEntryId) || !UUID_RE.test(input.targetEntryId)) {
      return { ok: false, message: "บิลไม่ถูกต้อง" };
    }
    if (input.slipEntryId === input.targetEntryId) {
      return { ok: false, message: "สลิปกับบิลเป้าหมายเป็นใบเดียวกัน" };
    }

    // ---- โหลดสลิป (ต้องเป็นร่างของลูกค้ารายนี้) ----
    const { data: s } = await service
      .from("bill_entries")
      .select("id, entry_type, status, doc_no, doc_date, payment_method, payment_bank_account_id")
      .eq("id", input.slipEntryId)
      .eq("tenant_id", ctx.tenantId)
      .eq("customer_id", input.customerId)
      .is("deleted_at", null)
      .maybeSingle();
    const slip = s as {
      id: string; entry_type: string; status: string; doc_no: string | null;
      doc_date: string | null; payment_method: string | null; payment_bank_account_id: string | null;
    } | null;
    if (!slip) return { ok: false, message: "ไม่พบสลิป (อาจถูกลบไปแล้ว)" };
    if (slip.status === "confirmed") {
      return { ok: false, message: "สลิปใบนี้ยืนยันเป็นบิลไปแล้ว — ลบบิลนั้นก่อนจึงจับคู่ได้" };
    }
    if (slip.entry_type !== "sale" && slip.entry_type !== "purchase") {
      return { ok: false, message: "สลิปยังไม่ระบุฝั่งเงินเข้า/ออก (ซื้อ/ขาย)" };
    }

    // ---- เป้าหมายต้องเป็นบิลของลูกค้ารายนี้ ฝั่งเดียวกับสลิป ----
    const { data: t } = await service
      .from("bill_entries")
      .select("id, entry_type, doc_no")
      .eq("id", input.targetEntryId)
      .eq("tenant_id", ctx.tenantId)
      .eq("customer_id", input.customerId)
      .is("deleted_at", null)
      .maybeSingle();
    const target = t as { id: string; entry_type: string; doc_no: string | null } | null;
    if (!target) return { ok: false, message: "ไม่พบบิลเชื่อเป้าหมาย" };
    if (target.entry_type !== slip.entry_type) {
      return { ok: false, message: "ฝั่งสลิปกับบิลเป้าหมายไม่ตรงกัน (เงินเข้า↔ขาย · เงินออก↔ซื้อ)" };
    }

    // ---- ยอดสลิป (สุทธิ) + ยอดค้างของเป้าหมาย → จ่ายจริง = ก้อนเล็กกว่า (รับชำระบางส่วนได้) ----
    const { data: slipLines } = await service
      .from("bill_entry_lines")
      .select("amount, vat_amount, wht_amount")
      .eq("tenant_id", ctx.tenantId)
      .eq("entry_id", slip.id);
    const num = (v: unknown) => (typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0) || 0;
    const slipNet = round2(
      ((slipLines ?? []) as { amount: unknown; vat_amount: unknown; wht_amount: unknown }[]).reduce(
        (sum, l) => sum + num(l.amount) + num(l.vat_amount) - num(l.wht_amount),
        0
      )
    );
    if (slipNet <= 0) return { ok: false, message: "สลิปไม่มียอดเงิน" };

    const { data: tgLines } = await service
      .from("bill_entry_lines")
      .select("amount, vat_amount, wht_amount")
      .eq("tenant_id", ctx.tenantId)
      .eq("entry_id", target.id);
    const targetLines = ((tgLines ?? []) as { amount: unknown; vat_amount: unknown; wht_amount: unknown }[]).map((l) => ({
      amount: num(l.amount), vatAmount: num(l.vat_amount), whtAmount: num(l.wht_amount),
    }));
    const paid = await listBillPayments(service, ctx.tenantId, target.id);
    const notes = await listNotes(service, ctx.tenantId, target.id);
    const adj = netAdjustmentByEntry(new Map([[target.id, notes]])).get(target.id) ?? 0;
    const outstanding = billOutstanding({ lines: targetLines }, paid, adj);
    if (outstanding <= 0) return { ok: false, message: "บิลเป้าหมายชำระครบแล้ว" };
    const amount = Math.min(slipNet, outstanding);

    // ---- บันทึกการชำระบนบิลเป้าหมาย (validate ซ้ำใน recordBillPayment) ----
    const method = slip.payment_method === "cash" ? "cash" : "transfer";
    const payDate = slip.doc_date ?? new Date().toISOString().slice(0, 10);
    const rec = await recordBillPayment(service, ctx.tenantId, target.id, {
      payDate,
      amount,
      method,
      bankAccountId: slip.payment_bank_account_id,
      notes: `จับคู่สลิป${slip.doc_no ? ` ${slip.doc_no}` : ""} (${payDate})`,
    });
    if (!rec.ok) return { ok: false, message: rec.message ?? "บันทึกการชำระไม่สำเร็จ" };

    // ---- สลิปกลายเป็นการชำระแล้ว → soft-delete บิลสลิป (กันลงรายได้/ค่าใช้จ่ายซ้ำ · กู้คืนได้) ----
    await deleteEntry(service, ctx.tenantId, slip.id);

    revalidatePath("/chat-audit/accounting");
    revalidatePath("/chat-audit/accounting/workspace");
    const verb = slip.entry_type === "sale" ? "รับชำระ + ตัดลูกหนี้" : "จ่ายชำระ + ตัดเจ้าหนี้";
    const partial = amount < slipNet ? ` (บางส่วน ${amount.toLocaleString("th-TH")})` : "";
    return { ok: true, message: `${verb}บิล ${target.doc_no ?? ""} แล้ว${partial}` };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "จับคู่ไม่สำเร็จ กรุณาลองใหม่" };
  }
}
