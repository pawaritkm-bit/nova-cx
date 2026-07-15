import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIProvider } from "./provider";
import { analyzeFeedback, type AnalyzeInput } from "./analyze";
import {
  shouldOpenCase,
  inferCaseType,
  computeSlaDueAt,
  type CaseLevel,
} from "./case";

/**
 * AI Analysis Worker (E6) — ดึง job `ai_analysis` จาก job_queue แล้วประมวลผล
 *   pull → claim → load response → redact+analyze → persist(+เปิดเคส) → mark done
 *   error → attempts++ ; ครบ max_attempts → dead (dead_letter) ; ไม่ครบ → pending + backoff
 *
 * ออกแบบให้ inject deps (db + provider) เพื่อ unit test ได้โดยไม่ต้องมี env จริง
 */

const DEFAULT_BATCH = 10;
const BACKOFF_BASE_SEC = 60; // backoff เชิงเส้นตาม attempts
const STALE_LOCK_MS = 5 * 60 * 1000; // job ที่ค้าง 'processing' เกินเวลานี้ = ถือว่าตาย → ดึงกลับมาทำใหม่

export type WorkerDeps = {
  db: SupabaseClient;
  provider: AIProvider | null;
  now?: () => Date;
};

export type WorkerSummary = {
  processed: number;
  done: number;
  failed: number; // กลับเข้าคิว (จะ retry)
  dead: number; // ย้าย dead_letter
  skipped: boolean;
  reason?: string;
};

type JobRow = {
  id: string;
  tenant_id: string;
  payload: { response_id?: string } | null;
  attempts: number;
  max_attempts: number;
  status?: string;
  locked_at?: string | null;
};

type ResponseContext = {
  tenant_id: string;
  survey_type: string;
  answers: Record<string, unknown>;
  overall_score: number | null;
  nps: number | null;
  knownNames: string[];
};

/** โหลดบริบทของ response สำหรับป้อน AI (answers + scores + ชื่อสำหรับ redact) */
export async function loadResponseContext(
  db: SupabaseClient,
  responseId: string
): Promise<ResponseContext | null> {
  const { data: resp } = await db
    .from("survey_responses")
    .select("id, tenant_id, customer_id, invitation_id")
    .eq("id", responseId)
    .maybeSingle();
  if (!resp) return null;

  const r = resp as {
    tenant_id: string;
    customer_id: string | null;
    invitation_id: string | null;
  };

  // survey_type + assignee snapshot จาก invitation
  let surveyType = "A";
  let snapshotNames: string[] = [];
  if (r.invitation_id) {
    const { data: inv } = await db
      .from("survey_invitations")
      .select("survey_type, assignee_snapshot")
      .eq("id", r.invitation_id)
      .maybeSingle();
    if (inv) {
      const i = inv as { survey_type: string; assignee_snapshot: unknown };
      surveyType = i.survey_type ?? "A";
      if (Array.isArray(i.assignee_snapshot)) {
        snapshotNames = i.assignee_snapshot
          .map((s) => (s && typeof s === "object" ? (s as { name?: string }).name : null))
          .filter((n): n is string => !!n);
      }
    }
  }

  // answers
  const { data: answerRows } = await db
    .from("survey_answers")
    .select("question_code, value_json")
    .eq("response_id", responseId);
  const answers: Record<string, unknown> = {};
  for (const row of (answerRows ?? []) as { question_code: string; value_json: unknown }[]) {
    answers[row.question_code] = row.value_json;
  }

  // overall CSAT
  const { data: scoreRows } = await db
    .from("satisfaction_scores")
    .select("dimension, score")
    .eq("response_id", responseId);
  let overall: number | null = null;
  for (const s of (scoreRows ?? []) as { dimension: string; score: number }[]) {
    if (s.dimension === "overall") overall = Number(s.score);
  }

  // NPS
  const { data: npsRow } = await db
    .from("nps_scores")
    .select("score_0_10")
    .eq("response_id", responseId)
    .maybeSingle();
  const nps = npsRow ? Number((npsRow as { score_0_10: number }).score_0_10) : null;

  // ชื่อสำหรับ redact (ลูกค้า + ธุรกิจ + พนักงานจาก snapshot)
  const knownNames = [...snapshotNames];
  if (r.customer_id) {
    const { data: cust } = await db
      .from("customers")
      .select("name, business_name")
      .eq("id", r.customer_id)
      .maybeSingle();
    if (cust) {
      const c = cust as { name: string | null; business_name: string | null };
      if (c.name) knownNames.push(c.name);
      if (c.business_name) knownNames.push(c.business_name);
    }
  }

  return {
    tenant_id: r.tenant_id,
    survey_type: surveyType,
    answers,
    overall_score: overall,
    nps,
    knownNames,
  };
}

