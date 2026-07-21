import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIProvider } from "./provider";
import { extractKnowledge, type KnowledgeMessageContext } from "./knowledge-extract";
import { decryptField, encryptField, hasEncKey } from "@/lib/crypto/field";

/**
 * Reply Knowledge Worker (Phase 1) — ดึง job `knowledge_extract` แล้วสกัด "คู่ถาม-ตอบ" จากแชตกลุ่ม
 *   pull → claim → โหลด window (ข้อความยังไม่สกัดความรู้ต่อกลุ่ม) →
 *   ★ decrypt (server) → กำหนดบทบาท (ลูกค้า/ทีมงาน) → redact → gate → extract (AI) →
 *   ★ เข้ารหัส gist (question/answer) → persist reply_knowledge (RPC atomic + mark) → mark done
 *
 *   ★ แยกจาก chat-worker/office-worker เด็ดขาด: ทำเฉพาะ group_kind ∈ ('group','room')
 *     ไม่แตะ ai_chat_analysis / office_inbound_analysis / conversation_cases / evaluation
 *   ★ ใช้ marker คนละคอลัมน์ (knowledge_extracted_at) ไม่ชนกับ analyzed_at ของ chat analysis
 *   ★ ห้าม log plaintext/ciphertext-decrypted
 *
 * inject deps (db + provider) เพื่อ unit test ได้โดยไม่ต้องมี env จริง
 */

const DEFAULT_BATCH = 5;
const BACKOFF_BASE_SEC = 60;
const STALE_LOCK_MS = 5 * 60 * 1000;
const MAX_WINDOW_MESSAGES = 200;

export type KnowledgeWorkerDeps = {
  db: SupabaseClient;
  provider: AIProvider | null;
  now?: () => Date;
};

export type KnowledgeWorkerSummary = {
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
  chat_member_id: string | null;
  message_type: string;
  content_enc: string | null;
  sent_at: string | null;
};

/** ข้อมูลผู้ส่งต่อ msg idx — ไว้ resolve staff เมื่อ AI ชี้ answer_msg_idx */
type SenderInfo = {
  role: KnowledgeMessageContext["role"];
  employeeId: string | null;
  staffRole: string | null;
};

type KnowledgeWindow = {
  tenantId: string;
  chatGroupId: string;
  windowStart: string | null;
  windowEnd: string | null;
  messages: KnowledgeMessageContext[];
  messageIds: string[];
  /** idx → ข้อมูลผู้ส่ง (resolve staff) */
  senders: SenderInfo[];
  knownNames: string[];
};

/** โหลด window: ข้อความยังไม่สกัดความรู้ของกลุ่ม + decrypt (server) + resolve บทบาท/ชื่อ
 *   ★ รับเฉพาะ group_kind ∈ ('group','room') — กันหยิบบทสนทนา 1-1 (office) มาสกัดผิดสาย */
export async function loadKnowledgeWindow(
  db: SupabaseClient,
  chatGroupId: string
): Promise<KnowledgeWindow | null> {
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
  // ★ กันปน: knowledge worker ทำเฉพาะแชตกลุ่มเท่านั้น (ไม่แตะ 1-1)
  if (g.group_kind !== "group" && g.group_kind !== "room") return null;

  // ข้อความที่ยัง "ไม่สกัดความรู้" (knowledge_extracted_at null) เรียงตามเวลา
  const { data: msgRows } = await db
    .from("chat_messages")
    .select("id, chat_member_id, message_type, content_enc, sent_at")
    .eq("chat_group_id", chatGroupId)
    .is("knowledge_extracted_at", null)
    .is("deleted_at", null)
    .order("sent_at", { ascending: true })
    .limit(MAX_WINDOW_MESSAGES);
  const rows = (msgRows ?? []) as MessageRow[];

  // สมาชิก: map chat_member_id → {member_kind, employee_id} + ชื่อไว้ redact
  const knownNames = new Set<string>();
  const memberInfo = new Map<string, { memberKind: string; employeeId: string | null }>();
  const employeeIds: string[] = [];
  const { data: members } = await db
    .from("chat_members")
    .select("id, member_kind, display_name_enc, employee_id")
    .eq("chat_group_id", chatGroupId);
  for (const m of (members ?? []) as {
    id: string;
    member_kind: string;
    display_name_enc: string | null;
    employee_id: string | null;
  }[]) {
    memberInfo.set(m.id, { memberKind: m.member_kind, employeeId: m.employee_id });
    if (m.employee_id) employeeIds.push(m.employee_id);
    if (m.display_name_enc) {
      try {
        const name = decryptField(m.display_name_enc);
        if (name) knownNames.add(name);
      } catch {
        // ห้าม log ciphertext/plaintext — decrypt ไม่ได้ก็ข้าม (best-effort)
      }
    }
  }

  // ชื่อพนักงาน (ไว้ redact) + ลูกค้า/ธุรกิจ
  if (employeeIds.length > 0) {
    const { data: emps } = await db
      .from("employees")
      .select("id, first_name, nickname")
      .in("id", employeeIds);
    for (const e of (emps ?? []) as { first_name: string | null; nickname: string | null }[]) {
      if (e.first_name) knownNames.add(e.first_name);
      if (e.nickname) knownNames.add(e.nickname);
    }
  }
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

  const messages: KnowledgeMessageContext[] = [];
  const messageIds: string[] = [];
  const senders: SenderInfo[] = [];
  let idx = 0;
  for (const r of rows) {
    let text: string;
    if (r.content_enc) {
      try {
        text = decryptField(r.content_enc);
      } catch {
        console.warn(`[ai/knowledge-worker] decrypt failed for a message (group=${chatGroupId})`);
        text = "[ถอดรหัสไม่ได้]";
      }
    } else {
      text = `[${r.message_type}]`;
    }

    const info = r.chat_member_id ? memberInfo.get(r.chat_member_id) : undefined;
    // ★ staff = สมาชิกที่ผูก employee_id (เซลล์/นักบัญชี/cs); ลูกค้า = member_kind='customer'
    let role: KnowledgeMessageContext["role"];
    let employeeId: string | null = null;
    let staffRole: string | null = null;
    if (info?.employeeId) {
      role = "staff";
      employeeId = info.employeeId;
      staffRole = info.memberKind ?? null;
    } else if (info?.memberKind === "customer") {
      role = "customer";
    } else {
      role = "other";
    }

    messages.push({ idx, at: r.sent_at ?? "", role, text });
    messageIds.push(r.id);
    senders.push({ role, employeeId, staffRole });
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
    senders,
    knownNames: [...knownNames],
  };
}

