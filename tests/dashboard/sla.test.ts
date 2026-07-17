import { describe, it, expect } from "vitest";
import {
  SLA_DUE_SOON_HOURS,
  computeSlaStatus,
  formatSlaLabel,
  compareUrgency,
  summarizeEscalation,
  type CaseLike,
} from "@/lib/dashboard/sla";

// เวลาอ้างอิงคงที่ (deterministic) — 2026-07-17T12:00:00Z
const NOW = Date.parse("2026-07-17T12:00:00Z");
const H = 3_600_000;

describe("computeSlaStatus", () => {
  it("ไม่มี sla_due_at → state none, hours null", () => {
    expect(computeSlaStatus(null, NOW)).toEqual({ state: "none", hours: null });
    expect(computeSlaStatus(undefined, NOW)).toEqual({
      state: "none",
      hours: null,
    });
  });

  it("parse ไม่ได้ → none", () => {
    expect(computeSlaStatus("ไม่ใช่วันที่", NOW)).toEqual({
      state: "none",
      hours: null,
    });
  });

  it("เกินกำหนดแล้ว → overdue พร้อมจำนวน ชม.ที่เกิน (ปัดขึ้น)", () => {
    const due = new Date(NOW - 3 * H).toISOString(); // เกินมา 3 ชม.
    expect(computeSlaStatus(due, NOW)).toEqual({ state: "overdue", hours: 3 });
    // เกินมา 30 นาที → ปัดขึ้นเป็น 1
    const due2 = new Date(NOW - 0.5 * H).toISOString();
    expect(computeSlaStatus(due2, NOW)).toEqual({ state: "overdue", hours: 1 });
  });

  it("ใกล้ครบ (เหลือ ≤ 2 ชม.) → due-soon", () => {
    const due = new Date(NOW + 1.5 * H).toISOString();
    expect(computeSlaStatus(due, NOW)).toEqual({ state: "due-soon", hours: 2 });
    // ขอบเขต: เหลือพอดี 2 ชม. ยังนับ due-soon
    const dueEdge = new Date(NOW + SLA_DUE_SOON_HOURS * H).toISOString();
    expect(computeSlaStatus(dueEdge, NOW).state).toBe("due-soon");
  });

  it("ยังไม่ใกล้ครบ → ok พร้อมจำนวน ชม.ที่เหลือ", () => {
    const due = new Date(NOW + 10 * H).toISOString();
    expect(computeSlaStatus(due, NOW)).toEqual({ state: "ok", hours: 10 });
  });
});

describe("formatSlaLabel", () => {
  it("แปลงสถานะเป็นข้อความไทย", () => {
    expect(formatSlaLabel({ state: "overdue", hours: 3 })).toBe("เกิน SLA 3h");
    expect(formatSlaLabel({ state: "due-soon", hours: 2 })).toBe("เหลือ 2h");
    expect(formatSlaLabel({ state: "ok", hours: 8 })).toBe("เหลือ 8h");
    expect(formatSlaLabel({ state: "none", hours: null })).toBe("ไม่มี SLA");
  });
});

describe("compareUrgency", () => {
  it("เกิน SLA มาก่อนเสมอ (แม้อีกตัวเป็น critical)", () => {
    const overdueHigh: CaseLike = {
      level: "high",
      sla_due_at: new Date(NOW - 1 * H).toISOString(),
    };
    const okCritical: CaseLike = {
      level: "critical",
      sla_due_at: new Date(NOW + 5 * H).toISOString(),
    };
    expect(compareUrgency(overdueHigh, okCritical, NOW)).toBeLessThan(0);
  });

  it("เมื่อสถานะ overdue เท่ากัน → critical มาก่อน high", () => {
    const critical: CaseLike = {
      level: "critical",
      sla_due_at: new Date(NOW + 5 * H).toISOString(),
    };
    const high: CaseLike = {
      level: "high",
      sla_due_at: new Date(NOW + 1 * H).toISOString(),
    };
    expect(compareUrgency(critical, high, NOW)).toBeLessThan(0);
  });

  it("level เท่ากัน → sla ใกล้สุดมาก่อน, ไม่มี sla ไปท้าย", () => {
    const soon: CaseLike = {
      level: "high",
      sla_due_at: new Date(NOW + 1 * H).toISOString(),
    };
    const later: CaseLike = {
      level: "high",
      sla_due_at: new Date(NOW + 8 * H).toISOString(),
    };
    const noSla: CaseLike = { level: "high", sla_due_at: null };
    expect(compareUrgency(soon, later, NOW)).toBeLessThan(0);
    expect(compareUrgency(later, noSla, NOW)).toBeLessThan(0);
  });

  it("จัดเรียงอาเรย์ได้ถูกต้องตามลำดับความเร่งด่วน", () => {
    const cases: CaseLike[] = [
      { level: "high", sla_due_at: new Date(NOW + 8 * H).toISOString() }, // ok high
      { level: "critical", sla_due_at: new Date(NOW - 2 * H).toISOString() }, // overdue critical
      { level: "high", sla_due_at: new Date(NOW - 1 * H).toISOString() }, // overdue high
      { level: "critical", sla_due_at: new Date(NOW + 3 * H).toISOString() }, // ok critical
    ];
    const sorted = [...cases].sort((a, b) => compareUrgency(a, b, NOW));
    expect(sorted.map((c) => `${c.level}`)).toEqual([
      "critical", // overdue critical
      "high", // overdue high
      "critical", // ok critical
      "high", // ok high
    ]);
  });
});

describe("summarizeEscalation", () => {
  it("นับ total/critical/high/overdue ถูกต้อง", () => {
    const cases: CaseLike[] = [
      { level: "critical", sla_due_at: new Date(NOW - 2 * H).toISOString() }, // overdue
      { level: "critical", sla_due_at: new Date(NOW + 5 * H).toISOString() },
      { level: "high", sla_due_at: new Date(NOW - 1 * H).toISOString() }, // overdue
      { level: "high", sla_due_at: null },
    ];
    expect(summarizeEscalation(cases, NOW)).toEqual({
      total: 4,
      critical: 2,
      high: 2,
      overdue: 2,
    });
  });

  it("ไม่มีเคส → ทุกค่าเป็น 0", () => {
    expect(summarizeEscalation([], NOW)).toEqual({
      total: 0,
      critical: 0,
      high: 0,
      overdue: 0,
    });
  });
});
