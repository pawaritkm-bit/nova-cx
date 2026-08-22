import type { SupabaseClient } from "@supabase/supabase-js";
import { extractBillData, extractBillsData, type ExtractedBill, type ExtractedLine } from "@/lib/ai/bill-extract";
import { buildChartByCode, type ChartAccount, type ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { suggestWhtRate } from "@/lib/accounting/wht";
import { calcVat } from "@/lib/accounting/calc";
import { suggestPaymentMethod } from "@/lib/accounting/payment";
import { getCustomerShareCircleFlag } from "@/lib/share-circles/queries";
import { classifyShareCircleImage } from "@/lib/ai/bill-classify";

/**
 * Bill extract worker — ไล่บิลที่เก็บแล้วแต่ยังไม่มี bill_entries → AI สกัด → สร้าง draft
 *   (สำหรับหน้า "ลงบันทึกบัญชี ภาษีซื้อ/ขาย")
 *
 * เลือกบิลที่: fetch_status='stored' และ attachment_type in ('image','file')
 *   และ doc_kind in ('sale','purchase','handwritten','cash') และ "ยังไม่มี bill_entries"
 *   (dedup ด้วย unique index บน attachment_id — กันสร้างซ้ำ)
 *
 * ★ high-confidence only: extractBillData เว้น null ช่องที่ไม่มั่นใจแล้ว
 *   worker แค่บันทึกตามนั้น — line ที่ AI เติมค่าจริง → ai_filled=true, ช่อง null = ไม่เติม
 * ★ entry_type (ซื้อ/ขาย): AI ไม่ตัดสิน (บิลใบเดียวเป็น "ขาย" ของผู้ขาย/"ซื้อ" ของผู้ซื้อ) —
 *   worker จับคู่ "ลูกค้าเรา" (customer ของ chat_group) กับ seller/buyer ที่ AI อ่าน:
 *     ลูกค้าเรา = ผู้ขาย → 'sale' (counterparty = ผู้ซื้อ)
 *     ลูกค้าเรา = ผู้ซื้อ → 'purchase' (counterparty = ผู้ขาย)
 *     จับคู่ไม่ชัด/ไม่มีข้อมูลลูกค้า → 'unspecified' (รอคนเลือกในหน้า UI) — ไม่เดา
 *   เก็บ seller และ buyer ที่ AI อ่านไว้ทั้งคู่ ให้ UI โชว์ตอน unspecified
 * ★ ไฟล์เอกสาร (attachment_type='file', doc_kind='file'): ดึงมาสร้าง bill_entry ด้วย —
 *   PDF → ให้ AI อ่าน (extractBillsData/gpt-5-mini อ่าน PDF ได้) · Excel/doc/อ่านไม่ได้ →
 *   "draft ว่าง" ให้คนคีย์ (ไฟล์แนบเปิด/ดาวน์โหลดได้เหมือนบิลรูป — ไม่ให้บิลตกหล่นจากคิว)
 * ★ degrade: ไม่มี OpenAI key → extractBillData คืน null → ยังสร้าง draft ว่างให้คนคีย์
 * ★ PDPA: ไม่ log objectPath/เนื้อบิล/ตัวเลข — log แค่ error สั้น ๆ
 */

const BILLS_BUCKET = "bills";

/** doc_kind ที่ถือเป็นบิลต้องลงบัญชี */
const BILL_DOC_KINDS = ["sale", "purchase", "handwritten", "cash"];

/**
 * doc_kind ที่ eligible เข้าคิวสกัด = บิลรูป (BILL_DOC_KINDS) + 'file' (ไฟล์เอกสาร PDF/Excel/doc)
 *   ★ ไฟล์เอกสารได้ doc_kind='file' ตอน fetch (attachments.ts) — ไม่คัด AI → ต้อง eligible เองที่นี่
 *     เพื่อสร้าง bill_entry (draft): PDF ให้ AI อ่าน, เอกสารอื่น = draft ว่างพร้อมไฟล์แนบ
 */
const EXTRACT_ELIGIBLE_DOC_KINDS = [...BILL_DOC_KINDS, "file"];

/** doc_kind ที่ "ไม่ใช่ใบกำกับภาษี" → ไม่มี VAT แน่นอน (บังคับ novat ทุก line ไม่ต้องเดา) */
const NONVAT_DOC_KINDS = new Set(["handwritten", "cash", "slip"]);

export type ExtractWorkerResult = {
  /** จำนวนบิลที่หยิบมาพิจารณา */
  scanned: number;
  /** จำนวน entry ที่สร้างใหม่ (draft) */
  created: number;
  /** จำนวนที่สกัดด้วย AI สำเร็จ (มี field อย่างน้อย 1) */
  extracted: number;
  /** จำนวนที่สร้าง draft ว่าง (PDF / ไม่มี key / สกัดไม่ได้) */
  blank: number;
  /** จำนวนบิล "ซ้ำ" ที่ข้าม (ไฟล์ไบต์เดียวกันกับบิลที่มีอยู่แล้ว — ไม่อ่าน/ไม่สร้างซ้ำ) */
  duplicate?: number;
  /** ปิดฟีเจอร์ (ไม่มี service env) — worker เป็น no-op */
  disabled?: boolean;
};

/** แถวบิลที่รอสกัด (join chat_group เพื่อจับคู่ลูกค้า) */
type QueueRow = {
  id: string;
  tenant_id: string;
  attachment_type: string | null;
  doc_kind: string | null;
  drive_file_id: string | null;
  chat_message_id: string | null;
  sha256: string | null;
};

/** เดา mime จากนามสกุลไฟล์ (fallback image/jpeg) */
export function mimeFromPath(path: string): string {
  const m = path.toLowerCase();
  if (m.endsWith(".png")) return "image/png";
  if (m.endsWith(".gif")) return "image/gif";
  if (m.endsWith(".webp")) return "image/webp";
  if (m.endsWith(".heic")) return "image/heic";
  if (m.endsWith(".heif")) return "image/heif";
  if (m.endsWith(".pdf")) return "application/pdf";
  return "image/jpeg";
}

/** true = ไฟล์ที่ vision อ่านไม่ได้ (PDF/เอกสาร) → สร้าง draft ว่าง */
function isNonImage(attachmentType: string | null, mime: string): boolean {
  return attachmentType === "file" || mime === "application/pdf" || !mime.startsWith("image/");
}

/**
 * ★ cache ผังบัญชีต่อ tenant ภายในรอบ worker เดียว (docs/06 A6) — โหลดครั้งเดียวต่อ tenant
 *   ไม่ query ซ้ำต่อบิล (cron อาจสแกนหลาย tenant ในรอบเดียว — cache key ตาม tenant_id)
 */
function createChartCache(db: SupabaseClient) {
  const cache = new Map<string, Promise<ChartAccount[]>>();
  return function getChart(tenantId: string): Promise<ChartAccount[]> {
    let p = cache.get(tenantId);
    if (!p) {
      p = listChartOfAccounts(db, tenantId);
      cache.set(tenantId, p);
    }
    return p;
  };
}

/** ปัดทศนิยม 2 ตำแหน่ง (ยอดเงิน) */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * คำนวณหัก ณ ที่จ่ายต่อบรรทัด (pure — เทสต์ได้) — ★ เป็น "ค่าแนะนำ ไม่ล็อก" นักบัญชีแก้ได้
 *   - อัตรา (rate): ใช้ค่าที่ AI อ่านจากบิลก่อน (aiRate) · ไม่มี → แนะนำจากประเภทบัญชี suggestWhtRate
 *   - ยอดหัก (amount): ใช้ค่าที่ AI อ่านก่อน (aiAmount) · ไม่มี → auto-คำนวณ round2(amount*rate/100)
 *     เฉพาะเมื่อมีทั้งอัตรา (>0) และฐาน amount (>0) — ไม่มีฐาน = 0 (ไม่เดา)
 */
export function resolveLineWht(
  aiRate: number | null | undefined,
  aiAmount: number | null | undefined,
  amount: number,
  accountCode: string | null
): { wht_rate: number; wht_amount: number } {
  const rate = aiRate ?? suggestWhtRate(accountCode);
  let whtAmount: number;
  if (aiAmount != null) whtAmount = aiAmount;
  else if (rate > 0 && amount > 0) whtAmount = round2((amount * rate) / 100);
  else whtAmount = 0;
  return { wht_rate: rate, wht_amount: whtAmount };
}

/**
 * สร้างแถว bill_entry_lines จากผลสกัด (ใช้ร่วมทั้งสกัดใหม่ + re-extract) — ★ ที่เดียวคุม WHT/บัญชี
 *   - ชื่อบัญชี: ดึงจากผังกลางเสมอ (ไม่เชื่อชื่อจากโมเดล)
 *   - WHT: AI อ่านได้ใช้เลย · ไม่มี → แนะนำจากบัญชี (resolveLineWht)
 *   - forceNoVat: เอกสารเขียนมือ/เงินสด/สลิป บังคับ novat
 *   - aiUsed: true เมื่อสกัดด้วย AI สำเร็จ (ใช้ตั้ง ai_filled — PDF/degrade = false)
 *   ไม่มี line เลย → สร้าง 1 บรรทัดว่างให้คนคีย์ (ไม่ทิ้งทั้งใบ)
 *   @param ctx.chartByCode ผังบัญชีของ tenant (map รหัส→บัญชี) — default {} เพื่อ backward-compat
 *     ระดับ compile เท่านั้น (ผู้เรียกจริงต้องส่งผังจริงของ tenant มาเสมอ ไม่งั้น account_name จะว่าง)
 */
export function buildEntryLineRows(
  lines: ExtractedLine[] | null | undefined,
  ctx: { entryId: string; tenantId: string; forceNoVat: boolean; aiUsed: boolean; chartByCode?: ChartByCode }
): Record<string, unknown>[] {
  const chartByCode = ctx.chartByCode ?? {};
  const src: ExtractedLine[] =
    lines && lines.length > 0
      ? lines
      : [
          {
            vat_type: "vat",
            description: null,
            amount: null,
            vat_amount: null,
            account_code: null,
            wht_rate: null,
            wht_amount: null,
            low_confidence: false,
          },
        ];
  return src.map((l, i) => {
    const accountCode = l.account_code ?? null;
    const accountName = accountCode ? chartByCode[accountCode]?.name ?? null : null;
    const amount = l.amount ?? 0;
    const vatType = ctx.forceNoVat ? ("novat" as const) : l.vat_type;
    // ★ VAT: AI อ่านได้ใช้เลย · ไม่มี → auto-คำนวณจากยอด×7% "เฉพาะ line ที่เป็น VAT"
    //   (calcVat: novat=0 เสมอ → บิลไม่มี VAT ยังเป็น 0) — เป็นค่าคำนวณ ไม่ล็อก นักบัญชีแก้ได้
    const vatAmount = l.vat_amount ?? calcVat(amount, vatType);
    const { wht_rate, wht_amount } = resolveLineWht(l.wht_rate, l.wht_amount, amount, accountCode);
    const aiFilled = ctx.aiUsed && (l.amount !== null || l.vat_amount !== null || accountCode !== null);
    // ★ true เมื่อ AI "เดาเติม" ช่องเสี่ยง (amount/vat/บัญชี conf ต่ำ) → UI ติดป้าย "AI เดา — ตรวจ"
    const aiLowConfidence = ctx.aiUsed && !!l.low_confidence;
    return {
      entry_id: ctx.entryId,
      tenant_id: ctx.tenantId,
      line_no: i + 1,
      vat_type: vatType,
      description: l.description,
      account_code: accountCode,
      account_name: accountName,
      amount,
      vat_amount: vatAmount,
      wht_rate,
      wht_amount,
      ai_filled: aiFilled,
      ai_low_confidence: aiLowConfidence,
    };
  });
}

/** บรรทัดขั้นต่ำที่ใช้ตัดสิน "ว่าง/ไม่ครบจริง" (สำหรับ re-extract) */
export type ReextractableLine = {
  amount: number | null;
  vat_amount: number | null;
  account_code: string | null;
  description: string | null;
};

/**
 * entry นี้ "ว่าง/ไม่ครบจริง" (ยังไม่มีใครคีย์) ไหม? (pure — เทสต์ได้)
 *   ว่างจริง = ไม่มี line เลย หรือ "ทุก" line ไม่มีข้อมูลเลย
 *     (amount=0 และ vat_amount=0 และ account_code null และ description ว่าง)
 *   ★ มี line ใดมีข้อมูลแม้ช่องเดียว = "คนอาจคีย์แล้ว" → false (ห้ามแตะ/สกัดทับ)
 */
export function isEmptyReextractable(lines: ReextractableLine[]): boolean {
  return lines.every(
    (l) =>
      (l.amount ?? 0) === 0 &&
      (l.vat_amount ?? 0) === 0 &&
      l.account_code == null &&
      (l.description == null || String(l.description).trim() === "")
  );
}

export type EntryType = "purchase" | "sale" | "unspecified";

/** ผลตัดสินฝั่ง + คู่ค้า (อีกฝั่งที่ไม่ใช่ลูกค้าเรา) */
export type SideDecision = {
  entryType: EntryType;
  counterpartyName: string | null;
  counterpartyTaxId: string | null;
};

/** ตัวตนลูกค้าเรา (ใช้จับฝั่งซื้อ/ขาย) */
export type CustomerIdentity = {
  name: string | null;
  businessName: string | null;
  taxId: string | null;
};

/** ฝั่งคู่ค้าในบิล (ชื่อ+เลขภาษี ที่ AI อ่าน) */
export type BillParty = { name: string | null; taxId: string | null };

/** เกณฑ์ fuzzy ชื่อ: ผ่านเมื่อคะแนน >= ACCEPT และชนะอีกฝั่งเกิน MARGIN */
const NAME_ACCEPT = 0.6;
const NAME_MARGIN = 0.1;

/**
 * normalize ชื่อคู่ค้า/ลูกค้าเพื่อจับคู่ (ตัดคำนำหน้านิติบุคคล/ช่องว่าง/อักขระ)
 *   ให้ "บริษัท เอ บี ซี จำกัด" ≈ "เอบีซี"
 */
export function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(
      /บริษัทมหาชนจำกัด|บริษัท|จำกัดมหาชน|มหาชน|จำกัด|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|ห้างหุ้นส่วน|หจก\.?|จก\.?|บจก\.?|บจ\.?|บมจ\.?|co\.,?|ltd\.?|company|limited|partnership/g,
      ""
    )
    .replace(/[\s.,\-_()（）"'`]/g, "");
}

/** strip ให้เหลือเฉพาะตัวเลข (ใช้เทียบเลขภาษี — ตัดขีด/ช่องว่าง/อักขระ) */
export function digitsOnly(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

/** Levenshtein distance (เผื่อพิมพ์ผิด/AI อ่านเพี้ยน 1-2 ตัว) */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** เซตของ bigram (คู่ตัวอักษรติดกัน) สำหรับ Dice coefficient */
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient ของ bigram (ทนต่อสลับ/เพี้ยนบางส่วน) 0..1 */
function diceCoefficient(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ba = bigrams(a);
  const bb = bigrams(b);
  let overlap = 0;
  for (const [g, ca] of ba) {
    const cb = bb.get(g);
    if (cb) overlap += Math.min(ca, cb);
  }
  const total = [...ba.values()].reduce((s, n) => s + n, 0) + [...bb.values()].reduce((s, n) => s + n, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

/**
 * ความเหมือนชื่อ (หลัง normalize) 0..1 — รวมหลายสัญญาณ:
 *   - substring 2 ทาง (ชื่อสั้นอยู่ในชื่อยาว) → 0.85 (จับ "ยูนิเวิร์ส" ⊂ "ยูนิเวิร์สเทรดดิ้ง")
 *   - Levenshtein similarity (เผื่อ AI อ่านเพี้ยน "ยูนิเวิร์ส"→"ยูนิไวส์")
 *   - Dice bigram (เผื่อสลับ/บางส่วน)
 *   คืน max ของสามสัญญาณ · ชื่อสั้นเกิน (<3) = 0 (กัน match มั่ว)
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na.length < 3 || nb.length < 3) return 0;
  let score = 0;
  if (na.includes(nb) || nb.includes(na)) score = 0.85;
  const lev = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  const dice = diceCoefficient(na, nb);
  return Math.max(score, lev, dice);
}

/** คะแนน fuzzy ชื่อลูกค้าเรา (ลอง name + business_name) เทียบชื่อคู่ค้า 1 ฝั่ง */
function bestNameScore(customer: CustomerIdentity, partyName: string | null): number {
  if (!partyName) return 0;
  const candidates = [customer.name, customer.businessName].filter((n): n is string => !!n);
  let best = 0;
  for (const c of candidates) best = Math.max(best, nameSimilarity(c, partyName));
  return best;
}

/** ประกอบผลลัพธ์ตามฝั่งที่ลูกค้าเราเป็น (seller=ขาย / buyer=ซื้อ) */
function sideResult(side: "seller" | "buyer", seller: BillParty, buyer: BillParty): SideDecision {
  return side === "seller"
    ? { entryType: "sale", counterpartyName: buyer.name, counterpartyTaxId: buyer.taxId }
    : { entryType: "purchase", counterpartyName: seller.name, counterpartyTaxId: seller.taxId };
}

/**
 * ตัดสิน entry_type จาก "ลูกค้าเรา" เทียบ seller/buyer ที่ AI อ่าน (pure — เทสต์ได้/re-run ได้)
 *   ★ ชั้น 1 (definitive): เลขภาษี — ลูกค้าเรามี tax_id → เทียบเลขล้วนกับ seller/buyer
 *     ตรงฝั่งเดียว = ตัดสินทันที (แม่นสุด · AI อ่านตัวเลขชัดกว่าชื่อไทย)
 *   ★ ชั้น 2 (fallback): fuzzy ชื่อไทย (normalize + substring + Levenshtein + Dice)
 *     ผ่านเกณฑ์ NAME_ACCEPT และชนะอีกฝั่งเกิน NAME_MARGIN = ตัดสินฝั่งนั้น
 *   ไม่เข้าเงื่อนไขไหน / กำกวม (สองฝั่งใกล้กัน) / ไม่มีข้อมูล → 'unspecified' (ไม่เดา)
 */
export function decideEntrySide(
  customer: CustomerIdentity,
  seller: BillParty,
  buyer: BillParty
): SideDecision {
  const unspecified: SideDecision = { entryType: "unspecified", counterpartyName: null, counterpartyTaxId: null };

  // ---- ชั้น 1: เลขภาษี (definitive) ----
  const custTax = digitsOnly(customer.taxId);
  if (custTax.length >= 10) {
    const sellerTax = digitsOnly(seller.taxId);
    const buyerTax = digitsOnly(buyer.taxId);
    const matchSeller = sellerTax.length >= 10 && sellerTax === custTax;
    const matchBuyer = buyerTax.length >= 10 && buyerTax === custTax;
    if (matchSeller && !matchBuyer) return sideResult("seller", seller, buyer);
    if (matchBuyer && !matchSeller) return sideResult("buyer", seller, buyer);
    // ตรงทั้งคู่ (เลขภาษีเดียวกันสองฝั่ง — ผิดปกติ) → ตกไปช่องชื่อ
  }

  // ---- ชั้น 2: fuzzy ชื่อ ----
  const sellerScore = bestNameScore(customer, seller.name);
  const buyerScore = bestNameScore(customer, buyer.name);
  if (sellerScore >= NAME_ACCEPT && sellerScore - buyerScore >= NAME_MARGIN) {
    return sideResult("seller", seller, buyer);
  }
  if (buyerScore >= NAME_ACCEPT && buyerScore - sellerScore >= NAME_MARGIN) {
    return sideResult("buyer", seller, buyer);
  }
  return unspecified;
}

const EMPTY_CUSTOMER: CustomerIdentity & { id: null } = {
  id: null,
  name: null,
  businessName: null,
  taxId: null,
};

/**
 * หาลูกค้าเรา จาก chat_message → chat_group.customer_id → ชื่อ+เลขภาษี (best-effort)
 *   คืน { id, name, businessName, taxId } (ใช้จับฝั่งซื้อ/ขาย)
 *   พลาด/ไม่เจอ = id:null (ไม่ทำให้ทั้ง entry ล้ม)
 */
async function resolveCustomer(
  db: SupabaseClient,
  chatMessageId: string | null
): Promise<CustomerIdentity & { id: string | null }> {
  if (!chatMessageId) return EMPTY_CUSTOMER;
  try {
    const { data: msg } = await db
      .from("chat_messages")
      .select("chat_group_id")
      .eq("id", chatMessageId)
      .maybeSingle();
    const groupId = (msg as { chat_group_id?: string } | null)?.chat_group_id;
    if (!groupId) return EMPTY_CUSTOMER;
    const { data: grp } = await db
      .from("chat_groups")
      .select("customer_id")
      .eq("id", groupId)
      .maybeSingle();
    const customerId = (grp as { customer_id?: string | null } | null)?.customer_id ?? null;
    if (!customerId) return EMPTY_CUSTOMER;

    const { data: cust } = await db
      .from("customers")
      .select("name, business_name, tax_id")
      .eq("id", customerId)
      .maybeSingle();
    const c = cust as { name?: string | null; business_name?: string | null; tax_id?: string | null } | null;
    return {
      id: customerId,
      name: c?.name ?? null,
      businessName: c?.business_name ?? null,
      taxId: c?.tax_id ?? null,
    };
  } catch {
    return EMPTY_CUSTOMER;
  }
}

/**
 * เพดานสแกน eligible ต่อรอบ — ครอบคลุมจำนวนบิลทั้งหมดที่คาดว่ามี (หลักร้อย–พัน)
 *   เรียงเก่า→ใหม่แล้วตัด done ออก จึงเดินหน้าได้เรื่อย ๆ ตราบใดที่ eligible ≤ ค่านี้
 *   (ถ้าโตเกินนี้จริง ค่อยเพิ่ม/ทำ pagination — ตอนนี้พอสำหรับ scale ปัจจุบัน)
 */
const CANDIDATE_SCAN_LIMIT = 30000;
/** เพดานดึง done set (attachment ที่มี entry แล้ว) */
const DONE_SCAN_LIMIT = 50000;

/**
 * ★ pagination สำหรับ reextract/backfill — entry เป้าหมาย (ว่าง/ไม่ครบ) กระจายทั่วกอง
 *   ไม่ได้อยู่แค่ N ใบเก่าสุด → ต้องไล่เป็นหน้าจนเจอครบ limit (ไม่พึ่งชุดแรกชุดเดียว)
 */
/** entry ต่อหน้า — โหลด line ≤ 200 ids/หน้า (กัน .in() ยาวชน URL limit ของ PostgREST) */
const REEXTRACT_PAGE_SIZE = 200;
/** เพดานจำนวนหน้า/รอบ (30×200 = 6000 entry) — bounded กันวนไม่จบ */
const REEXTRACT_MAX_PAGES = 30;

/**
 * ไล่ entry เป็นหน้า (cursor pagination บน created_at asc) จนสะสม "เป้าหมาย" ครบ limit — bounded/เทสต์ได้
 *   ★ ทำไม cursor: entry ที่ต้องทำกระจายทั่วกอง — ถ้าดึงแค่ N ใบเก่าสุดแล้วกรอง อาจเจอ 0 (คิวค้าง)
 *   - fetchPage(cursor,pageSize): ดึง entry หน้าถัดไป (created_at > cursor) เรียง asc — ต้อง select created_at
 *   - filterTargets(page): โหลด line ของหน้านี้ (≤pageSize ids) + กรองเฉพาะเป้าหมาย → คืน targets
 *   หยุดเมื่อ: ครบ limit / หน้าว่างหรือไม่เต็ม (หมดกอง) / ครบ maxPages
 *   ★ cursor เดินตาม "ทุก entry ในหน้า" (ไม่ใช่เฉพาะเป้าหมาย) → เดินข้ามใบที่เติมแล้วไปเรื่อย ๆ
 */
export async function collectTargetEntries<T extends { created_at: string | null }>(args: {
  limit: number;
  fetchPage: (cursor: string | null, pageSize: number) => Promise<T[]>;
  filterTargets: (page: T[]) => Promise<T[]>;
  pageSize?: number;
  maxPages?: number;
}): Promise<T[]> {
  const pageSize = args.pageSize ?? REEXTRACT_PAGE_SIZE;
  const maxPages = args.maxPages ?? REEXTRACT_MAX_PAGES;
  const targets: T[] = [];
  let cursor: string | null = null;
  for (let p = 0; p < maxPages; p += 1) {
    const page = await args.fetchPage(cursor, pageSize);
    if (page.length === 0) break; // ไม่มี entry เหลือ
    const hits = await args.filterTargets(page);
    for (const h of hits) {
      targets.push(h);
      if (targets.length >= args.limit) return targets; // ครบ limit → พอ
    }
    if (page.length < pageSize) break; // หน้าไม่เต็ม = ใบสุดท้ายของกองแล้ว
    const last = page[page.length - 1].created_at;
    if (last == null) break; // created_at ว่าง → เลื่อน cursor ต่อไม่ได้ (กันวนไม่จบ)
    cursor = last;
  }
  return targets;
}

/**
 * เลือกบิลที่ยังไม่มี entry (subtract-done + เรียงเก่า→ใหม่) — แยกออกมาให้เทสต์ได้
 *   1) done set = attachment_id ที่มี bill_entries (ยังไม่ลบ) ทั้งหมด
 *   2) eligible = message_attachments (stored + เอกสารการเงิน + มีไฟล์) เรียง created_at asc
 *   3) ตัด done ออก → slice(limit) · เก่าก่อน = คิวเดินหน้าไม่ค้างชุดเดิม
 */
/**
 * มี "บิลเดิม" (ไฟล์ไบต์เดียวกัน = sha256 ตรงกัน) ที่สร้าง bill_entry ไว้แล้ว (ยังไม่ลบ) ไหม
 *   → ใช้กันบิลซ้ำ: ลูกค้าส่งบิลใบเดิมซ้ำหลายข้อความ → AI ไม่อ่าน/ไม่สร้าง draft ซ้ำ
 *   ★ กันเฉพาะ "ไฟล์เดียวกันเป๊ะ" (sha256) — ถ่ายรูปบิลใบเดิมใหม่ (ไบต์ต่างกัน) ยังจับไม่ได้ (นักบัญชีลบเองได้)
 */
async function hasEntryForSameHash(
  db: SupabaseClient,
  tenantId: string,
  sha256: string,
  exceptAttachmentId: string
): Promise<boolean> {
  try {
    const { data: sib } = await db
      .from("message_attachments")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("sha256", sha256)
      .neq("id", exceptAttachmentId)
      .limit(50);
    const ids = ((sib ?? []) as { id: string }[]).map((a) => a.id);
    if (ids.length === 0) return false;
    const { data: dup } = await db
      .from("bill_entries")
      .select("id")
      .in("attachment_id", ids)
      .is("deleted_at", null)
      .limit(1);
    return !!(dup && dup.length);
  } catch {
    return false; // เช็กไม่ได้ → ไม่บล็อก (ปล่อยให้สร้างตามปกติ ดีกว่าพลาดบิลจริง)
  }
}

export async function selectExtractionCandidates(
  db: SupabaseClient,
  limit: number,
  chatGroupId?: string
): Promise<QueueRow[]> {
  // 1) done set (ทุก tenant — cron เป็น service-role สแกนรวม)
  //    ★ นับรวม entry ที่ถูกลบ (soft-delete) ด้วย — ไม่กรอง deleted_at
  //      บิลที่นักบัญชีลบทิ้ง = "ทำแล้ว" ไม่ต้องสกัดซ้ำ (กัน cron ปลุกบิลที่ลบกลับมา)
  //      → ทำให้ "ลบ" กู้คืนได้จริง (soft-delete เฉย ๆ ไม่ต้องทำลายไฟล์/มาร์ค attachment)
  //    ★★ บั๊กร้ายแรง (แก้): `.limit(50000)` ไม่ได้ผล — PostgREST cap ที่ max-rows (ดีฟอลต์ 1000) ต่อ request
  //       → doneSet ได้แค่ 1000 ตัวแรก · ถ้า "ทำแล้ว" > 1000 ตัว ที่เหลือหลุด set → ถูกหยิบเป็น candidate ซ้ำ
  //       → insert ชน unique(attachment_id) 23505 → continue → created=0 "ถาวร" (คิวไม่เดินเลย)
  //       วิธีแก้: page ทีละ 1000 (ordered by id เสถียร) จนครบ/ถึง DONE_SCAN_LIMIT
  const DONE_PAGE = 1000;
  const done = new Set<string>();
  for (let from = 0; from < DONE_SCAN_LIMIT; from += DONE_PAGE) {
    const { data: doneData, error: doneErr } = await db
      .from("bill_entries")
      .select("attachment_id")
      .not("attachment_id", "is", null)
      .order("attachment_id", { ascending: true })
      .range(from, from + DONE_PAGE - 1);
    if (doneErr) {
      console.warn(`[bill-extract-worker] select done error code=${(doneErr as { code?: string }).code ?? "?"}`);
      return [];
    }
    const rows = (doneData ?? []) as { attachment_id: string | null }[];
    for (const e of rows) if (e.attachment_id) done.add(e.attachment_id);
    if (rows.length < DONE_PAGE) break; // หน้าสุดท้าย
  }

  // ★ group-scoped (ใช้ตอน "ผูกลูกค้าทีหลัง" → ดึงบิลของกลุ่มนั้นทันที): กรองด้วย inner join chat_messages
  if (chatGroupId) {
    const { data, error } = await db
      .from("message_attachments")
      .select("id, tenant_id, attachment_type, doc_kind, drive_file_id, chat_message_id, sha256, chat_messages!inner(chat_group_id)")
      .eq("fetch_status", "stored")
      .in("attachment_type", ["image", "file"])
      .in("doc_kind", EXTRACT_ELIGIBLE_DOC_KINDS)
      .not("drive_file_id", "is", null)
      .eq("chat_messages.chat_group_id", chatGroupId)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) {
      console.warn(`[bill-extract-worker] select group queue error code=${(error as { code?: string }).code ?? "?"}`);
      return [];
    }
    const eligible = (data ?? []) as unknown as QueueRow[];
    return eligible.filter((r) => !done.has(r.id)).slice(0, limit);
  }

  // 2) eligible เรียงเก่า→ใหม่ — ★ page ทีละ 1000 จนเก็บ candidate ที่ "ยังไม่ทำ" ครบ limit
  //    (บั๊กเดิม: จำกัดหน้าต่างแค่ CANDIDATE_SCAN_LIMIT ตัวเก่าสุด — ถ้าตัวเก่าสุดทำไปหมดแล้ว
  //     backlog ที่อยู่นอกหน้าต่างจะไม่เคยถูกเห็น → ค้างถาวร · แก้ด้วย pagination จนถึง backlog จริง)
  const PAGE = 1000;
  const collected: QueueRow[] = [];
  for (let from = 0; from < CANDIDATE_SCAN_LIMIT && collected.length < limit; from += PAGE) {
    const { data, error } = await db
      .from("message_attachments")
      .select("id, tenant_id, attachment_type, doc_kind, drive_file_id, chat_message_id, sha256, chat_messages!inner(chat_groups!inner(customer_id))")
      .eq("fetch_status", "stored")
      .in("attachment_type", ["image", "file"])
      .in("doc_kind", EXTRACT_ELIGIBLE_DOC_KINDS)
      .not("drive_file_id", "is", null)
      // ★ เฉพาะกลุ่มที่ผูกลูกค้าแล้ว — กลุ่มยังไม่ผูกไม่ให้ติดคิว (กันกินสล็อตหน้าคิว = created 0)
      .not("chat_messages.chat_groups.customer_id", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn(`[bill-extract-worker] select queue error code=${(error as { code?: string }).code ?? "?"}`);
      break;
    }
    const page = (data ?? []) as unknown as QueueRow[];
    if (page.length === 0) break; // หมดกอง
    for (const r of page) {
      if (!done.has(r.id)) collected.push(r);
      if (collected.length >= limit) break;
    }
  }
  return collected.slice(0, limit);
}

/**
 * ประมวลผลบิลที่รอสกัด (batch)
 *   @returns สรุปผล
 */
export async function processBillExtraction(
  db: SupabaseClient,
  opts: { limit?: number; chatGroupId?: string } = {}
): Promise<ExtractWorkerResult> {
  const limit = opts.limit ?? 10;
  const empty: ExtractWorkerResult = { scanned: 0, created: 0, extracted: 0, blank: 0 };

  // 1) หาบิลที่ "ยังไม่มี entry" จริง ๆ (กันคิวค้าง)
  //    ★ บั๊กเดิม: ดึง 50 ใบแรกตาม default order (ไม่มี ORDER BY) แล้วค่อยกรอง done ออก
  //      → ถ้า 50 ใบนั้น done หมด = เหลือ 0 ทั้งที่ยังมีอีกหลายร้อยใบ (created=0 ค้างตลอด)
  //    วิธีแก้ (subtract-done): ดึง attachment_id ที่ "มี entry แล้ว" มาเป็น set ก่อน →
  //      แล้วสแกน eligible แบบเรียงเก่า→ใหม่ (ครอบคลุมพอ) → ตัด done ออก → slice(limit)
  //      เก่าก่อน = คิวเดินหน้าไปเรื่อย ๆ จนครบ (ไม่วนอยู่ชุดเดิม)
  const rows = await selectExtractionCandidates(db, limit, opts.chatGroupId);
  if (rows.length === 0) return empty;

  // ★ A6: cache ผังบัญชีต่อ tenant ในรอบนี้ (cron อาจสแกนหลาย tenant) — ไม่ query ซ้ำต่อบิล
  const getChart = createChartCache(db);

  let scanned = 0;
  let created = 0;
  let extracted = 0;
  let blank = 0;
  let duplicate = 0;
  const seenSha = new Set<string>(); // กันบิลไบต์เดียวกันซ้ำ "ในรอบเดียวกัน"

  for (const row of rows) {
    scanned++;
    const objectPath = row.drive_file_id;
    if (!objectPath) continue;

    // ★ กันบิลซ้ำ: ไฟล์ไบต์เดียวกัน (sha256) กับบิลที่มีอยู่/ที่เพิ่งทำในรอบนี้ → ไม่อ่าน/ไม่สร้างซ้ำ
    if (row.sha256) {
      if (seenSha.has(row.sha256)) { duplicate++; continue; }
      if (await hasEntryForSameHash(db, row.tenant_id, row.sha256, row.id)) {
        duplicate++;
        // ไฟล์ไบต์เดียวกันมี entry แล้ว (attachment อื่น) → มาร์กออกจากคิว กันวนสแกนซ้ำถาวร (กิน slot)
        await db.from("message_attachments").update({ fetch_status: "skipped", fetch_error: "dup_hash" }).eq("id", row.id).eq("tenant_id", row.tenant_id);
        continue;
      }
      seenSha.add(row.sha256);
    }

    const lowerPath = objectPath.toLowerCase();

    // ★ ไฟล์บีบอัด/อาร์ไคฟ์ (zip/rar/7z/tar/gz/…) — ไม่ใช่บิล + AI เปิดอ่านไม่ได้
    //   → มาร์กออกจากคิว (fetch_status='skipped') กันสร้าง draft ว่างรกหน้าลงบันทึกบัญชี + กันวนสแกนซ้ำถาวร
    //   (ปุ่มอัปไฟล์เองก็ปฏิเสธไฟล์พวกนี้อยู่แล้ว — ให้คิว auto สอดคล้องกัน)
    if (/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|z|arj|cab|iso|lzh|ace)$/.test(lowerPath)) {
      await db
        .from("message_attachments")
        .update({ fetch_status: "skipped", fetch_error: "archive_unsupported" })
        .eq("id", row.id)
        .eq("tenant_id", row.tenant_id);
      continue;
    }

    // ★ ชนิดไฟล์ (จากนามสกุลบน storage) — ตัดสินว่า AI อ่านได้ไหม
    //   - รูป (image / นามสกุลรูป): vision อ่านได้ (extractBillData, gpt-4o-mini)
    //   - PDF: file input อ่านได้ (extractBillsData, gpt-5-mini อ่าน PDF ได้)
    //   - ไฟล์เอกสารอื่น (Excel/doc/csv): อ่านไม่ได้ → สร้าง draft ว่างพร้อมไฟล์แนบ
    const isPdf = lowerPath.endsWith(".pdf");
    const isImageExt = /\.(jpe?g|png|gif|webp|heic|heif)$/.test(lowerPath);
    const isImage = row.attachment_type === "image" || isImageExt;
    const isDocumentFile = !isImage; // ไฟล์ที่ไม่ใช่รูป (PDF/Excel/doc/…)
    const aiReadable = isImage || isPdf;
    const mime = isPdf ? "application/pdf" : mimeFromPath(objectPath);

    // 3) จับคู่ลูกค้าเราจาก chat_group (best-effort) — ทำก่อนดาวน์โหลด/AI เพื่อเช็คธงท้าวแชร์
    const customer = await resolveCustomer(db, row.chat_message_id);
    // ★ กฎ: ดึงบิลเข้าบัญชี "เฉพาะกลุ่มที่ผูกลูกค้าแล้ว" — ยังไม่ผูก → รอผูกก่อน (ไม่สร้าง entry · คงในคิว)
    if (!customer.id) continue;
    const shareFlag = customer.id
      ? await getCustomerShareCircleFlag(db, row.tenant_id, customer.id)
      : false;

    // ★ ลูกค้าท้าวแชร์ (is_share_circle=true) — guard เดิมต้องไม่พัง:
    //   - ไฟล์เอกสาร/PDF (ไม่ใช่รูป): "ข้ามการสร้างบิล" เหมือนพฤติกรรมเดิม (วงแชร์ไม่เคยได้บิลจากไฟล์
    //     เพราะเดิมไม่ดึงไฟล์เลย) → มาร์ก doc_kind='share_circle' ให้ออกจากคิว (กันวนสแกน/starve)
    //   - รูป: "แยกเนื้อหา" ด้วย AI (ลิสต์วงแชร์ vs บิลจริง) เหมือนเดิม — บิลจริงยังสร้าง
    //   ★ gate false-positive: ทำเฉพาะลูกค้า is_share_circle (flag=false → ลูกค้าปกติ flow เดิม 100%)
    //   preBuf: buf รูปที่ดาวน์โหลดแล้ว (ถ้าเป็นบิล) ให้ extract ใช้ต่อ — ไม่ดาวน์โหลดซ้ำ
    let preBuf: Buffer | null = null;
    if (shareFlag) {
      if (isDocumentFile) {
        // วงแชร์ + ไฟล์เอกสาร → ไม่สร้างบิล (guard เดิม) · มาร์กออกจากคิว
        await db
          .from("message_attachments")
          .update({ doc_kind: "share_circle" })
          .eq("id", row.id)
          .eq("tenant_id", row.tenant_id);
        continue;
      }
      // วงแชร์ + รูป → ดาวน์โหลด + classify ลิสต์วง/บิลจริง (เหมือนเดิม)
      try {
        const { data: blob, error: dlErr } = await db.storage.from(BILLS_BUCKET).download(objectPath);
        if (dlErr || !blob) {
          console.warn("[bill-extract-worker] share download failed");
          // ดาวน์โหลดไม่ได้ (ไฟล์หาย/path เพี้ยน) → มาร์กออกจากคิว กันวนสแกนซ้ำถาวร (กิน slot)
          await db.from("message_attachments").update({ doc_kind: "share_circle" }).eq("id", row.id).eq("tenant_id", row.tenant_id);
          continue;
        }
        preBuf = Buffer.from(await blob.arrayBuffer());
      } catch {
        console.warn("[bill-extract-worker] share download error");
        await db.from("message_attachments").update({ doc_kind: "share_circle" }).eq("id", row.id).eq("tenant_id", row.tenant_id);
        continue;
      }
      const sc = await classifyShareCircleImage(preBuf, mime);
      if (sc && sc.isShareList) {
        // ★ ลิสต์วงแชร์ (มั่นใจ) → ไม่สร้างบิล · มาร์ก doc_kind ให้ออกจาก eligible (กันวนสแกน/starve คิว)
        await db
          .from("message_attachments")
          .update({ doc_kind: "share_circle" })
          .eq("id", row.id)
          .eq("tenant_id", row.tenant_id);
        continue;
      }
      // ไม่ใช่ลิสต์วง (หรือ classify ไม่ได้/ไม่มั่นใจ) → สร้างบิลตามปกติ (keep-if-unsure: บิลจริงไม่หาย)
    }

    // 4) รูป/PDF → ดาวน์โหลด + AI สกัด · เอกสารอื่น (Excel/doc) → draft ว่าง (มีไฟล์แนบให้เปิด/ดาวน์โหลด)
    let bill = null as ExtractedBill | null;
    if (aiReadable) {
      let buf: Buffer | null = preBuf; // ★ reuse ถ้าดาวน์โหลดไปแล้ว (share-circle image branch)
      if (!buf) {
        try {
          const { data: blob, error: dlErr } = await db.storage
            .from(BILLS_BUCKET)
            .download(objectPath);
          if (dlErr || !blob) {
            console.warn("[bill-extract-worker] download failed");
            continue; // ดาวน์โหลดไม่ได้ → ข้าม (รอบหน้าลองใหม่ ไม่สร้าง entry)
          }
          buf = Buffer.from(await blob.arrayBuffer());
        } catch {
          console.warn("[bill-extract-worker] download error");
          continue;
        }
      }
      const chart = await getChart(row.tenant_id);
      if (isPdf) {
        // ★ PDF: ใช้ extractBillsData (gpt-5-mini อ่าน PDF ได้) แล้วเอา "บิลแรก"
        //   (1 attachment = 1 entry เพราะ attachment_id unique) · อ่านไม่ได้ = [] → bill=null (draft ว่าง)
        const bills = await extractBillsData(buf, mime, chart);
        bill = bills[0] ?? null;
      } else {
        // รูปบิลไลน์ = gpt-4o-mini (ประหยัด · ปริมาณมากทุกวันผ่าน cron)
        bill = await extractBillData(buf, mime, chart);
      }
    }

    // 5) ตัดสินฝั่งซื้อ/ขาย จากลูกค้าเรา (resolve แล้วด้านบน)
    const seller: BillParty = { name: bill?.seller_name ?? null, taxId: bill?.seller_tax_id ?? null };
    const buyer: BillParty = { name: bill?.buyer_name ?? null, taxId: bill?.buyer_tax_id ?? null };
    const decision = decideEntrySide(customer, seller, buyer);

    // 6) สร้าง bill_entries (draft) — attachment_id unique กันซ้ำ (ถ้าชนก็ข้าม)
    const { data: entryIns, error: entryErr } = await db
      .from("bill_entries")
      .insert({
        tenant_id: row.tenant_id,
        attachment_id: row.id,
        customer_id: customer.id,
        entry_type: decision.entryType,
        doc_date: bill?.doc_date ?? null,
        doc_no: bill?.doc_no ?? null,
        counterparty_name: decision.counterpartyName,
        counterparty_tax_id: decision.counterpartyTaxId,
        seller_name: seller.name,
        seller_tax_id: seller.taxId,
        buyer_name: buyer.name,
        buyer_tax_id: buyer.taxId,
        // ค่าแนะนำวิธีจ่าย/รับเงิน จาก doc_kind (เงินสด/สลิป=โอน/ใบกำกับ=เชื่อ) — นักบัญชีแก้ได้
        payment_method: suggestPaymentMethod(row.doc_kind, decision.entryType),
        status: "draft",
        source: "ai",
        ai_confidence: bill?.overall_confidence ?? null,
      })
      .select("id")
      .maybeSingle();

    if (entryErr) {
      // 23505 = unique violation (มี entry ของ attachment นี้แล้ว จากรอบทับกัน) → ข้ามเงียบ
      const code = (entryErr as { code?: string }).code;
      if (code !== "23505") {
        console.warn(`[bill-extract-worker] insert entry error code=${code ?? "?"}`);
      }
      continue;
    }
    const entryId = (entryIns as { id?: string } | null)?.id;
    if (!entryId) continue;

    // 7) สร้าง bill_entry_lines — ช่องที่ AI เว้น null = ไม่เติม (ค่า 0 ตาม default DB)
    //    ai_filled=true เฉพาะ line ที่ AI เติม amount/vat/บัญชี จริง (รู้ที่มา)
    // ★ เอกสารเขียนมือ/เงินสด/สลิป = ไม่ใช่ใบกำกับภาษี → บังคับ novat แน่นอน (ไม่ต้องเดา)
    //   เฉพาะ purchase/sale (ใบกำกับ) ค่อยใช้ vat_type ที่ AI ตัดสิน
    const forceNoVat = NONVAT_DOC_KINDS.has((row.doc_kind ?? "").trim().toLowerCase());
    const lineRows = buildEntryLineRows(bill?.lines, {
      entryId,
      tenantId: row.tenant_id,
      forceNoVat,
      aiUsed: !!bill,
      chartByCode: buildChartByCode(await getChart(row.tenant_id)),
    });
    const { error: lineErr } = await db.from("bill_entry_lines").insert(lineRows);
    if (lineErr) {
      console.warn(`[bill-extract-worker] insert lines error code=${(lineErr as { code?: string }).code ?? "?"}`);
      // entry แม่สร้างแล้ว — lines พลาดปล่อยไว้ (คนเพิ่ม line เองได้) ไม่ rollback
    }

    created++;
    const gotSomething =
      !!bill &&
      (!!bill.doc_no ||
        !!bill.doc_date ||
        !!bill.seller_name ||
        !!bill.buyer_name ||
        lineRows.some((l) => Number(l.amount) > 0));
    if (gotSomething) extracted++;
    else blank++;
  }

  return { scanned, created, extracted, blank, duplicate };
}

/**
 * สกัดข้อมูลบิลจาก "ไฟล์ที่อัปโหลดเอง" (upload_path) → เติมหัว/บรรทัดให้ entry ที่มีอยู่แล้ว
 *
 *   ใช้ตอนนักบัญชีอัปไฟล์เอง (รูป/PDF) → AI อ่านแล้วลงบัญชีให้ นักบัญชีแค่ตรวจ
 *   (ต่างจาก processBillExtraction ที่ทำงานกับบิลจากไลน์ผ่าน message_attachments)
 *
 * ★ เคารพประเภทที่ผู้ใช้เลือกตอนอัป (entry.entry_type) — counterparty ตามฝั่งนั้น
 * ★ อ่านได้เฉพาะ รูป + PDF (OpenAI file input) · excel/csv ข้าม → คืน extracted:false (คีย์เอง)
 * ★ ปลอดภัย: สกัดเฉพาะ entry ที่ยัง "ว่างจริง" (ยังไม่มีใครคีย์) — ไม่ทับงานคน
 * ★ degrade: ไม่มี key / ดาวน์โหลดพลาด / อ่านไม่ได้ → extracted:false (คง draft ว่างให้คีย์เอง)
 * ★ PDPA: ไม่ log path/เนื้อบิล/ตัวเลข
 */
/** สร้าง object หัวเอกสารจากบิลที่สกัดได้ · counterparty ตามฝั่งที่ผู้ใช้เลือก (ซื้อ→ผู้ขาย, ขาย→ผู้ซื้อ) */
function billHeadFields(bill: ExtractedBill, entryType: string | null): Record<string, unknown> {
  const seller = { name: bill.seller_name ?? null, taxId: bill.seller_tax_id ?? null };
  const buyer = { name: bill.buyer_name ?? null, taxId: bill.buyer_tax_id ?? null };
  const counterparty =
    entryType === "sale" ? buyer : entryType === "purchase" ? seller : { name: null, taxId: null };
  return {
    doc_date: bill.doc_date ?? null,
    doc_no: bill.doc_no ?? null,
    counterparty_name: counterparty.name,
    counterparty_tax_id: counterparty.taxId,
    seller_name: seller.name,
    seller_tax_id: seller.taxId,
    buyer_name: buyer.name,
    buyer_tax_id: buyer.taxId,
    source: "ai",
    ai_confidence: bill.overall_confidence ?? null,
  };
}

export async function extractUploadedEntry(
  db: SupabaseClient,
  tenantId: string,
  entryId: string
): Promise<{ extracted: boolean; count: number }> {
  const NONE = { extracted: false, count: 0 };

  // 1) โหลดหัว entry (scope tenant)
  const { data: e } = await db
    .from("bill_entries")
    .select("entry_type, status, customer_id, upload_path, upload_name, upload_mime")
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!e) return NONE;
  const entry = e as {
    entry_type: string | null;
    status: string | null;
    customer_id: string | null;
    upload_path: string | null;
    upload_name: string | null;
    upload_mime: string | null;
  };
  if (entry.status === "confirmed" || !entry.upload_path) return NONE;

  // 2) อ่านได้เฉพาะรูป + PDF
  const mime = (entry.upload_mime || mimeFromPath(entry.upload_path)).toLowerCase();
  const isImage = mime.startsWith("image/");
  const isPdf = mime.includes("pdf");
  if (!isImage && !isPdf) return NONE;

  // 3) กันทับงานคน — สกัดเฉพาะ entry ที่ยัง "ว่างจริง"
  const { data: curLines } = await db
    .from("bill_entry_lines")
    .select("amount, vat_amount, account_code, description")
    .eq("entry_id", entryId)
    .eq("tenant_id", tenantId);
  const existing = (curLines ?? []) as ReextractableLine[];
  if (existing.length > 0 && !isEmptyReextractable(existing)) return NONE;

  // 4) ดาวน์โหลดไฟล์ + สกัด "ทุกบิล" (เอกสารอาจรวมหลายใบ)
  let buf: Buffer;
  try {
    const { data: blob, error: dlErr } = await db.storage.from(BILLS_BUCKET).download(entry.upload_path);
    if (dlErr || !blob) return NONE;
    buf = Buffer.from(await blob.arrayBuffer());
  } catch {
    return NONE;
  }
  // ★ ผังบัญชีของ tenant นี้ — โหลดครั้งเดียว (entry เดี่ยว ไม่ loop หลาย tenant)
  const chart = await listChartOfAccounts(db, tenantId);
  const bills = await extractBillsData(buf, mime, chart);
  if (bills.length === 0) return NONE;
  const chartByCode = buildChartByCode(chart);

  const entryType = entry.entry_type;

  // 5) บิลแรก → เติมลง entry เดิม (แทนบรรทัดว่าง)
  await db.from("bill_entries").update(billHeadFields(bills[0], entryType)).eq("id", entryId).eq("tenant_id", tenantId);
  await db.from("bill_entry_lines").delete().eq("entry_id", entryId).eq("tenant_id", tenantId);
  await db
    .from("bill_entry_lines")
    .insert(buildEntryLineRows(bills[0].lines, { entryId, tenantId, forceNoVat: false, aiUsed: true, chartByCode }));

  // 6) บิลที่ 2..N → สร้าง entry ใหม่ (ลูกค้า/ประเภท/ไฟล์เดียวกัน) ให้นักบัญชีตรวจแยกใบ
  for (let i = 1; i < bills.length; i++) {
    const { data: ins } = await db
      .from("bill_entries")
      .insert({
        tenant_id: tenantId,
        customer_id: entry.customer_id,
        entry_type: entryType,
        status: "draft",
        upload_path: entry.upload_path,
        upload_name: entry.upload_name,
        upload_mime: entry.upload_mime,
        ...billHeadFields(bills[i], entryType),
      })
      .select("id")
      .maybeSingle();
    const newId = (ins as { id?: string } | null)?.id;
    if (!newId) continue;
    await db
      .from("bill_entry_lines")
      .insert(
        buildEntryLineRows(bills[i].lines, { entryId: newId, tenantId, forceNoVat: false, aiUsed: true, chartByCode })
      );
  }

  return { extracted: true, count: bills.length };
}

export type RedecideResult = {
  /** จำนวน entry unspecified ที่พิจารณา */
  scanned: number;
  /** จำนวนที่ตัดสินฝั่งได้ (อัปเดต entry_type) */
  updated: number;
};

/** แถว entry ที่รอตัดสินฝั่งใหม่ */
type UnspecifiedRow = {
  id: string;
  customer_id: string | null;
  seller_name: string | null;
  seller_tax_id: string | null;
  buyer_name: string | null;
  buyer_tax_id: string | null;
};

/**
 * ตัดสินฝั่งซื้อ/ขายใหม่ ให้ entry เดิมที่ยัง 'unspecified' — ★ ไม่เรียก AI ซ้ำ
 *   ใช้ seller/buyer ที่เก็บไว้แล้ว + ตัวตนลูกค้าล่าสุด (เผื่อ NOVA Sales เพิ่งส่ง tax_id มา
 *   หรือแก้ชื่อ) แล้วเรียก decideEntrySide ใหม่ · ตัดสินได้ → อัปเดต entry_type + counterparty
 *   (idempotent · ปลอดภัยรันซ้ำ — ยังไม่ชัดก็คง unspecified เหมือนเดิม)
 *
 *   ★ เฉพาะ entry ที่มี customer_id (ต้องมีลูกค้าถึงจะจับฝั่งได้) + มีชื่อฝั่งอย่างน้อย 1
 *   ★ ไม่แตะ entry ที่ confirmed แล้ว (WHERE status='draft')
 *   ★ opts.customerId (ทางเลือก): จำกัดเฉพาะ entry ของลูกค้ารายนั้น — ใช้ตอนนักบัญชี
 *     เพิ่งกรอกเลขภาษีของลูกค้ารายเดียว (re-decide ทันทีเฉพาะรายนั้น ไม่ต้องสแกนทั้ง tenant)
 */
export async function redecideExistingEntries(
  db: SupabaseClient,
  tenantId: string,
  opts: { limit?: number; customerId?: string } = {}
): Promise<RedecideResult> {
  const limit = opts.limit ?? 50;

  let query = db
    .from("bill_entries")
    .select("id, customer_id, seller_name, seller_tax_id, buyer_name, buyer_tax_id")
    .eq("tenant_id", tenantId)
    .eq("entry_type", "unspecified")
    .eq("status", "draft")
    .is("deleted_at", null)
    .not("customer_id", "is", null);
  // scope ลูกค้าเดียว (ถ้าระบุ) — index (tenant_id, customer_id) รองรับ
  if (opts.customerId) query = query.eq("customer_id", opts.customerId);
  const { data, error } = await query.limit(limit);

  if (error) {
    console.warn(`[bill-extract-worker] redecide select error code=${(error as { code?: string }).code ?? "?"}`);
    return { scanned: 0, updated: 0 };
  }

  const rows = (data ?? []) as unknown as UnspecifiedRow[];
  if (rows.length === 0) return { scanned: 0, updated: 0 };

  // โหลดตัวตนลูกค้าครั้งเดียว (name/business_name/tax_id) แล้ว map
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter((x): x is string => !!x))];
  const custById = new Map<string, CustomerIdentity>();
  if (customerIds.length > 0) {
    const { data: custData } = await db
      .from("customers")
      .select("id, name, business_name, tax_id")
      .eq("tenant_id", tenantId)
      .in("id", customerIds);
    for (const c of (custData ?? []) as {
      id: string;
      name: string | null;
      business_name: string | null;
      tax_id: string | null;
    }[]) {
      custById.set(c.id, { name: c.name, businessName: c.business_name, taxId: c.tax_id });
    }
  }

  let scanned = 0;
  let updated = 0;
  for (const row of rows) {
    // ต้องมีชื่อฝั่งอย่างน้อย 1 ถึงจะตัดสินได้
    if (!row.seller_name && !row.buyer_name && !row.seller_tax_id && !row.buyer_tax_id) continue;
    const customer = row.customer_id ? custById.get(row.customer_id) : null;
    if (!customer) continue;
    scanned++;

    const decision = decideEntrySide(
      customer,
      { name: row.seller_name, taxId: row.seller_tax_id },
      { name: row.buyer_name, taxId: row.buyer_tax_id }
    );
    if (decision.entryType === "unspecified") continue; // ยังไม่ชัด → คงเดิม

    const { error: updErr } = await db
      .from("bill_entries")
      .update({
        entry_type: decision.entryType,
        counterparty_name: decision.counterpartyName,
        counterparty_tax_id: decision.counterpartyTaxId,
      })
      .eq("id", row.id)
      .eq("tenant_id", tenantId)
      .eq("entry_type", "unspecified"); // guard: อัปเดตเฉพาะที่ยัง unspecified (กัน race)
    if (updErr) {
      console.warn(`[bill-extract-worker] redecide update error code=${(updErr as { code?: string }).code ?? "?"}`);
      continue;
    }
    updated++;
  }

  return { scanned, updated };
}

