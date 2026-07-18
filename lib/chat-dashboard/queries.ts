/**
 * Chat Audit data layer (Phase 5a) — query helper ต่อบทบาท
 *   ★ ความปลอดภัย:
 *     - ใช้ "scoped client" (anon key + session cookie) เสมอ → RLS บังคับ tenant isolation
 *     - RLS ของ chat/case ทำแค่ tenant → ต้อง scope ต่อ owner ที่ "app-layer" เอง
 *       (caseScopeForViewer) แบบ default-deny; ผู้เรียก guard สิทธิ์หน้าเรียบร้อยก่อน
 *     - decrypt เนื้อหาแชตทำที่ getCaseChatView เท่านั้น + gate ด้วย canDecryptChat
 *     - จำกัด limit ทุก query (log เตือนเมื่อ truncate)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptField } from "@/lib/crypto/field";
import { computeSlaStatus } from "@/lib/dashboard/sla";
import type { Viewer } from "@/lib/evaluation/access";
import { caseScopeForViewer, canDecryptChat, type CaseScope } from "./access";
import { buildTimeline, type RawTimelineInput } from "./decrypt";
import type {
  ConversationCaseRow,
  ExecChatDashboard,
  TeamChatDashboard,
  TeamMemberStat,
  MeChatDashboard,
  RiskRow,
  TimelineMessage,
  AiChatAnalysisRow,
  SopViolationRow,
  AccountantEvaluationRow,
} from "./types";

type DB = SupabaseClient;

const CASE_LIMIT = 1000;
const MSG_LIMIT = 500;
const ACTIVE_STATUSES = ["open", "in_progress", "waiting_customer", "reopened"];
const ACTIVE_RISK = ["open", "acknowledged"];

/** ป้ายภาษาไทยของชนิด SOP violation (ปัญหาที่ AI จับได้) */
const VIOLATION_LABEL: Record<string, string> = {
  slow_reply: "ตอบช้าเกิน SLA",
  missed_request: "ตกหล่นคำขอลูกค้า",
  no_owner: "ไม่มีผู้รับผิดชอบชัดเจน",
  repeat_doc_request: "ลูกค้าถาม/ขอเอกสารซ้ำ",
  off_topic_reply: "ตอบไม่ตรงคำถาม",
  jargon: "ใช้ศัพท์ยากเกินไป",
  terse_reply: "ตอบห้วนเกินไป",
  conflicting_info: "ให้ข้อมูลขัดแย้งกัน",
  other: "อื่น ๆ",
};

export function violationLabel(type: string): string {
  return VIOLATION_LABEL[type] ?? type;
}

/** map ป้ายชื่อพนักงาน (nickname > first_name > id ตัดสั้น) */
export type EmployeeName = { id: string; label: string };

async function fetchEmployeeNames(
  db: DB,
  ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const { data } = await db
    .from("employees")
    .select("id, first_name, nickname")
    .in("id", unique);
  for (const e of (data ?? []) as { id: string; first_name: string | null; nickname: string | null }[]) {
    out.set(e.id, e.nickname || e.first_name || e.id.slice(0, 8));
  }
  return out;
}

function nameOf(map: Map<string, string>, id: string | null): string {
  if (!id) return "ไม่ระบุ";
  return map.get(id) ?? id.slice(0, 8);
}

/** conversation_cases → CaseLike ที่ helper SLA ใช้ (sla_due_at = resolution_due_at) */
function toCaseLike(c: ConversationCaseRow): { level: string; sla_due_at: string | null } {
  return { level: c.level, sla_due_at: c.resolution_due_at };
}

const CASE_COLS =
  "id, customer_id, chat_group_id, owner_employee_id, title, summary, status, urgency, level, first_response_due_at, resolution_due_at, first_responded_at, opened_at, closed_at";

/** apply owner scope ให้ query (ผู้เรียกตรวจ deny ก่อนแล้ว) */
function applyOwnerScope<Q extends { eq: (c: string, v: string) => Q; in: (c: string, v: string[]) => Q }>(
  q: Q,
  scope: CaseScope,
  col = "owner_employee_id"
): Q {
  if (scope.kind === "owner") return q.eq(col, scope.employeeId);
  if (scope.kind === "team") return q.in(col, scope.employeeIds);
  return q; // all
}

