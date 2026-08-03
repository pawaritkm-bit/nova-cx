import { describe, it, expect } from "vitest";
import {
  computeSbtMonthly,
  computeYearSummary,
  normalizePeriodMonth,
  round2,
  type ShareCircleEntry,
} from "@/lib/share-circles/queries";

/** helper สร้าง entry (ค่าที่ไม่ระบุ = null) */
function entry(p: Partial<ShareCircleEntry>): ShareCircleEntry {
  return {
    id: p.id ?? "id",
    tenantId: "t",
    customerId: "c",
    periodMonth: p.periodMonth ?? "2026-04",
    entryDate: null,
    circleName: p.circleName ?? "วง",
    roundNote: null,
    memberCount: p.memberCount ?? null,
    principalPerHead: p.principalPerHead ?? null,
    taoIncome: p.taoIncome ?? null,
    mgmtFee: p.mgmtFee ?? null,
    operationFee: p.operationFee ?? null,
    interestIncome: p.interestIncome ?? null,
    expense: p.expense ?? null,
    source: p.source ?? "ai",
    status: "active",
    createdAt: "2026-04-01T00:00:00Z",
  };
}

describe("normalizePeriodMonth — บังคับ ค.ศ. YYYY-MM", () => {
  it("ปี พ.ศ. (≥2500) → ลบ 543", () => {
    expect(normalizePeriodMonth("2569-04")).toBe("2026-04");
    expect(normalizePeriodMonth("2568-12")).toBe("2025-12");
  });
  it("ปี ค.ศ. อยู่แล้ว → ไม่แตะ", () => {
    expect(normalizePeriodMonth("2026-04")).toBe("2026-04");
    expect(normalizePeriodMonth("2024-01")).toBe("2024-01");
  });
  it("รูปแบบผิด → คืนค่าเดิม", () => {
    expect(normalizePeriodMonth("2026/04")).toBe("2026/04");
    expect(normalizePeriodMonth("")).toBe("");
  });
});

describe("computeSbtMonthly — ภธ.40 (ฐาน=G+I, รวม=3.3%)", () => {
  it("รวม G+I ต่อเดือน แล้วคิด 3% / ท้องถิ่น 10% / รวม 3.3%", () => {
    const rows = computeSbtMonthly([
      entry({ periodMonth: "2026-04", taoIncome: 100000, operationFee: 0 }),
      entry({ periodMonth: "2026-04", taoIncome: 50000, operationFee: 2000 }),
    ]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.baseG).toBe(150000);
    expect(r.baseI).toBe(2000);
    expect(r.base).toBe(152000);
    expect(r.sbt3).toBe(round2(152000 * 0.03)); // 4560
    expect(r.local).toBe(round2(4560 * 0.1)); // 456
    expect(r.total).toBe(round2(4560 * 1.1)); // 5016
    expect(r.total).toBeCloseTo(152000 * 0.033, 2);
    expect(r.circleCount).toBe(2);
  });

  it("null (ไม่ระบุ) นับเป็น 0 · แยกคนละเดือน · เรียงใหม่→เก่า", () => {
    const rows = computeSbtMonthly([
      entry({ periodMonth: "2026-03", taoIncome: null, operationFee: null }),
      entry({ periodMonth: "2026-05", taoIncome: 10000 }),
    ]);
    expect(rows.map((r) => r.month)).toEqual(["2026-05", "2026-03"]);
    const march = rows.find((r) => r.month === "2026-03")!;
    expect(march.base).toBe(0);
    expect(march.total).toBe(0);
  });

  it("ไม่มี entry → []", () => {
    expect(computeSbtMonthly([])).toEqual([]);
  });
});

describe("computeYearSummary — ภงด.90 (ดอกเบี้ย J ไม่หักเหมา)", () => {
  it("รายได้ธุรกิจ (G+H+I) หัก 40% + ดอกเบี้ย (J) เต็ม", () => {
    const rows = computeYearSummary([
      entry({ periodMonth: "2026-04", taoIncome: 100000, mgmtFee: 20000, operationFee: 5000, interestIncome: 8000 }),
      entry({ periodMonth: "2026-07", taoIncome: 50000, interestIncome: 2000 }),
    ]);
    expect(rows).toHaveLength(1);
    const y = rows[0];
    expect(y.year).toBe("2026");
    expect(y.businessIncome).toBe(175000); // 100000+20000+5000+50000
    expect(y.interestIncome).toBe(10000); // 8000+2000
    expect(y.totalIncome).toBe(185000);
    expect(y.businessAfterFlat).toBe(round2(175000 * 0.4)); // 70000
    // ★ ดอกเบี้ยไม่หักเหมา → บวกเต็ม: 70000 + 10000
    expect(y.afterDeduction).toBe(80000);
  });

  it("ดอกเบี้ยล้วน (ไม่มีรายได้ธุรกิจ) → afterDeduction = ดอกเบี้ยเต็ม", () => {
    const rows = computeYearSummary([entry({ periodMonth: "2025-12", interestIncome: 5000 })]);
    expect(rows[0].businessAfterFlat).toBe(0);
    expect(rows[0].afterDeduction).toBe(5000);
  });

  it("แยกคนละปี + เรียงใหม่→เก่า", () => {
    const rows = computeYearSummary([
      entry({ periodMonth: "2025-06", taoIncome: 10000 }),
      entry({ periodMonth: "2026-06", taoIncome: 20000 }),
    ]);
    expect(rows.map((r) => r.year)).toEqual(["2026", "2025"]);
  });

  it("period_month รูปแบบผิด → ข้าม (ไม่ crash)", () => {
    const rows = computeYearSummary([entry({ periodMonth: "bad", taoIncome: 999 })]);
    expect(rows).toEqual([]);
  });
});
