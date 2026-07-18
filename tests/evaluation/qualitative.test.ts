import { describe, it, expect } from "vitest";
import {
  deriveQualitativeFromProblems,
  scoreQualitativeWithAI,
  type ProblemContext,
} from "@/lib/evaluation/qualitative";
import type { AIProvider } from "@/lib/ai/provider";

describe("deriveQualitativeFromProblems — fallback จากประเภทปัญหา (ไม่ใช่จำนวนข้อความ)", () => {
  it("ไม่มีปัญหาเลย → ว่าง (ให้ scoring fallback sentiment ต่อ)", () => {
    expect(deriveQualitativeFromProblems([])).toEqual({});
  });

  it("jargon → clarity ลด ; terse_reply → politeness/clarity ลด", () => {
    const ctx: ProblemContext[] = [
      { caseId: "c1", problemTypes: ["jargon"] },
      { caseId: "c2", problemTypes: ["terse_reply"] },
    ];
    const q = deriveQualitativeFromProblems(ctx);
    expect(q.clarity).toBe(80 - 15 - 10); // jargon 15 + terse 10
    expect(q.politeness).toBe(80 - 15); // terse 15
    expect(q.correctness).toBe(80); // ไม่กระทบ
  });

  it("missed_request → completeness ลด ; off_topic → correctness ลด", () => {
    const q = deriveQualitativeFromProblems([
      { caseId: "c1", problemTypes: ["missed_request", "off_topic_reply"] },
    ]);
    expect(q.completeness).toBe(80 - 20 - 10);
    expect(q.correctness).toBe(80 - 15);
  });

  it("มีเคสแต่ไม่มีปัญหาที่กระทบ → baseline 80 ทุกมิติ", () => {
    const q = deriveQualitativeFromProblems([{ caseId: "c1", problemTypes: ["no_owner"] }]);
    expect(q.correctness).toBe(80);
    expect(q.clarity).toBe(80);
  });
});

describe("scoreQualitativeWithAI — เรียก provider + parse", () => {
  const ctx = { summaries: ["สรุป"], problemTypes: ["jargon"], evidenceQuotes: ["[ข้อความ]"] };

  it("provider คืน JSON ถูก → คะแนน 4 มิติ + confidence", async () => {
    const provider: AIProvider = {
      name: "fake",
      model: "m",
      generateJson: async () =>
        JSON.stringify({
          correctness: 88,
          completeness: 80,
          clarity: 70,
          politeness: 92,
          confidence: 0.6,
        }),
    };
    const res = await scoreQualitativeWithAI(provider, ctx);
    expect(res?.scores.correctness).toBe(88);
    expect(res?.confidence).toBe(0.6);
  });

  it("provider ล้ม/JSON ผิด → null (worker จะ fallback)", async () => {
    const bad: AIProvider = { name: "f", model: "m", generateJson: async () => "not json" };
    expect(await scoreQualitativeWithAI(bad, ctx)).toBeNull();
    const thrown: AIProvider = {
      name: "f",
      model: "m",
      generateJson: async () => {
        throw new Error("api down");
      },
    };
    expect(await scoreQualitativeWithAI(thrown, ctx)).toBeNull();
  });
});
