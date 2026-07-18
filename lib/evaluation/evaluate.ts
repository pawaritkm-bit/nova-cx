import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateAccountantSignals } from "./aggregate";
import { computeEvaluationScore, type QualitativeScores } from "./scoring";
import { buildEvidence } from "./evidence";
import { buildCoaching } from "./coach";
import { DEFAULT_WEIGHTS, normalizeWeights, type Weights } from "./weights";

/**
 * Orchestrator ประเมินนักบัญชี (Phase 4) — สร้าง "ร่าง" (ai_draft) แบบ idempotent
 *   1) โหลดน้ำหนัก (evaluation_weights active) → fallback DEFAULT
 *   2) aggregate signal (conversation_cases + ai_chat_analysis + sop_violations)
 *   3) คำนวณคะแนน 8 มิติ + overall (ปรับน้ำหนัก) — มิติคุณภาพรับจาก AI (qualitative)
 *   4) สร้าง evidence (อ้าง message/เวลา) + coaching (โทนโค้ช)
 *   5) เรียก RPC persist_accountant_evaluation (atomic: eval+evidence+coaching+audit)
 *
 *   ★ ผลเป็น draft เสมอ (needs_review=true) — ห้ามใช้คะแนน AI ลงโทษอัตโนมัติ
 *   ★ ไม่ throw ให้ล้ม worker — คืน { skipped, reason } เมื่อไม่มีข้อมูล/ล้ม
 */

export type EvaluateScope = "case" | "daily" | "weekly" | "monthly";

export type EvaluateInput = {
  tenantId: string;
  employeeId: string;
  scope: EvaluateScope;
  conversationCaseId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** คะแนนเชิงคุณภาพจาก AI (correctness/completeness/clarity/politeness) — worker ส่งมา */
  qualitative?: QualitativeScores;
  /** เป้าหมายเวลาตอบครั้งแรก (นาทีทำการ) */
  firstResponseTargetMinutes?: number;
  /** วันหยุด/วันลา (yyyy-mm-dd เวลาไทย) ที่ไม่คิดโทษ SLA */
  holidays?: ReadonlySet<string>;
  model?: string | null;
  provider?: string | null;
  actorUserId?: string | null;
};

export type EvaluateResult = {
  skipped: boolean;
  reason?: string;
  evaluationId?: string;
  created?: boolean;
  overall?: number;
};

const DEFAULT_TARGET_MIN = 240;

type WeightRow = { weights: unknown };

/** โหลดน้ำหนัก active ของ tenant (fallback DEFAULT เมื่อไม่มี/พัง) */
async function loadWeights(db: SupabaseClient, tenantId: string): Promise<Weights> {
  const { data } = await db
    .from("evaluation_weights")
    .select("weights")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();
  const raw = (data as WeightRow | null)?.weights;
  if (raw && typeof raw === "object") {
    return normalizeWeights(raw as Partial<Weights>);
  }
  return { ...DEFAULT_WEIGHTS };
}

export async function evaluateAccountant(
  db: SupabaseClient,
  input: EvaluateInput
): Promise<EvaluateResult> {
  const target = input.firstResponseTargetMinutes ?? DEFAULT_TARGET_MIN;

  // 2) aggregate
  const signals = await aggregateAccountantSignals(db, {
    tenantId: input.tenantId,
    employeeId: input.employeeId,
    conversationCaseId: input.conversationCaseId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  });

  if (signals.cases.length === 0) {
    return { skipped: true, reason: "no_cases_to_evaluate" };
  }

  // 1) weights
  const weights = await loadWeights(db, input.tenantId);

  // 3) คะแนน
  const { scores, overall, breakdown } = computeEvaluationScore(
    {
      cases: signals.cases,
      qualitative: input.qualitative,
      sentiment: signals.sentiment,
      firstResponseTargetMinutes: target,
      holidays: input.holidays,
    },
    weights
  );

  // confidence: ข้อมูลมากขึ้น → มั่นใจขึ้น (แต่ยัง cap — needs_review เสมอ)
  const confidence = Math.min(0.9, 0.3 + signals.cases.length * 0.1);

  // 4) evidence + coaching
  const evidence = buildEvidence(signals.cases, {
    firstResponseTargetMinutes: target,
    holidays: input.holidays,
  });
  const period =
    input.scope === "case"
      ? input.conversationCaseId ?? null
      : `${input.periodStart ?? ""}..${input.periodEnd ?? ""}`;
  const coaching = buildCoaching({
    scores,
    breakdown,
    cases: signals.cases,
    period,
  });

  // strengths/improvements (สรุปสั้นสำหรับ eval) จาก coaching
  const strengths = coaching.strengths;
  const improvements = coaching.improvements;
  const betterExamples = coaching.example_answers;

  // 5) persist (atomic + idempotent + audit)
  const { data, error } = await db.rpc("persist_accountant_evaluation", {
    p_tenant_id: input.tenantId,
    p_employee_id: input.employeeId,
    p_scope: input.scope,
    p_conversation_case_id: input.conversationCaseId ?? null,
    p_period_start: input.periodStart ?? null,
    p_period_end: input.periodEnd ?? null,
    p_overall_score: overall,
    p_dimension_scores: scores,
    p_strengths: strengths,
    p_improvements: improvements,
    p_better_examples: betterExamples,
    p_confidence: confidence,
    p_model: input.model ?? null,
    p_provider: input.provider ?? null,
    p_evidence: evidence,
    p_coaching: coaching,
    p_actor_user_id: input.actorUserId ?? null,
  });

  if (error) {
    return { skipped: true, reason: `rpc_failed:${(error as { code?: string }).code ?? "err"}` };
  }
  const res = (data ?? {}) as { evaluation_id?: string; created?: boolean };
  return {
    skipped: false,
    evaluationId: res.evaluation_id,
    created: res.created,
    overall,
  };
}
