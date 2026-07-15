/**
 * Dashboard data layer — อ่านจาก visibility views (0025) ผ่าน "scoped client"
 *   ★ สำคัญด้านความปลอดภัย:
 *     - dashboard พนักงาน "ต้อง" ใช้ scoped client (anon key + session cookie)
 *       ไม่ใช่ service-role → scope/visibility บังคับโดย view + auth.uid()
 *     - view ตัดชื่อลูกค้าออกให้ผู้ถูกประเมินแล้ว (v_feedback_for_evaluatee)
 *     - ฟังก์ชันเหล่านี้ "ไม่" เลือกว่า user เห็นอะไร (view/RLS เป็นคนคุม);
 *       พารามิเตอร์ role ใช้แค่ตัดสินใจว่าจะ "ประกอบหน้าไหน" เท่านั้น
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeCsat,
  computeNps,
  computeResponseRate,
  groupScores,
} from "./aggregate";
import { pickBestWorst } from "./sample-size";
import { redactFeedbackRows } from "./redact";
import type {
  ExecDashboard,
  AccountantDashboard,
  LeadDashboard,
  ResponseFactRow,
  TeamScoreRow,
  CaseFactRow,
  EvaluateeFeedbackRow,
  TrackingRow,
  CaseSummary,
} from "./types";

type DB = SupabaseClient;

/** นับความถี่ตาม key → Record<key, count> */
function countBy<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const CLOSED_STATUSES = new Set(["resolved", "closed"]);

function summarizeCases(rows: CaseFactRow[]): CaseSummary {
  const byStatus = countBy(rows, (r) => r.status);
  const byLevel = countBy(rows, (r) => r.level);
  const open = rows.filter((r) => !CLOSED_STATUSES.has(r.status)).length;
  const urgent = rows.filter(
    (r) => (r.level === "critical" || r.level === "high") && !CLOSED_STATUSES.has(r.status)
  ).length;
  const retentionRisk = rows.filter(
    (r) => r.type === "retention" && !CLOSED_STATUSES.has(r.status)
  ).length;

  const closed = rows.filter((r) => r.closed_at && r.created_at);
  let avgResolutionHours: number | null = null;
  if (closed.length > 0) {
    const totalHrs = closed.reduce((acc, r) => {
      const start = new Date(r.created_at).getTime();
      const end = new Date(r.closed_at as string).getTime();
      return acc + Math.max(0, end - start) / 3_600_000;
    }, 0);
    avgResolutionHours = Math.round((totalHrs / closed.length) * 10) / 10;
  }

  return { byStatus, byLevel, open, urgent, retentionRisk, avgResolutionHours };
}

// ---------------------------------------------------------------------
// Executive — ภาพรวมทั้ง tenant (view scope = privileged เห็นหมด)
// ---------------------------------------------------------------------
export async function getExecDashboard(db: DB): Promise<ExecDashboard> {
  const [{ data: facts }, { data: teamRows }, { data: caseRows }] =
    await Promise.all([
      db
        .from("v_dashboard_response_facts")
        .select(
          "invitation_id, response_id, customer_id, survey_type, cycle_period, invitation_status, is_responded, csat_overall, nps_score, nps_category, sentiment, urgency"
        ),
      db
        .from("v_team_score_facts")
        .select("team_name, team_type, avg_score, cycle_period"),
      db
        .from("v_dashboard_case_facts")
        .select(
          "case_id, case_no, customer_id, customer_code, type, level, status, sla_due_at, created_at, closed_at, post_resolution_csat"
        ),
    ]);

  const factRows = (facts ?? []) as ResponseFactRow[];
  const teams = (teamRows ?? []) as TeamScoreRow[];
  const cases = (caseRows ?? []) as CaseFactRow[];

  const csat = computeCsat(factRows.map((r) => r.csat_overall));
  const nps = computeNps(factRows.map((r) => r.nps_category));
  const responded = factRows.filter((r) => r.is_responded === true).length;
  const responseRate = computeResponseRate(factRows.length, responded);

  const teamCsat = groupScores(
    teams,
    (r) => r.team_name,
    (r) => r.avg_score
  );
  const teamRanking = pickBestWorst(teamCsat);

  const caseSummary = summarizeCases(cases);
  const urgentCases = cases
    .filter(
      (r) =>
        (r.level === "critical" || r.level === "high") &&
        !CLOSED_STATUSES.has(r.status)
    )
    .sort((a, b) => (a.sla_due_at ?? "").localeCompare(b.sla_due_at ?? ""))
    .slice(0, 20);

  return {
    role: "executive",
    csat,
    nps,
    responseRate,
    teamCsat,
    teamRanking,
    cases: caseSummary,
    urgentCases,
  };
}

