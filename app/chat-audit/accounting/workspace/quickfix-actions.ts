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
import { recordAccountRules } from "@/lib/accounting/account-learning";
import { round2 } from "@/lib/accounting/queries";

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

/** guard ร่วมของ action รายบรรทัด: สิทธิ์ + บิลเป็นของลูกค้า + บรรทัดเป็นของบิล */
async function loadLineScoped(input: { customerId: string; entryId: string; lineId: string }) {
  const authed = await createClient();
  const service = createServiceRoleClient();
  const ctx = await requireAccountingAccess(authed, service);
  if (!UUID_RE.test(input.customerId) || !customerInScope(ctx, input.customerId)) {
    return { err: "ลูกค้าไม่ถูกต้อง" as const };
  }
  if (!UUID_RE.test(input.entryId) || !UUID_RE.test(input.lineId)) {
    return { err: "บิลไม่ถูกต้อง" as const };
  }
  const { data: e } = await service
    .from("bill_entries")
    .select("id, entry_type, status")
    .eq("id", input.entryId)
    .eq("tenant_id", ctx.tenantId)
    .eq("customer_id", input.customerId)
    .is("deleted_at", null)
    .maybeSingle();
  const entry = e as { id: string; entry_type: string; status: string } | null;
  if (!entry) return { err: "ไม่พบบิล" as const };
  const { data: l } = await service
    .from("bill_entry_lines")
    .select("id, amount, vat_amount, wht_rate")
    .eq("id", input.lineId)
    .eq("tenant_id", ctx.tenantId)
    .eq("entry_id", entry.id)
    .maybeSingle();
  const line = l as { id: string; amount: number | string | null; vat_amount: number | string | null; wht_rate: number | string | null } | null;
  if (!line) return { err: "ไม่พบบรรทัดรายการ" as const };
  return { service, ctx, entry, line };
}

/**
 * เลือกเลขผังบัญชี "รายบรรทัด" บนการ์ดบิลหลายรายการ — ★ 2026-09-03 ผู้ใช้อนุมัติดีไซน์
 * การ์ดหลายรายการ (ตารางบรรทัดละช่องเลขผัง · Enter เด้งช่องถัดไป · ครบทุกบรรทัดยืนยันอัตโนมัติ)
 *   เขียนเฉพาะบรรทัดที่ชี้ + จำกติกา per-customer (best-effort) — ไม่แตะบรรทัดอื่น
 */
export async function setBillLineAccountAction(input: {
  customerId: string;
  entryId: string;
  lineId: string;
  accountCode: string;
  accountName: string;
  counterpartyName?: string | null;
  /** ยอดบรรทัด (สอน learning "ยอดซ้ำ") */
  amount?: number | null;
}): Promise<{ ok: boolean; message?: string }> {
  try {
    const got = await loadLineScoped(input);
    if ("err" in got) return { ok: false, message: got.err };
    const { service, ctx, entry } = got;

    const code = String(input.accountCode ?? "").trim();
    const name = String(input.accountName ?? "").trim().slice(0, 120);
    if (!/^[0-9A-Za-z.\-]{1,12}$/.test(code)) return { ok: false, message: "รหัสบัญชีไม่ถูกต้อง" };

    const { error } = await service
      .from("bill_entry_lines")
      .update({ account_code: code, account_name: name || null })
      .eq("id", input.lineId)
      .eq("tenant_id", ctx.tenantId);
    if (error) return { ok: false, message: "บันทึกบัญชีลงบรรทัดไม่สำเร็จ" };

    // จำกติกาของลูกค้ารายนี้ (best-effort — mirror applyStatementAccountToBillAction)
    const entryType = entry.entry_type === "sale" || entry.entry_type === "purchase" ? entry.entry_type : null;
    const cpName =
      typeof input.counterpartyName === "string" ? input.counterpartyName.trim().slice(0, 200) : "";
    const amt =
      typeof input.amount === "number" && Number.isFinite(input.amount) && input.amount > 0
        ? input.amount
        : null;
    if (entryType && (cpName || amt)) {
      await recordAccountRules(service, {
        tenantId: ctx.tenantId,
        customerId: input.customerId,
        entryType,
        counterpartyTaxId: null,
        counterpartyName: cpName || null,
        lines: [{ accountCode: code, accountName: name || null, amount: amt }],
      }).catch(() => {});
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * แก้ยอด "รายบรรทัด" บนการ์ด (มูลค่า/VAT/อัตราหัก %) — ★ ดีไซน์เดียวกัน (Tab ไปกรอกคอลัมน์อื่นได้)
 *   หัก ณ ที่จ่าย คำนวณให้เอง = round2(มูลค่า × อัตรา/100) · แก้ได้เฉพาะบิลร่าง (ยืนยันแล้วล็อก)
 */
export async function patchBillLineAmountsAction(input: {
  customerId: string;
  entryId: string;
  lineId: string;
  amount?: number;
  vatAmount?: number;
  whtRate?: number;
}): Promise<{ ok: boolean; message?: string; whtAmount?: number }> {
  try {
    const got = await loadLineScoped(input);
    if ("err" in got) return { ok: false, message: got.err };
    const { service, ctx, entry, line } = got;
    if (entry.status === "confirmed") {
      return { ok: false, message: "บิลยืนยันแล้ว แก้ยอดไม่ได้ — ยกเลิกยืนยันที่หน้าตรวจ/แก้ก่อน" };
    }

    const num = (v: unknown): number => (typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0) || 0;
    const okNum = (v: number | undefined, max: number) =>
      v !== undefined && Number.isFinite(v) && v >= 0 && v <= max;

    const patch: Record<string, unknown> = {};
    if (input.amount !== undefined) {
      if (!okNum(input.amount, 1_000_000_000_000)) return { ok: false, message: "มูลค่าไม่ถูกต้อง" };
      patch.amount = round2(input.amount);
    }
    if (input.vatAmount !== undefined) {
      if (!okNum(input.vatAmount, 1_000_000_000_000)) return { ok: false, message: "VAT ไม่ถูกต้อง" };
      patch.vat_amount = round2(input.vatAmount);
    }
    if (input.whtRate !== undefined) {
      if (!okNum(input.whtRate, 100)) return { ok: false, message: "อัตราหักต้อง 0–100%" };
      patch.wht_rate = input.whtRate;
    }
    if (Object.keys(patch).length === 0) return { ok: false, message: "ไม่มีอะไรให้แก้" };

    // หัก ณ ที่จ่าย = มูลค่าใหม่ × อัตราใหม่ (ตัวไหนไม่ได้แก้ใช้ค่าเดิม)
    const effAmount = input.amount !== undefined ? round2(input.amount) : num(line.amount);
    const effRate = input.whtRate !== undefined ? input.whtRate : num(line.wht_rate);
    const whtAmount = round2((effAmount * effRate) / 100);
    patch.wht_amount = whtAmount;

    const { error } = await service
      .from("bill_entry_lines")
      .update(patch)
      .eq("id", input.lineId)
      .eq("tenant_id", ctx.tenantId);
    if (error) return { ok: false, message: "บันทึกยอดไม่สำเร็จ" };
    return { ok: true, whtAmount };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}
