import { describe, it, expect } from "vitest";
import type { LineOa } from "@/lib/env";
import type { LineClient } from "@/lib/line/client";
import { processLineEventJobs } from "@/lib/line/events";
import { makeDb, makeStore } from "./fake-db";

function clientWithProfile(displayName: string | null) {
  const getClient = (oa: LineOa): LineClient => ({
    oa,
    async push() {
      return { ok: true };
    },
    async reply() {
      return { ok: true };
    },
    async getProfile(userId) {
      return displayName ? { userId, displayName } : { userId };
    },
  });
  return getClient;
}

function eventJob(event: unknown, oa: LineOa = "care") {
  return makeStore({
    job_queue: [
      {
        id: "job-1",
        tenant_id: "t-1",
        payload: { oa, event },
        attempts: 0,
        max_attempts: 5,
      },
    ],
  });
}

describe("processLineEventJobs", () => {
  it("follow → upsert line_users (linked + unblock + display_name)", async () => {
    const store = eventJob({ type: "follow", source: { type: "user", userId: "Uxyz" } });
    const summary = await processLineEventJobs({
      db: makeDb(store),
      getClient: clientWithProfile("คุณลูกค้า"),
      now: () => new Date("2026-07-15T10:00:00Z"),
    });

    expect(summary.done).toBe(1);
    const up = store.upserts.find((u) => u.table === "line_users");
    expect(up?.row.line_user_id).toBe("Uxyz");
    expect(up?.row.is_blocked).toBe(false);
    expect(up?.row.linked_at).toBe("2026-07-15T10:00:00.000Z");
    expect(up?.row.display_name).toBe("คุณลูกค้า");
    expect(up?.row.tenant_id).toBe("t-1");
  });

  it("follow ไม่มี client (ไม่มี LINE env) → upsert ได้แต่ไม่มี display_name", async () => {
    const store = eventJob({ type: "follow", source: { userId: "Uxyz" } });
    const summary = await processLineEventJobs({
      db: makeDb(store),
      getClient: () => null,
    });
    expect(summary.done).toBe(1);
    const up = store.upserts.find((u) => u.table === "line_users");
    expect(up?.row.line_user_id).toBe("Uxyz");
    expect(up?.row.display_name).toBeUndefined();
  });

  it("unfollow → mark is_blocked = true", async () => {
    const store = eventJob({ type: "unfollow", source: { userId: "Uxyz" } });
    const summary = await processLineEventJobs({ db: makeDb(store) });
    expect(summary.done).toBe(1);
    const upd = store.updates.find((u) => u.table === "line_users");
    expect(upd?.payload.is_blocked).toBe(true);
    expect(upd?.filters.line_user_id).toBe("Uxyz");
  });

  it("message → no-op แต่ปิดงาน (done)", async () => {
    const store = eventJob({ type: "message", source: { userId: "Uxyz" }, message: { type: "text", text: "hi" } });
    const summary = await processLineEventJobs({ db: makeDb(store) });
    expect(summary.done).toBe(1);
    expect(store.upserts).toHaveLength(0);
  });

  it("follow ไม่มี userId → retry (fail)", async () => {
    const store = eventJob({ type: "follow", source: {} });
    const summary = await processLineEventJobs({ db: makeDb(store) });
    expect(summary.failed).toBe(1);
  });
});
