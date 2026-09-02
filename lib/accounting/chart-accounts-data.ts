/**
 * ผังบัญชี (chart_of_accounts) — data layer (DB) + validate/CRUD + guard รหัสโครงสร้าง
 *
 * บริบท: เฟส 1 ส่วน A (docs/06-accounting-features-roadmap.md) — ผังบัญชี tenant-scoped ใน DB
 *   (migration 0063) แทน hardcode array เดิม. ไฟล์นี้เป็นชั้นเดียวที่คุย DB ตรง — chart-of-accounts.ts
 *   ยังเป็น pure function ล้วน ไม่รู้จัก DB
 *
 * ★ ทุก query/write กรอง tenant_id (จาก session — ห้ามรับจาก client)
 * ★ soft-delete (deleted_at) — ไม่ลบจริง (pattern เดิมทั้งระบบ)
 * ★ 0.7 PROTECTED_CODES guard: รหัสบัญชี "โครงสร้าง" ที่ engine อื่นผูก hardcode ไว้ตรง ๆ
 *   (VAT/WHT/เงินสด/ลูกหนี้/เจ้าหนี้/กำไรสะสม) — ห้ามลบ (soft-delete) จากหน้าจัดการผังเสมอ
 *   + รหัสเงินฝากธนาคาร 3 ตัว (1020/1025/1030 ผูกกับ customer_bank_accounts) — ห้ามปลด is_bank
 *   ถ้ามีบัญชีลูกค้าที่ยัง active ผูกอยู่ + ห้ามลบถ้ามีบัญชีลูกค้าที่ยัง active ผูกอยู่ (เหตุผลเดียวกัน)
 * ★ เพิ่มเติมจากที่วางแผนไว้ (เหตุผล: เปลี่ยน "รหัส" ของบัญชีโครงสร้าง = engine ที่ hardcode เช็ค
 *   code ตรง ๆ (statement-config.ts) จะหาไม่เจอทันที) — ห้ามแก้ไข "code" ของ PROTECTED_CODES/
 *   BANK_STRUCTURAL_CODES ผ่านหน้าจัดการผังด้วยเช่นกัน (แก้ชื่อ/หมวดได้ตามปกติ)
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartAccount } from "@/lib/accounting/chart-of-accounts";

type DB = SupabaseClient;

/**
 * รหัสบัญชี "โครงสร้าง" ที่ engine บัญชีอื่นผูก hardcode ไว้ตรง ๆ (statement-config.ts)
 *   ห้ามลบ (soft-delete) ผ่านหน้าจัดการผังเสมอ — แก้ชื่อ/หมวดได้ ลบไม่ได้ (0.7)
 */
export const PROTECTED_CODES: ReadonlySet<string> = new Set([
  "1154", // ภาษีซื้อ (INPUT_VAT)
  "2900", // ภาษีขาย (OUTPUT_VAT)
  "2910", // ภาษีหัก ณ ที่จ่าย (WHT_PAYABLE)
  "1216", // ภาษีถูกหัก ณ ที่จ่าย (WHT_RECEIVABLE)
  "1010", // เงินสด (CASH)
  "2010", // เจ้าหนี้การค้า (AP)
  "1140", // ลูกหนี้การค้า (AR)
  "3020", // กำไรสะสม (RETAINED_EARNINGS)
]);

/**
 * รหัสบัญชีเงินฝากธนาคาร generic ที่ customer_bank_accounts ผูกอยู่ (0.7)
 *   ห้ามปลด is_bank / ห้ามลบ ถ้ามีบัญชีลูกค้าที่ยัง active ผูกอยู่
 */
export const BANK_STRUCTURAL_CODES: ReadonlySet<string> = new Set(["1020", "1025", "1030"]);

/** เพดานความยาว (กัน payload ใหญ่ผิดปกติ) */
export const CODE_MAX = 20;
export const NAME_MAX = 200;
export const CATEGORY_MAX = 50;

/** เพดานแถว (ผังไม่ควรเกินหลักร้อย — กันดึงเวอร์) */
const LIMIT = 2000;

/** แถวผังบัญชีสำหรับหน้า admin (มี id + is_active — ต่างจาก ChartAccount ที่ engine ใช้) */
export type ChartAccountRow = ChartAccount & {
  id: string;
  isActive: boolean;
};

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline */
export type ChartActionResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