// ---------------------------------------------------------------------
// aggregation helpers (บริสุทธิ์ — แยกไว้ให้ test ได้)
// ---------------------------------------------------------------------
const CLOSED = new Set(["resolved", "closed"]);

export function summarizeExecCases(
  cases: ConversationCaseRow[],
  nowMs: number
): Pick<ExecChatDashboard, "casesByStatus" | "openCases" | "newTodayCases" | "overdueCases" | "urgentCases"> {
  const casesByStatus: Record<string, number> = {};
  let openCases = 0;
  let overdueCases = 0;
  let urgentCases = 0;
  let newTodayCases = 0;
  const startOfDay = new Date(nowMs);
  startOfDay.setHours(0, 0, 0, 0);
  const startMs = startOfDay.getTime();

  for (const c of cases) {
    casesByStatus[c.status] = (casesByStatus[c.status] ?? 0) + 1;
    const isOpen = !CLOSED.has(c.status);
    if (isOpen) {
      openCases += 1;
      if ((c.level === "critical" || c.level === "high")) urgentCases += 1;
      if (computeSlaStatus(c.resolution_due_at, nowMs).state === "overdue") overdueCases += 1;
    }
    if (c.opened_at && Date.parse(c.opened_at) >= startMs) newTodayCases += 1;
  }
  return { casesByStatus, openCases, newTodayCases, overdueCases, urgentCases };
}

/** งานค้างต่อ owner (open + overdue) เรียงงานค้างมาก→น้อย */
export function computeOwnerBacklog(
  cases: ConversationCaseRow[],
  nowMs: number,
  names: Map<string, string>
): ExecChatDashboard["ownerBacklog"] {
  const map = new Map<string, { open: number; overdue: number }>();
  for (const c of cases) {
    if (CLOSED.has(c.status) || !c.owner_employee_id) continue;
    const e = map.get(c.owner_employee_id) ?? { open: 0, overdue: 0 };
    e.open += 1;
    if (computeSlaStatus(c.resolution_due_at, nowMs).state === "overdue") e.overdue += 1;
    map.set(c.owner_employee_id, e);
  }
  return [...map.entries()]
    .map(([employeeId, v]) => ({ employeeId, name: nameOf(names, employeeId), ...v }))
    .sort((a, b) => b.open - a.open)
    .slice(0, 10);
}

