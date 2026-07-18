import { describe, it, expect } from "vitest";
import { makeFakeDb, makeCapture } from "../helpers/fake-supabase";
import {
  resolveReportAccess,
  summarizeCases,
  summarizeScores,
  isValidPeriod,
  monthRange,
  previousPeriod,
  buildMonthlyReport,
  ReportAccessError,
  type CaseRow,
  type EvalRow,
} from "@/lib/reports/accountant-report";
import type { Viewer } from "@/lib/evaluation/access";

const T = "tenant-1";
const EMP = "emp-1";
const OTHER = "emp-2";

function viewer(partial: Partial<Viewer>): Viewer {
  return { role: null, employeeId: null, tenantId: T, teamMemberIds: new Set(), ...partial };
}

describe("resolveReportAccess — tier", () => {
  it("admin/executive/auditor_qa → ทุกคน + ทุกสถานะ (confirmedOnly=false)", () => {
    for (const role of ["admin", "executive", "auditor_qa"] as const) {
      const a = resolveReportAccess(viewer({ role }), EMP);
      expect(a).toEqual({ allowed: true, confirmedOnly: false });
    }
  });

  it("★ hr → เห็นได้ แต่คะแนนนับเฉพาะ confirmed (confirmedOnly=true)", () => {
    const a = resolveReportAccess(viewer({ role: "hr" }), EMP);
    expect(a).toEqual({ allowed: true, confirmedOnly: true });
  });

  it("acc_lead → เฉพาะทีมตน (teamMemberIds) หรือของตัวเอง", () => {
    const lead = viewer({ role: "acc_lead", employeeId: "lead-1", teamMemberIds: new Set([EMP]) });
    expect(resolveReportAccess(lead, EMP)).toEqual({ allowed: true, confirmedOnly: false });
    expect(resolveReportAccess(lead, OTHER)).toEqual({ allowed: false });
    // ของตัวเอง
    expect(resolveReportAccess(lead, "lead-1")).toEqual({ allowed: true, confirmedOnly: false });
  });

  it("accountant → เฉพาะของตัวเอง", () => {
    const acc = viewer({ role: "accountant", employeeId: EMP });
    expect(resolveReportAccess(acc, EMP)).toEqual({ allowed: true, confirmedOnly: false });
    expect(resolveReportAccess(acc, OTHER)).toEqual({ allowed: false });
  });

  it("role null → ปฏิเสธ (default deny)", () => {
    expect(resolveReportAccess(viewer({ role: null }), EMP)).toEqual({ allowed: false });
  });
});

describe("period helpers", () => {
  it("isValidPeriod", () => {
    expect(isValidPeriod("2026-07")).toBe(true);
    expect(isValidPeriod("2026-13")).toBe(false);
    expect(isValidPeriod("2026-7")).toBe(false);
  });
  it("monthRange = [start, end) เดือนถัดไป", () => {
    const { start, end } = monthRange("2026-07");
    expect(start).toBe("2026-07-01T00:00:00.000Z");
    expect(end).toBe("2026-08-01T00:00:00.000Z");
  });
  it("previousPeriod", () => {
    expect(previousPeriod("2026-07")).toBe("2026-06");
    expect(previousPeriod("2026-01")).toBe("2025-12");
  });
});

