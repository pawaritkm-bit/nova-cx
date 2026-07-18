/**
 * อ่าน "คำตอบแบบประเมินรายบุคคล" สำหรับหน้า /surveys (แท็บ "คำตอบรายบุคคล")
 *
 * ★ ไฟล์นี้ให้ผู้บริหาร/แอดมิน "เรียงดูได้ว่าแต่ละคำตอบเป็นของลูกค้าคนไหน"
 *   จึง expose ตัวตนลูกค้า (ชื่อ + customer_code) — ซึ่งขัดกับ pseudonymity ของ role อื่น
 *   ⇒ ต้องเรียกผ่าน "service-role client" หลัง guard admin/executive ที่ page layer เท่านั้น
 *     (service-role bypass RLS + column-REVOKE 0027 ได้; app-layer guard คือด่านกันสิทธิ์)
 *   ไม่ decrypt เบอร์/อีเมล (phone_enc/email_enc) — แสดงแค่ชื่อ/รหัสลูกค้าที่ผู้บริหารเห็นได้อยู่แล้ว
 *
 * ทุก query scope ด้วย tenantId (จาก session) เสมอ และนับเฉพาะ invitation ที่ deleted_at is null
 * (ให้ตรงกับ dashboard ที่ขับด้วย invitation.deleted_at)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { SURVEY_TYPES, type SurveyType } from "@/lib/survey/types";

type DB = SupabaseClient;

/** นักบัญชี/พนักงานที่ถูกประเมินใน 1 คำตอบ (เฉพาะ Form B) */
export type EvaluatedEmployeeView = {
  employeeId: string;
  /** ชื่อที่แสดง = ชื่อเล่นถ้ามี ไม่งั้นชื่อจริง */
  name: string;
  subjectRole: string;
};

/** 1 แถว = 1 คำตอบแบบประเมิน (survey_responses 1 แถว) */
export type IndividualResponseView = {
  responseId: string;
  surveyType: SurveyType;
  submittedAt: string | null;
  customerName: string | null;
  customerCode: string | null;
  /** CSAT ภาพรวม (dimension='overall') ถ้าไม่มีใช้ค่าเฉลี่ยของมิติที่มี */
  csatOverall: number | null;
  npsScore: number | null;
  npsCategory: string | null;
  aiSentiment: string | null;
  aiUrgency: string | null;
  aiSummary: string | null;
  /** Form B: นักบัญชีที่ถูกประเมิน (ฟอร์มอื่นเป็น []) */
  evaluatedEmployees: EvaluatedEmployeeView[];
};

export type GetIndividualResponsesOptions = {
  /** กรองเฉพาะชนิดฟอร์ม (A/B/C/D) — ไม่ระบุ = ทุกฟอร์ม */
  surveyType?: SurveyType | null;
  /** จำกัดจำนวนแถว (กันดึงหนักเกิน) — ค่าเริ่มต้น 500 */
  limit?: number;
};

/**
 * ผลลัพธ์ของ getIndividualResponses
 * ★ truncated=true = มีคำตอบมากกว่า limit (ถูกตัด) → caller ต้องเตือนผู้บริหาร ไม่ให้เข้าใจผิดว่าเห็นครบ
 */
export type IndividualResponsesResult = {
  rows: IndividualResponseView[];
  /** ยังมีคำตอบมากกว่าที่แสดง (ถูกตัดที่ limit) หรือไม่ */
  truncated: boolean;
  /** เพดานจำนวนแถวที่ใช้ในรอบนี้ */
  limit: number;
};

/** shape ของแถวที่ได้จาก PostgREST embed (nested) — ประกาศไว้กันชนิดหลุด */
type RawRow = {
  id: string;
  submitted_at: string | null;
  survey_invitations: { survey_type: string; deleted_at: string | null } | null;
  customers: { name: string | null; customer_code: string | null } | null;
  satisfaction_scores:
    | { dimension: string; score: number | string | null; deleted_at: string | null }[]
    | null;
  nps_scores:
    | { score_0_10: number | null; category: string | null; deleted_at: string | null }[]
    | null;
  ai_feedback_analysis:
    | { sentiment: string | null; urgency: string | null; summary: string | null; deleted_at: string | null }[]
    | null;
  employee_evaluations:
    | {
        employee_id: string;
        subject_role: string | null;
        deleted_at: string | null;
        employees: { first_name: string | null; nickname: string | null } | null;
      }[]
    | null;
};

const DEFAULT_LIMIT = 500;

