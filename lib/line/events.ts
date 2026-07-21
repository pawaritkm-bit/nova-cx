import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineOa } from "@/lib/env";
import type { LineClient } from "@/lib/line/client";
import type { QueuedLineEvent } from "@/lib/line/webhook";
import { ingestGroupMessage, ingestDirectMessage, ingestGroupJoin } from "@/lib/line/ingest";

/**
 * Worker: line_event — ประมวลผล event ที่ webhook enqueue ไว้ (job_queue queue='line_event')
 *   follow (แอดเพื่อน)     → upsert line_users + linked + unblock
 *   unfollow/block         → mark is_blocked = true
 *   message (group/room)   → ingest แชตกลุ่มลง chat_* (เข้ารหัสแล้ว, idempotent) — per-accountant
 *   message (1:1/user)     → ingest แชต 1-1 ฝั่งลูกค้า (group_kind='user') — office inbound (Phase A)
 *   อื่น                    → no-op (mark done)
 *
 * inject deps (db + getClient) เพื่อ test ได้โดยไม่ต้องมี env/network จริง
 */

const DEFAULT_BATCH = 20;
const BACKOFF_BASE_SEC = 30;

/**
 * คืน "รหัส error ที่ปลอดภัย" สำหรับเก็บลง job_queue.last_error
 *   - Postgres/PostgREST error → ใช้ .code (SQLSTATE เช่น 23505) ไม่เอา message/detail ดิบ
 *   - อื่น ๆ → 'unknown' (ไม่ leak ข้อความที่อาจฝัง PII)
 * ★ ไม่คืน error.message เพราะข้อความ DB error อาจฝังค่าคอลัมน์ (เช่นชื่อ) = PII
 */
function sanitizeErrorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[0-9A-Za-z_]{1,16}$/.test(code)) return code;
  return "unknown";
}

export type LineEventWorkerDeps = {
  db: SupabaseClient;
  /** คืน client ของ OA (null = ไม่มี credential → ข้ามการดึงโปรไฟล์) */
  getClient?: (oa: LineOa) => LineClient | null;
  now?: () => Date;
};

export type LineEventSummary = {
  processed: number;
  done: number;
  failed: number;
  dead: number;
  skipped: boolean;
  reason?: string;
};

type JobRow = {
  id: string;
  tenant_id: string;
  payload: { oa?: LineOa; event?: QueuedLineEvent } | null;
  attempts: number;
  max_attempts: number;
};

/** upsert line_users ตอน follow (linked + unblock) + best-effort display name */
async function handleFollow(
  deps: LineEventWorkerDeps,
  tenantId: string,
  oa: LineOa,
  userId: string,
  now: Date
): Promise<void> {
  let displayName: string | null = null;
  const client = deps.getClient?.(oa) ?? null;
  if (client) {
    const profile = await client.getProfile(userId);
    displayName = profile?.displayName ?? null;
  }

  const row: Record<string, unknown> = {
    tenant_id: tenantId,
    line_user_id: userId,
    is_blocked: false,
    linked_at: now.toISOString(),
  };
  if (displayName) row.display_name = displayName;

  await deps.db
    .from("line_users")
    .upsert(row, { onConflict: "tenant_id,line_user_id" });
}

/** unfollow/block → mark is_blocked = true (FR-LN-04) */
async function handleUnfollow(
  deps: LineEventWorkerDeps,
  tenantId: string,
  userId: string
): Promise<void> {
  await deps.db
    .from("line_users")
    .update({ is_blocked: true })
    .eq("tenant_id", tenantId)
    .eq("line_user_id", userId);
}

