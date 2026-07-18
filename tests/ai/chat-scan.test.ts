import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { scanChatAnalysis } from "@/lib/ai/chat-scan";

/* ---------- Fake DB สำหรับ scan ---------- */

type UnMsg = { chat_group_id: string; tenant_id: string; sent_at: string | null };

type ScanStore = {
  unanalyzed: UnMsg[];
  pendingGroups: Set<string>; // กลุ่มที่มี job ค้างอยู่
  inserts: Record<string, unknown>[];
  insertError?: boolean;
};

class QB {
  private table: string;
  private store: ScanStore;
  private filters: Record<string, unknown> = {};
  private wantSingle = false;
  private isInsert = false;
  constructor(table: string, store: ScanStore) {
    this.table = table;
    this.store = store;
  }
  select() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters[col] = val;
    return this;
  }
  in() {
    return this;
  }
  is() {
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
  insert(payload: Record<string, unknown>) {
    this.isInsert = true;
    this.store.inserts.push(payload);
    return this;
  }
  private result() {
    if (this.isInsert) {
      return { data: null, error: this.store.insertError ? { message: "insert_fail" } : null };
    }
    if (this.table === "chat_messages") {
      return { data: this.store.unanalyzed, error: null };
    }
    if (this.table === "job_queue") {
      // hasPendingJob: filter payload->>chat_group_id
      const gid = this.filters["payload->>chat_group_id"] as string | undefined;
      const has = gid ? this.store.pendingGroups.has(gid) : false;
      return { data: has ? { id: "existing-job" } : null, error: null };
    }
    return { data: this.wantSingle ? null : [], error: null };
  }
  then<T>(onF: (v: { data: unknown; error: unknown }) => T) {
    return Promise.resolve(this.result()).then(onF);
  }
}

function makeDb(store: ScanStore): SupabaseClient {
  return {
    from(table: string) {
      return new QB(table, store);
    },
  } as unknown as SupabaseClient;
}

const NOW = new Date("2026-07-18T12:00:00Z");

describe("chat-scan — enqueue window ต่อกลุ่ม (debounce + idempotent)", () => {
  it("กลุ่มที่นิ่งแล้ว → enqueue 1 job/กลุ่ม", async () => {
    const store: ScanStore = {
      unanalyzed: [
        { chat_group_id: "g1", tenant_id: "t1", sent_at: "2026-07-18T11:00:00Z" },
        { chat_group_id: "g1", tenant_id: "t1", sent_at: "2026-07-18T11:02:00Z" },
      ],
      pendingGroups: new Set(),
      inserts: [],
    };
    const summary = await scanChatAnalysis({ db: makeDb(store), now: () => NOW });
    expect(summary.groups).toBe(1);
    expect(summary.enqueued).toBe(1);
    expect(store.inserts).toHaveLength(1);
    expect(store.inserts[0]).toMatchObject({
      queue: "chat_analysis",
      tenant_id: "t1",
      payload: { chat_group_id: "g1" },
    });
  });

  it("บทสนทนายังไม่นิ่ง (ข้อความล่าสุดสด ๆ) → waiting ไม่ enqueue", async () => {
    const store: ScanStore = {
      unanalyzed: [{ chat_group_id: "g2", tenant_id: "t1", sent_at: "2026-07-18T11:59:30Z" }],
      pendingGroups: new Set(),
      inserts: [],
    };
    const summary = await scanChatAnalysis({ db: makeDb(store), now: () => NOW });
    expect(summary.waiting).toBe(1);
    expect(summary.enqueued).toBe(0);
    expect(store.inserts).toHaveLength(0);
  });

  it("กลุ่มมี job ค้างอยู่แล้ว → existed (idempotent ไม่ enqueue ซ้ำ)", async () => {
    const store: ScanStore = {
      unanalyzed: [{ chat_group_id: "g3", tenant_id: "t1", sent_at: "2026-07-18T11:00:00Z" }],
      pendingGroups: new Set(["g3"]),
      inserts: [],
    };
    const summary = await scanChatAnalysis({ db: makeDb(store), now: () => NOW });
    expect(summary.existed).toBe(1);
    expect(summary.enqueued).toBe(0);
  });

  it("หลายกลุ่ม: aggregate แยกกลุ่ม → enqueue เท่าจำนวนกลุ่มที่นิ่ง", async () => {
    const store: ScanStore = {
      unanalyzed: [
        { chat_group_id: "gA", tenant_id: "t1", sent_at: "2026-07-18T11:00:00Z" },
        { chat_group_id: "gA", tenant_id: "t1", sent_at: "2026-07-18T11:01:00Z" },
        { chat_group_id: "gB", tenant_id: "t2", sent_at: "2026-07-18T10:00:00Z" },
      ],
      pendingGroups: new Set(),
      inserts: [],
    };
    const summary = await scanChatAnalysis({ db: makeDb(store), now: () => NOW });
    expect(summary.groups).toBe(2);
    expect(summary.enqueued).toBe(2);
  });
});
