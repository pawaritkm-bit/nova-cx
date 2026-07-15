import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurveyType } from "./types";
import type { CsatResult, NpsResult } from "./scoring";

/**
 * ชั้นเข้าถึง DB ของ Survey Engine (ใช้ service-role client จาก route)
 *   - อ่าน template/version (versioned JSON)
 *   - อ่าน invitation ตาม token
 *   - เขียน response/answers/scores แบบ transaction เชิงตรรกะ (best-effort)
 *
 * หมายเหตุ: Supabase JS ไม่มี multi-statement transaction ฝั่ง client
 *   → ใช้ลำดับ insert + จับ error unique constraint; ถ้าต้องการ atomic เต็ม
 *     ให้ย้ายเป็น RPC (SECURITY DEFINER) ใน chunk ถัดไป (ระบุใน TODO)
 */

type DB = SupabaseClient;

export type SurveyVersionRow = {
  id: string;
  tenant_id: string;
  template_id: string;
  version_no: number;
  schema_json: unknown;
  published_at: string | null;
};

export type SurveyTemplateRow = {
  id: string;
  tenant_id: string;
  survey_type: SurveyType;
  name: string;
  is_active: boolean;
};

export type InvitationRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  line_user_id: string | null;
  survey_type: SurveyType;
  survey_version_id: string;
  opportunity_id: string | null;
  cycle_period: string;
  assignee_snapshot: unknown;
  token: string;
  token_expires_at: string | null;
  status: string;
};

/** ดึง template ที่ active + version ล่าสุดที่ published ตามชนิด */
export async function getActiveVersionByType(
  db: DB,
  tenantId: string | null,
  surveyType: SurveyType
): Promise<{ template: SurveyTemplateRow; version: SurveyVersionRow } | null> {
  let templateQuery = db
    .from("survey_templates")
    .select("id, tenant_id, survey_type, name, is_active")
    .eq("survey_type", surveyType)
    .eq("is_active", true)
    .is("deleted_at", null);

  if (tenantId) templateQuery = templateQuery.eq("tenant_id", tenantId);

  const { data: template, error: tErr } = await templateQuery
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (tErr || !template) return null;

  const { data: version, error: vErr } = await db
    .from("survey_versions")
    .select("id, tenant_id, template_id, version_no, schema_json, published_at")
    .eq("template_id", (template as SurveyTemplateRow).id)
    .is("deleted_at", null)
    .not("published_at", "is", null)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (vErr || !version) return null;

  return {
    template: template as SurveyTemplateRow,
    version: version as SurveyVersionRow,
  };
}

/** ดึง invitation ตาม token (single-use scope) */
export async function getInvitationByToken(
  db: DB,
  token: string
): Promise<InvitationRow | null> {
  const { data, error } = await db
    .from("survey_invitations")
    .select(
      "id, tenant_id, customer_id, line_user_id, survey_type, survey_version_id, opportunity_id, cycle_period, assignee_snapshot, token, token_expires_at, status"
    )
    .eq("token", token)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !data) return null;
  return data as InvitationRow;
}

/** ดึง schema_json ของ version */
export async function getVersionById(
  db: DB,
  versionId: string
): Promise<SurveyVersionRow | null> {
  const { data, error } = await db
    .from("survey_versions")
    .select("id, tenant_id, template_id, version_no, schema_json, published_at")
    .eq("id", versionId)
    .maybeSingle();

  if (error || !data) return null;
  return data as SurveyVersionRow;
}

/** ดึงข้อมูลลูกค้าสำหรับ auto-fill ข้อมูลอ้างอิง (ไม่รวม PII) */
export async function getCustomerRef(
  db: DB,
  customerId: string
): Promise<{
  customer_code: string | null;
  name: string;
  business_name: string | null;
  service_start_date: string | null;
} | null> {
  const { data, error } = await db
    .from("customers")
    .select("customer_code, name, business_name, service_start_date")
    .eq("id", customerId)
    .maybeSingle();

  if (error || !data) return null;
  return data as {
    customer_code: string | null;
    name: string;
    business_name: string | null;
    service_start_date: string | null;
  };
}

/** error เมื่อพยายามตอบซ้ำ (ตอบ invitation นี้ไปแล้ว) */
export class DuplicateSubmissionError extends Error {
  constructor() {
    super("ตอบแบบประเมินนี้ไปแล้ว");
    this.name = "DuplicateSubmissionError";
  }
}

type SnapshotItem = {
  employee_id?: string;
  subject_role?: string;
  name?: string;
};

function parseSnapshot(raw: unknown): SnapshotItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is SnapshotItem =>
      !!x && typeof x === "object" && typeof (x as SnapshotItem).employee_id === "string"
  );
}

/** payload consent ที่จะบันทึกลง consent_records (ผ่าน RPC) */
export type ConsentInput = { policy_version: string; purpose: unknown } | null;

/**
 * บันทึกผลแบบประเมินแบบ ATOMIC ผ่าน RPC เดียว (Reviewer 🔴#1)
 *   - response + answers + scores + nps + Form B eval + consent + ปิด invitation + enqueue AI
 *   - อยู่ใน transaction เดียว → ล้มกลางคัน rollback ทั้งหมด (ไม่มี invitation ค้าง)
 *   - ตอบซ้ำ (P0001 / 23505) → DuplicateSubmissionError
 */
export async function persistSurveyResponse(
  db: DB,
  args: {
    invitation: InvitationRow;
    answers: Record<string, unknown>;
    csat: CsatResult;
    nps: NpsResult;
    consent: ConsentInput;
  }
): Promise<{ responseId: string }> {
  const { invitation, answers, csat, nps, consent } = args;

  // ตัด key ที่ value เป็น undefined ออก (JSON null คงไว้ได้ — jsonb เก็บ 'null')
  const cleanAnswers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(answers)) {
    if (v !== undefined) cleanAnswers[k] = v ?? null;
  }

  const { data, error } = await db.rpc("submit_survey_response", {
    p_invitation_id: invitation.id,
    p_answers: cleanAnswers,
    p_csat_overall: csat.overall,
    p_csat_dimensions: csat.dimensions,
    p_nps: nps,
    p_consent: consent,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    const msg = (error as { message?: string }).message ?? "";
    if (code === "23505" || code === "P0001" || msg.includes("already_responded")) {
      throw new DuplicateSubmissionError();
    }
    // โยน error กลางๆ ให้ route แปลงเป็น generic (ไม่ส่ง DB error ดิบ)
    throw new Error("submit_failed");
  }

  return { responseId: data as string };
}

/** คืนรายชื่อผู้ถูกประเมิน (Form B) จาก assignee snapshot ของ invitation */
export function getEvaluationSubjects(
  invitation: InvitationRow
): SnapshotItem[] {
  return parseSnapshot(invitation.assignee_snapshot);
}
