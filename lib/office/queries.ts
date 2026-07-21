/**
 * Office CX (ประเมินสำนักงาน) — data layer สำหรับหน้า /chat-audit/office
 *
 * ★ แยกจาก flow "ประเมินนักบัญชีรายคน" เด็ดขาด:
 *   - อ่าน "เฉพาะ" office_inbound_analysis (ผลวิเคราะห์แชต 1-1 ฝั่งลูกค้า)
 *     + chat_groups ที่ group_kind='user' (นับจำนวนบทสนทนา 1-1 + ชื่อลูกค้า)
 *   - ★ ห้ามแตะ conversation_cases / ai_chat_analysis / accountant_evaluations / risk_alerts
 *   - 1-1 ไม่มีนักบัญชีรายคน (webhook เห็นแต่ข้อความขาเข้าจากลูกค้า) → ไม่โยงพนักงาน
 *
 * ★ ความปลอดภัย:
 *   - ทุก query กรอง tenant_id จาก session (ส่งเข้ามาเป็นพารามิเตอร์ ห้ามรับจาก client)
 *     + ใช้ scoped client (RLS tenant_isolation) เป็นชั้นกันซ้ำ
 *   - decrypt ชื่อลูกค้า (display_name_enc) "ฝั่ง server เท่านั้น" แบบ best-effort
 *     ไม่ส่ง ciphertext/PII ดิบไป client
 *
 * ★ ฟังก์ชัน aggregate (summarize/aggregateTopics/countSentiments/selectAttention)
 *   เป็นฟังก์ชันบริสุทธิ์ (ไม่แตะ DB) → unit test ได้แน่นอน
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptField, hasEncKey } from "@/lib/crypto/field";

type DB = SupabaseClient;

/** เพดานแถวต่อ query (กันดึงเยอะเกินจนหน้าอืด) */
const OFFICE_LIMIT = 2000;
/** จำนวนรายการสูงสุดที่ส่งไป render (attention/recent) */
const ATTENTION_CAP = 100;
const RECENT_CAP = 20;

export type OfficeSentiment = "positive" | "neutral" | "negative";
export type OfficeUrgency = "critical" | "high" | "medium" | "low";

/** คอลัมน์ที่หน้าใช้จริงจาก office_inbound_analysis (ไม่ดึงเกินจำเป็น) */
const OFFICE_COLS =
  "id, chat_group_id, window_start, window_end, message_count, summary, sentiment, urgency, topics, is_complaint, needs_attention, created_at";

/** แถวดิบจาก office_inbound_analysis (เท่าที่หน้าใช้) */
export type OfficeAnalysisRow = {
  id: string;
  chat_group_id: string;
  window_start: string | null;
  window_end: string | null;
  message_count: number;
  summary: string | null;
  sentiment: OfficeSentiment | string | null;
  urgency: OfficeUrgency | string | null;
  topics: unknown; // jsonb — คาดว่าเป็น array ของ string
  is_complaint: boolean;
  needs_attention: boolean;
  created_at: string;
};

export type SentimentCounts = { positive: number; neutral: number; negative: number };
export type TopicCount = { topic: string; count: number };

/** รายการบทสนทนาที่ "ต้องให้เจ้าหน้าที่ดูด่วน" (พร้อมชื่อลูกค้าที่ถอดแล้ว) */
export type OfficeAttentionItem = {
  id: string;
  chatGroupId: string;
  customerLabel: string;
  summary: string | null;
  sentiment: OfficeSentiment | string | null;
  urgency: OfficeUrgency | string | null;
  isComplaint: boolean;
  at: string | null;
};

/** รายการบทสนทนา 1-1 ล่าสุด (สรุปสั้น) */
export type OfficeRecentItem = {
  id: string;
  chatGroupId: string;
  customerLabel: string;
  summary: string | null;
  sentiment: OfficeSentiment | string | null;
  messageCount: number;
  at: string | null;
};

