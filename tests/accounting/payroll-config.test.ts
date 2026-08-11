import { describe, it, expect, beforeEach } from "vitest";
import { makeInMemoryDb, type Tables } from "../helpers/fake-payroll-db";
import { getEffectivePitBrackets, getEffectiveSsoConfig } from "@/lib/accounting/payroll-config";

/**
 * เทสต์ lib/accounting/payroll-config.ts (เฟส 9 ส่วน AC, T103) — เลือกแถว effective_from ล่าสุดที่
 *   ≤ asOfDate ถูกต้องทุกกรณี (0.6) — โดยเฉพาะรอยต่อปี ค.ศ. 2025/2026 (= พ.ศ. 2568/2569) ที่เพดาน
 *   ประกันสังคมเปลี่ยน 15,000→17,500
 *
 * ★ ทุกวันที่ในเทสต์นี้เป็นปี ค.ศ. (Gregorian) จริงเสมอ — ตรงกับที่ทุกคอลัมน์ `date` ในระบบเก็บจริง (ดู
 *   คอมเมนต์แก้ไขบั๊กเรื่องนี้ใน migration 0079 — ร่าง SQL เดิมในเอกสารแผนเขียนปี พ.ศ. ตรง ๆ ผิด)
 */

let tables: Tables;

beforeEach(() => {
  tables = {
    pit_tax_brackets: [
      { id: "b1", effective_from: "2017-01-01", bracket_order: 1, income_from: 0, income_to: 150000, rate_percent: 0 },
      { id: "b2", effective_from: "2017-01-01", bracket_order: 2, income_from: 150001, income_to: 300000, rate_percent: 5 },
    ],
    sso_contribution_config: [
      { id: "s1", effective_from: "1997-01-01", employee_rate_percent: 5, employer_rate_percent: 5, wage_floor: 1650, wage_ceiling: 15000 },
      { id: "s2", effective_from: "2026-01-01", employee_rate_percent: 5, employer_rate_percent: 5, wage_floor: 1650, wage_ceiling: 17500 },
    ],
  };
});

describe("getEffectivePitBrackets", () => {
  it("asOfDate หลังแถว effective_from → ได้ขั้นภาษีของกลุ่มนั้นครบ เรียงตาม bracket_order", async () => {
    const { db } = makeInMemoryDb(tables);
    const brackets = await getEffectivePitBrackets(db, "2026-08-10");
    expect(brackets).not.toBeNull();
    expect(brackets!.map((b) => b.bracketOrder)).toEqual([1, 2]);
    expect(brackets![0].incomeTo).toBe(150000);
    expect(brackets![1].incomeTo).toBe(300000);
  });

  it("asOfDate ก่อนแถวแรกสุดที่มี → คืน null (ไม่ throw)", async () => {
    const { db } = makeInMemoryDb(tables);
    const brackets = await getEffectivePitBrackets(db, "2000-01-01");
    expect(brackets).toBeNull();
  });
});

describe("getEffectiveSsoConfig — รอยต่อ ค.ศ. 2025/2026 (พ.ศ. 2568/2569, 0.6)", () => {
  it("asOfDate ก่อน 2026-01-01 → ได้ ceiling 15,000 (แถวเก่า)", async () => {
    const { db } = makeInMemoryDb(tables);
    const cfg = await getEffectiveSsoConfig(db, "2025-12-31");
    expect(cfg?.wageCeiling).toBe(15000);
  });
  it("asOfDate = 2026-01-01 เป๊ะ → ได้ ceiling 17,500 (แถวใหม่ — เกณฑ์ ≤ รวมวันที่เปลี่ยนเอง)", async () => {
    const { db } = makeInMemoryDb(tables);
    const cfg = await getEffectiveSsoConfig(db, "2026-01-01");
    expect(cfg?.wageCeiling).toBe(17500);
  });
  it("asOfDate หลัง 2026-01-01 → ได้ ceiling 17,500", async () => {
    const { db } = makeInMemoryDb(tables);
    const cfg = await getEffectiveSsoConfig(db, "2027-06-15");
    expect(cfg?.wageCeiling).toBe(17500);
  });
  it("asOfDate ก่อนแถวแรกสุดที่มี (ก่อน 1997) → คืน null (ไม่ throw)", async () => {
    const { db } = makeInMemoryDb(tables);
    const cfg = await getEffectiveSsoConfig(db, "1990-01-01");
    expect(cfg).toBeNull();
  });
});
