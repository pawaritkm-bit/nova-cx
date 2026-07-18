/**
 * Static check — migration 0034 (conversation cases + SLA)
 *   รันได้ทันทีไม่ต้องมี DB: ตรวจ "เจตนา" ของ migration ที่รอบ reviewer สั่งแก้
 *     M3) RPC มี exception handler กัน race เปิดเคสครั้งแรก (unique_violation → re-select)
 *     security) exists-check ref ใน tenant + จำกัด INSERT audit/event ให้ service_role
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SQL = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0034_conversation_cases_sla.sql"),
  "utf8"
);
const CODE = SQL.split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .toLowerCase();

describe("migration 0034 — conversation cases + SLA", () => {
  it("M3: RPC มี exception handler กัน race (unique_violation → re-select)", () => {
    expect(CODE).toContain("exception when unique_violation then");
    // re-select เคส active หลังชน race (มี select ... for update ตอนต้น + re-select ใน handler)
    expect(CODE.match(/status in \('open','in_progress','waiting_customer','reopened'\)/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(3);
  });

  it("security: RPC nullify ref ที่ไม่อยู่ใน tenant (customer/owner/sla_rule)", () => {
    expect(CODE).toMatch(/from public\.customers where id = p_customer_id and tenant_id = p_tenant_id/);
    expect(CODE).toMatch(/from public\.employees where id = p_owner_employee_id and tenant_id = p_tenant_id/);
    expect(CODE).toMatch(/from public\.sla_rules where id = p_sla_rule_id and tenant_id = p_tenant_id/);
  });

  it("security: audit/event ตาราง — authenticated ได้แค่ SELECT (INSERT ผ่าน service_role)", () => {
    expect(CODE).toMatch(/grant select on public\.case_status_history\s+to authenticated/);
    expect(CODE).toMatch(/grant select on public\.sla_events\s+to authenticated/);
    // ต้องไม่ให้ insert/update/delete บนสองตารางนี้แก่ authenticated
    expect(CODE).not.toMatch(/grant select, insert, update, delete on public\.case_status_history/);
    expect(CODE).not.toMatch(/grant select, insert, update, delete on public\.sla_events/);
  });

  it("RLS + grant posture ครบ (revoke anon + tenant_isolation) สำหรับตารางใหม่", () => {
    for (const t of [
      "sla_rules",
      "conversation_cases",
      "case_messages",
      "case_status_history",
      "sla_events",
      "risk_alerts",
    ]) {
      expect(CODE).toMatch(new RegExp(`enable row level security`));
      expect(CODE).toMatch(new RegExp(`revoke all on public\\.${t}\\s+from anon`));
      expect(CODE).toMatch(new RegExp(`create policy tenant_isolation on public\\.${t}`));
    }
  });

  it("job_queue CHECK คง enum เดิม + เพิ่ม case_notification (เผื่ออนาคต)", () => {
    expect(CODE).toContain("'notification','ai_analysis','line_event','chat_analysis','case_notification'");
  });
});
