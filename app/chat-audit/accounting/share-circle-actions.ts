"use server";

/**
 * Server actions ของแท็บ "วงแชร์" ในหน้าลงบันทึกบัญชี (/chat-audit/accounting)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับ share-circle-actions/หน้าบัญชี — ห้ามเชื่อ client):
 *   1) requireAccountingAccess (สิทธิ์เดียวกับหน้าลงบัญชี) + tenantId จาก session
 *   2) validate อินพุตทุกตัว (uuid / month / ตัวเลข) ก่อนเขียน
 *   3) เขียนผ่าน service-role client + tenantId จาก session
 *   4) guard สโคปลูกค้า (customerInScope) ก่อน insert/update/soft-delete ทุกครั้ง
 *   5) revalidatePath('/chat-audit/accounting')
 *
 * ★ นักบัญชีต้องแก้/เพิ่ม/ลบเองได้ (เผื่อ AI ดึงผิด/ไม่หมด) — create/update/softDelete/restore
 * ★ PDPA: ไม่ log ชื่อวง/ตัวเลข
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  customerInScope,
  AccountingAuthError,
} from "@/lib/accounting/access";
import { createHash } from "node:crypto";
import { normalizePeriodMonth } from "@/lib/share-circles/queries";
import { extractShareCircles, type ShareCircleImage } from "@/lib/ai/share-circle";
import { insertParsedCirclesDedup, sourceRefAlreadyUsed } from "@/lib/share-circles/insert";
import { mimeFromPath } from "@/lib/line/bill-extract-worker";

/** bucket รูป (ตรงกับ actions.ts / storage) */
const BILLS_BUCKET = "bills";
/** เพดานรูป/ครั้ง + ข้อความ (กัน payload ใหญ่/ช้า) */
const MAX_IMAGES = 12;
const MAX_TEXT_CHARS = 20_000;

const PATH = "/chat-audit/accounting";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ตัด/trim ข้อความ — คืน null ถ้าว่าง */
function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** ตัวเลข ≥ 0 หรือ null (จำกัดช่วงกันค่าเวอร์) */
function asNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(String(v).replace(/,/g, "")) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 1_000_000_000);
}

/** จำนวนเต็ม ≥ 0 หรือ null */
function asIntOrNull(v: unknown): number | null {
  const n = asNumberOrNull(v);
  return n === null ? null : Math.round(n);
}

export type ActionResult = {
  ok: boolean;
  message: string;
  id?: string;
};

/**
 * ยืนยันว่าลูกค้าอยู่ใน tenant นี้จริง (defense-in-depth)
 *   ★ admin มี allowedCustomerIds===null → customerInScope ผ่านทุก uuid
 *     จึงต้องกันไม่ให้ส่ง customerId ของ tenant อื่นมาสร้าง/ตั้งค่าข้ามเทแนนต์
 */
async function customerBelongsToTenant(
  service: ReturnType<typeof createServiceRoleClient>,
  tenantId: string,
  customerId: string
): Promise<boolean> {
  const { data } = await service
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return !!data;
}

/** ช่องข้อมูลวงที่รับจาก client (ใช้ทั้ง create + update) */
export type ShareCircleFields = {
  periodMonth: string;
  circleName: string;
  roundNote?: string | null;
  memberCount?: number | string | null;
  principalPerHead?: number | string | null;
  taoIncome?: number | string | null;
  mgmtFee?: number | string | null;
  operationFee?: number | string | null;
  interestIncome?: number | string | null;
  expense?: number | string | null;
};

