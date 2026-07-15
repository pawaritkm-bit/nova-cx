import { describe, it, expect } from "vitest";
import {
  officeCycleDue,
  accountantCyclePeriod,
  schedulingIdempotencyKey,
  isCustomerServiceActive,
  customerBlockState,
  buildAssigneeSnapshot,
  fullMonthsBetween,
} from "@/lib/scheduling/eligibility";

const at = (iso: string) => new Date(iso);

describe("officeCycleDue — รอบสำนักงาน (A) ทุก 3 เดือน", () => {
  it("ยังไม่ถึงรอบแรก (ก่อนครบ 3 เดือน) → ไม่ due", () => {
    const r = officeCycleDue("2026-01-15", at("2026-03-14T00:00:00Z"));
    expect(r.due).toBe(false);
    if (!r.due) expect(r.reason).toBe("before_first_cycle");
  });

  it("ครบ 3 เดือนพอดี → due รอบที่ 1 (cyclePeriod = วันเริ่มรอบ)", () => {
    const r = officeCycleDue("2026-01-15", at("2026-04-15T09:00:00Z"));
    expect(r.due).toBe(true);
    if (r.due) {
      expect(r.cycleIndex).toBe(1);
      expect(r.cyclePeriod).toBe("A:2026-04-15");
      expect(r.cycleStartDate).toBe("2026-04-15");
    }
  });

  it("รอบที่ 2 (ครบ 6 เดือน) → cyclePeriod เลื่อนไปวันเริ่มรอบ 2", () => {
    const r = officeCycleDue("2026-01-15", at("2026-07-20T00:00:00Z"));
    expect(r.due).toBe(true);
    if (r.due) {
      expect(r.cycleIndex).toBe(2);
      expect(r.cyclePeriod).toBe("A:2026-07-15");
    }
  });

  it("cron พลาดหลายวัน → ยังชี้รอบล่าสุดเดิม (เก็บตกได้ ไม่สร้างรอบเก่าย้อนหลัง)", () => {
    const early = officeCycleDue("2026-01-15", at("2026-04-16T00:00:00Z"));
    const late = officeCycleDue("2026-01-15", at("2026-05-01T00:00:00Z"));
    expect(early.due && late.due).toBe(true);
    if (early.due && late.due) {
      expect(early.cyclePeriod).toBe(late.cyclePeriod); // idempotency key เท่ากัน
    }
  });

  it("ไม่มีวันเริ่มบริการ → ไม่ due", () => {
    const r = officeCycleDue(null, at("2026-07-01T00:00:00Z"));
    expect(r.due).toBe(false);
    if (!r.due) expect(r.reason).toBe("no_service_start");
  });

  it("clamp วันสิ้นเดือน: เริ่ม 30 พ.ย. → รอบครบ 3 เดือน (ก.พ.) ไม่ overflow", () => {
    const r = officeCycleDue("2025-11-30", at("2026-03-05T00:00:00Z"));
    expect(r.due).toBe(true);
    if (r.due) expect(r.cyclePeriod).toBe("A:2026-02-28");
  });
});

describe("fullMonthsBetween", () => {
  it("นับเดือนเต็มตามปฏิทิน (ยังไม่ถึงวันเดียวกัน = ยังไม่ครบเดือน)", () => {
    expect(fullMonthsBetween(at("2026-01-15"), at("2026-04-14"))).toBe(2);
    expect(fullMonthsBetween(at("2026-01-15"), at("2026-04-15"))).toBe(3);
  });
});

describe("accountantCyclePeriod — รอบนักบัญชี (B) รายเดือน", () => {
  it("bucket ตามเดือนปฏิทิน (ต้นเดือน/ปลายเดือนอยู่รอบเดียวกัน)", () => {
    expect(accountantCyclePeriod(at("2026-07-01T00:00:00Z"))).toBe("B:2026-07");
    expect(accountantCyclePeriod(at("2026-07-31T23:00:00Z"))).toBe("B:2026-07");
    expect(accountantCyclePeriod(at("2026-12-05T00:00:00Z"))).toBe("B:2026-12");
  });
});

describe("schedulingIdempotencyKey", () => {
  it("deterministic ตาม (customer, type, period)", () => {
    const a = schedulingIdempotencyKey("cust-1", "A", "A:2026-04-15");
    const b = schedulingIdempotencyKey("cust-1", "A", "A:2026-04-15");
    expect(a).toBe(b);
    expect(a.startsWith("sched:")).toBe(true);
  });

  it("ต่าง customer/type/period → key ต่างกัน", () => {
    const base = schedulingIdempotencyKey("cust-1", "A", "A:2026-04-15");
    expect(schedulingIdempotencyKey("cust-2", "A", "A:2026-04-15")).not.toBe(base);
    expect(schedulingIdempotencyKey("cust-1", "B", "A:2026-04-15")).not.toBe(base);
    expect(schedulingIdempotencyKey("cust-1", "A", "A:2026-07-15")).not.toBe(base);
  });
});

describe("stop conditions", () => {
  it("isCustomerServiceActive: active + ไม่ลบ = true; cancelled/ลบ = false", () => {
    expect(isCustomerServiceActive("active", null)).toBe(true);
    expect(isCustomerServiceActive("cancelled", null)).toBe(false);
    expect(isCustomerServiceActive("active", "2026-07-01")).toBe(false);
  });

  it("customerBlockState: ไม่มีบัญชี=no_link, บล็อกหมด=blocked, มีที่ส่งได้=reachable", () => {
    expect(customerBlockState([])).toBe("no_link");
    expect(customerBlockState([{ is_blocked: true }])).toBe("blocked");
    expect(
      customerBlockState([{ is_blocked: true }, { is_blocked: false }])
    ).toBe("reachable");
  });
});

describe("buildAssigneeSnapshot — snapshot ผู้ดูแล ณ ตอน trigger", () => {
  it("map role→subject_role + enrich ชื่อจาก employees", () => {
    const snap = buildAssigneeSnapshot(
      [
        { employee_id: "e1", role: "lead" },
        { employee_id: "e2", role: "member" },
      ],
      [
        { id: "e1", first_name: "สมชาย", nickname: "ชาย", position: "หัวหน้าทีม" },
        { id: "e2", first_name: "สมหญิง", nickname: null, position: null },
      ]
    );
    expect(snap).toEqual([
      {
        employee_id: "e1",
        subject_role: "lead",
        name: "สมชาย",
        nickname: "ชาย",
        position: "หัวหน้าทีม",
      },
      { employee_id: "e2", subject_role: "member", name: "สมหญิง" },
    ]);
  });

  it("dedupe employee_id ซ้ำ (คงตัวแรก)", () => {
    const snap = buildAssigneeSnapshot([
      { employee_id: "e1", role: "lead" },
      { employee_id: "e1", role: "member" },
    ]);
    expect(snap).toHaveLength(1);
    expect(snap[0]).toEqual({ employee_id: "e1", subject_role: "lead" });
  });

  it("role อื่น/ว่าง → member (ค่าปลอดภัย)", () => {
    const snap = buildAssigneeSnapshot([
      { employee_id: "e1", role: "coordinator" },
      { employee_id: "e2", role: null },
    ]);
    expect(snap.map((s) => s.subject_role)).toEqual(["member", "member"]);
  });
});
