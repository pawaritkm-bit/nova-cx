import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { normalizeClassification, classifyBillImage } from "@/lib/ai/bill-classify";

/**
 * bill-classify — คัดกรองรูปเอกสารการเงินด้วย AI vision
 *   เน้นกฎความปลอดภัย "keep-if-unsure" (กันลบบิลจริง):
 *     - เอกสารการเงิน (slip/handwritten/cash/purchase/sale) → keep เสมอ
 *     - other + มั่นใจสูง → keep=false (ทิ้งได้)
 *     - other + มั่นใจต่ำ (< 0.7) → keep=true (เก็บไว้ก่อน)
 *     - parse ไม่ได้ / kind แปลก → keep=true
 *     - ไม่มี key / error / timeout → classifyBillImage คืน null (caller ถือว่า keep)
 */

describe("normalizeClassification — keep-if-unsure", () => {
  it("เอกสารการเงินที่รู้จัก → keep=true เสมอ (แม้ confidence ต่ำ)", () => {
    for (const kind of ["slip", "handwritten", "cash", "purchase", "sale"]) {
      const r = normalizeClassification({ kind, keep: false, confidence: 0.3 });
      expect(r.keep).toBe(true);
      expect(r.kind).toBe(kind);
    }
  });

  it("other + keep=false + confidence สูง (>=0.7) → ทิ้งได้ (keep=false)", () => {
    const r = normalizeClassification({ kind: "other", keep: false, confidence: 0.9 });
    expect(r.keep).toBe(false);
    expect(r.kind).toBe("other");
  });

  it("other + confidence ต่ำ (<0.7) → keep=true (ไม่มั่นใจ เก็บไว้ก่อน)", () => {
    const r = normalizeClassification({ kind: "other", keep: false, confidence: 0.5 });
    expect(r.keep).toBe(true);
  });

  it("other แต่โมเดลบอก keep=true → keep=true", () => {
    const r = normalizeClassification({ kind: "other", keep: true, confidence: 0.95 });
    expect(r.keep).toBe(true);
  });

  it("kind แปลก/ไม่รู้จัก → ถือเป็น other และ keep=true (ไม่ทิ้งพร่ำเพรื่อ)", () => {
    const r = normalizeClassification({ kind: "banana", keep: false, confidence: 0.99 });
    expect(r.kind).toBe("other");
    expect(r.keep).toBe(true);
  });

  it("parse ไม่ได้ (null) → keep=true", () => {
    const r = normalizeClassification(null);
    expect(r.keep).toBe(true);
    expect(r.kind).toBe("other");
  });

  it("confidence ไม่ใช่ตัวเลข → treat เป็น 0 → keep=true", () => {
    const r = normalizeClassification({ kind: "other", keep: false });
    expect(r.keep).toBe(true);
    expect(r.confidence).toBe(0);
  });

  it("confidence เกินช่วง → clamp 0..1", () => {
    expect(normalizeClassification({ kind: "slip", confidence: 5 }).confidence).toBe(1);
    expect(normalizeClassification({ kind: "slip", confidence: -2 }).confidence).toBe(0);
  });
});

describe("classifyBillImage — degrade & error → null (caller keep)", () => {
  const origKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (origKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origKey;
    vi.restoreAllMocks();
  });

  it("ไม่มี OPENAI_API_KEY → คืน null (ข้ามการคัด)", async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await classifyBillImage(Buffer.from("IMG"), "image/jpeg");
    expect(res).toBeNull();
  });

  it("fetch โยน error (network/timeout) → คืน null", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const res = await classifyBillImage(Buffer.from("IMG"), "image/jpeg");
    expect(res).toBeNull();
  });

  it("HTTP ไม่ ok → คืน null", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const res = await classifyBillImage(Buffer.from("IMG"), "image/jpeg");
    expect(res).toBeNull();
  });

  it("ตอบ JSON other+มั่นใจสูง → keep=false", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"kind":"other","keep":false,"confidence":0.92}' } }],
        }),
      })
    );
    const res = await classifyBillImage(Buffer.from("IMG"), "image/jpeg");
    expect(res).not.toBeNull();
    expect(res?.keep).toBe(false);
    expect(res?.kind).toBe("other");
  });

  it("ตอบ JSON other แต่มั่นใจต่ำ → keep=true (keep-if-unsure)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"kind":"other","keep":false,"confidence":0.4}' } }],
        }),
      })
    );
    const res = await classifyBillImage(Buffer.from("IMG"), "image/jpeg");
    expect(res?.keep).toBe(true);
  });
});
