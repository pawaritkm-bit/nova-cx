"use server";

/**
 * แก้ไขด่วนบนการ์ดบิล (โต๊ะทำงาน) — ★ 2026-09-02 ผู้ใช้: "AI จับผิดอยู่ แก้ไม่ได้ —
 * เพิ่มปุ่มแก้คู่ค้า สลับเดบิตเครดิต และแก้เลขผังบัญชี" (ลูกค้าที่ไม่ใช่พี่สวยจับผิดเยอะ)
 *
 * - แก้คู่ค้า: เขียน counterparty_name ตรง ๆ
 * - สลับเดบิต/เครดิต: พลิก entry_type ซื้อ⇄ขาย (เอนจินสมุดรายวันสลับ Dr/Cr ให้เองทั้งใบ)
 *   + คู่ค้าตามหลัก: ขาย=ผู้ซื้อ (buyer) · ซื้อ=ผู้ขาย (seller) ถ้ามีชื่อเก็บไว้
 * - บัญชี: ใช้ applyStatementAccountToBillAction เดิม (เขียนบรรทัด + จำ per-customer)
 */
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  customerInScope,
  AccountingAuthError,
} from "@/lib/accounting/access";
import { paymentMethodForMoneyAccount } from "@/lib/accounting/payment";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function quickFixBillAction(input: {
  customerId: string;
  entryId: string;
  /** ส่งมา = เขียนทับชื่อคู่ค้า ("" = ล้าง) */
  counterpartyName?: string;
  /** true = สลับซื้อ⇄ขาย (สลับฝั่งเดบิต/เครดิตทั้งใบ) */
  flipType?: boolean;
  /** ★ เปลี่ยน "บัญชีฝั่งเงิน" (เดบิตเงินเข้า/เครดิตเงินออก) → แปลงเป็นวิธีรับ/จ่ายให้สอดคล้อง */
  moneyAccountCode?: string;
}): Promise<
  | { ok: true; message: string; entryType?: "purchase" | "sale"; counterpartyName?: string | null }
  | { ok: false; message: string }
> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!UUID_RE.test(input.customerId) || !customerInScope(ctx, input.customerId)) {
      return { ok: false, message: "ลูกค้าไม่ถูกต้อง" };
    }
    if (!UUID_RE.test(input.entryId)) return { ok: false, message: "บิลไม่ถูกต้อง" };

    const { data: e } = await service
      .from("bill_entries")
      .select("id, entry_type, status, counterparty_name, seller_name, buyer_name")
      .eq("id", input.entryId)
      .eq("tenant_id", ctx.tenantId)
      .eq("customer_id", input.customerId)
      .is("deleted_at", null)
      .maybeSingle();
    const entry = e as {
      id: string;
      entry_type: string;
      status: string;
      counterparty_name: string | null;
      seller_name: string | null;
      buyer_name: string | null;
    } | null;
    if (!entry) return { ok: false, message: "ไม่พบบิล" };

    const patch: Record<string, unknown> = {};
    let newType: "purchase" | "sale" | undefined;
    let newCp: string | null | undefined;

    if (input.flipType) {
      if (entry.entry_type !== "purchase" && entry.entry_type !== "sale") {
        return { ok: false, message: "บิลยังไม่ระบุประเภท — เลือกซื้อ/ขายที่ปุ่มตรวจ/ยืนยันก่อน" };
      }
      newType = entry.entry_type === "sale" ? "purchase" : "sale";
      patch.entry_type = newType;
      patch.side_guessed = false; // นักบัญชีตัดสินแล้ว
      // คู่ค้าตามหลักฝั่งใหม่ (ขาย=ผู้ซื้อ · ซื้อ=ผู้ขาย) — มีชื่อเก็บไว้ค่อยเปลี่ยน ไม่มีก็คงเดิม
      const cpByType = newType === "sale" ? entry.buyer_name : entry.seller_name;
      if (cpByType && cpByType.trim()) {
        newCp = cpByType.trim();
        patch.counterparty_name = newCp;
      }
    }

    if (input.moneyAccountCode !== undefined) {
      const t = (newType ?? entry.entry_type) as "purchase" | "sale" | string;
      if (t !== "purchase" && t !== "sale") {
        return { ok: false, message: "บิลยังไม่ระบุประเภท — เลือกซื้อ/ขายก่อน" };
      }
      const method = paymentMethodForMoneyAccount(input.moneyAccountCode, t);
      if (!method) return { ok: false, message: "บัญชีฝั่งเงินไม่ถูกต้อง" };
      patch.payment_method = method;
      // เปลี่ยนวิธี = ปลดผูกบัญชีธนาคารเฉพาะ (ให้ default ตามผัง) — เว้นเลือกโค้ดธนาคารที่ผูกไว้เดิม
      if (method !== "transfer") patch.payment_bank_account_id = null;
    }

    if (input.counterpartyName !== undefined) {
      newCp = input.counterpartyName.trim().slice(0, 200) || null;
      patch.counterparty_name = newCp;
    }

    if (Object.keys(patch).length === 0) return { ok: false, message: "ไม่มีอะไรให้แก้" };
    const { error } = await service
      .from("bill_entries")
      .update(patch)
      .eq("id", entry.id)
      .eq("tenant_id", ctx.tenantId);
    if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };

    return {
      ok: true,
      message: input.moneyAccountCode !== undefined
        ? "เปลี่ยนบัญชีฝั่งเงิน/วิธีรับ-จ่ายแล้ว"
        : input.flipType
        ? `สลับเป็น${newType === "sale" ? "บิลขาย (เครดิตรายได้/เดบิตเงินเข้า)" : "บิลซื้อ (เดบิตค่าใช้จ่าย/เครดิตเงินออก)"}แล้ว`
        : "บันทึกคู่ค้าแล้ว",
      entryType: newType,
      counterpartyName: newCp,
    };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}
