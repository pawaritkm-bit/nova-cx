/**
 * ลงบันทึกบัญชี ภาษีซื้อ/ขาย — data layer (อ่าน) สำหรับหน้า /accounting (UI เป็นอีก task)
 *
 * ★ แยกหน้าที่: queries.ts = อ่าน + คำนวณสรุป (pure) · actions-lib.ts = เขียน (upsert/update/delete)
 * ★ ทุก query กรอง tenant_id จาก session (ส่งเข้ามาเป็นพารามิเตอร์ ห้ามรับจาก client)
 *   + ใช้ scoped/service client เป็นชั้นกันซ้ำ
 * ★ ฟังก์ชันคำนวณ (summarizeEntries/lineNet) เป็น pure → unit test ได้แน่นอน
 * ★ PDPA: ไม่ log เนื้อบิล/ตัวเลข
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

/** เพดานแถวต่อ query (กันดึงเยอะเกิน) */
const ENTRIES_LIMIT = 2000;

/** unspecified = ยังไม่ระบุซื้อ/ขาย (AI จับคู่ลูกค้าเราไม่ชัด — รอคนเลือก) */
export type EntryType = "purchase" | "sale" | "unspecified";
export type EntryStatus = "draft" | "confirmed";
export type EntrySource = "ai" | "manual";
export type VatType = "vat" | "novat";
export type WhtForm = "pnd3" | "pnd53";
/** วิธีจ่าย/รับเงิน (บัญชีคู่ฝั่งเครดิต) — เงินสด/เช็ค/เงินโอน/ลูกหนี้-เจ้าหนี้ */
export type PaymentMethod = "cash" | "cheque" | "transfer" | "credit";

/** บรรทัดรายการ (ตรงกับ bill_entry_lines) */
export type BillEntryLine = {
  id: string;
  entryId: string;
  lineNo: number;
  vatType: VatType;
  description: string | null;
  /** รหัสบัญชีจากผังบัญชีมาตรฐาน (ล็อกเมื่อเลือกแล้ว) · null = ยังไม่เลือก */
  accountCode: string | null;
  /** ชื่อบัญชี (prefill จากผัง แก้ต่อบรรทัดได้) · null = ยังไม่เลือก */
  accountName: string | null;
  amount: number;
  vatAmount: number;
  whtRate: number;
  whtAmount: number;
  aiFilled: boolean;
  /** ★ true = AI "เดาเติม" ช่องเสี่ยง (ยอด/VAT/บัญชี conf ต่ำ) → ป้าย "AI เดา — ตรวจ" */
  aiLowConfidence: boolean;
};

