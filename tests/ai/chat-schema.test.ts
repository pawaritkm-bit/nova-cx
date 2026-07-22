import { describe, it, expect } from "vitest";
import {
  chatOutputSchema,
  parseChatOutput,
  PROBLEM_CATEGORIES,
  PROBLEM_LABELS,
  CHAT_AI_JSON_SCHEMA,
  type ChatOutput,
} from "@/lib/ai/chat-schema";

/** ผลลัพธ์ AI ที่ถูกต้องขั้นต่ำ ใช้เป็นฐานแล้ว override ทีละเคส */
function base(overrides: Partial<ChatOutput> = {}): ChatOutput {
  return {
    summary: "สรุปสั้น",
    customer_facts: [],
    ai_assumptions: [],
    evidence: [],
    flow_steps: [],
    problems: [{ type: "sla_risk", detail: "ลูกค้าถาม VAT ยังไม่มีผู้ตอบ ~3 ชม.", msg_idx: 1 }],
    sop_violations: [],
    sentiment_points: [],
    sentiment: "neutral",
    urgency: "medium",
    confidence: 0.5,
    insufficient_data: false,
    ...overrides,
  };
}

describe("chat-schema — problems[].type ใช้หมวดคงที่ 6 ค่า", () => {
  it("ผ่านทุกหมวดในชุด PROBLEM_CATEGORIES", () => {
    for (const type of PROBLEM_CATEGORIES) {
      const out = base({ problems: [{ type, detail: "รายละเอียดเจาะจง", msg_idx: null }] });
      expect(chatOutputSchema.safeParse(out).success).toBe(true);
    }
  });

  it("ปฏิเสธค่านอกชุด (ค่าเดิมที่เลิกใช้กับ problems)", () => {
    for (const bad of ["missed_request", "no_owner", "jargon", "terse_reply", "unknown_type"]) {
      const out = { ...base(), problems: [{ type: bad, detail: "x", msg_idx: null }] };
      expect(chatOutputSchema.safeParse(out).success).toBe(false);
    }
  });

  it("parseChatOutput คืนผลเมื่อ type อยู่ในชุด", () => {
    const raw = JSON.stringify(base({ problems: [{ type: "no_response", detail: "ถามแล้วเงียบ", msg_idx: 0 }] }));
    const parsed = parseChatOutput(raw);
    expect(parsed.problems[0].type).toBe("no_response");
  });
});

describe("chat-schema — PROBLEM_LABELS สำหรับ UI", () => {
  it("มี label ครบทุกหมวดและ level เป็น red|amber", () => {
    for (const type of PROBLEM_CATEGORIES) {
      const meta = PROBLEM_LABELS[type];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(["red", "amber"]).toContain(meta.level);
    }
  });

  it("map ระดับสีตามที่กำหนด", () => {
    expect(PROBLEM_LABELS.sla_risk.level).toBe("red");
    expect(PROBLEM_LABELS.complaint.level).toBe("red");
    expect(PROBLEM_LABELS.no_response.level).toBe("red");
    expect(PROBLEM_LABELS.dropped_work.level).toBe("amber");
    expect(PROBLEM_LABELS.slow_reply.level).toBe("amber");
    expect(PROBLEM_LABELS.other.level).toBe("amber");
  });
});

describe("chat-schema — JSON schema (OpenAI structured output) ตรงกับ enum", () => {
  it("problems.items.type.enum = PROBLEM_CATEGORIES", () => {
    const problems = CHAT_AI_JSON_SCHEMA.schema.properties.problems as {
      items: { properties: { type: { enum: readonly string[] } } };
    };
    expect(problems.items.properties.type.enum).toEqual([...PROBLEM_CATEGORIES]);
  });
});
