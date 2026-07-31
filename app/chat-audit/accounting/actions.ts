"use server";

/**
 * Server actions ของหน้า "ลงบันทึกบัญชี" (/chat-audit/accounting) — admin เท่านั้น
 *
 * flow ความปลอดภัย (ยึดมาตรฐาน write path — ห้ามเชื่อ scope จาก client):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess:
 *        - admin/executive (Supabase Auth) หรือ lead (LINE) = เห็น/แก้ได้ทุกลูกค้า
 *        - accountant (LINE) = แก้ได้เฉพาะลูกค้าที่ตัวเองดูแล (assertCustomerInScope ทุกครั้ง)
 *      + ได้ tenantId จาก session (ไม่เชื่อค่าจาก client)
 *   2) validate อินพุตทุกตัว (uuid / enum / ตัวเลข) ก่อนเขียน
 *   3) เขียนผ่าน actions-lib (pure) ด้วย service-role client + tenantId จาก session
 *   4) revalidatePath('/chat-audit/accounting')
 *
 * ★ ไม่แตะ backend contract — import actions-lib ไปใช้/ห่อเท่านั้น
 * ★ PDPA: ไม่ log เนื้อบิล/ตัวเลข/ชื่อลูกค้า (ไม่มี console.* ที่นี่)
 * ★ auto-calc ฝั่ง server เป็นเจ้าของความจริง (resolveWht ใน actions-lib) — client แค่ช่วยแสดง
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  assertCustomerInScope,
  customerInScope,
  loadEntryCustomerId,
  AccountingAuthError,
} from "@/lib/accounting/access";
import {
  upsertEntry,
  addLine,
  updateLine,
  deleteLine,
  confirmEntry,
  deleteEntry,
  type ActionResult,
} from "@/lib/accounting/actions-lib";
import type { EntryType, VatType, WhtForm } from "@/lib/accounting/queries";
import { normalizeTaxId } from "@/lib/accounting/tax-id";
import { validateUpload, sanitizeUploadName, extOf } from "@/lib/accounting/upload";
import { redecideExistingEntries } from "@/lib/line/bill-extract-worker";
import { pushCustomerTaxId } from "@/lib/integrations/nova-sales-outbound";

const PATH = "/chat-audit/accounting";
/** bucket รูปบิล (private) — ตรงกับหน้า bills / lib/storage/bill-storage.ts */
const BILLS_BUCKET = "bills";

/** ผลลัพธ์ที่ client component ใช้แสดง toast/inline (ไม่หลุด internal) */
export type SaveResult = {
  ok: boolean;
  message: string;
  /** entry id (สำหรับ create) */
  id?: string;
};

// ---------------------------------------------------------------------
// validate helpers (กันค่าปลอมจาก client)
// ---------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function asEntryType(v: unknown): EntryType {
  return v === "sale" ? "sale" : v === "unspecified" ? "unspecified" : "purchase";
}

function asVatType(v: unknown): VatType {
  return v === "novat" ? "novat" : "vat";
}

function asWhtForm(v: unknown): WhtForm | null {
  return v === "pnd3" || v === "pnd53" ? v : null;
}

/** ตัด/จำกัดความยาวข้อความ (กัน payload ใหญ่ผิดปกติ) — คืน null ถ้าว่าง */
function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** วันที่ YYYY-MM-DD (null ถ้าผิดรูป) */
function asDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** ตัวเลขปลอดภัย (NaN/ค่าพัง → 0) — จำกัดช่วงกันค่าเวอร์ */
function asNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, 1_000_000_000));
}

/** แปลง error code จาก actions-lib → ข้อความไทยสุภาพ */
function friendlyError(code: string): string {
  switch (code) {
    case "entry_type_unspecified":
      return "เลือกประเภทซื้อ/ขายก่อนยืนยัน";
    case "entry_confirmed":
    case "already_confirmed":
      return "รายการนี้ยืนยันแล้ว แก้ไขไม่ได้";
    case "no_amount":
      return "ต้องมีรายการที่มีมูลค่าอย่างน้อย 1 บรรทัดก่อนยืนยัน";
    case "not_found":
      return "ไม่พบรายการ (อาจถูกลบไปแล้ว)";
    default:
      return "ทำรายการไม่สำเร็จ กรุณาลองใหม่";
  }
}

// ---------------------------------------------------------------------
// input types (รับจาก EntryEditor ฝั่ง client — plain object)
// ---------------------------------------------------------------------

