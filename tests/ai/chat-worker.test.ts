import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ★ ต้องตั้งคีย์ถอดรหัสก่อน import worker/crypto (worker เช็ค hasEncKey)
beforeAll(() => {
  process.env.CREDENTIAL_ENC_KEY = "test-enc-key-สำหรับ-unit-test";
});

import { processChatAnalysisJobs } from "@/lib/ai/chat-worker";
import type { AIProvider, GenerateJsonArgs } from "@/lib/ai/provider";
import type { ChatOutput } from "@/lib/ai/chat-schema";
import { encryptField } from "@/lib/crypto/field";

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
  is() {
    return this;
  }
  in() {
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

function output(overrides: Partial<ChatOutput> = {}): ChatOutput {
  return {
    summary: "ลูกค้าถามภาษี ทีมตอบ",
    customer_facts: ["ถามการยื่นภาษี"],
    ai_assumptions: [],
    evidence: [{ claim: "ถาม", quote: "ยื่นยัง", msg_idx: 0 }],
    flow_steps: [{ step: "receive", status: "done", note: "รับเรื่อง", msg_idx: 0 }],
    problems: [{ type: "slow_reply", detail: "ช้า", msg_idx: 1 }],
    sop_violations: [
      {
        violation_type: "slow_reply",
        severity: "medium",
        description: "ตอบช้า",
        msg_idx: 1,
        needs_expert_review: false,
      },
    ],
    sentiment_points: [{ score: -0.1, label: "neutral", msg_idx: 0 }],
    sentiment: "neutral",
    urgency: "medium",
    confidence: 0.6,
    insufficient_data: false,
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
          payload: { chat_group_id: "grp-1" },
          attempts: 0,
          max_attempts: 5,
        },
      ],
      chat_groups: {
        id: "grp-1",
        tenant_id: "t-1",
        customer_id: "cust-1",
      },
      chat_messages: [
        {
          id: "msg-0",
          chat_member_id: "mem-c",
          message_type: "text",
          content_enc: encryptField("ยื่นภาษีเดือนนี้ยัง ประยุทธ โทร 0812345678"),
          sent_at: "2026-07-18T10:00:00Z",
        },
        {
          id: "msg-1",
          chat_member_id: "mem-a",
          message_type: "text",
          content_enc: encryptField("สมชายกำลังตรวจให้ครับ"),
          sent_at: "2026-07-18T10:05:00Z",
        },
      ],
      chat_members: [
        { id: "mem-c", member_kind: "customer", display_name_enc: null, employee_id: null },
        {
          id: "mem-a",
          member_kind: "accountant",
          display_name_enc: encryptField("สมชาย"),
          employee_id: "emp-1",
        },
      ],
      employees: [{ id: "emp-1", first_name: "ประยุทธ", nickname: "ตุ่น" }],
      customers: { name: "ลูกค้าทดสอบ", business_name: "บริษัท ทดสอบ" },
    },
    updates: [],
    rpcCalls: [],
  };
}

describe("chat-worker — degrade", () => {
  it("provider null → skipped ไม่ยุ่ง DB", async () => {
    const store = baseStore();
    const summary = await processChatAnalysisJobs({ db: makeDb(store), provider: null });
    expect(summary.skipped).toBe(true);
    expect(summary.reason).toBe("ai_provider_unconfigured");
    expect(store.rpcCalls).toHaveLength(0);
  });
});

