import { describe, it, expect } from "vitest";
import { resolveHomePath, HOME_FALLBACK_PATH } from "@/lib/auth/home";
import { ROLE_CODES, type RoleCode } from "@/lib/dashboard/types";

/**
 * resolveHomePath — หน้าหลักหลัง login ตามบทบาท
 *   ยึดลำดับ: exec → team → me → risk → fallback(/dashboard)
 *   path ต้องตรงกับ allow-list ของหน้าออดิทนั้น (กันผู้ใช้ไปจบหน้าที่โดน redirect)
 */
describe("lib/auth/home — resolveHomePath", () => {
  const cases: Array<{ role: RoleCode; expected: string }> = [
    // privileged (เห็นภาพรวมทั้ง tenant) → หน้าออดิทภาพรวม
    { role: "admin", expected: "/chat-audit" },
    { role: "executive", expected: "/chat-audit" },
    { role: "auditor_qa", expected: "/chat-audit" },
    // หัวหน้าทีมบัญชี → หน้าออดิททีม (ต้องมาก่อน risk แม้ acc_lead เห็น risk ด้วย)
    { role: "acc_lead", expected: "/chat-audit/team" },
    // นักบัญชี → งานแชตของฉัน
    { role: "accountant", expected: "/chat-audit/me" },
    // cs → ลูกค้าเสี่ยง (ไม่เห็นแชตดิบ)
    { role: "cs", expected: "/chat-audit/risk" },
    // บทบาทที่ไม่มีหน้าออดิท → fallback หน้า CSAT เดิม
    { role: "hr", expected: "/dashboard" },
    { role: "sales", expected: "/dashboard" },
    { role: "sales_lead", expected: "/dashboard" },
  ];

  for (const { role, expected } of cases) {
    it(`${role} → ${expected}`, () => {
      expect(resolveHomePath(role)).toBe(expected);
    });
  }

  it("role null/undefined → fallback /dashboard (ไม่ค้าง/ไม่ throw)", () => {
    expect(resolveHomePath(null)).toBe(HOME_FALLBACK_PATH);
    expect(resolveHomePath(undefined)).toBe("/dashboard");
  });

  it("ทุกบทบาทใน ROLE_CODES คืน path ภายในเสมอ (ขึ้นต้น / และไม่ใช่ //)", () => {
    for (const role of ROLE_CODES) {
      const path = resolveHomePath(role);
      expect(path.startsWith("/"), `${role} → ${path}`).toBe(true);
      expect(path.startsWith("//")).toBe(false);
    }
  });
});
