import { describe, it, expect } from "vitest";
import {
  computeDimensionScores,
  computeEvaluationScore,
  classifyDimensions,
  type CaseSignal,
} from "@/lib/evaluation/scoring";
import { DEFAULT_WEIGHTS } from "@/lib/evaluation/weights";

function makeCase(o: Partial<CaseSignal> = {}): CaseSignal {
  return {
    caseId: "c1",
    hasOwner: true,
    status: "closed",
    requestAt: "2026-07-20T03:00:00Z", // จันทร์ 10:00 ไทย
    firstRespondedAt: "2026-07-20T03:30:00Z", // ตอบใน 30 นาที
    firstResponseDueAt: "2026-07-20T07:00:00Z",
    resolutionDueAt: "2026-07-20T09:00:00Z",
    closedAt: "2026-07-20T08:00:00Z",
    reopened: false,
    flowSteps: [{ step: "close", status: "done" }],
    problemsCount: 0,
    sopViolations: [],
    ...o,
  };
}

describe("computeDimensionScores — มิติเชิงปริมาณจาก signal", () => {
  it("เคสดีเต็ม: sla/ownership/resolution/sop = 100", () => {
    const { scores, detail } = computeDimensionScores({ cases: [makeCase()] });
    expect(scores.sla).toBe(100);
    expect(scores.ownership).toBe(100);
    expect(scores.resolution).toBe(100);
    expect(scores.sop).toBe(100);
    expect(detail.sla.met).toBe(1);
  });

  it("★ SLA: ตอบข้ามสุดสัปดาห์ (นอกเวลางาน) ไม่ถูกหักคะแนน", () => {
    // ลูกค้าทักศุกร์ 17:30 (10:30Z) ตอบจันทร์ 9:30 (02:30Z) = 60 นาทีทำการ <= 240 → ผ่าน
    const c = makeCase({
      requestAt: "2026-07-24T10:30:00Z",
      firstRespondedAt: "2026-07-27T02:30:00Z",
    });
    const { scores } = computeDimensionScores({ cases: [c], firstResponseTargetMinutes: 240 });
    expect(scores.sla).toBe(100); // ไม่ถูกนับว่าช้าเพราะข้ามวันหยุด
  });

  it("SLA: ตอบเกินเป้าหมายเวลาทำการ → หัก", () => {
    // ตอบหลัง 5 ชม.ทำการ (300 นาที) > target 240
    const c = makeCase({
      requestAt: "2026-07-20T02:00:00Z", // 9:00 ไทย
      firstRespondedAt: "2026-07-20T07:00:00Z", // 14:00 ไทย = 300 นาทีทำการ
    });
    const { scores } = computeDimensionScores({ cases: [c], firstResponseTargetMinutes: 240 });
    expect(scores.sla).toBe(0);
  });

  it("SLA: ยังไม่ตอบ + เปิดค้าง + เลย due → ไม่ผ่าน (0)", () => {
    const now = new Date("2026-07-20T12:00:00Z");
    const c = makeCase({
      firstRespondedAt: null,
      status: "open",
      closedAt: null,
      firstResponseDueAt: "2026-07-20T07:00:00Z", // เลย due แล้ว
    });
    const { scores } = computeDimensionScores({ cases: [c], now });
    expect(scores.sla).toBe(0);
  });

  it("ownership: ไม่มี owner + ไม่ติดตาม → 0", () => {
    const c = makeCase({ hasOwner: false, status: "open", flowSteps: [], closedAt: null });
    const { scores } = computeDimensionScores({ cases: [c] });
    expect(scores.ownership).toBe(0);
  });

  it("resolution: เปิดค้าง = 0 ; reopened หัก 30", () => {
    const open = computeDimensionScores({ cases: [makeCase({ status: "open", closedAt: null })] });
    expect(open.scores.resolution).toBe(0);
    const reopened = computeDimensionScores({
      cases: [makeCase({ status: "closed", reopened: true })],
    });
    expect(reopened.scores.resolution).toBe(70);
  });

  it("sop: หักตาม severity ในเคสเดียว (high -20, medium -10, low -5)", () => {
    const c = makeCase({
      sopViolations: [{ severity: "high" }, { severity: "medium" }, { severity: "low" }],
    });
    const { scores } = computeDimensionScores({ cases: [c] });
    expect(scores.sop).toBe(65); // เคสเดียว: 100 - 35
  });

  it("★ sop เฉลี่ยต่อเคส (ไม่รวม penalty ข้ามทุกเคส): 2 เคส (เสีย/ดี) = 90", () => {
    const bad = makeCase({ caseId: "c1", sopViolations: [{ severity: "high" }] }); // 80
    const good = makeCase({ caseId: "c2", sopViolations: [] }); // 100
    const { scores } = computeDimensionScores({ cases: [bad, good] });
    expect(scores.sop).toBe(90); // (80+100)/2 — ไม่ใช่ 100-20=80 แบบผลรวม
  });

  it("★ M2: เคสยังไม่ตอบและยังไม่ถึง due → ไม่นับเป็น fail (pending)", () => {
    const now = new Date("2026-07-20T05:00:00Z");
    const pending = makeCase({
      firstRespondedAt: null,
      status: "open",
      closedAt: null,
      firstResponseDueAt: "2026-07-20T09:00:00Z", // due ในอนาคต
    });
    const responded = makeCase({ caseId: "c2" }); // ตอบเร็ว = met
    const { scores, detail } = computeDimensionScores({ cases: [pending, responded], now });
    expect(detail.sla.considered).toBe(1); // นับแค่เคสที่ตอบแล้ว
    expect(scores.sla).toBe(100);
  });

  it("★ M2: เคสยังไม่ตอบแต่เลย due แล้ว → นับเป็น breach", () => {
    const now = new Date("2026-07-20T12:00:00Z");
    const breached = makeCase({
      firstRespondedAt: null,
      status: "open",
      closedAt: null,
      firstResponseDueAt: "2026-07-20T09:00:00Z", // เลย due แล้ว
    });
    const { scores, detail } = computeDimensionScores({ cases: [breached], now });
    expect(detail.sla.considered).toBe(1);
    expect(scores.sla).toBe(0);
  });

  it("★ M2: เคสปิดโดยไม่มีการตอบครั้งแรก → ไม่คิดโทษ (ไม่นับ)", () => {
    const closedNoReply = makeCase({ firstRespondedAt: null, status: "closed" });
    const { detail } = computeDimensionScores({ cases: [closedNoReply] });
    expect(detail.sla.considered).toBe(0);
  });

  it("★ ไม่มีเคสให้วัดมิติ (ว่าง) → คะแนนมิตินั้น undefined", () => {
    const { scores } = computeDimensionScores({ cases: [] });
    expect(scores.sla).toBeUndefined();
    expect(scores.ownership).toBeUndefined();
  });
});