/** resolve staff จาก answer_msg_idx (ต้องเป็นข้อความ staff จริง — ไม่งั้นไม่ผูก) */
function resolveStaff(win: KnowledgeWindow, idx: number | null): { employeeId: string | null; role: string | null } {
  if (idx === null || idx < 0 || idx >= win.senders.length) return { employeeId: null, role: null };
  const s = win.senders[idx];
  if (s.role !== "staff") return { employeeId: null, role: null };
  return { employeeId: s.employeeId, role: s.staffRole };
}

/** ประมวลผล 1 job — คืน 'done' | 'retry' | 'dead' */
async function processJob(
  deps: KnowledgeWorkerDeps,
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

  const win = await loadKnowledgeWindow(db, chatGroupId);
  if (!win) return fail("knowledge_group_not_found_or_not_group_chat");

  // ไม่มีข้อความค้าง (ถูก window ก่อนหน้ากินไปแล้ว) → done เฉย ๆ
  if (win.messages.length === 0) {
    await markDone();
    return "done";
  }

  let outcome;
  try {
    outcome = await extractKnowledge(provider, {
      messages: win.messages,
      knownNames: win.knownNames,
    });
  } catch (e) {
    return fail(`extract_failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // สร้างรายการที่จะบันทึก — ★ เข้ารหัส gist ก่อนเก็บ (PDPA at-rest)
  //   ถ้าไม่มีคีย์เข้ารหัส worker จะ skip ทั้ง batch แล้ว (ดูด้านล่าง) จึงถือว่ามีคีย์แน่นอนที่นี่
  type Item = {
    category: string | null;
    question_gist_enc: string | null;
    answer_gist_enc: string | null;
    staff_employee_id: string | null;
    staff_role: string | null;
    confidence: number | null;
    model: string;
    provider: string;
    blocked_reason: string | null;
    validated: boolean;
  };
  const items: Item[] = [];

  if (outcome.blocked) {
    // ★ residual PII หลุด → เก็บ marker แถวเดียว (ให้แอดมินเห็นว่ามี window ถูกบล็อก) ไม่เก็บเนื้อหา
    items.push({
      category: "ระบบ",
      question_gist_enc: null,
      answer_gist_enc: null,
      staff_employee_id: null,
      staff_role: null,
      confidence: 0,
      model: outcome.model,
      provider: outcome.provider,
      blocked_reason: "residual_pii",
      validated: false,
    });
  } else {
    for (const p of outcome.pairs) {
      const staff = resolveStaff(win, p.answer_msg_idx);
      items.push({
        category: p.category,
        question_gist_enc: encryptField(p.question_gist),
        answer_gist_enc: encryptField(p.answer_gist),
        staff_employee_id: staff.employeeId,
        staff_role: staff.role,
        confidence: p.confidence,
        model: outcome.model,
        provider: outcome.provider,
        blocked_reason: null,
        validated: true,
      });
    }
  }

  const { error: rpcErr } = await db.rpc("persist_reply_knowledge", {
    p_tenant_id: win.tenantId,
    p_chat_group_id: win.chatGroupId,
    p_message_ids: win.messageIds,
    p_items: items,
  });

  if (rpcErr) {
    const code = (rpcErr as { code?: string }).code;
    return fail(`persist_failed${code ? `:${code}` : ""}`);
  }

  await markDone();
  return "done";
}

/**
 * ดึง+ประมวลผลงาน knowledge_extract เป็น batch
 *   - ไม่มี provider (ยังไม่ตั้ง OPENAI_API_KEY) → skip (job คง pending)
 *   - ไม่มี CREDENTIAL_ENC_KEY → skip (decrypt/encrypt ไม่ได้ ไม่ควรทำให้ job ตาย)
 */
export async function processKnowledgeExtractJobs(
  deps: KnowledgeWorkerDeps,
  opts: { limit?: number } = {}
): Promise<KnowledgeWorkerSummary> {
  const { db, provider } = deps;
  const now = deps.now ? deps.now() : new Date();
  const limit = opts.limit ?? DEFAULT_BATCH;

  const summary: KnowledgeWorkerSummary = {
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
    .eq("queue", "knowledge_extract")
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
