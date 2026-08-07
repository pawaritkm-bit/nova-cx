/**
 * ยอดยกมาต่อบัญชี ต่อลูกค้า (opening balances) — data layer (อ่าน) + helper pure (parse)
 *
 * บริบท: เพื่อออกงบดุลให้สมดุล ต้องมี "ยอดยกมาต้นงวด" ต่อบัญชีต่อลูกค้า
 *   (เช่น เงินสด/เงินฝาก/ลูกหนี้/เจ้าหนี้/ทุน ยกมาจากงวดก่อน). เก็บที่ account_opening_balances.
 *
 * ★ ทุก query กรอง tenant_id (จาก session — ห้ามรับจาก client) + customer_id
 * ★ parseOpeningBalanceRows เป็น pure (จับคอลัมน์ยืดหยุ่นจากไฟล์อัปโหลด) → unit test ได้แน่นอน
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { CHART_BY_CODE } from "@/lib/accounting/chart-of-accounts";

type DB = SupabaseClient;

/** ยอดยกมา 1 บัญชี (รูปที่ UI ใช้) */
export type OpeningBalance = {
  id: string;
  accountCode: string;
  accountName: string | null;
  openingBalance: number;
  note: string | null;
};

/** แถวที่ parse ได้จากไฟล์ (ก่อน upsert) */
export type ParsedOpeningRow = {
  accountCode: string;
  accountName: string | null;
  openingBalance: number;
};

/** เพดานความยาว (กัน payload ใหญ่ผิดปกติ) */
export const ACCOUNT_CODE_MAX = 20;
export const ACCOUNT_NAME_MAX = 200;
export const OPENING_NOTE_MAX = 500;

/** clamp + trim ข้อความ (คืน null ถ้าว่าง) */
export function clampOpeningText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * แปลงค่าเงินจากไฟล์ → number (รองรับ "1,234.50" / "(1,234)" วงเล็บ=ติดลบ / เลขไทย)
 *   คืน 0 ถ้าแปลงไม่ได้ (ไม่โยน error — ให้ทั้งไฟล์ผ่าน)
 */
export function parseMoney(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? round2(v) : 0;
  if (typeof v !== "string") return 0;
  let s = v.trim();
  if (!s) return 0;
  // เลขไทย → อารบิก
  s = s.replace(/[๐-๙]/g, (d) => String("๐๑๒๓๔๕๖๗๘๙".indexOf(d)));
  // วงเล็บ = ค่าติดลบ (บัญชี)
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  // ตัด comma / ช่องว่าง / สัญลักษณ์เงิน
  s = s.replace(/[,\s฿]/g, "");
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return round2(neg ? -n : n);
}