function normText(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * ดึงผังบัญชี "ที่ใช้งานได้จริง" ของ tenant (is_active + ไม่ถูกลบ) เรียงตาม sort_order
 *   ★ ใช้โดย engine ทุกจุด (journal/ledger/payment/opening-balance/bank-accounts/statements/
 *   AI bill-extract/EntryEditor/OpeningBalancePanel) — โหลดครั้งเดียวต่อ request แล้ว inject
 *   คืน [] ถ้าไม่มี/query พลาด (ไม่ throw — ผู้เรียก degrade เอง เหมือน listOpeningBalances)
 */
export async function listChartOfAccounts(db: DB, tenantId: string): Promise<ChartAccount[]> {
  const { data, error } = await db
    .from("chart_of_accounts")
    .select("code, name, category, is_bank")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true })
    .limit(LIMIT);
  if (error || !data) return [];
  return (data as { code: string; name: string; category: string; is_bank: boolean }[]).map((r) => ({
    code: r.code,
    name: r.name,
    category: r.category,
    ...(r.is_bank ? { bank: true as const } : {}),
  }));
}

/**
 * ดึงผังบัญชีทั้งหมดของ tenant (รวม inactive แต่ไม่รวมที่ลบแล้ว) — ใช้หน้า admin list+CRUD
 */
export async function listChartOfAccountsAdmin(db: DB, tenantId: string): Promise<ChartAccountRow[]> {
  const { data, error } = await db
    .from("chart_of_accounts")
    .select("id, code, name, category, is_bank, is_active")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true })
    .limit(LIMIT);
  if (error || !data) return [];
  return (
    data as { id: string; code: string; name: string; category: string; is_bank: boolean; is_active: boolean }[]
  ).map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    category: r.category,
    ...(r.is_bank ? { bank: true as const } : {}),
    isActive: r.is_active,
  }));
}

/** input ที่ validate แล้ว (ก่อนเขียน DB) */
export type ValidatedChartAccountInput = {
  code: string;
  name: string;
  category: string;
  isBank: boolean;
};

/**
 * validate input สร้าง/แก้ผังบัญชี — คืน null ถ้าไม่ผ่าน (รหัส/ชื่อ/หมวดว่าง)
 *   ★ ไม่เช็คซ้ำในนี้ (ซ้ำในผังเดียวกันชนที่ unique index ของ DB → error 23505 ให้ caller แปลข้อความ)
 */
export function validateChartAccountInput(input: {
  code: unknown;
  name: unknown;
  category: unknown;
  isBank?: unknown;
}): ValidatedChartAccountInput | null {
  const code = normText(input.code, CODE_MAX);
  const name = normText(input.name, NAME_MAX);
  const category = normText(input.category, CATEGORY_MAX);
  if (!code || !name || !category) return null;
  return { code, name, category, isBank: input.isBank === true };
}

/** ดึง 1 แถวผัง (scope tenant) — ใช้ตรวจก่อนแก้/ลบ */
async function loadRow(
  db: DB,
  tenantId: string,
  id: string
): Promise<{ code: string; is_bank: boolean } | null> {
  const { data } = await db
    .from("chart_of_accounts")
    .select("code, is_bank")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as { code: string; is_bank: boolean } | null) ?? null;
}