describe("มิติเชิงคุณภาพ — AI ก่อน, fallback sentiment", () => {
  it("ใช้คะแนน AI (qualitative) ถ้ามี", () => {
    const { scores } = computeDimensionScores({
      cases: [makeCase()],
      qualitative: { correctness: 90, completeness: 85, clarity: 88, politeness: 92 },
    });
    expect(scores.correctness).toBe(90);
    expect(scores.politeness).toBe(92);
  });

  it("ไม่มี AI → fallback จาก sentiment (negative = 55)", () => {
    const { scores } = computeDimensionScores({ cases: [makeCase()], sentiment: "negative" });
    expect(scores.correctness).toBe(55);
    expect(scores.clarity).toBe(55);
  });

  it("ไม่มีทั้ง AI และ sentiment → มิติคุณภาพว่าง", () => {
    const { scores } = computeDimensionScores({ cases: [makeCase()] });
    expect(scores.correctness).toBeUndefined();
  });
});

describe("computeEvaluationScore + classifyDimensions", () => {
  it("รวม overall ด้วยน้ำหนัก default (เคสดี + AI สูง → overall สูง)", () => {
    const { overall } = computeEvaluationScore(
      {
        cases: [makeCase()],
        qualitative: { correctness: 100, completeness: 100, clarity: 100, politeness: 100 },
      },
      DEFAULT_WEIGHTS
    );
    expect(overall).toBe(100);
  });

  it("classifyDimensions: >=80 strength, <60 improvement", () => {
    const { strengths, improvements } = classifyDimensions({
      correctness: 90,
      sla: 40,
      politeness: 70,
    });
    expect(strengths).toContain("correctness");
    expect(improvements).toContain("sla");
    expect(strengths).not.toContain("politeness");
    expect(improvements).not.toContain("politeness");
  });
});
