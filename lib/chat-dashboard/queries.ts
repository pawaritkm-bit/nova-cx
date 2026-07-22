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
import { computeSlaStatus, compareUrgency } from "@/lib/dashboard/sla";
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
  ChatProblem,
  IncidentRow,
  CareHealthDay,
} from "./types";

type DB = SupabaseClient;

const CASE_LIMIT = 1000;
const MSG_LIMIT = 500;
const ACTIVE_STATUSES = ["open", "in_progress", "waiting_customer", "reopened"];
const ACTIVE_RISK = ["open", "acknowledged"];
/** confidence ต่ำกว่านี้ = AI ยังไม่มั่นใจ → ควรให้หัวหน้าตรวจ */
const LOW_CONFIDENCE = 0.5;
/** จำนวนเหตุการณ์เร่งด่วนสูงสุดที่โชว์บนการ์ด exec */
const INCIDENT_LIMIT = 8;

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

/**
 * งานค้างต่อ owner (open + overdue) เรียงงานค้างมาก→น้อย
 *   ★ นับเฉพาะ "เคสเปิดที่ AI เจอปัญหาจริง" (hasRealProblem) — เกณฑ์เดียวกับทั้งหน้า
 *     ไม่นับ noise (insufficient_data / other / ข้อมูลไม่พอ) เพื่อให้ตัวเลขสอดคล้องกัน
 *   analysisByGroup: วิเคราะห์ล่าสุดต่อกลุ่ม (ผู้เรียกเตรียมมาให้)
 */
