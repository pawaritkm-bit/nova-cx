import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIProvider } from "./provider";
import { analyzeChat, type AnalyzeChatInput } from "./chat-analyze";
import type { ChatMessageContext } from "./chat-prompt";
import { decryptField, hasEncKey } from "@/lib/crypto/field";

/**
 * Chat Analysis Worker (Phase 2) — ดึง job `chat_analysis` จาก job_queue แล้วประมวลผล
 *   pull → claim → โหลด window (ข้อความยังไม่วิเคราะห์ต่อกลุ่ม) →
 *   ★ decrypt (server) → redact → gate → เรียก provider → guardrail →
 *   persist ai_chat_analysis + customer_sentiment + sop_violations (RPC atomic) → mark done
 *
 *   error → attempts++ ; ครบ max_attempts → dead ; ไม่ครบ → pending + backoff
 *   ★ ไม่วิเคราะห์ทีละข้อความ — รวมเป็น window/กลุ่ม เพื่อคุมต้นทุน AI
 *   ★ ห้าม log plaintext/ciphertext-decrypted (decrypt แล้วใช้ในหน่วยความจำเท่านั้น)
 *
 * inject deps (db + provider) เพื่อ unit test ได้โดยไม่ต้องมี env จริง
 */

const DEFAULT_BATCH = 5; // งาน chat หนักกว่า survey → batch เล็กกว่า
const BACKOFF_BASE_SEC = 60;
const STALE_LOCK_MS = 5 * 60 * 1000;
/** จำนวนข้อความสูงสุดต่อ 1 window (คุมต้นทุน token) */
const MAX_WINDOW_MESSAGES = 200;

export type ChatWorkerDeps = {
  db: SupabaseClient;
  provider: AIProvider | null;
  now?: () => Date;
};

export type ChatWorkerSummary = {
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
  status?: string;
  locked_at?: string | null;
};

type MessageRow = {
  id: string;
  chat_member_id: string | null;
  message_type: string;
  content_enc: string | null;
  sent_at: string | null;
};

type ChatWindow = {
  tenantId: string;
  chatGroupId: string;
  windowStart: string | null;
  windowEnd: string | null;
  /** ข้อความ context (idx → text) พร้อม map idx → {id, at} */
  messages: ChatMessageContext[];
  idxToMessage: { id: string; at: string | null }[];
  groupLabel: string | null;
  knownNames: string[];
};

/** โหลด window: ข้อความยังไม่วิเคราะห์ของกลุ่ม + decrypt (server) + resolve บทบาท/ชื่อ */
export async function loadChatWindow(
  db: SupabaseClient,
  chatGroupId: string
): Promise<ChatWindow | null> {
  // กลุ่ม + tenant + ลูกค้า (ไว้ redact ชื่อ)
  const { data: group } = await db
    .from("chat_groups")
    .select("id, tenant_id, customer_id, display_name")
    .eq("id", chatGroupId)
    .maybeSingle();
  if (!group) return null;
  const g = group as {
    tenant_id: string;
    customer_id: string | null;
    display_name: string | null;
  };

  // ข้อความที่ยังไม่วิเคราะห์ (analyzed_at null) เรียงตามเวลา
  const { data: msgRows } = await db
    .from("chat_messages")
    .select("id, chat_member_id, message_type, content_enc, sent_at")
    .eq("chat_group_id", chatGroupId)
    .is("analyzed_at", null)
    .is("deleted_at", null)
    .order("sent_at", { ascending: true })
    .limit(MAX_WINDOW_MESSAGES);
  const rows = (msgRows ?? []) as MessageRow[];

  // บทบาทผู้ส่ง: map chat_member_id → member_kind (ไม่ดึงชื่อ = ลด PII)
  const memberKind = new Map<string, string>();
  const { data: members } = await db
    .from("chat_members")
    .select("id, member_kind")
    .eq("chat_group_id", chatGroupId);
  for (const m of (members ?? []) as { id: string; member_kind: string }[]) {
    memberKind.set(m.id, m.member_kind);
  }

  // ชื่อสำหรับ redact (ลูกค้า/ธุรกิจ)
  const knownNames: string[] = [];
  if (g.customer_id) {
    const { data: cust } = await db
      .from("customers")
      .select("name, business_name")
      .eq("id", g.customer_id)
      .maybeSingle();
    const c = cust as { name: string | null; business_name: string | null } | null;
    if (c?.name) knownNames.push(c.name);
    if (c?.business_name) knownNames.push(c.business_name);
  }

  const messages: ChatMessageContext[] = [];
  const idxToMessage: { id: string; at: string | null }[] = [];
  let idx = 0;
  for (const r of rows) {
    // ★ decrypt ฝั่ง server — best-effort: decrypt ไม่ได้/ไม่ใช่ text = ใช้ placeholder
    let text: string;
    if (r.content_enc) {
      try {
        text = decryptField(r.content_enc);
      } catch {
        // ห้าม log ciphertext/plaintext — แจ้งเฉพาะว่ามีข้อความ decrypt ไม่ได้
        console.warn(`[ai/chat-worker] decrypt failed for a message (group=${chatGroupId})`);
        text = "[ถอดรหัสไม่ได้]";
      }
    } else {
      text = `[${r.message_type}]`;
    }
    const sender = (r.chat_member_id && memberKind.get(r.chat_member_id)) || "unknown";
    messages.push({ idx, at: r.sent_at ?? "", sender, text });
    idxToMessage.push({ id: r.id, at: r.sent_at });
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
    idxToMessage,
    groupLabel: g.display_name,
    knownNames,
  };
}

