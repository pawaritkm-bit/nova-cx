import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildSalesDocumentPayload,
  type MapperRejectReason,
} from "@/lib/integrations/flowaccount-mapper";
import {
  createSalesDocument,
  type FlowAccountDocType,
  type FlowAccountReason,
} from "@/lib/integrations/flowaccount";
import type { PaymentMethod, VatType } from "@/lib/accounting/queries";

/**
 * orchestration: ส่งบิลขาย 1 ใบไป FlowAccount (manual trigger, ดู docs/05-flowaccount-integration.md)
 *   ลำดับ: guard ธุรกิจ (sale+confirmed+มีลูกค้า) → claim (atomic กันกดซ้ำ/สองแท็บ) →
 *          โหลดลูกค้า/lines → map payload (pure) → เรียก client → เขียนผล + insert log เสมอ
 *   ★ ทุก write scope ด้วย tenant_id (กัน cross-tenant แม้ client เป็น service_role)
 *   ★ PDPA: log สั้น ๆ ไม่มี payload/เลขภาษี/ยอดเงิน
 */

type DB = SupabaseClient;

export type SyncRejectReason =
  | "not_found"
  | "not_sale"
  | "not_confirmed"
  | "missing_customer"
  | "already_syncing"
  | MapperRejectReason
  | FlowAccountReason;

export type SyncResult =
  | { ok: true; docType: FlowAccountDocType; docId: string; docNo: string | null }
  | { ok: false; reason: SyncRejectReason };

type RawEntry = {
  id: string;
  entry_type: string;
  status: string;
  customer_id: string | null;
  doc_date: string | null;
  doc_no: string | null;
  payment_method: string | null;
};

type RawCustomer = { name: string | null; tax_id: string | null; address: string | null };

type RawLine = {
  description: string | null;
  amount: number | string | null;
  vat_amount: number | string | null;
  vat_type: string | null;
};

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function asPaymentMethod(v: string | null): PaymentMethod | null {
  return v === "cash" || v === "cheque" || v === "transfer" || v === "credit" ? v : null;
}

/** ข้อความ error สั้น ๆ ให้นักบัญชีเห็นก่อนกดส่งใหม่ (ไม่มี payload/PII) */
const REASON_LABEL: Partial<Record<SyncRejectReason, string>> = {
  not_found: "ไม่พบบิลนี้",
  not_sale: "ไม่ใช่บิลขาย",
  not_confirmed: "บิลยังไม่ยืนยัน",
  missing_customer: "บิลยังไม่ผูกลูกค้า",
  already_syncing: "มีการส่งบิลนี้อยู่แล้ว",
  missing_customer_tax_id: "ลูกค้าไม่มีเลขประจำตัวผู้เสียภาษี",
  no_value_lines: "ไม่มีรายการที่มีมูลค่า",
  missing_doc_date: "ไม่มีวันที่เอกสาร",
  not_configured: "ยังไม่เปิดการเชื่อมต่อ FlowAccount",
  auth_failed: "ยืนยันตัวตนกับ FlowAccount ไม่สำเร็จ",
  validation_error: "FlowAccount ปฏิเสธข้อมูลที่ส่งไป",
  timeout: "เชื่อมต่อ FlowAccount หมดเวลา",
  network: "เชื่อมต่อ FlowAccount ไม่ได้ (เครือข่าย)",
  server_error: "FlowAccount ขัดข้อง (เซิร์ฟเวอร์)",
};

function shortErrorMessage(reason: string): string {
  return REASON_LABEL[reason as SyncRejectReason] ?? "ส่งไป FlowAccount ไม่สำเร็จ";
}

/**
 * claim entry แบบ atomic (1 คำสั่ง SQL — UPDATE...WHERE...RETURNING) กันกดซ้ำ/สองแท็บพร้อมกัน
 *   claim ได้ 2 กรณี: (1) not_synced/failed (ยังไม่เคยส่ง/ส่งแล้วล้ม) หรือ
 *   (2) synced ที่ needs_resync=true (ปุ่ม "ส่งใหม่" หลังแก้บิลที่ synced แล้ว — เดิมพลาดไม่ได้ครอบเคสนี้)
 *   คืน true = claim สำเร็จ (ตั้ง syncing แล้ว) · false = มีคน claim ไปแล้ว/entry ไม่อยู่ในสถานะที่ claim ได้
 */
export async function claimEntryForSync(db: DB, tenantId: string, entryId: string): Promise<boolean> {
  const { data, error } = await db
    .from("bill_entries")
    .update({
      flowaccount_sync_status: "syncing",
      flowaccount_last_attempted_at: new Date().toISOString(),
    })
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .or(
      "flowaccount_sync_status.in.(not_synced,failed),and(flowaccount_sync_status.eq.synced,flowaccount_needs_resync.eq.true)"
    )
    .select("id")
    .maybeSingle();
  if (error) {
    console.warn(`[flowaccount-sync] claim error code=${(error as { code?: string }).code ?? "?"}`);
    return false;
  }
  return !!data;
}