export function computeOwnerBacklog(
  cases: ConversationCaseRow[],
  nowMs: number,
  names: Map<string, string>,
  analysisByGroup: Map<string, GroupAnalysis>
): ExecChatDashboard["ownerBacklog"] {
  const map = new Map<string, { open: number; overdue: number }>();
  for (const c of cases) {
    if (CLOSED.has(c.status) || !c.owner_employee_id) continue;
    // ★ นับเฉพาะเคสเปิดที่มีปัญหาจริง
    if (!hasRealProblem(analysisByGroup.get(c.chat_group_id))) continue;
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

/**
 * แปลง ai_chat_analysis.problems (jsonb unknown) → ChatProblem[] อย่างปลอดภัย
 *   - ไม่ใช่ array → []
 *   - แต่ละ item อ่าน type/detail แบบ defensive (ข้อมูลจาก AI อาจไม่ครบ)
 *   - เก็บ item ที่มี type หรือ detail อย่างน้อยอย่างใดอย่างหนึ่ง
 */
export function parseProblems(raw: unknown): ChatProblem[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatProblem[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const type = typeof o.type === "string" ? o.type : null;
      const detail = typeof o.detail === "string" ? o.detail.trim() : "";
      if (type || detail) out.push({ type: type ?? "other", detail });
    }
  }
  return out;
}

/** key วันแบบ YYYY-MM-DD ตามโซนเวลา server (ใช้จับ bucket รายวัน) */
function dayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * สุขภาพการดูแล 7 วันล่าสุด — อัตรา "ตอบทันภายใน SLA" รายวัน
 *   - จัด bucket ตามวันที่ "เปิดเคส" (opened_at) 7 วันย้อนหลังรวมวันนี้
 *   - total = เคสที่เปิดวันนั้นและมีกำหนดตอบ (first_response_due_at)
 *   - withinSla = ตอบครั้งแรกแล้ว (first_responded_at) และไม่เกินกำหนด
 *   - ไม่มีเคสวันนั้น → rate = null (หน้าแสดง empty/จาง)
 *   ★ pure: รับ cases + nowMs (ไม่แตะ DB / ไม่เรียก Date.now เอง)
 */
export function computeCareHealth7d(
  cases: ConversationCaseRow[],
  nowMs: number
): CareHealthDay[] {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const days: CareHealthDay[] = [];
  const byKey = new Map<string, CareHealthDay>();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(start);
    d.setDate(start.getDate() - i);
    const key = dayKey(d.getTime());
    const day: CareHealthDay = {
      date: key,
      label: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`,
      total: 0,
      withinSla: 0,
      rate: null,
    };
    days.push(day);
    byKey.set(key, day);
  }
  for (const c of cases) {
    if (!c.opened_at || !c.first_response_due_at) continue;
    const openedMs = Date.parse(c.opened_at);
    if (!Number.isFinite(openedMs)) continue;
    const day = byKey.get(dayKey(openedMs));
    if (!day) continue;
    day.total += 1;
    const dueMs = Date.parse(c.first_response_due_at);
    if (
      c.first_responded_at &&
      Number.isFinite(dueMs) &&
      Date.parse(c.first_responded_at) <= dueMs
    ) {
      day.withinSla += 1;
    }
  }
  for (const day of days) {
    day.rate = day.total > 0 ? Math.round((day.withinSla / day.total) * 100) / 100 : null;
  }
  return days;
}

/**
 * สร้างรายการ "เหตุการณ์เร่งด่วน" จากเคสที่เปิดอยู่
 *   ★ กรอง: แสดงเฉพาะเคสที่กลุ่มมี analysis "เจอปัญหาจริง" (hasRealProblem)
 *     — ตัดแถว insufficient_data / other / ข้อมูลไม่พอทิ้ง (ไม่ให้ noise ขึ้นการ์ด)
 *   - เรียงตามความด่วน (compareUrgency: เกิน SLA → critical/high → ครบกำหนดใกล้สุด)
 *   - เหตุการณ์เจาะจง = problem จริงตัวแรก (detail) → summary → summary เคส → title
 *   - ลูกค้า/ผู้รับผิดชอบ: จากเคสก่อน ถ้าไม่มีใช้ fallback จากกลุ่ม (customer/responsible)
 *   ★ pure: ผู้เรียกเตรียม map (analysis/กลุ่ม/รหัสลูกค้า/ชื่อ) มาให้
 */
export function buildIncidents(
  openCases: ConversationCaseRow[],
  analysisByGroup: Map<string, GroupAnalysis>,
  groupFallback: Map<string, { customerId: string | null; responsibleId: string | null }>,
  custCode: Map<string, string>,
  names: Map<string, string>,
  nowMs: number,
  limit = INCIDENT_LIMIT
): IncidentRow[] {
  const sorted = [...openCases]
    // ★ เฉพาะเคสที่ AI ตรวจเจอปัญหาจริง (ตัด insufficient/other/ข้อมูลไม่พอ)
    .filter((c) => hasRealProblem(analysisByGroup.get(c.chat_group_id)))
    .sort((a, b) =>
      compareUrgency(
        { level: a.level, sla_due_at: a.resolution_due_at },
        { level: b.level, sla_due_at: b.resolution_due_at },
        nowMs
      )
    );
  return sorted.slice(0, limit).map((c) => {
    const fb = groupFallback.get(c.chat_group_id);
    const custId = c.customer_id ?? fb?.customerId ?? null;
    const ownerId = c.owner_employee_id ?? fb?.responsibleId ?? null;
    const an = analysisByGroup.get(c.chat_group_id);
    const top = firstRealProblem(an);
    const detail =
      (top?.detail && top.detail.trim()) ||
      (an?.summary && an.summary.trim()) ||
      (c.summary && c.summary.trim()) ||
      (c.title && c.title.trim()) ||
      "ยังไม่มีรายละเอียดจาก AI";
    return {
      caseId: c.id,
      customerLabel: custId ? custCode.get(custId) ?? "—" : "—",
      ownerName: nameOf(names, ownerId),
      level: c.level,
      urgency: c.urgency,
      problemType: top?.type ?? null,
      detail,
      overdue: computeSlaStatus(c.resolution_due_at, nowMs).state === "overdue",
    };
  });
}

/**
 * ★ M2: อัตราทวงซ้ำ — คิดจาก "เคสเปิด" ชุดเดียวทั้งเศษ/ส่วน (ไม่ปนหน่วย)
 *   = (เคสเปิดที่กลุ่มมี violation repeat_doc_request) ÷ (เคสเปิดทั้งหมด)
 *   openCases = รายการเคสที่เปิดอยู่แล้ว (ผู้เรียกกรอง CLOSED ออกก่อน)
 */
export function computeRepeatRate(
  openCases: ConversationCaseRow[],
  violations: { violation_type: string; chat_group_id: string }[]
): number | null {
  if (openCases.length === 0) return null;
  const repeatGroups = new Set(
    violations.filter((v) => v.violation_type === "repeat_doc_request").map((v) => v.chat_group_id)
  );
  const n = openCases.filter((c) => repeatGroups.has(c.chat_group_id)).length;
  return Math.min(1, Math.round((n / openCases.length) * 100) / 100);
}

/**
 * ★ M1: attribute violation "ต่อเคส → owner" (ไม่ผูกที่ระดับ chat_group ซึ่ง last-write-wins)
 *   - ทางหลัก: evidence_message_id → owner ของเคสที่ข้อความนั้นสังกัด (messageOwner)
 *   - fallback: ถ้ากลุ่มมี owner เดียวชัดเจน (unambiguous) ใช้ groupSingleOwner
 *   - ระบุ owner ไม่ได้ (กลุ่มหลายเจ้าของ + ไม่มี evidence) → ข้าม (ไม่เดา ไม่โยนผิดคน)
 */
export function attributeExpertViolations(
  violations: { evidence_message_id: string | null; chat_group_id: string }[],
  messageOwner: Map<string, string>,
  groupSingleOwner: Map<string, string>
): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of violations) {
    const owner =
      (v.evidence_message_id ? messageOwner.get(v.evidence_message_id) : undefined) ??
      groupSingleOwner.get(v.chat_group_id);
    if (owner) out.set(owner, (out.get(owner) ?? 0) + 1);
  }
  return out;
}

/** map chat_group_id → owner "เฉพาะกลุ่มที่มี owner เดียว" (กลุ่มหลายเจ้าของ = ข้าม) */
export function buildGroupSingleOwner(
  cases: { chat_group_id: string; owner_employee_id: string | null }[]
): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const c of cases) {
    if (!c.owner_employee_id) continue;
    const s = owners.get(c.chat_group_id) ?? new Set<string>();
    s.add(c.owner_employee_id);
    owners.set(c.chat_group_id, s);
  }
  const out = new Map<string, string>();
  for (const [gid, set] of owners.entries()) {
    if (set.size === 1) out.set(gid, [...set][0]);
  }
  return out;
}

function logTruncate(context: string, n: number, cap: number): void {
  if (n >= cap) {
    console.warn(`[chat-dashboard] ${context}: ผลลัพธ์ถูกตัดที่ ${cap} แถว (อาจมีข้อมูลมากกว่านี้)`);
  }
}

/** แถวดิบ ai_chat_analysis เท่าที่ dashboard ใช้ (เรียง window_end desc มาแล้ว) */
type AnalysisRaw = {
  chat_group_id: string;
  summary: string | null;
  problems: unknown;
  confidence: number | null;
  needs_human_review: boolean;
  insufficient_data?: boolean | null;
};

/** วิเคราะห์ล่าสุดต่อกลุ่ม (subset ที่ layer แสดงผลใช้ + ธง insufficient_data สำหรับกรอง) */
export type GroupAnalysis = {
  problems: ChatProblem[];
  summary: string | null;
  insufficientData: boolean;
};

/**
 * หมวดปัญหา "จริงเจาะจง" 5 หมวด ที่ถือว่า AI ตรวจเจอปัญหาชัด
 *   ★ ตัด "other" ออก — "อื่นๆ" ถือว่ายังไม่เจอปัญหาชัด ไม่ต้องโชว์
 *   ★ ตรงกับ PROBLEM_CATEGORIES (lib/ai/chat-schema.ts) เว้น other
 */
export const REAL_PROBLEM_TYPES = new Set<string>([
  "sla_risk",
  "complaint",
  "dropped_work",
  "slow_reply",
  "no_response",
]);

/** problem ที่ถือว่า "จริง" = หมวดอยู่ใน 5 หมวดจริง + มี detail ไม่ว่าง */
function isRealProblem(p: ChatProblem): boolean {
  return REAL_PROBLEM_TYPES.has(p.type) && p.detail.trim().length > 0;
}

/**
 * ★ นิยามกลาง: analysis ล่าสุดของกลุ่ม "AI ตรวจเจอปัญหาจริง" ไหม
 *   ใช้กรองการแสดงผลทุกที่ (การ์ดเหตุการณ์เร่งด่วน + หน้าลูกค้าเสี่ยง + KPI ลูกค้าเสี่ยง)
 *   เข้าเกณฑ์เมื่อ:
 *     1) insufficient_data = false (ไม่ใช่บทสนทนาสั้น/ข้อมูลไม่พอสรุป)
 *     2) มี problem อย่างน้อย 1 ที่ type อยู่ใน 5 หมวดจริง (ตัด other)
 *     3) problem นั้น detail ต้องไม่ว่าง
 *   ★ pure function — ทดสอบ/นำกลับมาใช้ซ้ำได้
 */
export function hasRealProblem(
  analysis: { problems: ChatProblem[]; insufficientData?: boolean } | null | undefined
): boolean {
  if (!analysis || analysis.insufficientData) return false;
  return analysis.problems.some(isRealProblem);
}

/** problem จริงตัวแรก (ไว้แสดงหมวด+detail เด่น) — null ถ้าไม่มี */
export function firstRealProblem(
  analysis: { problems: ChatProblem[] } | null | undefined
): ChatProblem | null {
  if (!analysis) return null;
  return analysis.problems.find(isRealProblem) ?? null;
}

/** เก็บเฉพาะ problem จริง (ตัด other/detail ว่าง) — ใช้แสดงในหน้าลูกค้าเสี่ยง */
export function realProblemsOf(
  analysis: { problems: ChatProblem[] } | null | undefined
): ChatProblem[] {
  if (!analysis) return [];
  return analysis.problems.filter(isRealProblem);
}

/**
 * map "การวิเคราะห์ล่าสุดต่อกลุ่ม" (rows เรียง window_end desc มาก่อน → ตัวแรกของกลุ่ม = ล่าสุด)
 *   ★ pure: ผู้เรียก query + order มาให้
 */
export function latestAnalysisByGroup(
  rows: { chat_group_id: string; summary: string | null; problems: unknown; insufficient_data?: boolean | null }[]
): Map<string, GroupAnalysis> {
  const out = new Map<string, GroupAnalysis>();
  for (const r of rows) {
    if (out.has(r.chat_group_id)) continue; // ตัวแรก = ล่าสุด (desc)
    out.set(r.chat_group_id, {
      problems: parseProblems(r.problems),
      summary: r.summary,
      insufficientData: r.insufficient_data === true,
    });
  }
  return out;
}

/**
 * นับ "AI รอหัวหน้าตรวจ" จากวิเคราะห์ล่าสุดต่อกลุ่ม:
 *   needs_human_review = true หรือ confidence ต่ำกว่าเกณฑ์ (LOW_CONFIDENCE)
 *   ★ นับต่อกลุ่ม (ล่าสุด) ไม่นับซ้ำหลาย window ของกลุ่มเดียว
 */
export function countAiPendingReview(rows: AnalysisRaw[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const r of rows) {
    if (seen.has(r.chat_group_id)) continue; // ตัวแรก = ล่าสุด
    seen.add(r.chat_group_id);
    if (r.needs_human_review || (typeof r.confidence === "number" && r.confidence < LOW_CONFIDENCE)) {
      n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------
// 1) Executive Dashboard — ภาพรวมทั้ง tenant
// ---------------------------------------------------------------------
export async function getExecChatDashboard(
  db: DB,
  nowMs: number = Date.now()
): Promise<ExecChatDashboard> {
  const [
    { data: caseData },
    { data: groupData },
    { data: riskData },
    { data: violData },
    { data: analysisData },
  ] = await Promise.all([
    db.from("conversation_cases").select(CASE_COLS).is("deleted_at", null).limit(CASE_LIMIT),
    db
      .from("chat_groups")
      .select("id")
      .is("deleted_at", null)
      .eq("is_active", true)
      // ★ กันปน (Phase A): นับเฉพาะกลุ่มจริง (group/room) ไม่รวมบทสนทนา 1-1 (group_kind='user')
      .in("group_kind", ["group", "room"])
      .limit(CASE_LIMIT),
    db.from("risk_alerts").select("case_id, level, status").in("status", ACTIVE_RISK).limit(CASE_LIMIT),
    db.from("sop_violations").select("violation_type, chat_group_id").is("deleted_at", null).limit(CASE_LIMIT),
    // ★ วิเคราะห์ล่าสุดต่อกลุ่ม (เรียง window_end desc) — ใช้ทั้ง incident detail + นับ AI รอตรวจ + กรองปัญหาจริง
    db
      .from("ai_chat_analysis")
      .select("chat_group_id, summary, problems, confidence, needs_human_review, insufficient_data, window_end")
      .is("deleted_at", null)
      .order("window_end", { ascending: false })
      .limit(CASE_LIMIT),
  ]);

  const cases = (caseData ?? []) as ConversationCaseRow[];
  logTruncate("exec cases", cases.length, CASE_LIMIT);
  const risks = (riskData ?? []) as { case_id: string | null; level: string; status: string }[];
  const violations = (violData ?? []) as { violation_type: string; chat_group_id: string }[];
  const analysisRows = (analysisData ?? []) as AnalysisRaw[];

  const summary = summarizeExecCases(cases, nowMs);
  const analysisByGroup = latestAnalysisByGroup(analysisRows);

  // ★ "ลูกค้าเสี่ยง" = นับเฉพาะ risk ที่กลุ่ม (ผ่านเคส) มี analysis เจอปัญหาจริง
  //   risk ที่ไม่มีเคส / กลุ่มไม่มีปัญหาจริง (แค่ sentiment/ข้อมูลไม่พอ) → ไม่นับ
  const caseGroupById = new Map<string, string>();
  for (const c of cases) caseGroupById.set(c.id, c.chat_group_id);
  const activeRisk = risks.filter((r) => {
    const gid = r.case_id ? caseGroupById.get(r.case_id) : undefined;
    return gid ? hasRealProblem(analysisByGroup.get(gid)) : false;
  }).length;

  const complaints = risks.filter((r) => r.level === "orange" || r.level === "red").length;
  const cancelRisk = risks.filter((r) => r.level === "red").length;

  // ★ M2: อัตราทวงซ้ำ = "เคสเปิด" ที่กลุ่มมี violation repeat_doc_request ÷ "เคสเปิด" ทั้งหมด
  //   (numerator/denominator มาจากชุดเดียวกัน = เคสเปิด — ไม่ปนหน่วย)
  const openCases = cases.filter((c) => !CLOSED.has(c.status));
  const repeatRate = computeRepeatRate(openCases, violations);

  // ★ เรื่องรอตอบ = เคสเปิดที่ยังไม่ตอบครั้งแรก
  const waitingCases = openCases.filter((c) => !c.first_responded_at).length;

  // fallback ลูกค้า/ผู้รับผิดชอบ จากกลุ่ม (เมื่อเคสไม่มี) — ดึงเฉพาะกลุ่มของเคสที่เปิด
  const openGroupIds = [...new Set(openCases.map((c) => c.chat_group_id))];
  type GroupFbRow = { id: string; customer_id: string | null; responsible_employee_id: string | null };
  const { data: groupFbData } =
    openGroupIds.length > 0
      ? await db
          .from("chat_groups")
          .select("id, customer_id, responsible_employee_id")
          .in("id", openGroupIds)
          .limit(CASE_LIMIT)
      : { data: [] as GroupFbRow[] };
  const groupFallback = new Map<string, { customerId: string | null; responsibleId: string | null }>();
  for (const g of (groupFbData ?? []) as GroupFbRow[]) {
    groupFallback.set(g.id, { customerId: g.customer_id, responsibleId: g.responsible_employee_id });
  }

  // รหัสลูกค้า (ปลอมนาม) + ชื่อผู้รับผิดชอบ — รวมทั้งของเคสและ fallback จากกลุ่ม
  const custIds = [
    ...new Set(
      [
        ...openCases.map((c) => c.customer_id),
        ...[...groupFallback.values()].map((g) => g.customerId),
      ].filter((x): x is string => !!x)
    ),
  ];
  const ownerIds = [
    ...openCases.map((c) => c.owner_employee_id),
    ...cases.map((c) => c.owner_employee_id), // เผื่อ ownerBacklog
    ...[...groupFallback.values()].map((g) => g.responsibleId),
  ].filter((x): x is string => !!x);

  type CustRow = { id: string; customer_code: string | null };
  const [names, custRes] = await Promise.all([
    fetchEmployeeNames(db, ownerIds),
    custIds.length > 0
      ? db.from("customers").select("id, customer_code").in("id", custIds)
      : Promise.resolve({ data: [] as CustRow[] }),
  ]);
  const custCode = new Map<string, string>();
  for (const c of (custRes.data ?? []) as CustRow[]) {
    custCode.set(c.id, c.customer_code ?? c.id.slice(0, 8));
  }

  return {
    totalGroups: (groupData ?? []).length,
    ...summary,
    waitingCases,
    activeRisk,
    aiPendingReview: countAiPendingReview(analysisRows),
    complaints,
    cancelRisk,
    repeatRate,
    topProblems: topProblemsFromViolations(violations),
    ownerBacklog: computeOwnerBacklog(cases, nowMs, names, analysisByGroup),
    incidents: buildIncidents(openCases, analysisByGroup, groupFallback, custCode, names, nowMs),
    careHealth: computeCareHealth7d(cases, nowMs),
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

  // ★ M1: attribute needs_expert_review "ต่อเคส → owner" (ไม่ใช่ chat_group last-write-wins)
  //   1) caseOwner: caseId → owner ; 2) messageOwner: chat_message_id → owner (ผ่าน case_messages)
  //   3) groupSingleOwner: กลุ่มที่มี owner เดียวเท่านั้น (fallback เมื่อ violation ไม่มี evidence)
  const caseOwner = new Map<string, string>();
  for (const c of cases) {
    if (c.owner_employee_id) caseOwner.set(c.id, c.owner_employee_id);
  }
  const caseIds = [...caseOwner.keys()];
  const groupIds = [...new Set(cases.map((c) => c.chat_group_id))];
  const groupSingleOwner = buildGroupSingleOwner(cases);

  // ★ perf: 3 query นี้ไม่ขึ้นต่อกัน (link ↔ violation ↔ ชื่อสมาชิก) → ยิงขนาน
  //   messageOwner ต้องประกอบก่อนค่อย attribute violation (คงลำดับพึ่งพาไว้)
  type LinkRow = { case_id: string; chat_message_id: string };
  type ViolRow = { evidence_message_id: string | null; chat_group_id: string };
  const [linkRes, violRes, names] = await Promise.all([
    caseIds.length > 0
      ? db.from("case_messages").select("case_id, chat_message_id").in("case_id", caseIds).limit(CASE_LIMIT)
      : Promise.resolve({ data: [] as LinkRow[] }),
    groupIds.length > 0
      ? db
          .from("sop_violations")
          .select("evidence_message_id, chat_group_id")
          .eq("needs_expert_review", true)
          .in("chat_group_id", groupIds)
          .is("deleted_at", null)
          .limit(CASE_LIMIT)
      : Promise.resolve({ data: [] as ViolRow[] }),
    fetchEmployeeNames(db, memberIds),
  ]);

  const messageOwner = new Map<string, string>();
  for (const l of (linkRes.data ?? []) as LinkRow[]) {
    const owner = caseOwner.get(l.case_id);
    if (owner) messageOwner.set(l.chat_message_id, owner);
  }

  const viols = (violRes.data ?? []) as ViolRow[];
  const expertByOwner = attributeExpertViolations(viols, messageOwner, groupSingleOwner);

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

  // ── ขั้นที่ 1: เคสที่ผูกกับ alert → chat_group_id + fallback ลูกค้า/เจ้าของ ──
  const caseIds = [...new Set(rows.map((r) => r.case_id).filter((x): x is string => !!x))];
  type CaseFbRow = {
    id: string;
    chat_group_id: string;
    customer_id: string | null;
    owner_employee_id: string | null;
  };
  const { data: caseFbData } =
    caseIds.length > 0
      ? await db
          .from("conversation_cases")
          .select("id, chat_group_id, customer_id, owner_employee_id")
          .in("id", caseIds)
          .is("deleted_at", null)
          .limit(CASE_LIMIT)
      : { data: [] as CaseFbRow[] };
  const caseMap = new Map<string, CaseFbRow>();
  for (const c of (caseFbData ?? []) as CaseFbRow[]) caseMap.set(c.id, c);

  // ── ขั้นที่ 2: กลุ่มของเคส → วิเคราะห์ล่าสุด (problems/summary) + fallback กลุ่ม ──
  const groupIds = [...new Set([...caseMap.values()].map((c) => c.chat_group_id))];
  type GroupFbRow = { id: string; customer_id: string | null; responsible_employee_id: string | null };
  const [groupFbRes, analysisRes] =
    groupIds.length > 0
      ? await Promise.all([
          db
            .from("chat_groups")
            .select("id, customer_id, responsible_employee_id")
            .in("id", groupIds)
            .limit(CASE_LIMIT),
          db
            .from("ai_chat_analysis")
            .select("chat_group_id, summary, problems, insufficient_data, window_end")
            .in("chat_group_id", groupIds)
            .is("deleted_at", null)
            .order("window_end", { ascending: false })
            .limit(CASE_LIMIT),
        ])
      : [
          { data: [] as GroupFbRow[] },
          { data: [] as { chat_group_id: string; summary: string | null; problems: unknown; insufficient_data?: boolean | null }[] },
        ];
  const groupMap = new Map<string, GroupFbRow>();
  for (const g of (groupFbRes.data ?? []) as GroupFbRow[]) groupMap.set(g.id, g);
  const analysisByGroup = latestAnalysisByGroup(
    (analysisRes.data ?? []) as { chat_group_id: string; summary: string | null; problems: unknown; insufficient_data?: boolean | null }[]
  );

  // ── ขั้นที่ 3: รหัสลูกค้า (ปลอมนาม) + ชื่อผู้รับผิดชอบ (รวม fallback เคส/กลุ่ม) ──
  const custIds = [
    ...new Set(
      [
        ...rows.map((r) => r.customer_id),
        ...[...caseMap.values()].map((c) => c.customer_id),
        ...[...groupMap.values()].map((g) => g.customer_id),
      ].filter((x): x is string => !!x)
    ),
  ];
  const ownerIds = [
    ...rows.map((r) => r.owner_employee_id),
    ...[...caseMap.values()].map((c) => c.owner_employee_id),
    ...[...groupMap.values()].map((g) => g.responsible_employee_id),
  ].filter((x): x is string => !!x);

  type CustRow = { id: string; customer_code: string | null };
  const [names, custRes] = await Promise.all([
    fetchEmployeeNames(db, ownerIds),
    custIds.length > 0
      ? db.from("customers").select("id, customer_code").in("id", custIds)
      : Promise.resolve({ data: [] as CustRow[] }),
  ]);

  const custCode = new Map<string, string>();
  for (const c of (custRes.data ?? []) as CustRow[]) {
    custCode.set(c.id, c.customer_code ?? c.id.slice(0, 8));
  }

  const rank: Record<string, number> = { red: 0, orange: 1, yellow: 2, green: 3 };
  return rows
    .map((r) => {
      const kase = r.case_id ? caseMap.get(r.case_id) : undefined;
      const group = kase ? groupMap.get(kase.chat_group_id) : undefined;
      // ★ ลูกค้า/ผู้รับผิดชอบ: alert → เคส → กลุ่ม (เอาค่าแรกที่มี)
      const custId = r.customer_id ?? kase?.customer_id ?? group?.customer_id ?? null;
      const ownerId = r.owner_employee_id ?? kase?.owner_employee_id ?? group?.responsible_employee_id ?? null;
      const analysis = kase ? analysisByGroup.get(kase.chat_group_id) : undefined;
      return {
        row: {
          alertId: r.id,
          caseId: r.case_id,
          // ★ pseudonymity: แสดง "รหัสลูกค้า" ไม่ใช่ชื่อจริง
          customerLabel: custId ? custCode.get(custId) ?? "—" : "—",
          level: r.level,
          reason: r.reason,
          // ★ โชว์เฉพาะ problem จริง (ตัด other/detail ว่าง) — เน้นสิ่งที่ AI ตรวจได้จริง
          problems: realProblemsOf(analysis),
          summary: analysis?.summary ?? null,
          ownerName: nameOf(names, ownerId),
          status: r.status,
          escalated: !!r.escalated_at,
        } satisfies RiskRow,
        // ★ กรอง: แสดงเฉพาะ risk ที่ analysis เจอปัญหาจริง — ตัด noise (แค่ sentiment/ข้อมูลไม่พอ)
        real: hasRealProblem(analysis),
      };
    })
    .filter((x) => x.real)
    .map((x) => x.row)
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
  // capture ฟิลด์ที่ closure ด้านล่างใช้ (closure จะ re-widen kase เป็น nullable)
  const chatGroupId = kase.chat_group_id;
  const customerId = kase.customer_id;
  const ownerEmployeeId = kase.owner_employee_id;

  // ไทม์ไลน์แชต = สาย query ที่พึ่งพากันจริง (case_messages → chat_messages → chat_members)
  //   คงลำดับภายในไว้ แต่ทั้งสายนี้ไม่ขึ้นกับ analysis/violations/ชื่อ/ลูกค้า
  async function loadTimeline(): Promise<TimelineMessage[]> {
    const { data: linkData } = await db
      .from("case_messages")
      .select("chat_message_id")
      .eq("case_id", caseId)
      .limit(MSG_LIMIT);
    const msgIds = ((linkData ?? []) as { chat_message_id: string }[]).map((x) => x.chat_message_id);
    logTruncate("case messages", msgIds.length, MSG_LIMIT);
    if (msgIds.length === 0) return [];

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
    return buildTimeline(raw, canDecrypt, decryptField);
  }

  async function loadCustomerLabel(): Promise<string> {
    if (!customerId) return "—";
    const { data: cust } = await db
      .from("customers")
      .select("customer_code")
      .eq("id", customerId)
      .maybeSingle();
    return (cust as { customer_code: string | null } | null)?.customer_code ?? "—";
  }

  // ★ perf: ไทม์ไลน์ / ผลวิเคราะห์ AI / violations / ชื่อ owner / รหัสลูกค้า ต่างขึ้นกับ kase
  //   แต่ไม่ขึ้นต่อกัน → ยิงขนานทั้งชุด (ผลลัพธ์เท่าเดิม)
  const [timeline, aiRes, violRes, names, customerLabel] = await Promise.all([
    loadTimeline(),
    db
      .from("ai_chat_analysis")
      .select(
        "id, window_start, window_end, summary, sentiment, urgency, customer_facts, ai_assumptions, evidence, flow_steps, problems, confidence, insufficient_data, needs_human_review"
      )
      .eq("chat_group_id", chatGroupId)
      .is("deleted_at", null)
      .order("window_end", { ascending: false })
      .limit(1),
    db
      .from("sop_violations")
      .select("id, violation_type, severity, evidence_message_id, description, needs_expert_review")
      .eq("chat_group_id", chatGroupId)
      .is("deleted_at", null)
      .limit(100),
    fetchEmployeeNames(db, [ownerEmployeeId ?? ""].filter(Boolean)),
    loadCustomerLabel(),
  ]);
  const analysis = ((aiRes.data ?? [])[0] as AiChatAnalysisRow | undefined) ?? null;
  const violations = (violRes.data ?? []) as SopViolationRow[];

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