/** map fields (validate) → object สำหรับ insert/update (ไม่รวม tenant/customer) */
function normalizeFields(f: ShareCircleFields): { ok: true; row: Record<string, unknown> } | { ok: false; message: string } {
  // ★ บังคับ ค.ศ. YYYY-MM เสมอ (ผู้ใช้อาจเผลอส่ง พ.ศ.) แล้วค่อย validate รูปแบบ
  const periodMonth = normalizePeriodMonth((f.periodMonth ?? "").trim());
  if (!MONTH_RE.test(periodMonth)) {
    return { ok: false, message: "กรุณาเลือกเดือน (รูปแบบ ปี-เดือน)" };
  }
  const name = clampText(f.circleName, 200);
  if (!name) return { ok: false, message: "กรุณาระบุชื่อวง" };
  return {
    ok: true,
    row: {
      period_month: periodMonth,
      circle_name: name,
      round_note: clampText(f.roundNote, 200),
      member_count: asIntOrNull(f.memberCount),
      principal_per_head: asNumberOrNull(f.principalPerHead),
      tao_income: asNumberOrNull(f.taoIncome),
      mgmt_fee: asNumberOrNull(f.mgmtFee),
      operation_fee: asNumberOrNull(f.operationFee),
      interest_income: asNumberOrNull(f.interestIncome),
      expense: asNumberOrNull(f.expense),
    },
  };
}

/**
 * (0) สวิตช์ "ลูกค้าเป็นท้าวแชร์" (เปิด/ปิด) — set customers.is_share_circle
 *   ★ เปิดครั้งเดียวเพื่อให้แท็บ "วงแชร์" โผล่ (แม้ยัง 0 วง) → เริ่มอ่านจากไลน์/คีย์เองได้
 *   ★ guard admin + service-role + สโคปลูกค้า (เหมือน action อื่น)
 *   ★ degrade: คอลัมน์ยังไม่ apply (schema cache) → คืน error สุภาพ ไม่ throw
 */
