import { describe, it, expect } from "vitest";
import { selectSlaRule, computeSlaDue, type SlaRule } from "@/lib/sla/rules";
import { addBusinessHours, computeSlaDueAt } from "@/lib/ai/case";

function rule(overrides: Partial<SlaRule> = {}): SlaRule {
  return {
    id: "r",
    customer_type: null,
    urgency: null,
    work_type: null,
    team_id: null,
    first_response_minutes: null,
    resolution_minutes: null,
    priority: 100,
    is_active: true,
    ...overrides,
  };
}

// จันทร์ 2026-07-20 10:00 เวลาไทย = 03:00 UTC (อยู่ในเวลาทำการ)
const NOW = new Date("2026-07-20T03:00:00Z");

describe("selectSlaRule — เลือก rule ตาม priority + specificity", () => {
  it("ไม่มี rule → null (ให้ fallback default)", () => {
    expect(selectSlaRule([], { urgency: "high" })).toBeNull();
  });

  it("scope null = wildcard match ทุกบริบท", () => {
    const r = rule({ id: "wild", first_response_minutes: 60 });
    expect(selectSlaRule([r], { urgency: "critical", teamId: "t1" })?.id).toBe("wild");
  });

  it("scope ที่ไม่ตรง → ไม่ match", () => {
    const r = rule({ id: "crit-only", urgency: "critical" });
    expect(selectSlaRule([r], { urgency: "high" })).toBeNull();
  });

  it("priority สูงกว่าถูกเลือกก่อน", () => {
    const low = rule({ id: "low", priority: 10, first_response_minutes: 240 });
    const high = rule({ id: "high", priority: 900, first_response_minutes: 60 });
    expect(selectSlaRule([low, high], { urgency: "high" })?.id).toBe("high");
  });

  it("priority เท่ากัน → rule เจาะจงกว่า (scope non-null มากกว่า) ถูกเลือก", () => {
    const generic = rule({ id: "generic", priority: 100 });
    const specific = rule({ id: "specific", priority: 100, urgency: "critical", team_id: "tA" });
    const picked = selectSlaRule([generic, specific], { urgency: "critical", teamId: "tA" });
    expect(picked?.id).toBe("specific");
  });

  it("is_active=false → ไม่ถูกเลือก", () => {
    const inactive = rule({ id: "off", is_active: false, first_response_minutes: 30 });
    expect(selectSlaRule([inactive], { urgency: "high" })).toBeNull();
  });
});

describe("computeSlaDue — คำนวณ due บนเวลาทำการ", () => {
  it("มี rule (minutes) → บวกชั่วโมงทำการจาก rule", () => {
    const r = rule({ first_response_minutes: 120, resolution_minutes: 300 });
    const due = computeSlaDue(r, "high", NOW);
    // 120 นาที = 2 ชม.ทำการ จาก 10:00 → 12:00 ไทย = 05:00 UTC
    expect(due.firstResponseDueAt.toISOString()).toBe(addBusinessHours(NOW, 2).toISOString());
    expect(due.resolutionDueAt.toISOString()).toBe(addBusinessHours(NOW, 5).toISOString());
  });

  it("ไม่มี rule → fallback default (critical=4 ชม.ทำการ)", () => {
    const due = computeSlaDue(null, "critical", NOW);
    expect(due.firstResponseDueAt.toISOString()).toBe(computeSlaDueAt("critical", NOW).toISOString());
    expect(due.resolutionDueAt.toISOString()).toBe(addBusinessHours(NOW, 8).toISOString());
  });

  it("ไม่มี rule → fallback default (high=สิ้นวันทำการ)", () => {
    const due = computeSlaDue(null, "high", NOW);
    expect(due.firstResponseDueAt.toISOString()).toBe(computeSlaDueAt("high", NOW).toISOString());
  });
});
