import { describe, it, expect } from "vitest";
import {
  customerInScope,
  assertCustomerInScope,
  AccountingAuthError,
  type AccountingAccess,
} from "@/lib/accounting/access";

/**
 * access scope — ชั้นบังคับ "นักบัญชีเห็น/แก้ได้เฉพาะลูกค้าตัวเอง, admin/lead เห็นทั้งหมด"
 *   ★ นี่คือหัวใจความปลอดภัยของงาน (server-side enforce)
 */

function accountant(ids: string[]): AccountingAccess {
  return {
    tenantId: "t-1",
    mode: "accountant",
    employeeId: "emp-1",
    name: "ชาย",
    allowedCustomerIds: new Set(ids),
    navRole: "accountant",
  };
}

function admin(): AccountingAccess {
  return {
    tenantId: "t-1",
    mode: "admin",
    employeeId: null,
    name: null,
    allowedCustomerIds: null,
    navRole: "admin",
  };
}

describe("customerInScope", () => {
  it("นักบัญชี: จริงเฉพาะลูกค้าในชุดที่ดูแล", () => {
    const a = accountant(["c1", "c2"]);
    expect(customerInScope(a, "c1")).toBe(true);
    expect(customerInScope(a, "c3")).toBe(false); // ลูกค้าคนอื่น
  });

  it("นักบัญชี: ลูกค้า null (unassigned) → เท็จ (ห้ามแตะ)", () => {
    expect(customerInScope(accountant(["c1"]), null)).toBe(false);
  });

  it("admin/lead (allowedCustomerIds=null): จริงเสมอ รวม unassigned", () => {
    expect(customerInScope(admin(), "c99")).toBe(true);
    expect(customerInScope(admin(), null)).toBe(true);
  });
});

describe("assertCustomerInScope", () => {
  it("นอกสโคป → โยน AccountingAuthError", () => {
    expect(() => assertCustomerInScope(accountant(["c1"]), "c2")).toThrow(AccountingAuthError);
    expect(() => assertCustomerInScope(accountant(["c1"]), null)).toThrow(AccountingAuthError);
  });

  it("ในสโคป / admin → ไม่โยน", () => {
    expect(() => assertCustomerInScope(accountant(["c1"]), "c1")).not.toThrow();
    expect(() => assertCustomerInScope(admin(), "cX")).not.toThrow();
  });
});
