import { describe, it, expect } from "vitest";
import {
  createTeamSchema,
  createEmployeeSchema,
  createCustomerSchema,
  updateCustomerSchema,
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
  it("handles_customer_type ว่าง → undefined (ดูแลทั้งสองประเภท)", () => {
    const r = createTeamSchema.safeParse({
      name: "ทีม",
      type: "accounting",
      handles_customer_type: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.handles_customer_type).toBeUndefined();
  });
  it("handles_customer_type = company → ผ่าน", () => {
    const r = createTeamSchema.safeParse({
      name: "ทีม",
      type: "accounting",
      handles_customer_type: "company",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.handles_customer_type).toBe("company");
  });
  it("ล้มเหลว: handles_customer_type นอก enum", () => {
    const r = createTeamSchema.safeParse({
      name: "ทีม",
      type: "accounting",
      handles_customer_type: "vip",
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
  it("customer_type ว่าง → undefined (ยังไม่จัดประเภท)", () => {
    const r = createCustomerSchema.safeParse({ name: "x", customer_type: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.customer_type).toBeUndefined();
  });
  it("customer_type = individual → ผ่าน", () => {
    const r = createCustomerSchema.safeParse({
      name: "x",
      customer_type: "individual",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.customer_type).toBe("individual");
  });
  it("ล้มเหลว: customer_type นอก enum", () => {
    const r = createCustomerSchema.safeParse({ name: "x", customer_type: "vip" });
    expect(r.success).toBe(false);
  });
});

describe("updateCustomerSchema", () => {
  it("ผ่าน: ครบทุกฟิลด์ถูกต้อง", () => {
    const r = updateCustomerSchema.safeParse({
      customerId: UUID,
      customer_code: "C-001",
      name: "บริษัท ก",
      business_name: "ร้าน ก",
      service_start_date: "2026-01-15",
    });
    expect(r.success).toBe(true);
  });
  it("customer_code ว่าง → null (เคลียร์ค่า)", () => {
    const r = updateCustomerSchema.safeParse({
      customerId: UUID,
      customer_code: "   ",
      name: "x",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.customer_code).toBeNull();
  });
  it("service_start_date ว่าง → null", () => {
    const r = updateCustomerSchema.safeParse({
      customerId: UUID,
      name: "x",
      service_start_date: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.service_start_date).toBeNull();
  });
  it("ล้มเหลว: name ส่งมาแต่ว่าง", () => {
    const r = updateCustomerSchema.safeParse({ customerId: UUID, name: "   " });
    expect(r.success).toBe(false);
  });
  it("name ไม่ส่ง (undefined) → optional ผ่าน", () => {
    const r = updateCustomerSchema.safeParse({ customerId: UUID, customer_code: "C-2" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBeUndefined();
  });
  it("ล้มเหลว: customerId ไม่ใช่ uuid", () => {
    const r = updateCustomerSchema.safeParse({ customerId: "nope", name: "x" });
    expect(r.success).toBe(false);
  });
  it("ล้มเหลว: วันที่ผิดรูปแบบ", () => {
    const r = updateCustomerSchema.safeParse({
      customerId: UUID,
      name: "x",
      service_start_date: "15/01/2026",
    });
    expect(r.success).toBe(false);
  });
  it("customer_type ว่าง → null (เคลียร์เป็นยังไม่ระบุ)", () => {
    const r = updateCustomerSchema.safeParse({
      customerId: UUID,
      name: "x",
      customer_type: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.customer_type).toBeNull();
  });
  it("customer_type = company → ผ่าน", () => {
    const r = updateCustomerSchema.safeParse({
      customerId: UUID,
      customer_type: "company",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.customer_type).toBe("company");
  });
  it("ล้มเหลว: customer_type นอก enum", () => {
    const r = updateCustomerSchema.safeParse({
      customerId: UUID,
      customer_type: "vip",
    });
    expect(r.success).toBe(false);
  });
});

describe("createAssignmentSchema (มอบหมายผ่านกลุ่มแชต — customer + employee เท่านั้น)", () => {
  it("ผ่าน: customer+employee uuid (ไม่มี role/team แล้ว)", () => {
    const r = createAssignmentSchema.safeParse({
      customer_id: UUID,
      employee_id: UUID,
    });
    expect(r.success).toBe(true);
  });
  it("ผ่าน: มี key ส่วนเกิน (role/team) ถูกละเว้น ไม่ทำให้ fail", () => {
    const r = createAssignmentSchema.safeParse({
      customer_id: UUID,
      employee_id: UUID,
      role: "boss",
      team_id: "x",
    });
    expect(r.success).toBe(true);
  });
  it("ล้มเหลว: customer_id ไม่ใช่ uuid", () => {
    const r = createAssignmentSchema.safeParse({
      customer_id: "nope",
      employee_id: UUID,
    });
    expect(r.success).toBe(false);
  });
  it("ล้มเหลว: employee_id ไม่ใช่ uuid", () => {
    const r = createAssignmentSchema.safeParse({
      customer_id: UUID,
      employee_id: "nope",
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
