import { describe, it, expect } from "vitest";
import { computeRiskLevel, maxRiskLevel, riskRank } from "@/lib/sla/risk";

describe("computeRiskLevel — map SLA/sentiment → ระดับความเสี่ยง", () => {
  it("resolution breach หรือ escalated → red", () => {
    expect(computeRiskLevel({ level: "high", resolutionBreached: true })).toBe("red");
    expect(computeRiskLevel({ level: "high", escalated: true })).toBe("red");
  });
  it("response breach → orange", () => {
    expect(computeRiskLevel({ level: "high", responseBreached: true })).toBe("orange");
  });
  it("critical + ลบ → orange (เสี่ยงร้องเรียนแม้ยังไม่ถึงกำหนด)", () => {
    expect(computeRiskLevel({ level: "critical", sentiment: "negative" })).toBe("orange");
  });
  it("ใกล้ครบกำหนด → yellow", () => {
    expect(computeRiskLevel({ level: "high", responseDueSoon: true })).toBe("yellow");
    expect(computeRiskLevel({ level: "high", resolutionDueSoon: true })).toBe("yellow");
  });
  it("ปกติ → green", () => {
    expect(computeRiskLevel({ level: "high", sentiment: "neutral" })).toBe("green");
  });
});

describe("maxRiskLevel / riskRank — ยกระดับไม่ให้ลดเอง", () => {
  it("คืนระดับที่รุนแรงกว่า", () => {
    expect(maxRiskLevel("yellow", "red")).toBe("red");
    expect(maxRiskLevel("orange", "yellow")).toBe("orange");
  });
  it("rank เรียงจากน้อยไปมาก", () => {
    expect(riskRank("green")).toBeLessThan(riskRank("yellow"));
    expect(riskRank("orange")).toBeLessThan(riskRank("red"));
  });
});
