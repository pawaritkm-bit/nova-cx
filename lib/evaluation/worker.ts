import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIProvider } from "@/lib/ai/provider";
import { evaluateAccountant, type EvaluateScope } from "./evaluate";
import {
  deriveQualitativeFromProblems,
  scoreQualitativeWithAI,
  type ProblemContext,
  type QualitativeContext,
} from "./qualitative";
import type { QualitativeScores } from "./scoring";

/**
 * Evaluation Worker (Phase 4) — ดึง job `evaluation` จาก job_queue แล้วประเมินนักบัญชี
 *   pull → claim → โหลด qualitative (best-effort AI/สัญญาณ) → evaluateAccountant (สร้าง draft)
 *   error → attempts++ ; ครบ max_attempts → dead ; ไม่ครบ → pending + backoff
 *   ★ ผลเป็น draft เสมอ (ห้ามลงโทษอัตโนมัติ) — evaluateAccountant/RPC บังคับ needs_review
 */

const DEFAULT_BATCH = 10;
const BACKOFF_BASE_SEC = 60;
const STALE_LOCK_MS = 5 * 60 * 1000;

export type EvalWorkerDeps = {
  db: SupabaseClient;
  provider: AIProvider | null;
  now?: () => Date;
  /** วันหยุด/วันลา (yyyy-mm-dd) ต่อ tenant — best-effort (ไม่มี = ไม่ยกเว้นเพิ่ม) */
  holidays?: ReadonlySet<string>;
};

export type EvalWorkerSummary = {
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
  payload: {
    scope?: string;
    conversation_case_id?: string;
    employee_id?: string;
    period_start?: string;
    period_end?: string;
  } | null;
  attempts: number;
  max_attempts: number;
};

type AnalysisRow = {
  chat_group_id: string;
  summary: string | null;
  problems: unknown;
  evidence: unknown;
};

const VALID_SCOPES = new Set(["case", "daily", "weekly", "monthly"]);

/** โหลด context สรุป (redact แล้ว) ของเคสที่ประเมิน → ทำ qualitative */
async function loadQualitative(
  db: SupabaseClient,
  provider: AIProvider | null,
  job: JobRow
): Promise<{ scores: QualitativeScores; confidence?: number }> {
  const tenantId = job.tenant_id;
  const employeeId = job.payload?.employee_id;
  if (!employeeId) return { scores: {} };

  // หา chat_group ของเคสที่เกี่ยวข้อง (owner = พนักงาน)
  let caseQuery = db
    .from("conversation_cases")
    .select("id, chat_group_id")
    .eq("tenant_id", tenantId)
    .eq("owner_employee_id", employeeId)
    .is("deleted_at", null);
  if (job.payload?.conversation_case_id) {
    caseQuery = caseQuery.eq("id", job.payload.conversation_case_id);
  } else {
    if (job.payload?.period_start) caseQuery = caseQuery.gte("opened_at", job.payload.period_start);
    if (job.payload?.period_end) caseQuery = caseQuery.lte("opened_at", job.payload.period_end);
  }
  const { data: caseData } = await caseQuery;
  const cases = (caseData ?? []) as { id: string; chat_group_id: string }[];
  if (cases.length === 0) return { scores: {} };

  const groupIds = [...new Set(cases.map((c) => c.chat_group_id))];
  const { data: aData } = await db
    .from("ai_chat_analysis")
    .select("chat_group_id, summary, problems, evidence")
    .eq("tenant_id", tenantId)
    .in("chat_group_id", groupIds)
    .is("deleted_at", null);
  const analyses = (aData ?? []) as AnalysisRow[];

  // problem types + summaries + quotes (จาก ai_chat_analysis — redact แล้ว)
  const problemTypes = new Set<string>();
  const summaries: string[] = [];
  const quotes: string[] = [];
  const problemCtx: ProblemContext[] = [];
  for (const a of analyses) {
    if (a.summary) summaries.push(a.summary);
    const types: string[] = [];
    if (Array.isArray(a.problems)) {
      for (const p of a.problems) {
        const t = (p as { type?: string })?.type;
        if (t) {
          types.push(t);
          problemTypes.add(t);
        }
      }
    }
    if (Array.isArray(a.evidence)) {
      for (const e of a.evidence) {
        const q = (e as { quote?: string })?.quote;
        if (q) quotes.push(q);
      }
    }
    problemCtx.push({ caseId: a.chat_group_id, problemTypes: types });
  }

  // (A) AI — ถ้ามี provider ลองให้คะแนนจากสรุป (ที่ redact แล้ว)
  if (provider && summaries.length > 0) {
    const ctx: QualitativeContext = {
      summaries,
      problemTypes: [...problemTypes],
      evidenceQuotes: quotes,
    };
    const ai = await scoreQualitativeWithAI(provider, ctx);
    if (ai) return { scores: ai.scores, confidence: ai.confidence };
  }

  // (B) fallback deterministic จากประเภทปัญหา
  return { scores: deriveQualitativeFromProblems(problemCtx) };
}

async function processJob(
  deps: EvalWorkerDeps,
  job: JobRow,
  now: Date
): Promise<"done" | "retry" | "dead"> {
  const { db, provider } = deps;

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

  const employeeId = job.payload?.employee_id;
  const scope = (job.payload?.scope ?? "case") as EvaluateScope;
  if (!employeeId) return fail("missing_employee_id");
  if (!VALID_SCOPES.has(scope)) return fail("invalid_scope");

  const qual = await loadQualitative(db, provider, job);

  const res = await evaluateAccountant(db, {
    tenantId: job.tenant_id,
    employeeId,
    scope,
    conversationCaseId: job.payload?.conversation_case_id ?? null,
    periodStart: job.payload?.period_start ?? null,
    periodEnd: job.payload?.period_end ?? null,
    qualitative: qual.scores,
    holidays: deps.holidays,
    provider: provider?.name ?? null,
    model: provider?.model ?? null,
  });

  // ไม่มีเคสให้ประเมิน = ไม่ใช่ error (เคสอาจถูกลบ/ย้าย owner) → done
  if (res.skipped && res.reason === "no_cases_to_evaluate") {
    await markDone();
    return "done";
  }
  if (res.skipped) return fail(res.reason ?? "evaluate_failed");

  await markDone();
  return "done";
}

export async function processEvaluationJobs(
  deps: EvalWorkerDeps,
  opts: { limit?: number } = {}
): Promise<EvalWorkerSummary> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const limit = opts.limit ?? DEFAULT_BATCH;

  const summary: EvalWorkerSummary = {
    processed: 0,
    done: 0,
    failed: 0,
    dead: 0,
    skipped: false,
  };

  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - STALE_LOCK_MS).toISOString();
  const { data: jobs, error } = await db
    .from("job_queue")
    .select("id, tenant_id, payload, attempts, max_attempts")
    .eq("queue", "evaluation")
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