/** หัวเอกสาร + lines + ข้อมูลประกอบ (ลูกค้า/ไฟล์แนบ) ที่หน้าใช้ */
export type BillEntry = {
  id: string;
  tenantId: string;
  attachmentId: string | null;
  customerId: string | null;
  customerName: string | null;
  /** object path ของไฟล์บิลใน bucket (ให้ UI เอาไป sign รูป) — null = ไม่มีไฟล์ */
  attachmentObjectPath: string | null;
  /** ไฟล์ที่นักบัญชี "อัปเอง" (ไม่ได้มาทางไลน์) — object path ใน bucket `bills` · null = ไม่มี */
  uploadPath: string | null;
  /** ชื่อไฟล์เดิมที่อัป (ไว้โชว์/ตั้งชื่อดาวน์โหลด) · null = ไม่มี */
  uploadName: string | null;
  /** MIME ของไฟล์ที่อัป (แยกรูป=inline vs pdf/excel=ปุ่มเปิด) · null = ไม่มี */
  uploadMime: string | null;
  entryType: EntryType;
  docDate: string | null;
  docNo: string | null;
  counterpartyName: string | null;
  counterpartyTaxId: string | null;
  /** ผู้ขาย/ผู้ซื้อ ที่ AI อ่านได้ทั้ง 2 ฝั่ง — ให้ UI โชว์ตอน entryType='unspecified' */
  sellerName: string | null;
  sellerTaxId: string | null;
  buyerName: string | null;
  buyerTaxId: string | null;
  whtForm: WhtForm | null;
  /** วิธีจ่าย/รับเงิน → บัญชีคู่ฝั่งเครดิต (null = ยังไม่ระบุ) */
  paymentMethod: PaymentMethod | null;
  /** id ของบัญชีเงินฝากที่ใช้ (เฉพาะ transfer) · null = ไม่ระบุ/ไม่ใช่โอน */
  paymentBankAccountId: string | null;
  /** รหัสผังบัญชีเงินฝากของบัญชีที่เลือก (1020/1025/1030) — join มาให้ hint บัญชีคู่ · null = ไม่มี */
  paymentBankAccountCode: string | null;
  status: EntryStatus;
  source: EntrySource;
  aiConfidence: number | null;
  notes: string | null;
  /**
   * เดือนที่ใช้เครดิตภาษีซื้อ (input VAT) รูปแบบ 'YYYY-MM' (ค.ศ.) — เฉพาะบิลซื้อ
   *   null = ใช้เดือนของ doc_date (ค่าโดยปริยาย ไม่ยกเดือน)
   *   ★ degrade: ถ้าคอลัมน์ input_tax_month ยังไม่ apply (migration 0060) → null เสมอ
   */
  inputTaxMonth: string | null;
  /** ผลส่งไป FlowAccount ล่าสุด (M1 — บิลขาย confirmed เท่านั้น) */
  flowaccountSync: FlowAccountSyncInfo;
  createdAt: string;
  confirmedAt: string | null;
  lines: BillEntryLine[];
};

/** สถานะส่งไป FlowAccount (docs/05-flowaccount-integration.md, migration 0061) */
export type FlowAccountSyncStatus = "not_synced" | "syncing" | "synced" | "failed";
export type FlowAccountDocTypeDb = "tax_invoice" | "cash_sale";

/** ผลส่งไป FlowAccount ล่าสุดของบิล — ★ degrade: คอลัมน์ยังไม่ apply migration → not_synced เสมอ (ไม่พัง) */
export type FlowAccountSyncInfo = {
  status: FlowAccountSyncStatus;
  docType: FlowAccountDocTypeDb | null;
  docId: string | null;
  docNo: string | null;
  syncedAt: string | null;
  /** ข้อความ error สั้น ๆ ครั้งล่าสุด (ไม่มี payload/PII) */
  lastError: string | null;
  /** true = ส่งไปแล้วแต่บิลถูกแก้ทีหลัง (ควรส่งใหม่) */
  needsResync: boolean;
};

/** ค่าเริ่มต้น (ยังไม่เคยส่ง/คอลัมน์ยังไม่ apply migration) — export ไว้ให้เทสต์สร้าง BillEntry fixture ใช้ร่วมกันได้ */
export function defaultFlowAccountSync(): FlowAccountSyncInfo {
  return {
    status: "not_synced",
    docType: null,
    docId: null,
    docNo: null,
    syncedAt: null,
    lastError: null,
    needsResync: false,
  };
}

/** สรุปยอดต่อประเภท (ภาษีซื้อ/ขาย) */
export type EntrySummary = {
  count: number;
  amount: number;      // รวมมูลค่าก่อน VAT
  vat: number;         // รวม VAT
  wht: number;         // รวมหัก ณ ที่จ่าย
  net: number;         // รวมจ่ายจริง = amount + vat - wht
};

export type EntriesResult = {
  entries: BillEntry[];
  summary: { purchase: EntrySummary; sale: EntrySummary };
};

