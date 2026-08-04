import { describe, it, expect } from "vitest";
import {
  taxMonthLabel,
  taxMonthOptions,
  shiftMonth,
  purchaseFetchLowerBound,
  filterPurchaseByTaxMonth,
} from "@/lib/accounting/tax-month";

describe("tax-month: taxMonthLabel (YYYY-MM ค.ศ. → ไทย พ.ศ.)", () => {
  it("แปลงเดือน/ปีเป็นชื่อย่อไทย + พ.ศ.", () => {
    expect(taxMonthLabel("2026-07")).toBe("ก.ค. 2569");
    expect(taxMonthLabel("2026-01")).toBe("ม.ค. 2569");
    expect(taxMonthLabel("2025-12")).toBe("ธ.ค. 2568");
  });
  it("รูปแบบพัง → คืนค่าเดิม", () => {
    expect(taxMonthLabel("bad")).toBe("bad");
    expect(taxMonthLabel("2026-13")).toBe("2026-13");
  });
});

describe("tax-month: taxMonthOptions (เดือนฐาน + 6 เดือนถัดไป)", () => {
  it("default = 7 เดือน (รวมเดือนฐาน) ข้ามปีถูก", () => {
    expect(taxMonthOptions("2026-07")).toEqual([
      "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01",
    ]);
  });
  it("ปรับ ahead ได้", () => {
    expect(taxMonthOptions("2026-07", 2)).toEqual(["2026-07", "2026-08", "2026-09"]);
  });
  it("baseYm พัง → []", () => {
    expect(taxMonthOptions("")).toEqual([]);
    expect(taxMonthOptions("2026-99")).toEqual([]);
  });
});

describe("tax-month: shiftMonth", () => {
  it("เลื่อนไปหน้า/ถอยหลัง ข้ามปีถูก", () => {
    expect(shiftMonth("2026-07", 1)).toBe("2026-08");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-07", -6)).toBe("2026-01");
    expect(shiftMonth("2026-07", -7)).toBe("2025-12");
  });
  it("รูปแบบพัง → คืนค่าเดิม", () => {
    expect(shiftMonth("nope", 3)).toBe("nope");
  });
});

describe("tax-month: purchaseFetchLowerBound", () => {
  it("= วันแรกของเดือน (start - 6)", () => {
    expect(purchaseFetchLowerBound("2026-07", "2026-07-01")).toBe("2026-01-01");
    expect(purchaseFetchLowerBound("2026-03", "2026-03-01")).toBe("2025-09-01");
  });
  it("start พัง → fallback", () => {
    expect(purchaseFetchLowerBound("bad", "2026-07-01")).toBe("2026-07-01");
  });
});

describe("tax-month: filterPurchaseByTaxMonth (ยึด effectiveTaxMonth)", () => {
  const mk = (id: string, docDate: string | null, inputTaxMonth: string | null = null) => ({
    id,
    docDate,
    inputTaxMonth,
  });

  it("บิลปกติ (ไม่ยกเดือน) เข้าตามเดือน doc_date", () => {
    const entries = [
      mk("a", "2026-07-05"), // ก.ค.
      mk("b", "2026-06-30"), // มิ.ย. → นอกช่วง
    ];
    const out = filterPurchaseByTaxMonth(entries, "2026-07", "2026-07");
    expect(out.map((e) => e.id)).toEqual(["a"]);
  });

  it("บิลยกเดือน (inputTaxMonth) โผล่ในเดือนที่ยื่นจริง ไม่ใช่เดือน doc_date", () => {
    const entries = [
      mk("a", "2026-06-20", "2026-07"), // บิล มิ.ย. ยกไปยื่น ก.ค.
      mk("b", "2026-07-10"),            // บิล ก.ค. ปกติ
    ];
    // เลือกช่วง ก.ค. → ได้ทั้ง a (ยกมา) และ b
    const jul = filterPurchaseByTaxMonth(entries, "2026-07", "2026-07");
    expect(jul.map((e) => e.id).sort()).toEqual(["a", "b"]);
    // เลือกช่วง มิ.ย. → a ไม่โผล่ (ยกออกไป ก.ค. แล้ว)
    const jun = filterPurchaseByTaxMonth(entries, "2026-06", "2026-06");
    expect(jun.map((e) => e.id)).toEqual([]);
  });

  it("บิลไม่มีวันที่ + ไม่ระบุเดือน (effectiveTaxMonth=null) → ตัดออก", () => {
    const entries = [mk("a", null, null)];
    expect(filterPurchaseByTaxMonth(entries, "2026-07", "2026-07")).toEqual([]);
  });

  it("ช่วงหลายเดือน [start,end] inclusive", () => {
    const entries = [
      mk("a", "2026-06-01"),
      mk("b", "2026-07-01"),
      mk("c", "2026-08-01"),
    ];
    const out = filterPurchaseByTaxMonth(entries, "2026-06", "2026-07");
    expect(out.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });
});
