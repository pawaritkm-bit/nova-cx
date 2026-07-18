import { describe, it, expect } from "vitest";
import { buildCoaching } from "@/lib/evaluation/coach";
import { computeDimensionScores, type CaseSignal } from "@/lib/evaluation/scoring";

function makeCase(o: Partial<CaseSignal> = {}): CaseSignal {
  return {
    caseId: "c1",
    hasOwner: true,
    status: "closed",
    requestAt: "2026-07-20T03:00:00Z",
    firstRespondedAt: "2026-07-20T03:30:00Z",
    firstResponseDueAt: null,
    resolutionDueAt: null,
    closedAt: "2026-07-20T08:00:00Z",
    reopened: false,
    flowSteps: [{ step: "close", status: "done" }],
    problemsCount: 0,
    sopViolations: [],
    ...o,
  };
}

describe("buildCoaching — โทนโค้ช ไม่จับผิด", () => {
  it("มิติอ่อน (<60) → improvements + example_answers + checklist + training_topics", () => {
    const now = new Date("2026-07-20T12:00:00Z");
    const cases = [
      makeCase({
        firstRespondedAt: null,
        status: "open",
        closedAt: null,
        firstResponseDueAt: "2026-07-20T07:00:00Z", // เลย due → sla อ่อน
      }),
    ];
    const bd = computeDimensionScores({ cases, now });
    const coaching = buildCoaching({ scores: bd.scores, breakdown: bd, cases });
    expect(coaching.improvements.length).toBeGreaterThan(0);
    expect(coaching.example_answers.length).toBe(coaching.improvements.length);
    expect(coaching.checklist.length).toBe(coaching.improvements.length);
    expect(coaching.training_topics.length).toBe(coaching.improvements.length);
    // sla อ่อน → ต้องมีคำแนะนำเรื่องเวลาตอบ
    expect(coaching.improvements.join(" ")).toContain("การตอบตรงเวลา");
  });

  it("มิติเด่น (>=80) → strengths เป็นคำชม", () => {
    const cases = [makeCase()];
    const bd = computeDimensionScores({
      cases,
      qualitative: { correctness: 95, completeness: 90, clarity: 85, politeness: 88 },
    });
    const coaching = buildCoaching({ scores: bd.scores, breakdown: bd, cases });
    expect(coaching.strengths.length).toBeGreaterThan(0);
    expect(coaching.strengths.join(" ")).toMatch(/ทำได้ดี|เยี่ยม/);
  });

  it("repeated_errors: sop ระดับสูงเกิดซ้ำ → เตือน", () => {
    const cases = [
      makeCase({ sopViolations: [{ severity: "high" }] }),
      makeCase({ caseId: "c2", sopViolations: [{ severity: "high" }] }),
    ];
    const bd = computeDimensionScores({ cases });
    const coaching = buildCoaching({ scores: bd.scores, breakdown: bd, cases });
    expect(coaching.repeated_errors.length).toBeGreaterThan(0);
    expect(coaching.repeated_errors.join(" ")).toContain("ระดับสูง");
  });

  it("ไม่มีมิติเด่น → strengths ยังให้กำลังใจ (ไม่ว่าง)", () => {
    const cases = [makeCase({ firstRespondedAt: null, status: "open", closedAt: null })];
    const bd = computeDimensionScores({ cases, sentiment: "negative" });
    const coaching = buildCoaching({ scores: bd.scores, breakdown: bd, cases });
    expect(coaching.strengths.length).toBeGreaterThan(0);
  });
});
