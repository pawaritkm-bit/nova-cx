import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canReviewEvaluation,
  canAppeal,
  canResolveAppeal,
  type Viewer,
} from "./access";

/**
 * Manager review + Appeal actions (Phase 4) — ★ guard tier แล้วเรียก RPC (atomic + audit)
 *   - serviceDb : service-role client (RPC เขียน DB, bypass RLS)
 *   - viewer    : context ผู้ใช้ (resolve จาก session — ห้ามเชื่อ client)
 *   ★ guard ที่นี่ = ด่านสอง (ด่านแรกคือ RLS/RPC ownership check ใน DB)
 *     accountant confirm/edit/reject ไม่ได้; อุทธรณ์ได้เฉพาะเจ้าของ eval
 */

export class EvalAuthError extends Error {
  constructor(message = "คุณไม่มีสิทธิ์ทำรายการนี้") {
    super(message);
    this.name = "EvalAuthError";
  }
}

/** โหลด eval (employee_id + status) เพื่อ guard tier — null = ไม่พบ/นอก tenant */
async function loadEvalMeta(
  serviceDb: SupabaseClient,
  tenantId: string,
  evaluationId: string
): Promise<{ employeeId: string; status: string } | null> {
  const { data } = await serviceDb
    .from("accountant_evaluations")
    .select("employee_id, status")
    .eq("id", evaluationId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as { employee_id?: string; status?: string } | null;
  if (!row?.employee_id || !row.status) return null;
  return { employeeId: row.employee_id, status: row.status };
}

export type ManagerReviewParams = {
  tenantId: string;
  evaluationId: string;
  action: "confirm" | "edit" | "reject";
  adjustedDimensionScores?: Record<string, number> | null;
  adjustedOverall?: number | null;
  note?: string | null;
  actorUserId?: string | null;
};

/** หัวหน้า confirm/edit/reject — guard tier + เรียก record_manager_review */
export async function applyManagerReview(
  serviceDb: SupabaseClient,
  viewer: Viewer,
  params: ManagerReviewParams
): Promise<{ evaluationId: string; fromStatus: string; toStatus: string }> {
  const meta = await loadEvalMeta(serviceDb, params.tenantId, params.evaluationId);
  if (!meta) throw new EvalAuthError("ไม่พบรายการประเมิน");

  // ★ guard: ต้องเป็นหัวหน้าทีมของนักบัญชีคนนั้น หรือ admin/executive
  if (!canReviewEvaluation(viewer, meta.employeeId)) {
    throw new EvalAuthError();
  }

  const { data, error } = await serviceDb.rpc("record_manager_review", {
    p_tenant_id: params.tenantId,
    p_evaluation_id: params.evaluationId,
    p_reviewer_emp_id: viewer.employeeId,
    p_action: params.action,
    p_adjusted_dimension: params.adjustedDimensionScores ?? null,
    p_adjusted_overall: params.adjustedOverall ?? null,
    p_note: params.note ?? null,
    p_actor_user_id: params.actorUserId ?? null,
  });
  if (error) throw new Error(`review_failed:${(error as { code?: string }).code ?? "err"}`);
  const res = (data ?? {}) as { from_status?: string; to_status?: string };
  return {
    evaluationId: params.evaluationId,
    fromStatus: res.from_status ?? meta.status,
    toStatus: res.to_status ?? params.action,
  };
}

export type SubmitAppealParams = {
  tenantId: string;
  evaluationId: string;
  reason: string;
  actorUserId?: string | null;
};

/** นักบัญชียื่นอุทธรณ์ — guard เฉพาะเจ้าของ eval + สถานะอุทธรณ์ได้ */
export async function submitAppeal(
  serviceDb: SupabaseClient,
  viewer: Viewer,
  params: SubmitAppealParams
): Promise<{ appealId: string; evaluationId: string }> {
  const meta = await loadEvalMeta(serviceDb, params.tenantId, params.evaluationId);
  if (!meta) throw new EvalAuthError("ไม่พบรายการประเมิน");

  // ★ guard: ต้องเป็นเจ้าของ eval + สถานะอุทธรณ์ได้ (confirmed/edited)
  if (!canAppeal(viewer, meta.employeeId, meta.status)) {
    throw new EvalAuthError("อุทธรณ์ได้เฉพาะเจ้าของผลประเมินหลังหัวหน้ายืนยันแล้ว");
  }
  if (!params.reason || !params.reason.trim()) {
    throw new EvalAuthError("กรุณาระบุเหตุผลการอุทธรณ์");
  }

  const { data, error } = await serviceDb.rpc("submit_evaluation_appeal", {
    p_tenant_id: params.tenantId,
    p_evaluation_id: params.evaluationId,
    p_employee_id: viewer.employeeId,
    p_reason: params.reason.trim(),
    p_actor_user_id: params.actorUserId ?? null,
  });
  if (error) throw new Error(`appeal_failed:${(error as { code?: string }).code ?? "err"}`);
  const res = (data ?? {}) as { appeal_id?: string };
  return { appealId: res.appeal_id ?? "", evaluationId: params.evaluationId };
}

export type ResolveAppealParams = {
  tenantId: string;
  appealId: string;
  evaluationEmployeeId: string; // เจ้าของ eval (ไว้ guard tier)
  decision: "accepted" | "rejected";
  managerResponse?: string | null;
  adjustedOverall?: number | null;
  adjustedDimensionScores?: Record<string, number> | null;
  actorUserId?: string | null;
};

/** หัวหน้าตัดสินคำอุทธรณ์ — guard tier + เรียก resolve_evaluation_appeal */
export async function resolveAppeal(
  serviceDb: SupabaseClient,
  viewer: Viewer,
  params: ResolveAppealParams
): Promise<{ appealId: string; decision: string }> {
  // ★ guard: หัวหน้าทีมของเจ้าของ eval หรือ admin/executive
  if (!canResolveAppeal(viewer, params.evaluationEmployeeId)) {
    throw new EvalAuthError();
  }

  const { data, error } = await serviceDb.rpc("resolve_evaluation_appeal", {
    p_tenant_id: params.tenantId,
    p_appeal_id: params.appealId,
    p_resolver_emp_id: viewer.employeeId,
    p_decision: params.decision,
    p_manager_response: params.managerResponse ?? null,
    p_adjusted_overall: params.adjustedOverall ?? null,
    p_adjusted_dimension: params.adjustedDimensionScores ?? null,
    p_actor_user_id: params.actorUserId ?? null,
  });
  if (error) throw new Error(`resolve_failed:${(error as { code?: string }).code ?? "err"}`);
  const res = (data ?? {}) as { decision?: string };
  return { appealId: params.appealId, decision: res.decision ?? params.decision };
}