export type EditableLineInput = {
  /** มี id = line เดิม (update) · ไม่มี = line ใหม่ (add) */
  id?: string;
  vatType: VatType;
  description?: string | null;
  amount: number;
  vatAmount: number;
  whtRate: number;
  whtAmount: number;
};

export type SaveEntryInput = {
  id?: string;
  entryType: EntryType;
  customerId?: string | null;
  attachmentId?: string | null;
  docDate?: string | null;
  docNo?: string | null;
  counterpartyName?: string | null;
  counterpartyTaxId?: string | null;
  whtForm?: WhtForm | null;
  notes?: string | null;
  lines: EditableLineInput[];
  /** id ของ line ที่ผู้ใช้ลบใน editor (ต้องลบใน DB ด้วย) */
  deletedLineIds?: string[];
  /** true = บันทึกแล้วยืนยันเลย (draft → confirmed) */
  confirm?: boolean;
};

// ---------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------

/**
 * บันทึก entry ทั้งใบ (หัว + ทุก line) แบบ composite:
 *   upsert หัว → ลบ line ที่เอาออก → add/update แต่ละ line → (optional) confirm
 *   ★ ทุกขั้นผ่าน actions-lib (guard confirmed/ tenant scope) — server เป็นเจ้าของความจริง
 */
export async function saveEntryAction(input: SaveEntryInput): Promise<SaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    // id ต้องเป็น uuid ถ้าส่งมา (แก้ของเดิม)
    if (input.id !== undefined && !isUuid(input.id)) {
      return { ok: false, message: "ไม่พบรายการที่เลือก" };
    }
    if (input.customerId != null && !isUuid(input.customerId)) {
      return { ok: false, message: "ลูกค้าไม่ถูกต้อง" };
    }
    if (input.attachmentId != null && !isUuid(input.attachmentId)) {
      return { ok: false, message: "ไฟล์แนบไม่ถูกต้อง" };
    }

    // ★ สโคปนักบัญชี (server-side): แก้ของเดิม → ลูกค้าปัจจุบันของ entry ต้องอยู่ในความดูแล
    //   + ลูกค้าปลายทางที่จะบันทึกก็ต้องอยู่ในความดูแล (admin/lead ผ่านทุกกรณี)
    if (input.id) {
      const currentCustomer = await loadEntryCustomerId(service, ctx.tenantId, input.id);
      if (currentCustomer === undefined) {
        return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
      }
      assertCustomerInScope(ctx, currentCustomer);
    }
    assertCustomerInScope(ctx, input.customerId ?? null);

    // 1) upsert หัวเอกสาร
    const up = await upsertEntry(service, ctx.tenantId, {
      id: input.id,
      entryType: asEntryType(input.entryType),
      customerId: input.customerId ?? null,
      attachmentId: input.attachmentId ?? null,
      docDate: asDate(input.docDate),
      docNo: clampText(input.docNo, 60),
      counterpartyName: clampText(input.counterpartyName, 200),
      counterpartyTaxId: clampText(input.counterpartyTaxId, 20),
      whtForm: asWhtForm(input.whtForm),
      notes: clampText(input.notes, 500),
    });
    if (!up.ok) return { ok: false, message: friendlyError(up.error) };
    const entryId = up.data.id;

    // 2) ลบ line ที่ผู้ใช้เอาออก
    for (const lid of input.deletedLineIds ?? []) {
      if (isUuid(lid)) {
        const res = await deleteLine(service, ctx.tenantId, lid);
        if (!res.ok && res.error !== "not_found") {
          return { ok: false, message: friendlyError(res.error) };
        }
      }
    }

    // 3) add/update แต่ละ line (เรียงลำดับ line_no ตามที่ส่งมา)
    let lineNo = 1;
    for (const l of input.lines) {
      const payload = {
        lineNo: lineNo++,
        vatType: asVatType(l.vatType),
        description: clampText(l.description, 300),
        amount: asNumber(l.amount),
        vatAmount: asNumber(l.vatAmount),
        whtRate: asNumber(l.whtRate),
        whtAmount: asNumber(l.whtAmount),
      };
      let res: ActionResult;
      if (l.id && isUuid(l.id)) {
        res = await updateLine(service, ctx.tenantId, l.id, payload);
      } else {
        res = await addLine(service, ctx.tenantId, entryId, payload);
      }
      if (!res.ok) return { ok: false, message: friendlyError(res.error) };
    }

    // 4) ยืนยัน (ถ้าขอ) — reject ถ้ายัง unspecified / ไม่มีมูลค่า
    if (input.confirm) {
      const conf = await confirmEntry(service, ctx.tenantId, entryId);
      if (!conf.ok) {
        revalidatePath(PATH);
        return { ok: false, message: friendlyError(conf.error), id: entryId };
      }
    }

    revalidatePath(PATH);
    return {
      ok: true,
      message: input.confirm ? "ยืนยันรายการแล้ว" : "บันทึกร่างแล้ว",
      id: entryId,
    };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่ หรือติดต่อผู้ดูแลระบบ" };
  }
}