export type OfficeDashboard = {
  /** จำนวนบทสนทนา 1-1 (chat_groups group_kind='user') */
  conversationCount: number;
  /** จำนวนข้อความลูกค้าขาเข้า (ผลรวม message_count ในช่วงเวลา) */
  inboundMessageCount: number;
  /** จำนวนบทสนทนาที่ต้องดูด่วน (needs_attention=true) ในช่วงเวลา */
  needsAttentionCount: number;
  /** จำนวนบทสนทนาที่เป็นการร้องเรียน (is_complaint=true) ในช่วงเวลา */
  complaintCount: number;
  /** จำนวนผลวิเคราะห์ทั้งหมดในช่วงเวลา (ใช้คิดสัดส่วน) */
  analyzedCount: number;
  sentiment: SentimentCounts;
  topTopics: TopicCount[];
  attention: OfficeAttentionItem[];
  recent: OfficeRecentItem[];
};

// ---------------------------------------------------------------------
// ฟังก์ชัน aggregate (บริสุทธิ์ — ไม่แตะ DB)
// ---------------------------------------------------------------------

/** ผลรวมข้อความขาเข้า + จำนวน needs_attention/complaint */
export function summarizeOffice(rows: OfficeAnalysisRow[]): {
  inboundMessageCount: number;
  needsAttentionCount: number;
  complaintCount: number;
  analyzedCount: number;
} {
  let inbound = 0;
  let attn = 0;
  let complaint = 0;
  for (const r of rows) {
    inbound += Number.isFinite(r.message_count) ? r.message_count : 0;
    if (r.needs_attention) attn += 1;
    if (r.is_complaint) complaint += 1;
  }
  return {
    inboundMessageCount: inbound,
    needsAttentionCount: attn,
    complaintCount: complaint,
    analyzedCount: rows.length,
  };
}

/** นับสัดส่วนอารมณ์ลูกค้า (ข้ามค่า null/ไม่รู้จัก) */
export function countSentiments(rows: OfficeAnalysisRow[]): SentimentCounts {
  const c: SentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  for (const r of rows) {
    if (r.sentiment === "positive" || r.sentiment === "neutral" || r.sentiment === "negative") {
      c[r.sentiment] += 1;
    }
  }
  return c;
}

