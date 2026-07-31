"use server";

/**
 * Server actions ของหน้า "ลงบันทึกบัญชี" (/chat-audit/accounting) — admin เท่านั้น
 *
 * flow ความปลอดภัย (ยึดมาตรฐาน write path — ห้ามเชื่อ scope จาก client):
 *   1) resolve viewer จาก session จริง (cookie) → requireAdminContext บังคับ role∈{admin,executive}
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
import { requireAdminContext, AdminAuthError } from "@/lib/admin/guard";
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
    const ctx = await requireAdminContext(authed);
    const service = createServiceRoleClient();

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
    if (e instanceof AdminAuthError) return { ok: false, message: e.message };
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
    const ctx = await requireAdminContext(authed);
    const service = createServiceRoleClient();

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
    if (e instanceof AdminAuthError) return { ok: false, message: e.message };
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
    const ctx = await requireAdminContext(authed);
    const service = createServiceRoleClient();

    // อ่าน attachment ต้นทางก่อนลบ (scope tenant)
    const { data: entryRow } = await service
      .from("bill_entries")
      .select("attachment_id")
      .eq("id", entryId)
      .eq("tenant_id", ctx.tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    const attachmentId = (entryRow as { attachment_id: string | null } | null)?.attachment_id ?? null;

    // 1) soft-delete entry
    const res = await deleteEntry(service, ctx.tenantId, entryId);
    if (!res.ok) return { ok: false, message: friendlyError(res.error) };

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
    if (e instanceof AdminAuthError) return { ok: false, message: e.message };
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
  const ctx = await requireAdminContext(authed); // throw ถ้าไม่ใช่ admin → error boundary
  const service = createServiceRoleClient();

  const rawCustomer = formData.get("customerId");
  const customerId = isUuid(rawCustomer) ? rawCustomer : null;
  // แท็บ unspecified → เริ่มเป็น purchase (คีย์เองรู้ฝั่งอยู่แล้ว, ให้ยืนยันได้ทันที)
  const rawType = asEntryType(formData.get("entryType"));
  const entryType: EntryType = rawType === "unspecified" ? "purchase" : rawType;

  const res = await upsertEntry(service, ctx.tenantId, { entryType, customerId });
  revalidatePath(PATH);

  // สร้างสำเร็จ → เปิดหน้าแก้ของ entry ใหม่ (คงบริบทลูกค้า/แท็บ)
  const sp = new URLSearchParams();
  if (customerId) sp.set("open", customerId);
  sp.set("type", entryType);
  if (res.ok) sp.set("edit", res.data.id);
  redirect(`${PATH}?${sp.toString()}`);
}
