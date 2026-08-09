/**
 * บัญชีเงินฝากธนาคาร "ต่อลูกค้า" — data layer (อ่าน) + helper pure
 *
 * บริบท: ผังบัญชีกลางเก็บบัญชีเงินฝากเป็นชื่อ generic (#1/#2/#3, bank:true) เท่านั้น.
 *   เลขบัญชีจริงของแต่ละบริษัทเก็บที่ตาราง customer_bank_accounts (ผูก customer_id).
 *   หน้าตรวจบิลเลือกบัญชีของ "ลูกค้าเจ้าของบิล" เท่านั้น (กันหลุดข้ามบริษัท / PDPA).
 *
 * ★ ทุก query กรอง tenant_id (จาก session — ห้ามรับจาก client) + customer_id
 * ★ helper (sanitize/label/filter) เป็น pure → unit test ได้แน่นอน
 * ★ PDPA: ไม่ log ชื่อธนาคาร/เลขบัญชี/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { type ChartAccount, isBankAccountCode } from "@/lib/accounting/chart-of-accounts";

type DB = SupabaseClient;

/** บัญชีเงินฝากของลูกค้า (รูปที่ UI ใช้) */
export type CustomerBankAccount = {
  id: string;
  /** รหัสผังบัญชีเงินฝาก (1020/1025/1030) ที่บัญชีนี้ผูกอยู่ */
  accountCode: string;
  bankName: string | null;
  accountNo: string | null;
};

/** เพดานความยาว (กัน payload ใหญ่ผิดปกติ) */
export const BANK_NAME_MAX = 80;
export const ACCOUNT_NO_MAX = 40;

/** clamp + trim ข้อความบัญชี (คืน null ถ้าว่าง) — ใช้ทั้ง action และแสดงผล */
export function clampBankText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * ชื่อที่ใช้ตั้งเป็น account_name เมื่อเลือกบัญชีลูกค้าใน picker
 *   = "ชื่อธนาคาร เลขบัญชี" (ตัดช่องว่างซ้อน) · ถ้าไม่มีข้อมูลเลย = "เงินฝากธนาคาร"
 */
export function bankAccountDisplayName(b: {
  bankName?: string | null;
  accountNo?: string | null;
}): string {
  const name = `${b.bankName ?? ""} ${b.accountNo ?? ""}`.replace(/\s+/g, " ").trim();
  return name || "เงินฝากธนาคาร";
}

/** ตรวจความถูกต้องของ input ก่อนเขียน (validate accountCode + sanitize ชื่อ/เลข) */
export type ValidatedBankAccount = {
  accountCode: string;
  bankName: string | null;
  accountNo: string | null;
};

/**
 * validate + sanitize input บัญชีลูกค้า — คืน null ถ้า accountCode ไม่ใช่รหัสเงินฝาก
 *   ★ อนุญาตเฉพาะรหัสที่ bank:true ในผัง (ไม่ให้ผูกบัญชีเงินฝากกับรหัสมั่ว/รหัสอื่น)
 *     — ถ้าจะรองรับเงินฝากเกิน 3 บัญชี ให้เพิ่มรหัส bank:true ในผังก่อน (ชุดนี้ขยายเอง)
 *   @param chart ผังบัญชีของ tenant — ไม่มี default (ผู้เรียกต้องส่งเสมอ)
 */
export function validateBankAccountInput(
  chart: ChartAccount[],
  input: {
    accountCode: unknown;
    bankName?: unknown;
    accountNo?: unknown;
  }
): ValidatedBankAccount | null {
  const code = typeof input.accountCode === "string" ? input.accountCode.trim() : "";
  if (!isBankAccountCode(chart, code)) return null;
  return {
    accountCode: code,
    bankName: clampBankText(input.bankName, BANK_NAME_MAX),
    accountNo: clampBankText(input.accountNo, ACCOUNT_NO_MAX),
  };
}

/** กรองบัญชีลูกค้าตาม query (รหัส/ชื่อธนาคาร/เลขบัญชี) — ใช้ใน combobox */
export function filterBankAccounts(
  list: CustomerBankAccount[],
  q: string
): CustomerBankAccount[] {
  const s = (q ?? "").trim().toLowerCase();
  if (!s) return list;
  return list.filter(
    (b) =>
      b.accountCode.toLowerCase().includes(s) ||
      (b.bankName ?? "").toLowerCase().includes(s) ||
      (b.accountNo ?? "").toLowerCase().includes(s)
  );
}

/** เพดานแถว (ต่อ 1 ลูกค้าไม่ควรเยอะ — กันดึงเวอร์) */
const LIMIT = 100;

/**
 * ดึงบัญชีเงินฝากของลูกค้า 1 ราย (scope tenant + customer) — เรียง sort แล้ว account_code
 *   คืน [] ถ้าไม่มี/ผิดพลาด (หน้า fallback ไปใช้ generic bank ในผังกลาง)
 */
export async function listCustomerBankAccounts(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<CustomerBankAccount[]> {
  const { data, error } = await db
    .from("customer_bank_accounts")
    .select("id, account_code, bank_name, account_no")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("sort", { ascending: true })
    .order("account_code", { ascending: true })
    .limit(LIMIT);
  if (error || !data) return [];
  return (data as Array<{
    id: string;
    account_code: string;
    bank_name: string | null;
    account_no: string | null;
  }>).map((r) => ({
    id: r.id,
    accountCode: r.account_code,
    bankName: r.bank_name,
    accountNo: r.account_no,
  }));
}
