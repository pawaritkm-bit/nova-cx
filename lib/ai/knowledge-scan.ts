import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Knowledge Extract Scan/Enqueue (Phase 1) — pass ใหม่แยกจาก chat-scan เดิม
 *   รวบ "กลุ่ม" ที่มีข้อความยัง "ไม่สกัดความรู้" (knowledge_extracted_at IS NULL) → enqueue `knowledge_extract`
 *
 *   ★ marker คนละคอลัมน์กับ analyzed_at (chat analysis) → เดินอิสระ ไม่ชน/ไม่กระทบของเดิม
 *   ★ เฉพาะ group_kind ∈ ('group','room') — ★ ไม่แตะ 1-1 (group_kind='user' ของ office)
 *   ★ อ่าน group_kind ไม่ได้/ไม่ใช่กลุ่ม → ข้าม (ปลอดภัย: ไม่สกัดจาก 1-1 โดยพลาด)
 *
 * debounce: enqueue เฉพาะกลุ่มที่ "นิ่งแล้ว" หรือค้างเยอะเกิน threshold (กัน backlog บวม)
 * idempotent: มี job knowledge_extract ค้าง (pending/processing) แล้ว → ไม่ enqueue ซ้ำ
 *
 * inject deps (now) เพื่อ test ได้โดยไม่พึ่งเวลาจริง
 */

const DEFAULT_DEBOUNCE_MS = 3 * 60 * 1000;
const FORCE_THRESHOLD = 50;
const SCAN_MESSAGE_PAGE = 2000;

export type KnowledgeScanDeps = {
  db: SupabaseClient;
  now?: () => Date;
  debounceMs?: number;
};

export type KnowledgeScanSummary = {
  groups: number; // กลุ่มที่มีข้อความค้างสกัด (พิจารณา)
  enqueued: number; // enqueue job knowledge_extract ใหม่
  skippedDirect: number; // ข้ามเพราะเป็น 1-1/ไม่ใช่กลุ่ม (กันปน)
  waiting: number; // ยังไม่ถึง debounce (รอรอบหน้า)
  existed: number; // มี job ค้างอยู่แล้ว (idempotent skip)
  failed: number;
};

type UnextractedRow = {
  chat_group_id: string;
  tenant_id: string;
  sent_at: string | null;
};

type GroupAgg = {
  tenantId: string;
  count: number;
  latestMs: number;
};

async function hasPendingKnowledgeJob(db: SupabaseClient, chatGroupId: string): Promise<boolean> {
  const { data } = await db
    .from("job_queue")
    .select("id")
    .eq("queue", "knowledge_extract")
    .in("status", ["pending", "processing"])
    .eq("payload->>chat_group_id", chatGroupId)
    .limit(1)
    .maybeSingle();
  return !!(data as { id?: string } | null)?.id;
}

/** โหลด group_kind ต่อ chat_group_id (best-effort) */
async function loadGroupKinds(db: SupabaseClient, groupIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (groupIds.length === 0) return out;
  const { data } = await db.from("chat_groups").select("id, group_kind").in("id", groupIds);
  for (const g of (data ?? []) as { id: string; group_kind: string }[]) {
    out.set(g.id, g.group_kind);
  }
  return out;
}

export async function scanKnowledgeExtract(deps: KnowledgeScanDeps): Promise<KnowledgeScanSummary> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const nowMs = now.getTime();
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const summary: KnowledgeScanSummary = {
    groups: 0,
    enqueued: 0,
    skippedDirect: 0,
    waiting: 0,
    existed: 0,
    failed: 0,
  };

  // ดึงข้อความที่ยัง "ไม่สกัดความรู้" แล้ว aggregate ต่อกลุ่มใน JS
  const { data: rows, error } = await db
    .from("chat_messages")
    .select("chat_group_id, tenant_id, sent_at")
    .is("knowledge_extracted_at", null)
    .is("deleted_at", null)
    .order("sent_at", { ascending: true })
    .limit(SCAN_MESSAGE_PAGE);

  if (error) return summary;

  const agg = new Map<string, GroupAgg>();
  for (const r of (rows ?? []) as UnextractedRow[]) {
    const t = r.sent_at ? new Date(r.sent_at).getTime() : nowMs;
    const cur = agg.get(r.chat_group_id);
    if (cur) {
      cur.count += 1;
      if (Number.isFinite(t) && t > cur.latestMs) cur.latestMs = t;
    } else {
      agg.set(r.chat_group_id, {
        tenantId: r.tenant_id,
        count: 1,
        latestMs: Number.isFinite(t) ? t : nowMs,
      });
    }
  }

  summary.groups = agg.size;

  const kinds = await loadGroupKinds(db, [...agg.keys()]);

  for (const [chatGroupId, info] of agg) {
    // ★ กันปน: เฉพาะ group/room — 1-1 (user)/อ่านไม่ได้ = ข้าม (ไม่สกัดความรู้จาก 1-1)
    const kind = kinds.get(chatGroupId);
    if (kind !== "group" && kind !== "room") {
      summary.skippedDirect += 1;
      continue;
    }

    // debounce: ยังไม่นิ่ง + ยังไม่ถึง threshold → รอรอบหน้า
    const settled = nowMs - info.latestMs >= debounceMs;
    if (!settled && info.count < FORCE_THRESHOLD) {
      summary.waiting += 1;
      continue;
    }

    try {
      if (await hasPendingKnowledgeJob(db, chatGroupId)) {
        summary.existed += 1;
        continue;
      }

      const { error: insErr } = await db.from("job_queue").insert({
        tenant_id: info.tenantId,
        queue: "knowledge_extract",
        payload: { chat_group_id: chatGroupId },
      });
      if (insErr) {
        // ★ 23505 = ชน partial unique index (มี job ค้างอยู่แล้ว) → idempotent skip ไม่ใช่ error
        if ((insErr as { code?: string }).code === "23505") {
          summary.existed += 1;
        } else {
          summary.failed += 1;
        }
      } else {
        summary.enqueued += 1;
      }
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}