export type ListEntriesFilter = {
  entryType?: EntryType;
  /** เดือน YYYY-MM (กรองที่ doc_date) */
  month?: string;
  /**
   * ช่วงวันที่ (YYYY-MM-DD) กรองที่ doc_date แบบ inclusive ทั้งสองด้าน
   *   - ถ้ามี dateFrom/dateTo (อย่างน้อยหนึ่งด้าน) จะ "แทนที่" การกรองด้วย month
   *   - ใช้กับรายงานภาษีที่เลือกช่วงวันเองได้
   */
  dateFrom?: string;
  dateTo?: string;
  customerId?: string;
  /**
   * จำกัดเฉพาะลูกค้าในชุดนี้ (สโคปนักบัญชี — เห็นเฉพาะลูกค้าที่ตัวเองดูแล)
   *   - [] (ว่าง) = ไม่มีลูกค้าในสโคป → คืนผลว่าง (ไม่ใช่ "ไม่กรอง")
   *   - undefined = ไม่กรองด้วยชุดนี้ (admin/lead เห็นทุกลูกค้า)
   */
  customerIds?: string[];
  status?: EntryStatus;
};

// ---------------------------------------------------------------------
// คำนวณ (pure — ไม่แตะ DB)
// ---------------------------------------------------------------------

/** แปลงค่าเป็นเลขจำกัด (null/NaN/string → 0) */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** ยอดจ่ายจริงของ 1 line = amount + vat - wht */
export function lineNet(line: Pick<BillEntryLine, "amount" | "vatAmount" | "whtAmount">): number {
  return round2(num(line.amount) + num(line.vatAmount) - num(line.whtAmount));
}

/** ปัดทศนิยม 2 ตำแหน่ง (กัน floating error สะสม) */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * เดือน 'YYYY-MM' ของวันที่เอกสาร (ISO 'YYYY-MM-DD') — คืน null ถ้าไม่มี/รูปแบบพัง
 *   ★ doc_date เป็น date ล้วน (ไม่มีเวลา) → เดือนคือ 7 ตัวแรก ไม่ขึ้นกับ timezone
 */