describe("summarizeCases", () => {
  const base = (over: Partial<CaseRow>): CaseRow => ({
    id: "c", customer_id: "cust-a", status: "closed",
    opened_at: "2026-07-01T09:00:00.000Z",
    first_responded_at: "2026-07-01T09:30:00.000Z",
    first_response_due_at: "2026-07-01T10:00:00.000Z",
    resolution_due_at: "2026-07-01T18:00:00.000Z",
    closed_at: "2026-07-01T12:00:00.000Z",
    ...over,
  });

  it("นับลูกค้า/ปิด/เวลา/เกิน SLA", () => {
    const rows: CaseRow[] = [
      base({ id: "c1", customer_id: "A" }),
      // open + ยังไม่เลยกำหนดปิด (due null) → ไม่ over SLA
      base({ id: "c2", customer_id: "B", status: "open", closed_at: null, resolution_due_at: null }),
      // ตอบช้ากว่ากำหนด → เกิน SLA
      base({ id: "c3", customer_id: "A", first_responded_at: "2026-07-01T11:00:00.000Z" }),
    ];
    const s = summarizeCases(rows);
    expect(s.customerCount).toBe(2);
    expect(s.totalCases).toBe(3);
    expect(s.closedCases).toBe(2); // c1, c3 closed
    expect(s.avgFirstResponseMin).not.toBeNull();
    expect(s.overSlaCases).toBe(1); // c3 (ตอบช้ากว่ากำหนด)
  });

  it("เคส open ที่เลยกำหนดปิดแล้ว → นับ over SLA", () => {
    const rows: CaseRow[] = [
      base({ id: "o1", status: "open", closed_at: null, first_responded_at: null, resolution_due_at: "2020-01-01T00:00:00.000Z" }),
    ];
    expect(summarizeCases(rows).overSlaCases).toBe(1);
  });

  it("ไม่มีเคส → ค่าเป็น null/0", () => {
    const s = summarizeCases([]);
    expect(s.totalCases).toBe(0);
    expect(s.closedPct).toBeNull();
    expect(s.avgFirstResponseMin).toBeNull();
  });
});

describe("summarizeScores", () => {
  it("เฉลี่ย overall + 8 มิติ", () => {
    const rows: EvalRow[] = [
      { status: "manager_confirmed", overall_score: 80, dimension_scores: { correctness: 90, sla: 70 } },
      { status: "manager_edited", overall_score: 90, dimension_scores: { correctness: 100, sla: 80 } },
    ];
    const s = summarizeScores(rows);
    expect(s.overallAvg).toBe(85);
    expect(s.evalCount).toBe(2);
    const correctness = s.dimensions.find((d) => d.key === "correctness");
    expect(correctness?.avg).toBe(95);
    const politeness = s.dimensions.find((d) => d.key === "politeness");
    expect(politeness?.avg).toBeNull(); // ไม่มีข้อมูล
  });
});

describe("buildMonthlyReport — hr ต้อง filter สถานะ confirmed", () => {
  function makeReportDb() {
    return makeFakeDb((q) => {
      if (q.table === "employees" && q.terminal === "maybeSingle") return { data: { first_name: "พิม", nickname: "พิม" } };
      if (q.table === "conversation_cases") return { data: [] };
      if (q.table === "accountant_evaluations") return { data: [] };
      if (q.table === "coaching_recommendations") return { data: [] };
      return { data: null };
    }, makeCapture());
  }

  it("hr → มี filter .in('status', CONFIRMED) บน accountant_evaluations", async () => {
    const { db, capture } = makeReportDb();
    const v = viewer({ role: "hr" });
    const r = await buildMonthlyReport(db, v, { employeeId: EMP, period: "2026-07" });
    expect(r.confirmedOnly).toBe(true);
    const statusFilter = capture.filters.find(
      (f) => f.table === "accountant_evaluations" && f.kind === "in" && f.column === "status"
    );
    expect(statusFilter).toBeTruthy();
    expect(statusFilter?.value).toContain("manager_confirmed");
  });

  it("admin → ไม่ filter status (เห็นทุกสถานะ)", async () => {
    const { db, capture } = makeReportDb();
    const v = viewer({ role: "admin" });
    const r = await buildMonthlyReport(db, v, { employeeId: EMP, period: "2026-07" });
    expect(r.confirmedOnly).toBe(false);
    const statusFilter = capture.filters.find(
      (f) => f.table === "accountant_evaluations" && f.kind === "in" && f.column === "status"
    );
    expect(statusFilter).toBeUndefined();
  });

  it("accountant ดูของคนอื่น → ReportAccessError", async () => {
    const { db } = makeReportDb();
    const v = viewer({ role: "accountant", employeeId: OTHER });
    await expect(buildMonthlyReport(db, v, { employeeId: EMP, period: "2026-07" })).rejects.toThrow(ReportAccessError);
  });
});
