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

describe("tax-month: filterPurchaseByTaxMonth (ยึดเดือนที่ติ๊ก inputTaxMonth ล้วน)", () => {
  const mk = (id: string, docDate: string | null, inputTaxMonth: string | null = null) => ({
    id,
    docDate,
    inputTaxMonth,
  });

  it("★ ต้องติ๊ก (inputTaxMonth) ก่อนถึงเข้ารายงาน — ไม่ยึดวันที่บิล", () => {
    const entries = [
      mk("a", "2026-07-05", null),      // ก.ค. แต่ยังไม่ติ๊ก → ไม่เข้า
      mk("b", "2026-06-20", "2026-07"), // บิล มิ.ย. ติ๊กยื่น ก.ค. → เข้า
    ];
    const out = filterPurchaseByTaxMonth(entries, "2026-07", "2026-07");
    expect(out.map((e) => e.id)).toEqual(["b"]);
  });

  it("ยกเดือน: ติ๊ก ก.ค. → โผล่ ก.ค. ไม่โผล่ มิ.ย.", () => {
    const entries = [mk("a", "2026-06-20", "2026-07")];
    expect(filterPurchaseByTaxMonth(entries, "2026-07", "2026-07").map((e) => e.id)).toEqual(["a"]);
    expect(filterPurchaseByTaxMonth(entries, "2026-06", "2026-06")).toEqual([]);
  });

  it("ยังไม่ติ๊ก (null) → ตัดออกแม้มีวันที่บิล", () => {
    expect(filterPurchaseByTaxMonth([mk("a", "2026-07-05", null)], "2026-07", "2026-07")).toEqual([]);
    expect(filterPurchaseByTaxMonth([mk("a", null, null)], "2026-07", "2026-07")).toEqual([]);
  });

  it("ช่วงหลายเดือน [start,end] inclusive (ตามเดือนที่ติ๊ก)", () => {
    const entries = [
      mk("a", "2026-06-01", "2026-06"),
      mk("b", "2026-07-01", "2026-07"),
      mk("c", "2026-08-01", "2026-08"),
    ];
    const out = filterPurchaseByTaxMonth(entries, "2026-06", "2026-07");
    expect(out.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });
});
