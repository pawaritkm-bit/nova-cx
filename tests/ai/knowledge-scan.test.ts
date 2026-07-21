import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { scanKnowledgeExtract } from "@/lib/ai/knowledge-scan";

/**
 * knowledge-scan (Phase 1) — enqueue เฉพาะแชตกลุ่ม (group/room)
 *   ★ กันปน: กลุ่ม 1-1 (group_kind='user') ต้องถูกข้าม (ไม่สกัดความรู้จาก 1-1)
 */

type Store = {
  messages: { chat_group_id: string; tenant_id: string; sent_at: string | null }[];
  groups: { id: string; group_kind: string }[];
  pendingJobs: Set<string>; // chat_group_id ที่มี job ค้าง
  inserts: { queue: string; chatGroupId: string }[];
};

/** fake db: รองรับ chat_messages(select), chat_groups(select in), job_queue(select pending + insert) */
function makeDb(store: Store): SupabaseClient {
  function qb(table: string) {
    const state: { table: string; filters: Record<string, unknown>; insertPayload?: Record<string, unknown> } = {
      table,
      filters: {},
    };
    const chain = {
      select() {
        return chain;
      },
      eq(col: string, val: unknown) {
        state.filters[col] = val;
        return chain;
      },
      in() {
        return chain;
      },
      is() {
        return chain;
      },
      order() {
        return chain;
      },
      insert(payload: Record<string, unknown>) {
        state.insertPayload = payload;
        return chain;
      },
      limit() {
        // job_queue pending check
        if (table === "job_queue") {
          const gid = String(state.filters["payload->>chat_group_id"] ?? "");
          const has = store.pendingJobs.has(gid);
          return {
            maybeSingle: () => Promise.resolve({ data: has ? { id: "j" } : null, error: null }),
          };
        }
        // chat_messages page
        if (table === "chat_messages") {
          return Promise.resolve({ data: store.messages, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: null, error: null });
      },
      then<T>(onF: (v: { data: unknown; error: unknown }) => T) {
        // chat_groups select .in(...) resolves here
        if (table === "chat_groups") {
          return Promise.resolve({ data: store.groups, error: null }).then(onF);
        }
        // job_queue insert resolves here
        if (table === "job_queue" && state.insertPayload) {
          const gid = (state.insertPayload.payload as { chat_group_id: string }).chat_group_id;
          store.inserts.push({ queue: String(state.insertPayload.queue), chatGroupId: gid });
          store.pendingJobs.add(gid);
          return Promise.resolve({ data: null, error: null }).then(onF);
        }
        return Promise.resolve({ data: [], error: null }).then(onF);
      },
    };
    return chain;
  }
  return { from: (t: string) => qb(t) } as unknown as SupabaseClient;
}

describe("knowledge-scan — routing กันปน", () => {
  it("enqueue เฉพาะ group/room — ข้าม 1-1 (user)", async () => {
    const old = "2020-01-01T00:00:00Z"; // เก่ามาก → นิ่งแล้ว (ผ่าน debounce)
    const store: Store = {
      messages: [
        { chat_group_id: "grp-1", tenant_id: "t-1", sent_at: old },
        { chat_group_id: "room-1", tenant_id: "t-1", sent_at: old },
        { chat_group_id: "dm-1", tenant_id: "t-1", sent_at: old }, // 1-1 → ต้องข้าม
      ],
      groups: [
        { id: "grp-1", group_kind: "group" },
        { id: "room-1", group_kind: "room" },
        { id: "dm-1", group_kind: "user" },
      ],
      pendingJobs: new Set(),
      inserts: [],
    };

    const summary = await scanKnowledgeExtract({ db: makeDb(store) });

    expect(summary.groups).toBe(3);
    expect(summary.skippedDirect).toBe(1); // dm-1 (user) ถูกข้าม
    expect(summary.enqueued).toBe(2);

    const enqueuedGroups = store.inserts.map((i) => i.chatGroupId).sort();
    expect(enqueuedGroups).toEqual(["grp-1", "room-1"]);
    expect(store.inserts.every((i) => i.queue === "knowledge_extract")).toBe(true);
    // ★ ต้องไม่ enqueue dm-1
    expect(store.inserts.find((i) => i.chatGroupId === "dm-1")).toBeUndefined();
  });

  it("มี job ค้างอยู่แล้ว → idempotent skip (existed)", async () => {
    const old = "2020-01-01T00:00:00Z";
    const store: Store = {
      messages: [{ chat_group_id: "grp-1", tenant_id: "t-1", sent_at: old }],
      groups: [{ id: "grp-1", group_kind: "group" }],
      pendingJobs: new Set(["grp-1"]),
      inserts: [],
    };
    const summary = await scanKnowledgeExtract({ db: makeDb(store) });
    expect(summary.existed).toBe(1);
    expect(summary.enqueued).toBe(0);
  });
});
