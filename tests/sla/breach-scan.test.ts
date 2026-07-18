import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { scanSlaBreaches } from "@/lib/sla/breach-scan";

/* ---------- Fake DB สำหรับ scanner ---------- */

type CaseRow = {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  owner_employee_id: string | null;
  level: string;
  status: string;
  first_responded_at: string | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
};

type Store = {
  cases: CaseRow[];
  existingEvents: Set<string>; // `${case_id}:${event_type}`
  eventInserts: { case_id: string; event_type: string }[];
  existingAlerts: Map<string, { id: string; level: string; escalated_at: string | null }>;
  alertInserts: Record<string, unknown>[];
  alertUpdates: { id: string; patch: Record<string, unknown> }[];
  jobInserts: Record<string, unknown>[];
  teams: { id: string; lead_employee_id: string | null }[];
  assignments: Record<string, unknown>[];
};

class QB {
  private op: "select" | "insert" | "update" = "select";
  private filters: Record<string, unknown> = {};
  private inFilter: { col: string; vals: unknown[] } | null = null;
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
  in(col: string, vals: unknown[]) {
    this.inFilter = { col, vals };
    return this;
  }
  is() {
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
  maybeSingle() {
    this.wantSingle = true;
    return this;
  }

  private result() {
    // ----- INSERT -----
    if (this.op === "insert") {
      if (this.table === "sla_events") {
        const key = `${this.payload.case_id}:${this.payload.event_type}`;
        if (this.store.existingEvents.has(key)) {
          return { data: null, error: { code: "23505" } };
        }
        this.store.existingEvents.add(key);
        this.store.eventInserts.push({
          case_id: this.payload.case_id as string,
          event_type: this.payload.event_type as string,
        });
        return { data: null, error: null };
      }
      if (this.table === "risk_alerts") {
        const caseId = this.payload.case_id as string;
        this.store.alertInserts.push(this.payload);
        this.store.existingAlerts.set(caseId, {
          id: `alert-${caseId}`,
          level: this.payload.level as string,
          escalated_at: (this.payload.escalated_at as string) ?? null,
        });
        return { data: null, error: null };
      }
      if (this.table === "job_queue") {
        this.store.jobInserts.push(this.payload);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }

    // ----- UPDATE -----
    if (this.op === "update") {
      if (this.table === "risk_alerts") {
        this.store.alertUpdates.push({
          id: this.filters.id as string,
          patch: this.payload,
        });
      }
      return { data: null, error: null };
    }

    // ----- SELECT -----
    if (this.table === "conversation_cases") {
      return { data: this.store.cases, error: null };
    }
    if (this.table === "risk_alerts") {
      const caseId = this.filters.case_id as string;
      const ex = this.store.existingAlerts.get(caseId) ?? null;
      return { data: ex, error: null };
    }
    if (this.table === "teams") {
      const t = this.store.teams.find((x) => x.id === this.filters.id) ?? null;
      return { data: t, error: null };
    }
    if (this.table === "customer_assignments") {
      const rows = this.store.assignments.filter(
        (r) => (r as { customer_id?: string }).customer_id === this.filters.customer_id
      );
      return { data: rows, error: null };
    }
    return { data: this.wantSingle ? null : [], error: null };
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
  } as unknown as SupabaseClient;
}

function baseStore(overrides: Partial<Store> = {}): Store {
  return {
    cases: [],
    existingEvents: new Set(),
    eventInserts: [],
    existingAlerts: new Map(),
    alertInserts: [],
    alertUpdates: [],
    jobInserts: [],
    teams: [],
    assignments: [],
    ...overrides,
  };
}

const NOW = new Date("2026-07-20T05:00:00Z"); // จันทร์ 12:00 ไทย

describe("scanSlaBreaches — SLA breach → event + alert + escalate (idempotent)", () => {
  it("เคสเลยกำหนดตอบครั้งแรก → response_breached + แจ้ง owner + alert orange", async () => {
    const store = baseStore({
      cases: [
        {
          id: "case-1",
          tenant_id: "t1",
          customer_id: "c1",
          owner_employee_id: "acc-emp",
          level: "high",
          status: "open",
          first_responded_at: null,
          first_response_due_at: "2026-07-20T02:00:00Z", // เลยมาแล้ว
          resolution_due_at: "2026-07-21T05:00:00Z", // ยังไม่ถึง
        },
      ],
    });
    const summary = await scanSlaBreaches({ db: makeDb(store), now: () => NOW });
    expect(summary.scanned).toBe(1);
    expect(summary.ownerNotified).toBe(1);
    expect(summary.escalated).toBe(0);
    expect(store.eventInserts.some((e) => e.event_type === "response_breached")).toBe(true);
    expect(store.jobInserts[0]).toMatchObject({
      queue: "case_notification",
      payload: { kind: "owner_breach", employee_id: "acc-emp" },
    });
    expect(store.alertInserts[0]).toMatchObject({ level: "orange" });
  });

  it("รันซ้ำ (event มีอยู่แล้ว) → ไม่ยิงแจ้งเตือนซ้ำ (idempotent)", async () => {
    const store = baseStore({
      cases: [
        {
          id: "case-1",
          tenant_id: "t1",
          customer_id: "c1",
          owner_employee_id: "acc-emp",
          level: "high",
          status: "open",
          first_responded_at: null,
          first_response_due_at: "2026-07-20T02:00:00Z",
          resolution_due_at: "2026-07-21T05:00:00Z",
        },
      ],
      existingEvents: new Set(["case-1:response_breached"]),
      existingAlerts: new Map([
        ["case-1", { id: "alert-case-1", level: "orange", escalated_at: null }],
      ]),
    });
    const summary = await scanSlaBreaches({ db: makeDb(store), now: () => NOW });
    expect(summary.ownerNotified).toBe(0);
    expect(store.jobInserts).toHaveLength(0);
  });

  it("เลยกำหนดปิดงาน → resolution_breached → escalate หัวหน้าทีม + alert red", async () => {
    const store = baseStore({
      cases: [
        {
          id: "case-2",
          tenant_id: "t1",
          customer_id: "c1",
          owner_employee_id: "acc-emp",
          level: "critical",
          status: "in_progress",
          first_responded_at: "2026-07-19T05:00:00Z", // ตอบแล้ว → ไม่นับ response
          first_response_due_at: "2026-07-19T04:00:00Z",
          resolution_due_at: "2026-07-20T01:00:00Z", // เลยมาแล้ว
        },
      ],
      teams: [{ id: "team-1", lead_employee_id: "lead-emp" }],
      assignments: [
        { customer_id: "c1", employee_id: "acc-emp", team_id: "team-1", role: "member", valid_from: "2026-01-01", valid_to: null },
      ],
    });
    const summary = await scanSlaBreaches({ db: makeDb(store), now: () => NOW });
    expect(summary.escalated).toBe(1);
    expect(store.eventInserts.some((e) => e.event_type === "resolution_breached")).toBe(true);
    // escalate ไป lead-emp ผ่าน assignment team → teams.lead_employee_id
    const escJob = store.jobInserts.find(
      (j) => (j.payload as { kind?: string }).kind === "lead_escalation"
    );
    expect(escJob).toBeDefined();
    expect((escJob!.payload as { employee_id?: string }).employee_id).toBe("lead-emp");
    expect(store.alertInserts[0]).toMatchObject({ level: "red" });
  });

  it("owner เป็นหัวหน้าทีมเอง → ไม่ escalate ไปหาตัวเอง", async () => {
    const store = baseStore({
      cases: [
        {
          id: "case-3",
          tenant_id: "t1",
          customer_id: "c1",
          owner_employee_id: "lead-emp",
          level: "high",
          status: "open",
          first_responded_at: "2026-07-19T05:00:00Z",
          first_response_due_at: "2026-07-19T04:00:00Z",
          resolution_due_at: "2026-07-20T01:00:00Z",
        },
      ],
      teams: [{ id: "team-1", lead_employee_id: "lead-emp" }],
      assignments: [
        { customer_id: "c1", employee_id: "lead-emp", team_id: "team-1", role: "lead", valid_from: "2026-01-01", valid_to: null },
      ],
    });
    const summary = await scanSlaBreaches({ db: makeDb(store), now: () => NOW });
    // event resolution_breached ยังบันทึก แต่ไม่ enqueue escalation (หัวหน้า=owner)
    expect(store.eventInserts.some((e) => e.event_type === "resolution_breached")).toBe(true);
    expect(summary.escalated).toBe(0);
    expect(store.jobInserts.filter((j) => (j.payload as { kind?: string }).kind === "lead_escalation")).toHaveLength(0);
  });

  it("ยังไม่ถึงกำหนด (ok) → ไม่มี event/alert", async () => {
    const store = baseStore({
      cases: [
        {
          id: "case-4",
          tenant_id: "t1",
          customer_id: "c1",
          owner_employee_id: "acc-emp",
          level: "high",
          status: "open",
          first_responded_at: null,
          first_response_due_at: "2026-07-25T05:00:00Z",
          resolution_due_at: "2026-07-26T05:00:00Z",
        },
      ],
    });
    const summary = await scanSlaBreaches({ db: makeDb(store), now: () => NOW });
    expect(summary.events).toBe(0);
    expect(summary.alerts).toBe(0);
    expect(store.jobInserts).toHaveLength(0);
  });
});
