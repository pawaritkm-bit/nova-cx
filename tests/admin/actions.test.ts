import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * เทสต์ server action `updateCustomerAction` (แก้ไขลูกค้ารายคน)
 *   - ยืนยัน guard (requireAdminContext) + inject tenant จาก session (ไม่เชื่อ client)
 *   - validate ด้วย zod ก่อนแตะ DB
 *   - map ค่าว่าง → null (เคลียร์ค่า) ส่งเข้า service ถูกต้อง
 * mock ชั้นล่าง (supabase/guard/service/next-cache) เพื่อทดสอบเฉพาะ logic ของ action
 */
const { updateCustomerMock, updateEmployeeMock, requireAdminContextMock } =
  vi.hoisted(() => ({
    updateCustomerMock: vi.fn(),
    updateEmployeeMock: vi.fn(),
    requireAdminContextMock: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ __authed: true })),
  createServiceRoleClient: vi.fn(() => ({ __service: true })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/admin/guard", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/admin/guard")>();
  return {
    ...actual,
    requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
  };
});

vi.mock("@/lib/admin/service", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/admin/service")>();
  return {
    ...actual,
    updateCustomer: (...args: unknown[]) => updateCustomerMock(...args),
    updateEmployee: (...args: unknown[]) => updateEmployeeMock(...args),
  };
});

import { updateCustomerAction, updateEmployeeAction } from "@/app/admin/actions";
import { AdminAuthError } from "@/lib/admin/guard";

const UUID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const UUID_E = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const UUID_TEAM = "aaaa1111-aaaa-1111-aaaa-111111111111";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminContextMock.mockResolvedValue({ tenantId: "tenant-9", role: "admin" });
  updateCustomerMock.mockResolvedValue(undefined);
  updateEmployeeMock.mockResolvedValue(undefined);
});

describe("updateCustomerAction", () => {
  it("สำเร็จ: เรียก updateCustomer ด้วย tenant จาก session + patch ถูกต้อง (ว่าง→null)", async () => {
    const res = await updateCustomerAction(
      null,
      fd({
        customerId: UUID,
        customer_code: "C-99",
        name: "บริษัท ใหม่",
        business_name: "",
        service_start_date: "",
      })
    );
    expect(res.ok).toBe(true);
    expect(updateCustomerMock).toHaveBeenCalledTimes(1);
    const [, tenantId, customerId, patch] = updateCustomerMock.mock.calls[0];
    expect(tenantId).toBe("tenant-9"); // ★ จาก session ไม่ใช่ client
    expect(customerId).toBe(UUID);
    expect(patch.customer_code).toBe("C-99");
    expect(patch.name).toBe("บริษัท ใหม่");
    expect(patch.business_name).toBeNull(); // ว่าง → null
    expect(patch.service_start_date).toBeNull();
  });

  it("ล้มเหลว: name ส่งมาแต่ว่าง → ไม่แตะ service", async () => {
    const res = await updateCustomerAction(null, fd({ customerId: UUID, name: "   " }));
    expect(res.ok).toBe(false);
    expect(updateCustomerMock).not.toHaveBeenCalled();
  });

  it("ล้มเหลว: customerId ไม่ใช่ uuid → validate ไม่ผ่าน", async () => {
    const res = await updateCustomerAction(null, fd({ customerId: "nope", name: "x" }));
    expect(res.ok).toBe(false);
    expect(updateCustomerMock).not.toHaveBeenCalled();
  });

  it("ไม่มีสิทธิ์ (guard throw) → คืน error สุภาพ ไม่แตะ service", async () => {
    requireAdminContextMock.mockRejectedValue(new AdminAuthError());
    const res = await updateCustomerAction(null, fd({ customerId: UUID, name: "x" }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/สิทธิ์/);
    expect(updateCustomerMock).not.toHaveBeenCalled();
  });
});

describe("updateEmployeeAction", () => {
  it("สำเร็จ: เรียก updateEmployee ด้วย tenant จาก session + patch ถูกต้อง (ว่าง→null, teamId)", async () => {
    const res = await updateEmployeeAction(
      null,
      fd({
        employeeId: UUID_E,
        first_name: "สมชาย ใหม่",
        nickname: "",
        position: "นักบัญชีอาวุโส",
        employee_type: "sales",
        teamId: UUID_TEAM,
      })
    );
    expect(res.ok).toBe(true);
    expect(updateEmployeeMock).toHaveBeenCalledTimes(1);
    const [, tenantId, employeeId, patch] = updateEmployeeMock.mock.calls[0];
    expect(tenantId).toBe("tenant-9"); // ★ จาก session ไม่ใช่ client
    expect(employeeId).toBe(UUID_E);
    expect(patch.first_name).toBe("สมชาย ใหม่");
    expect(patch.nickname).toBeNull(); // ว่าง → null
    expect(patch.position).toBe("นักบัญชีอาวุโส");
    expect(patch.employee_type).toBe("sales");
    expect(patch.teamId).toBe(UUID_TEAM);
  });

  it("teamId ว่าง (\"\") → null (เอาออกจากทีม)", async () => {
    const res = await updateEmployeeAction(
      null,
      fd({ employeeId: UUID_E, first_name: "x", teamId: "" })
    );
    expect(res.ok).toBe(true);
    const [, , , patch] = updateEmployeeMock.mock.calls[0];
    expect(patch.teamId).toBeNull();
  });

  it("ล้มเหลว: first_name ส่งมาแต่ว่าง → ไม่แตะ service", async () => {
    const res = await updateEmployeeAction(
      null,
      fd({ employeeId: UUID_E, first_name: "   " })
    );
    expect(res.ok).toBe(false);
    expect(updateEmployeeMock).not.toHaveBeenCalled();
  });

  it("ล้มเหลว: employeeId ไม่ใช่ uuid → validate ไม่ผ่าน", async () => {
    const res = await updateEmployeeAction(
      null,
      fd({ employeeId: "nope", first_name: "x" })
    );
    expect(res.ok).toBe(false);
    expect(updateEmployeeMock).not.toHaveBeenCalled();
  });

  it("ล้มเหลว: employee_type นอก enum → validate ไม่ผ่าน", async () => {
    const res = await updateEmployeeAction(
      null,
      fd({ employeeId: UUID_E, employee_type: "manager" })
    );
    expect(res.ok).toBe(false);
    expect(updateEmployeeMock).not.toHaveBeenCalled();
  });

  it("ไม่มีสิทธิ์ (guard throw) → คืน error สุภาพ ไม่แตะ service", async () => {
    requireAdminContextMock.mockRejectedValue(new AdminAuthError());
    const res = await updateEmployeeAction(
      null,
      fd({ employeeId: UUID_E, first_name: "x" })
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/สิทธิ์/);
    expect(updateEmployeeMock).not.toHaveBeenCalled();
  });
});
