import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processAiAnalysisJobs } from "@/lib/ai/worker";
import type { AIProvider, GenerateJsonArgs } from "@/lib/ai/provider";
import type { AiOutput } from "@/lib/ai/schema";

/* ---------- Fake Supabase client (chainable + thenable) ---------- */

type Store = {
  data: Record<string, unknown>;
  updates: { table: string; payload: Record<string, unknown> }[];
  rpcCalls: { name: string; params: Record<string, unknown> }[];
  rpcError?: { message: string } | null;
};

class QB {
  private wantSingle = false;
  private isUpdate = false;
  private updatePayload: Record<string, unknown> = {};
  private filters: Record<string, unknown> = {};
  constructor(private table: string, private store: Store) {}
  select() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters[col] = val;
    return this;
  }
  or() {
    return this;
  }
  lte() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  update(payload: Record<string, unknown>) {
    this.isUpdate = true;
    this.updatePayload = payload;
    return this;
  }
  maybeSingle() {
    this.wantSingle = true;
    return this;
  }
  private result() {
    if (this.isUpdate) {
      this.store.updates.push({ table: this.table, payload: this.updatePayload });
      // claim: update ... .select().maybeSingle() → คืน id (จำลองว่ายัง pending อยู่)
      if (this.wantSingle) return { data: { id: this.filters.id ?? "job" }, error: null };
      return { data: null, error: null };
    }
    const canned = this.store.data[this.table];
    if (this.wantSingle) {
      const single = Array.isArray(canned) ? canned[0] ?? null : canned ?? null;
      return { data: single, error: null };
    }
    const arr = Array.isArray(canned) ? canned : canned ? [canned] : [];
    return { data: arr, error: null };
  }
  then<T>(onF: (v: { data: unknown; error: unknown }) => T) {
    return Promise.resolve(this.result()).then(onF);
  }
}

function makeDb(store: Store): SupabaseClient {
  const db = {
    from(table: string) {
      return new QB(table, store);
    },
    async rpc(name: string, params: Record<string, unknown>) {
      store.rpcCalls.push({ name, params });
      return { data: null, error: store.rpcError ?? null };
    },
  };
  return db as unknown as SupabaseClient;
}

/* ---------- Fake provider ---------- */

function output(overrides: Partial<AiOutput> = {}): AiOutput {
  return {
    summary: "ลูกค้าไม่พอใจงานยื่นภาษีผิด",
    customer_facts: ["ยื่นภาษีผิดเดือน"],
    ai_assumptions: [],
    evidence: [{ claim: "งานผิด", quote: "ยื่นผิดเดือน" }],
    categories: ["งานผิด"],
    sentiment: "negative",
    urgency: "high",
    urgency_reason: "งานผิดกระทบภาษี",
    affected: { employee: null, team: null, service: null, period: null },
    repeat_issue: false,
    next_best_action: "ตรวจสอบการยื่นภาษี",
    draft_reply: "ขอบคุณค่ะ จะส่งต่อทีมตรวจสอบ",
    confidence: 0.8,
    ...overrides,
  };
}

class FakeProvider implements AIProvider {
  readonly name = "fake";
  readonly model = "fake-1";
  lastArgs: GenerateJsonArgs | null = null;
  constructor(private readonly json: string) {}
  async generateJson(args: GenerateJsonArgs) {
    this.lastArgs = args;
    if (this.json === "__throw__") throw new Error("api_down");
    return this.json;
  }
}

function baseStore(): Store {
  return {
    data: {
      job_queue: [
        {
          id: "job-1",
          tenant_id: "t-1",
          payload: { response_id: "resp-1" },
          attempts: 0,
          max_attempts: 5,
        },
      ],
      survey_responses: {
        tenant_id: "t-1",
        customer_id: "cust-1",
        invitation_id: "inv-1",
      },
      survey_invitations: {
        survey_type: "A",
        assignee_snapshot: [{ name: "พนักงานเอ" }],
      },
      survey_answers: [{ question_code: "note", value_json: "งานผิด โทร 0812345678" }],
      satisfaction_scores: [{ dimension: "overall", score: 2 }],
      nps_scores: { score_0_10: 3 },
      customers: { name: "ลูกค้าทดสอบ", business_name: "บริษัท ทดสอบ" },
    },
    updates: [],
    rpcCalls: [],
  };
}

describe("worker — degrade เมื่อไม่มี provider", () => {
  it("provider null → skipped, ไม่ยุ่ง DB", async () => {
    const store = baseStore();
    const summary = await processAiAnalysisJobs({ db: makeDb(store), provider: null });
    expect(summary.skipped).toBe(true);
    expect(summary.reason).toBe("ai_provider_unconfigured");
    expect(store.rpcCalls).toHaveLength(0);
  });
});

