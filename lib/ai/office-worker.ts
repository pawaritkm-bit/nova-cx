import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIProvider } from "./provider";
import { analyzeOfficeInbound, type OfficeMessageContext } from "./office-analyze";
import { decryptField, hasEncKey } from "@/lib/crypto/field";

/**
 * Office Inbound Worker (Phase A) — ดึง job `office_inbound` แล้ววิเคราะห์ "แชต 1-1 ฝั่งลูกค้า"
 *   pull → claim → โหลด window (ข้อความลูกค้ายังไม่วิเคราะห์ต่อบทสนทนา) →
 *   ★ decrypt (server) → redact → gate → เรียก provider → guardrail →
 *   persist office_inbound_analysis (RPC atomic + mark analyzed) → mark done
 *
 *   ★ แยกจาก chat-worker เด็ดขาด: ทำงานเฉพาะ group_kind='user'
 *     ไม่เปิด conversation_cases / ไม่เขียน ai_chat_analysis / ไม่แตะ per-accountant flow
 *   ★ ห้าม log plaintext/ciphertext-decrypted
 *
 * inject deps (db + provider) เพื่อ unit test ได้โดยไม่ต้องมี env จริง
 */

const DEFAULT_BATCH = 5;
const BACKOFF_BASE_SEC = 60;
const STALE_LOCK_MS = 5 * 60 * 1000;
const MAX_WINDOW_MESSAGES = 200;

export type OfficeWorkerDeps = {
  db: SupabaseClient;
  provider: AIProvider | null;
  now?: () => Date;
};

export type OfficeWorkerSummary = {
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
  payload: { chat_group_id?: string } | null;
  attempts: number;
  max_attempts: number;
};

type MessageRow = {
  id: string;
  message_type: string;
  content_enc: string | null;
  sent_at: string | null;
};

type OfficeWindow = {
  tenantId: string;
  chatGroupId: string;
  windowStart: string | null;
  windowEnd: string | null;
  messages: OfficeMessageContext[];
  messageIds: string[];
  knownNames: string[];
};

/** โหลด window ของบทสนทนา 1-1: ข้อความลูกค้าที่ยังไม่วิเคราะห์ + decrypt (server) + ชื่อไว้ redact
 *   ★ รับเฉพาะ group_kind='user' — กันหยิบกลุ่ม/ห้อง (per-accountant) มาวิเคราะห์ผิดสาย */
export async function loadOfficeWindow(
  db: SupabaseClient,
  chatGroupId: string
): Promise<OfficeWindow | null> {
  const { data: group } = await db
    .from("chat_groups")
    .select("id, tenant_id, customer_id, group_kind")
    .eq("id", chatGroupId)
    .maybeSingle();
  if (!group) return null;
  const g = group as {
    tenant_id: string;
    customer_id: string | null;
    group_kind: string;
  };
  // ★ กันปน: office worker ทำเฉพาะบทสนทนา 1-1 เท่านั้น
  if (g.group_kind !== "user") return null;

  const { data: msgRows } = await db
    .from("chat_messages")
    .select("id, message_type, content_enc, sent_at")
    .eq("chat_group_id", chatGroupId)
    .is("analyzed_at", null)
    .is("deleted_at", null)
    .order("sent_at", { ascending: true })
    .limit(MAX_WINDOW_MESSAGES);
  const rows = (msgRows ?? []) as MessageRow[];

  // ชื่อสำหรับ redact — ลูกค้า/ธุรกิจ (ถ้าบทสนทนานี้ผูกลูกค้าที่รู้จักแล้ว)
  const knownNames = new Set<string>();
  if (g.customer_id) {
    const { data: cust } = await db
      .from("customers")
      .select("name, business_name")
      .eq("id", g.customer_id)
      .maybeSingle();
    const c = cust as { name: string | null; business_name: string | null } | null;
    if (c?.name) knownNames.add(c.name);
    if (c?.business_name) knownNames.add(c.business_name);
  }
  // ชื่อที่แสดงของบทสนทนา (โปรไฟล์ผู้ใช้) — เพิ่มลง redact
  const { data: members } = await db
    .from("chat_members")
    .select("display_name_enc")
    .eq("chat_group_id", chatGroupId);
  for (const m of (members ?? []) as { display_name_enc: string | null }[]) {
    if (m.display_name_enc) {
      try {
        const name = decryptField(m.display_name_enc);
        if (name) knownNames.add(name);
      } catch {
        // ห้าม log ciphertext/plaintext — ถอดไม่ได้ก็ข้าม (best-effort)
      }
    }
  }

  const messages: OfficeMessageContext[] = [];
  const messageIds: string[] = [];
  let idx = 0;
  for (const r of rows) {
    let text: string;
    if (r.content_enc) {
      try {
        text = decryptField(r.content_enc);
      } catch {
        console.warn(`[ai/office-worker] decrypt failed for a message (group=${chatGroupId})`);
        text = "[ถอดรหัสไม่ได้]";
      }
    } else {
      text = `[${r.message_type}]`;
    }
    messages.push({ idx, at: r.sent_at ?? "", text });
    messageIds.push(r.id);
    idx += 1;
  }

  const windowStart = rows.length > 0 ? rows[0].sent_at : null;
  const windowEnd = rows.length > 0 ? rows[rows.length - 1].sent_at : null;

  return {
    tenantId: g.tenant_id,
    chatGroupId,
    windowStart,
    windowEnd,
    messages,
    messageIds,
    knownNames: [...knownNames],
  };
}

