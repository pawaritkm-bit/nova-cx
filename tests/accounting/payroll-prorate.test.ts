import { describe, it, expect } from "vitest";
import { calcProratedGrossSalary } from "@/lib/accounting/payroll-prorate";

/**
 * เทสต์ lib/accounting/payroll-prorate.ts (เฟส 9b กลุ่ม BB, T129)
 *   ★ pure ล้วน — ไม่แตะ DB
 */

describe("calcProratedGrossSalary (BB)", () => {
  it("★ พนักงานเต็มเดือน (ไม่มี start/resign ตกในเดือนนี้) → isProrated=false, prorated===baseSalary เป๊ะ", () => {
    const res = calcProratedGrossSalary(20000, 2569, 8, "2020-01-01", null);
    expect(res.isProrated).toBe(false);
    expect(res.prorated).toBe(20000);
    expect(res.daysWorked).toBe(res.daysInMonth);
  });

  it("★ ไม่มี start_date/resign_date เลย (พนักงานเก่า) → isProrated=false, prorated===baseSalary เป๊ะ", () => {
    const res = calcProratedGrossSalary(35000.5, 2569, 8, null, null);
    expect(res.isProrated).toBe(false);
    expect(res.prorated).toBe(35000.5);
  });

  it("เข้าใหม่กลางเดือน (เริ่ม 16 ก.พ. 2569 = ค.ศ.2026 ไม่ใช่ปีอธิกสุรทิน, ก.พ.=28 วัน) → daysWorked=13/28", () => {
    const res = calcProratedGrossSalary(28000, 2569, 2, "2026-02-16", null);
    expect(res.isProrated).toBe(true);
    expect(res.daysInMonth).toBe(28);
    expect(res.daysWorked).toBe(13); // 28-16+1
    expect(res.prorated).toBe(Math.round((28000 / 28) * 13 * 100) / 100);
  });

  it("ลาออกกลางเดือน (resign วันที่ 10 ของเดือน) → daysWorked=10", () => {
    const res = calcProratedGrossSalary(30000, 2569, 8, "2020-01-01", "2026-08-10");
    expect(res.isProrated).toBe(true);
    expect(res.daysWorked).toBe(10);
  });

  it("เข้า+ออกในเดือนเดียวกัน (start=5, resign=20) → daysWorked=16", () => {
    const res = calcProratedGrossSalary(30000, 2569, 8, "2026-08-05", "2026-08-20");
    expect(res.isProrated).toBe(true);
    expect(res.daysWorked).toBe(16); // 20-5+1
  });

  it("★ เดือน ก.พ. ปีอธิกสุรทิน (พ.ศ.2567 = ค.ศ.2024 หาร 4 ลงตัว) → daysInMonth=29", () => {
    const res = calcProratedGrossSalary(29000, 2567, 2, "2024-02-20", null);
    expect(res.daysInMonth).toBe(29);
    expect(res.daysWorked).toBe(10); // 29-20+1
  });

  it("★ เดือน ก.พ. ปีปกติ (พ.ศ.2569 = ค.ศ.2026 ไม่หาร 4 ลงตัว) → daysInMonth=28", () => {
    const res = calcProratedGrossSalary(28000, 2569, 2, "2020-01-01", null);
    expect(res.daysInMonth).toBe(28);
  });

  it("resign_date ก่อนเดือนนี้ทั้งเดือน (ข้อมูลผิดปกติ) → fallback ไม่ prorate กันค่าติดลบ", () => {
    const res = calcProratedGrossSalary(20000, 2569, 8, null, "2026-07-15");
    expect(res.isProrated).toBe(false);
    expect(res.prorated).toBe(20000);
  });

  it("baseSalary=0 → prorated=0 เสมอ ไม่ throw", () => {
    const res = calcProratedGrossSalary(0, 2569, 8, "2026-08-16", null);
    expect(res.prorated).toBe(0);
  });
});
