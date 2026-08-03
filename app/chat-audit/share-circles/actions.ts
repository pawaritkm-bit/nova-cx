"use server";

/**
 * Server actions ของหน้า "วงแชร์" (/chat-audit/share-circles)
 *
 * flow ความปลอดภัย (ยึดมาตรฐานเดียวกับหน้าลงบันทึกบัญชี — ห้ามเชื่อ scope จาก client):
 *   1) resolve สิทธิ์จาก session จริง → requireAccountingAccess (สิทธิ์เดียวกับหน้าลงบัญชี)
 *      + ได้ tenantId จาก session (ไม่เชื่อค่าจาก client)
 *   2) validate อินพุตทุกตัว (uuid / date / ตัวเลข) ก่อนเขียน
 *   3) เขียนผ่าน service-role client + tenantId จาก session
 *   4) guard สโคปลูกค้า (customerInScope) ก่อน insert/soft-delete ทุกครั้ง
 *   5) revalidatePath('/chat-audit/share-circles')
 *
 * ★ PDPA: ไม่ log ชื่อวง/ชื่อสมาชิก/ตัวเลข (ไม่มี console.* ที่ log ข้อมูลอ่อนไหวที่นี่)
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  customerInScope,
  AccountingAuthError,
} from "@/lib/accounting/access";
import { parseShareCircle, type ParsedShareCircle } from "@/lib/ai/share-circle";

const PATH = "/chat-audit/share-circles";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ตัด/trim ข้อความ (กัน payload ใหญ่) — คืน null ถ้าว่าง */
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

/** ตัวเลข ≥ 0 หรือ null (จำกัดช่วงกันค่าเวอร์) — ค่าว่าง/พัง = null */
function asNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 1_000_000_000);
}

/** จำนวนเต็ม ≥ 0 หรือ null */
function asIntOrNull(v: unknown): number | null {
  const n = asNumberOrNull(v);
  return n === null ? null : Math.round(n);
}

/** ผลลัพธ์มาตรฐานที่ client ใช้แสดง toast/inline (ไม่หลุด internal) */
export type ActionResult = {
  ok: boolean;
  message: string;
  id?: string;
};

// ---------------------------------------------------------------------
// input types (รับจาก ShareCircleCreator ฝั่ง client — plain object)
// ---------------------------------------------------------------------

export type HandInput = {
  hand_no: number;
  member_name?: string | null;
  send_amount?: number | null;
  bid_amount?: number | null;
  is_organizer?: boolean;
};

export type SaveShareCircleInput = {
  customerId: string;
  name: string;
  principal?: number | null;
  num_hands?: number | null;
  fee_per_hand?: number | null;
  period_note?: string | null;
  start_date?: string | null;
  source_text?: string | null;
  hands: HandInput[];
};

export type ParseShareCircleInput = {
  customerId?: string | null;
  text?: string;
  imageBase64?: string;
  mime?: string;
};

// ---------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------

/**
 * (a) ให้ AI แยกลิสต์วงแชร์ → คืน parsed ให้ client ตรวจ/แก้ (ยังไม่บันทึก)
 *   ★ guard สิทธิ์ก่อน (กันคนนอกยิง action) — ไม่ต้อง guard scope เพราะยังไม่เขียน DB
 *   ★ จำกัดขนาด text/รูป กัน payload ใหญ่
 */
export async function parseShareCircleAction(
  input: ParseShareCircleInput
): Promise<{ ok: true; parsed: ParsedShareCircle } | { ok: false; message: string }> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    await requireAccountingAccess(authed, service); // throw ถ้าไม่มีสิทธิ์

    const text = clampText(input.text, 20_000) ?? undefined;
    const imageBase64 =
      typeof input.imageBase64 === "string" && input.imageBase64.length > 0
        ? input.imageBase64
        : undefined;
    if (!text && !imageBase64) {
      return { ok: false, message: "กรุณาวางข้อความหรือแนบรูปลิสต์วงแชร์ก่อน" };
    }
    // รูป base64 ~13MB (≈ 10MB ไฟล์จริง) — กัน payload ใหญ่เกิน
    if (imageBase64 && imageBase64.length > 13_000_000) {
      return { ok: false, message: "รูปใหญ่เกินไป กรุณาใช้รูปที่เล็กลง" };
    }

    const parsed = await parseShareCircle({
      text,
      imageBase64,
      mime: typeof input.mime === "string" ? input.mime : undefined,
    });
    if (!parsed) {
      return {
        ok: false,
        message: "AI แยกวงไม่สำเร็จ (อาจยังไม่ได้ตั้งค่า OPENAI_API_KEY หรืออ่านลิสต์ไม่ออก) — ลองคีย์เอง",
      };
    }
    return { ok: true, parsed };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "แยกวงไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * (b) บันทึกวงแชร์ + มือทั้งหมด → insert share_circles + share_circle_hands
 *   ★ guard สโคปลูกค้า (customerInScope) — นักบัญชีบันทึกได้เฉพาะลูกค้าที่ตัวเองดูแล
 *   ★ tenantId + write ทั้งหมดผ่าน service-role (ไม่เชื่อ client)
 *   ★ ถ้า insert มือล้ม → ลบวงที่เพิ่งสร้างกันข้อมูลค้าง (best-effort)
 */
