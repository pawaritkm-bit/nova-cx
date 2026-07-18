import { describe, it, expect } from "vitest";
import { isValidOverallScore, parseEditScore } from "@/lib/chat-dashboard/eval-score";

describe("parseEditScore — ★ H1 กันช่องว่างเซฟเป็น 0", () => {
  it("ช่องว่าง / เว้นวรรคล้วน → null (ไม่ใช่ 0)", () => {
    expect(parseEditScore("")).toBeNull();
    expect(parseEditScore("   ")).toBeNull();
  });
  it("ตัวเลขในช่วง 0–100 → ค่าตัวเลข", () => {
    expect(parseEditScore("0")).toBe(0);
    expect(parseEditScore("62")).toBe(62);
    expect(parseEditScore("100")).toBe(100);
  });
  it("นอกช่วง / ไม่ใช่ตัวเลข → null", () => {
    expect(parseEditScore("-1")).toBeNull();
    expect(parseEditScore("101")).toBeNull();
    expect(parseEditScore("abc")).toBeNull();
  });
});

describe("isValidOverallScore — guard ฝั่ง API route", () => {
  it("ยอมรับเฉพาะ number จริงในช่วง 0–100", () => {
    expect(isValidOverallScore(0)).toBe(true);
    expect(isValidOverallScore(88)).toBe(true);
    expect(isValidOverallScore(100)).toBe(true);
  });
  it("★ ปฏิเสธ string ว่าง / string เลข / null / NaN / นอกช่วง", () => {
    expect(isValidOverallScore("")).toBe(false);
    expect(isValidOverallScore("62")).toBe(false);
    expect(isValidOverallScore(null)).toBe(false);
    expect(isValidOverallScore(undefined)).toBe(false);
    expect(isValidOverallScore(NaN)).toBe(false);
    expect(isValidOverallScore(120)).toBe(false);
  });
});
