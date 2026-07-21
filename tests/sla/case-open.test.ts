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
  alertInserts: Record<string, unknown>[];
};

class QB {
  private op: "select" | "insert" | "update" = "select";
  private filters: Record<string, unknown> = {};
  private wantSingle = false;
  private payload: Record<string, unknown> = {};
  constructor(private table: string, private store: Store) {}
  select() {
    return this;
  }
  insert(payload: Record<string, unknown>) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Record<string, unknown>) {
    this.op = "update";
    this.payload = payload;
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
    return all.filter((r) =>
      Object.entries(this.filters).every(([k, v]) => !(k in r) || r[k] === v)
    );
  }
  private result() {
    if (this.op === "insert") {
      if (this.table === "risk_alerts") this.store.alertInserts.push(this.payload);
      return { data: null, error: null };
    }
    if (this.op === "update") {
      return { data: null, error: null };
    }
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

function makeStore(overrides: Partial<Store> = {}): Store {
  return { data: {}, rpcCalls: [], alertInserts: [], ...overrides };
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

describe("resolveCaseOwner — owner จากนักบัญชีผู้ดูแลกลุ่มแชต (chat_groups.responsible_employee_id)", () => {
  it("chatGroupId null → null", async () => {
    const store = makeStore();
    expect(await resolveCaseOwner(makeDb(store), "t1", null)).toBeNull();
  });

  it("กลุ่มมีผู้ดูแล → คืน employeeId + team ปัจจุบันจาก team_members", async () => {
    const store = makeStore({
      data: {
        chat_groups: [
          { tenant_id: "t1", id: "g1", responsible_employee_id: "acc-emp", group_kind: "group" },
        ],
        team_members: [
          { tenant_id: "t1", employee_id: "acc-emp", team_id: "team-1", valid_to: null },
        ],
      },
    });
    const owner = await resolveCaseOwner(makeDb(store), "t1", "g1");
    expect(owner).toEqual({ employeeId: "acc-emp", teamId: "team-1" });
  });

  it("กลุ่มมีผู้ดูแลแต่ยังไม่อยู่ทีมใด → teamId null", async () => {
    const store = makeStore({
      data: {
        chat_groups: [
          { tenant_id: "t1", id: "g1", responsible_employee_id: "acc-emp", group_kind: "group" },
        ],
      },
    });
    const owner = await resolveCaseOwner(makeDb(store), "t1", "g1");
    expect(owner).toEqual({ employeeId: "acc-emp", teamId: null });
  });

  it("กลุ่มยังไม่มีผู้ดูแล (responsible null) → null", async () => {
    const store = makeStore({
      data: {
        chat_groups: [
          { tenant_id: "t1", id: "g1", responsible_employee_id: null, group_kind: "group" },
        ],
      },
    });
    expect(await resolveCaseOwner(makeDb(store), "t1", "g1")).toBeNull();
  });

  it("ไม่พบกลุ่มใน tenant → null (ไม่ leak ข้าม tenant)", async () => {
    const store = makeStore({
      data: {
        chat_groups: [
          { tenant_id: "t2", id: "g1", responsible_employee_id: "acc-emp", group_kind: "group" },
        ],
      },
    });
    expect(await resolveCaseOwner(makeDb(store), "t1", "g1")).toBeNull();
  });
});

describe("resolveTeamLead — หัวหน้าทีมสำหรับ escalate", () => {
  it("จาก teams.lead_employee_id", async () => {
    const store = makeStore({ data: { teams: [{ id: "team-1", lead_employee_id: "lead-emp" }] } });
    expect(await resolveTeamLead(makeDb(store), "t1", "c1", "team-1", NOW)).toBe("lead-emp");
  });

  it("fallback: assignment role=lead ของลูกค้า", async () => {
    const store = makeStore({
      data: {
        teams: [],
        customer_assignments: [
          { tenant_id: "t1", customer_id: "c1", employee_id: "lead-emp", team_id: null, role: "lead", valid_from: "2026-01-01", valid_to: null },
        ],
      },
    });
    expect(await resolveTeamLead(makeDb(store), "t1", "c1", null, NOW)).toBe("lead-emp");
  });
});

describe("openCaseFromChatAnalysis — orchestrator", () => {
  it("ไม่เข้าเงื่อนไขเปิดเคส → skipped ไม่เรียก RPC", async () => {
    const store = makeStore();
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

  it("เปิดเคส: resolve owner จากกลุ่มแชต + match rule + เรียก RPC ด้วย due ที่คำนวณ", async () => {
    const store = makeStore({
      data: {
        chat_groups: [
          { tenant_id: "t1", id: "g1", responsible_employee_id: "acc-emp", group_kind: "group" },
        ],
        team_members: [
          { tenant_id: "t1", employee_id: "acc-emp", team_id: "team-1", valid_to: null },
        ],
        sla_rules: [
          { id: "rule-high", customer_type: null, urgency: "high", work_type: null, team_id: null, first_response_minutes: 120, resolution_minutes: 300, priority: 500, is_active: true },
        ],
      },
    });
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
    expect(typeof p.p_first_response_due_at).toBe("string");
    expect(typeof p.p_resolution_due_at).toBe("string");
  });

  it("M2: เปิดเคส sentiment ลบ + มีปัญหา → สร้าง risk_alert ทันที (ไม่รอ SLA breach)", async () => {
    const store = makeStore();
    await openCaseFromChatAnalysis(
      makeDb(store),
      {
        tenantId: "t1",
        chatGroupId: "g1",
        customerId: "c1",
        analysisId: "a1",
        analysis: analysis({ urgency: "high", sentiment: "negative", problems: [{ type: "x" }] }),
        messageIds: ["m1"],
      },
      NOW
    );
    // negative + มีปัญหา → orange (computeRiskLevel) → insert risk_alert
    expect(store.alertInserts).toHaveLength(1);
    expect(store.alertInserts[0]).toMatchObject({ case_id: "case-1", level: "orange" });
  });

  it("M2: sentiment เป็นกลาง ไม่มีปัญหา → ไม่สร้าง alert (green)", async () => {
    const store = makeStore();
    await openCaseFromChatAnalysis(
      makeDb(store),
      {
        tenantId: "t1",
        chatGroupId: "g1",
        customerId: "c1",
        analysisId: "a1",
        analysis: analysis({ urgency: "high", sentiment: "neutral", problems: [] }),
        messageIds: ["m1"],
      },
      NOW
    );
    expect(store.alertInserts).toHaveLength(0);
  });

  it("กลุ่มยังไม่มีผู้ดูแล → เปิดเคสได้แต่ owner null", async () => {
    const store = makeStore(); // ไม่มี chat_groups → resolve owner ไม่เจอ
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
    const store = makeStore({ rpcResult: { data: null, error: { code: "P0002" } } });
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
