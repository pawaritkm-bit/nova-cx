import { describe, it, expect } from "vitest";
import { extractKnowledge, type AnalyzeKnowledgeInput } from "@/lib/ai/knowledge-extract";
import type { AIProvider, GenerateJsonArgs } from "@/lib/ai/provider";
import type { KnowledgePair } from "@/lib/ai/knowledge-schema";

/**
 * knowledge-extract (Phase 1) — สกัดคู่ถาม-ตอบจากแชตกลุ่ม
 *   ครอบคลุม: happy path validate, redact ก่อนส่ง AI, residual-PII gate (block),
 *   ไม่มีคำถาม+คำตอบ → ไม่เรียก AI, fallback parse-fail (ไม่เดา)
 */

function pairs(...p: Partial<KnowledgePair>[]): { pairs: KnowledgePair[] } {
  return {
    pairs: p.map((x) => ({
      category: x.category ?? "เอกสาร",
      question_gist: x.question_gist ?? "ลูกค้าขอใบเสร็จเดือนนี้",
      answer_gist: x.answer_gist ?? "แจ้งว่าจะจัดส่งใบเสร็จภายในวันทำการถัดไป",
      answer_msg_idx: x.answer_msg_idx ?? 1,
      confidence: x.confidence ?? 0.8,
    })),
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

/** input: ลูกค้าถาม (idx0) → ทีมงานตอบ (idx1) */
function qaInput(customerText: string, staffText: string): AnalyzeKnowledgeInput {
  return {
    messages: [
      { idx: 0, at: "2026-07-18T10:00:00Z", role: "customer", text: customerText },
      { idx: 1, at: "2026-07-18T10:05:00Z", role: "staff", text: staffText },
    ],
    knownNames: ["บริษัท ทดสอบ จำกัด"],
  };
}

describe("knowledge-extract — happy path + validate", () => {
  it("JSON ถูก schema → คืน pairs, ไม่ถูก block", async () => {
    const p = new FakeProvider(() => JSON.stringify(pairs({})));
    const out = await extractKnowledge(p, qaInput("ขอใบเสร็จเดือนนี้ครับ", "ได้ครับ เดี๋ยวส่งให้"));
    expect(out.blocked).toBe(false);
    expect(out.parseFailed).toBe(false);
    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0].category).toBe("เอกสาร");
  });

  it("redact เบอร์โทรก่อนส่ง AI (ไม่มี PII ดิบใน prompt)", async () => {
    const p = new FakeProvider(() => JSON.stringify(pairs({})));
    await extractKnowledge(p, qaInput("โทรกลับ 0812345678 ด้วยครับ", "รับทราบครับ"));
    expect(p.lastArgs).not.toBeNull();
    expect(p.lastArgs!.user).not.toContain("0812345678");
    expect(p.lastArgs!.user).toContain("[เบอร์โทร]");
  });
});

describe("knowledge-extract — ไม่มีคู่ให้สกัด", () => {
  it("มีแต่ข้อความลูกค้า (ไม่มีคำตอบทีมงาน) → ไม่เรียก AI, pairs ว่าง", async () => {
    const p = new FakeProvider(() => JSON.stringify(pairs({})));
    const out = await extractKnowledge(p, {
      messages: [
        { idx: 0, at: "2026-07-18T10:00:00Z", role: "customer", text: "สวัสดีครับ" },
        { idx: 1, at: "2026-07-18T10:01:00Z", role: "customer", text: "ขอสอบถามหน่อย" },
      ],
    });
    expect(p.calls).toBe(0);
    expect(out.pairs).toHaveLength(0);
    expect(out.blocked).toBe(false);
  });
});

describe("knowledge-extract — fail-safe", () => {
  it("residual PII หลุด redact → block ไม่ส่ง AI + ไม่มี pairs", async () => {
    const p = new FakeProvider(() => JSON.stringify(pairs({})));
    const out = await extractKnowledge(p, {
      messages: [
        { idx: 0, at: "2026-07-18T10:00:00Z", role: "customer", text: "รหัสลับ 987654321012345 ครับ" },
        { idx: 1, at: "2026-07-18T10:05:00Z", role: "staff", text: "รับทราบครับ" },
      ],
    });
    expect(out.blocked).toBe(true);
    expect(p.calls).toBe(0); // ไม่เรียก AI ภายนอกเลย
    expect(out.pairs).toHaveLength(0);
  });

  it("parse ไม่ผ่านทั้ง 2 ครั้ง → parseFailed, ไม่มี pairs (ไม่เดา)", async () => {
    const p = new FakeProvider(() => "not-json");
    const out = await extractKnowledge(p, qaInput("ขอเอกสารครับ", "ส่งให้แล้วครับ"));
    expect(p.calls).toBe(2); // retry 1 ครั้ง
    expect(out.parseFailed).toBe(true);
    expect(out.pairs).toHaveLength(0);
  });
});
