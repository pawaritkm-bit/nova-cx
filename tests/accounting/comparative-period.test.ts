import { describe, it, expect } from "vitest";
import {
  periodLengthInMonths,
  shiftPeriodBackward,
  resolveComparePeriod,
  quarterRangeOf,
} from "@/lib/accounting/comparative-period";

/**
 * comparative-period.ts — เฟส 4 ส่วน M1 (docs/06-accounting-features-roadmap.md, หมวด 0.4)
 *   เน้น: ความยาวงวด/เลื่อนงวดถอยหลัง (ข้ามปีถูกต้อง) + resolveComparePeriod ครบทุกโหมด + quarterRangeOf
 */

describe("periodLengthInMonths", () => {
  it("เดือนเดียว = 1", () => {
    expect(periodLengthInMonths("2026-07", "2026-07")).toBe(1);
  });

  it("หลายเดือนในปีเดียวกัน (ม.ค.-มี.ค.) = 3", () => {
    expect(periodLengthInMonths("2026-01", "2026-03")).toBe(3);
  });

  it("ข้ามปี (2025-11 ถึง 2026-02) = 4", () => {
    expect(periodLengthInMonths("2025-11", "2026-02")).toBe(4);
  });

  it("from อยู่หลัง to → 0", () => {
    expect(periodLengthInMonths("2026-03", "2026-01")).toBe(0);
  });

  it("รูปแบบผิด → 0", () => {
    expect(periodLengthInMonths("bad", "2026-01")).toBe(0);
    expect(periodLengthInMonths("2026-01", "")).toBe(0);
  });
});

describe("shiftPeriodBackward — ข้ามปีถูกต้องเสมอ", () => {
  it("เลื่อนถอยหลัง 1 เดือนจาก ม.ค. → ธ.ค.ปีก่อน", () => {
    expect(shiftPeriodBackward("2026-01", "2026-01", 1)).toEqual({ from: "2025-12", to: "2025-12" });
  });

  it("เลื่อนถอยหลัง 4 เดือน งวดยาว 4 เดือนไม่เท่าไตรมาส (2026-01 ถึง 2026-04)", () => {
    expect(shiftPeriodBackward("2026-01", "2026-04", 4)).toEqual({ from: "2025-09", to: "2025-12" });
  });

  it("เลื่อนถอยหลัง 12 เดือน (ปีก่อน) — เดือนเดียวกัน ปีก่อนหน้า", () => {
    expect(shiftPeriodBackward("2026-07", "2026-07", 12)).toEqual({ from: "2025-07", to: "2025-07" });
  });

  it("เลื่อนถอยหลัง 3 เดือนจากไตรมาสแรก (2026-01 ถึง 2026-03) → ข้ามปีเป็น 2025-10 ถึง 2025-12", () => {
    expect(shiftPeriodBackward("2026-01", "2026-03", 3)).toEqual({ from: "2025-10", to: "2025-12" });
  });

  it("เลื่อนถอยหลังจากปลายปี ไม่ข้ามปี", () => {
    expect(shiftPeriodBackward("2026-12", "2026-12", 1)).toEqual({ from: "2026-11", to: "2026-11" });
  });

  it("รูปแบบผิด → {from:'', to:''}", () => {
    expect(shiftPeriodBackward("bad", "2026-01", 1)).toEqual({ from: "", to: "" });
  });
});

