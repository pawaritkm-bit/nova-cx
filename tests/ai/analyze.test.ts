import { describe, it, expect } from "vitest";
import { analyzeFeedback, type AnalyzeInput } from "@/lib/ai/analyze";
import type { AIProvider, GenerateJsonArgs } from "@/lib/ai/provider";
import type { AiOutput } from "@/lib/ai/schema";

function goodOutput(overrides: Partial<AiOutput> = {}): AiOutput {
  return {
    summary: "ลูกค้าพอใจ",
    customer_facts: ["บริการดี"],
    ai_assumptions: [],
    evidence: [{ claim: "ดี", quote: "ชอบมาก" }],
    categories: ["บริการ"],
    sentiment: "positive",
    urgency: "positive",
    urgency_reason: "คะแนนสูง",
    affected: { employee: null, team: null, service: null, period: null },
    repeat_issue: false,
    next_best_action: "ขอ testimonial",
    draft_reply: "ขอบคุณค่ะ",
    confidence: 0.9,
    ...overrides,
  };
}

/** provider ปลอมที่ควบคุมพฤติกรรมได้ + บันทึก prompt ที่ถูกส่ง */
class FakeProvider implements AIProvider {
  readonly name = "fake";
  readonly model = "fake-1";
  calls = 0;
  lastArgs: GenerateJsonArgs | null = null;
  constructor(private readonly responder: (call: number) => string) {}
  async generateJson(args: GenerateJsonArgs): Promise<string> {
    this.calls += 1;
    this.lastArgs = args;
    const r = this.responder(this.calls);
    if (r === "__throw__") throw new Error("api_down");
    return r;
  }
}

const baseInput: AnalyzeInput = {
  survey_type: "A",
  overall_score: 5,
  answers: { note: "ดีมาก โทร 0812345678 ได้", r1: 5 },
  knownNames: ["บริษัท ทดสอบ จำกัด"],
};

describe("analyze — happy path", () => {
  it("valid JSON → validated true", async () => {
    const p = new FakeProvider(() => JSON.stringify(goodOutput()));
    const out = await analyzeFeedback(p, baseInput);
    expect(out.result.validated).toBe(true);
    expect(out.parseFailed).toBe(false);
    expect(out.result.needs_human_review).toBe(false);
    expect(out.provider).toBe("fake");
  });
});

describe("analyze — redact ก่อนส่ง AI (C-15)", () => {
  it("prompt ที่ส่งเข้า provider ต้องไม่มี PII ดิบ", async () => {
    const p = new FakeProvider(() => JSON.stringify(goodOutput()));
    await analyzeFeedback(p, baseInput);
    expect(p.lastArgs?.user).not.toContain("0812345678");
    expect(p.lastArgs?.user).toContain("[เบอร์โทร]");
  });
});

describe("analyze — retry + fallback", () => {
  it("parse ไม่ผ่านครั้งแรก แต่ครั้งสองผ่าน → validated true (retry ทำงาน)", async () => {
    const p = new FakeProvider((n) =>
      n === 1 ? "ไม่ใช่ json" : JSON.stringify(goodOutput())
    );
    const out = await analyzeFeedback(p, baseInput);
    expect(p.calls).toBe(2);
    expect(out.result.validated).toBe(true);
  });

  it("throw ทั้งสองครั้ง → fallback + needs_human_review + validated false", async () => {
    const p = new FakeProvider(() => "__throw__");
    const out = await analyzeFeedback(p, baseInput);
    expect(p.calls).toBe(2);
    expect(out.parseFailed).toBe(true);
    expect(out.result.validated).toBe(false);
    expect(out.result.needs_human_review).toBe(true);
  });

  it("JSON ผิด schema ทั้งสองครั้ง → fallback", async () => {
    const p = new FakeProvider(() => JSON.stringify({ summary: "x" }));
    const out = await analyzeFeedback(p, baseInput);
    expect(out.parseFailed).toBe(true);
    expect(out.result.validated).toBe(false);
  });
});

describe("analyze — guardrail + human-in-the-loop", () => {
  it("draft_reply ผิด guardrail → ถูกตัด + needs_human_review", async () => {
    const p = new FakeProvider(() =>
      JSON.stringify(goodOutput({ draft_reply: "จะคืนเงินให้ค่ะ" }))
    );
    const out = await analyzeFeedback(p, baseInput);
    expect(out.result.draft_reply).toBe("");
    expect(out.result.needs_human_review).toBe(true);
  });

  it("urgency high → needs_human_review บังคับ true (FR-AI-04)", async () => {
    const p = new FakeProvider(() =>
      JSON.stringify(
        goodOutput({
          urgency: "high",
          sentiment: "negative",
          draft_reply: "ขอบคุณค่ะ จะส่งต่อทีมตรวจสอบ",
        })
      )
    );
    const out = await analyzeFeedback(p, baseInput);
    expect(out.result.urgency).toBe("high");
    expect(out.result.needs_human_review).toBe(true);
  });
});
