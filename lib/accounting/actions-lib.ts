/**
 * ลงบันทึกบัญชี ภาษีซื้อ/ขาย — data layer (เขียน) — pure data functions รับ db
 *   ★ ไม่ใช่ "use server" — UI task จะ import ไปห่อเป็น server action + guard admin เอง
 *   ★ ทุกฟังก์ชันรับ tenantId (จาก session) + scope ทุก write ด้วย tenant_id/entry_id
 *     กัน cross-tenant แม้ client จะเป็น service_role (bypass RLS)
 *   ★ PDPA: ไม่ log เนื้อบิล/ตัวเลข
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/accounting/queries";
import type { EntryType, VatType, WhtForm, PaymentMethod } from "@/lib/accounting/queries";

type DB = SupabaseClient;

export type UpsertEntryInput = {
  /** มี id = update · ไม่มี = insert ใหม่ (คีย์เอง source='manual') */
  id?: string;
  entryType: EntryType;
  attachmentId?: string | null;
  customerId?: string | null;
  docDate?: string | null;
  docNo?: string | null;
  counterpartyName?: string | null;
  counterpartyTaxId?: string | null;
  whtForm?: WhtForm | null;
  /** วิธีจ่าย/รับเงิน → บัญชีคู่ฝั่งเครดิต (null = ล้าง) */
  paymentMethod?: PaymentMethod | null;
  /** บัญชีเงินฝากที่ใช้ (เฉพาะ transfer) · null = ล้าง */
  paymentBankAccountId?: string | null;
  notes?: string | null;
  /**
   * ไฟล์ที่นักบัญชี "อัปเอง" (แนบตอน insert entry ใหม่เท่านั้น)
   *   ★ ส่งเมื่อ create เท่านั้น — ปล่อย undefined ตอน update เพื่อ "ไม่ทับ" ค่าเดิม
   *   (saveEntryAction ไม่เคยส่ง 3 ค่านี้ → update จึงคงไฟล์อัปไว้)
   */
  uploadPath?: string | null;
  uploadName?: string | null;
  uploadMime?: string | null;
};

export type LineInput = {
  lineNo?: number;
  vatType?: VatType;
  description?: string | null;
  /** รหัสบัญชีจากผังบัญชี (ล็อกเมื่อเลือกแล้ว) · null = ล้าง */
  accountCode?: string | null;
  /** ชื่อบัญชี (แก้ต่อบรรทัดได้) · null = ล้าง */
  accountName?: string | null;
  amount?: number | null;
  vatAmount?: number | null;
  whtRate?: number | null;
  whtAmount?: number | null;
};

export type ActionResult<T = { id: string }> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** normalize ค่าเลข (null/NaN → 0, ปัด 2 ตำแหน่ง, ไม่ติดลบ) */
function safeAmount(v: number | null | undefined): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return round2(Math.max(0, n));
}

/** auto-calc wht_amount ถ้าไม่ได้ส่งมา: amount * rate/100 (ถ้าส่ง whtAmount มาใช้ค่านั้น) */
function resolveWht(amount: number, whtRate: number | null | undefined, whtAmount: number | null | undefined): {
  rate: number;
  amount: number;
} {
  const rate = typeof whtRate === "number" && Number.isFinite(whtRate) && whtRate > 0 ? round2(whtRate) : 0;
  if (typeof whtAmount === "number" && Number.isFinite(whtAmount) && whtAmount > 0) {
    return { rate, amount: round2(whtAmount) };
  }
  // ไม่ส่ง whtAmount → คำนวณจาก rate (ปล่อยให้ auto-calc — AI ไม่เดา WHT)
  return { rate, amount: rate > 0 ? round2((amount * rate) / 100) : 0 };
}

/**
 * upsert หัวเอกสาร (insert ใหม่ = manual / update ของเดิม)
 *   - update: scope ด้วย id + tenant_id (กัน cross-tenant)
 *   - ห้ามแก้ entry ที่ confirmed แล้ว (คืน error) — ป้องกันแก้ของที่เข้ารายงานแล้ว
 */
