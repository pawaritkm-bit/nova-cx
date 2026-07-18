/**
 * คำนวณคะแนน 8 มิติของนักบัญชีจาก "signal จริง" (Phase 4) — ★ ฟังก์ชันบริสุทธิ์ testable
 *
 *   เชิงปริมาณ (จาก signal เคส/บทสนทนา):
 *     - sla        : ตอบครั้งแรกทันเวลา "ทำการ" (นับเฉพาะเวลาทำการ — กันโทษนอกเวลา/วันหยุด)
 *     - ownership  : มีเจ้าของงาน + ติดตาม/อัปเดตความคืบหน้า
 *     - resolution : ปิดงานได้จริง (หัก reopen)
 *     - sop        : ทำตามมาตรฐาน (หักตาม severity ของ sop_violations)
 *   เชิงคุณภาพ (จาก AI): correctness / completeness / clarity / politeness
 *
 *   ★ กติกาผู้ใช้:
 *     - ไม่ลดคะแนนจากข้อความนอกเวลางาน/วันหยุด → sla ใช้ businessMinutesBetween
 *     - ไม่ให้คะแนนจาก "จำนวนข้อความ" อย่างเดียว → ทุกมิติวัดคุณภาพ/ผลลัพธ์/ตรงเวลา
 *     - ข้อมูลไม่พอ (ไม่มีเคสให้วัดมิตินั้น) → คะแนนมิตินั้น = undefined (ไม่ดึง overall ต่ำเกินจริง)
 */

import { businessMinutesBetween } from "./business-hours";
import {
  clampScore,
  weightedOverall,
  type DimensionScores,
  type Dimension,
  type Weights,
  DEFAULT_WEIGHTS,
} from "./weights";

/** ผล flow 1 ขั้น (จาก ai_chat_analysis.flow_steps) */
export type FlowStep = { step: string; status: string };

/** signal ต่อเคส (นักบัญชีเป็น owner) — aggregate มาจาก conversation_cases + ai_chat_analysis */
export type CaseSignal = {
  caseId: string;
  hasOwner: boolean;
  status: string; // open|in_progress|waiting_customer|resolved|closed|reopened
  /** เวลาที่ลูกค้าเริ่มขอ/เปิดเคส (ไว้คำนวณเวลาตอบ) */
  requestAt: string; // ISO
  firstRespondedAt: string | null;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  closedAt: string | null;
  reopened: boolean;
  flowSteps: FlowStep[];
  problemsCount: number;
  sopViolations: { severity: "low" | "medium" | "high" }[];
  /** message id ที่เป็นหลักฐานตอบครั้งแรก (ไว้แนบ evidence) */
  firstResponseMessageId?: string | null;
};

/** คะแนนเชิงคุณภาพจาก AI (0-100 ต่อมิติ) */
export type QualitativeScores = Partial<
  Pick<DimensionScores, "correctness" | "completeness" | "clarity" | "politeness">
>;

export type ScoreInputs = {
  cases: CaseSignal[];
  qualitative?: QualitativeScores;
  /** sentiment ภาพรวม (ใช้ fallback มิติคุณภาพเมื่อ AI ไม่มีคะแนน) */
  sentiment?: "positive" | "neutral" | "negative";
  /** เป้าหมายเวลาตอบครั้งแรก (นาทีทำการ) — default 240 = 4 ชม.ทำการ */
  firstResponseTargetMinutes?: number;
  holidays?: ReadonlySet<string>;
  /** เวลาปัจจุบัน (สำหรับตัดสินว่าเคสยังไม่ตอบเลย due หรือยัง) — default new Date() */
  now?: Date;
};

/** ปัดทศนิยม 2 ตำแหน่งให้สม่ำเสมอกับ overall (L1) */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export type ScoreBreakdown = {
  scores: Partial<DimensionScores>;
  detail: {
    sla: { considered: number; met: number };
    ownership: { considered: number; withOwner: number; withFollowUp: number };
    resolution: { considered: number; closed: number; reopened: number };
    sop: { violations: number; penalty: number };
  };
};

const DEFAULT_FIRST_RESPONSE_TARGET_MIN = 240; // 4 ชม.ทำการ
const CLOSED_STATUSES = new Set(["resolved", "closed"]);
const FOLLOW_UP_STEPS = new Set(["update", "execute", "close"]);