/** ประมวลผล 1 job (แยกออกมาให้ทดสอบง่าย) — คืน 'done' | 'retry' | 'dead' */
async function processJob(
  deps: WorkerDeps,
  job: JobRow,
  now: Date
): Promise<"done" | "retry" | "dead"> {
  const { db, provider } = deps;
  const responseId = job.payload?.response_id;

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

  if (!responseId) return fail("missing_response_id");
  if (!provider) return fail("ai_provider_unconfigured");

  const ctx = await loadResponseContext(db, responseId);
  if (!ctx) return fail("response_context_not_found");

  const input: AnalyzeInput = {
    survey_type: ctx.survey_type,
    overall_score: ctx.overall_score,
    nps: ctx.nps,
    answers: ctx.answers,
    knownNames: ctx.knownNames,
  };

  let outcome;
  try {
    outcome = await analyzeFeedback(provider, input);
  } catch (e) {
    return fail(`analyze_failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  const urgency = outcome.result.urgency;
  // TODO(M5): urgency=medium → สร้าง follow_up_tasks แทนการเปิดเคส (ยังไม่อยู่ scope chunk นี้)
  const openCase = shouldOpenCase(urgency);
  const level = (openCase ? urgency : "high") as CaseLevel;
  const caseType = inferCaseType(outcome.result, ctx.survey_type);
  const slaDueAt = openCase ? computeSlaDueAt(level, now) : null;

  const { error: rpcErr } = await db.rpc("persist_ai_analysis", {
    p_tenant_id: ctx.tenant_id,
    p_response_id: responseId,
    p_analysis: {
      summary: outcome.result.summary,
      sentiment: outcome.result.sentiment,
      urgency: outcome.result.urgency,
      urgency_reason: outcome.result.urgency_reason,
      affected: outcome.result.affected,
      repeat_issue: outcome.result.repeat_issue,
      customer_facts: outcome.result.customer_facts,
      ai_assumptions: outcome.result.ai_assumptions,
      evidence: outcome.result.evidence,
      categories: outcome.result.categories,
      next_best_action: outcome.result.next_best_action,
      draft_reply: outcome.result.draft_reply,
      confidence: outcome.result.confidence,
      model: outcome.model,
      provider: outcome.provider,
      needs_human_review: outcome.result.needs_human_review,
      validated: outcome.result.validated,
    },
    p_open_case: openCase,
    p_case_type: caseType,
    p_case_level: level,
    p_sla_due_at: slaDueAt ? slaDueAt.toISOString() : null,
  });

  if (rpcErr) {
    return fail(`persist_failed: ${rpcErr.message ?? "rpc_error"}`);
  }

  await db
    .from("job_queue")
    .update({ status: "sent", last_error: null, locked_at: null })
    .eq("id", job.id);

  return "done";
}

/**
 * ดึง+ประมวลผลงาน ai_analysis เป็น batch
 *   - ไม่มี provider (ยังไม่ตั้ง OPENAI_API_KEY) → skip (job คง pending, ไม่ crash)
 */
export async function processAiAnalysisJobs(
  deps: WorkerDeps,
  opts: { limit?: number } = {}
): Promise<WorkerSummary> {
  const { db, provider } = deps;
  const now = deps.now ? deps.now() : new Date();
  const limit = opts.limit ?? DEFAULT_BATCH;

  const summary: WorkerSummary = {
    processed: 0,
    done: 0,
    failed: 0,
    dead: 0,
    skipped: false,
  };

  // ไม่มี provider → degrade สุภาพ (คง pending ไว้ให้รอบหน้า)
  if (!provider) {
    summary.skipped = true;
    summary.reason = "ai_provider_unconfigured";
    return summary;
  }

  // 1) ดึงงานที่พร้อมรัน:
  //    (ก) pending ที่ถึงเวลา run_at แล้ว
  //    (ข) processing ที่ล็อกค้างเกิน STALE_LOCK_MS (worker เดิมตาย/timeout) → reclaim
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - STALE_LOCK_MS).toISOString();
  const { data: jobs, error } = await db
    .from("job_queue")
    .select("id, tenant_id, payload, attempts, max_attempts, status, locked_at")
    .eq("queue", "ai_analysis")
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
    // 2) claim แบบ optimistic — อัปเดตเฉพาะที่ยัง pending หรือ processing ที่ล็อกค้าง (stale)
    //    กัน worker ซ้อน: ถ้า worker อื่นเพิ่ง claim/ล็อกใหม่ไปแล้ว เงื่อนไขจะไม่ match → ข้าม
    const { data: claimed } = await db
      .from("job_queue")
      .update({ status: "processing", locked_at: nowIso })
      .eq("id", raw.id)
      .or(`status.eq.pending,and(status.eq.processing,locked_at.lt.${staleIso})`)
      .select("id")
      .maybeSingle();
    if (!claimed) continue; // job อื่น claim/ล็อกไปแล้ว

    summary.processed += 1;
    const outcome = await processJob(deps, raw, now);
    if (outcome === "done") summary.done += 1;
    else if (outcome === "dead") summary.dead += 1;
    else summary.failed += 1;
  }

  return summary;
}