/** ประมวลผล 1 job → 'done' | 'retry' | 'dead' */
async function processOne(
  deps: LineEventWorkerDeps,
  job: JobRow,
  now: Date
): Promise<"done" | "retry" | "dead"> {
  const { db } = deps;

  const fail = async (msg: string): Promise<"retry" | "dead"> => {
    const attempts = job.attempts + 1;
    const isDead = attempts >= job.max_attempts;
    await db
      .from("job_queue")
      .update({
        status: isDead ? "dead" : "pending",
        attempts,
        last_error: msg.slice(0, 500),
        locked_at: null,
        run_at: isDead
          ? now.toISOString()
          : new Date(now.getTime() + attempts * BACKOFF_BASE_SEC * 1000).toISOString(),
      })
      .eq("id", job.id);
    return isDead ? "dead" : "retry";
  };

  const oa = job.payload?.oa;
  const event = job.payload?.event;
  if (!oa || !event) return fail("missing_oa_or_event");

  const userId = event.source?.userId;

  try {
    switch (event.type) {
      case "follow":
        if (!userId) return fail("follow_missing_userId");
        await handleFollow(deps, job.tenant_id, oa, userId, now);
        break;
      case "unfollow":
        if (!userId) return fail("unfollow_missing_userId");
        await handleUnfollow(deps, job.tenant_id, userId);
        break;
      case "message":
        // routing ตามชนิดต้นทาง:
        //   1-1 (user) → ingest ฝั่งลูกค้า (office inbound) ; group/room → ingest กลุ่ม (per-accountant)
        //   (แต่ละ ingest จัดการ skip เองถ้าข้อมูลไม่ครบ/ผิดชนิด)
        if (event.source?.type === "user") {
          await ingestDirectMessage(
            { db, client: deps.getClient?.(oa) ?? null, now: () => now },
            job.tenant_id,
            oa,
            event
          );
        } else {
          await ingestGroupMessage(
            { db, client: deps.getClient?.(oa) ?? null, now: () => now },
            job.tenant_id,
            oa,
            event
          );
        }
        break;
      case "join":
        // บอทถูกเชิญเข้ากลุ่ม/ห้อง → สร้าง chat_group + ดึงชื่อทันที (โผล่ในหน้า admin ไม่ต้องรอข้อความแรก)
        await ingestGroupJoin(
          { db, client: deps.getClient?.(oa) ?? null, now: () => now },
          job.tenant_id,
          oa,
          event
        );
        break;
      default:
        // postback / อื่น ๆ — ยังไม่ต้องทำอะไร (mark done)
        break;
    }
  } catch (e) {
    // ★ sanitize: ไม่เก็บ error message ดิบลง last_error (อาจมี PII เช่นชื่อในข้อความ DB error)
    //   เก็บแค่ error code (เช่น Postgres SQLSTATE) หรือ generic ต่อชนิด event
    return fail(`line_event_failed:${event.type}:${sanitizeErrorCode(e)}`);
  }

  await db
    .from("job_queue")
    .update({ status: "sent", last_error: null, locked_at: null })
    .eq("id", job.id);
  return "done";
}

/** ดึง+ประมวลผลงาน line_event เป็น batch */
export async function processLineEventJobs(
  deps: LineEventWorkerDeps,
  opts: { limit?: number } = {}
): Promise<LineEventSummary> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const limit = opts.limit ?? DEFAULT_BATCH;

  const summary: LineEventSummary = {
    processed: 0,
    done: 0,
    failed: 0,
    dead: 0,
    skipped: false,
  };

  const { data: jobs, error } = await db
    .from("job_queue")
    .select("id, tenant_id, payload, attempts, max_attempts")
    .eq("queue", "line_event")
    .eq("status", "pending")
    .lte("run_at", now.toISOString())
    .order("run_at", { ascending: true })
    .limit(limit);

  if (error) {
    summary.skipped = true;
    summary.reason = `pull_failed: ${error.message ?? "unknown"}`;
    return summary;
  }

  for (const raw of (jobs ?? []) as JobRow[]) {
    const { data: claimed } = await db
      .from("job_queue")
      .update({ status: "processing", locked_at: now.toISOString() })
      .eq("id", raw.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    summary.processed += 1;
    const outcome = await processOne(deps, raw, now);
    if (outcome === "done") summary.done += 1;
    else if (outcome === "dead") summary.dead += 1;
    else summary.failed += 1;
  }

  return summary;
}