export type BackfillAccountsResult = {
  /** จำนวน entry (ai draft) ที่ยิง AI เพื่อเติมบัญชีในรอบนี้ */
  scanned: number;
  /** จำนวน entry ที่เติมบัญชีได้อย่างน้อย 1 บรรทัด */
  entriesFilled: number;
  /** จำนวนบรรทัดที่เติม account_code สำเร็จ */
  linesFilled: number;
};

/**
 * Backfill บัญชีให้บิลเดิม — เติม account_code/account_name ให้ bill_entry_lines ของ entry ที่
 *   AI สร้างไว้ก่อนมีฟีเจอร์แนะนำบัญชี (มีบรรทัดที่ account_code ยังว่าง)
 *   ★ ยิง AI ใหม่จากรูปบิล เอา "เฉพาะบัญชี" มาเติม — ไม่แตะ amount/vat/หัก (คนอาจแก้ไว้แล้ว)
 *   ★ เฉพาะ source='ai' + status='draft' (ยังไม่ยืนยัน) + มีไฟล์รูป (PDF ข้าม vision อ่านไม่ได้)
 *   ★ guard: update เฉพาะบรรทัดที่ account_code ยัง null (กัน race/คนเพิ่งเลือก) · idempotent
 *   ★ จำกัด limit = จำนวน entry ที่ยิง AI จริงต่อรอบ (คุมค่าใช้จ่าย) · เรียกผ่าน cron mode=accounts
 *   ★ PDPA: log แค่ตัวเลขสรุป ไม่มี path/เนื้อบิล
 */