/** ตัวเลข: ยอมรับได้ทั้ง number/string(numeric ของ pg) → number | null */
function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/** เลือก CSAT ภาพรวม: ใช้ 'overall' ก่อน ไม่มีก็เฉลี่ยมิติที่เหลือ (เฉพาะแถว active) */
function pickCsatOverall(rows: RawRow["satisfaction_scores"]): number | null {
  const active = (rows ?? []).filter((r) => r.deleted_at == null);
  if (active.length === 0) return null;

  const overall = active.find((r) => r.dimension === "overall");
  if (overall) return toNum(overall.score);

  const nums = active.map((r) => toNum(r.score)).filter((n): n is number => n != null);
  if (nums.length === 0) return null;
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return Math.round(avg * 100) / 100;
}

/**
 * ดึงคำตอบรายบุคคลของ tenant (ใหม่→เก่า) พร้อมตัวตนลูกค้า + คะแนน + ผล AI + (B) นักบัญชีที่ถูกประเมิน
 *
 * @param db       ★ ต้องเป็น service-role client (bypass RLS/column-REVOKE) — caller ต้อง guard admin/exec ก่อน
 * @param tenantId scope จาก session เสมอ
 */
export async function getIndividualResponses(
  db: DB,
  tenantId: string,
  opts: GetIndividualResponsesOptions = {}
): Promise<IndividualResponsesResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // 1 query เดียวด้วย PostgREST embed:
  //   - survey_invitations!inner → บังคับต้องมี invitation + ดึง survey_type/deleted_at
  //   - customers ผูกจาก survey_responses.customer_id (ตัวตนลูกค้า)
  //   - คะแนน/AI/employee_evaluations ผูกด้วย response_id (reverse embed → array)
  let query = db
    .from("survey_responses")
    .select(
      `id,
       submitted_at,
       survey_invitations!inner ( survey_type, deleted_at ),
       customers ( name, customer_code ),
       satisfaction_scores ( dimension, score, deleted_at ),
       nps_scores ( score_0_10, category, deleted_at ),
       ai_feedback_analysis ( sentiment, urgency, summary, deleted_at ),
       employee_evaluations ( employee_id, subject_role, deleted_at, employees ( first_name, nickname ) )`
    )
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    // ★ นับเฉพาะ invitation ที่ยังไม่ถูกลบ (ให้ตรง dashboard)
    .is("survey_invitations.deleted_at", null)
    .order("submitted_at", { ascending: false, nullsFirst: false })
    // ★ ดึงเกิน 1 แถวเพื่อ "รู้ว่ามีมากกว่า limit ไหม" (silent truncation → เตือนผู้บริหารได้)
    .limit(limit + 1);

  // กรองชนิดฟอร์มฝั่ง server (ถ้าระบุ) — เฉพาะ A/B/C/D ที่ถูกต้องเท่านั้น
  if (opts.surveyType && (SURVEY_TYPES as readonly string[]).includes(opts.surveyType)) {
    query = query.eq("survey_invitations.survey_type", opts.surveyType);
  }

  const { data, error } = await query;
  if (error) throw error;

  const fetched = (data ?? []) as unknown as RawRow[];

  // ตัดกลับเหลือ limit + ตั้ง flag เมื่อมีมากกว่า (query ดึง limit+1)
  const truncated = fetched.length > limit;
  const rows = truncated ? fetched.slice(0, limit) : fetched;
  if (truncated) {
    console.warn(
      `[getIndividualResponses] tenant=${tenantId} มีคำตอบมากกว่า limit=${limit} — แสดงเฉพาะ ${limit} แถวล่าสุด`
    );
  }

  const mapped = rows.map((r) => {
    const npsActive = (r.nps_scores ?? []).find((n) => n.deleted_at == null) ?? null;
    const aiActive = (r.ai_feedback_analysis ?? []).find((a) => a.deleted_at == null) ?? null;

    const evaluatedEmployees: EvaluatedEmployeeView[] = (r.employee_evaluations ?? [])
      .filter((e) => e.deleted_at == null)
      .map((e) => {
        const emp = e.employees;
        const name = emp?.nickname?.trim() || emp?.first_name?.trim() || "(ไม่ทราบชื่อ)";
        return {
          employeeId: e.employee_id,
          name,
          subjectRole: e.subject_role ?? "unknown",
        };
      });

    return {
      responseId: r.id,
      surveyType: (r.survey_invitations?.survey_type ?? "A") as SurveyType,
      submittedAt: r.submitted_at,
      customerName: r.customers?.name ?? null,
      customerCode: r.customers?.customer_code ?? null,
      csatOverall: pickCsatOverall(r.satisfaction_scores),
      npsScore: npsActive ? npsActive.score_0_10 : null,
      npsCategory: npsActive?.category ?? null,
      aiSentiment: aiActive?.sentiment ?? null,
      aiUrgency: aiActive?.urgency ?? null,
      aiSummary: aiActive?.summary ?? null,
      evaluatedEmployees,
    };
  });

  return { rows: mapped, truncated, limit };
}
