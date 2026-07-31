import type { SupabaseClient } from "@supabase/supabase-js";
import { extractBillData } from "@/lib/ai/bill-extract";

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
 * ★ ไฟล์ PDF (attachment_type='file'): vision อ่านไม่ได้ตรง ๆ →
 *   สร้าง "draft ว่าง" (unspecified) ให้คนคีย์ (ปลอดภัยกว่าข้าม — ไม่ให้บิลตกหล่นจากคิว)
 * ★ degrade: ไม่มี OpenAI key → extractBillData คืน null → ยังสร้าง draft ว่างให้คนคีย์
 * ★ PDPA: ไม่ log objectPath/เนื้อบิล/ตัวเลข — log แค่ error สั้น ๆ
 */

const BILLS_BUCKET = "bills";

/** doc_kind ที่ถือเป็นบิลต้องลงบัญชี */
const BILL_DOC_KINDS = ["sale", "purchase", "handwritten", "cash"];

export type ExtractWorkerResult = {
  /** จำนวนบิลที่หยิบมาพิจารณา */
  scanned: number;
  /** จำนวน entry ที่สร้างใหม่ (draft) */
  created: number;
  /** จำนวนที่สกัดด้วย AI สำเร็จ (มี field อย่างน้อย 1) */
  extracted: number;
  /** จำนวนที่สร้าง draft ว่าง (PDF / ไม่มี key / สกัดไม่ได้) */
  blank: number;
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
};