export async function setCustomerShareCircleAction(
  customerId: string,
  on: boolean
): Promise<ActionResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้า" };
    if (!customerInScope(ctx, customerId)) {
      return { ok: false, message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }
    if (!(await customerBelongsToTenant(service, ctx.tenantId, customerId))) {
      return { ok: false, message: "ไม่พบลูกค้าในสำนักงานนี้" };
    }

    const { error } = await service
      .from("customers")
      .update({ is_share_circle: on === true })
      .eq("id", customerId)
      .eq("tenant_id", ctx.tenantId);
    if (error) {
      // คอลัมน์ยังไม่ apply migration 0057 → แจ้งสุภาพ (ไม่ crash)
      return { ok: false, message: "ตั้งค่าไม่สำเร็จ (อาจยังไม่ได้ apply migration 0057)" };
    }

    // ★ ย้อนหลังอัตโนมัติ: เปิดธง → soft-delete "บิลร่างที่เป็นรูปวงแชร์" ของลูกค้าคนนี้
    //   เงื่อนไข: unspecified (รอระบุ) + ยังไม่ยืนยัน + มาจากรูปในไลน์ (attachment_id ≠ null) + ยังไม่ลบ
    //   ★ ไม่แตะ: บิล confirmed / บิลที่คีย์เอง-อัปเอง (attachment_id = null) / บิลซื้อ-ขายที่ตัดสินฝั่งแล้ว
    //   ★ soft-delete → กู้คืนได้ (ลบผิดยังกลับมาได้)
    let movedCount = 0;
    if (on === true) {
      const { data: moved, error: delErr } = await service
        .from("bill_entries")
        .update({ deleted_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId)
        .eq("customer_id", customerId)
        .eq("entry_type", "unspecified")
        .neq("status", "confirmed")
        .not("attachment_id", "is", null)
        .is("deleted_at", null)
        .select("id");
      if (!delErr) movedCount = (moved ?? []).length;
      // delErr = best-effort (ธงเปิดสำเร็จแล้ว) — ไม่ทำให้ทั้ง action ล้ม
    }

    revalidatePath(PATH);
    if (!on) return { ok: true, message: "ยกเลิกท้าวแชร์แล้ว", id: customerId };
    const movedMsg =
      movedCount > 0
        ? ` · ย้ายรูปวงแชร์ ${movedCount.toLocaleString("th-TH")} รายการออกจากบิลแล้ว`
        : "";
    return { ok: true, message: `ตั้งเป็นลูกค้าท้าวแชร์แล้ว${movedMsg}`, id: customerId };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ตั้งค่าไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * (a) เพิ่มวงเอง (นักบัญชีคีย์เอง กรณี AI ดึงไม่หมด) — source='manual'
 */
export async function createShareCircleEntryAction(
  customerId: string,
  fields: ShareCircleFields
): Promise<ActionResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้า" };
    if (!customerInScope(ctx, customerId)) {
      return { ok: false, message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }
    if (!(await customerBelongsToTenant(service, ctx.tenantId, customerId))) {
      return { ok: false, message: "ไม่พบลูกค้าในสำนักงานนี้" };
    }
    const norm = normalizeFields(fields);
    if (!norm.ok) return { ok: false, message: norm.message };

    const { data, error } = await service
      .from("share_circle_entries")
      .insert({
        tenant_id: ctx.tenantId,
        customer_id: customerId,
        ...norm.row,
        source: "manual",
        status: "active",
      })
      .select("id")
      .maybeSingle();
    if (error || !data) return { ok: false, message: "เพิ่มวงไม่สำเร็จ กรุณาลองใหม่" };

    revalidatePath(PATH);
    return { ok: true, message: "เพิ่มวงแล้ว", id: (data as { id: string }).id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "เพิ่มวงไม่สำเร็จ กรุณาลองใหม่" };
  }
}

// ---------------------------------------------------------------------
// กรอกเอง: วางข้อความ / อัปรูป → AI แยก → insert entries (source='ai')
// ---------------------------------------------------------------------

/** sha256 (8 ตัวแรก) ของข้อความ/บัฟเฟอร์ — ใช้ทำ source_ref กัน input ซ้ำเป๊ะ */
function sha8(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/** สรุปข้อความผลลัพธ์ dedup (added/skipped) */
function dedupResultMsg(added: number, skipped: number): string {
  const a = added.toLocaleString("th-TH");
  if (skipped === 0) return `AI แยกได้ ${a} วง — ตรวจ/แก้ได้ในตาราง`;
  const s = skipped.toLocaleString("th-TH");
  return `⚠️ พบซ้ำ ${s} วง (ข้ามให้แล้ว) · เพิ่มใหม่ ${a} วง`;
}

/** guard ร่วม (admin + scope + tenant) + normalize month — คืน ctx/month หรือ error */
async function guardExtractInput(
  customerId: string,
  monthInput: string
): Promise<
  | { ok: true; service: ReturnType<typeof createServiceRoleClient>; tenantId: string; month: string }
  | { ok: false; message: string }
> {
  const authed = await createClient();
  const service = createServiceRoleClient();
  const ctx = await requireAccountingAccess(authed, service);
  if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้า" };
  if (!customerInScope(ctx, customerId)) {
    return { ok: false, message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
  }
  if (!(await customerBelongsToTenant(service, ctx.tenantId, customerId))) {
    return { ok: false, message: "ไม่พบลูกค้าในสำนักงานนี้" };
  }
  const month = normalizePeriodMonth((monthInput ?? "").trim());
  if (!MONTH_RE.test(month)) return { ok: false, message: "กรุณาเลือกเดือนก่อน" };
  return { ok: true, service, tenantId: ctx.tenantId, month };
}

/**
 * (a1) วางข้อความวงแชร์เอง → AI แยก → insert เข้าเดือนที่เลือก (source='ai')
 *   ★ guard admin + scope + tenant · เรียก extractShareCircles({ text }) (prompt เดียวกับอ่านจากไลน์)
 */
export async function extractShareCircleFromTextAction(
  customerId: string,
  month: string,
  text: string,
  opts?: { force?: boolean }
): Promise<ActionResult> {
  try {
    const g = await guardExtractInput(customerId, month);
    if (!g.ok) return { ok: false, message: g.message };

    const t = typeof text === "string" ? text.trim().slice(0, MAX_TEXT_CHARS) : "";
    if (!t) return { ok: false, message: "กรุณาวางข้อความลิสต์วงแชร์ก่อน" };

    // ระดับ 2: กัน "วางข้อความซ้ำเป๊ะ" — hash ข้อความ (normalize whitespace) → source_ref
    const norm = t.replace(/\s+/g, " ").trim();
    const sourceRef = `paste:${sha8(norm)}`;
    if (!opts?.force && (await sourceRefAlreadyUsed(g.service, g.tenantId, customerId, g.month, sourceRef))) {
      return { ok: false, message: "ข้อความนี้เคยวางในเดือนนี้แล้ว (กัน 'ซ้ำ') — ถ้าตั้งใจเพิ่มซ้ำ กด 'วางซ้ำอยู่ดี'" };
    }

    const circles = await extractShareCircles({ text: t });
    if (circles.length === 0) {
      return {
        ok: false,
        message: "AI ไม่พบวงแชร์ในข้อความ (หรือยังไม่ได้ตั้งค่า OPENAI_API_KEY) — ลองเพิ่มวงเอง",
      };
    }
    const { added, skipped } = await insertParsedCirclesDedup(
      g.service, g.tenantId, customerId, g.month, circles, sourceRef
    );
    if (added === 0 && skipped === 0) return { ok: false, message: "บันทึกวงไม่สำเร็จ กรุณาลองใหม่" };
    if (added === 0) return { ok: false, message: `⚠️ วงทั้งหมด (${skipped.toLocaleString("th-TH")}) ซ้ำกับที่มีอยู่แล้ว — ไม่เพิ่มซ้ำ` };

    revalidatePath(PATH);
    return { ok: true, message: dedupResultMsg(added, skipped) };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "แยกวงไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * (a2) อัปรูปวงแชร์เอง (อัปตรงเข้า storage แล้ว) → อ่านรูปจาก path → AI แยก → insert
 *   ★ paths มาจาก createBillUploadUrlAction (อยู่ใต้ {tenant}/manual/) — re-verify prefix กันชี้ข้าม
 *   ★ อ่านรูปเป็น base64 (in-memory) → extractShareCircles({ images })
 */
export async function extractShareCircleFromImagesAction(
  customerId: string,
  month: string,
  paths: string[],
  opts?: { force?: boolean }
): Promise<ActionResult> {
  try {
    const g = await guardExtractInput(customerId, month);
    if (!g.ok) return { ok: false, message: g.message };

    const list = Array.isArray(paths) ? paths.filter((p) => typeof p === "string").slice(0, MAX_IMAGES) : [];
    if (list.length === 0) return { ok: false, message: "กรุณาเลือกรูปวงแชร์ก่อน" };

    const images: ShareCircleImage[] = [];
    const hashes: string[] = [];
    for (const path of list) {
      // ★ path ต้องอยู่ใต้ {tenant}/manual/ ของ tenant นี้ (กันชี้ไฟล์ข้าม tenant)
      if (!path.startsWith(`${g.tenantId}/manual/`)) continue;
      try {
        const { data: blob, error } = await g.service.storage.from(BILLS_BUCKET).download(path);
        if (error || !blob) continue;
        const buf = Buffer.from(await blob.arrayBuffer());
        images.push({ base64: buf.toString("base64"), mime: mimeFromPath(path) });
        hashes.push(createHash("sha256").update(buf).digest("hex")); // hash bytes กันรูปซ้ำ
      } catch {
        // อ่านรูปพลาด → ข้ามรูปนั้น
      }
    }
    if (images.length === 0) return { ok: false, message: "อ่านรูปไม่สำเร็จ กรุณาลองใหม่" };

    // ระดับ 2: กัน "อัปรูปชุดเดิมซ้ำเป๊ะ" — hash รวมของทุกรูป (เรียง) → source_ref
    const sourceRef = `img:${sha8(hashes.sort().join(","))}`;
    if (!opts?.force && (await sourceRefAlreadyUsed(g.service, g.tenantId, customerId, g.month, sourceRef))) {
      return { ok: false, message: "รูปชุดนี้เคยอัปในเดือนนี้แล้ว (กัน 'ซ้ำ') — ถ้าตั้งใจเพิ่มซ้ำ กด 'อัปซ้ำอยู่ดี'" };
    }

    const circles = await extractShareCircles({ images });
    if (circles.length === 0) {
      return {
        ok: false,
        message: "AI ไม่พบวงแชร์ในรูป (หรือยังไม่ได้ตั้งค่า OPENAI_API_KEY) — ลองเพิ่มวงเอง",
      };
    }
    const { added, skipped } = await insertParsedCirclesDedup(
      g.service, g.tenantId, customerId, g.month, circles, sourceRef
    );
    if (added === 0 && skipped === 0) return { ok: false, message: "บันทึกวงไม่สำเร็จ กรุณาลองใหม่" };
    if (added === 0) return { ok: false, message: `⚠️ วงทั้งหมด (${skipped.toLocaleString("th-TH")}) ซ้ำกับที่มีอยู่แล้ว — ไม่เพิ่มซ้ำ` };

    revalidatePath(PATH);
    return { ok: true, message: dedupResultMsg(added, skipped) };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "แยกวงจากรูปไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/** อ่าน customer_id ของ entry (scope tenant) เพื่อตรวจสโคปก่อนแก้/ลบ */
async function loadEntryCustomerId(
  service: ReturnType<typeof createServiceRoleClient>,
  tenantId: string,
  id: string
): Promise<string | null | undefined> {
  const { data } = await service
    .from("share_circle_entries")
    .select("customer_id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return undefined;
  return (data as { customer_id: string | null }).customer_id;
}

/**
 * (b) แก้ไขทุกช่องของวง — บันทึกผ่าน update (สรุปภาษีคิดใหม่หลัง refresh)
 */
export async function updateShareCircleEntryAction(
  id: string,
  fields: ShareCircleFields
): Promise<ActionResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(id)) return { ok: false, message: "ไม่พบวงที่เลือก" };
    const custId = await loadEntryCustomerId(service, ctx.tenantId, id);
    if (custId === undefined) return { ok: false, message: "ไม่พบวง (อาจถูกลบไปแล้ว)" };
    if (!customerInScope(ctx, custId)) {
      return { ok: false, message: "วงของลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }
    const norm = normalizeFields(fields);
    if (!norm.ok) return { ok: false, message: norm.message };

    const { error } = await service
      .from("share_circle_entries")
      .update(norm.row)
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .is("deleted_at", null);
    if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };

    revalidatePath(PATH);
    return { ok: true, message: "บันทึกแล้ว", id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * (c) ลบวง (soft-delete) — คืนค่าให้ client โชว์ปุ่ม "เลิกทำ" (undo)
 */
export async function softDeleteShareCircleEntryAction(id: string): Promise<ActionResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบวงที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const custId = await loadEntryCustomerId(service, ctx.tenantId, id);
    if (custId === undefined) return { ok: false, message: "ไม่พบวง (อาจถูกลบไปแล้ว)" };
    if (!customerInScope(ctx, custId)) {
      return { ok: false, message: "วงของลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }

    const { error } = await service
      .from("share_circle_entries")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .is("deleted_at", null);
    if (error) return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };

    revalidatePath(PATH);
    return { ok: true, message: "ลบวงแล้ว", id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * (d) เลิกทำการลบ (undo) — กู้ entry ที่เพิ่ง soft-delete กลับมา (เคลียร์ deleted_at)
 */
export async function restoreShareCircleEntryAction(id: string): Promise<ActionResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบวงที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    // อ่าน customer_id ของ entry (ไม่กรอง deleted_at เพราะกำลังกู้)
    const { data } = await service
      .from("share_circle_entries")
      .select("customer_id")
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    if (!data) return { ok: false, message: "ไม่พบวง" };
    if (!customerInScope(ctx, (data as { customer_id: string | null }).customer_id)) {
      return { ok: false, message: "วงของลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }

    const { error } = await service
      .from("share_circle_entries")
      .update({ deleted_at: null })
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .not("deleted_at", "is", null);
    if (error) return { ok: false, message: "กู้คืนไม่สำเร็จ" };

    revalidatePath(PATH);
    return { ok: true, message: "กู้คืนวงแล้ว", id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "กู้คืนไม่สำเร็จ" };
  }
}