export async function saveShareCircleAction(
  input: SaveShareCircleInput
): Promise<ActionResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) {
      return { ok: false, message: "กรุณาเลือกลูกค้า (ท้าวแชร์) ก่อนบันทึก" };
    }
    // ★ สโคปนักบัญชี: บันทึกได้เฉพาะลูกค้าที่ตัวเองดูแล (admin/lead ผ่านทุกกรณี)
    if (!customerInScope(ctx, input.customerId)) {
      return { ok: false, message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }

    const name = clampText(input.name, 200);
    if (!name) {
      return { ok: false, message: "กรุณาระบุชื่อวง" };
    }

    // 1) insert หัววง
    const { data: circleRow, error: circleErr } = await service
      .from("share_circles")
      .insert({
        tenant_id: ctx.tenantId,
        customer_id: input.customerId,
        name,
        principal: asNumberOrNull(input.principal),
        num_hands: asIntOrNull(input.num_hands),
        fee_per_hand: asNumberOrNull(input.fee_per_hand),
        period_note: clampText(input.period_note, 300),
        start_date: asDate(input.start_date),
        source_text: clampText(input.source_text, 20_000),
        status: "active",
      })
      .select("id")
      .maybeSingle();
    if (circleErr || !circleRow) {
      return { ok: false, message: "บันทึกวงไม่สำเร็จ กรุณาลองใหม่" };
    }
    const circleId = (circleRow as { id: string }).id;

    // 2) insert มือ (re-validate ทุกแถวฝั่ง server) — cap 500 มือ/วง
    const hands = Array.isArray(input.hands) ? input.hands.slice(0, 500) : [];
    if (hands.length > 0) {
      const rows = hands.map((h) => ({
        circle_id: circleId,
        tenant_id: ctx.tenantId,
        hand_no: asIntOrNull(h.hand_no),
        member_name: clampText(h.member_name, 200),
        send_amount: asNumberOrNull(h.send_amount),
        bid_amount: asNumberOrNull(h.bid_amount),
        is_organizer: h.is_organizer === true,
      }));
      const { error: handErr } = await service.from("share_circle_hands").insert(rows);
      if (handErr) {
        // ลบวงที่เพิ่งสร้างกันข้อมูลค้าง (soft-delete)
        await service
          .from("share_circles")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", circleId)
          .eq("tenant_id", ctx.tenantId);
        return { ok: false, message: "บันทึกรายชื่อมือไม่สำเร็จ กรุณาลองใหม่" };
      }
    }

    revalidatePath(PATH);
    return { ok: true, message: "บันทึกวงแชร์แล้ว", id: circleId };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกวงไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * (c) ลบวงแชร์ (soft-delete) — guard สโคปผ่าน customer_id ของวง
 *   ★ อ่านลูกค้าของวงก่อน (scope tenant) → ตรวจ customerInScope → set deleted_at
 */
export async function deleteShareCircleAction(id: string): Promise<ActionResult> {
  if (!isUuid(id)) return { ok: false, message: "ไม่พบวงที่เลือก" };
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    // อ่านลูกค้าของวง (scope tenant) เพื่อตรวจสโคปก่อนลบ
    const { data: row } = await service
      .from("share_circles")
      .select("customer_id")
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!row) return { ok: false, message: "ไม่พบวง (อาจถูกลบไปแล้ว)" };
    // ★ สโคปนักบัญชี: ลบได้เฉพาะลูกค้าที่ตัวเองดูแล (admin/lead ผ่าน)
    if (!customerInScope(ctx, (row as { customer_id: string | null }).customer_id)) {
      return { ok: false, message: "วงของลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }

    const { error } = await service
      .from("share_circles")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .is("deleted_at", null);
    if (error) return { ok: false, message: "ลบวงไม่สำเร็จ กรุณาลองใหม่" };

    revalidatePath(PATH);
    return { ok: true, message: "ลบวงแล้ว", id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "ลบวงไม่สำเร็จ กรุณาลองใหม่" };
  }
}
