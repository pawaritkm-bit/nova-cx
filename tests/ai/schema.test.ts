import { describe, it, expect } from "vitest";
import { aiOutputSchema, parseAiOutput, AI_JSON_SCHEMA } from "@/lib/ai/schema";

const valid = {
  summary: "สรุป",
  customer_facts: ["ข้อเท็จจริง"],
  ai_assumptions: [],
  evidence: [{ claim: "c", quote: "q" }],
  categories: ["บริการ"],
  sentiment: "negative",
  urgency: "high",
  urgency_reason: "เพราะ...",
  affected: { employee: null, team: "ทีม A", service: null, period: null },
  repeat_issue: false,
  next_best_action: "ทำ X",
  draft_reply: "ขอบคุณค่ะ",
  confidence: 0.7,
};

describe("ai/schema — aiOutputSchema (Zod)", () => {
  it("ผ่านเมื่อ output ครบถูกต้อง", () => {
    expect(aiOutputSchema.safeParse(valid).success).toBe(true);
  });

  it("ไม่ผ่านเมื่อ urgency ไม่อยู่ใน enum", () => {
    const r = aiOutputSchema.safeParse({ ...valid, urgency: "urgent" });
    expect(r.success).toBe(false);
  });

  it("ไม่ผ่านเมื่อ sentiment ผิด", () => {
    const r = aiOutputSchema.safeParse({ ...valid, sentiment: "bad" });
    expect(r.success).toBe(false);
  });

  it("ไม่ผ่านเมื่อ confidence เกิน 1", () => {
    const r = aiOutputSchema.safeParse({ ...valid, confidence: 1.5 });
    expect(r.success).toBe(false);
  });

  it("ไม่ผ่านเมื่อ evidence item ขาด quote", () => {
    const r = aiOutputSchema.safeParse({
      ...valid,
      evidence: [{ claim: "c" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("ai/schema — parseAiOutput", () => {
  it("parse JSON string ถูกต้อง", () => {
    const out = parseAiOutput(JSON.stringify(valid));
    expect(out.urgency).toBe("high");
  });
  it("throw เมื่อไม่ใช่ JSON", () => {
    expect(() => parseAiOutput("ไม่ใช่ json")).toThrow(/ai_output_not_json/);
  });
  it("throw เมื่อ JSON แต่ schema ไม่ผ่าน", () => {
    expect(() => parseAiOutput(JSON.stringify({ summary: "x" }))).toThrow();
  });
});

describe("ai/schema — AI_JSON_SCHEMA (สำหรับ OpenAI strict)", () => {
  it("strict = true + additionalProperties false", () => {
    expect(AI_JSON_SCHEMA.strict).toBe(true);
    expect(AI_JSON_SCHEMA.schema.additionalProperties).toBe(false);
  });
  it("required ครอบทุก field หลัก", () => {
    expect(AI_JSON_SCHEMA.schema.required).toContain("summary");
    expect(AI_JSON_SCHEMA.schema.required).toContain("urgency");
    expect(AI_JSON_SCHEMA.schema.required).toContain("draft_reply");
  });
});
