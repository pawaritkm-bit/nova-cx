import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildSalesDocumentPayload,
  buildPurchaseDocumentPayload,
  type MapperRejectReason,
  type PurchaseMapperRejectReason,
} from "@/lib/integrations/flowaccount-mapper";
import {
  createSalesDocument,
  createPurchaseDocument,
  type FlowAccountCredential,
  type FlowAccountDocType,
  type FlowAccountPurchaseDocType,
  type FlowAccountReason,
} from "@/lib/integrations/flowaccount";
import { decryptField } from "@/lib/crypto/field";
import type { PaymentMethod, VatType } from "@/lib/accounting/queries";
import {
  listAccountMap,
  listProductMap,
  accountMapToRecord,
  productMapToRecord,
} from "@/lib/accounting/flowaccount-map";

/**
 * orchestration: ส่งบิล 1 ใบไป FlowAccount (manual trigger, ดู docs/05-flowaccount-integration.md +
 *   docs/06-accounting-features-roadmap.md เฟส 5 ส่วน P)
 *   ลำดับ: guard ธุรกิจ (entry_type รองรับ+confirmed+มีลูกค้า) → claim (atomic กันกดซ้ำ/สองแท็บ) →
 *          โหลดลูกค้า/lines → ถอดรหัส credential ต่อลูกค้า (M2) → dispatch ตาม entry_type
 *          (sale/purchase) → map payload (pure) → เรียก client → เขียนผล + insert log เสมอ
 *   ★ ทุก write scope ด้วย tenant_id (กัน cross-tenant แม้ client เป็น service_role)
 *   ★ PDPA: log สั้น ๆ ไม่มี payload/เลขภาษี/ยอดเงิน/client_secret (plaintext หรือ ciphertext)
 *
 * ★★ M2 — credential ต่อลูกค้า ★★ ลูกค้าที่ยังไม่กรอก flowaccount_client_id/flowaccount_client_secret_enc
 *   (หรือ ciphertext decrypt ไม่ได้) → reason `customer_not_configured` (เช็คหลัง claim เหมือน mapper reject
 *   เดิม เพราะต้องโหลดตาราง customers ก่อนถึงจะรู้)
 *
 * ★★ เฟส 5 ส่วน P (T33) — เดิมชื่อ `syncSaleEntryToFlowAccount` (ผูกกับ "sale" ตรงๆ) เปลี่ยนเป็น
 *   `syncEntryToFlowAccount()` แล้ว dispatch ภายในตาม `entry.entry_type`:
 *     - sale     → path เดิม (M1/M2) + mapping ผังบัญชี/สินค้าจาก Q (T28) — ไม่เปลี่ยนพฤติกรรม
 *
 * ★★ เฟส 10 (multi-currency, decision 0.13 — T96) ★★ ไฟล์นี้ "ไม่ถูกแก้เลยแม้แต่บรรทัดเดียว" ในเฟส 10 —
 *   ส่งบิล FX ไป FlowAccount ยังทำงานได้ปกติ เพราะ `flowaccount-mapper.ts` ที่ไฟล์นี้เรียกอยู่แล้วอ่าน
 *   `line.amount`/`vatAmount` (THB ที่ derive แล้วเสมอ ตาม 0.6 ของเฟส 10) ไม่ต้องรู้จัก currency/fx_rate/
 *   fx_amount เลย
 *     - purchase → path ใหม่ (T32/T31) — contact ของเอกสารมาจาก `entry.counterpartyName/
 *                  counterpartyTaxId` (ผู้ขายจริง — decision 0.6) ไม่ใช่ `customers`
 *     - อื่น ๆ (เช่น 'unspecified') → reason `unsupported_entry_type` ก่อน claim (decision 0.5 — ไม่ขยาย
 *       ไป unspecified นักบัญชีต้องเลือกซื้อ/ขายให้ชัดก่อนเสมอ)
 *   credential/mapping ของบิลซื้อใช้ของลูกค้ารายเดียวกับบิลขาย (จาก customer_id — decision 0.7/0.9)
 */

type DB = SupabaseClient;

/** ชนิดเอกสารที่ sync สำเร็จ — รวมทั้งฝั่งขาย (M1/M2) และฝั่งซื้อ (เฟส 5 ส่วน P) */
export type SyncDocType = FlowAccountDocType | FlowAccountPurchaseDocType;

export type SyncRejectReason =
  | "not_found"
  | "not_confirmed"
  | "missing_customer"
  | "already_syncing"
  | "customer_not_configured"
  | "unsupported_entry_type"
  | MapperRejectReason
  | PurchaseMapperRejectReason
  | FlowAccountReason;

