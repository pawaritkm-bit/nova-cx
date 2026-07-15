/**
 * รายงาน/Export พื้นฐาน (E10 บางส่วน) — อ่านจาก visibility views (0025)
 *   - อ่านผ่าน scoped client → สิทธิ์บังคับโดย view/RLS (ไม่ leak ข้าม scope)
 *   - CSV เท่านั้นในเฟสนี้ (XLSX/PDF = TODO), 2 รายงานจริง + โครงพร้อมต่อยอด
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCsv, type CsvColumn } from "./csv";
import type { ResponseFactRow, TeamScoreRow, RoleCode } from "@/lib/dashboard/types";

type DB = SupabaseClient;

// ---------------------------------------------------------------------
// Export gate — allow-list (default deny) · H1/M1
//   รายงานทุกชนิด (team + monthly ที่มี customer_id) เป็น "score/ข้อมูลผูกลูกค้า"
//   → อนุญาต export เฉพาะบทบาทที่มีสิทธิ์ดูข้อมูลผูกลูกค้าอยู่แล้ว
//   member (accountant/sales) หรือ role=null (ไม่มี session/ไม่มีบทบาท) → ปฏิเสธ (fail-closed)
// ---------------------------------------------------------------------
export const EXPORT_ALLOWED_ROLES: readonly RoleCode[] = [
  "executive",
  "admin",
  "acc_lead",
  "sales_lead",
  "cs",
];

/** true เฉพาะบทบาทใน allow-list; null/undefined/member → false (default deny) */
export function canExportReports(role: RoleCode | null | undefined): boolean {
  if (!role) return false;
  return (EXPORT_ALLOWED_ROLES as readonly string[]).includes(role);
}

/** รายงานที่รองรับในเฟสนี้ */
export const REPORT_TYPES = ["monthly", "team"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export function isReportType(v: string): v is ReportType {
  return (REPORT_TYPES as readonly string[]).includes(v);
}

export type ReportFilter = {
  /** กรองรอบ เช่น '2026-07' หรือ '2026-Q3' (ตรงกับ cycle_period) */
  cycle?: string;
  /** กรองประเภทแบบ A/B/C/D */
  surveyType?: string;
};

export type ReportOutput = {
  filename: string;
  contentType: string;
  body: string;
};

// ---------------------------------------------------------------------
// รายงานรายเดือน/รอบ (response-level): CSAT/NPS/sentiment ต่อคำตอบ
//   หมายเหตุ PDPA: ไม่ใส่ชื่อลูกค้า (ใช้ customer_id ปลอมนาม) — สอดคล้อง C-07/§16
// ---------------------------------------------------------------------
async function buildMonthlyReport(
  db: DB,
  filter: ReportFilter
): Promise<ReportOutput> {
  let q = db
    .from("v_dashboard_response_facts")
    .select(
      "invitation_id, response_id, customer_id, survey_type, cycle_period, invitation_status, is_responded, csat_overall, nps_score, nps_category, sentiment, urgency"
    );
  if (filter.cycle) q = q.eq("cycle_period", filter.cycle);
  if (filter.surveyType) q = q.eq("survey_type", filter.surveyType);

  const { data } = await q;
  const rows = (data ?? []) as ResponseFactRow[];

  const columns: CsvColumn<ResponseFactRow>[] = [
    { header: "รอบ", value: (r) => r.cycle_period },
    { header: "ประเภทแบบ", value: (r) => r.survey_type },
    { header: "รหัสลูกค้า(ปลอมนาม)", value: (r) => r.customer_id },
    { header: "สถานะคำเชิญ", value: (r) => r.invitation_status },
    { header: "ตอบแล้ว", value: (r) => (r.is_responded ? "ใช่" : "ไม่") },
    { header: "CSAT", value: (r) => r.csat_overall },
    { header: "NPS(0-10)", value: (r) => r.nps_score },
    { header: "หมวด NPS", value: (r) => r.nps_category },
    { header: "Sentiment", value: (r) => r.sentiment },
    { header: "ความเร่งด่วน", value: (r) => r.urgency },
  ];

  const suffix = filter.cycle ? `-${filter.cycle}` : "";
  return {
    filename: `report-monthly${suffix}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: buildCsv(rows, columns),
  };
}

// ---------------------------------------------------------------------
// รายงานทีม/พนักงาน (คะแนนต่อพนักงานผูกทีม) — ไม่มีชื่อลูกค้า
// ---------------------------------------------------------------------
async function buildTeamReport(
  db: DB,
  filter: ReportFilter
): Promise<ReportOutput> {
  let q = db
    .from("v_team_score_facts")
    .select(
      "team_name, team_type, employee_first_name, employee_nickname, subject_role, avg_score, survey_type, cycle_period, submitted_at"
    );
  if (filter.cycle) q = q.eq("cycle_period", filter.cycle);
  if (filter.surveyType) q = q.eq("survey_type", filter.surveyType);

  const { data } = await q;
  const rows = (data ?? []) as TeamScoreRow[];

  const columns: CsvColumn<TeamScoreRow>[] = [
    { header: "ทีม", value: (r) => r.team_name },
    { header: "ประเภททีม", value: (r) => r.team_type },
    {
      header: "พนักงาน",
      value: (r) => r.employee_nickname || r.employee_first_name || r.employee_id,
    },
    { header: "บทบาทที่ถูกประเมิน", value: (r) => r.subject_role },
    { header: "รอบ", value: (r) => r.cycle_period },
    { header: "ประเภทแบบ", value: (r) => r.survey_type },
    { header: "คะแนนเฉลี่ย", value: (r) => r.avg_score },
  ];

  const suffix = filter.cycle ? `-${filter.cycle}` : "";
  return {
    filename: `report-team${suffix}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: buildCsv(rows, columns),
  };
}

/** สร้างรายงานตามชนิด (อ่านผ่าน scoped client → สิทธิ์บังคับที่ view) */
export async function buildReport(
  db: DB,
  type: ReportType,
  filter: ReportFilter = {}
): Promise<ReportOutput> {
  switch (type) {
    case "monthly":
      return buildMonthlyReport(db, filter);
    case "team":
      return buildTeamReport(db, filter);
    default:
      // exhaustive guard
      throw new Error(`unsupported report type: ${type as string}`);
  }
}