/** true = เคสนี้มีการติดตาม/อัปเดต/ปิดงาน (flow step ที่บ่งบอกความรับผิดชอบ) */
function hasFollowUp(c: CaseSignal): boolean {
  if (CLOSED_STATUSES.has(c.status)) return true;
  return c.flowSteps.some(
    (s) => FOLLOW_UP_STEPS.has(s.step) && (s.status === "done" || s.status === "partial")
  );
}

/**
 * มิติ SLA — ตอบครั้งแรกทันเวลาทำการ
 *   ★ นับ "เวลาทำการ" ระหว่างลูกค้าขอ → ตอบครั้งแรก (businessMinutesBetween)
 *     → ตอบข้ามคืน/ข้ามสุดสัปดาห์ไม่ถูกนับเป็นช้า (กันโทษนอกเวลางาน)
 *   - ตอบแล้ว: met = เวลาทำการที่ใช้ <= เป้าหมาย
 *   - ยังไม่ตอบ: ถือว่าไม่ผ่าน (พลาดการตอบครั้งแรก)
 */
function scoreSla(inp: ScoreInputs): { score?: number; considered: number; met: number } {
  const target = inp.firstResponseTargetMinutes ?? DEFAULT_FIRST_RESPONSE_TARGET_MIN;
  const holidays = inp.holidays ?? new Set<string>();
  const nowMs = (inp.now ?? new Date()).getTime();
  let considered = 0;
  let met = 0;
  for (const c of inp.cases) {
    if (c.firstRespondedAt) {
      // ตอบแล้ว → นับ + met ถ้าอยู่ในเป้าหมายเวลาทำการ
      considered += 1;
      const mins = businessMinutesBetween(
        new Date(c.requestAt),
        new Date(c.firstRespondedAt),
        holidays
      );
      if (mins <= target) met += 1;
      continue;
    }
    // ยังไม่ตอบ:
    // ★ M2: อย่านับเคสที่ "ปิดโดยไม่ต้องตอบ" หรือ "ยังไม่ถึง due" เป็น fail
    if (CLOSED_STATUSES.has(c.status)) continue; // ปิดโดยไม่มีการตอบครั้งแรก → ไม่คิดโทษ
    if (c.firstResponseDueAt && new Date(c.firstResponseDueAt).getTime() < nowMs) {
      considered += 1; // เลยกำหนดตอบแล้วยังไม่ตอบ = breach จริง
    }
    // ยังไม่ถึง due (pending) → ข้าม ไม่นับ
  }
  if (considered === 0) return { considered: 0, met: 0 };
  return { score: round2((met / considered) * 100), considered, met };
}

/** มิติ ownership — มีเจ้าของ (50) + มีการติดตาม/อัปเดต (50) เฉลี่ยต่อเคส */
function scoreOwnership(cases: CaseSignal[]): {
  score?: number;
  considered: number;
  withOwner: number;
  withFollowUp: number;
} {
  if (cases.length === 0) return { considered: 0, withOwner: 0, withFollowUp: 0 };
  let withOwner = 0;
  let withFollowUp = 0;
  let acc = 0;
  for (const c of cases) {
    const o = c.hasOwner ? 1 : 0;
    const f = hasFollowUp(c) ? 1 : 0;
    withOwner += o;
    withFollowUp += f;
    acc += o * 50 + f * 50;
  }
  return {
    score: round2(clampScore(acc / cases.length)),
    considered: cases.length,
    withOwner,
    withFollowUp,
  };
}

/** มิติ resolution — ปิดงานได้จริง (closed ratio) หัก reopen -30/เคส */
function scoreResolution(cases: CaseSignal[]): {
  score?: number;
  considered: number;
  closed: number;
  reopened: number;
} {
  if (cases.length === 0) return { considered: 0, closed: 0, reopened: 0 };
  let closed = 0;
  let reopened = 0;
  let acc = 0;
  for (const c of cases) {
    const isClosed = CLOSED_STATUSES.has(c.status);
    if (isClosed) closed += 1;
    if (c.reopened) reopened += 1;
    let s = isClosed ? 100 : 0;
    if (c.reopened) s = Math.max(0, s - 30);
    acc += s;
  }
  return {
    score: round2(clampScore(acc / cases.length)),
    considered: cases.length,
    closed,
    reopened,
  };
}

const SOP_PENALTY: Record<"low" | "medium" | "high", number> = {
  low: 5,
  medium: 10,
  high: 20,
};

