import { describe, it, expect } from "vitest";
import {
  resolveStaffEmployeeByLineUserId,
  roleFromPosition,
  ACC_LEAD_POSITION,
} from "@/lib/staff/employee";
import { makeFakeDb, type ResolverArg } from "../helpers/fake-supabase";

/**
 * resolveStaffEmployeeByLineUserId — resolve LINE userId → พนักงาน (นักบัญชี active)
 *   ครอบคลุม: เจอนักบัญชี → คืน role/ชื่อ, position หัวหน้า → lead,
 *   ไม่เจอ → null, ไม่ใช่ employee_type accountant → null (default-deny), userId ว่าง → null
 */

function db(row: unknown) {
  return makeFakeDb((q: ResolverArg) => {
    if (q.table === "employees") return { data: row };
    return { data: null };
  }).db;
}

const base = {
  id: "emp-1",
  tenant_id: "t-1",
  first_name: "สมชาย ใจดี",
  nickname: "ชาย",
  position: null,
  employee_type: "accountant",
  is_active: true,
};

describe("roleFromPosition", () => {
  it("ตำแหน่งหัวหน้านักบัญชี → lead, อื่น ๆ → accountant", () => {
    expect(roleFromPosition(ACC_LEAD_POSITION)).toBe("lead");
    expect(roleFromPosition(" นักบัญชี ")).toBe("accountant");
    expect(roleFromPosition(null)).toBe("accountant");
  });
});

describe("resolveStaffEmployeeByLineUserId", () => {
  it("เจอนักบัญชี → คืน employeeId/tenantId/role/name (ชื่อเล่นก่อน)", async () => {
    const res = await resolveStaffEmployeeByLineUserId(db(base), "Uacc1");
    expect(res).toEqual({
      employeeId: "emp-1",
      tenantId: "t-1",
      role: "accountant",
      name: "ชาย",
    });
  });

  it("position = หัวหน้านักบัญชี → role lead", async () => {
    const res = await resolveStaffEmployeeByLineUserId(
      db({ ...base, nickname: null, position: ACC_LEAD_POSITION }),
      "Ulead"
    );
    expect(res?.role).toBe("lead");
    expect(res?.name).toBe("สมชาย ใจดี"); // ไม่มีชื่อเล่น → ชื่อจริง
  });

  it("ไม่เจอ (null) → null", async () => {
    expect(await resolveStaffEmployeeByLineUserId(db(null), "Uunknown")).toBeNull();
  });

  it("employee_type ไม่ใช่ accountant → null (default-deny)", async () => {
    const res = await resolveStaffEmployeeByLineUserId(
      db({ ...base, employee_type: "sales" }),
      "Usales"
    );
    expect(res).toBeNull();
  });

  it("userId ว่าง → null (ไม่ query)", async () => {
    expect(await resolveStaffEmployeeByLineUserId(db(base), "")).toBeNull();
  });
});
