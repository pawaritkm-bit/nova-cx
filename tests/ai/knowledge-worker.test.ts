import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ★ ต้องตั้งคีย์ถอดรหัสก่อน import worker/crypto (worker เช็ค hasEncKey + เข้ารหัส gist)
beforeAll(() => {
  process.env.CREDENTIAL_ENC_KEY = "test-enc-key-สำหรับ-unit-test";
});

import { processKnowledgeExtractJobs } from "@/lib/ai/knowledge-worker";
import type { AIProvider, GenerateJsonArgs } from "@/lib/ai/provider";
import type { KnowledgePair } from "@/lib/ai/knowledge-schema";
import { encryptField, decryptField } from "@/lib/crypto/field";

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
      return { data: { inserted: 1 }, error: store.rpcError ?? null };
    },
  };
  return db as unknown as SupabaseClient;
}

/* ---------- Fake provider ---------- */

function pairsJson(...p: Partial<KnowledgePair>[]): string {
  return JSON.stringify({
    pairs: p.map((x) => ({
      category: x.category ?? "เอกสาร",
      question_gist: x.question_gist ?? "ลูกค้าขอใบเสร็จ",
      answer_gist: x.answer_gist ?? "แจ้งว่าจะส่งใบเสร็จให้",
      answer_msg_idx: x.answer_msg_idx ?? 1,
      confidence: x.confidence ?? 0.8,
    })),
  });
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

/** store พื้นฐาน: กลุ่ม (group) + ลูกค้าถาม (m-0) + ทีมงานตอบ (m-1, ผูก employee) */
function baseStore(groupKind = "group"): Store {
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
        group_kind: groupKind,
      },
      chat_messages: [
        {
          id: "m-0",
          chat_member_id: "cm-cust",
          message_type: "text",
          content_enc: encryptField("ขอใบเสร็จเดือนนี้ด้วยครับ โทร 0812345678"),
          sent_at: "2026-07-18T10:00:00Z",
        },
        {
          id: "m-1",
          chat_member_id: "cm-staff",
          message_type: "text",
          content_enc: encryptField("ได้ครับ เดี๋ยวจัดส่งใบเสร็จให้ภายในพรุ่งนี้"),
          sent_at: "2026-07-18T10:05:00Z",
        },
      ],
      chat_members: [
        { id: "cm-cust", member_kind: "customer", display_name_enc: encryptField("คุณลูกค้า"), employee_id: null },
        { id: "cm-staff", member_kind: "accountant", display_name_enc: encryptField("น้องบัญชี"), employee_id: "emp-9" },
      ],
      employees: [{ id: "emp-9", first_name: "สมชาย", nickname: "ชาย" }],
      customers: { name: "ลูกค้าทดสอบ", business_name: "บริษัท ทดสอบ" },
    },
    updates: [],
    rpcCalls: [],
  };
}

describe("knowledge-worker — degrade", () => {
  it("provider null → skipped ไม่ยุ่ง DB", async () => {
    const store = baseStore();
    const summary = await processKnowledgeExtractJobs({ db: makeDb(store), provider: null });
    expect(summary.skipped).toBe(true);
    expect(summary.reason).toBe("ai_provider_unconfigured");
    expect(store.rpcCalls).toHaveLength(0);
  });
});

describe("knowledge-worker — happy path", () => {
  it("1 window → เรียก persist_reply_knowledge + mark done + เข้ารหัส gist", async () => {
    const store = baseStore();
    const provider = new FakeProvider(pairsJson({}));
    const summary = await processKnowledgeExtractJobs({ db: makeDb(store), provider });

    expect(summary.processed).toBe(1);
    expect(summary.done).toBe(1);

    const rpc = store.rpcCalls.find((c) => c.name === "persist_reply_knowledge");
    expect(rpc).toBeTruthy();
    expect(rpc!.params.p_tenant_id).toBe("t-1");
    expect(rpc!.params.p_chat_group_id).toBe("grp-1");
    expect(rpc!.params.p_message_ids).toEqual(["m-0", "m-1"]);

    // gist ต้องเข้ารหัส (ถอดกลับได้ + ไม่ใช่ plaintext ตรง ๆ)
    const items = rpc!.params.p_items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const qEnc = items[0].question_gist_enc as string;
    expect(qEnc).not.toContain("ใบเสร็จ");
    expect(decryptField(qEnc)).toBe("ลูกค้าขอใบเสร็จ");
    // resolve staff จาก answer_msg_idx=1 (m-1 = พนักงาน emp-9)
    expect(items[0].staff_employee_id).toBe("emp-9");
    expect(items[0].staff_role).toBe("accountant");

    // ★ กันปน: ต้องไม่เรียก RPC ของ per-accountant/office
    expect(store.rpcCalls.find((c) => c.name === "persist_chat_analysis")).toBeUndefined();
    expect(store.rpcCalls.find((c) => c.name === "persist_office_inbound_analysis")).toBeUndefined();
  });

  it("redact ก่อนส่ง AI: เบอร์โทรในข้อความไม่หลุดเข้า prompt", async () => {
    const store = baseStore();
    const provider = new FakeProvider(pairsJson({}));
    await processKnowledgeExtractJobs({ db: makeDb(store), provider });
    expect(provider.lastArgs).not.toBeNull();
    expect(provider.lastArgs!.user).not.toContain("0812345678");
  });

  it("★ กันปน: group_kind='user' (1-1) → worker ไม่สกัด (ไม่เรียก persist)", async () => {
    const store = baseStore("user"); // บทสนทนา 1-1 — knowledge worker ต้องไม่แตะ
    const provider = new FakeProvider(pairsJson({}));
    const summary = await processKnowledgeExtractJobs({ db: makeDb(store), provider });
    expect(summary.processed).toBe(1);
    expect(store.rpcCalls.find((c) => c.name === "persist_reply_knowledge")).toBeUndefined();
  });
});