/**
 * ปุ่มลัด "ย้ายไปซื้อ/ขาย" (แก้ AI จับผิดฝั่ง) — เปลี่ยนเฉพาะ entry_type
 *   คงค่าอื่นไว้ครบ (อ่านของเดิมแล้ว re-upsert) — ไม่ให้ค่าอื่นหาย
 */
export async function moveEntryTypeAction(
  entryId: string,
  target: EntryType
): Promise<SaveResult> {
  if (!isUuid(entryId)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  const type = asEntryType(target);
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    // อ่านหัวเดิม (scope tenant) เพื่อคงค่าอื่นไว้
    const { data: cur } = await service
      .from("bill_entries")
      .select(
        "attachment_id, customer_id, doc_date, doc_no, counterparty_name, counterparty_tax_id, wht_form, notes"
      )
      .eq("id", entryId)
      .eq("tenant_id", ctx.tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!cur) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };

    const c = cur as {
      attachment_id: string | null;
      customer_id: string | null;
      doc_date: string | null;
      doc_no: string | null;
      counterparty_name: string | null;
      counterparty_tax_id: string | null;
      wht_form: string | null;
      notes: string | null;
    };

    // ★ สโคปนักบัญชี: ต้องเป็นลูกค้าที่ตัวเองดูแล (admin/lead ผ่าน)
    assertCustomerInScope(ctx, c.customer_id);

    const res = await upsertEntry(service, ctx.tenantId, {
      id: entryId,
      entryType: type,
      attachmentId: c.attachment_id,
      customerId: c.customer_id,
      docDate: c.doc_date,
      docNo: c.doc_no,
      counterpartyName: c.counterparty_name,
      counterpartyTaxId: c.counterparty_tax_id,
      whtForm: asWhtForm(c.wht_form),
      notes: c.notes,
    });
    if (!res.ok) return { ok: false, message: friendlyError(res.error) };

    revalidatePath(PATH);
    const label = type === "purchase" ? "ภาษีซื้อ" : type === "sale" ? "ภาษีขาย" : "รอระบุ";
    return { ok: true, message: `ย้ายไป ${label} แล้ว` };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ย้ายประเภทไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * ลบ entry (กรณี AI ดึงรูปที่ "ไม่ใช่บิล" มาสร้าง) — admin เท่านั้น
 *
 * ทำ 2 อย่างพร้อมกัน (กัน cron extract-bills สร้าง entry ใหม่มาอีก):
 *   1) soft-delete bill_entries (deleteEntry จาก actions-lib)
 *   2) ถ้า entry มี attachment_id → "มาร์คต้นทางว่าไม่ใช่บิล" + ลบไฟล์จริง:
 *        - ลบไฟล์จาก bucket `bills` (ถ้ามี drive_file_id)
 *        - update message_attachments: doc_kind='other', fetch_status='skipped',
 *          fetch_error='not_a_bill', drive_url=null, drive_file_id=null
 *      → หายจากหน้าบัญชี + หน้าบิล + extract-bills ไม่ดึงมาอีก
 *        (worker เลือกเฉพาะ fetch_status='stored' + doc_kind∈บิล — สองเงื่อนไขถูกตัดพร้อมกัน)
 *   - entry ที่คีย์เอง (attachment_id=null) → ข้ามขั้น 2 (ลบแค่ entry)
 */