describe("resolveComparePeriod", () => {
  const current = { from: "2026-03", to: "2026-03" };

  it("mode='none' → null เสมอ", () => {
    expect(resolveComparePeriod(current, "none")).toBeNull();
  });

  it("mode='prev_period' เดือนเดียว → เดือนก่อนหน้า", () => {
    expect(resolveComparePeriod(current, "prev_period")).toEqual({ from: "2026-02", to: "2026-02" });
  });

  it("★ mode='prev_period' ไตรมาส (งวดยาว 3 เดือน) → ไตรมาสก่อนหน้า (ย้อน 3 เดือนทั้งช่วง ไม่ใช่แค่ 1 เดือน)", () => {
    const q2 = { from: "2026-04", to: "2026-06" };
    expect(resolveComparePeriod(q2, "prev_period")).toEqual({ from: "2026-01", to: "2026-03" });
  });

  it("mode='prev_period' งวดยาวไม่เท่าไตรมาส (4 เดือน) → เลื่อนถอยหลัง 4 เดือนทั้งช่วง", () => {
    const long = { from: "2026-01", to: "2026-04" };
    expect(resolveComparePeriod(long, "prev_period")).toEqual({ from: "2025-09", to: "2025-12" });
  });

  it("mode='prev_year' → งวดเดียวกัน ปีก่อนหน้าเสมอ (ไม่ว่างวดจะยาวเท่าไร)", () => {
    expect(resolveComparePeriod(current, "prev_year")).toEqual({ from: "2025-03", to: "2025-03" });
    const q2 = { from: "2026-04", to: "2026-06" };
    expect(resolveComparePeriod(q2, "prev_year")).toEqual({ from: "2025-04", to: "2025-06" });
  });

  it("★ mode='prev_year' ต้นปี (ม.ค.) ข้ามทศวรรษ/ศตวรรษไม่ผิดเพี้ยน", () => {
    const jan = { from: "2000-01", to: "2000-01" };
    expect(resolveComparePeriod(jan, "prev_year")).toEqual({ from: "1999-01", to: "1999-01" });
  });

  it("mode='custom' ครบและถูกรูปแบบ → ใช้ตามที่กรอก", () => {
    expect(resolveComparePeriod(current, "custom", { from: "2020-01", to: "2020-06" })).toEqual({
      from: "2020-01",
      to: "2020-06",
    });
  });

  it("mode='custom' รูปแบบผิด/ไม่ครบ → null", () => {
    expect(resolveComparePeriod(current, "custom", { from: "bad", to: "2020-06" })).toBeNull();
    expect(resolveComparePeriod(current, "custom")).toBeNull();
    expect(resolveComparePeriod(current, "custom", { from: "2020-01" })).toBeNull();
  });

  it("งวดปัจจุบันรูปแบบผิด → prev_period/prev_year คืน null", () => {
    const bad = { from: "bad", to: "2026-03" };
    expect(resolveComparePeriod(bad, "prev_period")).toBeNull();
    expect(resolveComparePeriod(bad, "prev_year")).toBeNull();
  });

  it("งวดปัจจุบัน from > to (ไม่ถูกต้อง) → prev_period คืน null", () => {
    const bad = { from: "2026-05", to: "2026-01" };
    expect(resolveComparePeriod(bad, "prev_period")).toBeNull();
  });
});

describe("quarterRangeOf — ไตรมาสปฏิทิน ครบ 4 ไตรมาส", () => {
  it("Q1 = ม.ค.-มี.ค.", () => {
    expect(quarterRangeOf(2026, 1)).toEqual({ from: "2026-01", to: "2026-03" });
  });
  it("Q2 = เม.ย.-มิ.ย.", () => {
    expect(quarterRangeOf(2026, 2)).toEqual({ from: "2026-04", to: "2026-06" });
  });
  it("Q3 = ก.ค.-ก.ย.", () => {
    expect(quarterRangeOf(2026, 3)).toEqual({ from: "2026-07", to: "2026-09" });
  });
  it("Q4 = ต.ค.-ธ.ค. (ไม่ข้ามปี)", () => {
    expect(quarterRangeOf(2026, 4)).toEqual({ from: "2026-10", to: "2026-12" });
  });

  it("★ prev_period ของ Q1 (ม.ค.-มี.ค.) ต้องข้ามไปปีก่อน (ต.ค.-ธ.ค. ปีก่อน)", () => {
    const q1 = quarterRangeOf(2026, 1);
    expect(resolveComparePeriod(q1, "prev_period")).toEqual({ from: "2025-10", to: "2025-12" });
  });
});
