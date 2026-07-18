import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  openCaseFromChatAnalysis,
  shouldOpenChatCase,
  chatCaseLevel,
  type ChatAnalysisForCase,
} from "@/lib/sla/case-open";
import { resolveCaseOwner, resolveTeamLead } from "@/lib/sla/owner";

/* ---------- Fake DB (chainable + thenable) + rpc ---------- */

type Store = {
  data: Record<string, unknown[]>;
  rpcCalls: { name: string; params: Record<string, unknown> }[];
  rpcResult?: { data: unknown; error: unknown };
};

class QB {
  private filters: Record<string, unknown> = {};
  private wantSingle = false;
  constructor(private table: string, private store: Store) {}
  select() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters[col] = val;
    return this;
  }
  is() {
    return this;
  }
  lte() {
    return this;
  }
  in() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  maybeSingle() {
    this.wantSingle = true;
    return this;
  }
  private rows(): unknown[] {
    const all = (this.store.data[this.table] ?? []) as Record<string, unknown>[];
    // กรองตาม eq filter แบบง่าย ๆ (คอลัมน์ที่มีใน row)
    return all.filter((r) =>
      Object.entries(this.filters).every(([k, v]) => !(k in r) || r[k] === v)
    );
  }
  private result() {
    const rows = this.rows();
    if (this.wantSingle) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
  then<T>(onF: (v: { data: unknown; error: unknown }) => T) {
    return Promise.resolve(this.result()).then(onF);
  }
}

function makeDb(store: Store): SupabaseClient {
  return {
    from(table: string) {
      return new QB(table, store);
    },
    async rpc(name: string, params: Record<string, unknown>) {
      store.rpcCalls.push({ name, params });
      return store.rpcResult ?? { data: { case_id: "case-1", created: true }, error: null };
    },
  } as unknown as SupabaseClient;
}

const NOW = new Date("2026-07-20T03:00:00Z"); // จันทร์ 10:00 ไทย

function analysis(overrides: Partial<ChatAnalysisForCase> = {}): ChatAnalysisForCase {
  return {
    urgency: "high",
    sentiment: "negative",
    summary: "ลูกค้าขอด่วน แจ้งปัญหายื่นภาษีช้า",
    problems: [{ type: "slow_reply" }],
    insufficient_data: false,
    ...overrides,
  };
}

describe("shouldOpenChatCase / chatCaseLevel", () => {
  it("urgency critical/high → เปิดเคส", () => {
    expect(shouldOpenChatCase(analysis({ urgency: "critical" }))).toBe(true);
    expect(shouldOpenChatCase(analysis({ urgency: "high" }))).toBe(true);
  });
  it("medium + ปัญหา + ลบ → เปิดเคส", () => {
    expect(shouldOpenChatCase(analysis({ urgency: "medium" }))).toBe(true);
  });
  it("medium ไม่มีปัญหา/ไม่ลบ → ไม่เปิด", () => {
    expect(
      shouldOpenChatCase(analysis({ urgency: "medium", problems: [], sentiment: "neutral" }))
    ).toBe(false);
  });
  it("insufficient_data → ไม่เปิด", () => {
    expect(shouldOpenChatCase(analysis({ insufficient_data: true }))).toBe(false);
  });
  it("chatCaseLevel: critical→critical, อื่น→high", () => {
    expect(chatCaseLevel("critical")).toBe("critical");
    expect(chatCaseLevel("high")).toBe("high");
    expect(chatCaseLevel("medium")).toBe("high");
  });
});

describe("resolveCaseOwner — owner จาก customer_assignments (effective-dated)", () => {
  it("customerId null → null", async () => {
    const store: Store = { data: {}, rpcCalls: [] };
    expect(await resolveCaseOwner(makeDb(store), null, NOW)).toBeNull();
  });

  it("เลือกผู้ดูแลตรง (member) ก่อนหัวหน้า (lead) + คืน team", async () => {
    const store: Store = {
      data: {
        customer_assignments: [
          { customer_id: "c1", employee_id: "lead-emp", team_id: "team-1", role: "lead", valid_from: "2026-01-01", valid_to: null },
          { customer_id: "c1", employee_id: "acc-emp", team_id: "team-1", role: "member", valid_from: "2026-01-01", valid_to: null },
        ],
      },
      rpcCalls: [],
    };
    const owner = await resolveCaseOwner(makeDb(store), "c1", NOW);
    expect(owner).toEqual({ employeeId: "acc-emp", teamId: "team-1" });
  });

  it("กรอง assignment ที่หมดอายุแล้ว (valid_to < now)", async () => {
    const store: Store = {
      data: {
        customer_assignments: [
          { customer_id: "c1", employee_id: "old-emp", team_id: "team-x", role: "member", valid_from: "2025-01-01", valid_to: "2026-06-30" },
        ],
      },
      rpcCalls: [],
    };
    expect(await resolveCaseOwner(makeDb(store), "c1", NOW)).toBeNull();
  });
});

