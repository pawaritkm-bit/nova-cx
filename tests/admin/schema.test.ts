import { describe, it, expect } from "vitest";
import {
  createTeamSchema,
  createEmployeeSchema,
  createCustomerSchema,
  createAssignmentSchema,
  firstZodError,
} from "@/lib/admin/schema";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("createTeamSchema", () => {
  it("ผ่าน: ชื่อ+ประเภท (lead ว่าง → undefined)", () => {
    const r = createTeamSchema.safeParse({
      name: "ทีมบัญชี A",
      type: "accounting",
      lead_employee_id: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lead_employee_id).toBeUndefined();
  });
  it("ล้มเหลว: ชื่อว่าง", () => {
    const r = createTeamSchema.safeParse({ name: "   ", type: "accounting" });
    expect(r.success).toBe(false);
  });
  it("ล้มเหลว: ประเภทนอก enum", () => {
    const r = createTeamSchema.safeParse({ name: "x", type: "marketing" });
    expect(r.success).toBe(false);
  });
  it("ล้มเหลว: lead_employee_id ไม่ใช่ uuid", () => {
    const r = createTeamSchema.safeParse({
      name: "x",
      type: "sales",
      lead_employee_id: "abc",
    });
    expect(r.success).toBe(false);
  });
});

describe("createEmployeeSchema", () => {
  it("ผ่าน: is_active จาก 'on' → true, ฟิลด์ว่าง → undefined", () => {
    const r = createEmployeeSchema.safeParse({
      first_name: "สมชาย ใจดี",
      nickname: "",
      position: "",
      employee_type: "accountant",
      is_active: "on",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.is_active).toBe(true);
      expect(r.data.nickname).toBeUndefined();
    }
  });
  it("is_active undefined (ไม่ติ๊ก) → false", () => {
    const r = createEmployeeSchema.safeParse({
      first_name: "x",
      employee_type: "sales",
      is_active: undefined,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.is_active).toBe(false);
  });
  it("ล้มเหลว: employee_type นอก enum", () => {
    const r = createEmployeeSchema.safeParse({
      first_name: "x",
      employee_type: "manager",
      is_active: "on",
    });
    expect(r.success).toBe(false);
  });
});

describe("createCustomerSchema", () => {
  it("ผ่าน: ชื่อ + วันที่ถูกรูปแบบ", () => {
    const r = createCustomerSchema.safeParse({
      customer_code: "C-001",
      name: "บริษัท ก",
      business_name: "",
      service_start_date: "2026-01-15",
    });
    expect(r.success).toBe(true);
  });
  it("ล้มเหลว: วันที่ผิดรูปแบบ", () => {
    const r = createCustomerSchema.safeParse({
      name: "x",
      service_start_date: "15/01/2026",
    });
    expect(r.success).toBe(false);
  });
  it("ล้มเหลว: ชื่อว่าง", () => {
    const r = createCustomerSchema.safeParse({ name: "" });
    expect(r.success).toBe(false);
  });
});

describe("createAssignmentSchema", () => {
  it("ผ่าน: customer+employee uuid + role", () => {
    const r = createAssignmentSchema.safeParse({
      customer_id: UUID,
      employee_id: UUID,
      role: "member",
      team_id: "",
    });
    expect(r.success).toBe(true);
  });
  it("ล้มเหลว: customer_id ไม่ใช่ uuid", () => {
    const r = createAssignmentSchema.safeParse({
      customer_id: "nope",
      employee_id: UUID,
      role: "member",
    });
    expect(r.success).toBe(false);
  });
  it("ล้มเหลว: role นอก enum", () => {
    const r = createAssignmentSchema.safeParse({
      customer_id: UUID,
      employee_id: UUID,
      role: "boss",
    });
    expect(r.success).toBe(false);
  });
});

describe("firstZodError", () => {
  it("คืนข้อความ error แรก", () => {
    const r = createTeamSchema.safeParse({ name: "", type: "accounting" });
    expect(r.success).toBe(false);
    if (!r.success) expect(firstZodError(r.error)).toContain("ชื่อทีม");
  });
});
