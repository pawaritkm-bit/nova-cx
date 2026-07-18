import { describe, it, expect } from "vitest";
import { businessMinutesBetween, toHolidaySet } from "@/lib/evaluation/business-hours";

/**
 * เวลาไทย = UTC+7. เวลาทำการ จ–ศ 9:00–18:00 (ไทย)
 *   09:00 ไทย = 02:00Z ; 18:00 ไทย = 11:00Z
 */
describe("businessMinutesBetween — นับเฉพาะเวลาทำการ (กันโทษนอกเวลา/วันหยุด)", () => {
  it("ภายในวันทำการเดียว: 10:00→11:30 ไทย = 90 นาที", () => {
    const start = new Date("2026-07-20T03:00:00Z"); // จันทร์ 10:00 ไทย
    const end = new Date("2026-07-20T04:30:00Z"); // จันทร์ 11:30 ไทย
    expect(businessMinutesBetween(start, end)).toBe(90);
  });

  it("★ ข้ามสุดสัปดาห์ไม่ถูกนับ: ศุกร์ 17:30 → จันทร์ 9:30 = 60 นาที", () => {
    // ศุกร์ 2026-07-24 17:30 ไทย = 10:30Z ; จันทร์ 2026-07-27 09:30 ไทย = 02:30Z
    const fri = new Date("2026-07-24T10:30:00Z");
    const mon = new Date("2026-07-27T02:30:00Z");
    // ศุกร์ 17:30–18:00 = 30 + จันทร์ 9:00–9:30 = 30 = 60 (ไม่นับ ส.–อา.)
    expect(businessMinutesBetween(fri, mon)).toBe(60);
  });

  it("★ ตอบนอกเวลางาน (กลางคืน) ไม่ถูกนับเป็นเวลาช้า", () => {
    // ลูกค้าทัก 20:00 ไทย (13:00Z) นักบัญชีตอบ 21:00 ไทย (14:00Z) — นอกเวลาทำการทั้งคู่
    const req = new Date("2026-07-20T13:00:00Z");
    const reply = new Date("2026-07-20T14:00:00Z");
    expect(businessMinutesBetween(req, reply)).toBe(0);
  });

  it("★ วันหยุด/วันลา ถูกยกเว้น: อังคารเป็นวันหยุด → จันทร์ 17:00 → พุธ 10:00 = 60+60", () => {
    // จันทร์ 2026-07-20 17:00 ไทย (10:00Z) → พุธ 2026-07-22 10:00 ไทย (03:00Z)
    // ปกติ = จันทร์ 17–18(60) + อังคาร 9–18(540) + พุธ 9–10(60) = 660
    // ถ้าอังคารเป็นวันหยุด → 60 + 60 = 120
    const mon = new Date("2026-07-20T10:00:00Z");
    const wed = new Date("2026-07-22T03:00:00Z");
    const holidays = toHolidaySet(["2026-07-21"]); // อังคาร
    expect(businessMinutesBetween(mon, wed, holidays)).toBe(120);
  });

  it("end <= start → 0", () => {
    const t = new Date("2026-07-20T03:00:00Z");
    expect(businessMinutesBetween(t, t)).toBe(0);
    expect(businessMinutesBetween(t, new Date("2026-07-20T02:00:00Z"))).toBe(0);
  });

  it("ก่อนเวลาเปิด → นับจาก 9:00: 7:00→10:00 ไทย = 60 นาที", () => {
    const before = new Date("2026-07-20T00:00:00Z"); // จันทร์ 7:00 ไทย
    const at10 = new Date("2026-07-20T03:00:00Z"); // จันทร์ 10:00 ไทย
    expect(businessMinutesBetween(before, at10)).toBe(60);
  });
});