export function monthOf(docDate: string | null | undefined): string | null {
  if (!docDate) return null;
  const m = /^(\d{4})-(0[1-9]|1[0-2])/.exec(docDate);
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * เดือนที่ใช้เครดิตภาษีซื้อจริงของบิล (pure — เทสต์ได้)
 *   = inputTaxMonth (ถ้ามีและถูกรูปแบบ 'YYYY-MM') · มิฉะนั้น = เดือนของ doc_date
 *   คืน null ถ้าทั้งคู่ไม่มี (บิลยังไม่ลงวันที่ + ไม่ได้ระบุเดือนใช้ภาษี)
 *
 *   ★ ใช้ยึด "เดือนที่ใช้ภาษี" ในรายงานภาษีซื้อ (แทนเดือนของ doc_date)
 *   ★ degrade: inputTaxMonth = null/undefined (คอลัมน์ยังไม่ apply) → คืนเดือนของ doc_date
 *     = พฤติกรรมเดิม (ยึดวันที่บิล) — ไม่พัง, ไม่ยกเดือน
 */
export function effectiveTaxMonth(
  entry: { inputTaxMonth?: string | null; docDate: string | null }
): string | null {
  const im = entry.inputTaxMonth;
  if (im && /^\d{4}-(0[1-9]|1[0-2])$/.test(im)) return im;
  return monthOf(entry.docDate);
}

/** สรุปยอดของ 1 entry (รวมทุก line) */
export function summarizeEntry(lines: BillEntryLine[]): EntrySummary {
  let amount = 0;
  let vat = 0;
  let wht = 0;
  for (const l of lines) {
    amount += num(l.amount);
    vat += num(l.vatAmount);
    wht += num(l.whtAmount);
  }
  amount = round2(amount);
  vat = round2(vat);
  wht = round2(wht);
  return { count: 1, amount, vat, wht, net: round2(amount + vat - wht) };
}

/**
 * สรุปยอดแยกประเภท (purchase/sale) จาก entries ทั้งชุด
 *   entry ที่ยัง 'unspecified' (รอระบุ) ไม่ถูกนับในสรุปซื้อ/ขาย (ยังไม่รู้ฝั่ง)
 */
export function summarizeEntries(entries: BillEntry[]): {
  purchase: EntrySummary;
  sale: EntrySummary;
} {
  const zero = (): EntrySummary => ({ count: 0, amount: 0, vat: 0, wht: 0, net: 0 });
  const acc = { purchase: zero(), sale: zero() };
  for (const e of entries) {
    if (e.entryType !== "purchase" && e.entryType !== "sale") continue;
    const s = summarizeEntry(e.lines);
    const t = acc[e.entryType];
    t.count += 1;
    t.amount = round2(t.amount + s.amount);
    t.vat = round2(t.vat + s.vat);
    t.wht = round2(t.wht + s.wht);
    t.net = round2(t.net + s.net);
  }
  return acc;
}

// ---------------------------------------------------------------------
// map แถวดิบ → type ของหน้า
// ---------------------------------------------------------------------

type RawLine = {
  id: string;
  entry_id: string;
  line_no: number;
  vat_type: string;
  description: string | null;
  account_code: string | null;
  account_name: string | null;
  amount: number | string | null;
  vat_amount: number | string | null;
  wht_rate: number | string | null;
  wht_amount: number | string | null;
  ai_filled: boolean;
  ai_low_confidence: boolean;
};

type RawEntry = {
  id: string;
  tenant_id: string;
  attachment_id: string | null;
  customer_id: string | null;
  upload_path: string | null;
  upload_name: string | null;
  upload_mime: string | null;
  entry_type: string;
  doc_date: string | null;
  doc_no: string | null;
  counterparty_name: string | null;
  counterparty_tax_id: string | null;
  seller_name: string | null;
  seller_tax_id: string | null;
  buyer_name: string | null;
  buyer_tax_id: string | null;
  wht_form: string | null;
  payment_method: string | null;
  payment_bank_account_id: string | null;
  status: string;
  source: string;
  ai_confidence: number | null;
  notes: string | null;
  created_at: string;
  confirmed_at: string | null;
};

/** แถวเดือนที่ใช้ภาษี (best-effort — คอลัมน์ input_tax_month เพิ่ง add ใน 0060) */
type RawInputTaxMonth = { id: string; input_tax_month: string | null };

/** แถวสถานะ FlowAccount (best-effort — คอลัมน์เพิ่ง add ใน migration 0061) */
type RawFlowAccountSync = {
  id: string;
  flowaccount_sync_status: string | null;
  flowaccount_doc_type: string | null;
  flowaccount_doc_id: string | null;
  flowaccount_doc_no: string | null;
  flowaccount_synced_at: string | null;
  flowaccount_last_error: string | null;
  flowaccount_needs_resync: boolean | null;
};

function mapFlowAccountSync(r: RawFlowAccountSync): FlowAccountSyncInfo {
  const status: FlowAccountSyncStatus =
    r.flowaccount_sync_status === "syncing" ||
    r.flowaccount_sync_status === "synced" ||
    r.flowaccount_sync_status === "failed"
      ? r.flowaccount_sync_status
      : "not_synced";
  const docType: FlowAccountDocTypeDb | null =
    r.flowaccount_doc_type === "tax_invoice" || r.flowaccount_doc_type === "cash_sale"
      ? r.flowaccount_doc_type
      : null;
  return {
    status,
    docType,
    docId: r.flowaccount_doc_id ?? null,
    docNo: r.flowaccount_doc_no ?? null,
    syncedAt: r.flowaccount_synced_at ?? null,
    lastError: r.flowaccount_last_error ?? null,
    needsResync: !!r.flowaccount_needs_resync,
  };
}

/** cast string ดิบจาก DB → PaymentMethod | null */
function asPaymentMethodDb(v: string | null): PaymentMethod | null {
  return v === "cash" || v === "cheque" || v === "transfer" || v === "credit" ? v : null;
}

function mapLine(r: RawLine): BillEntryLine {
  return {
    id: r.id,
    entryId: r.entry_id,
    lineNo: r.line_no,
    vatType: r.vat_type === "novat" ? "novat" : "vat",
    description: r.description,
    accountCode: r.account_code,
    accountName: r.account_name,
    amount: num(r.amount),
    vatAmount: num(r.vat_amount),
    whtRate: num(r.wht_rate),
    whtAmount: num(r.wht_amount),
    aiFilled: !!r.ai_filled,
    aiLowConfidence: !!r.ai_low_confidence,
  };
}

// ---------------------------------------------------------------------
// DB: list entries + lines + customer + attachment path
// ---------------------------------------------------------------------

/** ช่วงวันของเดือน YYYY-MM → [firstDay, firstDayNextMonth) เป็น ISO date (null = ไม่กรอง) */
export function monthRange(month?: string): { start: string; end: string } | null {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split("-").map(Number);
  if (m < 1 || m > 12) return null;
  const start = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-01`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const end = `${ny.toString().padStart(4, "0")}-${nm.toString().padStart(2, "0")}-01`;
  return { start, end };
}

/** วันแรก–วันสุดท้ายของเดือน YYYY-MM (ISO date) · null ถ้ารูปแบบพัง
 *   ใช้เป็น default ช่วงวัน + ปุ่มลัด "ทั้งเดือน" ของรายงานภาษี */
export function monthBounds(month?: string): { first: string; last: string } | null {
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [y, m] = month.split("-").map(Number);
  // Date.UTC(y, m, 0) = วันที่ 0 ของเดือนถัดไป = วันสุดท้ายของเดือน m (m เป็นเลข 1-based)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * ช่วงวันที่ from/to (YYYY-MM-DD, inclusive ทั้งคู่) → bounds สำหรับ gte/lte
 *   - รูปแบบผิดทั้งคู่ → null (ผู้เรียก fallback ไปกรองด้วย month)
 *   - มีข้างเดียว → เปิดปลายอีกข้าง (start only / end only)
 *   - from > to → สลับให้ (กันผู้ใช้ใส่กลับด้าน)
 */
export function dateRange(
  from?: string,
  to?: string
): { start: string | null; end: string | null } | null {
  const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  const f = from && DATE_RE.test(from) ? from : null;
  const t = to && DATE_RE.test(to) ? to : null;
  if (!f && !t) return null;
  if (f && t && f > t) return { start: t, end: f };
  return { start: f, end: t };
}

/**
 * ดึงรายการ entry + lines (+ ชื่อลูกค้า + object path ไฟล์บิล) ตาม filter
 *   - tenantId มาจาก session เท่านั้น
 */
export async function listEntries(
  db: DB,
  tenantId: string,
  filter: ListEntriesFilter = {}
): Promise<EntriesResult> {
  // สโคปนักบัญชี: ชุดลูกค้าว่าง = ไม่มีสิทธิ์เห็นลูกค้าใดเลย → คืนผลว่างทันที
  if (filter.customerIds && filter.customerIds.length === 0) {
    return { entries: [], summary: emptySummary() };
  }

  let q = db
    .from("bill_entries")
    .select(
      "id, tenant_id, attachment_id, customer_id, upload_path, upload_name, upload_mime, entry_type, doc_date, doc_no, counterparty_name, counterparty_tax_id, seller_name, seller_tax_id, buyer_name, buyer_tax_id, wht_form, payment_method, payment_bank_account_id, status, source, ai_confidence, notes, created_at, confirmed_at"
    )
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("doc_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(ENTRIES_LIMIT);

  if (filter.entryType) q = q.eq("entry_type", filter.entryType);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.customerId) q = q.eq("customer_id", filter.customerId);
  if (filter.customerIds && filter.customerIds.length > 0) {
    q = q.in("customer_id", filter.customerIds);
  }
  // ช่วงวันที่ (from/to) มาก่อน month — ถ้ามีให้ใช้ช่วงวัน (inclusive); ไม่งั้น fallback กรองทั้งเดือน
  const dr = dateRange(filter.dateFrom, filter.dateTo);
  if (dr) {
    if (dr.start) q = q.gte("doc_date", dr.start);
    if (dr.end) q = q.lte("doc_date", dr.end);
  } else {
    const range = monthRange(filter.month);
    if (range) q = q.gte("doc_date", range.start).lt("doc_date", range.end);
  }

  const { data: entryData, error: entryErr } = await q;
  if (entryErr) {
    console.warn(`[accounting] list entries error code=${(entryErr as { code?: string }).code ?? "?"}`);
    return { entries: [], summary: emptySummary() };
  }
  const rawEntries = (entryData ?? []) as unknown as RawEntry[];
  if (rawEntries.length === 0) return { entries: [], summary: emptySummary() };

  const entryIds = rawEntries.map((e) => e.id);

  // เดือนที่ใช้ภาษีซื้อ (input_tax_month) — ★ best-effort แยก query
  //   คอลัมน์นี้เพิ่ง add ด้วย migration 0060 · ถ้ายังไม่ apply → select error →
  //   ถือเป็น null ทั้งหมด (degrade เงียบ ไม่ทำ list พัง = ยึดเดือน doc_date ตามเดิม)
  const inputTaxMonthByEntry = new Map<string, string | null>();
  try {
    const { data: itmData, error: itmErr } = await db
      .from("bill_entries")
      .select("id, input_tax_month")
      .eq("tenant_id", tenantId)
      .in("id", entryIds);
    if (!itmErr) {
      for (const r of (itmData ?? []) as unknown as RawInputTaxMonth[]) {
        inputTaxMonthByEntry.set(r.id, r.input_tax_month ?? null);
      }
    }
  } catch {
    // คอลัมน์ยังไม่ apply → คงเป็น null ทั้งหมด
  }

  // สถานะส่งไป FlowAccount (migration 0061) — ★ best-effort เหมือน input_tax_month ข้างบน
  //   คอลัมน์ยังไม่ apply → select error → ทุก entry ได้ default (not_synced) แทน ไม่ทำ list ทั้งหน้าพัง
  const flowaccountSyncByEntry = new Map<string, FlowAccountSyncInfo>();
  try {
    const { data: faData, error: faErr } = await db
      .from("bill_entries")
      .select(
        "id, flowaccount_sync_status, flowaccount_doc_type, flowaccount_doc_id, flowaccount_doc_no, flowaccount_synced_at, flowaccount_last_error, flowaccount_needs_resync"
      )
      .eq("tenant_id", tenantId)
      .in("id", entryIds);
    if (!faErr) {
      for (const r of (faData ?? []) as unknown as RawFlowAccountSync[]) {
        flowaccountSyncByEntry.set(r.id, mapFlowAccountSync(r));
      }
    }
  } catch {
    // คอลัมน์ยังไม่ apply → คงเป็น default (not_synced) ทั้งหมด
  }

  // lines ของ entry เหล่านี้
  const { data: lineData } = await db
    .from("bill_entry_lines")
    .select("id, entry_id, line_no, vat_type, description, account_code, account_name, amount, vat_amount, wht_rate, wht_amount, ai_filled, ai_low_confidence")
    .eq("tenant_id", tenantId)
    .in("entry_id", entryIds)
    .order("line_no", { ascending: true });
  const linesByEntry = new Map<string, BillEntryLine[]>();
  for (const r of (lineData ?? []) as unknown as RawLine[]) {
    const l = mapLine(r);
    const arr = linesByEntry.get(l.entryId) ?? [];
    arr.push(l);
    linesByEntry.set(l.entryId, arr);
  }

  // ชื่อลูกค้า (customers.name เป็น plain text — ไม่เข้ารหัส)
  const customerIds = [...new Set(rawEntries.map((e) => e.customer_id).filter((x): x is string => !!x))];
  const nameByCustomer = new Map<string, string>();
  if (customerIds.length > 0) {
    const { data: custData } = await db
      .from("customers")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .in("id", customerIds);
    for (const c of (custData ?? []) as { id: string; name: string | null }[]) {
      if (c.name) nameByCustomer.set(c.id, c.name);
    }
  }

  // object path ของไฟล์บิล (message_attachments.drive_file_id) — ให้ UI เอาไป sign
  const attachmentIds = [...new Set(rawEntries.map((e) => e.attachment_id).filter((x): x is string => !!x))];
  const pathByAttachment = new Map<string, string | null>();
  if (attachmentIds.length > 0) {
    const { data: attData } = await db
      .from("message_attachments")
      .select("id, drive_file_id")
      .eq("tenant_id", tenantId)
      .in("id", attachmentIds);
    for (const a of (attData ?? []) as { id: string; drive_file_id: string | null }[]) {
      pathByAttachment.set(a.id, a.drive_file_id);
    }
  }

  // รหัสผังบัญชีเงินฝากของ payment_bank_account_id (ให้ UI ทำ hint บัญชีคู่ตอนโอน)
  const bankAccountIds = [
    ...new Set(rawEntries.map((e) => e.payment_bank_account_id).filter((x): x is string => !!x)),
  ];
  const codeByBankAccount = new Map<string, string | null>();
  if (bankAccountIds.length > 0) {
    const { data: baData } = await db
      .from("customer_bank_accounts")
      .select("id, account_code")
      .eq("tenant_id", tenantId)
      .in("id", bankAccountIds);
    for (const b of (baData ?? []) as { id: string; account_code: string | null }[]) {
      codeByBankAccount.set(b.id, b.account_code);
    }
  }

  const entries: BillEntry[] = rawEntries.map((e) => ({
    id: e.id,
    tenantId: e.tenant_id,
    attachmentId: e.attachment_id,
    customerId: e.customer_id,
    customerName: e.customer_id ? nameByCustomer.get(e.customer_id) ?? null : null,
    attachmentObjectPath: e.attachment_id ? pathByAttachment.get(e.attachment_id) ?? null : null,
    uploadPath: e.upload_path,
    uploadName: e.upload_name,
    uploadMime: e.upload_mime,
    entryType: e.entry_type === "sale" ? "sale" : e.entry_type === "purchase" ? "purchase" : "unspecified",
    docDate: e.doc_date,
    docNo: e.doc_no,
    counterpartyName: e.counterparty_name,
    counterpartyTaxId: e.counterparty_tax_id,
    sellerName: e.seller_name,
    sellerTaxId: e.seller_tax_id,
    buyerName: e.buyer_name,
    buyerTaxId: e.buyer_tax_id,
    whtForm: e.wht_form === "pnd3" || e.wht_form === "pnd53" ? e.wht_form : null,
    paymentMethod: asPaymentMethodDb(e.payment_method),
    paymentBankAccountId: e.payment_bank_account_id,
    paymentBankAccountCode: e.payment_bank_account_id
      ? codeByBankAccount.get(e.payment_bank_account_id) ?? null
      : null,
    status: e.status === "confirmed" ? "confirmed" : "draft",
    source: e.source === "manual" ? "manual" : "ai",
    aiConfidence: e.ai_confidence,
    notes: e.notes,
    inputTaxMonth: inputTaxMonthByEntry.get(e.id) ?? null,
    flowaccountSync: flowaccountSyncByEntry.get(e.id) ?? defaultFlowAccountSync(),
    createdAt: e.created_at,
    confirmedAt: e.confirmed_at,
    lines: linesByEntry.get(e.id) ?? [],
  }));

  return { entries, summary: summarizeEntries(entries) };
}

function emptySummary(): { purchase: EntrySummary; sale: EntrySummary } {
  const zero = (): EntrySummary => ({ count: 0, amount: 0, vat: 0, wht: 0, net: 0 });
  return { purchase: zero(), sale: zero() };
}
