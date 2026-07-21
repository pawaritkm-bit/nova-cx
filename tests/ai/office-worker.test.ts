import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ★ ต้องตั้งคีย์ถอดรหัสก่อน import worker/crypto (worker เช็ค hasEncKey)
beforeAll(() => {
  process.env.CREDENTIAL_ENC_KEY = "test-enc-key-สำหรับ-unit-test";
});

import { processOfficeInboundJobs } from "@/lib/ai/office-worker";
import type { AIProvider, GenerateJsonArgs } from "@/lib/ai/provider";
import type { OfficeOutput } from "@/lib/ai/office-schema";
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
      return { data: { analysis_id: "oia-1" }, error: store.rpcError ?? null };
    },
  };
  return db as unknown as SupabaseClient;
}

/* ---------- Fake provider ---------- */

function output(overrides: Partial<OfficeOutput> = {}): OfficeOutput {
  return {
    summary: "ลูกค้าถามเรื่องเอกสาร",
    sentiment: "neutral",
    urgency: "medium",
    topics: ["เอกสาร"],
    is_complaint: false,
    needs_attention: false,
    confidence: 0.7,
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

/** store พื้นฐาน: บทสนทนา 1-1 (group_kind='user') + ข้อความลูกค้า 2 ท่อน */
function baseStore(groupKind = "user"): Store {
  return {
    data: {
      job_queue: [
        {
          id: "job-1",
          tenant_id: "t-1",
          payload: { chat_group_id: "dm-1" },
          attempts: 0,
          max_attempts: 5,
        },
      ],
      chat_groups: {
        id: "dm-1",
        tenant_id: "t-1",
        customer_id: "cust-1",
        group_kind: groupKind,
      },
      chat_messages: [
        {
          id: "m-0",
          message_type: "text",
          content_enc: encryptField("ขอใบเสร็จเดือนนี้ด้วยครับ โทร 0812345678"),
          sent_at: "2026-07-18T10:00:00Z",
        },
        {
          id: "m-1",
          message_type: "text",
          content_enc: encryptField("รอนานมากเลยครับ"),
          sent_at: "2026-07-18T10:05:00Z",
        },
      ],
      chat_members: [{ display_name_enc: encryptField("คุณลูกค้า") }],
      customers: { name: "ลูกค้าทดสอบ", business_name: "บริษัท ทดสอบ" },
    },
    updates: [],
    rpcCalls: [],
  };
}

describe("office-worker — degrade", () => {
  it("provider null → skipped ไม่ยุ่ง DB", async () => {
    const store = baseStore();
    const summary = await processOfficeInboundJobs({ db: makeDb(store), provider: null });
    expect(summary.skipped).toBe(true);
    expect(summary.reason).toBe("ai_provider_unconfigured");
    expect(store.rpcCalls).toHaveLength(0);
  });
});

describe("office-worker — happy path", () => {
  it("1 window/บทสนทนา → เรียก persist_office_inbound_analysis + mark done", async () => {
    const store = baseStore();
    const provider = new FakeProvider(JSON.stringify(output()));
    const summary = await processOfficeInboundJobs({ db: makeDb(store), provider });

    expect(summary.processed).toBe(1);
    expect(summary.done).toBe(1);

    const rpc = store.rpcCalls.find((c) => c.name === "persist_office_inbound_analysis");
    expect(rpc).toBeTruthy();
    expect(rpc!.params.p_tenant_id).toBe("t-1");
    expect(rpc!.params.p_chat_group_id).toBe("dm-1");
    expect(rpc!.params.p_message_ids).toEqual(["m-0", "m-1"]);

    // ★ ต้องไม่เรียก RPC ของ per-accountant flow
    expect(store.rpcCalls.find((c) => c.name === "persist_chat_analysis")).toBeUndefined();
  });

  it("redact ก่อนส่ง AI: เบอร์โทรในข้อความไม่หลุดเข้า prompt", async () => {
    const store = baseStore();
    const provider = new FakeProvider(JSON.stringify(output()));
    await processOfficeInboundJobs({ db: makeDb(store), provider });
    expect(provider.lastArgs).not.toBeNull();
    expect(provider.lastArgs!.user).not.toContain("0812345678");
  });

  it("★ กันปน: group_kind != 'user' → worker ไม่วิเคราะห์ (fail ไม่เรียก persist)", async () => {
    const store = baseStore("group"); // กลุ่มจริง — office worker ต้องไม่แตะ
    const provider = new FakeProvider(JSON.stringify(output()));
    const summary = await processOfficeInboundJobs({ db: makeDb(store), provider });
    expect(summary.processed).toBe(1);
    // ไม่ควรมีการเรียก persist office เลย (loadOfficeWindow คืน null)
    expect(store.rpcCalls.find((c) => c.name === "persist_office_inbound_analysis")).toBeUndefined();
  });
});