export type SyncResult =
  | { ok: true; docType: SyncDocType; docId: string; docNo: string | null }
  | { ok: false; reason: SyncRejectReason };

type RawEntry = {
  id: string;
  entry_type: string;
  status: string;
  customer_id: string | null;
  doc_date: string | null;
  doc_no: string | null;
  payment_method: string | null;
  /** ผู้ขาย/vendor ของบิลซื้อ (decision 0.6) — เฉยๆ สำหรับบิลขาย (ไม่ใช้) */
  counterparty_name: string | null;
  counterparty_tax_id: string | null;
};

type RawCustomer = {
  name: string | null;
  tax_id: string | null;
  address: string | null;
  flowaccount_client_id: string | null;
  flowaccount_client_secret_enc: string | null;
};

type RawLine = {
  description: string | null;
  amount: number | string | null;
  vat_amount: number | string | null;
  vat_type: string | null;
  /** เฟส 5 ส่วน Q — ใช้จับคู่ maps.accountMap/maps.productMap (ดู flowaccount-mapper.ts) */
  account_code?: string | null;
  product_id?: string | null;
};

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function asPaymentMethod(v: string | null): PaymentMethod | null {
  return v === "cash" || v === "cheque" || v === "transfer" || v === "credit" ? v : null;
}

/**
 * ถอดรหัส credential FlowAccount ของลูกค้ารายนี้ — คืน null ถ้าไม่ครบ/ถอดรหัสไม่ได้
 *   ★ จับ throw ทุกกรณี (CREDENTIAL_ENC_KEY ไม่ตั้ง/ciphertext เพี้ยน/คนละคีย์) — ไม่ให้ throw ทะลุขึ้นไป
 *   ★ ไม่ log ทั้ง ciphertext และ plaintext ของ secret ที่ใดเลย
 */
function resolveCustomerCredential(customer: RawCustomer): FlowAccountCredential | null {
  if (!customer.flowaccount_client_id || !customer.flowaccount_client_secret_enc) return null;
  try {
    const clientSecret = decryptField(customer.flowaccount_client_secret_enc);
    return { clientId: customer.flowaccount_client_id, clientSecret };
  } catch {
    console.warn("[flowaccount-sync] decrypt customer credential failed");
    return null;
  }
}

