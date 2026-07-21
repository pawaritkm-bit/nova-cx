import { describe, it, expect } from "vitest";
import { analyzeOfficeInbound, type AnalyzeOfficeInput } from "@/lib/ai/office-analyze";
import type { AIProvider, GenerateJsonArgs } from "@/lib/ai/provider";
import type { OfficeOutput } from "@/lib/ai/office-schema";

/**
 * office-analyze (Phase A) — วิเคราะห์แชต 1-1 ฝั่งลูกค้า
 *   ครอบคลุม: happy path validate, redact ก่อนส่ง AI, residual-PII gate (block),
 *   guardrail (complaint/urgency/needs_attention → human review), fallback parse-fail
 */

function goodOutput(overrides: Partial<OfficeOutput> = {}): OfficeOutput {
  return {
    summary: "ลูกค้าถามเรื่องการยื่นภาษีเดือนนี้",
    sentiment: "neutral",
    urgency: "medium",
    topics: ["ยื่นภาษี"],
    is_complaint: false,
    needs_attention: false,
    confidence: 0.7,
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

function input(...texts: string[]): AnalyzeOfficeInput {
  return {
    messages: texts.map((t, i) => ({ idx: i, at: `2026-07-18T10:0${i}:00Z`, text: t })),
    knownNames: ["บริษัท ทดสอบ จำกัด"],
  };
}

describe("office-analyze — happy path + validate", () => {
  it("JSON ถูก schema → validated true, ไม่ถูก block", async () => {
    const p = new FakeProvider(() => JSON.stringify(goodOutput()));
    const out = await analyzeOfficeInbound(p, input("ยื่นภาษีเดือนนี้ยังครับ", "รอเอกสารอยู่"));
    expect(out.result.validated).toBe(true);
    expect(out.parseFailed).toBe(false);
    expect(out.blocked).toBe(false);
    expect(out.result.sentiment).toBe("neutral");
  });

  it("redact เบอร์โทรก่อนส่ง AI (ไม่มี PII ดิบใน prompt)", async () => {
    const p = new FakeProvider(() => JSON.stringify(goodOutput()));
    await analyzeOfficeInbound(p, input("โทรกลับที่ 0812345678 ด้วยครับ", "ขอบคุณครับ"));
    expect(p.lastArgs).not.toBeNull();
    expect(p.lastArgs!.user).not.toContain("0812345678");
    expect(p.lastArgs!.user).toContain("[เบอร์โทร]");
  });
});

describe("office-analyze — guardrail ฝั่งลูกค้า", () => {
  it("ลูกค้าโมโห/ร้องเรียน (is_complaint) → needs_human_review", async () => {
    const p = new FakeProvider(() =>
      JSON.stringify(goodOutput({ is_complaint: true, sentiment: "negative" }))
    );
    const out = await analyzeOfficeInbound(p, input("บริการแย่มาก ไม่ตอบเลย", "จะยกเลิกแล้วนะ"));
    expect(out.result.is_complaint).toBe(true);
    expect(out.result.needs_human_review).toBe(true);
    expect(out.violations).toContain("customer_complaint");
  });

  it("urgency critical → needs_human_review", async () => {
    const p = new FakeProvider(() =>
      JSON.stringify(goodOutput({ urgency: "critical", needs_attention: true }))
    );
    const out = await analyzeOfficeInbound(p, input("พรุ่งนี้เดดไลน์ยื่นภาษีแล้ว ด่วนมาก", "ช่วยด้วย"));
    expect(out.result.needs_human_review).toBe(true);
    expect(out.violations).toContain("urgency_high_or_critical");
  });
});

describe("office-analyze — fail-safe", () => {
  it("residual PII หลุด redact → block ไม่ส่ง AI + บังคับ human review + needs_attention", async () => {
    const p = new FakeProvider(() => JSON.stringify(goodOutput()));
    // อีเมล/รูปแบบ PII ที่ base redact อาจไม่จับ → ให้ยังเหลือเลขยาว 13 หลัก (residual)
    const out = await analyzeOfficeInbound(p, {
      messages: [{ idx: 0, at: "2026-07-18T10:00:00Z", text: "รหัสลับ 987654321012345 ครับ" }],
    });
    expect(out.blocked).toBe(true);
    expect(p.calls).toBe(0); // ไม่เรียก AI ภายนอกเลย
    expect(out.result.needs_human_review).toBe(true);
    expect(out.result.needs_attention).toBe(true);
  });

  it("parse ไม่ผ่านทั้ง 2 ครั้ง → fallback needs_human_review, validated=false", async () => {
    const p = new FakeProvider(() => "not-json");
    const out = await analyzeOfficeInbound(p, input("สวัสดีครับ", "สอบถามหน่อย"));
    expect(p.calls).toBe(2); // retry 1 ครั้ง
    expect(out.parseFailed).toBe(true);
    expect(out.result.validated).toBe(false);
    expect(out.result.needs_human_review).toBe(true);
  });
});
