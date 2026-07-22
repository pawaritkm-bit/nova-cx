/**
 * ชนิดข้อมูลชั้น chat-audit dashboards (Phase 5a)
 *   สะท้อนคอลัมน์จริงจาก 0031-0035 เท่าที่ dashboard/viewer ใช้
 */

// ---- แถวดิบจากตาราง (subset ที่ dashboard ใช้) --------------------------
export type ConversationCaseRow = {
  id: string;
  customer_id: string | null;
  chat_group_id: string;
  owner_employee_id: string | null;
  title: string | null;
  summary: string | null;
  status: string;
  urgency: string | null;
  level: string;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  first_responded_at: string | null;
  opened_at: string;
  closed_at: string | null;
};

export type RiskAlertRow = {
  id: string;
  case_id: string | null;
  customer_id: string | null;
  level: string; // green/yellow/orange/red
  reason: string | null;
  owner_employee_id: string | null;
  status: string; // open/acknowledged/resolved
  escalated_at: string | null;
  escalated_to_employee_id: string | null;
  created_at: string;
};

export type ChatMessageRow = {
  id: string;
  chat_group_id: string;
  sender_line_user_id: string | null;
  chat_member_id: string | null;
  message_type: string;
  content_enc: string | null;
  sent_at: string | null;
};

export type SopViolationRow = {
  id: string;
  violation_type: string;
  severity: string; // low/medium/high
  evidence_message_id: string | null;
  description: string | null;
  needs_expert_review: boolean;
};

export type AiChatAnalysisRow = {
  id: string;
  window_start: string | null;
  window_end: string | null;
  summary: string | null;
  sentiment: string | null;
  urgency: string | null;
  customer_facts: unknown; // jsonb array (ข้อเท็จจริง อ้างข้อความ+เวลา)
  ai_assumptions: unknown; // jsonb array (สันนิษฐาน)
  evidence: unknown; // jsonb array (อ้าง message_id + เวลา)
  flow_steps: unknown; // jsonb array
  problems: unknown; // jsonb array
  confidence: number | null;
  insufficient_data: boolean;
  needs_human_review: boolean;
};

export type AccountantEvaluationRow = {
  id: string;
  employee_id: string;
  scope: string;
  conversation_case_id: string | null;
  period_start: string | null;
  period_end: string | null;
  overall_score: number | null;
  dimension_scores: Record<string, unknown> | null;
  strengths: unknown;
  improvements: unknown;
  better_examples: unknown;
  confidence: number | null;
  status: string;
  needs_review: boolean;
};

/** ปัญหาที่ AI สกัดจากบทสนทนา (subset ของ ai_chat_analysis.problems) */
export type ChatProblem = {
  type: string; // หมวด (ดู problem-labels.ts)
  detail: string; // ข้อความอธิบายเหตุการณ์จริง
};

/** เหตุการณ์เร่งด่วน 1 รายการ (ต่อเคส) — ใช้บนการ์ด exec + ตารางลูกค้าเสี่ยง */
export type IncidentRow = {
  caseId: string;
  customerLabel: string; // รหัสลูกค้า (ปลอมนาม) หรือ "—"
  ownerName: string; // ผู้รับผิดชอบ (owner เคส → ผู้ดูแลกลุ่ม)
  level: string; // ระดับเคส (critical/high/...)
  urgency: string | null;
  problemType: string | null; // หมวดปัญหาเด่น (null = ไม่มี problem → ใช้ summary)
  detail: string; // เหตุการณ์เจาะจง (problem.detail → summary → title)
  overdue: boolean; // เกิน SLA แล้วหรือยัง (ไว้เน้น/เรียง)
};

/** จุดข้อมูลกราฟ "สุขภาพการดูแล 7 วัน" (อัตราตอบภายใน SLA รายวัน) */
export type CareHealthDay = {
  date: string; // YYYY-MM-DD (โซนเวลา server)
  label: string; // ป้ายสั้น (ว/ด)
  total: number; // เคสที่ครบกำหนดตอบในวันนั้น
  withinSla: number; // ตอบทันภายใน SLA
  rate: number | null; // withinSla/total (null = ไม่มีเคสวันนั้น)
};

