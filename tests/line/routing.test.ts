import { describe, it, expect } from "vitest";
import { oaForSurveyType, channelForSurveyType } from "@/lib/line/routing";

describe("oaForSurveyType — OA ตามชนิดแบบประเมิน", () => {
  it("A/B → Care", () => {
    expect(oaForSurveyType("A")).toBe("care");
    expect(oaForSurveyType("B")).toBe("care");
  });
  it("C/D → Sale", () => {
    expect(oaForSurveyType("C")).toBe("sale");
    expect(oaForSurveyType("D")).toBe("sale");
  });
});

describe("channelForSurveyType — ช่องทางส่ง", () => {
  it("A (สำนักงาน) → กลุ่ม", () => {
    expect(channelForSurveyType("A")).toBe("group");
  });
  it("B (นักบัญชี) → ส่วนตัว", () => {
    expect(channelForSurveyType("B")).toBe("user");
  });
  it("C/D (เซล) → ส่วนตัว", () => {
    expect(channelForSurveyType("C")).toBe("user");
    expect(channelForSurveyType("D")).toBe("user");
  });
});