describe("chat-worker — happy path (batch window)", () => {
  it("รวมข้อความ 1 window/กลุ่ม → เรียก persist_chat_analysis + mark done", async () => {
    const store = baseStore();
    const provider = new FakeProvider(JSON.stringify(output()));
    const summary = await processChatAnalysisJobs({ db: makeDb(store), provider });

    expect(summary.processed).toBe(1);
    expect(summary.done).toBe(1);

    const rpc = store.rpcCalls.find((c) => c.name === "persist_chat_analysis");
    expect(rpc).toBeTruthy();
    expect(rpc?.params.p_tenant_id).toBe("t-1");
    expect(rpc?.params.p_chat_group_id).toBe("grp-1");

    // ★ batch window: ทั้ง 2 ข้อความอยู่ใน window เดียว (ไม่วิเคราะห์ทีละข้อความ)
    const msgIds = rpc?.params.p_message_ids as string[];
    expect(msgIds).toEqual(["msg-0", "msg-1"]);
    expect(rpc?.params.p_window_start).toBe("2026-07-18T10:00:00Z");
    expect(rpc?.params.p_window_end).toBe("2026-07-18T10:05:00Z");

    // sop_violations map msg_idx=1 → evidence_message_id = msg-1
    const violations = rpc?.params.p_violations as { evidence_message_id: string }[];
    expect(violations[0].evidence_message_id).toBe("msg-1");

    // job mark 'sent'
    expect(store.updates.some((u) => u.payload.status === "sent")).toBe(true);
  });

  it("★ decrypt ฝั่ง server + redact: prompt ไม่มีเบอร์/ชื่อคนในกลุ่มดิบ (C-15, sec-M1)", async () => {
    const store = baseStore();
    const provider = new FakeProvider(JSON.stringify(output()));
    await processChatAnalysisJobs({ db: makeDb(store), provider });
    const prompt = provider.lastArgs?.user ?? "";
    // เบอร์ถูก redact
    expect(prompt).not.toContain("0812345678");
    expect(prompt).toContain("[เบอร์โทร]");
    // ★ sec-M1: ชื่อสมาชิกกลุ่ม (จาก display_name_enc) + ชื่อพนักงาน ถูก redact ด้วย
    expect(prompt).not.toContain("สมชาย"); // ชื่อสมาชิก (decrypt แล้วเข้า knownNames)
    expect(prompt).not.toContain("ประยุทธ"); // first_name พนักงาน
    // เนื้อความอื่น (decrypt สำเร็จ) ยังอยู่
    expect(prompt).toContain("กำลังตรวจให้");
  });

  it("★ sec-H1: ไม่ส่งชื่อกลุ่มเข้า AI prompt เลย", async () => {
    const store = baseStore();
    const provider = new FakeProvider(JSON.stringify(output()));
    await processChatAnalysisJobs({ db: makeDb(store), provider });
    // prompt ไม่มี label 'กลุ่ม:' (ตัด groupLabel ออกทั้งหมด)
    expect(provider.lastArgs?.user).not.toContain("กลุ่ม:");
  });
});

describe("chat-worker — gate-blocked marker (rev-M1)", () => {
  it("PII หลุด redact → persist พร้อม blocked_reason='residual_pii' + mark done (ไม่วน)", async () => {
    const store = baseStore();
    // ข้อความมีเลขยาว 15 หลักที่ redact ไม่ได้ → residual gate บล็อก
    store.data.chat_messages = [
      {
        id: "msg-0",
        chat_member_id: "mem-c",
        message_type: "text",
        content_enc: encryptField("รหัสลับ 987654321012345"),
        sent_at: "2026-07-18T10:00:00Z",
      },
      {
        id: "msg-1",
        chat_member_id: "mem-a",
        message_type: "text",
        content_enc: encryptField("รับทราบครับ"),
        sent_at: "2026-07-18T10:05:00Z",
      },
    ];
    const provider = new FakeProvider(JSON.stringify(output()));
    const summary = await processChatAnalysisJobs({ db: makeDb(store), provider });

    expect(summary.done).toBe(1);
    // ยัง persist (เพื่อ mark analyzed → ไม่วนบล็อกซ้ำ) พร้อม marker
    const rpc = store.rpcCalls.find((c) => c.name === "persist_chat_analysis");
    expect(rpc).toBeTruthy();
    const analysis = rpc?.params.p_analysis as Record<string, unknown>;
    expect(analysis.blocked_reason).toBe("residual_pii");
    expect(analysis.needs_human_review).toBe(true);
    expect(analysis.validated).toBe(false);
    // provider ต้องไม่ถูกเรียก (โดนบล็อกก่อนส่ง AI)
    expect(provider.lastArgs).toBeNull();
    // job mark done
    expect(store.updates.some((u) => u.payload.status === "sent")).toBe(true);
  });
});

describe("chat-worker — ไม่มีข้อความค้าง → done เฉย ๆ", () => {
  it("window ว่าง → ไม่เรียก persist + mark done", async () => {
    const store = baseStore();
    store.data.chat_messages = [];
    const provider = new FakeProvider(JSON.stringify(output()));
    const summary = await processChatAnalysisJobs({ db: makeDb(store), provider });
    expect(summary.done).toBe(1);
    expect(store.rpcCalls.find((c) => c.name === "persist_chat_analysis")).toBeUndefined();
  });
});

describe("chat-worker — error handling", () => {
  it("กลุ่มไม่พบ + attempts ยังไม่ครบ → retry (pending)", async () => {
    const store = baseStore();
    store.data.chat_groups = null;
    const provider = new FakeProvider(JSON.stringify(output()));
    const summary = await processChatAnalysisJobs({ db: makeDb(store), provider });
    expect(summary.failed).toBe(1);
    const back = store.updates.find(
      (u) => u.table === "job_queue" && u.payload.status === "pending"
    );
    expect(back?.payload.attempts).toBe(1);
  });

  it("RPC persist ล้ม → retry", async () => {
    const store = baseStore();
    store.rpcError = { message: "db_down" };
    const provider = new FakeProvider(JSON.stringify(output()));
    const summary = await processChatAnalysisJobs({ db: makeDb(store), provider });
    expect(summary.failed).toBe(1);
  });
});