export async function upsertEntry(
  db: DB,
  tenantId: string,
  input: UpsertEntryInput
): Promise<ActionResult> {
  const payload: Record<string, unknown> = {
    entry_type: input.entryType,
    attachment_id: input.attachmentId ?? null,
    customer_id: input.customerId ?? null,
    doc_date: input.docDate ?? null,
    doc_no: input.docNo ?? null,
    counterparty_name: input.counterpartyName ?? null,
    counterparty_tax_id: input.counterpartyTaxId ?? null,
    wht_form: input.whtForm ?? null,
    notes: input.notes ?? null,
  };
  // วิธีจ่าย/รับเงิน: ใส่เฉพาะเมื่อส่งค่ามา (undefined = ไม่แตะ — กัน update ทับเป็น null)
  //   ★ ไม่ใช่ transfer → บังคับล้าง payment_bank_account_id (บัญชีธนาคารใช้เฉพาะโอน)
  if (input.paymentMethod !== undefined) {
    payload.payment_method = input.paymentMethod ?? null;
    payload.payment_bank_account_id =
      input.paymentMethod === "transfer" ? input.paymentBankAccountId ?? null : null;
  } else if (input.paymentBankAccountId !== undefined) {
    payload.payment_bank_account_id = input.paymentBankAccountId ?? null;
  }
  // ไฟล์อัปเอง: ใส่เฉพาะเมื่อส่งค่ามา (undefined = ไม่แตะ — กัน update ทับไฟล์เดิมเป็น null)
  if (input.uploadPath !== undefined) payload.upload_path = input.uploadPath;
  if (input.uploadName !== undefined) payload.upload_name = input.uploadName;
  if (input.uploadMime !== undefined) payload.upload_mime = input.uploadMime;

  if (input.id) {
    // กันแก้ของที่ยืนยันแล้ว
    const { data: cur } = await db
      .from("bill_entries")
      .select("status")
      .eq("id", input.id)
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!cur) return { ok: false, error: "not_found" };
    if ((cur as { status?: string }).status === "confirmed") {
      return { ok: false, error: "entry_confirmed" };
    }
    const { error } = await db
      .from("bill_entries")
      .update(payload)
      .eq("id", input.id)
      .eq("tenant_id", tenantId);
    if (error) return { ok: false, error: "update_failed" };
    return { ok: true, data: { id: input.id } };
  }

  // insert ใหม่ (คีย์เอง)
  const { data, error } = await db
    .from("bill_entries")
    .insert({ ...payload, tenant_id: tenantId, status: "draft", source: "manual" })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, error: "insert_failed" };
  return { ok: true, data: { id: (data as { id: string }).id } };
}

/** ตรวจว่า entry อยู่ใน tenant + ยังไม่ confirmed (สำหรับ mutate line) */
async function assertEditableEntry(db: DB, tenantId: string, entryId: string): Promise<string | null> {
  const { data } = await db
    .from("bill_entries")
    .select("status")
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return "not_found";
  if ((data as { status?: string }).status === "confirmed") return "entry_confirmed";
  return null;
}

/** เพิ่ม 1 line ให้ entry (line_no ต่อท้ายอัตโนมัติถ้าไม่ระบุ) */
export async function addLine(
  db: DB,
  tenantId: string,
  entryId: string,
  input: LineInput
): Promise<ActionResult> {
  const guard = await assertEditableEntry(db, tenantId, entryId);
  if (guard) return { ok: false, error: guard };

  let lineNo = input.lineNo;
  if (typeof lineNo !== "number") {
    const { data: last } = await db
      .from("bill_entry_lines")
      .select("line_no")
      .eq("tenant_id", tenantId)
      .eq("entry_id", entryId)
      .order("line_no", { ascending: false })
      .limit(1)
      .maybeSingle();
    lineNo = ((last as { line_no?: number } | null)?.line_no ?? 0) + 1;
  }

  const amount = safeAmount(input.amount);
  const wht = resolveWht(amount, input.whtRate, input.whtAmount);
  const { data, error } = await db
    .from("bill_entry_lines")
    .insert({
      entry_id: entryId,
      tenant_id: tenantId,
      line_no: lineNo,
      vat_type: input.vatType === "novat" ? "novat" : "vat",
      description: input.description ?? null,
      account_code: input.accountCode ?? null,
      account_name: input.accountName ?? null,
      amount,
      vat_amount: safeAmount(input.vatAmount),
      wht_rate: wht.rate,
      wht_amount: wht.amount,
      ai_filled: false, // คนคีย์
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, error: "insert_failed" };
  return { ok: true, data: { id: (data as { id: string }).id } };
}

/** แก้ 1 line (scope ด้วย lineId + tenant_id + entry ต้อง editable) */
export async function updateLine(
  db: DB,
  tenantId: string,
  lineId: string,
  input: LineInput
): Promise<ActionResult> {
  // หา entry แม่เพื่อเช็คสถานะ
  const { data: line } = await db
    .from("bill_entry_lines")
    .select("entry_id")
    .eq("id", lineId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!line) return { ok: false, error: "not_found" };
  const guard = await assertEditableEntry(db, tenantId, (line as { entry_id: string }).entry_id);
  if (guard) return { ok: false, error: guard };

  const patch: Record<string, unknown> = {};
  if (input.vatType !== undefined) patch.vat_type = input.vatType === "novat" ? "novat" : "vat";
  if (input.description !== undefined) patch.description = input.description;
  if (input.accountCode !== undefined) patch.account_code = input.accountCode;
  if (input.accountName !== undefined) patch.account_name = input.accountName;
  if (input.lineNo !== undefined) patch.line_no = input.lineNo;
  if (input.amount !== undefined) patch.amount = safeAmount(input.amount);
  if (input.vatAmount !== undefined) patch.vat_amount = safeAmount(input.vatAmount);
  // wht: ถ้าแก้ rate หรือ amount ให้คำนวณใหม่ (ใช้ amount ที่จะมีผลจริง)
  if (input.whtRate !== undefined || input.whtAmount !== undefined) {
    const amount =
      input.amount !== undefined ? safeAmount(input.amount) : await currentLineAmount(db, tenantId, lineId);
    const wht = resolveWht(amount, input.whtRate, input.whtAmount);
    patch.wht_rate = wht.rate;
    patch.wht_amount = wht.amount;
  }
  // คนแก้ line → ai_filled=false (ไม่ใช่ค่า AI อีกต่อไป)
  patch.ai_filled = false;

  if (Object.keys(patch).length === 0) return { ok: true, data: { id: lineId } };
  const { error } = await db
    .from("bill_entry_lines")
    .update(patch)
    .eq("id", lineId)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, error: "update_failed" };
  return { ok: true, data: { id: lineId } };
}

