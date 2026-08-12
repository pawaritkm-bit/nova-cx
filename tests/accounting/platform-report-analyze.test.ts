import { describe, it, expect } from "vitest";
import {
  summarizePlatformReport,
  summarizePlatformReportByMonth,
  type PlatformReportLine,
} from "@/lib/accounting/platform-report-analyze";

/**
 * เทสต์ `platform-report-analyze.ts` (ข้อ C, 2026-08-12)
 *   โจทย์: "แยกค่าใช้จ่ายต่างๆของแพลตฟอร์ม และยอดขายออกจากกัน ให้เหลือกำไรจริง"
 */

function line(p: Partial<PlatformReportLine>): PlatformReportLine {
  return {
    date: null,
    order_no: null,
    description: null,
    category: null,
    direction: null,
    amount: null,
    ...p,
  };
}

describe("summarizePlatformReport", () => {
  it("แยกยอดขาย vs ค่าธรรมเนียมแต่ละประเภท ให้เหลือกำไรสุทธิถูกต้อง", () => {
    const lines: PlatformReportLine[] = [
      line({ category: "sales", direction: "credit", amount: 1000 }),
      line({ category: "sales", direction: "credit", amount: 500 }),
      line({ category: "commission_fee", direction: "deduct", amount: 100 }),
      line({ category: "payment_fee", direction: "deduct", amount: 30 }),
      line({ category: "commission_fee", direction: "deduct", amount: 50 }),
    ];
    const s = summarizePlatformReport(lines);
    expect(s.grossSales).toBe(1500);
    expect(s.totalDeductions).toBe(180);
    expect(s.netAmount).toBe(1320); // 1500 - 180
    const commission = s.deductions.find((d) => d.category === "commission_fee");
    expect(commission?.total).toBe(150);
    expect(commission?.count).toBe(2);
    const payment = s.deductions.find((d) => d.category === "payment_fee");
    expect(payment?.total).toBe(30);
  });

  it("รายการ credit ที่ไม่ใช่ยอดขาย (เช่นเงินปรับปรุงเพิ่ม) → เข้า otherCredit ไม่ปนกับ grossSales", () => {
    const lines: PlatformReportLine[] = [
      line({ category: "sales", direction: "credit", amount: 1000 }),
      line({ category: "other", direction: "credit", amount: 50 }),
    ];
    const s = summarizePlatformReport(lines);
    expect(s.grossSales).toBe(1000);
    expect(s.otherCredit).toBe(50);
    expect(s.netAmount).toBe(1050);
  });

  it("category ไม่ระบุแต่ direction=deduct → รวมเข้ากลุ่ม 'other'", () => {
    const lines: PlatformReportLine[] = [line({ category: null, direction: "deduct", amount: 20 })];
    const s = summarizePlatformReport(lines);
    const other = s.deductions.find((d) => d.category === "other");
    expect(other?.total).toBe(20);
    expect(s.totalDeductions).toBe(20);
  });

  it("amount null/ลบ → ไม่นับ (safeAmount กันค่าผิดปกติ)", () => {
    const lines: PlatformReportLine[] = [
      line({ category: "sales", direction: "credit", amount: null }),
      line({ category: "sales", direction: "credit", amount: -100 }),
    ];
    const s = summarizePlatformReport(lines);
    expect(s.grossSales).toBe(0);
  });

  it("category='sales' แต่ direction='deduct' (ผู้ใช้แก้ตารางเองติดคอมโบนี้) → ยังต้องนับใน totalDeductions เสมอ (แก้บั๊กร้ายแรง — เดิม netAmount สูงเกินจริงแบบเงียบ ๆ)", () => {
    const lines: PlatformReportLine[] = [
      line({ category: "sales", direction: "credit", amount: 1000 }),
      line({ category: "sales", direction: "deduct", amount: 300 }), // เช่นยอดขายที่ถูกยกเลิก/หักคืน
      line({ category: "commission_fee", direction: "deduct", amount: 50 }),
    ];
    const s = summarizePlatformReport(lines);
    expect(s.totalDeductions).toBe(350); // ต้องรวม 300 ด้วย ไม่ใช่แค่ 50
    expect(s.netAmount).toBe(650); // 1000 - 350 (เดิมบั๊กจะได้ 950)
    // ค่าต้องตรงกับ summarizePlatformReportByMonth เสมอ (การ์ดสรุปหลัก vs การ์ดรายเดือน ห้ามไม่ตรงกัน)
    const monthly = summarizePlatformReportByMonth(lines);
    expect(monthly[0].netAmount).toBe(650);
  });

  it("array ว่าง → ทุกยอดเป็น 0", () => {
    const s = summarizePlatformReport([]);
    expect(s).toEqual({ grossSales: 0, otherCredit: 0, deductions: [], totalDeductions: 0, netAmount: 0, count: 0 });
  });
});

describe("summarizePlatformReportByMonth", () => {
  it("แยกกำไรสุทธิตามเดือน (เวลาไทย) ถูกต้อง", () => {
    const lines: PlatformReportLine[] = [
      line({ date: "2026-07-15", category: "sales", direction: "credit", amount: 1000 }),
      line({ date: "2026-07-20", category: "commission_fee", direction: "deduct", amount: 100 }),
      line({ date: "2026-08-01", category: "sales", direction: "credit", amount: 2000 }),
      line({ date: "2026-08-05", category: "payment_fee", direction: "deduct", amount: 50 }),
    ];
    const monthly = summarizePlatformReportByMonth(lines);
    expect(monthly.map((m) => m.month)).toEqual(["2026-08", "2026-07"]); // ล่าสุดก่อน
    const jul = monthly.find((m) => m.month === "2026-07")!;
    expect(jul.grossSales).toBe(1000);
    expect(jul.totalDeductions).toBe(100);
    expect(jul.netAmount).toBe(900);
    const aug = monthly.find((m) => m.month === "2026-08")!;
    expect(aug.netAmount).toBe(1950);
  });

  it("ไม่มีวันที่ → กลุ่ม 'ไม่ระบุเดือน' อยู่ท้ายสุด", () => {
    const lines: PlatformReportLine[] = [
      line({ date: "2026-07-01", category: "sales", direction: "credit", amount: 100 }),
      line({ date: null, category: "sales", direction: "credit", amount: 50 }),
    ];
    const monthly = summarizePlatformReportByMonth(lines);
    expect(monthly[monthly.length - 1].month).toBe("");
  });
});