export async function backfillEntryAccounts(
  db: SupabaseClient,
  opts: { limit?: number } = {}
): Promise<BackfillAccountsResult> {
  const limit = opts.limit ?? 10;
  const empty: BackfillAccountsResult = { scanned: 0, entriesFilled: 0, linesFilled: 0 };

  // ★ ไล่หา entry เป้าหมาย "ทั่วทั้งกอง" (cursor pagination) — เดิมดึงแค่ limit*5 ใบเก่าสุด
  //   แล้วกรอง → ถ้าใบเก่าถูกเติมหมด = เจอ 0 (คิวค้าง ไม่ลด). เป้าหมาย = ai draft + มีไฟล์รูป +
  //   "มีบรรทัด account_code ว่าง" (กระจายทั่วกอง). สะสม nullLines/path ระหว่างไล่ ใช้ต่อในลูป
  const nullLinesByEntry = new Map<string, { id: string; lineNo: number }[]>();
  const pathByAtt = new Map<string, string | null>();
  type BackfillEntry = { id: string; tenant_id: string; attachment_id: string | null; created_at: string | null };

  const entries = await collectTargetEntries<BackfillEntry>({
    limit,
    fetchPage: async (cursor, pageSize) => {
      let q = db
        .from("bill_entries")
        .select("id, tenant_id, attachment_id, created_at")
        .eq("source", "ai")
        .eq("status", "draft")
        .is("deleted_at", null)
        .not("attachment_id", "is", null);
      if (cursor) q = q.gt("created_at", cursor); // ★ gt ต้องอยู่ก่อน order/limit (filter builder)
      const { data, error } = await q.order("created_at", { ascending: true }).limit(pageSize);
      if (error) {
        console.warn(`[bill-extract-worker] backfill select entries error code=${(error as { code?: string }).code ?? "?"}`);
        return [];
      }
      return (data ?? []) as BackfillEntry[];
    },
    filterTargets: async (page) => {
      // บรรทัด account_code ว่าง ของ entry ในหน้านี้ (≤ pageSize ids)
      const ids = page.map((e) => e.id);
      const { data: lineData } = await db
        .from("bill_entry_lines")
        .select("id, entry_id, line_no, account_code")
        .in("entry_id", ids)
        .is("account_code", null)
        .order("line_no", { ascending: true });
      const pageNull = new Map<string, { id: string; lineNo: number }[]>();
      for (const l of (lineData ?? []) as { id: string; entry_id: string; line_no: number }[]) {
        const arr = pageNull.get(l.entry_id) ?? [];
        arr.push({ id: l.id, lineNo: l.line_no });
        pageNull.set(l.entry_id, arr);
      }
      const candidates = page.filter((e) => (pageNull.get(e.id)?.length ?? 0) > 0);
      if (candidates.length === 0) return [];

      // ต้องมีไฟล์ "รูป" (PDF ข้าม vision) — ★ กัน PDF ว่างค้างหัวกอง วนเจอทุกรอบ = ไม่ลด
      const attIds = [...new Set(candidates.map((e) => e.attachment_id).filter((x): x is string => !!x))];
      const localPath = new Map<string, string | null>();
      if (attIds.length > 0) {
        const { data: attData } = await db
          .from("message_attachments")
          .select("id, drive_file_id")
          .in("id", attIds);
        for (const a of (attData ?? []) as { id: string; drive_file_id: string | null }[]) {
          localPath.set(a.id, a.drive_file_id);
        }
      }
      const hits = candidates.filter((e) => {
        const p = e.attachment_id ? localPath.get(e.attachment_id) ?? null : null;
        return !!p && !isNonImage(null, mimeFromPath(p));
      });
      // เก็บ nullLines/path ของเป้าหมายที่ผ่านลง map ถาวร (ใช้ต่อในลูปประมวลผล — ไม่ query ซ้ำ)
      for (const e of hits) {
        nullLinesByEntry.set(e.id, pageNull.get(e.id) ?? []);
        if (e.attachment_id) pathByAtt.set(e.attachment_id, localPath.get(e.attachment_id) ?? null);
      }
      return hits;
    },
  });
  if (entries.length === 0) return empty;

  // ★ A6: cache ผังบัญชีต่อ tenant ในรอบนี้ (entry อาจกระจายหลาย tenant) — ไม่ query ซ้ำต่อบิล
  const getChart = createChartCache(db);

  let scanned = 0;
  let entriesFilled = 0;
  let linesFilled = 0;

  for (const e of entries) {
    if (scanned >= limit) break; // คุมจำนวน AI call ต่อรอบ
    const nullLines = nullLinesByEntry.get(e.id);
    if (!nullLines || nullLines.length === 0) continue; // ไม่มีบรรทัดที่ต้องเติม
    const objectPath = e.attachment_id ? pathByAtt.get(e.attachment_id) ?? null : null;
    if (!objectPath) continue;
    const mime = mimeFromPath(objectPath);
    if (isNonImage(null, mime)) continue; // PDF/เอกสาร — vision อ่านไม่ได้ ข้าม

    scanned++;

    // ดาวน์โหลด + สกัดใหม่ (เอาเฉพาะ account_code)
    let buf: Buffer;
    try {
      const { data: blob, error: dlErr } = await db.storage.from(BILLS_BUCKET).download(objectPath);
      if (dlErr || !blob) continue;
      buf = Buffer.from(await blob.arrayBuffer());
    } catch {
      continue;
    }
    const chart = await getChart(e.tenant_id);
    const bill = await extractBillData(buf, mime, chart);
    if (!bill) continue;
    const chartByCode = buildChartByCode(chart);

    // จับคู่บรรทัดเดิม (เรียง line_no) กับบรรทัดที่ AI สกัดใหม่ (ตามลำดับ) → เติมเฉพาะบัญชี
    let filledThisEntry = 0;
    for (let i = 0; i < nullLines.length; i += 1) {
      const code = bill.lines[i]?.account_code ?? null;
      if (!code) continue;
      const name = chartByCode[code]?.name ?? null;
      const { error: updErr } = await db
        .from("bill_entry_lines")
        .update({ account_code: code, account_name: name, ai_filled: true })
        .eq("id", nullLines[i].id)
        .is("account_code", null); // guard: เติมเฉพาะที่ยังว่าง
      if (updErr) continue;
      filledThisEntry += 1;
      linesFilled += 1;
    }
    if (filledThisEntry > 0) entriesFilled += 1;
  }

  console.log(
    `[bill-extract-worker] backfill accounts scanned=${scanned} entriesFilled=${entriesFilled} linesFilled=${linesFilled}`
  );
  return { scanned, entriesFilled, linesFilled };
}

