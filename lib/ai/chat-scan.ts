import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Chat Analysis Scan/Enqueue (Phase 2) — รวบกลุ่มที่มีข้อความใหม่ "ยังไม่วิเคราะห์"
 *   → enqueue job `chat_analysis` 1 งาน/กลุ่ม (1 window) ให้ chat-worker ทำต่อ
 *   (Phase 1 ยังไม่ enqueue AI — scan นี้เป็นตัวเชื่อม ingest → analysis)
 *
 * debounce: enqueue เฉพาะกลุ่มที่บทสนทนา "นิ่งแล้ว" (ข้อความล่าสุดเก่ากว่า debounce)
 *   หรือมีข้อความค้างเยอะเกิน threshold (ไม่รอ ป้องกัน backlog บวม)
 *   → กันการเรียก AI ถี่ทุกข้อความ (คุมต้นทุน) + ให้ได้บริบทบทสนทนาครบก่อนวิเคราะห์
 *
 * idempotent: ถ้ากลุ่มนั้นมี job chat_analysis ค้างอยู่ (pending/processing) แล้ว → ไม่ enqueue ซ้ำ
 *
 * inject deps (now) เพื่อ test ได้โดยไม่พึ่งเวลาจริง
 */

const DEFAULT_DEBOUNCE_MS = 3 * 60 * 1000; // 3 นาที: ถือว่าบทสนทนานิ่งแล้ว
const FORCE_THRESHOLD = 50; // ค้างเกินนี้ → enqueue เลย ไม่รอ debounce
const SCAN_MESSAGE_PAGE = 2000; // ดึงข้อความค้างต่อรอบ scan (aggregate ใน JS)

export type ChatScanDeps = {
  db: SupabaseClient;
  now?: () => Date;
  debounceMs?: number;
};

export type ChatScanSummary = {
  groups: number; // กลุ่มที่มีข้อความค้าง (พิจารณา)
  enqueued: number; // enqueue job ใหม่
  waiting: number; // ยังไม่ถึง debounce (รอรอบหน้า)
  existed: number; // มี job ค้างอยู่แล้ว (idempotent skip)
  failed: number; // enqueue พัง (isolate ไม่ล้มทั้ง batch)
};

type UnanalyzedRow = {
  chat_group_id: string;
  tenant_id: string;
  sent_at: string | null;
};

type GroupAgg = {
  tenantId: string;
  count: number;
  latestMs: number; // เวลาข้อความล่าสุด (ms)
};

/** true เมื่อกลุ่มนี้มี job chat_analysis ค้างอยู่ (pending/processing) */
async function hasPendingJob(db: SupabaseClient, chatGroupId: string): Promise<boolean> {
  const { data } = await db
    .from("job_queue")
    .select("id")
    .eq("queue", "chat_analysis")
    .in("status", ["pending", "processing"])
    .eq("payload->>chat_group_id", chatGroupId)
    .limit(1)
    .maybeSingle();
  return !!(data as { id?: string } | null)?.id;
}

export async function scanChatAnalysis(deps: ChatScanDeps): Promise<ChatScanSummary> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const nowMs = now.getTime();
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const summary: ChatScanSummary = {
    groups: 0,
    enqueued: 0,
    waiting: 0,
    existed: 0,
    failed: 0,
  };

  // ดึงข้อความที่ยังไม่วิเคราะห์ (page เดียวต่อรอบ scan) แล้ว aggregate ต่อกลุ่มใน JS
  const { data: rows, error } = await db
    .from("chat_messages")
    .select("chat_group_id, tenant_id, sent_at")
    .is("analyzed_at", null)
    .is("deleted_at", null)
    .order("sent_at", { ascending: true })
    .limit(SCAN_MESSAGE_PAGE);

  if (error) return summary;

  const agg = new Map<string, GroupAgg>();
  for (const r of (rows ?? []) as UnanalyzedRow[]) {
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

  for (const [chatGroupId, info] of agg) {
    // debounce: ยังไม่นิ่ง + ยังไม่ถึง threshold → รอรอบหน้า
    const settled = nowMs - info.latestMs >= debounceMs;
    if (!settled && info.count < FORCE_THRESHOLD) {
      summary.waiting += 1;
      continue;
    }

    try {
      if (await hasPendingJob(db, chatGroupId)) {
        summary.existed += 1;
        continue;
      }

      const { error: insErr } = await db.from("job_queue").insert({
        tenant_id: info.tenantId,
        queue: "chat_analysis",
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
