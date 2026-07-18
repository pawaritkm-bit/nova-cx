/**
 * Static check — migration 0035 (accountant evaluation + coaching)
 *   รันได้ทันทีไม่ต้องมี DB: ตรวจ "เจตนา" ความปลอดภัย/ครบถ้วนของ migration
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SQL = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0035_accountant_evaluation.sql"),
  "utf8"
);
const CODE = SQL.split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .toLowerCase();

const TABLES = [
  "evaluation_weights",
  "accountant_evaluations",
  "evaluation_evidence",
  "manager_reviews",
  "coaching_recommendations",
  "evaluation_appeals",
];

describe("migration 0035 — โครงสร้างครบ", () => {
  it("สร้างครบ 6 ตาราง", () => {
    for (const t of TABLES) {
      expect(CODE).toMatch(new RegExp(`create table if not exists public\\.${t}`));
    }
  });

  it("ไม่แตะ employee_evaluations (0007) เชิงทำลาย", () => {
    expect(CODE).not.toContain("drop table public.employee_evaluations");
    expect(CODE).not.toContain("alter table public.employee_evaluations");
  });

  it("job_queue CHECK คงค่าเดิม + เพิ่ม evaluation", () => {
    expect(CODE).toContain(
      "'notification','ai_analysis','line_event','chat_analysis',\n                   'case_notification','evaluation'"
    );
  });
});

describe("migration 0035 — RLS tier (★ accountant เห็นเฉพาะตัวเอง)", () => {
  it("enable RLS + revoke anon ทุกตาราง", () => {
    for (const t of TABLES) {
      expect(CODE).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
      expect(CODE).toMatch(new RegExp(`revoke all on public\\.${t}\\s+from anon`));
    }
  });

  it("accountant_evaluations : SELECT policy ผูก can_view_accountant_eval(employee_id, status)", () => {
    expect(CODE).toMatch(
      /create policy tier_read on public\.accountant_evaluations for select/
    );
    expect(CODE).toContain("public.can_view_accountant_eval(employee_id, status)");
  });

  it("helper can_view_accountant_eval : accountant = เฉพาะ employee ตัวเอง; hr = เฉพาะ confirmed", () => {
    expect(CODE).toContain("p_employee_id = public.current_employee_id()");
    expect(CODE).toMatch(/current_role_code\(\) = 'hr'/);
    expect(CODE).toContain("'manager_confirmed','manager_edited','appeal_resolved'");
  });

  it("★ evidence : hr ถูกตัด (can_view_eval_evidence ไม่มี hr) + policy ผูก eval แม่", () => {
    // can_view_eval_evidence ต้องไม่มีเงื่อนไข hr (ต่างจาก can_view_accountant_eval)
    const fn = CODE.split("can_view_eval_evidence")[2] ?? ""; // body ของ function
    expect(fn.includes("'hr'")).toBe(false);
    expect(CODE).toMatch(/create policy tier_read on public\.evaluation_evidence for select/);
  });

  it("acc_lead : is_eval_team_lead_of ผูก team_members + teams.lead_employee_id", () => {
    expect(CODE).toContain("is_eval_team_lead_of");
    expect(CODE).toMatch(/current_role_code\(\) = 'acc_lead'/);
    expect(CODE).toContain("t.lead_employee_id = public.current_employee_id()");
  });
});

describe("migration 0035 — GRANT posture (write ผ่าน service_role เท่านั้น)", () => {
  it("authenticated ได้แค่ SELECT (ไม่มี insert/update/delete ให้ client)", () => {
    for (const t of TABLES) {
      expect(CODE).toMatch(new RegExp(`grant select on public\\.${t}\\s+to authenticated`));
      expect(CODE).not.toMatch(
        new RegExp(`grant select, insert, update, delete on public\\.${t}`)
      );
    }
  });
  it("service_role ได้ all ทุกตาราง", () => {
    for (const t of TABLES) {
      expect(CODE).toMatch(new RegExp(`grant all on public\\.${t}\\s+to service_role`));
    }
  });
});

describe("migration 0035 — น้ำหนักรวม = 100 (constraint)", () => {
  it("CHECK eval_weight_total(weights) = 100", () => {
    expect(CODE).toContain("check (public.eval_weight_total(weights) = 100)");
  });
  it("default weights รวม = 100 (20+10+15+10+10+15+10+10)", () => {
    expect(CODE).toContain('"correctness":20');
    expect(CODE).toContain('"sla":15');
    expect(CODE).toContain('"ownership":15');
  });
});

describe("migration 0035 — RPC atomic + ★ audit ทุกการเปลี่ยนคะแนน", () => {
  it("มี RPC ครบ 4 ตัว (persist/review/appeal submit/resolve) + execute เฉพาะ service_role", () => {
    for (const fn of [
      "persist_accountant_evaluation",
      "record_manager_review",
      "submit_evaluation_appeal",
      "resolve_evaluation_appeal",
    ]) {
      expect(CODE).toContain(`function public.${fn}`);
      expect(CODE).toMatch(new RegExp(`grant execute on function public\\.${fn}`));
      expect(CODE).toMatch(new RegExp(`revoke all on function public\\.${fn}`));
    }
  });

  it("★ ทุก RPC ที่เปลี่ยนคะแนน/สถานะ insert audit_logs", () => {
    // นับจำนวน insert into audit_logs — persist(1) + review(1) + submit(1) + resolve(1) = 4
    const count = (CODE.match(/insert into public\.audit_logs/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it("★ persist บังคับ status='ai_draft' + needs_review=true (ห้ามลงโทษอัตโนมัติ)", () => {
    expect(CODE).toContain("'ai_draft', true");
  });

  it("review confirm→manager_confirmed / edit→manager_edited / reject→rejected", () => {
    expect(CODE).toContain("when 'confirm' then 'manager_confirmed'");
    expect(CODE).toContain("when 'edit'    then 'manager_edited'");
  });

  it("submit_appeal : เฉพาะเจ้าของ (owner check) + ต้อง confirmed/edited", () => {
    expect(CODE).toContain("v_owner <> p_employee_id");
    expect(CODE).toContain("not_evaluation_owner");
    expect(CODE).toContain("'manager_confirmed','manager_edited'");
  });

  it("★ record_manager_review : status guard (บล็อก appealed/resolved/rejected)", () => {
    expect(CODE).toContain("evaluation_not_reviewable");
    // อนุญาตเฉพาะ 3 สถานะ
    expect(CODE).toMatch(
      /v_old_status not in \('ai_draft','manager_confirmed','manager_edited'\)/
    );
  });

  it("★ RPC defense-in-depth : reviewer/resolver ต้องอยู่ใน tenant เดียวกัน", () => {
    expect(CODE).toContain("reviewer_not_in_tenant");
    expect(CODE).toContain("resolver_not_in_tenant");
    expect(CODE).toMatch(
      /from public\.employees where id = p_reviewer_emp_id and tenant_id = p_tenant_id/
    );
  });

  it("★ L2 : validate adjusted_dimension_scores อยู่ 0-100 (eval_dimension_scores_valid)", () => {
    expect(CODE).toContain("eval_dimension_scores_valid");
    expect(CODE).toContain("dimension_score_out_of_range");
    // ใช้ทั้งใน review และ resolve
    expect((CODE.match(/eval_dimension_scores_valid/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("RPC เป็น SECURITY DEFINER + fixed search_path (กัน hijack)", () => {
    const count = (CODE.match(/security definer/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(4 + 4); // 4 RPC + 4 helper
    expect(CODE).toContain("set search_path = public, pg_temp");
  });
});

describe("migration 0035 — idempotency", () => {
  it("unique index กัน draft ซ้ำต่อเคส + ต่อช่วง", () => {
    expect(CODE).toContain("uq_acc_eval_draft_case");
    expect(CODE).toContain("uq_acc_eval_draft_period");
  });
  it("unique index กัน job evaluation ซ้อนต่อเคส", () => {
    expect(CODE).toContain("uq_job_queue_evaluation_active");
  });
  it("manager_reviews append-only (prevent_update_delete)", () => {
    expect(CODE).toMatch(/trg_mgr_review_immutable.*prevent_update_delete/s);
  });
});