describe("resolveTeamLead — หัวหน้าทีมสำหรับ escalate", () => {
  it("จาก teams.lead_employee_id", async () => {
    const store: Store = {
      data: { teams: [{ id: "team-1", lead_employee_id: "lead-emp" }] },
      rpcCalls: [],
    };
    expect(await resolveTeamLead(makeDb(store), "c1", "team-1", NOW)).toBe("lead-emp");
  });

  it("fallback: assignment role=lead ของลูกค้า", async () => {
    const store: Store = {
      data: {
        teams: [],
        customer_assignments: [
          { customer_id: "c1", employee_id: "lead-emp", team_id: null, role: "lead", valid_from: "2026-01-01", valid_to: null },
        ],
      },
      rpcCalls: [],
    };
    expect(await resolveTeamLead(makeDb(store), "c1", null, NOW)).toBe("lead-emp");
  });
});

describe("openCaseFromChatAnalysis — orchestrator", () => {
  it("ไม่เข้าเงื่อนไขเปิดเคส → skipped ไม่เรียก RPC", async () => {
    const store: Store = { data: {}, rpcCalls: [] };
    const res = await openCaseFromChatAnalysis(
      makeDb(store),
      {
        tenantId: "t1",
        chatGroupId: "g1",
        customerId: "c1",
        analysisId: "a1",
        analysis: analysis({ urgency: "low", problems: [], sentiment: "neutral" }),
        messageIds: ["m1"],
      },
      NOW
    );
    expect(res.skipped).toBe(true);
    expect(store.rpcCalls).toHaveLength(0);
  });

  it("เปิดเคส: resolve owner จาก assignment + match rule + เรียก RPC ด้วย due ที่คำนวณ", async () => {
    const store: Store = {
      data: {
        customer_assignments: [
          { customer_id: "c1", employee_id: "acc-emp", team_id: "team-1", role: "member", valid_from: "2026-01-01", valid_to: null },
        ],
        sla_rules: [
          { id: "rule-high", customer_type: null, urgency: "high", work_type: null, team_id: null, first_response_minutes: 120, resolution_minutes: 300, priority: 500, is_active: true },
        ],
      },
      rpcCalls: [],
    };
    const res = await openCaseFromChatAnalysis(
      makeDb(store),
      {
        tenantId: "t1",
        chatGroupId: "g1",
        customerId: "c1",
        analysisId: "a1",
        analysis: analysis({ urgency: "high" }),
        messageIds: ["m1", "m2"],
      },
      NOW
    );
    expect(res.skipped).toBe(false);
    expect(res.caseId).toBe("case-1");
    expect(store.rpcCalls).toHaveLength(1);
    const p = store.rpcCalls[0].params;
    expect(store.rpcCalls[0].name).toBe("open_or_update_conversation_case");
    expect(p.p_owner_employee_id).toBe("acc-emp");
    expect(p.p_sla_rule_id).toBe("rule-high");
    expect(p.p_level).toBe("high");
    expect(p.p_message_ids).toEqual(["m1", "m2"]);
    // due ต้องเป็น ISO string (คำนวณจริง ไม่ null)
    expect(typeof p.p_first_response_due_at).toBe("string");
    expect(typeof p.p_resolution_due_at).toBe("string");
  });

  it("customerId null → เปิดเคสได้แต่ owner null (ยังจับคู่ไม่ได้)", async () => {
    const store: Store = { data: {}, rpcCalls: [] };
    const res = await openCaseFromChatAnalysis(
      makeDb(store),
      {
        tenantId: "t1",
        chatGroupId: "g1",
        customerId: null,
        analysisId: "a1",
        analysis: analysis({ urgency: "critical" }),
        messageIds: ["m1"],
      },
      NOW
    );
    expect(res.skipped).toBe(false);
    expect(store.rpcCalls[0].params.p_owner_employee_id).toBeNull();
    expect(store.rpcCalls[0].params.p_level).toBe("critical");
  });

  it("RPC error → skipped=true (ไม่ throw ให้ล้ม job)", async () => {
    const store: Store = {
      data: {},
      rpcCalls: [],
      rpcResult: { data: null, error: { code: "P0002" } },
    };
    const res = await openCaseFromChatAnalysis(
      makeDb(store),
      {
        tenantId: "t1",
        chatGroupId: "g1",
        customerId: "c1",
        analysisId: "a1",
        analysis: analysis({ urgency: "high" }),
        messageIds: ["m1"],
      },
      NOW
    );
    expect(res.skipped).toBe(true);
    expect(res.reason).toContain("rpc_failed");
  });
});
