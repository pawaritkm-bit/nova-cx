import { describe, it, expect } from "vitest";
import { saveWeightsSchema, slaRuleSchema, setMemberSchema, mapGroupSchema } from "@/lib/chat-admin/schema";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("saveWeightsSchema — น้ำหนัก 8 มิติ ต้องรวม = 100", () => {
  it("รวม = 100 พอดี → ผ่าน", () => {
    const w = { correctness: 20, completeness: 10, sla: 15, clarity: 10, politeness: 10, ownership: 15, resolution: 10, sop: 10 };
    expect(saveWeightsSchema.safeParse(w).success).toBe(true);
  });

  it("รวม != 100 → ไม่ผ่าน (มี error เรื่องรวม)", () => {
    const w = { correctness: 30, completeness: 10, sla: 15, clarity: 10, politeness: 10, ownership: 15, resolution: 10, sop: 10 };
    const r = saveWeightsSchema.safeParse(w);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /100/.test(i.message))).toBe(true);
  });

  it("รับค่าจาก string (form) แล้วรวม = 100 → ผ่าน", () => {
    const w = { correctness: "20", completeness: "10", sla: "15", clarity: "10", politeness: "10", ownership: "15", resolution: "10", sop: "10" };
    expect(saveWeightsSchema.safeParse(w).success).toBe(true);
  });

  it("ค่าติดลบ → ไม่ผ่าน", () => {
    const w = { correctness: -5, completeness: 15, sla: 15, clarity: 10, politeness: 10, ownership: 15, resolution: 15, sop: 25 };
    expect(saveWeightsSchema.safeParse(w).success).toBe(false);
  });
});

describe("slaRuleSchema", () => {
  it("ระบุชื่อ + เวลาอย่างน้อย 1 → ผ่าน (scope ว่าง = null)", () => {
    const r = slaRuleSchema.safeParse({
      name: "ขอเอกสาร", customer_type: "", urgency: "", work_type: "",
      first_response_minutes: "60", resolution_minutes: "", priority: "100", is_active: "on",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.customer_type).toBeNull();
      expect(r.data.urgency).toBeNull();
      expect(r.data.first_response_minutes).toBe(60);
      expect(r.data.resolution_minutes).toBeNull();
      expect(r.data.is_active).toBe(true);
    }
  });

  it("ไม่ระบุเวลาเลย → ไม่ผ่าน", () => {
    const r = slaRuleSchema.safeParse({ name: "x", first_response_minutes: "", resolution_minutes: "", priority: "100" });
    expect(r.success).toBe(false);
  });

  it("ชื่อว่าง → ไม่ผ่าน", () => {
    const r = slaRuleSchema.safeParse({ name: "  ", first_response_minutes: "30", priority: "100" });
    expect(r.success).toBe(false);
  });

  it("urgency นอก enum → ไม่ผ่าน", () => {
    const r = slaRuleSchema.safeParse({ name: "x", urgency: "superhot", first_response_minutes: "30", priority: "100" });
    expect(r.success).toBe(false);
  });
});

describe("setMemberSchema — บทบาทที่ไม่ใช่นักบัญชี/หัวหน้า ห้ามผูกพนักงาน", () => {
  it("accountant + employee_id → ผ่าน", () => {
    expect(setMemberSchema.safeParse({ chat_member_id: UUID, member_kind: "accountant", employee_id: UUID }).success).toBe(true);
  });
  it("customer + employee_id → ไม่ผ่าน (ขัดกัน)", () => {
    expect(setMemberSchema.safeParse({ chat_member_id: UUID, member_kind: "customer", employee_id: UUID }).success).toBe(false);
  });
  it("customer + ไม่มี employee → ผ่าน", () => {
    expect(setMemberSchema.safeParse({ chat_member_id: UUID, member_kind: "customer", employee_id: "" }).success).toBe(true);
  });
});

describe("mapGroupSchema — customer_id ว่าง = null (ยกเลิกจับคู่)", () => {
  it("ว่าง → customer_id null", () => {
    const r = mapGroupSchema.safeParse({ chat_group_id: UUID, customer_id: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.customer_id).toBeNull();
  });
  it("uuid → คงค่า", () => {
    const r = mapGroupSchema.safeParse({ chat_group_id: UUID, customer_id: UUID });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.customer_id).toBe(UUID);
  });
});
