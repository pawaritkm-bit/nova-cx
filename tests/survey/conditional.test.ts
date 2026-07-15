import { describe, it, expect } from "vitest";
import {
  ratingFollowup,
  shouldOfferCallback,
  exclusiveValues,
  validateExclusiveSelection,
  computeRatingFollowups,
} from "@/lib/survey/conditional";
import type { NormalizedQuestion } from "@/lib/survey/types";

describe("survey/conditional — ratingFollowup", () => {
  it("4–5 = PRAISE", () => {
    expect(ratingFollowup(5)).toBe("PRAISE");
    expect(ratingFollowup(4)).toBe("PRAISE");
  });
  it("3 = IMPROVE", () => {
    expect(ratingFollowup(3)).toBe("IMPROVE");
  });
  it("1–2 = ROOT_CAUSE + เสนอติดต่อกลับ", () => {
    expect(ratingFollowup(2)).toBe("ROOT_CAUSE");
    expect(ratingFollowup(1)).toBe("ROOT_CAUSE");
    expect(shouldOfferCallback(1)).toBe(true);
    expect(shouldOfferCallback(4)).toBe(false);
  });
  it("ค่าไม่ใช่ตัวเลข = null", () => {
    expect(ratingFollowup(NaN)).toBeNull();
  });
});

describe("survey/conditional — exclusive (ยังไม่พบปัญหา เลือกเดี่ยว)", () => {
  const q: NormalizedQuestion = {
    code: "problems",
    text: "ปัญหาที่พบ",
    type: "multi",
    options: [
      { value: "none", label: "ยังไม่พบปัญหา", is_exclusive: true },
      { value: "slow", label: "ตอบช้า" },
      { value: "wrong_work", label: "งานผิด" },
    ],
  };

  it("ดึงค่า exclusive ได้", () => {
    expect(exclusiveValues(q)).toEqual(["none"]);
  });
  it("เลือก exclusive เดี่ยว = ผ่าน", () => {
    expect(validateExclusiveSelection(["none"], ["none"])).toBe(true);
  });
  it("เลือก exclusive + อื่น = ไม่ผ่าน", () => {
    expect(validateExclusiveSelection(["none", "slow"], ["none"])).toBe(false);
  });
  it("เลือกหลายอันที่ไม่ใช่ exclusive = ผ่าน", () => {
    expect(validateExclusiveSelection(["slow", "wrong_work"], ["none"])).toBe(true);
  });
  it("ไม่เลือกอะไร = ผ่าน", () => {
    expect(validateExclusiveSelection([], ["none"])).toBe(true);
  });
});

describe("survey/conditional — computeRatingFollowups", () => {
  const questions: NormalizedQuestion[] = [
    { code: "a", text: "", type: "rating", scale: 5 },
    { code: "b", text: "", type: "rating", scale: 5 },
    { code: "note", text: "", type: "open" },
  ];
  it("map เฉพาะ rating ที่มี follow-up", () => {
    const fu = computeRatingFollowups(questions, { a: 5, b: 2, note: "x" });
    expect(fu).toEqual({ a: "PRAISE", b: "ROOT_CAUSE" });
  });
});
