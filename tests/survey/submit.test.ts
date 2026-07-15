import { describe, it, expect } from "vitest";
import {
  submitPayloadSchema,
  validateAnswers,
  toAnswerRows,
  requiredQuestionCodes,
  isAnswered,
} from "@/lib/survey/submit";
import type { NormalizedQuestion } from "@/lib/survey/types";

const questions: NormalizedQuestion[] = [
  { code: "r1", text: "", type: "rating", scale: 5 },
  { code: "nps", text: "", type: "nps" },
  {
    code: "problems",
    text: "",
    type: "multi",
    options: [
      { value: "none", label: "ยังไม่พบปัญหา", is_exclusive: true },
      { value: "slow", label: "ช้า" },
    ],
  },
  {
    code: "continue",
    text: "",
    type: "single",
    options: [
      { value: "yes", label: "ต่อ" },
      { value: "no", label: "เลิก" },
    ],
  },
  { code: "note", text: "", type: "open" },
];

describe("survey/submit — submitPayloadSchema (Zod)", () => {
  it("ผ่านเมื่อ payload ถูกต้อง", () => {
    const r = submitPayloadSchema.safeParse({
      token: "abcdefghijklmnop",
      answers: { r1: 5, note: "ดีมาก" },
    });
    expect(r.success).toBe(true);
  });
  it("ไม่ผ่านเมื่อ token สั้นเกิน", () => {
    const r = submitPayloadSchema.safeParse({ token: "x", answers: {} });
    expect(r.success).toBe(false);
  });
  it("ไม่ผ่านเมื่อ answers ไม่ใช่ object", () => {
    const r = submitPayloadSchema.safeParse({ token: "abcdefghijkl", answers: 5 });
    expect(r.success).toBe(false);
  });
});

describe("survey/submit — validateAnswers (server-side)", () => {
  it("คำตอบถูกต้องทั้งหมด = ok", () => {
    const r = validateAnswers(questions, {
      r1: 4,
      nps: 9,
      problems: ["slow"],
      continue: "yes",
      note: "hello",
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("rating นอกช่วง 1..5 = error", () => {
    const r = validateAnswers(questions, { r1: 6 });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("r1");
  });

  it("nps นอกช่วง 0..10 = error", () => {
    const r = validateAnswers(questions, { nps: 11 });
    expect(r.ok).toBe(false);
  });

  it('exclusive "ยังไม่พบปัญหา" + อื่น = error (FR-SV-07)', () => {
    const r = validateAnswers(questions, { problems: ["none", "slow"] });
    expect(r.ok).toBe(false);
  });

  it("single ที่ค่าไม่อยู่ในตัวเลือก = error", () => {
    const r = validateAnswers(questions, { continue: "maybe" });
    expect(r.ok).toBe(false);
  });

  it("multi ค่าที่ไม่อยู่ในตัวเลือก = error", () => {
    const r = validateAnswers(questions, { problems: ["ghost"] });
    expect(r.ok).toBe(false);
  });

  it("code ที่ไม่อยู่ใน template (follow-up) = ปล่อยผ่าน", () => {
    const r = validateAnswers(questions, { r1__followup: "ข้อความเสริม" });
    expect(r.ok).toBe(true);
  });
});

describe("survey/submit — required (FR-SC-04c บังคับตอบ)", () => {
  it("requiredQuestionCodes = rating + nps เท่านั้น", () => {
    expect(requiredQuestionCodes(questions).sort()).toEqual(["nps", "r1"]);
  });

  it("isAnswered: ว่าง/สตริงว่าง/อาเรย์ว่าง = ไม่ตอบ", () => {
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered("")).toBe(false);
    expect(isAnswered("  ")).toBe(false);
    expect(isAnswered([])).toBe(false);
    expect(isAnswered(0)).toBe(true);
    expect(isAnswered("x")).toBe(true);
    expect(isAnswered(["a"])).toBe(true);
  });

  it("ขาดคำตอบบังคับ → error", () => {
    const r = validateAnswers(questions, { r1: 4 }, ["r1", "nps"]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "nps")).toBe(true);
  });

  it("ตอบบังคับครบ → ok", () => {
    const r = validateAnswers(questions, { r1: 4, nps: 9 }, ["r1", "nps"]);
    expect(r.ok).toBe(true);
  });
});

describe("survey/submit — toAnswerRows", () => {
  it("แปลง map → rows พร้อม null-safe", () => {
    const rows = toAnswerRows({ r1: 5, note: null });
    expect(rows).toEqual([
      { question_code: "r1", value_json: 5 },
      { question_code: "note", value_json: null },
    ]);
  });
});