/** มีบัญชีลูกค้า (customer_bank_accounts) ที่ยัง active ผูกรหัสนี้อยู่ไหม (scope tenant) */
async function hasActiveCustomerBankAccounts(db: DB, tenantId: string, code: string): Promise<boolean> {
  const { data } = await db
    .from("customer_bank_accounts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("account_code", code)
    .is("deleted_at", null)
    .limit(1);
  return !!data && data.length > 0;
}

/** สร้างบัญชีใหม่ในผัง (tenant นี้) — sort_order ต่อท้ายสุด */
export async function createChartAccount(
  db: DB,
  tenantId: string,
  input: { code: unknown; name: unknown; category: unknown; isBank?: unknown }
): Promise<ChartActionResult> {
  const v = validateChartAccountInput(input);
  if (!v) return { ok: false, message: "กรุณากรอกรหัส/ชื่อ/หมวดบัญชีให้ครบ" };

  // ★ กติกาผู้ใช้ 2026-09-02: "เลขซ้ำได้ ชื่อห้ามซ้ำ" (เช่น 4010 ขายสินค้า + 4010 รายได้บริการ)
  const { data: dupName } = await db
    .from("chart_of_accounts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("name", v.name)
    .is("deleted_at", null)
    .limit(1);
  if (dupName && dupName.length > 0) return { ok: false, message: "ชื่อบัญชีนี้มีอยู่ในผังแล้ว (เลขซ้ำได้ แต่ชื่อห้ามซ้ำ)" };

  const { data: maxRow } = await db
    .from("chart_of_accounts")
    .select("sort_order")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort = ((maxRow as { sort_order?: number } | null)?.sort_order ?? 0) + 1;

  const { data, error } = await db
    .from("chart_of_accounts")
    .insert({
      tenant_id: tenantId,
      code: v.code,
      name: v.name,
      category: v.category,
      is_bank: v.isBank,
      sort_order: nextSort,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "23505") return { ok: false, message: "รหัส+ชื่อคู่นี้มีอยู่ในผังแล้ว" };
    return { ok: false, message: "เพิ่มบัญชีไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * แก้บัญชีเดิมในผัง (scope tenant) — guard (0.7 + เพิ่มเติม):
 *   - ห้ามแก้ "code" ของรหัสโครงสร้าง (PROTECTED_CODES/BANK_STRUCTURAL_CODES) — engine hardcode
 *     ผูก code ตรง ๆ เปลี่ยนแล้วพังเงียบ (แก้ชื่อ/หมวด/is_bank ได้ตามปกติ ยกเว้นกรณี is_bank ด้านล่าง)
 *   - ห้ามปลด is_bank (true→false) ของ BANK_STRUCTURAL_CODES ถ้ามี customer_bank_accounts
 *     ที่ยัง active ผูกอยู่ (ผังลูกค้าจะหาบัญชีเงินฝากไม่เจอ)
 */
export async function updateChartAccount(
  db: DB,
  tenantId: string,
  id: string,
  input: { code: unknown; name: unknown; category: unknown; isBank?: unknown }
): Promise<ChartActionResult> {
  const v = validateChartAccountInput(input);
  if (!v) return { ok: false, message: "กรุณากรอกรหัส/ชื่อ/หมวดบัญชีให้ครบ" };

  const cur = await loadRow(db, tenantId, id);
  if (!cur) return { ok: false, message: "ไม่พบบัญชี (อาจถูกลบไปแล้ว)" };

  // ชื่อห้ามซ้ำ (ยกเว้นแถวตัวเอง) — กติกา 2026-09-02
  const { data: dupName } = await db
    .from("chart_of_accounts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("name", v.name)
    .neq("id", id)
    .is("deleted_at", null)
    .limit(1);
  if (dupName && dupName.length > 0) return { ok: false, message: "ชื่อบัญชีนี้มีอยู่ในผังแล้ว (เลขซ้ำได้ แต่ชื่อห้ามซ้ำ)" };

  const isStructuralCode = PROTECTED_CODES.has(cur.code) || BANK_STRUCTURAL_CODES.has(cur.code);
  if (isStructuralCode && v.code !== cur.code) {
    return { ok: false, message: "รหัสบัญชีนี้เป็นรหัสโครงสร้างที่ระบบผูกไว้ — แก้รหัสไม่ได้ (แก้ชื่อ/หมวดได้)" };
  }
  if (BANK_STRUCTURAL_CODES.has(cur.code) && cur.is_bank && !v.isBank) {
    const hasBankAccounts = await hasActiveCustomerBankAccounts(db, tenantId, cur.code);
    if (hasBankAccounts) {
      return {
        ok: false,
        message: "ปลดหมวดเงินฝากธนาคารไม่ได้ — มีบัญชีเงินฝากของลูกค้าผูกกับรหัสนี้อยู่",
      };
    }
  }

  const { error } = await db
    .from("chart_of_accounts")
    .update({ code: v.code, name: v.name, category: v.category, is_bank: v.isBank })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") return { ok: false, message: "รหัส+ชื่อคู่นี้มีอยู่ในผังแล้ว" };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id };
}

/** สลับ is_active (ปิดใช้งานชั่วคราว/เปิดกลับ) — ไม่ใช่ลบ, ไม่ผ่าน PROTECTED_CODES guard */
export async function setChartAccountActive(
  db: DB,
  tenantId: string,
  id: string,
  isActive: boolean
): Promise<ChartActionResult> {
  const { error } = await db
    .from("chart_of_accounts")
    .update({ is_active: isActive })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

/**
 * ลบบัญชี (soft-delete) — guard (0.7 + เพิ่มเติม):
 *   - ปฏิเสธเสมอถ้ารหัสอยู่ใน PROTECTED_CODES (VAT/WHT/เงินสด/ลูกหนี้/เจ้าหนี้/กำไรสะสม)
 *   - ปฏิเสธถ้ารหัสอยู่ใน BANK_STRUCTURAL_CODES และมี customer_bank_accounts ที่ยัง active ผูกอยู่
 */
export async function softDeleteChartAccount(
  db: DB,
  tenantId: string,
  id: string
): Promise<ChartActionResult> {
  const cur = await loadRow(db, tenantId, id);
  if (!cur) return { ok: false, message: "ไม่พบบัญชี (อาจถูกลบไปแล้ว)" };

  if (PROTECTED_CODES.has(cur.code)) {
    return { ok: false, message: `รหัส ${cur.code} เป็นรหัสโครงสร้างที่ระบบบัญชีผูกไว้ — ลบไม่ได้` };
  }
  if (BANK_STRUCTURAL_CODES.has(cur.code)) {
    const hasBankAccounts = await hasActiveCustomerBankAccounts(db, tenantId, cur.code);
    if (hasBankAccounts) {
      return { ok: false, message: `รหัส ${cur.code} มีบัญชีเงินฝากของลูกค้าผูกอยู่ — ลบไม่ได้` };
    }
  }

  const { error } = await db
    .from("chart_of_accounts")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}
