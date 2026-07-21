/**
 * Reply Knowledge — data layer สำหรับหน้า /chat-audit/knowledge (Phase 1)
 *
 * ★ แยกจาก flow ประเมินนักบัญชี/office เด็ดขาด:
 *   - อ่าน "เฉพาะ" reply_knowledge (คู่ถาม-ตอบที่สกัดจากแชตกลุ่ม)
 *   - ★ ห้ามแตะ ai_chat_analysis / office_inbound_analysis / conversation_cases / accountant_evaluations
 *
 * ★ ความปลอดภัย:
 *   - ทุก query กรอง tenant_id จาก session (ส่งเข้ามาเป็นพารามิเตอร์ ห้ามรับจาก client)
 *     + scoped client (RLS tenant_isolation) เป็นชั้นกันซ้ำ
 *   - decrypt gist (question/answer) "ฝั่ง server เท่านั้น" แบบ best-effort — ไม่ส่ง ciphertext ไป client
 *
 * ★ ฟังก์ชัน aggregate (countByCategory) เป็นฟังก์ชันบริสุทธิ์ (ไม่แตะ DB) → unit test ได้
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptField, hasEncKey } from "@/lib/crypto/field";

type DB = SupabaseClient;

const KNOWLEDGE_LIMIT = 2000;
const ITEMS_CAP = 200;

export type KnowledgeStatus = "new" | "approved" | "rejected";
export const KNOWLEDGE_STATUSES: readonly KnowledgeStatus[] = ["new", "approved", "rejected"] as const;

/** คอลัมน์ที่หน้าใช้จริง (ไม่ดึงเกินจำเป็น) */
const KNOWLEDGE_COLS =
  "id, category, question_gist_enc, answer_gist_enc, staff_role, confidence, status, blocked_reason, validated, created_at";

/** แถวดิบจาก reply_knowledge (เท่าที่หน้าใช้) */
export type KnowledgeRow = {
  id: string;
  category: string | null;
  question_gist_enc: string | null;
  answer_gist_enc: string | null;
  staff_role: string | null;
  confidence: number | null;
  status: KnowledgeStatus | string;
  blocked_reason: string | null;
  validated: boolean;
  created_at: string;
};

export type CategoryCount = { category: string; count: number };

/** รายการความรู้ 1 คู่ (decrypt แล้ว พร้อม render) */
export type KnowledgeItem = {
  id: string;
  category: string;
  question: string | null;
  answer: string | null;
  staffRole: string | null;
  confidence: number | null;
  status: KnowledgeStatus | string;
  blockedReason: string | null;
  validated: boolean;
  at: string;
};

export type KnowledgeList = {
  /** จำนวนต่อหมวด (ทุกสถานะในขอบเขต tenant) เรียงมาก→น้อย */
  categories: CategoryCount[];
  /** จำนวนรวมทั้งหมด (ทุกหมวด/สถานะ) */
  total: number;
  /** รายการที่ผ่าน filter (decrypt แล้ว) */
  items: KnowledgeItem[];
  categoryFilter: string | null;
  statusFilter: KnowledgeStatus | null;
};

// ---------------------------------------------------------------------
// aggregate (บริสุทธิ์ — ไม่แตะ DB)
// ---------------------------------------------------------------------

const UNCATEGORIZED = "ไม่ระบุหมวด";

/** นับจำนวนต่อหมวด เรียงมาก→น้อย (หมวดว่าง → "ไม่ระบุหมวด") */
export function countByCategory(rows: Pick<KnowledgeRow, "category">[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = (r.category ?? "").trim() || UNCATEGORIZED;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category, "th"));
}

// ---------------------------------------------------------------------
// decrypt gist (best-effort ฝั่ง server)
// ---------------------------------------------------------------------
function safeDecrypt(enc: string | null | undefined): string | null {
  if (!enc || !hasEncKey()) return null;
  try {
    return decryptField(enc);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// DB: ประกอบข้อมูลหน้า
// ---------------------------------------------------------------------

/**
 * ดึง + ประกอบข้อมูลหน้า "คลังคำตอบ AI"
 *   - tenantId มาจาก session (guard) เท่านั้น
 *   - filter หมวด (category) + สถานะ (status) ทำหลังนับหมวดจากชุดเต็ม เพื่อให้ตัวนับหมวดคงที่
 */
export async function getKnowledgeList(
  db: DB,
  tenantId: string,
  opts: { category?: string | null; status?: KnowledgeStatus | null } = {}
): Promise<KnowledgeList> {
  const categoryFilter = opts.category && opts.category.trim() ? opts.category.trim() : null;
  const statusFilter =
    opts.status && KNOWLEDGE_STATUSES.includes(opts.status) ? opts.status : null;

  const { data } = await db
    .from("reply_knowledge")
    .select(KNOWLEDGE_COLS)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(KNOWLEDGE_LIMIT);

  const rows = ((data ?? []) as KnowledgeRow[]).filter(Boolean);

  // นับหมวดจากชุดเต็ม (คงที่ไม่ว่าจะ filter อะไร)
  const categories = countByCategory(rows);

  // filter ตามหมวด/สถานะ
  const filtered = rows.filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (categoryFilter) {
      const cat = (r.category ?? "").trim() || UNCATEGORIZED;
      if (cat !== categoryFilter) return false;
    }
    return true;
  });

  const items: KnowledgeItem[] = filtered.slice(0, ITEMS_CAP).map((r) => ({
    id: r.id,
    category: (r.category ?? "").trim() || UNCATEGORIZED,
    question: safeDecrypt(r.question_gist_enc),
    answer: safeDecrypt(r.answer_gist_enc),
    staffRole: r.staff_role,
    confidence: r.confidence,
    status: r.status,
    blockedReason: r.blocked_reason,
    validated: r.validated,
    at: r.created_at,
  }));

  return {
    categories,
    total: rows.length,
    items,
    categoryFilter,
    statusFilter,
  };
}

/**
 * อัปเดตสถานะรายการความรู้ (อนุมัติ/ตัดออก) — ★ กรอง tenant_id จาก session เสมอ
 *   คืนจำนวนแถวที่อัปเดต (0 = ไม่พบ/ไม่ใช่ของ tenant นี้)
 */
export async function updateKnowledgeStatus(
  db: DB,
  tenantId: string,
  id: string,
  status: KnowledgeStatus
): Promise<number> {
  const { data, error } = await db
    .from("reply_knowledge")
    .update({ status })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}
