import { describe, it, expect } from "vitest";
import { applyGuardrails, countRiskKeywords } from "@/lib/ai/guardrail";
import type { AiOutput } from "@/lib/ai/schema";

function baseOutput(overrides: Partial<AiOutput> = {}): AiOutput {
  return {
    summary: "ลูกค้าพอใจโดยรวม",
    customer_facts: [],
    ai_assumptions: [],
    evidence: [],
    categories: [],
    sentiment: "neutral",
    urgency: "medium",
    urgency_reason: "ทั่วไป",
    affected: { employee: null, team: null, service: null, period: null },
    repeat_issue: false,
    next_best_action: "ติดตามปกติ",
    draft_reply: "ขอบคุณสำหรับความคิดเห็นค่ะ",
    confidence: 0.8,
    ...overrides,
  };
}

describe("guardrail — C-01/C-02 บล็อกคำรับปากเงิน/รับรอง", () => {
  it("draft_reply รับปากคืนเงิน → ตัดทิ้ง + needs_human_review", () => {
    const r = applyGuardrails(
      baseOutput({ draft_reply: "ทางเราจะคืนเงินให้ทั้งหมดค่ะ" })
    );
    expect(r.output.draft_reply).toBe("");
    expect(r.needsHumanReview).toBe(true);
    expect(r.violations.join(" ")).toMatch(/คืนเงิน/);
  });

  it("draft_reply ชดเชย → บล็อก", () => {
    const r = applyGuardrails(
      baseOutput({ draft_reply: "เราจะชดเชยค่าเสียหายให้นะคะ" })
    );
    expect(r.output.draft_reply).toBe("");
    expect(r.needsHumanReview).toBe(true);
  });

  it('draft_reply "รับรองว่าจะไม่เกิดขึ้นอีก" → บล็อก (C-02)', () => {
    const r = applyGuardrails(
      baseOutput({ draft_reply: "เรารับรองว่าจะไม่เกิดขึ้นอีกแน่นอนค่ะ" })
    );
    expect(r.output.draft_reply).toBe("");
    expect(r.needsHumanReview).toBe(true);
  });

  it("draft_reply ลดราคา/ส่วนลด → บล็อก", () => {
    const r = applyGuardrails(
      baseOutput({ draft_reply: "ครั้งหน้าลดราคาให้ 20% ค่ะ" })
    );
    expect(r.output.draft_reply).toBe("");
  });

  it("draft_reply สุภาพปกติ (ขอบคุณ+รับเรื่อง) → ผ่าน", () => {
    const r = applyGuardrails(
      baseOutput({
        draft_reply: "ขอบคุณค่ะ น้อง NOVA รับเรื่องแล้ว จะส่งต่อทีมตรวจสอบให้ค่ะ",
      })
    );
    expect(r.output.draft_reply).not.toBe("");
    expect(r.needsHumanReview).toBe(false);
  });
});

describe("guardrail — C-03 บังคับ evidence เมื่อชี้ผิดพนักงาน", () => {
  it("assumption ชี้พนักงานผิด แต่ไม่มี evidence → needs_human_review", () => {
    const r = applyGuardrails(
      baseOutput({
        ai_assumptions: ["นักบัญชีน่าจะทำงานผิดพลาดและละเลยหน้าที่"],
        evidence: [],
      })
    );
    expect(r.needsHumanReview).toBe(true);
    expect(r.violations.join(" ")).toMatch(/evidence/);
  });

  it("ชี้พนักงานผิด + มี evidence → ผ่าน (ไม่ flag จากข้อนี้)", () => {
    const r = applyGuardrails(
      baseOutput({
        ai_assumptions: ["นักบัญชีอาจทำงานผิดพลาด"],
        evidence: [{ claim: "งานผิด", quote: "ยื่นภาษีผิดเดือน" }],
        urgency: "medium",
      })
    );
    // ไม่ควร flag เพราะเหตุ C-03 (แต่ยังต้องไม่ถูกยกเป็น high โดยไม่มีเหตุ)
    expect(r.violations.join(" ")).not.toMatch(/C-03/);
  });
});

describe("guardrail — C-04 keyword + บริบท (ไม่ตัดสินจาก keyword เดี่ยว)", () => {
  it("keyword เสี่ยง + บริบทลบ → ยกระดับเป็น high", () => {
    const r = applyGuardrails(
      baseOutput({
        summary: "ลูกค้าแจ้งว่าโดนค่าปรับจากสรรพากรเพราะยื่นภาษีล่าช้า",
        sentiment: "negative",
        customer_facts: ["โดนค่าปรับสรรพากร"],
        urgency: "medium",
      })
    );
    expect(r.output.urgency).toBe("high");
    expect(r.violations.join(" ")).toMatch(/ยกระดับ/);
  });

  it("keyword ปรากฏแต่บริบทเป็นบวก/กลาง (ไม่มี fact/negative) → ไม่ยกระดับ", () => {
    const r = applyGuardrails(
      baseOutput({
        summary: "ลูกค้าถามเฉยๆ ว่าถ้ายกเลิกบริการต้องทำอย่างไร ไม่ได้มีปัญหา",
        sentiment: "neutral",
        customer_facts: [],
        evidence: [],
        urgency: "positive",
      })
    );
    // มี keyword 'ยกเลิก' แต่ไม่มีบริบทลบ → คงเดิม positive (เคารพ C-04)
    expect(r.output.urgency).toBe("positive");
  });

  it("countRiskKeywords ตรวจพบ keyword", () => {
    const { hits } = countRiskKeywords(
      baseOutput({ summary: "จะฟ้องร้องและขอคืนเงิน" })
    );
    expect(hits).toContain("ฟ้อง");
    expect(hits).toContain("คืนเงิน");
  });
});
