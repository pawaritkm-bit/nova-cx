/**
 * ชนิดข้อมูลชั้น dashboard (M2 chunk 5)
 */
import type { ScoredItem, BestWorstResult } from "./sample-size";
import type { EscalationSummary } from "./sla";
import type {
  CsatAggregate,
  NpsAggregate,
  ResponseRate,
  NpsCategory,
} from "./aggregate";

/**
 * บทบาทพนักงาน (ตรงกับ roles.code — 0002 + 0030)
 *   auditor_qa/hr เพิ่มใน 0030 (Phase 0 ของโมดูล AI วิเคราะห์แชท)
 *   ★ เป็นเพียงการ "รู้จัก" บทบาท — สิทธิ์จริงยังคุมด้วย allow-list/RLS แยกต่างหาก
 *     (2 บทบาทนี้ไม่อยู่ใน PRIVILEGED_ROLES/ADMIN_ROLES → default deny)
 */
export type RoleCode =
  | "executive"
  | "acc_lead"
  | "accountant"
  | "sales_lead"
  | "sales"
  | "cs"
  | "admin"
  | "auditor_qa"
  | "hr";

export const ROLE_CODES: RoleCode[] = [
  "executive",
  "acc_lead",
  "accountant",
  "sales_lead",
  "sales",
  "cs",
  "admin",
  "auditor_qa",
  "hr",
];

export function isRoleCode(v: string): v is RoleCode {
  return (ROLE_CODES as string[]).includes(v);
}

// ---- แถวจาก view (เท่าที่ dashboard ใช้) --------------------------------
export type ResponseFactRow = {
  invitation_id: string;
  response_id: string | null;
  customer_id: string;
  survey_type: string | null;
  cycle_period: string | null;
  invitation_status: string;
  is_responded: boolean | null;
  csat_overall: number | null;
  nps_score: number | null;
  nps_category: NpsCategory | null;
  sentiment: string | null;
  urgency: string | null;
};

export type TeamScoreRow = {
  team_id: string | null;
  team_name: string | null;
  team_type: string | null;
  employee_id: string;
  employee_first_name: string | null;
  employee_nickname: string | null;
  subject_role: string;
  avg_score: number | null;
  survey_type: string | null;
  cycle_period: string | null;
  submitted_at: string | null;
};

export type CaseFactRow = {
  case_id: string;
  case_no: string;
  customer_id: string | null;
  customer_code: string | null;
  type: string;
  level: string;
  status: string;
  sla_due_at: string | null;
  created_at: string;
  closed_at: string | null;
  post_resolution_csat: number | null;
};

/** feedback ที่ผู้ถูกประเมินเห็น — ★ ไม่มีชื่อ/customer_id/response_id (non-linkability, C1) */
export type EvaluateeFeedbackRow = {
  evaluation_id: string;
  employee_id: string;
  subject_role: string;
  avg_score: number | null;
  submitted_at: string | null;
  survey_type: string | null;
  cycle: string | null;
  sentiment: string | null;
  urgency: string | null;
  summary: string | null;
  categories: unknown;
  next_best_action: string | null;
};

export type TrackingRow = {
  invitation_id: string;
  customer_id: string;
  customer_name: string;
  customer_code: string | null;
  survey_type: string | null;
  cycle_period: string | null;
  invitation_status: string;
  is_responded: boolean | null;
  reminder_count: number;
  has_phone: boolean;
  invited_at: string;
  last_reminded_at: string | null;
};

// ---- ผลลัพธ์ dashboard ต่อบทบาท ----------------------------------------
export type CaseSummary = {
  byStatus: Record<string, number>;
  byLevel: Record<string, number>;
  open: number;
  urgent: number; // critical/high ที่ยังไม่ปิด
  retentionRisk: number; // เคส type=retention ที่ยังไม่ปิด
  avgResolutionHours: number | null; // เฉลี่ยเวลาปิดเคส (created→closed)
};

export type ExecDashboard = {
  role: "executive";
  csat: CsatAggregate;
  nps: NpsAggregate;
  responseRate: ResponseRate;
  teamCsat: ScoredItem[];
  teamRanking: BestWorstResult;
  cases: CaseSummary;
  urgentCases: CaseFactRow[]; // ★ list สำหรับแสดง (cap แล้ว, เรียงตามความเร่งด่วน)
  urgentTotal: number; // จำนวนเคสด่วนทั้งหมด (ก่อน cap) — ใช้คำนวณ "และอีก N"
  escalation: EscalationSummary; // สรุปนับจากชุดเต็ม (ตรงกับ cases.urgent)
};

export type AccountantDashboard = {
  role: "accountant" | "sales";
  ownScore: CsatAggregate; // เฉลี่ยคะแนนตัวเอง + n
  trendByCycle: ScoredItem[]; // แนวโน้มรายรอบ (label=cycle)
  praises: EvaluateeFeedbackRow[]; // sentiment positive
  improvements: EvaluateeFeedbackRow[]; // sentiment negative
  tracking: {
    total: number;
    responded: number;
    notResponded: number;
    responseRate: ResponseRate;
  };
  callList: TrackingRow[]; // ★ เฉพาะคนยังไม่ประเมิน (โทรตาม)
};

export type LeadDashboard = {
  role: "acc_lead" | "sales_lead";
  teamScore: CsatAggregate;
  memberScores: ScoredItem[]; // คะแนนต่อลูกทีม (label=ชื่อพนักงาน)
  memberRanking: BestWorstResult;
  tracking: {
    total: number;
    responded: number;
    notResponded: number;
    responseRate: ResponseRate;
  };
};

export type DashboardResult =
  | ExecDashboard
  | AccountantDashboard
  | LeadDashboard;