/** ประมวลผล 1 job — คืน 'done' | 'retry' | 'dead' */
async function processJob(
  deps: OfficeWorkerDeps,
  job: JobRow,
  now: Date
): Promise<"done" | "retry" | "dead"> {
  const { db, provider } = deps;
  const chatGroupId = job.payload?.chat_group_id;

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

  const markDone = async () => {
    await db
      .from("job_queue")
      .update({ status: "sent", last_error: null, locked_at: null })
      .eq("id", job.id);
  };

  if (!chatGroupId) return fail("missing_chat_group_id");
  if (!provider) return fail("ai_provider_unconfigured");

  const win = await loadOfficeWindow(db, chatGroupId);
  if (!win) return fail("office_group_not_found_or_not_direct");

  // ไม่มีข้อความค้าง (ถูก window ก่อนหน้ากินไปแล้ว) → done เฉย ๆ
  if (win.messages.length === 0) {
    await markDone();
    return "done";
  }

  let outcome;
  try {
    outcome = await analyzeOfficeInbound(provider, {
      messages: win.messages,
      knownNames: win.knownNames,
    });
  } catch (e) {
    return fail(`analyze_failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  const res = outcome.result;
  const analysisPayload = {
    summary: res.summary,
    sentiment: res.sentiment,
    urgency: res.urgency,
    topics: res.topics,
    is_complaint: res.is_complaint,
    needs_attention: res.needs_attention,
    confidence: res.confidence,
    model: outcome.model,
    provider: outcome.provider,
    blocked_reason: outcome.blocked ? "residual_pii" : null,
    validated: res.validated,
  };

  const { error: rpcErr } = await db.rpc("persist_office_inbound_analysis", {
    p_tenant_id: win.tenantId,
    p_chat_group_id: win.chatGroupId,
    p_window_start: win.windowStart,
    p_window_end: win.windowEnd,
    p_message_ids: win.messageIds,
    p_analysis: analysisPayload,
  });

  if (rpcErr) {
    const code = (rpcErr as { code?: string }).code;
    return fail(`persist_failed${code ? `:${code}` : ""}`);
  }

  await markDone();
  return "done";
}

/**
 * ดึง+ประมวลผลงาน office_inbound เป็น batch
 *   - ไม่มี provider (ยังไม่ตั้ง OPENAI_API_KEY) → skip (job คง pending)
 *   - ไม่มี CREDENTIAL_ENC_KEY → skip (decrypt ไม่ได้ ไม่ควรทำให้ job ตาย)
 */
export async function processOfficeInboundJobs(
  deps: OfficeWorkerDeps,
  opts: { limit?: number } = {}
): Promise<OfficeWorkerSummary> {
  const { db, provider } = deps;
  const now = deps.now ? deps.now() : new Date();
  const limit = opts.limit ?? DEFAULT_BATCH;

  const summary: OfficeWorkerSummary = {
    processed: 0,
    done: 0,
    failed: 0,
    dead: 0,
    skipped: false,
  };

  if (!provider) {
    summary.skipped = true;
    summary.reason = "ai_provider_unconfigured";
    return summary;
  }
  if (!hasEncKey()) {
    summary.skipped = true;
    summary.reason = "enc_key_unconfigured";
    return summary;
  }

  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - STALE_LOCK_MS).toISOString();
  const { data: jobs, error } = await db
    .from("job_queue")
    .select("id, tenant_id, payload, attempts, max_attempts, status, locked_at")
    .eq("queue", "office_inbound")
    .or(
      `and(status.eq.pending,run_at.lte.${nowIso}),and(status.eq.processing,locked_at.lt.${staleIso})`
    )
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
      .update({ status: "processing", locked_at: nowIso })
      .eq("id", raw.id)
      .or(`status.eq.pending,and(status.eq.processing,locked_at.lt.${staleIso})`)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    summary.processed += 1;
    const outcome = await processJob(deps, raw, now);
    if (outcome === "done") summary.done += 1;
    else if (outcome === "dead") summary.dead += 1;
    else summary.failed += 1;
  }

  return summary;
}