/** map msg_idx → message_id (ถ้าอยู่ในช่วง idx ที่ถูกต้อง) */
function messageIdAt(win: ChatWindow, idx: number | null): string | null {
  if (idx === null || idx < 0 || idx >= win.idxToMessage.length) return null;
  return win.idxToMessage[idx].id;
}

/** map msg_idx → เวลาส่ง (ISO) — ใช้เป็นเวลาของจุด sentiment */
function messageAt(win: ChatWindow, idx: number | null): string | null {
  if (idx === null || idx < 0 || idx >= win.idxToMessage.length) return null;
  return win.idxToMessage[idx].at;
}

/** ประมวลผล 1 job — คืน 'done' | 'retry' | 'dead' */
async function processJob(
  deps: ChatWorkerDeps,
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

  const win = await loadChatWindow(db, chatGroupId);
  if (!win) return fail("chat_group_not_found");

  // ไม่มีข้อความค้างวิเคราะห์ (อาจถูก window ก่อนหน้ากินไปแล้ว) → done เฉย ๆ
  if (win.messages.length === 0) {
    await markDone();
    return "done";
  }

  const input: AnalyzeChatInput = {
    messages: win.messages,
    groupLabel: win.groupLabel,
    knownNames: win.knownNames,
  };

  let outcome;
  try {
    outcome = await analyzeChat(provider, input);
  } catch (e) {
    return fail(`analyze_failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  const res = outcome.result;
  const messageIds = win.idxToMessage.map((m) => m.id);

  // evidence: เติม message_id + at จาก msg_idx (อ้างข้อความจริง)
  const evidence = res.evidence.map((e) => ({
    claim: e.claim,
    quote: e.quote,
    msg_idx: e.msg_idx,
    message_id: messageIdAt(win, e.msg_idx),
    at: messageAt(win, e.msg_idx),
  }));

  // problems: เติม message_id
  const problems = res.problems.map((p) => ({
    type: p.type,
    detail: p.detail,
    msg_idx: p.msg_idx,
    message_id: messageIdAt(win, p.msg_idx),
  }));

  // sop_violations → resolve evidence_message_id จาก msg_idx
  const violations = res.sop_violations.map((v) => ({
    violation_type: v.violation_type,
    severity: v.severity,
    description: v.description,
    needs_expert_review: v.needs_expert_review,
    evidence_message_id: messageIdAt(win, v.msg_idx),
  }));

  // sentiment_points → เวลาจาก msg_idx (fallback window_end)
  const sentimentPoints = res.sentiment_points
    .map((s) => ({
      score: s.score,
      label: s.label,
      at: messageAt(win, s.msg_idx) ?? win.windowEnd,
    }))
    .filter((s) => s.at !== null);

  const analysisPayload = {
    summary: res.summary,
    sentiment: res.sentiment,
    urgency: res.urgency,
    customer_facts: res.customer_facts,
    ai_assumptions: res.ai_assumptions,
    evidence,
    flow_steps: res.flow_steps,
    problems,
    confidence: res.confidence,
    model: outcome.model,
    provider: outcome.provider,
    needs_human_review: res.needs_human_review,
    insufficient_data: res.insufficient_data,
    validated: res.validated,
  };

  const { error: rpcErr } = await db.rpc("persist_chat_analysis", {
    p_tenant_id: win.tenantId,
    p_chat_group_id: win.chatGroupId,
    p_window_start: win.windowStart,
    p_window_end: win.windowEnd,
    p_message_ids: messageIds,
    p_analysis: analysisPayload,
    p_sentiment_points: sentimentPoints,
    p_violations: violations,
  });

  if (rpcErr) {
    return fail(`persist_failed: ${rpcErr.message ?? "rpc_error"}`);
  }

  await markDone();
  return "done";
}

/**
 * ดึง+ประมวลผลงาน chat_analysis เป็น batch
 *   - ไม่มี provider (ยังไม่ตั้ง OPENAI_API_KEY) → skip (job คง pending)
 *   - ไม่มี CREDENTIAL_ENC_KEY → skip (decrypt ไม่ได้ ไม่ควรทำให้ job ตาย)
 */
export async function processChatAnalysisJobs(
  deps: ChatWorkerDeps,
  opts: { limit?: number } = {}
): Promise<ChatWorkerSummary> {
  const { db, provider } = deps;
  const now = deps.now ? deps.now() : new Date();
  const limit = opts.limit ?? DEFAULT_BATCH;

  const summary: ChatWorkerSummary = {
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
    // ไม่มีคีย์ถอดรหัส → คง pending ไว้ (degrade สุภาพ ไม่ทำให้ job ตาย/รั่ว)
    summary.skipped = true;
    summary.reason = "enc_key_unconfigured";
    return summary;
  }

  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - STALE_LOCK_MS).toISOString();
  const { data: jobs, error } = await db
    .from("job_queue")
    .select("id, tenant_id, payload, attempts, max_attempts, status, locked_at")
    .eq("queue", "chat_analysis")
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
    // claim แบบ optimistic (กัน worker ซ้อน)
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
