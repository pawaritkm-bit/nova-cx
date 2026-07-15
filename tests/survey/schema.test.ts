import { describe, it, expect } from "vitest";
import { flattenQuestions, buildQuestionMap } from "@/lib/survey/schema";

// ตัวอย่างโครง schema_json แบบ sections (Form A/C/D)
const schemaA = {
  type: "A",
  sections: [
    { code: "ref", title: "ข้อมูลอ้างอิง", auto_fill: true },
    {
      code: "ratings",
      questions: [
        { code: "acc_correct", text: "ความถูกต้อง", type: "rating", scale: 5 },
        { code: "acc_overall", text: "ภาพรวม", type: "rating", scale: 5 },
      ],
    },
    {
      code: "problems",
      questions: [
        {
          code: "problems",
          text: "ปัญหาที่พบ",
          type: "multi",
          options: [
            { value: "none", label: "ยังไม่พบปัญหา", is_exclusive: true },
            { value: "slow", label: "ตอบช้า" },
          ],
        },
      ],
    },
    { code: "loyalty", questions: [{ code: "nps", text: "แนะนำ", type: "nps" }] },
  ],
};

// โครง question_sets (Form B)
const schemaB = {
  type: "B",
  question_sets: {
    lead: [{ code: "lead_overall", text: "ภาพรวมหัวหน้า", type: "rating", scale: 5 }],
    member: [
      { code: "mem_correct", text: "ถูกต้อง", type: "rating", scale: 5 },
      { code: "mem_overall", text: "ภาพรวม", type: "rating", scale: 5 },
    ],
  },
  open_questions: [{ code: "open_feedback", text: "เพิ่มเติม", type: "open" }],
};

describe("survey/schema — flattenQuestions", () => {
  it("flatten จาก sections ได้ครบ + ข้าม section ที่ไม่มีคำถาม", () => {
    const qs = flattenQuestions(schemaA);
    const codes = qs.map((q) => q.code);
    expect(codes).toContain("acc_correct");
    expect(codes).toContain("problems");
    expect(codes).toContain("nps");
    // ref section ไม่มี questions → ไม่โผล่
    expect(codes).not.toContain("ref");
  });

  it("flatten จาก question_sets + open_questions (Form B) + ติด group", () => {
    const qs = flattenQuestions(schemaB);
    const codes = qs.map((q) => q.code);
    expect(codes).toEqual(
      expect.arrayContaining(["lead_overall", "mem_correct", "mem_overall", "open_feedback"])
    );
    const mem = qs.find((q) => q.code === "mem_correct");
    expect(mem?.group).toBe("member");
  });

  it("multi question เก็บ options + is_exclusive", () => {
    const qs = flattenQuestions(schemaA);
    const problems = qs.find((q) => q.code === "problems");
    expect(problems?.options?.find((o) => o.value === "none")?.is_exclusive).toBe(true);
  });

  it("schema ว่าง/ผิดรูป ไม่ throw", () => {
    expect(flattenQuestions(null)).toEqual([]);
    expect(flattenQuestions({})).toEqual([]);
    expect(flattenQuestions({ sections: [{}] })).toEqual([]);
  });

  it("buildQuestionMap lookup ด้วย code ได้", () => {
    const map = buildQuestionMap(flattenQuestions(schemaA));
    expect(map.get("acc_correct")?.type).toBe("rating");
  });
});