export type ReExtractResult = {
  /** จำนวน entry "ว่างจริง + มีไฟล์รูป" ที่ยิง AI สกัดใหม่ในรอบนี้ */
  scanned: number;
  /** จำนวน entry ที่สกัดใหม่แล้วอัปเดตในที่เดิมสำเร็จ (ได้ข้อมูลอย่างน้อย 1) */
  updated: number;
  /** จำนวน entry ที่สกัดแล้วยังว่าง (AI อ่านไม่ออก) — อัปเดตในที่เดิมแต่ยังไม่มีข้อมูล */
  stillEmpty: number;
};

/**
 * mark entry ว่า "ลองสกัดใหม่แล้ว" (reextract_attempted_at = now) — เขียนผ่าน service-role
 *   ★ กัน reextract วนบิลหน้าคิวเดิมที่ AI อ่านไม่ออก (null/ว่าง) ซ้ำทุกรอบ:
 *     selection กรอง reextract_attempted_at is null → mark แล้ว = รอบหน้าข้ามไปใบใหม่
 *   ★ guard (source=ai, status=draft, ยังไม่ลบ): ไม่ mark/ไม่แตะ entry ที่คนยืนยัน/ลบแล้ว
 *   ★ PDPA: log แค่ error code ไม่มี id/เนื้อบิล
 */
