import { describe, it, expect } from "vitest";
import {
  isClosedStatus,
  normalizeLevelFilter,
  normalizeStatusFilter,
  filterCases,
  sortCasesByUrgency,
  filterAndSortCases,
} from "@/lib/dashboard/cases";
import type { CaseFactRow } from "@/lib/dashboard/types";

// เวลาอ้างอิงคงที่ (deterministic) — 2026-07-17T12:00:00Z
const NOW = Date.parse("2026-07-17T12:00:00Z");
const H = 3_600_000;

/** helper สร้างเคสจำลอง (เฉพาะฟิลด์ที่ filter/sort ใช้) */
function mkCase(over: Partial<CaseFactRow>): CaseFactRow {
  return {
    case_id: over.case_id ?? Math.random().toString(36).slice(2),
    case_no: over.case_no ?? "CASE-000",
    customer_id: null,
    customer_code: over.customer_code ?? "C-001",
    type: over.type ?? "complaint",
    level: over.level ?? "medium",
    status: over.status ?? "open",
    sla_due_at: over.sla_due_at ?? null,
    created_at: over.created_at ?? "2026-07-17T00:00:00Z",
    closed_at: over.closed_at ?? null,
    post_resolution_csat: null,
  };
}

describe("isClosedStatus", () => {
  it("resolved/closed = ปิด, อื่น ๆ = เปิด", () => {
    expect(isClosedStatus("resolved")).toBe(true);
    expect(isClosedStatus("closed")).toBe(true);
    expect(isClosedStatus("open")).toBe(false);
    expect(isClosedStatus("in_progress")).toBe(false);
  });
});

describe("normalizeLevelFilter / normalizeStatusFilter", () => {
  it("ค่าที่รู้จักผ่าน, ค่าอื่น/ว่าง → all", () => {
    expect(normalizeLevelFilter("critical")).toBe("critical");
    expect(normalizeLevelFilter("low")).toBe("low");
    expect(normalizeLevelFilter("banana")).toBe("all");
    expect(normalizeLevelFilter(null)).toBe("all");
    expect(normalizeLevelFilter(undefined)).toBe("all");

    expect(normalizeStatusFilter("open")).toBe("open");
    expect(normalizeStatusFilter("closed")).toBe("closed");
    expect(normalizeStatusFilter("???")).toBe("all");
    expect(normalizeStatusFilter(null)).toBe("all");
  });
});

describe("filterCases", () => {
  const rows = [
    mkCase({ case_no: "A", level: "critical", status: "open" }),
    mkCase({ case_no: "B", level: "high", status: "resolved" }),
    mkCase({ case_no: "C", level: "medium", status: "in_progress" }),
    mkCase({ case_no: "D", level: "low", status: "closed" }),
  ];

  it("level=all + status=all → คืนทุกเคส", () => {
    expect(filterCases(rows, { level: "all", status: "all" })).toHaveLength(4);
  });

  it("กรองตามระดับ (case-insensitive)", () => {
    const rowsUpper = [mkCase({ case_no: "X", level: "CRITICAL" })];
    expect(filterCases(rowsUpper, { level: "critical", status: "all" })).toHaveLength(1);
  });

  it("status=open → ตัด resolved/closed ออก", () => {
    const out = filterCases(rows, { level: "all", status: "open" });
    expect(out.map((c) => c.case_no)).toEqual(["A", "C"]);
  });

  it("status=closed → เหลือเฉพาะ resolved/closed", () => {
    const out = filterCases(rows, { level: "all", status: "closed" });
    expect(out.map((c) => c.case_no)).toEqual(["B", "D"]);
  });

  it("กรองระดับ + สถานะพร้อมกัน", () => {
    const out = filterCases(rows, { level: "critical", status: "open" });
    expect(out.map((c) => c.case_no)).toEqual(["A"]);
  });
});

describe("sortCasesByUrgency", () => {
  it("เกิน SLA มาก่อน แล้ว critical ก่อน high แล้ว sla ใกล้สุด (ไม่แก้ต้นฉบับ)", () => {
    const overdue = mkCase({
      case_no: "OVERDUE",
      level: "high",
      sla_due_at: new Date(NOW - 3 * H).toISOString(),
    });
    const critSoon = mkCase({
      case_no: "CRIT",
      level: "critical",
      sla_due_at: new Date(NOW + 1 * H).toISOString(),
    });
    const highSoon = mkCase({
      case_no: "HIGH",
      level: "high",
      sla_due_at: new Date(NOW + 1 * H).toISOString(),
    });
    const input = [critSoon, highSoon, overdue];
    const out = sortCasesByUrgency(input, NOW);
    expect(out.map((c) => c.case_no)).toEqual(["OVERDUE", "CRIT", "HIGH"]);
    // ต้นฉบับไม่ถูกแก้ (immutability)
    expect(input.map((c) => c.case_no)).toEqual(["CRIT", "HIGH", "OVERDUE"]);
  });
});

describe("filterAndSortCases", () => {
  it("กรองแล้วเรียงในขั้นตอนเดียว", () => {
    const rows = [
      mkCase({ case_no: "OPEN-CRIT", level: "critical", status: "open" }),
      mkCase({ case_no: "DONE", level: "critical", status: "closed" }),
      mkCase({ case_no: "OPEN-HIGH", level: "high", status: "open" }),
    ];
    const out = filterAndSortCases(rows, { level: "all", status: "open" }, NOW);
    // ปิดถูกตัด, critical มาก่อน high
    expect(out.map((c) => c.case_no)).toEqual(["OPEN-CRIT", "OPEN-HIGH"]);
  });
});