// ---------------------------------------------------------------------
// Accountant / Sales — คะแนนตัวเอง (view ตัดชื่อลูกค้า) + tracking (โทรตาม)
// ---------------------------------------------------------------------
export async function getMemberDashboard(
  db: DB,
  role: "accountant" | "sales"
): Promise<AccountantDashboard> {
  const [{ data: fbRows }, { data: trackRows }] = await Promise.all([
    db
      .from("v_feedback_for_evaluatee")
      .select(
        "evaluation_id, employee_id, subject_role, avg_score, response_id, submitted_at, survey_type, cycle, sentiment, urgency, summary, categories, next_best_action"
      ),
    db
      .from("v_customer_tracking")
      .select(
        "invitation_id, customer_id, customer_name, customer_code, survey_type, cycle_period, invitation_status, is_responded, reminder_count, has_phone, invited_at, last_reminded_at"
      ),
  ]);

  // ★ safety-net: ตัดคีย์ PII ที่อาจหลุดมา (view ตัดให้แล้ว แต่กันพลาด)
  const feedback = redactFeedbackRows(
    (fbRows ?? []) as unknown as Record<string, unknown>[]
  ) as unknown as EvaluateeFeedbackRow[];
  const tracking = (trackRows ?? []) as TrackingRow[];

  const ownScore = computeCsat(feedback.map((r) => r.avg_score));
  const trendByCycle = groupScores(
    feedback,
    (r) => r.cycle,
    (r) => r.avg_score
  ).sort((a, b) => a.label.localeCompare(b.label));

  const praises = feedback.filter((r) => r.sentiment === "positive").slice(0, 20);
  const improvements = feedback
    .filter((r) => r.sentiment === "negative")
    .slice(0, 20);

  const responded = tracking.filter((r) => r.is_responded === true).length;
  const notResponded = tracking.length - responded;
  // ★ โทรตามได้เฉพาะคนที่ "ยังไม่ประเมิน" (ตรงกับต้นแบบ) + มีเบอร์ในระบบ
  const callList = tracking
    .filter((r) => r.is_responded !== true)
    .sort((a, b) => b.reminder_count - a.reminder_count);

  return {
    role,
    ownScore,
    trendByCycle,
    praises,
    improvements,
    tracking: {
      total: tracking.length,
      responded,
      notResponded,
      responseRate: computeResponseRate(tracking.length, responded),
    },
    callList,
  };
}

// ---------------------------------------------------------------------
// Lead (หัวหน้าบัญชี/ขาย) — internal review ลูกทีม + tracking ทีม
// ---------------------------------------------------------------------
export async function getLeadDashboard(
  db: DB,
  role: "acc_lead" | "sales_lead"
): Promise<LeadDashboard> {
  const [{ data: teamRows }, { data: trackRows }] = await Promise.all([
    db
      .from("v_team_score_facts")
      .select(
        "team_id, team_name, employee_id, employee_first_name, employee_nickname, avg_score, cycle_period"
      ),
    db
      .from("v_customer_tracking")
      .select("invitation_id, is_responded"),
  ]);

  const teams = (teamRows ?? []) as TeamScoreRow[];
  const tracking = (trackRows ?? []) as Pick<TrackingRow, "is_responded">[];

  const teamScore = computeCsat(teams.map((r) => r.avg_score));
  const memberScores = groupScores(
    teams,
    (r) =>
      r.employee_nickname || r.employee_first_name || r.employee_id,
    (r) => r.avg_score
  );
  const memberRanking = pickBestWorst(memberScores);

  const responded = tracking.filter((r) => r.is_responded === true).length;
  const notResponded = tracking.length - responded;

  return {
    role,
    teamScore,
    memberScores,
    memberRanking,
    tracking: {
      total: tracking.length,
      responded,
      notResponded,
      responseRate: computeResponseRate(tracking.length, responded),
    },
  };
}
