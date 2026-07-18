/**
 * Chat Audit — รายละเอียดการประเมินนักบัญชี 1 ใบ (สำหรับหน้า review + appeal)
 *   ★ ความปลอดภัย:
 *     - อ่านผ่าน scoped client → RLS tier-aware (0035) บังคับว่าใครเห็นอะไร
 *       (accountant=ของตัวเอง, acc_lead=ทีม, privileged=ทั้งหมด, hr=confirmed คะแนน)
 *     - ซ้ำด้วย access.ts app-layer เพื่อคุมปุ่ม review/appeal (default-deny)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canReviewEvaluation,
  canAppeal,
  canViewEvidence,
  type Viewer,
} from "@/lib/evaluation/access";
import type { AccountantEvaluationRow } from "./types";

/** 8 มิติการประเมิน (ตรงกับ evaluation_weights / dimension_scores) */
export const EVAL_DIMENSIONS: { key: string; label: string }[] = [
  { key: "correctness", label: "ความถูกต้อง" },
  { key: "completeness", label: "ความครบถ้วน" },
  { key: "sla", label: "เร็วตาม SLA" },
  { key: "clarity", label: "ความชัดเจน" },
  { key: "politeness", label: "สุภาพ/เข้าใจลูกค้า" },
  { key: "ownership", label: "รับผิดชอบ/ติดตาม" },
  { key: "resolution", label: "ปิดเคส" },
  { key: "sop", label: "ตาม SOP" },
];

export type EvidenceRow = {
  id: string;
  chat_message_id: string | null;
  dimension: string;
  impact: string; // gain/loss
  note: string | null;
  sent_at: string | null;
};

export type ManagerReviewRow = {
  id: string;
  action: string;
  adjusted_overall: number | null;
  note: string | null;
  reviewed_at: string;
};

export type AppealRow = {
  id: string;
  reason: string;
  status: string;
  manager_response: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type EvaluationDetail = {
  evaluation: AccountantEvaluationRow;
  employeeName: string;
  weights: Record<string, number>;
  evidence: EvidenceRow[];
  reviews: ManagerReviewRow[];
  appeals: AppealRow[];
  /** ผู้ใช้ยืนยัน/แก้/ยกเลิกได้ไหม (หัวหน้า/ผู้บริหาร) */
  canReview: boolean;
  /** ผู้ใช้ (นักบัญชีเจ้าของ) อุทธรณ์ได้ไหม */
  canAppealNow: boolean;
  /** เห็นหลักฐานแชตดิบไหม (hr = false) */
  canSeeEvidence: boolean;
};

const DEFAULT_WEIGHTS: Record<string, number> = {
  correctness: 20,
  completeness: 10,
  sla: 15,
  clarity: 10,
  politeness: 10,
  ownership: 15,
  resolution: 10,
  sop: 10,
};

export async function getEvaluationDetail(
  db: SupabaseClient,
  viewer: Viewer,
  evaluationId: string
): Promise<EvaluationDetail | null> {
  // RLS จะคืน 0 แถวถ้าไม่มีสิทธิ์ → null (default-deny โดยธรรมชาติ)
  const { data: evalData } = await db
    .from("accountant_evaluations")
    .select(
      "id, employee_id, scope, conversation_case_id, period_start, period_end, overall_score, dimension_scores, strengths, improvements, better_examples, confidence, status, needs_review"
    )
    .eq("id", evaluationId)
    .is("deleted_at", null)
    .maybeSingle();
  const evaluation = (evalData as AccountantEvaluationRow | null) ?? null;
  if (!evaluation) return null;

  const empId = evaluation.employee_id;
  const canSeeEvidence = canViewEvidence(viewer, empId);

  const [{ data: wData }, { data: empData }, { data: revData }, { data: appData }] =
    await Promise.all([
      db.from("evaluation_weights").select("weights").eq("is_active", true).is("deleted_at", null).limit(1),
      db.from("employees").select("first_name, nickname").eq("id", empId).maybeSingle(),
      db
        .from("manager_reviews")
        .select("id, action, adjusted_overall, note, reviewed_at")
        .eq("evaluation_id", evaluationId)
        .order("reviewed_at", { ascending: false })
        .limit(50),
      db
        .from("evaluation_appeals")
        .select("id, reason, status, manager_response, created_at, resolved_at")
        .eq("evaluation_id", evaluationId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  // evidence เห็นเฉพาะผู้มีสิทธิ์ (hr ไม่เห็น) — ไม่ query เลยถ้าไม่มีสิทธิ์ (กัน leak)
  let evidence: EvidenceRow[] = [];
  if (canSeeEvidence) {
    const { data: evData } = await db
      .from("evaluation_evidence")
      .select("id, chat_message_id, dimension, impact, note, sent_at")
      .eq("evaluation_id", evaluationId)
      .limit(100);
    evidence = (evData ?? []) as EvidenceRow[];
  }

  const weightsRow = (wData ?? [])[0] as { weights: Record<string, number> } | undefined;
  const weights = weightsRow?.weights ?? DEFAULT_WEIGHTS;
  const emp = empData as { first_name: string | null; nickname: string | null } | null;
  const employeeName = emp?.nickname || emp?.first_name || empId.slice(0, 8);

  return {
    evaluation,
    employeeName,
    weights,
    evidence,
    reviews: (revData ?? []) as ManagerReviewRow[],
    appeals: (appData ?? []) as AppealRow[],
    canReview: canReviewEvaluation(viewer, empId),
    canAppealNow: canAppeal(viewer, empId, evaluation.status),
    canSeeEvidence,
  };
}