/** ปัดทศนิยม 2 ตำแหน่ง */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** normalize หัวคอลัมน์เป็น key เทียบง่าย (ตัดช่องว่าง/ตัวพิมพ์เล็ก) */
function normHeader(h: unknown): string {
  return String(h ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

/** ชื่อคอลัมน์ที่รับได้ (ยืดหยุ่นทั้งไทย/อังกฤษ) */
const CODE_HEADERS = new Set(
  ["รหัสบัญชี", "รหัส", "เลขที่บัญชี", "code", "accountcode", "acccode", "acc"].map(normHeader)
);
const NAME_HEADERS = new Set(
  ["ชื่อบัญชี", "ชื่อ", "name", "accountname", "accname", "description"].map(normHeader)
);
const OPENING_HEADERS = new Set(
  [
    "ยอดยกมาต้นงวด",
    "ยอดยกมา",
    "ยอดต้นงวด",
    "ยกมา",
    "opening",
    "openingbalance",
    "beginning",
    "beginningbalance",
    "balance",
  ].map(normHeader)
);

/**
 * จับ index คอลัมน์จากแถวหัว (header row) — คืน index ของ code/name/opening (-1 = ไม่พบ)
 */
function detectColumns(header: unknown[]): { code: number; name: number; opening: number } {
  let code = -1;
  let name = -1;
  let opening = -1;
  header.forEach((h, i) => {
    const k = normHeader(h);
    if (code < 0 && CODE_HEADERS.has(k)) code = i;
    else if (name < 0 && NAME_HEADERS.has(k)) name = i;
    else if (opening < 0 && OPENING_HEADERS.has(k)) opening = i;
  });
  return { code, name, opening };
}

/**
 * parse แถวจากไฟล์อัปโหลด (array ของ array — จาก 2D grid ที่อ่านด้วย exceljs) → ParsedOpeningRow[]
 *   ★ แถวแรกที่มีหัวคอลัมน์ code+opening = header · แถวถัดไป = ข้อมูล
 *   ★ จับคอลัมน์ยืดหยุ่น (ไทย/อังกฤษ) · ไม่พบ header ที่จำเป็น → คืน []
 *   ★ ชื่อบัญชี: ใช้จากไฟล์ก่อน · ไม่มี → เติมจากผังกลาง (ถ้ารหัสอยู่ในผัง)
 *   ★ validate: รหัสต้องไม่ว่าง · รับ "รหัสอิสระ" นอกผังกลางได้ (ธุรกิจอาจมีบัญชีย่อยเอง)
 *   ★ ข้ามแถวที่รหัสว่าง / เป็นแถวรวม ("รวม"/"total")
 */
export function parseOpeningBalanceRows(rows: unknown[][]): ParsedOpeningRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // หาแถว header (แถวแรกที่จับ code + opening ได้)
  let headerIdx = -1;
  let cols = { code: -1, name: -1, opening: -1 };
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = Array.isArray(rows[i]) ? rows[i] : [];
    const c = detectColumns(r);
    if (c.code >= 0 && c.opening >= 0) {
      headerIdx = i;
      cols = c;
      break;
    }
  }
  if (headerIdx < 0) return [];

  const out: ParsedOpeningRow[] = [];
  const seen = new Set<string>();
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = Array.isArray(rows[i]) ? rows[i] : [];
    const rawCode = clampOpeningText(cellToString(r[cols.code]), ACCOUNT_CODE_MAX);
    if (!rawCode) continue;
    const lower = rawCode.toLowerCase();
    if (lower === "total" || rawCode === "รวม" || rawCode === "รวมทั้งสิ้น") continue;

    // กันรหัสซ้ำในไฟล์ (แถวหลังทับแถวก่อน)
    if (seen.has(rawCode)) {
      const idx = out.findIndex((x) => x.accountCode === rawCode);
      if (idx >= 0) out.splice(idx, 1);
    }
    seen.add(rawCode);

    const fileName = cols.name >= 0 ? clampOpeningText(cellToString(r[cols.name]), ACCOUNT_NAME_MAX) : null;
    const accountName = fileName ?? CHART_BY_CODE[rawCode]?.name ?? null;
    const openingBalance = parseMoney(cellToString(r[cols.opening]) ?? r[cols.opening]);

    out.push({ accountCode: rawCode, accountName, openingBalance });
  }
  return out;
}

/** แปลง cell (exceljs อาจคืน object rich text / number / date) → string|null */
function cellToString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    // exceljs rich text / formula result
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (typeof o.text === "string") return o.text;
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join("");
    if (o.result != null) return String(o.result);
  }
  return String(v);
}

/** ผลรวมยอดยกมา (บวก=เดบิตสุทธิ / ลบ=เครดิตสุทธิ) — ช่วยเช็คคร่าว ๆ ว่าสมดุลไหม */
export function sumOpeningBalances(rows: Pick<OpeningBalance, "openingBalance">[]): number {
  return round2(rows.reduce((s, r) => s + (Number.isFinite(r.openingBalance) ? r.openingBalance : 0), 0));
}

/** เพดานแถว (ต่อ 1 ลูกค้าไม่ควรเยอะ — กันดึงเวอร์) */
const LIMIT = 500;

/**
 * ดึงยอดยกมาของลูกค้า 1 ราย (scope tenant + customer) — เรียงตามรหัสบัญชี
 *   คืน [] ถ้าไม่มี/ผิดพลาด
 */
export async function listOpeningBalances(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<OpeningBalance[]> {
  const { data, error } = await db
    .from("account_opening_balances")
    .select("id, account_code, account_name, opening_balance, note")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("account_code", { ascending: true })
    .limit(LIMIT);
  if (error || !data) return [];
  return (data as Array<{
    id: string;
    account_code: string;
    account_name: string | null;
    opening_balance: number | string | null;
    note: string | null;
  }>).map((r) => ({
    id: r.id,
    accountCode: r.account_code,
    accountName: r.account_name,
    openingBalance: parseMoney(typeof r.opening_balance === "number" ? r.opening_balance : String(r.opening_balance ?? 0)),
    note: r.note,
  }));
}