/** นับ SOP violation ตามชนิด → top problems (ปัญหาซ้ำบ่อยสุด) */
export function topProblemsFromViolations(
  violations: { violation_type: string }[]
): { label: string; count: number }[] {
  const map = new Map<string, number>();
  for (const v of violations) {
    map.set(v.violation_type, (map.get(v.violation_type) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([type, count]) => ({ label: violationLabel(type), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function logTruncate(context: string, n: number, cap: number): void {
  if (n >= cap) {
    console.warn(`[chat-dashboard] ${context}: ผลลัพธ์ถูกตัดที่ ${cap} แถว (อาจมีข้อมูลมากกว่านี้)`);
  }
}

// ---------------------------------------------------------------------
// 1) Executive Dashboard — ภาพรวมทั้ง tenant
// ---------------------------------------------------------------------
export async function getExecChatDashboard(
  db: DB,
  nowMs: number = Date.now()
): Promise<ExecChatDashboard> {
  const [{ data: caseData }, { data: groupData }, { data: riskData }, { data: violData }] =
    await Promise.all([
      db.from("conversation_cases").select(CASE_COLS).is("deleted_at", null).limit(CASE_LIMIT),
      db.from("chat_groups").select("id").is("deleted_at", null).eq("is_active", true).limit(CASE_LIMIT),
      db.from("risk_alerts").select("level, status").in("status", ACTIVE_RISK).limit(CASE_LIMIT),
      db.from("sop_violations").select("violation_type").is("deleted_at", null).limit(CASE_LIMIT),
    ]);

  const cases = (caseData ?? []) as ConversationCaseRow[];
  logTruncate("exec cases", cases.length, CASE_LIMIT);
  const risks = (riskData ?? []) as { level: string; status: string }[];
  const violations = (violData ?? []) as { violation_type: string }[];

  const summary = summarizeExecCases(cases, nowMs);
  const names = await fetchEmployeeNames(db, cases.map((c) => c.owner_employee_id ?? "").filter(Boolean));

  const complaints = risks.filter((r) => r.level === "orange" || r.level === "red").length;
  const cancelRisk = risks.filter((r) => r.level === "red").length;

  // อัตราทวงซ้ำ (ประมาณ) = เคสเปิดที่มี violation ประเภทถาม/ขอซ้ำ ÷ เคสเปิดทั้งหมด
  const repeatCount = violations.filter((v) => v.violation_type === "repeat_doc_request").length;
  const repeatRate = summary.openCases > 0 ? Math.min(1, Math.round((repeatCount / summary.openCases) * 100) / 100) : null;

  return {
    totalGroups: (groupData ?? []).length,
    ...summary,
    complaints,
    cancelRisk,
    repeatRate,
    topProblems: topProblemsFromViolations(violations),
    ownerBacklog: computeOwnerBacklog(cases, nowMs, names),
  };
}

// ---------------------------------------------------------------------
// 2) Team Leader Dashboard — ทีมของ acc_lead (scope=team)
// ---------------------------------------------------------------------
export async function getTeamChatDashboard(
  db: DB,
  viewer: Viewer,
  nowMs: number = Date.now()
): Promise<TeamChatDashboard> {
  const scope = caseScopeForViewer(viewer);
  const empty: TeamChatDashboard = {
    members: [],
    toReviewCount: 0,
    needsExpertTotal: 0,
    openTotal: 0,
    overdueTotal: 0,
    reviewQueue: [],
  };
  if (scope.kind !== "team") return empty; // acc_lead ที่ไม่มีทีม → ไม่เห็นอะไร (default deny)
  const memberIds = scope.employeeIds;

  const caseQ = applyOwnerScope(
    db.from("conversation_cases").select(CASE_COLS).is("deleted_at", null).limit(CASE_LIMIT),
    scope
  );
  const evalQ = db
    .from("accountant_evaluations")
    .select("id, employee_id, conversation_case_id, overall_score, status, needs_review")
    .in("employee_id", memberIds)
    .is("deleted_at", null)
    .limit(CASE_LIMIT);

  const [{ data: caseData }, { data: evalData }] = await Promise.all([caseQ, evalQ]);
  const cases = (caseData ?? []) as ConversationCaseRow[];
  const evals = (evalData ?? []) as (Pick<AccountantEvaluationRow, "id" | "employee_id" | "conversation_case_id" | "overall_score" | "status" | "needs_review">)[];

  // owner ต่อ chat_group (สำหรับ attribute needs_expert_review)
  const groupOwner = new Map<string, string>();
  for (const c of cases) {
    if (c.owner_employee_id) groupOwner.set(c.chat_group_id, c.owner_employee_id);
  }
  const groupIds = [...groupOwner.keys()];
  let expertByOwner = new Map<string, number>();
  if (groupIds.length > 0) {
    const { data: violData } = await db
      .from("sop_violations")
      .select("chat_group_id")
      .eq("needs_expert_review", true)
      .in("chat_group_id", groupIds)
      .is("deleted_at", null)
      .limit(CASE_LIMIT);
    for (const v of (violData ?? []) as { chat_group_id: string }[]) {
      const owner = groupOwner.get(v.chat_group_id);
      if (owner) expertByOwner.set(owner, (expertByOwner.get(owner) ?? 0) + 1);
    }
  }

  const names = await fetchEmployeeNames(db, memberIds);

  // สถิติต่อสมาชิก
  const stat = new Map<string, TeamMemberStat>();
  for (const id of memberIds) {
    stat.set(id, {
      employeeId: id,
      name: nameOf(names, id),
      avgScore: null,
      n: 0,
      openCases: 0,
      overdueCases: 0,
      needsExpertReview: expertByOwner.get(id) ?? 0,
    });
  }
  let openTotal = 0;
  let overdueTotal = 0;
  for (const c of cases) {
    if (!c.owner_employee_id) continue;
    const s = stat.get(c.owner_employee_id);
    if (!s || CLOSED.has(c.status)) continue;
    s.openCases += 1;
    openTotal += 1;
    if (computeSlaStatus(c.resolution_due_at, nowMs).state === "overdue") {
      s.overdueCases += 1;
      overdueTotal += 1;
    }
  }
  // คะแนนเฉลี่ยต่อสมาชิก (นับ eval ที่มี overall_score)
  const scoreAcc = new Map<string, { sum: number; n: number }>();
  for (const e of evals) {
    if (typeof e.overall_score === "number") {
      const a = scoreAcc.get(e.employee_id) ?? { sum: 0, n: 0 };
      a.sum += e.overall_score;
      a.n += 1;
      scoreAcc.set(e.employee_id, a);
    }
  }
  for (const [id, a] of scoreAcc.entries()) {
    const s = stat.get(id);
    if (s) {
      s.avgScore = a.n > 0 ? Math.round((a.sum / a.n) * 10) / 10 : null;
      s.n = a.n;
    }
  }

  const toReview = evals.filter((e) => e.needs_review && e.status === "ai_draft");
  const reviewQueue = toReview.slice(0, 30).map((e) => ({
    caseId: e.conversation_case_id,
    evaluationId: e.id,
    ownerName: nameOf(names, e.employee_id),
    overall: e.overall_score,
    status: e.status,
  }));

  const needsExpertTotal = [...expertByOwner.values()].reduce((a, b) => a + b, 0);

  return {
    members: [...stat.values()].sort((a, b) => b.openCases - a.openCases),
    toReviewCount: toReview.length,
    needsExpertTotal,
    openTotal,
    overdueTotal,
    reviewQueue,
  };
}

// ---------------------------------------------------------------------
// 3) Accountant Dashboard — ของตัวเอง (scope=owner)
// ---------------------------------------------------------------------
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        return String(o.text ?? o.note ?? o.title ?? o.label ?? JSON.stringify(o));
      }
      return String(x);
    })
    .filter(Boolean);
}

export async function getMeChatDashboard(
  db: DB,
  viewer: Viewer,
  nowMs: number = Date.now()
): Promise<MeChatDashboard> {
  const scope = caseScopeForViewer(viewer);
  const empty: MeChatDashboard = {
    newToday: 0,
    toRespond: 0,
    dueSoon: 0,
    overdue: 0,
    myCases: [],
    latestEvaluation: null,
    coaching: null,
  };
  if (scope.kind !== "owner") return empty; // accountant เท่านั้น

  const caseQ = applyOwnerScope(
    db
      .from("conversation_cases")
      .select(CASE_COLS)
      .is("deleted_at", null)
      .in("status", ACTIVE_STATUSES)
      .order("resolution_due_at", { ascending: true })
      .limit(CASE_LIMIT),
    scope
  );
  const evalQ = db
    .from("accountant_evaluations")
    .select(
      "id, employee_id, scope, conversation_case_id, period_start, period_end, overall_score, dimension_scores, strengths, improvements, better_examples, confidence, status, needs_review"
    )
    .eq("employee_id", scope.employeeId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const coachQ = db
    .from("coaching_recommendations")
    .select("strengths, improvements, example_answers, checklist")
    .eq("employee_id", scope.employeeId)
    .order("created_at", { ascending: false })
    .limit(1);

  const [{ data: caseData }, { data: evalData }, { data: coachData }] = await Promise.all([
    caseQ,
    evalQ,
    coachQ,
  ]);

  const myCases = (caseData ?? []) as ConversationCaseRow[];
  const startOfDay = new Date(nowMs);
  startOfDay.setHours(0, 0, 0, 0);
  const startMs = startOfDay.getTime();

  let newToday = 0;
  let toRespond = 0;
  let dueSoon = 0;
  let overdue = 0;
  for (const c of myCases) {
    if (c.opened_at && Date.parse(c.opened_at) >= startMs) newToday += 1;
    if (!c.first_responded_at) toRespond += 1;
    const sla = computeSlaStatus(c.resolution_due_at, nowMs);
    if (sla.state === "overdue") overdue += 1;
    else if (sla.state === "due-soon") dueSoon += 1;
  }

  const latestEvaluation = ((evalData ?? [])[0] as AccountantEvaluationRow | undefined) ?? null;
  const coachRow = (coachData ?? [])[0] as
    | { strengths: unknown; improvements: unknown; example_answers: unknown; checklist: unknown }
    | undefined;
  const coaching = coachRow
    ? {
        strengths: toStringArray(coachRow.strengths),
        improvements: toStringArray(coachRow.improvements),
        exampleAnswers: toStringArray(coachRow.example_answers),
        checklist: toStringArray(coachRow.checklist),
      }
    : null;

  return { newToday, toRespond, dueSoon, overdue, myCases, latestEvaluation, coaching };
}

// ---------------------------------------------------------------------
// 4) Customer Risk Dashboard — risk_alerts (scope ต่อบทบาท)
// ---------------------------------------------------------------------
export async function getRiskDashboard(db: DB, viewer: Viewer): Promise<RiskRow[]> {
  const scope = caseScopeForViewer(viewer);
  if (scope.kind === "deny") return [];

  const q = applyOwnerScope(
    db
      .from("risk_alerts")
      .select("id, case_id, customer_id, level, reason, owner_employee_id, status, escalated_at")
      .in("status", ACTIVE_RISK)
      .is("deleted_at", null)
      .limit(CASE_LIMIT),
    scope
  );
  const { data } = await q;
  const rows = (data ?? []) as {
    id: string;
    case_id: string | null;
    customer_id: string | null;
    level: string;
    reason: string | null;
    owner_employee_id: string | null;
    status: string;
    escalated_at: string | null;
  }[];

  const names = await fetchEmployeeNames(db, rows.map((r) => r.owner_employee_id ?? "").filter(Boolean));

  // ★ pseudonymity: แสดง "รหัสลูกค้า" ไม่ใช่ชื่อจริง
  const custIds = [...new Set(rows.map((r) => r.customer_id).filter((x): x is string => !!x))];
  const custCode = new Map<string, string>();
  if (custIds.length > 0) {
    const { data: custData } = await db
      .from("customers")
      .select("id, customer_code")
      .in("id", custIds);
    for (const c of (custData ?? []) as { id: string; customer_code: string | null }[]) {
      custCode.set(c.id, c.customer_code ?? c.id.slice(0, 8));
    }
  }

  const rank: Record<string, number> = { red: 0, orange: 1, yellow: 2, green: 3 };
  return rows
    .map((r) => ({
      alertId: r.id,
      caseId: r.case_id,
      customerLabel: r.customer_id ? custCode.get(r.customer_id) ?? "—" : "—",
      level: r.level,
      reason: r.reason,
      ownerName: nameOf(names, r.owner_employee_id),
      status: r.status,
      escalated: !!r.escalated_at,
    }))
    .sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9));
}

// ---------------------------------------------------------------------
// 5) Chat Viewer + Case Analysis — decrypt ฝั่ง server (gate ด้วย canDecryptChat)
// ---------------------------------------------------------------------
export type CaseChatView = {
  case: ConversationCaseRow | null;
  ownerName: string;
  customerLabel: string;
  timeline: TimelineMessage[];
  analysis: AiChatAnalysisRow | null;
  violations: SopViolationRow[];
  canDecrypt: boolean;
  /** true = ผู้ใช้ไม่มีสิทธิ์เข้าเคสนี้เลย (นอก scope) */
  denied: boolean;
};

export async function getCaseChatView(
  db: DB,
  viewer: Viewer,
  caseId: string
): Promise<CaseChatView> {
  const denied: CaseChatView = {
    case: null,
    ownerName: "",
    customerLabel: "",
    timeline: [],
    analysis: null,
    violations: [],
    canDecrypt: false,
    denied: true,
  };

  const scope = caseScopeForViewer(viewer);
  if (scope.kind === "deny") return denied;

  const { data: caseData } = await db
    .from("conversation_cases")
    .select(CASE_COLS)
    .eq("id", caseId)
    .is("deleted_at", null)
    .maybeSingle();
  const kase = (caseData as ConversationCaseRow | null) ?? null;
  if (!kase) return denied;

  // ★ app-layer scope check: accountant/acc_lead ต้องเป็น owner/ทีมของเคสนี้เท่านั้น
  if (scope.kind === "owner" && kase.owner_employee_id !== scope.employeeId) return denied;
  if (scope.kind === "team" && !(kase.owner_employee_id && scope.employeeIds.includes(kase.owner_employee_id)))
    return denied;

  const canDecrypt = canDecryptChat(viewer, kase.owner_employee_id);

  // ข้อความในเคส (ผ่าน case_messages → chat_messages) + สมาชิก (ชนิด+ชื่อ enc)
  const { data: linkData } = await db
    .from("case_messages")
    .select("chat_message_id")
    .eq("case_id", caseId)
    .limit(MSG_LIMIT);
  const msgIds = ((linkData ?? []) as { chat_message_id: string }[]).map((x) => x.chat_message_id);
  logTruncate("case messages", msgIds.length, MSG_LIMIT);

  let timeline: TimelineMessage[] = [];
  if (msgIds.length > 0) {
    const { data: msgData } = await db
      .from("chat_messages")
      .select("id, chat_member_id, sender_line_user_id, message_type, content_enc, sent_at")
      .in("id", msgIds)
      .order("sent_at", { ascending: true })
      .limit(MSG_LIMIT);
    const msgs = (msgData ?? []) as {
      id: string;
      chat_member_id: string | null;
      sender_line_user_id: string | null;
      message_type: string;
      content_enc: string | null;
      sent_at: string | null;
    }[];

    // สมาชิก → ชนิด + ชื่อ (enc)
    const memberIds = [...new Set(msgs.map((m) => m.chat_member_id).filter((x): x is string => !!x))];
    const memberMap = new Map<string, { kind: string; nameEnc: string | null }>();
    if (memberIds.length > 0) {
      const { data: memData } = await db
        .from("chat_members")
        .select("id, member_kind, display_name_enc")
        .in("id", memberIds);
      for (const m of (memData ?? []) as { id: string; member_kind: string; display_name_enc: string | null }[]) {
        memberMap.set(m.id, { kind: m.member_kind, nameEnc: m.display_name_enc });
      }
    }

    const raw: RawTimelineInput[] = msgs.map((m) => {
      const mem = m.chat_member_id ? memberMap.get(m.chat_member_id) : undefined;
      return {
        id: m.id,
        memberKind: mem?.kind ?? null,
        displayNameEnc: mem?.nameEnc ?? null,
        senderLineUserId: m.sender_line_user_id,
        contentEnc: m.content_enc,
        messageType: m.message_type,
        sentAt: m.sent_at,
      };
    });
    // ★ decrypt เฉพาะเมื่อ canDecrypt — buildTimeline จะซ่อนเนื้อหาถ้าไม่มีสิทธิ์
    timeline = buildTimeline(raw, canDecrypt, decryptField);
  }

  // ผลวิเคราะห์ AI ล่าสุดของกลุ่ม
  const { data: aiData } = await db
    .from("ai_chat_analysis")
    .select(
      "id, window_start, window_end, summary, sentiment, urgency, customer_facts, ai_assumptions, evidence, flow_steps, problems, confidence, insufficient_data, needs_human_review"
    )
    .eq("chat_group_id", kase.chat_group_id)
    .is("deleted_at", null)
    .order("window_end", { ascending: false })
    .limit(1);
  const analysis = ((aiData ?? [])[0] as AiChatAnalysisRow | undefined) ?? null;

  const { data: violData } = await db
    .from("sop_violations")
    .select("id, violation_type, severity, evidence_message_id, description, needs_expert_review")
    .eq("chat_group_id", kase.chat_group_id)
    .is("deleted_at", null)
    .limit(100);
  const violations = (violData ?? []) as SopViolationRow[];

  const names = await fetchEmployeeNames(db, [kase.owner_employee_id ?? ""].filter(Boolean));
  let customerLabel = "—";
  if (kase.customer_id) {
    const { data: cust } = await db
      .from("customers")
      .select("customer_code")
      .eq("id", kase.customer_id)
      .maybeSingle();
    customerLabel = (cust as { customer_code: string | null } | null)?.customer_code ?? "—";
  }

  return {
    case: kase,
    ownerName: nameOf(names, kase.owner_employee_id),
    customerLabel,
    timeline,
    analysis,
    violations,
    canDecrypt,
    denied: false,
  };
}