/** เขียนผลล้ม + insert log (เสมอ ไม่ว่าล้มตอน map หรือตอนเรียก client) */
async function writeFailure(
  db: DB,
  tenantId: string,
  entryId: string,
  docType: FlowAccountDocType | null,
  reason: string,
  requestedBy: string | null
): Promise<void> {
  await db
    .from("bill_entries")
    .update({
      flowaccount_sync_status: "failed",
      flowaccount_last_error: shortErrorMessage(reason),
    })
    .eq("id", entryId)
    .eq("tenant_id", tenantId);

  await db.from("flowaccount_sync_log").insert({
    tenant_id: tenantId,
    entry_id: entryId,
    doc_type: docType,
    status: "failed",
    error_message: shortErrorMessage(reason),
    requested_by: requestedBy,
  });
}

/** เขียนผลสำเร็จ + insert log */
async function writeSuccess(
  db: DB,
  tenantId: string,
  entryId: string,
  docType: FlowAccountDocType,
  docId: string,
  docNo: string | null,
  requestedBy: string | null
): Promise<void> {
  await db
    .from("bill_entries")
    .update({
      flowaccount_sync_status: "synced",
      flowaccount_doc_type: docType,
      flowaccount_doc_id: docId,
      flowaccount_doc_no: docNo,
      flowaccount_synced_at: new Date().toISOString(),
      flowaccount_last_error: null,
      flowaccount_needs_resync: false,
    })
    .eq("id", entryId)
    .eq("tenant_id", tenantId);

  await db.from("flowaccount_sync_log").insert({
    tenant_id: tenantId,
    entry_id: entryId,
    doc_type: docType,
    status: "success",
    flowaccount_doc_id: docId,
    requested_by: requestedBy,
  });
}

/**
 * ส่งบิลขาย 1 ใบไป FlowAccount — ★ ไม่ throw ทุก error จับแล้วคืนผลตาม reason
 *   guard ธุรกิจ (sale/confirmed/มีลูกค้า) ทำก่อน claim เสมอ — กันเสีย claim ไปเปล่า ๆ กับบิลที่ส่งไม่ได้แน่ ๆ
 */
export async function syncSaleEntryToFlowAccount(
  db: DB,
  tenantId: string,
  entryId: string,
  opts?: { requestedBy?: string | null }
): Promise<SyncResult> {
  const requestedBy = opts?.requestedBy ?? null;

  const { data: entryData, error: entryErr } = await db
    .from("bill_entries")
    .select("id, entry_type, status, customer_id, doc_date, doc_no, payment_method")
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (entryErr || !entryData) return { ok: false, reason: "not_found" };
  const entry = entryData as unknown as RawEntry;

  if (entry.entry_type !== "sale") return { ok: false, reason: "not_sale" };
  if (entry.status !== "confirmed") return { ok: false, reason: "not_confirmed" };
  if (!entry.customer_id) return { ok: false, reason: "missing_customer" };

  const claimed = await claimEntryForSync(db, tenantId, entryId);
  if (!claimed) return { ok: false, reason: "already_syncing" };

  const { data: customerData } = await db
    .from("customers")
    .select("name, tax_id, address")
    .eq("id", entry.customer_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const customer = (customerData as unknown as RawCustomer | null) ?? {
    name: null,
    tax_id: null,
    address: null,
  };

  const { data: lineData } = await db
    .from("bill_entry_lines")
    .select("description, amount, vat_amount, vat_type")
    .eq("tenant_id", tenantId)
    .eq("entry_id", entryId)
    .order("line_no", { ascending: true });
  const lines = ((lineData ?? []) as unknown as RawLine[]).map((l) => ({
    description: l.description,
    amount: num(l.amount),
    vatAmount: num(l.vat_amount),
    vatType: (l.vat_type === "novat" ? "novat" : "vat") as VatType,
  }));

  const mapResult = buildSalesDocumentPayload(
    {
      docNo: entry.doc_no,
      docDate: entry.doc_date,
      paymentMethod: asPaymentMethod(entry.payment_method),
    },
    lines,
    { name: customer.name, taxId: customer.tax_id, address: customer.address }
  );
  if (!mapResult.ok) {
    await writeFailure(db, tenantId, entryId, null, mapResult.reason, requestedBy);
    return { ok: false, reason: mapResult.reason };
  }

  const clientResult = await createSalesDocument({ docType: mapResult.docType, body: mapResult.body });
  if (!clientResult.ok) {
    await writeFailure(db, tenantId, entryId, mapResult.docType, clientResult.reason, requestedBy);
    return { ok: false, reason: clientResult.reason };
  }

  await writeSuccess(
    db,
    tenantId,
    entryId,
    mapResult.docType,
    clientResult.docId,
    clientResult.docNo,
    requestedBy
  );
  return { ok: true, docType: mapResult.docType, docId: clientResult.docId, docNo: clientResult.docNo };
}