export async function markReextractAttempted(db: SupabaseClient, entryId: string): Promise<void> {
  const { error } = await db
    .from("bill_entries")
    .update({ reextract_attempted_at: new Date().toISOString() })
    .eq("id", entryId)
    .eq("source", "ai")
    .eq("status", "draft")
    .is("deleted_at", null);
  if (error) {
    console.warn(
      `[bill-extract-worker] reextract mark attempted error code=${(error as { code?: string }).code ?? "?"}`
    );
  }
}

/** entry ที่รอสกัดใหม่ (ว่าง/ไม่ครบ) — created_at ใช้เป็น cursor ไล่หน้า */
type ReExtractEntryRow = {
  id: string;
  tenant_id: string;
  attachment_id: string | null;
  customer_id: string | null;
  created_at: string | null;
};

/**
 * ไล่สกัดใหม่ให้บิล "ว่าง/ไม่ครบจริง" ที่ AI สร้างไว้ (draft) โดย "ไม่ทับงานคน"
 *   ★ เลือกเฉพาะ entry ปลอดภัย: source='ai' + status='draft' + ยังไม่ลบ + มีไฟล์รูป
 *     และ "ว่างจริง" (isEmptyReextractable: ทุก line ไม่มีข้อมูล / ไม่มี line เลย)
 *   ★ กันชนรอบทับ: ก่อนแตะ re-read line ปัจจุบันของ entry แล้วเช็คว่ายังว่างอยู่จริง
 *     (คนอาจเพิ่งคีย์ระหว่างรอบ) — ไม่ว่างแล้ว = ข้าม ไม่แตะ
 *   ★ อัปเดต "ในที่เดิม": update หัว entry (doc/seller/buyer + re-decide side) +
 *     ลบ line ว่างเก่า → insert line ใหม่ (พร้อมบัญชี/WHT ตามงาน A + บังคับ novat ถ้า doc_kind ไม่ใช่ใบกำกับ)
 *   ★ ยิง AI แพง → limit = จำนวน entry ที่สกัดจริงต่อรอบ (แยก cron mode=reextract)
 *   ★ PDPA: log แค่ตัวเลขสรุป ไม่มี path/ชื่อ/เลขภาษี
 */
