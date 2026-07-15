/**
 * Static check — migration 0027 (pseudonymity column grants + cs case access)
 *   รันได้ทันทีไม่ต้องมี DB: ตรวจ "เจตนา" ของ migration ว่าครบตามงาน A/B
 *     A) REVOKE SELECT(customer_id, invitation_id) บน survey_responses จาก authenticated
 *        (ปิด base-table linkage: response_id → ลูกค้า)
 *     B) v_dashboard_case_facts เปิดให้ cs (is_privileged() OR current_role_code()='cs')
 *        แต่ "ไม่แตะ" v_dashboard_response_facts (คง privileged-only)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SQL = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0027_pseudonymity_column_grants.sql"),
  "utf8"
);
// normalize ช่องว่างให้ match ง่าย (ตัด comment ที่ขึ้นต้น -- ออกทั้งบรรทัด)
const CODE = SQL.split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .toLowerCase();

describe("migration 0027 — pseudonymity column grants", () => {
  it("A: revoke select(customer_id) บน survey_responses จาก authenticated", () => {
    expect(CODE).toMatch(
      /revoke\s+select\s*\(\s*customer_id\s*\)\s+on\s+public\.survey_responses\s+from\s+authenticated/
    );
  });

  it("A: revoke select(invitation_id) บน survey_responses จาก authenticated (กัน hop → survey_invitations)", () => {
    expect(CODE).toMatch(
      /revoke\s+select\s*\(\s*invitation_id\s*\)\s+on\s+public\.survey_responses\s+from\s+authenticated/
    );
  });

  it("A: ไม่ revoke ทั้งตาราง (คงคอลัมน์ไม่โยงตัวตนไว้ — ไม่ over-revoke)", () => {
    // ต้องไม่มี revoke select บนทั้งตารางแบบไม่ระบุคอลัมน์
    expect(CODE).not.toMatch(
      /revoke\s+select\s+on\s+public\.survey_responses\s+from\s+authenticated/
    );
  });

  it("B: v_dashboard_case_facts เปิดให้ cs ด้วย current_role_code()='cs'", () => {
    expect(CODE).toContain("create or replace view public.v_dashboard_case_facts");
    expect(CODE).toMatch(/is_privileged\(\)\s+or\s+public\.current_role_code\(\)\s*=\s*'cs'/);
  });

  it("B: ไม่แตะ v_dashboard_response_facts (คง privileged-only ในไฟล์นี้)", () => {
    expect(CODE).not.toContain("v_dashboard_response_facts");
  });

  it("B: ไม่เปิดทางลูกค้าให้ member ผ่าน can_access_customer ใน case_facts", () => {
    expect(CODE).not.toContain("can_access_customer");
  });
});