/** ข้อความ error สั้น ๆ ให้นักบัญชีเห็นก่อนกดส่งใหม่ (ไม่มี payload/PII) */
const REASON_LABEL: Partial<Record<SyncRejectReason, string>> = {
  not_found: "ไม่พบบิลนี้",
  not_confirmed: "บิลยังไม่ยืนยัน",
  missing_customer: "บิลยังไม่ผูกลูกค้า",
  already_syncing: "มีการส่งบิลนี้อยู่แล้ว",
  customer_not_configured: "ลูกค้ารายนี้ยังไม่เปิดใช้การเชื่อมต่อ FlowAccount",
  unsupported_entry_type: "บิลประเภทนี้ยังไม่รองรับการส่ง FlowAccount",
  missing_customer_tax_id: "ลูกค้าไม่มีเลขประจำตัวผู้เสียภาษี",
  missing_vendor_tax_id: "ผู้ขายไม่มีเลขประจำตัวผู้เสียภาษี",
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
  docType: SyncDocType | null,
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
  docType: SyncDocType,
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
 * ส่งบิล 1 ใบไป FlowAccount — ★ ไม่ throw ทุก error จับแล้วคืนผลตาม reason
 *   guard ธุรกิจ (entry_type รองรับ/confirmed/มีลูกค้า) ทำก่อน claim เสมอ — กันเสีย claim ไปเปล่า ๆ กับบิล
 *   ที่ส่งไม่ได้แน่ ๆ · dispatch ตาม `entry.entry_type` หลัง claim+โหลด credential/lines/mapping สำเร็จ
 *   (เฟส 5 ส่วน P, T33 — เดิมชื่อ `syncSaleEntryToFlowAccount` รองรับแค่ sale)
 */
export async function syncEntryToFlowAccount(
  db: DB,
  tenantId: string,
  entryId: string,
  opts?: { requestedBy?: string | null }
): Promise<SyncResult> {
  const requestedBy = opts?.requestedBy ?? null;

  const { data: entryData, error: entryErr } = await db
    .from("bill_entries")
    .select(
      "id, entry_type, status, customer_id, doc_date, doc_no, payment_method, counterparty_name, counterparty_tax_id"
    )
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (entryErr || !entryData) return { ok: false, reason: "not_found" };
  const entry = entryData as unknown as RawEntry;

  // ★ เฟส 5 ส่วน P (decision 0.5): รองรับแค่ sale/purchase — 'unspecified' หรือค่าอื่น ๆ ปฏิเสธก่อน claim
  if (entry.entry_type !== "sale" && entry.entry_type !== "purchase") {
    return { ok: false, reason: "unsupported_entry_type" };
  }
  if (entry.status !== "confirmed") return { ok: false, reason: "not_confirmed" };
  if (!entry.customer_id) return { ok: false, reason: "missing_customer" };

  const claimed = await claimEntryForSync(db, tenantId, entryId);
  if (!claimed) return { ok: false, reason: "already_syncing" };

  const { data: customerData } = await db
    .from("customers")
    .select("name, tax_id, address, flowaccount_client_id, flowaccount_client_secret_enc")
    .eq("id", entry.customer_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const customer = (customerData as unknown as RawCustomer | null) ?? {
    name: null,
    tax_id: null,
    address: null,
    flowaccount_client_id: null,
    flowaccount_client_secret_enc: null,
  };

  // ★ M2: credential ต่อลูกค้า — เช็คหลัง claim (ต้องโหลด customers ก่อนถึงจะรู้) ก่อนยิง fetch ใดๆ
  //   ★ decision 0.7 — credential ชุดเดียวกันใช้ร่วมกันทั้งบิลขายและบิลซื้อของลูกค้ารายนี้
  const credential = resolveCustomerCredential(customer);
  if (!credential) {
    await writeFailure(db, tenantId, entryId, null, "customer_not_configured", requestedBy);
    return { ok: false, reason: "customer_not_configured" };
  }

  const { data: lineData } = await db
    .from("bill_entry_lines")
    .select("description, amount, vat_amount, vat_type, account_code, product_id")
    .eq("tenant_id", tenantId)
    .eq("entry_id", entryId)
    .order("line_no", { ascending: true });
  const lines = ((lineData ?? []) as unknown as RawLine[]).map((l) => ({
    description: l.description,
    amount: num(l.amount),
    vatAmount: num(l.vat_amount),
    vatType: (l.vat_type === "novat" ? "novat" : "vat") as VatType,
    accountCode: l.account_code ?? null,
    productId: l.product_id ?? null,
  }));

  // ★ เฟส 5 ส่วน Q (decision 0.13)/P (decision 0.9): mapping ผังบัญชี/สินค้าของลูกค้ารายนี้ (ใช้ทั้ง
  //   sale/purchase) — ไม่มี mapping ตั้งไว้เลยก็ยังส่งเอกสารได้ตามปกติ (เป็น enhancement ไม่ใช่ prerequisite)
  //   degrade เป็น {} อัตโนมัติถ้ายังไม่มี migration 0071/ไม่มีแถว (listAccountMap/listProductMap ไม่ throw)
  const [accountMapRows, productMapRows] = await Promise.all([
    listAccountMap(db, tenantId, entry.customer_id),
    listProductMap(db, tenantId, entry.customer_id),
  ]);
  const maps = {
    accountMap: accountMapToRecord(accountMapRows),
    productMap: productMapToRecord(productMapRows),
  };

  const mapperEntry = {
    docNo: entry.doc_no,
    docDate: entry.doc_date,
    paymentMethod: asPaymentMethod(entry.payment_method),
  };

  if (entry.entry_type === "sale") {
    const mapResult = buildSalesDocumentPayload(
      mapperEntry,
      lines,
      { name: customer.name, taxId: customer.tax_id, address: customer.address },
      maps
    );
    if (!mapResult.ok) {
      await writeFailure(db, tenantId, entryId, null, mapResult.reason, requestedBy);
      return { ok: false, reason: mapResult.reason };
    }

    const clientResult = await createSalesDocument(
      { docType: mapResult.docType, body: mapResult.body },
      credential
    );
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

  // entry.entry_type === "purchase" — ★ decision 0.6: contact ของเอกสารมาจาก counterparty (ผู้ขายจริง)
  //   ไม่ใช่ `customers` (ตัวลูกค้า NOVA-CX เอง — ใช้แค่ระบุ credential/mapping ด้านบนเท่านั้น)
  const mapResult = buildPurchaseDocumentPayload(
    mapperEntry,
    lines,
    { name: entry.counterparty_name, taxId: entry.counterparty_tax_id },
    maps
  );
  if (!mapResult.ok) {
    await writeFailure(db, tenantId, entryId, null, mapResult.reason, requestedBy);
    return { ok: false, reason: mapResult.reason };
  }

  const clientResult = await createPurchaseDocument(
    { docType: mapResult.docType, body: mapResult.body },
    credential
  );
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