// ---- ผลลัพธ์ dashboard ----------------------------------------------
export type ExecChatDashboard = {
  totalGroups: number;
  casesByStatus: Record<string, number>;
  openCases: number;
  newTodayCases: number;
  overdueCases: number;
  urgentCases: number; // critical/high ที่ยังเปิด
  waitingCases: number; // ★ เรื่องรอตอบ (เปิดอยู่ + ยังไม่ตอบครั้งแรก)
  activeRisk: number; // ★ ลูกค้าเสี่ยง (นับเฉพาะ risk ที่กลุ่มมี analysis เจอปัญหาจริง — ตัด noise)
  aiPendingReview: number; // ★ AI รอหัวหน้าตรวจ (needs_human_review / confidence ต่ำ)
  complaints: number; // risk level orange/red ที่ยัง active
  cancelRisk: number; // risk level red ที่ยัง active
  repeatRate: number | null; // อัตราทวงซ้ำ (0..1) — ประมาณจาก repeat_doc_request/off-topic
  topProblems: { label: string; count: number }[];
  ownerBacklog: { employeeId: string; name: string; open: number; overdue: number }[];
  incidents: IncidentRow[]; // ★ เหตุการณ์เร่งด่วน (top เรียงตามความด่วน)
  careHealth: CareHealthDay[]; // ★ สุขภาพการดูแล 7 วัน
};

export type TeamMemberStat = {
  employeeId: string;
  name: string;
  avgScore: number | null;
  n: number; // จำนวน eval confirmed/draft ที่นับ
  openCases: number;
  overdueCases: number;
  needsExpertReview: number; // คำตอบที่ AI มองว่าอาจผิด (needs_expert_review)
};

export type TeamChatDashboard = {
  members: TeamMemberStat[];
  toReviewCount: number; // eval ที่รอหัวหน้ายืนยัน (needs_review)
  needsExpertTotal: number;
  openTotal: number;
  overdueTotal: number;
  reviewQueue: { caseId: string | null; evaluationId: string; ownerName: string; overall: number | null; status: string }[];
};

export type MeChatDashboard = {
  newToday: number;
  toRespond: number;
  dueSoon: number;
  overdue: number;
  myCases: ConversationCaseRow[];
  latestEvaluation: AccountantEvaluationRow | null;
  coaching: {
    strengths: string[];
    improvements: string[];
    exampleAnswers: string[];
    checklist: string[];
  } | null;
};

/** แถวในตารางลูกค้าเสี่ยง (join customer + owner + เหตุการณ์เจาะจงจาก AI) */
export type RiskRow = {
  alertId: string;
  caseId: string | null;
  customerLabel: string; // รหัสลูกค้า (ปลอมนาม) — ★ ไม่ใช่ชื่อจริง
  level: string;
  reason: string | null; // เหตุผลกว้างจาก risk_alert (fallback สุดท้าย)
  problems: ChatProblem[]; // ★ เหตุการณ์เจาะจง (หมวด + detail จริง) จาก ai_chat_analysis
  summary: string | null; // ★ สรุปบทสนทนา (fallback เมื่อไม่มี problem)
  ownerName: string;
  status: string;
  escalated: boolean;
};

/** ข้อความในไทม์ไลน์ (หลัง gate decrypt) */
export type TimelineMessage = {
  id: string;
  senderKind: "customer" | "accountant" | "lead" | "system" | "unknown";
  senderLabel: string;
  content: string; // ถอดรหัสแล้ว หรือ placeholder ตามสิทธิ์
  sentAt: string | null;
  redacted: boolean; // true = ถูกซ่อน (ไม่มีสิทธิ์ decrypt)
};