/** อ่าน amount ปัจจุบันของ line (ช่วยคำนวณ wht เมื่อไม่ได้ส่ง amount มาแก้) */
async function currentLineAmount(db: DB, tenantId: string, lineId: string): Promise<number> {
  const { data } = await db
    .from("bill_entry_lines")
    .select("amount")
    .eq("id", lineId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const v = (data as { amount?: number | string } | null)?.amount;
  return safeAmount(typeof v === "string" ? Number(v) : (v as number | undefined));
}

/** ลบ 1 line (hard delete — line เป็นรายละเอียด ไม่ต้อง soft delete) */
export async function deleteLine(
  db: DB,
  tenantId: string,
  lineId: string
): Promise<ActionResult<{ id: string }>> {
  const { data: line } = await db
    .from("bill_entry_lines")
    .select("entry_id")
    .eq("id", lineId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!line) return { ok: false, error: "not_found" };
  const guard = await assertEditableEntry(db, tenantId, (line as { entry_id: string }).entry_id);
  if (guard) return { ok: false, error: guard };

  const { error } = await db
    .from("bill_entry_lines")
    .delete()
    .eq("id", lineId)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, error: "delete_failed" };
  return { ok: true, data: { id: lineId } };
}

/** ยืนยัน entry (draft → confirmed) + set confirmed_at — ต้องมีอย่างน้อย 1 line มีมูลค่า */
export async function confirmEntry(
  db: DB,
  tenantId: string,
  entryId: string
): Promise<ActionResult> {
  const { data: entry } = await db
    .from("bill_entries")
    .select("status, entry_type")
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!entry) return { ok: false, error: "not_found" };
  const cur = entry as { status?: string; entry_type?: string };
  if (cur.status === "confirmed") return { ok: false, error: "already_confirmed" };
  // ต้องระบุซื้อ/ขายก่อนยืนยัน (unspecified = ยังไม่รู้ฝั่ง ยื่นภาษีไม่ได้)
  if (cur.entry_type !== "purchase" && cur.entry_type !== "sale") {
    return { ok: false, error: "entry_type_unspecified" };
  }

  // ต้องมี line ที่มีมูลค่า > 0 (กันยืนยัน draft ว่างเปล่าที่ AI ยังไม่เติม)
  const { data: lines } = await db
    .from("bill_entry_lines")
    .select("amount, vat_amount")
    .eq("tenant_id", tenantId)
    .eq("entry_id", entryId);
  const hasValue = ((lines ?? []) as { amount: number | string; vat_amount: number | string }[]).some(
    (l) => safeAmount(Number(l.amount)) > 0 || safeAmount(Number(l.vat_amount)) > 0
  );
  if (!hasValue) return { ok: false, error: "no_amount" };

  const { error } = await db
    .from("bill_entries")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .eq("status", "draft"); // guard: เขียนเฉพาะตอนยังเป็น draft (กัน race)
  if (error) return { ok: false, error: "confirm_failed" };
  return { ok: true, data: { id: entryId } };
}

/** ลบ entry (soft delete — set deleted_at) + cascade lines จะยังอยู่ (entry ซ่อนจาก list) */
export async function deleteEntry(
  db: DB,
  tenantId: string,
  entryId: string
): Promise<ActionResult> {
  const { error } = await db
    .from("bill_entries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, error: "delete_failed" };
  return { ok: true, data: { id: entryId } };
}
