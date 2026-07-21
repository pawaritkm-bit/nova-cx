import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Chat Analysis Scan/Enqueue (Phase 2 + Phase A) — รวบกลุ่ม/บทสนทนาที่มีข้อความใหม่ "ยังไม่วิเคราะห์"
 *   → routing ตาม group_kind (กันปนเปื้อนสองสาย):
 *       group/room (group_kind != 'user') → enqueue `chat_analysis` (per-accountant, chat-worker)
 *       1-1        (group_kind = 'user')   → enqueue `office_inbound` (office-worker, ฝั่งลูกค้า)
 *   ★ default = chat_analysis เมื่ออ่าน group_kind ไม่ได้ (ปลอดภัย: ไม่ปล่อยกลุ่มจริงหลุด)
 *
 * debounce: enqueue เฉพาะบทสนทนาที่ "นิ่งแล้ว" (ข้อความล่าสุดเก่ากว่า debounce)
 *   หรือมีข้อความค้างเยอะเกิน threshold (ไม่รอ ป้องกัน backlog บวม)
 *
 * idempotent: ถ้ามี job ค้างอยู่ (pending/processing) ใน queue ที่ตรงกันแล้ว → ไม่ enqueue ซ้ำ
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
  groups: number; // กลุ่ม/บทสนทนาที่มีข้อความค้าง (พิจารณา)
  enqueued: number; // enqueue job chat_analysis ใหม่ (group/room)
  enqueuedOffice: number; // enqueue job office_inbound ใหม่ (1-1)
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

/** true เมื่อบทสนทนานี้มี job (queue ที่ระบุ) ค้างอยู่ (pending/processing) */
async function hasPendingJob(
  db: SupabaseClient,
  queue: string,
  chatGroupId: string
): Promise<boolean> {
  const { data } = await db
    .from("job_queue")
    .select("id")
    .eq("queue", queue)
    .in("status", ["pending", "processing"])
    .eq("payload->>chat_group_id", chatGroupId)
    .limit(1)
    .maybeSingle();
  return !!(data as { id?: string } | null)?.id;
}

/** โหลด group_kind ต่อ chat_group_id (best-effort) — คืน map; อ่านไม่ได้ = ว่าง (default group) */
async function loadGroupKinds(
  db: SupabaseClient,
  groupIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (groupIds.length === 0) return out;
  const { data } = await db
    .from("chat_groups")
    .select("id, group_kind")
    .in("id", groupIds);
  for (const g of (data ?? []) as { id: string; group_kind: string }[]) {
    out.set(g.id, g.group_kind);
  }
  return out;
}

export async function scanChatAnalysis(deps: ChatScanDeps): Promise<ChatScanSummary> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const nowMs = now.getTime();
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const summary: ChatScanSummary = {
    groups: 0,
    enqueued: 0,
    enqueuedOffice: 0,
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

  // routing: อ่าน group_kind ของทุกกลุ่มที่พิจารณา (1 query) → เลือก queue ต่อรายการ
  const kinds = await loadGroupKinds(db, [...agg.keys()]);

  for (const [chatGroupId, info] of agg) {
    // debounce: ยังไม่นิ่ง + ยังไม่ถึง threshold → รอรอบหน้า
    const settled = nowMs - info.latestMs >= debounceMs;
    if (!settled && info.count < FORCE_THRESHOLD) {
      summary.waiting += 1;
      continue;
    }

    // ★ กันปน: 1-1 (group_kind='user') → office_inbound ; อื่น/อ่านไม่ได้ → chat_analysis (per-accountant)
    const isDirect = kinds.get(chatGroupId) === "user";
    const queue = isDirect ? "office_inbound" : "chat_analysis";

    try {
      if (await hasPendingJob(db, queue, chatGroupId)) {
        summary.existed += 1;
        continue;
      }

      const { error: insErr } = await db.from("job_queue").insert({
        tenant_id: info.tenantId,
        queue,
        payload: { chat_group_id: chatGroupId },
      });
      if (insErr) {
        // ★ 23505 = ชน partial unique index (มี job ค้างอยู่แล้ว) → idempotent skip ไม่ใช่ error
        if ((insErr as { code?: string }).code === "23505") {
          summary.existed += 1;
        } else {
          summary.failed += 1;
        }
      } else if (isDirect) {
        summary.enqueuedOffice += 1;
      } else {
        summary.enqueued += 1;
      }
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}
