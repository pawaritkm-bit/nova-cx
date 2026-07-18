import { describe, it, expect } from "vitest";
import { analyzeChat, type AnalyzeChatInput } from "@/lib/ai/chat-analyze";
import type { AIProvider, GenerateJsonArgs } from "@/lib/ai/provider";
import type { ChatOutput } from "@/lib/ai/chat-schema";
import type { ChatMessageContext } from "@/lib/ai/chat-prompt";

function goodOutput(overrides: Partial<ChatOutput> = {}): ChatOutput {
  return {
    summary: "ลูกค้าถามเรื่องภาษี ทีมตอบแล้ว",
    customer_facts: ["ลูกค้าถามการยื่นภาษีเดือนนี้"],
    ai_assumptions: [],
    evidence: [{ claim: "ลูกค้าถาม", quote: "ยื่นภาษีเดือนนี้ยัง", msg_idx: 0 }],
    flow_steps: [{ step: "receive", status: "done", note: "รับเรื่องแล้ว", msg_idx: 0 }],
    problems: [{ type: "slow_reply", detail: "ตอบช้า", msg_idx: 1 }],
    sop_violations: [
      {
        violation_type: "slow_reply",
        severity: "medium",
        description: "ตอบช้ากว่ามาตรฐาน",
        msg_idx: 1,
        needs_expert_review: false,
      },
    ],
    sentiment_points: [{ score: -0.1, label: "neutral", msg_idx: 0 }],
    sentiment: "neutral",
    urgency: "medium",
    confidence: 0.6,
    insufficient_data: false,
    ...overrides,
  };
}

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

function messages(...texts: string[]): ChatMessageContext[] {
  return texts.map((t, i) => ({
    idx: i,
    at: `2026-07-18T10:0${i}:00Z`,
    sender: i % 2 === 0 ? "customer" : "accountant",
    text: t,
  }));
}

const baseInput: AnalyzeChatInput = {
  messages: messages("ยื่นภาษีเดือนนี้ยัง โทร 0812345678", "กำลังตรวจให้ครับ"),
  knownNames: ["บริษัท ทดสอบ จำกัด"],
};

describe("chat-analyze — happy path + validate", () => {
  it("JSON ถูก schema → validated true", async () => {
    const p = new FakeProvider(() => JSON.stringify(goodOutput()));
    const out = await analyzeChat(p, baseInput);
    expect(out.result.validated).toBe(true);
    expect(out.parseFailed).toBe(false);
    expect(out.blocked).toBe(false);
  });

  it("redact ก่อนส่ง AI (C-15): prompt ไม่มีเบอร์ดิบ", async () => {
    const p = new FakeProvider(() => JSON.stringify(goodOutput()));
    await analyzeChat(p, baseInput);
    expect(p.lastArgs?.user).not.toContain("0812345678");
    expect(p.lastArgs?.user).toContain("[เบอร์โทร]");
  });
});

describe("chat-analyze — residual-PII gate (C-15) บล็อกเมื่อ PII หลุด", () => {
  it("เลขยาวหลุด redact → บล็อก ไม่เรียก AI + needs_human_review", async () => {
    const p = new FakeProvider(() => JSON.stringify(goodOutput()));
    const out = await analyzeChat(p, {
      messages: messages("รหัสลับ 987654321012345 ครับ", "รับทราบ"),
      knownNames: [],
    });
    // provider ต้องไม่ถูกเรียก (โดนบล็อกก่อน)
    expect(p.calls).toBe(0);
    expect(out.blocked).toBe(true);
    expect(out.result.needs_human_review).toBe(true);
    expect(out.result.validated).toBe(false);
    expect(out.violations).toContain("residual_pii_blocked (C-15)");
  });
});

describe("chat-analyze — insufficient_data (บทสนทนาสั้น)", () => {
  it("ข้อความ < ขั้นต่ำ → ไม่เรียก AI + insufficient_data true", async () => {
    const p = new FakeProvider(() => JSON.stringify(goodOutput()));
    const out = await analyzeChat(p, {
      messages: messages("สวัสดีครับ"),
      knownNames: [],
    });
    expect(p.calls).toBe(0);
    expect(out.result.insufficient_data).toBe(true);
    expect(out.result.validated).toBe(false);
  });
});

describe("chat-analyze — retry + fallback", () => {
  it("parse ไม่ผ่านครั้งแรก ครั้งสองผ่าน → validated true", async () => {
    const p = new FakeProvider((n) => (n === 1 ? "ไม่ใช่ json" : JSON.stringify(goodOutput())));
    const out = await analyzeChat(p, baseInput);
    expect(p.calls).toBe(2);
    expect(out.result.validated).toBe(true);
  });

  it("throw ทั้งสองครั้ง → fallback + needs_human_review + validated false", async () => {
    const p = new FakeProvider(() => "__throw__");
    const out = await analyzeChat(p, baseInput);
    expect(p.calls).toBe(2);
    expect(out.parseFailed).toBe(true);
    expect(out.result.validated).toBe(false);
    expect(out.result.needs_human_review).toBe(true);
  });
});

describe("chat-analyze — human-in-the-loop", () => {
  it("sop_violations.needs_expert_review → บังคับ needs_human_review", async () => {
    const p = new FakeProvider(() =>
      JSON.stringify(
        goodOutput({
          sop_violations: [
            {
              violation_type: "conflicting_info",
              severity: "high",
              description: "ตัวเลขภาษีขัดแย้ง",
              msg_idx: 1,
              needs_expert_review: true,
            },
          ],
        })
      )
    );
    const out = await analyzeChat(p, baseInput);
    expect(out.result.needs_human_review).toBe(true);
    expect(out.violations.some((v) => v.includes("expert_review_required"))).toBe(true);
  });

  it("urgency high → บังคับ needs_human_review", async () => {
    const p = new FakeProvider(() =>
      JSON.stringify(goodOutput({ urgency: "high", sentiment: "negative" }))
    );
    const out = await analyzeChat(p, baseInput);
    expect(out.result.needs_human_review).toBe(true);
  });
});