export async function deleteEntryAction(entryId: string): Promise<SaveResult> {
  if (!isUuid(entryId)) return { ok: false, message: "ไม่พบรายการที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    // อ่าน attachment ต้นทาง + ไฟล์อัปเอง + ลูกค้า ก่อนลบ (scope tenant)
    const { data: entryRow } = await service
      .from("bill_entries")
      .select("attachment_id, upload_path, customer_id")
      .eq("id", entryId)
      .eq("tenant_id", ctx.tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!entryRow) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
    // ★ สโคปนักบัญชี: ลบได้เฉพาะลูกค้าที่ตัวเองดูแล (admin/lead ผ่าน)
    assertCustomerInScope(ctx, (entryRow as { customer_id: string | null }).customer_id);
    const attachmentId = (entryRow as { attachment_id: string | null }).attachment_id ?? null;
    const uploadPath = (entryRow as { upload_path: string | null }).upload_path ?? null;

    // 1) soft-delete entry
    const res = await deleteEntry(service, ctx.tenantId, entryId);
    if (!res.ok) return { ok: false, message: friendlyError(res.error) };

    // 1.5) entry ที่อัปไฟล์เอง → ลบไฟล์จริงออกจาก bucket ด้วย (best-effort)
    if (uploadPath) {
      await service.storage.from(BILLS_BUCKET).remove([uploadPath]);
    }

    // 2) มาร์ค attachment ต้นทางว่าไม่ใช่บิล + ลบไฟล์ (ถ้ามี)
    if (attachmentId) {
      const { data: attRow } = await service
        .from("message_attachments")
        .select("drive_file_id")
        .eq("id", attachmentId)
        .eq("tenant_id", ctx.tenantId)
        .maybeSingle();
      const objectPath = (attRow as { drive_file_id: string | null } | null)?.drive_file_id ?? null;

      // ลบไฟล์จริงจาก bucket (best-effort — ไฟล์หายแล้วก็ mark ต่อ)
      if (objectPath) {
        await service.storage.from(BILLS_BUCKET).remove([objectPath]);
      }
      // ตัดออกจาก query ของ extract-bills (doc_kind='other' + fetch_status='skipped')
      await service
        .from("message_attachments")
        .update({
          doc_kind: "other",
          fetch_status: "skipped",
          fetch_error: "not_a_bill",
          drive_url: null,
          drive_file_id: null,
          doc_checked: true,
        })
        .eq("id", attachmentId)
        .eq("tenant_id", ctx.tenantId);
    }

    revalidatePath(PATH);
    revalidatePath("/chat-audit/bills");
    return { ok: true, message: "ลบรายการแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * "เพิ่มรายการเอง" (คีย์เอง source='manual') — สร้าง entry ว่างแล้วพาไปหน้าแก้ทันที
 *   ใช้เป็น <form action={createEntryAction}> (server action) — redirect ไป ?edit=<newId>
 *   รับ customerId (ผูกลูกค้าที่กำลังดู) + entryType (แท็บย่อยปัจจุบัน) จาก form
 */
export async function createEntryAction(formData: FormData): Promise<void> {
  const authed = await createClient();
  const service = createServiceRoleClient();
  const ctx = await requireAccountingAccess(authed, service); // throw ถ้าไม่มีสิทธิ์ → error boundary

  const rawCustomer = formData.get("customerId");
  const customerId = isUuid(rawCustomer) ? rawCustomer : null;
  // แท็บ unspecified → เริ่มเป็น purchase (คีย์เองรู้ฝั่งอยู่แล้ว, ให้ยืนยันได้ทันที)
  const rawType = asEntryType(formData.get("entryType"));
  const entryType: EntryType = rawType === "unspecified" ? "purchase" : rawType;

  // ★ สโคปนักบัญชี: สร้างได้เฉพาะลูกค้าที่ตัวเองดูแล (ห้ามสร้างแบบไม่ผูกลูกค้า/ลูกค้าคนอื่น)
  //   นอกสโคป → ไม่สร้าง กลับหน้าเดิม (ไม่ throw เพื่อไม่ให้ crash flow redirect)
  if (!customerInScope(ctx, customerId)) {
    redirect(customerId ? `${PATH}?open=${customerId}` : PATH);
  }

  const res = await upsertEntry(service, ctx.tenantId, { entryType, customerId });
  revalidatePath(PATH);

  // สร้างสำเร็จ → เปิดหน้าแก้ของ entry ใหม่ (คงบริบทลูกค้า/แท็บ)
  const sp = new URLSearchParams();
  if (customerId) sp.set("open", customerId);
  sp.set("type", entryType);
  if (res.ok) sp.set("edit", res.data.id);
  redirect(`${PATH}?${sp.toString()}`);
}

/** เดือน 'YYYY-MM' (UTC) จากเวลาปัจจุบัน — โฟลเดอร์เก็บไฟล์ */
function monthFolder(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** timestamp ปลอดภัยกับชื่อไฟล์ (ตัด : และ .) กันชนกันในโฟลเดอร์เดียว */
function safeStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** sanitize ส่วนของ path เป็น ASCII (กัน key ไทย/`/` → 400 InvalidKey / path traversal) */
function sanitizePathPart(raw: string): string {
  const s = (raw ?? "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/_{2,}/g, "_");
  return s || "unassigned";
}

/**
 * "อัปโหลดไฟล์เอง" เข้าบัญชี — นักบัญชีแนบเอกสาร (Excel/PDF/รูป/CSV) ที่ไม่ได้มาทางไลน์
 *   flow ความปลอดภัย (เหมือน write path อื่น):
 *     1) guard admin/executive + tenant จาก session (ไม่เชื่อ client)
 *     2) validate ไฟล์ (ชนิด image/pdf/excel/csv + ขนาด ≤ 15MB)
 *     3) resolve customer_code (ถ้าเลือกลูกค้า) → ชื่อโฟลเดอร์ (ASCII)
 *     4) อัปเข้า bucket `bills` path manual/{code|unassigned}/{YYYY-MM}/{stamp}_{ชื่อ sanitize}
 *        (service role · upsert:false — ไม่ทับไฟล์เดิม)
 *     5) สร้าง bill_entries ใหม่ (source='manual', status='draft') + set upload_path/name/mime
 *        + สร้าง 1 line ว่างให้คีย์
 *     6) revalidatePath — คืน { ok, message, id } (ให้ client พาไปหน้าแก้)
 *   ★ PDPA: ไม่ log ชื่อไฟล์/ลูกค้า/URL/path (ไม่มี console.* ที่นี่)
 */
export async function uploadAccountingFileAction(formData: FormData): Promise<SaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    // 1) validate อินพุตควบคุม (ลูกค้า/ประเภท)
    const rawCustomer = formData.get("customerId");
    const customerId = isUuid(rawCustomer) ? rawCustomer : null;
    // ถ้าส่ง customerId มาแต่รูปแบบผิด (ไม่ใช่ uuid และไม่ว่าง) = ปฏิเสธ กันผูกผิด
    if (rawCustomer != null && rawCustomer !== "" && !customerId) {
      return { ok: false, message: "ลูกค้าไม่ถูกต้อง" };
    }
    // ★ สโคปนักบัญชี: อัปไฟล์เข้าได้เฉพาะลูกค้าที่ตัวเองดูแล (admin/lead ผ่าน)
    if (!customerInScope(ctx, customerId)) {
      return { ok: false, message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }
    const entryType = asEntryType(formData.get("entryType"));

    // 2) validate ไฟล์
    const file = formData.get("file");
    if (!(file instanceof File)) return { ok: false, message: "ไม่พบไฟล์ที่เลือก" };
    const v = validateUpload({ mime: file.type, name: file.name, size: file.size });
    if (!v.ok) return { ok: false, message: v.error };

    // 3) resolve customer_code เป็นชื่อโฟลเดอร์ (ASCII) — ต้องมีลูกค้าจริงถ้าเลือกมา
    let folderCode = "unassigned";
    if (customerId) {
      const { data: cust } = await service
        .from("customers")
        .select("customer_code")
        .eq("id", customerId)
        .eq("tenant_id", ctx.tenantId)
        .is("deleted_at", null)
        .maybeSingle();
      if (!cust) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
      const code = (cust as { customer_code: string | null }).customer_code?.trim();
      folderCode = code ? sanitizePathPart(code) : `unassigned-${customerId.slice(0, 8)}`;
    }

    // 4) อัปเข้า Supabase Storage bucket `bills` (ตรงเข้า supabase เสมอ — ให้ sign แสดงได้)
    const safeName = sanitizeUploadName(file.name) || `file.${extOf(file.name) || "bin"}`;
    const objectPath = [
      ctx.tenantId,
      "manual",
      folderCode,
      monthFolder(),
      `${safeStamp()}_${safeName}`,
    ].join("/");

    const buf = Buffer.from(await file.arrayBuffer());
    const { error: upErr } = await service.storage
      .from(BILLS_BUCKET)
      .upload(objectPath, buf, { contentType: file.type || "application/octet-stream", upsert: false });
    if (upErr) return { ok: false, message: "อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่" };

    // 5) สร้าง entry ใหม่ (manual/draft) + แนบไฟล์ + 1 line ว่าง
    const up = await upsertEntry(service, ctx.tenantId, {
      entryType,
      customerId,
      uploadPath: objectPath,
      uploadName: file.name.slice(0, 200),
      uploadMime: file.type || null,
    });
    if (!up.ok) {
      // สร้าง entry ไม่ได้ → เก็บไฟล์ค้างไว้ไม่ได้ (orphan) ลบทิ้ง best-effort
      await service.storage.from(BILLS_BUCKET).remove([objectPath]);
      return { ok: false, message: friendlyError(up.error) };
    }
    await addLine(service, ctx.tenantId, up.data.id, {});

    revalidatePath(PATH);
    return { ok: true, message: "อัปโหลดไฟล์แล้ว — คีย์รายการต่อได้เลย", id: up.data.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * บันทึกเลขภาษีของลูกค้า (loop เก็บเลขภาษี) — admin เท่านั้น
 *
 * บิลหลายใบไม่มีเลขภาษีให้ AI อ่าน → จับซื้อ/ขายไม่ได้ (กลายเป็น "รอระบุ").
 * ให้นักบัญชีกรอกเลขภาษีของลูกค้าที่ขาด แล้วระบบทำ 3 อย่าง:
 *   1) จำไว้ที่ customers.tax_id (tenant-scoped; trigger set_updated_at อัปเดต updated_at ให้เอง)
 *   2) re-decide บิลของลูกค้ารายนั้นที่ยัง 'unspecified' ทันที (ใช้ tax_id ใหม่ + seller/buyer ที่เก็บไว้)
 *   3) ส่งเลขภาษีกลับ NOVA Sale (best-effort — ไม่มี env/ล้ม ก็ไม่ทำให้ action พัง)
 *
 * ★ validate 13 หลัก (strip ขีด/ช่องว่าง) ก่อนเขียน
 * ★ PDPA: ไม่ log เลขภาษี/ชื่อลูกค้า (ไม่มี console.* ที่นี่)
 */
export async function saveCustomerTaxIdAction(input: {
  customerId: string;
  taxId: string;
}): Promise<SaveResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) {
      return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    }
    // ★ สโคปนักบัญชี: กรอกเลขภาษีได้เฉพาะลูกค้าที่ตัวเองดูแล (admin/lead ผ่าน)
    if (!customerInScope(ctx, input.customerId)) {
      return { ok: false, message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }
    const taxId = normalizeTaxId(input.taxId);
    if (!taxId) {
      return { ok: false, message: "เลขภาษีต้องเป็นตัวเลข 13 หลัก" };
    }

    // 1) อัปเดต customers.tax_id (scope tenant — กันเขียนข้าม tenant) + คืน external_ref/customer_code
    //    เพื่อส่งกลับ NOVA Sale (updated_at อัปเดตอัตโนมัติจาก trigger set_updated_at)
    const { data: updated, error: updErr } = await service
      .from("customers")
      .update({ tax_id: taxId })
      .eq("id", input.customerId)
      .eq("tenant_id", ctx.tenantId)
      .is("deleted_at", null)
      .select("id, external_ref, customer_code")
      .maybeSingle();

    if (updErr || !updated) {
      return { ok: false, message: "บันทึกเลขภาษีไม่สำเร็จ (ไม่พบลูกค้า หรือฐานข้อมูลผิดพลาด)" };
    }
    const cust = updated as {
      id: string;
      external_ref: string | null;
      customer_code: string | null;
    };

    // 2) re-decide บิล 'unspecified' ของลูกค้ารายนี้ทันที (ใช้ tax_id ใหม่)
    let redecided = 0;
    try {
      const r = await redecideExistingEntries(service, ctx.tenantId, {
        customerId: input.customerId,
      });
      redecided = r.updated;
    } catch {
      // re-decide ล้ม ไม่ให้ทั้ง action พัง — เลขภาษีเก็บแล้ว, cron redecide รอบถัดไปจะตามเก็บ
    }

    // 3) ส่งกลับ NOVA Sale (best-effort — degrade ถ้าไม่ตั้ง env / ยิงไม่ผ่าน)
    await pushCustomerTaxId({
      externalRef: cust.external_ref,
      customerCode: cust.customer_code,
      taxId,
    });

    revalidatePath(PATH);
    const suffix = redecided > 0 ? ` · จับคู่ซื้อ/ขายให้ ${redecided} รายการแล้ว` : "";
    return { ok: true, message: `บันทึกเลขภาษีแล้ว${suffix}` };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกเลขภาษีไม่สำเร็จ กรุณาลองใหม่" };
  }
}
