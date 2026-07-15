import { describe, it, expect } from "vitest";
import {
  shouldOpenCase,
  inferCaseType,
  computeSlaDueAt,
  addBusinessHours,
} from "@/lib/ai/case";

describe("case — shouldOpenCase", () => {
  it("critical/high → เปิดเคส", () => {
    expect(shouldOpenCase("critical")).toBe(true);
    expect(shouldOpenCase("high")).toBe(true);
  });
  it("medium/positive → ไม่เปิด", () => {
    expect(shouldOpenCase("medium")).toBe(false);
    expect(shouldOpenCase("positive")).toBe(false);
  });
});

describe("case — inferCaseType", () => {
  const empty = { summary: "", categories: [] as string[], customer_facts: [] as string[] };

  it("ยกเลิกบริการ → retention", () => {
    expect(
      inferCaseType({ ...empty, summary: "ลูกค้าจะยกเลิกบริการ" }, "A")
    ).toBe("retention");
  });
  it("ขอเปลี่ยนผู้ดูแล → reassign_request", () => {
    expect(
      inferCaseType({ ...empty, summary: "ขอเปลี่ยนนักบัญชีคนใหม่" }, "B")
    ).toBe("reassign_request");
  });
  it("ทั่วไป → complaint", () => {
    expect(
      inferCaseType({ ...empty, summary: "งานยื่นภาษีผิด" }, "A")
    ).toBe("complaint");
  });
});

describe("case — addBusinessHours (จ-ศ 9:00-18:00 เวลาไทย UTC+7)", () => {
  it("บวก 4 ชม.ในวันทำการ ไม่ล้นวัน", () => {
    // จันทร์ 10:00 เวลาไทย = 03:00Z (2026-07-13 เป็นวันจันทร์)
    const start = new Date("2026-07-13T03:00:00Z");
    const due = addBusinessHours(start, 4);
    // 14:00 ไทย = 07:00Z
    expect(due.toISOString()).toBe("2026-07-13T07:00:00.000Z");
  });

  it("บวกแล้วล้นเวลาทำการ → ต่อวันถัดไป", () => {
    // จันทร์ 16:00 ไทย = 09:00Z + 4 ชม. = เหลือ 2 ชม.จันทร์ (ถึง 18:00 ไทย) + 2 ชม.อังคาร
    //   → อังคาร 11:00 ไทย = 04:00Z
    const start = new Date("2026-07-13T09:00:00Z");
    const due = addBusinessHours(start, 4);
    expect(due.toISOString()).toBe("2026-07-14T04:00:00.000Z");
  });

  it("เริ่มนอกเวลาทำการ (ก่อน 9:00 ไทย) → เลื่อนเข้า 9:00 ไทย", () => {
    // จันทร์ 06:00 ไทย = 2026-07-12T23:00Z → clamp 09:00 ไทย, +1 = 10:00 ไทย = 03:00Z
    const start = new Date("2026-07-12T23:00:00Z");
    const due = addBusinessHours(start, 1);
    expect(due.toISOString()).toBe("2026-07-13T03:00:00.000Z");
  });

  it("เริ่มวันเสาร์ → ข้ามไปจันทร์", () => {
    // เสาร์ 10:00 ไทย = 2026-07-11T03:00Z → ข้ามไปจันทร์ 09:00 ไทย + 1 ชม. = 10:00 ไทย = 03:00Z
    const start = new Date("2026-07-11T03:00:00Z");
    const due = addBusinessHours(start, 1);
    expect(due.toISOString()).toBe("2026-07-13T03:00:00.000Z");
  });
});

describe("case — computeSlaDueAt (เวลาไทย)", () => {
  it("critical = +4 ชม.ทำการ", () => {
    // จันทร์ 10:00 ไทย = 03:00Z → +4 = 14:00 ไทย = 07:00Z
    const now = new Date("2026-07-13T03:00:00Z");
    expect(computeSlaDueAt("critical", now).toISOString()).toBe(
      "2026-07-13T07:00:00.000Z"
    );
  });
  it("high = สิ้นวันทำการ (18:00 ไทย) ของวันนั้น", () => {
    // จันทร์ 10:00 ไทย = 03:00Z → 18:00 ไทย = 11:00Z
    const now = new Date("2026-07-13T03:00:00Z");
    expect(computeSlaDueAt("high", now).toISOString()).toBe(
      "2026-07-13T11:00:00.000Z"
    );
  });
});