describe("worker — happy path + เปิดเคสอัตโนมัติ", () => {
  it("urgency high → เรียก persist_ai_analysis พร้อม p_open_case=true + mark done", async () => {
    const store = baseStore();
    const provider = new FakeProvider(JSON.stringify(output()));
    const summary = await processAiAnalysisJobs({
      db: makeDb(store),
      provider,
      now: () => new Date("2026-07-13T10:00:00Z"),
    });

    expect(summary.processed).toBe(1);
    expect(summary.done).toBe(1);

    // เรียก RPC persist_ai_analysis
    const rpc = store.rpcCalls.find((c) => c.name === "persist_ai_analysis");
    expect(rpc).toBeTruthy();
    expect(rpc?.params.p_open_case).toBe(true);
    expect(rpc?.params.p_case_level).toBe("high");
    expect(rpc?.params.p_tenant_id).toBe("t-1");
    // now=10:00Z (=17:00 เวลาไทย) → high SLA = 18:00 ไทย = 11:00Z
    expect(rpc?.params.p_sla_due_at).toBe("2026-07-13T11:00:00.000Z");

    // needs_human_review บังคับ true สำหรับ high
    const analysis = rpc?.params.p_analysis as Record<string, unknown>;
    expect(analysis.needs_human_review).toBe(true);
    expect(analysis.validated).toBe(true);
    // เก็บข้อมูลจัดระดับครบ (urgency_reason / affected / repeat_issue)
    expect(analysis.urgency_reason).toBe("งานผิดกระทบภาษี");
    expect(analysis.affected).toBeTruthy();
    expect(analysis.repeat_issue).toBe(false);

    // job ถูก mark 'sent'
    const done = store.updates.find((u) => u.payload.status === "sent");
    expect(done).toBeTruthy();
  });

  it("redact ทำงาน: prompt ที่ส่ง AI ไม่มีเบอร์ดิบ (C-15)", async () => {
    const store = baseStore();
    const provider = new FakeProvider(JSON.stringify(output()));
    await processAiAnalysisJobs({ db: makeDb(store), provider });
    expect(provider.lastArgs?.user).not.toContain("0812345678");
    expect(provider.lastArgs?.user).toContain("[เบอร์โทร]");
  });
});

describe("worker — positive urgency ไม่เปิดเคส", () => {
  it("urgency positive → p_open_case=false", async () => {
    const store = baseStore();
    const provider = new FakeProvider(
      JSON.stringify(output({ urgency: "positive", sentiment: "positive" }))
    );
    await processAiAnalysisJobs({ db: makeDb(store), provider });
    const rpc = store.rpcCalls.find((c) => c.name === "persist_ai_analysis");
    expect(rpc?.params.p_open_case).toBe(false);
    expect(rpc?.params.p_sla_due_at).toBeNull();
  });
});

describe("worker — AI ล้ม → fallback (job สำเร็จ + needs_human_review)", () => {
  it("provider throw ทั้ง 2 ครั้ง → บันทึก fallback (validated=false) + mark done", async () => {
    const store = baseStore();
    const provider = new FakeProvider("__throw__");
    const summary = await processAiAnalysisJobs({ db: makeDb(store), provider });
    expect(summary.done).toBe(1);
    const rpc = store.rpcCalls.find((c) => c.name === "persist_ai_analysis");
    const analysis = rpc?.params.p_analysis as Record<string, unknown>;
    expect(analysis.validated).toBe(false);
    expect(analysis.needs_human_review).toBe(true);
  });
});

describe("worker — error handling (retry/dead)", () => {
  it("โหลด context ไม่ได้ + attempts ยังไม่ครบ → mark pending (retry)", async () => {
    const store = baseStore();
    store.data.survey_responses = null; // context หาย → processJob ล้ม
    const provider = new FakeProvider(JSON.stringify(output()));
    const summary = await processAiAnalysisJobs({ db: makeDb(store), provider });
    expect(summary.failed).toBe(1);
    const back = store.updates.find(
      (u) => u.table === "job_queue" && u.payload.status === "pending"
    );
    expect(back).toBeTruthy();
    expect(back?.payload.attempts).toBe(1);
  });

  it("โหลด context ไม่ได้ + attempts ครบ max_attempts → dead", async () => {
    const store = baseStore();
    store.data.survey_responses = null;
    (store.data.job_queue as { attempts: number }[])[0].attempts = 4; // +1 = 5 = max
    const provider = new FakeProvider(JSON.stringify(output()));
    const summary = await processAiAnalysisJobs({ db: makeDb(store), provider });
    expect(summary.dead).toBe(1);
    const dead = store.updates.find((u) => u.payload.status === "dead");
    expect(dead).toBeTruthy();
  });

  it("RPC ล้ม → retry", async () => {
    const store = baseStore();
    store.rpcError = { message: "db_down" };
    const provider = new FakeProvider(JSON.stringify(output()));
    const summary = await processAiAnalysisJobs({ db: makeDb(store), provider });
    expect(summary.failed).toBe(1);
  });
});