/** เดา mime จากนามสกุลไฟล์ (fallback image/jpeg) */
function mimeFromPath(path: string): string {
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

export type EntryType = "purchase" | "sale" | "unspecified";

/** ผลตัดสินฝั่ง + คู่ค้า (อีกฝั่งที่ไม่ใช่ลูกค้าเรา) */
export type SideDecision = {
  entryType: EntryType;
  counterpartyName: string | null;
  counterpartyTaxId: string | null;
};

/**
 * normalize ชื่อคู่ค้า/ลูกค้าเพื่อจับคู่ (ตัดคำนำหน้านิติบุคคล/ช่องว่าง/อักขระ)
 *   ให้ "บริษัท เอ บี ซี จำกัด" ≈ "เอบีซี"
 */
function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/บริษัท|จำกัด|มหาชน|ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วน|หจก\.?|บจก\.?|บมจ\.?|co\.,?|ltd\.?|company|limited|partnership/g, "")
    .replace(/[\s.,\-_()"'`]/g, "");
}

/** เทียบชื่อแบบ substring 2 ทาง (หลัง normalize) — ต้องยาวพอ (>=3) กัน match พร่ำเพรื่อ */
function nameMatches(a: string, b: string): boolean {
  if (a.length < 3 || b.length < 3) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * ตัดสิน entry_type จาก "ลูกค้าเรา" เทียบ seller/buyer ที่ AI อ่าน (pure — เทสต์ได้)
 *   - ลูกค้าเรา match ผู้ขาย (ไม่ match ผู้ซื้อ) → 'sale' · counterparty = ผู้ซื้อ
 *   - ลูกค้าเรา match ผู้ซื้อ (ไม่ match ผู้ขาย) → 'purchase' · counterparty = ผู้ขาย
 *   - match ทั้งคู่ / ไม่ match เลย / ไม่มีชื่อลูกค้า → 'unspecified' · counterparty = null
 *     (ไม่เดา — ให้คนเลือกในหน้า UI)
 */
export function decideEntrySide(
  customerNames: string[],
  seller: { name: string | null; taxId: string | null },
  buyer: { name: string | null; taxId: string | null }
): SideDecision {
  const custNorms = customerNames.map(normalizeName).filter((n) => n.length >= 3);
  const sellerNorm = normalizeName(seller.name);
  const buyerNorm = normalizeName(buyer.name);

  const matchSeller = custNorms.some((c) => nameMatches(c, sellerNorm));
  const matchBuyer = custNorms.some((c) => nameMatches(c, buyerNorm));

  if (matchSeller && !matchBuyer) {
    return { entryType: "sale", counterpartyName: buyer.name, counterpartyTaxId: buyer.taxId };
  }
  if (matchBuyer && !matchSeller) {
    return { entryType: "purchase", counterpartyName: seller.name, counterpartyTaxId: seller.taxId };
  }
  return { entryType: "unspecified", counterpartyName: null, counterpartyTaxId: null };
}

/**
 * หาลูกค้าเรา จาก chat_message → chat_group.customer_id → ชื่อลูกค้า (best-effort)
 *   คืน { id, names } — names รวม name + business_name (ใช้จับคู่ seller/buyer)
 *   พลาด/ไม่เจอ = { id:null, names:[] } (ไม่ทำให้ทั้ง entry ล้ม)
 */
async function resolveCustomer(
  db: SupabaseClient,
  chatMessageId: string | null
): Promise<{ id: string | null; names: string[] }> {
  if (!chatMessageId) return { id: null, names: [] };
  try {
    const { data: msg } = await db
      .from("chat_messages")
      .select("chat_group_id")
      .eq("id", chatMessageId)
      .maybeSingle();
    const groupId = (msg as { chat_group_id?: string } | null)?.chat_group_id;
    if (!groupId) return { id: null, names: [] };
    const { data: grp } = await db
      .from("chat_groups")
      .select("customer_id")
      .eq("id", groupId)
      .maybeSingle();
    const customerId = (grp as { customer_id?: string | null } | null)?.customer_id ?? null;
    if (!customerId) return { id: null, names: [] };

    const { data: cust } = await db
      .from("customers")
      .select("name, business_name")
      .eq("id", customerId)
      .maybeSingle();
    const c = cust as { name?: string | null; business_name?: string | null } | null;
    const names = [c?.name, c?.business_name].filter((n): n is string => !!n);
    return { id: customerId, names };
  } catch {
    return { id: null, names: [] };
  }
}

/**
 * ประมวลผลบิลที่รอสกัด (batch)
 *   @returns สรุปผล
 */
export async function processBillExtraction(
  db: SupabaseClient,
  opts: { limit?: number } = {}
): Promise<ExtractWorkerResult> {
  const limit = opts.limit ?? 10;
  const empty: ExtractWorkerResult = { scanned: 0, created: 0, extracted: 0, blank: 0 };

  // 1) หาบิลที่เก็บแล้ว + เป็นเอกสารการเงิน + ยังไม่มี entry
  //    (ดึงมากกว่า limit เผื่อกรอง "มี entry แล้ว" ออก แล้วค่อยตัดให้เหลือ limit)
  const { data, error } = await db
    .from("message_attachments")
    .select("id, tenant_id, attachment_type, doc_kind, drive_file_id, chat_message_id")
    .eq("fetch_status", "stored")
    .in("attachment_type", ["image", "file"])
    .in("doc_kind", BILL_DOC_KINDS)
    .not("drive_file_id", "is", null)
    .limit(limit * 5);

  if (error) {
    console.warn(`[bill-extract-worker] select queue error code=${(error as { code?: string }).code ?? "?"}`);
    return empty;
  }

  const candidates = (data ?? []) as unknown as QueueRow[];
  if (candidates.length === 0) return empty;

  // 2) กรองอันที่ "มี bill_entries อยู่แล้ว" ออก (dedup) — query entries ของ attachment เหล่านี้
  const attachmentIds = candidates.map((r) => r.id);
  const { data: existing } = await db
    .from("bill_entries")
    .select("attachment_id")
    .in("attachment_id", attachmentIds)
    .is("deleted_at", null);
  const done = new Set(
    ((existing ?? []) as { attachment_id: string | null }[])
      .map((e) => e.attachment_id)
      .filter((x): x is string => !!x)
  );

  const rows = candidates.filter((r) => !done.has(r.id)).slice(0, limit);

  let scanned = 0;
  let created = 0;
  let extracted = 0;
  let blank = 0;

  for (const row of rows) {
    scanned++;
    const objectPath = row.drive_file_id;
    if (!objectPath) continue;

    const mime = mimeFromPath(objectPath);
    const nonImage = isNonImage(row.attachment_type, mime);

    // 3) รูป → ดาวน์โหลด + สกัด · PDF/เอกสาร → ข้ามการสกัด (draft ว่าง)
    let bill = null as Awaited<ReturnType<typeof extractBillData>> | null;
    if (!nonImage) {
      let buf: Buffer | null = null;
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
      bill = await extractBillData(buf, mime);
    }

    // 4) จับคู่ลูกค้าเราจาก chat_group (best-effort) + ตัดสินฝั่งซื้อ/ขาย
    const customer = await resolveCustomer(db, row.chat_message_id);
    const seller = { name: bill?.seller_name ?? null, taxId: bill?.seller_tax_id ?? null };
    const buyer = { name: bill?.buyer_name ?? null, taxId: bill?.buyer_tax_id ?? null };
    const decision = decideEntrySide(customer.names, seller, buyer);

    // 5) สร้าง bill_entries (draft) — attachment_id unique กันซ้ำ (ถ้าชนก็ข้าม)
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

    // 6) สร้าง bill_entry_lines — ช่องที่ AI เว้น null = ไม่เติม (ค่า 0 ตาม default DB)
    //    ai_filled=true เฉพาะ line ที่ AI เติม amount/vat จริง (รู้ที่มา)
    const lines = bill?.lines ?? [
      { vat_type: "vat" as const, description: null, amount: null, vat_amount: null },
    ];
    const lineRows = lines.map((l, i) => {
      const aiFilled = !!bill && (l.amount !== null || l.vat_amount !== null);
      return {
        entry_id: entryId,
        tenant_id: row.tenant_id,
        line_no: i + 1,
        vat_type: l.vat_type,
        description: l.description,
        amount: l.amount ?? 0,
        vat_amount: l.vat_amount ?? 0,
        wht_rate: 0,
        wht_amount: 0,
        ai_filled: aiFilled,
      };
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
        lineRows.some((l) => l.amount > 0));
    if (gotSomething) extracted++;
    else blank++;
  }

  return { scanned, created, extracted, blank };
}