/**
 * มิติ SOP — ★ เฉลี่ย "ต่อเคส" (เหมือน ownership/resolution)
 *   แต่ละเคสเริ่ม 100 หักตาม severity ของ violation ในเคสนั้น (floor 0) แล้วเฉลี่ย
 *   → คนปิดงานเยอะแต่ผิดน้อยไม่ถูกหักหนักจากผลรวม penalty ข้ามทุกเคส
 */
function scoreSop(cases: CaseSignal[]): { score?: number; violations: number; penalty: number } {
  if (cases.length === 0) return { violations: 0, penalty: 0 };
  let violations = 0;
  let totalPenalty = 0;
  let acc = 0;
  for (const c of cases) {
    let casePenalty = 0;
    for (const v of c.sopViolations) {
      violations += 1;
      const pen = SOP_PENALTY[v.severity] ?? SOP_PENALTY.low;
      casePenalty += pen;
      totalPenalty += pen;
    }
    acc += Math.max(0, 100 - casePenalty);
  }
  return { score: round2(acc / cases.length), violations, penalty: totalPenalty };
}

/** fallback คะแนนคุณภาพจาก sentiment เมื่อ AI ไม่ได้ให้คะแนน (กันมิติว่างทั้งหมด) */
function sentimentBaseline(sentiment?: string): number | undefined {
  if (sentiment === "positive") return 85;
  if (sentiment === "neutral") return 70;
  if (sentiment === "negative") return 55;
  return undefined; // ไม่มี sentiment → ปล่อยว่าง (ให้ AI เท่านั้น)
}

/**
 * รวมมิติเชิงคุณภาพ (AI) + fallback sentiment
 *   ★ ไม่เดาคะแนนถ้าไม่มีทั้ง AI และ sentiment → undefined (needs_review อยู่แล้ว)
 */
function qualitativeScores(inp: ScoreInputs): Partial<DimensionScores> {
  const base = sentimentBaseline(inp.sentiment);
  const q = inp.qualitative ?? {};
  const out: Partial<DimensionScores> = {};
  for (const d of ["correctness", "completeness", "clarity", "politeness"] as const) {
    const v = q[d];
    if (v !== undefined && v !== null && Number.isFinite(v)) out[d] = round2(clampScore(v));
    else if (base !== undefined) out[d] = base;
  }
  return out;
}

/** คำนวณคะแนน 8 มิติ + breakdown (ไว้สร้าง evidence/coaching) */
export function computeDimensionScores(inp: ScoreInputs): ScoreBreakdown {
  const sla = scoreSla(inp);
  const own = scoreOwnership(inp.cases);
  const res = scoreResolution(inp.cases);
  const sop = scoreSop(inp.cases);
  const qual = qualitativeScores(inp);

  const scores: Partial<DimensionScores> = { ...qual };
  if (sla.score !== undefined) scores.sla = sla.score;
  if (own.score !== undefined) scores.ownership = own.score;
  if (res.score !== undefined) scores.resolution = res.score;
  if (sop.score !== undefined) scores.sop = sop.score;

  return {
    scores,
    detail: {
      sla: { considered: sla.considered, met: sla.met },
      ownership: {
        considered: own.considered,
        withOwner: own.withOwner,
        withFollowUp: own.withFollowUp,
      },
      resolution: { considered: res.considered, closed: res.closed, reopened: res.reopened },
      sop: { violations: sop.violations, penalty: sop.penalty },
    },
  };
}

/** คำนวณคะแนน 8 มิติ + overall (ปรับด้วยน้ำหนัก) ในขั้นตอนเดียว */
export function computeEvaluationScore(
  inp: ScoreInputs,
  weights: Partial<Weights> = DEFAULT_WEIGHTS
): { scores: Partial<DimensionScores>; overall: number; breakdown: ScoreBreakdown } {
  const breakdown = computeDimensionScores(inp);
  const overall = weightedOverall(breakdown.scores, weights);
  return { scores: breakdown.scores, overall, breakdown };
}

/** มิติที่ควรชม (>=80) / ควรปรับ (<60) — ใช้สร้าง coaching + strengths/improvements */
export function classifyDimensions(scores: Partial<DimensionScores>): {
  strengths: Dimension[];
  improvements: Dimension[];
} {
  const strengths: Dimension[] = [];
  const improvements: Dimension[] = [];
  for (const d of Object.keys(scores) as Dimension[]) {
    const v = scores[d];
    if (v === undefined) continue;
    if (v >= 80) strengths.push(d);
    else if (v < 60) improvements.push(d);
  }
  return { strengths, improvements };
}