/** แปลง topics(jsonb) → array ของ string ที่สะอาด (รองรับทั้ง string ล้วนและ object) */
function normalizeTopics(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const el of raw) {
    let s: string | null = null;
    if (typeof el === "string") {
      s = el;
    } else if (el && typeof el === "object") {
      const o = el as Record<string, unknown>;
      if (typeof o.topic === "string") s = o.topic;
      else if (typeof o.label === "string") s = o.label;
      else if (typeof o.name === "string") s = o.name;
    }
    if (s) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * นับความถี่หัวข้อที่ลูกค้าพูดถึง เรียงมาก→น้อย (top N)
 *   - รวมหัวข้อแบบ case-insensitive (แต่คงรูปแบบที่พบครั้งแรกไว้แสดง)
 */
export function aggregateTopics(rows: OfficeAnalysisRow[], limit = 10): TopicCount[] {
  const counts = new Map<string, { display: string; count: number }>();
  for (const r of rows) {
    for (const t of normalizeTopics(r.topics)) {
      const key = t.toLowerCase();
      const cur = counts.get(key);
      if (cur) cur.count += 1;
      else counts.set(key, { display: t, count: 1 });
    }
  }
  return [...counts.values()]
    .map((v) => ({ topic: v.display, count: v.count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic, "th"))
    .slice(0, limit);
}

const URGENCY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** เวลาอ้างอิงของแถว (window_end ถ้ามี ไม่งั้น created_at) */
function rowTimeMs(r: OfficeAnalysisRow): number {
  const t = r.window_end ?? r.created_at;
  const ms = t ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * คัดบทสนทนาที่ต้องดูด่วน (needs_attention หรือ is_complaint)
 *   เรียง: urgency critical→low ก่อน แล้วเวลาใหม่→เก่า
 */
export function selectAttention(rows: OfficeAnalysisRow[]): OfficeAnalysisRow[] {
  return rows
    .filter((r) => r.needs_attention || r.is_complaint)
    .sort((a, b) => {
      const ra = URGENCY_RANK[a.urgency ?? ""] ?? 4;
      const rb = URGENCY_RANK[b.urgency ?? ""] ?? 4;
      if (ra !== rb) return ra - rb;
      return rowTimeMs(b) - rowTimeMs(a);
    });
}

// ---------------------------------------------------------------------
// decrypt ชื่อลูกค้า (best-effort ฝั่ง server)
// ---------------------------------------------------------------------
/** ถอดชื่อแบบ best-effort — ไม่มีคีย์/ถอดไม่ได้ = null (ไม่ทำให้ทั้งหน้าใช้ไม่ได้) */
function safeDecrypt(enc: string | null | undefined): string | null {
  if (!enc || !hasEncKey()) return null;
  try {
    return decryptField(enc);
  } catch {
    return null;
  }
}

/** ป้ายชื่อลูกค้าเมื่อไม่มีชื่อจริง (ไม่ leak ref/ciphertext) */
const CUSTOMER_FALLBACK = "ลูกค้า (1-1)";

// ---------------------------------------------------------------------
// DB: ประกอบข้อมูลหน้า dashboard
// ---------------------------------------------------------------------

/**
 * ดึง + ประกอบข้อมูลหน้า "ประเมินสำนักงาน"
 *   - tenantId มาจาก session (guard) เท่านั้น
 *   - sinceMs = ตัดช่วงเวลา (null = ทั้งหมด) กรองที่ created_at
 */
export async function getOfficeDashboard(
  db: DB,
  tenantId: string,
  opts: { sinceMs?: number | null } = {}
): Promise<OfficeDashboard> {
  const sinceIso =
    opts.sinceMs && Number.isFinite(opts.sinceMs) ? new Date(opts.sinceMs).toISOString() : null;

  // 1) ผลวิเคราะห์ 1-1 ในช่วงเวลา (tenant + soft-delete + time window)
  let analysisQuery = db
    .from("office_inbound_analysis")
    .select(OFFICE_COLS)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(OFFICE_LIMIT);
  if (sinceIso) analysisQuery = analysisQuery.gte("created_at", sinceIso);

  // 2) บทสนทนา 1-1 ทั้งหมด (chat_groups group_kind='user') → นับจำนวน + map ชื่อ
  const groupQuery = db
    .from("chat_groups")
    .select("id, display_name_enc")
    .eq("tenant_id", tenantId)
    .eq("group_kind", "user")
    .is("deleted_at", null)
    .limit(OFFICE_LIMIT);

  const [analysisRes, groupRes] = await Promise.all([analysisQuery, groupQuery]);

  const rows = ((analysisRes.data ?? []) as OfficeAnalysisRow[]).filter(Boolean);
  const groups = (groupRes.data ?? []) as { id: string; display_name_enc: string | null }[];

  // map ชื่อลูกค้าต่อบทสนทนา (decrypt ฝั่ง server)
  const labelByGroup = new Map<string, string>();
  for (const g of groups) {
    const name = safeDecrypt(g.display_name_enc);
    labelByGroup.set(g.id, name || CUSTOMER_FALLBACK);
  }
  const labelOf = (groupId: string): string => labelByGroup.get(groupId) ?? CUSTOMER_FALLBACK;

  const summary = summarizeOffice(rows);
  const sentiment = countSentiments(rows);
  const topTopics = aggregateTopics(rows, 10);

  const attention: OfficeAttentionItem[] = selectAttention(rows)
    .slice(0, ATTENTION_CAP)
    .map((r) => ({
      id: r.id,
      chatGroupId: r.chat_group_id,
      customerLabel: labelOf(r.chat_group_id),
      summary: r.summary,
      sentiment: r.sentiment,
      urgency: r.urgency,
      isComplaint: r.is_complaint,
      at: r.window_end ?? r.created_at,
    }));

  // recent: rows เรียง created_at desc มาแล้วจาก query
  const recent: OfficeRecentItem[] = rows.slice(0, RECENT_CAP).map((r) => ({
    id: r.id,
    chatGroupId: r.chat_group_id,
    customerLabel: labelOf(r.chat_group_id),
    summary: r.summary,
    sentiment: r.sentiment,
    messageCount: r.message_count,
    at: r.window_end ?? r.created_at,
  }));

  return {
    conversationCount: groups.length,
    inboundMessageCount: summary.inboundMessageCount,
    needsAttentionCount: summary.needsAttentionCount,
    complaintCount: summary.complaintCount,
    analyzedCount: summary.analyzedCount,
    sentiment,
    topTopics,
    attention,
    recent,
  };
}
