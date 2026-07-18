import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Scan/Enqueue งานประเมินนักบัญชี (Phase 4) — idempotent
 *   หลังเคสถูกปิด (resolved/closed) ที่มี owner → enqueue job `evaluation` (scope=case) 1 งาน/เคส
 *   ★ idempotent 3 ชั้น:
 *     1) มี eval ของเคสนี้อยู่แล้ว (accountant_evaluations) → skip
 *     2) มี job evaluation ค้าง (pending/processing) ต่อเคส → skip
 *     3) DB partial unique index uq_job_queue_evaluation_active (กัน insert ชน → 23505 = skip)
 *
 * inject deps (now) เพื่อ test ได้โดยไม่พึ่งเวลาจริง
 */

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000; // ปิดภายใน 24 ชม.ล่าสุด
const DEFAULT_BATCH = 200;
const CLOSED_STATUSES = ["resolved", "closed"];

export type EvalScanDeps = {
  db: SupabaseClient;
  now?: () => Date;
  lookbackMs?: number;
};

export type EvalScanSummary = {
  candidates: number;
  enqueued: number;
  hasEval: number; // มี eval แล้ว → skip
  existed: number; // มี job ค้าง → skip
  failed: number;
};

type CaseRow = {
  id: string;
  tenant_id: string;
  owner_employee_id: string | null;
};

/** true = เคสนี้มี eval อยู่แล้ว (draft/confirmed/…) → ไม่ต้อง enqueue ซ้ำ */
async function hasEvaluation(db: SupabaseClient, caseId: string): Promise<boolean> {
  const { data } = await db
    .from("accountant_evaluations")
    .select("id")
    .eq("conversation_case_id", caseId)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  return !!(data as { id?: string } | null)?.id;
}

/** true = มี job evaluation ค้าง (pending/processing) ต่อเคสนี้ */
async function hasPendingJob(db: SupabaseClient, caseId: string): Promise<boolean> {
  const { data } = await db
    .from("job_queue")
    .select("id")
    .eq("queue", "evaluation")
    .in("status", ["pending", "processing"])
    .eq("payload->>conversation_case_id", caseId)
    .limit(1)
    .maybeSingle();
  return !!(data as { id?: string } | null)?.id;
}

export async function scanCaseEvaluations(
  deps: EvalScanDeps,
  opts: { limit?: number } = {}
): Promise<EvalScanSummary> {
  const { db } = deps;
  const now = deps.now ? deps.now() : new Date();
  const lookback = deps.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const sinceIso = new Date(now.getTime() - lookback).toISOString();
  const limit = opts.limit ?? DEFAULT_BATCH;

  const summary: EvalScanSummary = {
    candidates: 0,
    enqueued: 0,
    hasEval: 0,
    existed: 0,
    failed: 0,
  };

  // เคสปิดแล้ว มี owner ในช่วง lookback
  const { data, error } = await db
    .from("conversation_cases")
    .select("id, tenant_id, owner_employee_id")
    .in("status", CLOSED_STATUSES)
    .not("owner_employee_id", "is", null)
    .gte("closed_at", sinceIso)
    .is("deleted_at", null)
    .limit(limit);
  if (error) return summary;

  const cases = (data ?? []) as CaseRow[];
  summary.candidates = cases.length;

  for (const c of cases) {
    if (!c.owner_employee_id) continue;
    try {
      if (await hasEvaluation(db, c.id)) {
        summary.hasEval += 1;
        continue;
      }
      if (await hasPendingJob(db, c.id)) {
        summary.existed += 1;
        continue;
      }
      const { error: insErr } = await db.from("job_queue").insert({
        tenant_id: c.tenant_id,
        queue: "evaluation",
        payload: {
          scope: "case",
          conversation_case_id: c.id,
          employee_id: c.owner_employee_id,
        },
      });
      if (insErr) {
        // 23505 = ชน partial unique index (มี job ค้าง) → idempotent skip ไม่ใช่ error
        if ((insErr as { code?: string }).code === "23505") summary.existed += 1;
        else summary.failed += 1;
      } else {
        summary.enqueued += 1;
      }
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}