export async function reExtractIncompleteEntries(
  db: SupabaseClient,
  opts: { limit?: number } = {}
): Promise<ReExtractResult> {
  const limit = opts.limit ?? 10;
  const empty: ReExtractResult = { scanned: 0, updated: 0, stillEmpty: 0 };

  // 1) ★ ไล่หา entry "ว่างจริง + มีไฟล์รูป" ทั่วทั้งกอง (cursor pagination) — เดิมดึงแค่ limit*10
  //    ใบเก่าสุดแล้วกรอง → ถ้าใบเก่าถูกเติมหมด = เจอ 0 (คิว 281 ใบว่างไม่ลด). เป้าหมายกระจายทั่วกอง
  //    เก็บ att (path/doc_kind) ของเป้าหมายระหว่างไล่ ใช้ต่อในลูปประมวลผล (ไม่ query ซ้ำ)
  const attById = new Map<string, { path: string | null; docKind: string | null }>();
  const emptyEntries = await collectTargetEntries<ReExtractEntryRow>({
    limit,
    fetchPage: async (cursor, pageSize) => {
      let q = db
        .from("bill_entries")
        .select("id, tenant_id, attachment_id, customer_id, created_at")
        .eq("source", "ai")
        .eq("status", "draft")
        .is("deleted_at", null)
        // ★ ข้าม entry ที่ "ลองสกัดใหม่แล้ว" (0052) — กันวนบิลหน้าคิวเดิมที่ AI อ่านไม่ออกซ้ำ
        //   เฉพาะเส้น reextract เท่านั้น (backfill ใช้ query แยก ไม่กรองคอลัมน์นี้)
        .is("reextract_attempted_at", null)
        .not("attachment_id", "is", null);
      if (cursor) q = q.gt("created_at", cursor); // ★ gt ต้องอยู่ก่อน order/limit (filter builder)
      const { data, error } = await q.order("created_at", { ascending: true }).limit(pageSize);
      if (error) {
        console.warn(`[bill-extract-worker] reextract select entries error code=${(error as { code?: string }).code ?? "?"}`);
        return [];
      }
      return (data ?? []) as ReExtractEntryRow[];
    },
    filterTargets: async (page) => {
      // โหลด line ของหน้านี้ (≤ pageSize ids) → คัด "ว่างจริง" (ไม่มีใครคีย์)
      const ids = page.map((e) => e.id);
      const { data: lineData } = await db
        .from("bill_entry_lines")
        .select("entry_id, amount, vat_amount, account_code, description")
        .in("entry_id", ids);
      const linesByEntry = new Map<string, ReextractableLine[]>();
      for (const l of (lineData ?? []) as (ReextractableLine & { entry_id: string })[]) {
        const arr = linesByEntry.get(l.entry_id) ?? [];
        arr.push({ amount: l.amount, vat_amount: l.vat_amount, account_code: l.account_code, description: l.description });
        linesByEntry.set(l.entry_id, arr);
      }
      const candidates = page.filter((e) => isEmptyReextractable(linesByEntry.get(e.id) ?? []));
      if (candidates.length === 0) return [];

      // ต้องมีไฟล์ "รูป" (PDF ข้าม vision) — ★ กัน PDF ว่างค้างหัวกอง วนเจอทุกรอบ = ไม่ลด
      const attIds = [...new Set(candidates.map((e) => e.attachment_id).filter((x): x is string => !!x))];
      if (attIds.length > 0) {
        const { data: attData } = await db
          .from("message_attachments")
          .select("id, drive_file_id, doc_kind")
          .in("id", attIds);
        for (const a of (attData ?? []) as { id: string; drive_file_id: string | null; doc_kind: string | null }[]) {
          attById.set(a.id, { path: a.drive_file_id, docKind: a.doc_kind });
        }
      }
      return candidates.filter((e) => {
        const p = e.attachment_id ? attById.get(e.attachment_id)?.path ?? null : null;
        return !!p && !isNonImage(null, mimeFromPath(p));
      });
    },
  });
  if (emptyEntries.length === 0) return empty;

  // 2) ตัวตนลูกค้า (เพื่อ re-decide ฝั่งซื้อ/ขาย) — โหลดครั้งเดียว
  const custIds = [...new Set(emptyEntries.map((e) => e.customer_id).filter((x): x is string => !!x))];
  const custById = new Map<string, CustomerIdentity>();
  if (custIds.length > 0) {
    const { data: custData } = await db
      .from("customers")
      .select("id, name, business_name, tax_id")
      .in("id", custIds);
    for (const c of (custData ?? []) as {
      id: string;
      name: string | null;
      business_name: string | null;
      tax_id: string | null;
    }[]) {
      custById.set(c.id, { name: c.name, businessName: c.business_name, taxId: c.tax_id });
    }
  }

  // ★ A6: cache ผังบัญชีต่อ tenant ในรอบนี้ (entry อาจกระจายหลาย tenant) — ไม่ query ซ้ำต่อบิล
  const getChart = createChartCache(db);

  let scanned = 0;
  let updated = 0;
  let stillEmpty = 0;

  for (const e of emptyEntries) {
    if (scanned >= limit) break; // คุมจำนวน AI call ต่อรอบ
    const att = e.attachment_id ? attById.get(e.attachment_id) : null;
    const objectPath = att?.path ?? null;
    if (!objectPath) continue;
    const mime = mimeFromPath(objectPath);
    if (isNonImage(null, mime)) continue; // PDF/เอกสาร — vision อ่านไม่ได้ ข้าม

    scanned++;

    // ดาวน์โหลด + สกัดใหม่
    let buf: Buffer;
    try {
      const { data: blob, error: dlErr } = await db.storage.from(BILLS_BUCKET).download(objectPath);
      if (dlErr || !blob) continue;
      buf = Buffer.from(await blob.arrayBuffer());
    } catch {
      continue;
    }
    const chart = await getChart(e.tenant_id);
    const bill = await extractBillData(buf, mime, chart);
    // ★ mark "ลองสกัดใหม่แล้ว" ทันทีหลังยิง AI จริง (ครอบทุกผล: null/stillEmpty/updated)
    //   → รอบหน้า selection ข้ามใบนี้ ไม่วนซ้ำบิลหน้าคิวเดิม (guard ai+draft: ไม่แตะที่คนยืนยันแล้ว)
    await markReextractAttempted(db, e.id);
    if (!bill) continue; // สกัดไม่ได้ → คงว่างไว้ (mark แล้ว รอบหน้าไม่วนซ้ำ)

    // ★ กันชนรอบทับ: re-read line ปัจจุบัน ตรวจว่ายัง "ว่างจริง" อยู่ (คนอาจเพิ่งคีย์)
    const { data: freshData } = await db
      .from("bill_entry_lines")
      .select("id, amount, vat_amount, account_code, description")
      .eq("entry_id", e.id);
    const fresh = (freshData ?? []) as (ReextractableLine & { id: string })[];
    if (!isEmptyReextractable(fresh)) continue; // มีคนคีย์แล้ว → ไม่แตะ

    // re-decide ฝั่งซื้อ/ขายจากตัวตนลูกค้า + ชื่อ/เลขที่ AI อ่านใหม่
    const customer = (e.customer_id ? custById.get(e.customer_id) : null) ?? {
      name: null,
      businessName: null,
      taxId: null,
    };
    const seller: BillParty = { name: bill.seller_name, taxId: bill.seller_tax_id };
    const buyer: BillParty = { name: bill.buyer_name, taxId: bill.buyer_tax_id };
    const decision = decideEntrySide(customer, seller, buyer);

    // อัปเดตหัว entry ในที่เดิม (guard: ยังเป็น ai draft — กัน race กับการยืนยัน/ลบ)
    const { data: updData, error: updErr } = await db
      .from("bill_entries")
      .update({
        entry_type: decision.entryType,
        doc_date: bill.doc_date,
        doc_no: bill.doc_no,
        counterparty_name: decision.counterpartyName,
        counterparty_tax_id: decision.counterpartyTaxId,
        seller_name: seller.name,
        seller_tax_id: seller.taxId,
        buyer_name: buyer.name,
        buyer_tax_id: buyer.taxId,
        // ค่าแนะนำวิธีจ่าย/รับเงิน จาก doc_kind (re-suggest — entry นี้ยังเป็น draft ว่าง)
        payment_method: suggestPaymentMethod(att?.docKind, decision.entryType),
        ai_confidence: bill.overall_confidence,
      })
      .eq("id", e.id)
      .eq("source", "ai")
      .eq("status", "draft")
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (updErr) {
      console.warn(`[bill-extract-worker] reextract update entry error code=${(updErr as { code?: string }).code ?? "?"}`);
      continue;
    }
    if (!updData) continue; // entry เปลี่ยนสถานะไปแล้ว (ยืนยัน/ลบ) → ไม่แตะต่อ

    // ลบ line ว่างเก่า (เฉพาะ id ที่ re-check แล้วว่าว่าง) แล้ว insert line ใหม่
    const oldIds = fresh.map((l) => l.id);
    if (oldIds.length > 0) {
      const { error: delErr } = await db.from("bill_entry_lines").delete().in("id", oldIds);
      if (delErr) {
        console.warn(`[bill-extract-worker] reextract delete lines error code=${(delErr as { code?: string }).code ?? "?"}`);
        continue; // ลบไม่ได้ → ไม่ insert (กันบรรทัดซ้อน)
      }
    }
    const forceNoVat = NONVAT_DOC_KINDS.has((att?.docKind ?? "").trim().toLowerCase());
    const lineRows = buildEntryLineRows(bill.lines, {
      entryId: e.id,
      tenantId: e.tenant_id,
      forceNoVat,
      aiUsed: true,
      chartByCode: buildChartByCode(chart),
    });
    const { error: insErr } = await db.from("bill_entry_lines").insert(lineRows);
    if (insErr) {
      console.warn(`[bill-extract-worker] reextract insert lines error code=${(insErr as { code?: string }).code ?? "?"}`);
    }

    const got =
      !!bill.doc_no ||
      !!bill.doc_date ||
      !!bill.seller_name ||
      !!bill.buyer_name ||
      lineRows.some((l) => Number(l.amount) > 0);
    if (got) updated++;
    else stillEmpty++;
  }

  console.log(
    `[bill-extract-worker] reextract scanned=${scanned} updated=${updated} stillEmpty=${stillEmpty}`
  );
  return { scanned, updated, stillEmpty };
}
