/**
 * วงแชร์ (share_circles + share_circle_hands) — data layer (อ่าน) สำหรับหน้า /chat-audit/share-circles
 *
 * ★ pure: รับ SupabaseClient + tenantId เข้ามา (tenantId มาจาก session เท่านั้น ห้ามรับจาก client)
 * ★ กรอง deleted_at is null (soft-delete) ทุก query
 * ★ PDPA: ไม่ log ชื่อวง/ชื่อสมาชิก/ตัวเลข
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

/** เพดานแถวต่อ query (กันดึงเยอะเกิน) */
const CIRCLES_LIMIT = 2000;
const HANDS_LIMIT = 1000;

/** 1 วงแชร์ (หัววง) + จำนวนมือ */
export type ShareCircle = {
  id: string;
  tenantId: string;
  customerId: string;
  name: string;
  /** ต้น (เงินต้น/มือ) · null = ไม่ระบุ */
  principal: number | null;
  /** จำนวนมือ · null = ไม่ระบุ */
  numHands: number | null;
  /** ค่าดูแล/มือ · null = ไม่ระบุ */
  feePerHand: number | null;
  periodNote: string | null;
  /** วันเริ่มวง YYYY-MM-DD · null = ไม่ระบุ */
  startDate: string | null;
  status: string;
  createdAt: string;
  /** จำนวนมือที่บันทึกไว้จริง (นับจาก share_circle_hands) */
  handCount: number;
};

/** 1 มือ (สมาชิก) ในวง */
export type ShareCircleHand = {
  id: string;
  circleId: string;
  handNo: number | null;
  memberName: string | null;
  sendAmount: number | null;
  bidAmount: number | null;
  isOrganizer: boolean;
  note: string | null;
};

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

/** numeric จาก DB มาเป็น string → number | null (ค่าว่าง/พัง = null) */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

type RawCircle = {
  id: string;
  tenant_id: string;
  customer_id: string;
  name: string;
  principal: number | string | null;
  num_hands: number | null;
  fee_per_hand: number | string | null;
  period_note: string | null;
  start_date: string | null;
  status: string;
  created_at: string;
};

type RawHand = {
  id: string;
  circle_id: string;
  hand_no: number | null;
  member_name: string | null;
  send_amount: number | string | null;
  bid_amount: number | string | null;
  is_organizer: boolean;
  note: string | null;
};

function mapHand(r: RawHand): ShareCircleHand {
  return {
    id: r.id,
    circleId: r.circle_id,
    handNo: r.hand_no,
    memberName: r.member_name,
    sendAmount: numOrNull(r.send_amount),
    bidAmount: numOrNull(r.bid_amount),
    isOrganizer: !!r.is_organizer,
    note: r.note,
  };
}

// ---------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------

/**
 * ดึงวงแชร์ (ยังไม่ลบ) ของ tenant — เรียง created_at desc + นับจำนวนมือแต่ละวง
 *   - customerId (optional) = กรองเฉพาะวงของลูกค้ารายนั้น
 */
export async function listShareCircles(
  db: DB,
  tenantId: string,
  customerId?: string
): Promise<ShareCircle[]> {
  let q = db
    .from("share_circles")
    .select(
      "id, tenant_id, customer_id, name, principal, num_hands, fee_per_hand, period_note, start_date, status, created_at"
    )
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(CIRCLES_LIMIT);

  if (customerId) q = q.eq("customer_id", customerId);

  const { data, error } = await q;
  if (error) {
    console.warn(`[share-circles] list error code=${(error as { code?: string }).code ?? "?"}`);
    throw error;
  }
  const rows = (data ?? []) as unknown as RawCircle[];
  if (rows.length === 0) return [];

  // นับจำนวนมือของแต่ละวง (query เดียว แล้วรวมฝั่ง app)
  const circleIds = rows.map((r) => r.id);
  const handCountByCircle = new Map<string, number>();
  const { data: handRows } = await db
    .from("share_circle_hands")
    .select("circle_id")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .in("circle_id", circleIds)
    .limit(CIRCLES_LIMIT * 50);
  for (const h of (handRows ?? []) as { circle_id: string }[]) {
    handCountByCircle.set(h.circle_id, (handCountByCircle.get(h.circle_id) ?? 0) + 1);
  }

  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    name: r.name,
    principal: numOrNull(r.principal),
    numHands: r.num_hands,
    feePerHand: numOrNull(r.fee_per_hand),
    periodNote: r.period_note,
    startDate: r.start_date,
    status: r.status,
    createdAt: r.created_at,
    handCount: handCountByCircle.get(r.id) ?? 0,
  }));
}

/**
 * ดึงวง 1 วง + มือทั้งหมด (เรียง hand_no) — คืน null ถ้าไม่พบ/ถูกลบ
 */
export async function getShareCircle(
  db: DB,
  tenantId: string,
  id: string
): Promise<{ circle: ShareCircle; hands: ShareCircleHand[] } | null> {
  const { data, error } = await db
    .from("share_circles")
    .select(
      "id, tenant_id, customer_id, name, principal, num_hands, fee_per_hand, period_note, start_date, status, created_at"
    )
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.warn(`[share-circles] get error code=${(error as { code?: string }).code ?? "?"}`);
    throw error;
  }
  if (!data) return null;
  const r = data as unknown as RawCircle;

  const { data: handData } = await db
    .from("share_circle_hands")
    .select("id, circle_id, hand_no, member_name, send_amount, bid_amount, is_organizer, note")
    .eq("tenant_id", tenantId)
    .eq("circle_id", id)
    .is("deleted_at", null)
    .order("hand_no", { ascending: true, nullsFirst: false })
    .limit(HANDS_LIMIT);
  const hands = ((handData ?? []) as unknown as RawHand[]).map(mapHand);

  const circle: ShareCircle = {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    name: r.name,
    principal: numOrNull(r.principal),
    numHands: r.num_hands,
    feePerHand: numOrNull(r.fee_per_hand),
    periodNote: r.period_note,
    startDate: r.start_date,
    status: r.status,
    createdAt: r.created_at,
    handCount: hands.length,
  };
  return { circle, hands };
}
