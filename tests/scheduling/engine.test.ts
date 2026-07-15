import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runScheduling } from "@/lib/scheduling/engine";

/**
 * Mock Supabase client เฉพาะ pattern ที่ engine ใช้:
 *   - select().eq().is().limit()  → thenable คืน array จาก store.data[table]
 *   - select().eq().maybeSingle() → คืน row แรกหรือ null (ใช้ตรวจ invitation ซ้ำ)
 *   - insert().select().single()  → คืน {id} หรือจำลอง 23505 (unique) ตาม flag
 *   - insert() (job_queue)        → resolve เฉย ๆ + บันทึกลง store.inserts
 *   - upsert()                    → resolve เฉย ๆ
 */
type Store = {
  data: Record<string, Record<string, unknown>[]>;
  inserts: { table: string; row: Record<string, unknown> }[];
  uniqueViolationOnInsert?: boolean;
};

function makeStore(data: Store["data"] = {}): Store {
  return { data, inserts: [] };
}

class MockQB {
  private mode: "select" | "insert" = "select";
  private want: "single" | "maybe" | "list" = "list";
  constructor(private table: string, private store: Store) {}

  select() {
    return this;
  }
  eq() {
    return this;
  }
  in() {
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
  insert(row: Record<string, unknown> | Record<string, unknown>[]) {
    this.mode = "insert";
    const rows = Array.isArray(row) ? row : [row];
    for (const r of rows) this.store.inserts.push({ table: this.table, row: r });
    return this;
  }
  upsert() {
    return Promise.resolve({ data: null, error: null });
  }
  single() {
    this.want = "single";
    return Promise.resolve(this.resolve());
  }
  maybeSingle() {
    this.want = "maybe";
    return Promise.resolve(this.resolve());
  }
  then<T>(onF: (v: { data: unknown; error: unknown }) => T) {
    return Promise.resolve(this.resolve()).then(onF);
  }

  private resolve(): { data: unknown; error: unknown } {
    if (this.mode === "insert") {
      if (this.store.uniqueViolationOnInsert && this.table === "survey_invitations") {
        return { data: null, error: { code: "23505", message: "duplicate" } };
      }
      if (this.want === "single") return { data: { id: "inv-new" }, error: null };
      return { data: null, error: null };
    }
    const rows = this.store.data[this.table] ?? [];
    if (this.want === "single" || this.want === "maybe") {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }
}

function makeDb(store: Store): SupabaseClient {
  return {
    from(table: string) {
      return new MockQB(table, store);
    },
  } as unknown as SupabaseClient;
}

const NOW = new Date("2026-07-15T00:00:00Z");
const deps = (store: Store) => ({
  db: makeDb(store),
  now: () => NOW,
  // inject version lookup — คืน version เสมอ (ยกเว้นทดสอบ noTemplate)
  getActiveVersion: async (_db: unknown, _t: unknown, type: unknown) => ({
    template: { id: `tpl-${type}` },
    version: { id: `ver-${type}` },
  }),
  generateToken: () => "tok-fixed",
});

const inserted = (store: Store, table: string) =>
  store.inserts.filter((i) => i.table === table).map((i) => i.row);

describe("runScheduling — A (สำนักงาน ราย 3 เดือน)", () => {
  it("ถึงรอบ → สร้าง invitation A + enqueue notification (oa care)", async () => {
    const store = makeStore({
      customers: [
        {
          id: "c1",
          tenant_id: "t1",
          service_start_date: "2026-01-15", // ครบ 6 เดือน ณ 2026-07-15 → รอบ 2
          status: "active",
          deleted_at: null,
        },
      ],
      survey_invitations: [], // ยังไม่มี → ไม่ existed
      line_users: [{ id: "lu1", is_blocked: false, linked_at: "2026-02-01" }],
      customer_assignments: [], // ไม่มีผู้ดูแล → B skip
    });

    const r = await runScheduling(deps(store) as never);

    expect(r.office.created).toBe(1);
    expect(r.accountant.skipped).toBe(1); // ไม่มี assignment

    const invs = inserted(store, "survey_invitations");
    expect(invs).toHaveLength(1);
    expect(invs[0].survey_type).toBe("A");
    expect(invs[0].cycle_period).toBe("A:2026-07-15");
    expect(invs[0].assignee_snapshot).toEqual([]); // A = ภาพรวม ไม่ผูกบุคคล
    expect(invs[0].token).toBe("tok-fixed");
    expect(typeof invs[0].idempotency_key).toBe("string");
    expect(invs[0].line_user_id).toBe("lu1"); // ผูก owner ที่ส่งได้

    const jobs = inserted(store, "job_queue");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].queue).toBe("notification");
    expect((jobs[0].payload as { oa: string }).oa).toBe("care");
  });

  it("มี invitation รอบนี้แล้ว → existed, ไม่สร้างซ้ำ (idempotent / FR-SC-05)", async () => {
    const store = makeStore({
      customers: [
        {
          id: "c1",
          tenant_id: "t1",
          service_start_date: "2026-01-15",
          status: "active",
          deleted_at: null,
        },
      ],
      survey_invitations: [{ id: "existing" }], // มีอยู่แล้ว
      line_users: [],
      customer_assignments: [],
    });

    const r = await runScheduling(deps(store) as never);
    expect(r.office.existed).toBe(1);
    expect(r.office.created).toBe(0);
    expect(inserted(store, "survey_invitations")).toHaveLength(0);
  });

  it("ยกเลิกบริการ (cancelled) → หยุด ไม่สร้าง (FR-SC-04)", async () => {
    const store = makeStore({
      customers: [
        {
          id: "c1",
          tenant_id: "t1",
          service_start_date: "2026-01-15",
          status: "cancelled",
          deleted_at: null,
        },
      ],
      survey_invitations: [],
      line_users: [],
      customer_assignments: [],
    });

    const r = await runScheduling(deps(store) as never);
    expect(r.office.skipped).toBe(1);
    expect(r.office.created).toBe(0);
    expect(inserted(store, "survey_invitations")).toHaveLength(0);
  });

  it("ยังไม่ตั้ง template A → นับ noTemplate ไม่สร้าง", async () => {
    const store = makeStore({
      customers: [
        {
          id: "c1",
          tenant_id: "t1",
          service_start_date: "2026-01-15",
          status: "active",
          deleted_at: null,
        },
      ],
      survey_invitations: [],
      line_users: [],
      customer_assignments: [],
    });

    const d = { ...deps(store), getActiveVersion: async () => null };
    const r = await runScheduling(d as never);
    expect(r.office.noTemplate).toBe(1);
    expect(r.office.created).toBe(0);
  });
});

describe("runScheduling — B (นักบัญชี รายเดือน) + snapshot ผู้ดูแล", () => {
  it("มีผู้ดูแล → สร้าง invitation B + snapshot รายชื่อ ณ ตอนนั้น (personal/OA care)", async () => {
    const store = makeStore({
      customers: [
        {
          id: "c1",
          tenant_id: "t1",
          service_start_date: "2026-07-01", // เพิ่งเริ่ม → A ยังไม่ถึงรอบ
          status: "active",
          deleted_at: null,
        },
      ],
      survey_invitations: [],
      line_users: [{ id: "lu1", is_blocked: false, linked_at: "2026-07-05" }],
      customer_assignments: [
        { employee_id: "e1", role: "lead" },
        { employee_id: "e2", role: "member" },
      ],
      employees: [
        { id: "e1", first_name: "สมชาย", nickname: "ชาย", position: "หัวหน้า" },
        { id: "e2", first_name: "สมหญิง", nickname: null, position: null },
      ],
    });

    const r = await runScheduling(deps(store) as never);

    expect(r.office.skipped).toBe(1); // A ยังไม่ถึงรอบ
    expect(r.accountant.created).toBe(1);

    const invs = inserted(store, "survey_invitations");
    expect(invs).toHaveLength(1);
    expect(invs[0].survey_type).toBe("B");
    expect(invs[0].cycle_period).toBe("B:2026-07");
    expect(invs[0].line_user_id).toBe("lu1");
    expect(invs[0].assignee_snapshot).toEqual([
      {
        employee_id: "e1",
        subject_role: "lead",
        name: "สมชาย",
        nickname: "ชาย",
        position: "หัวหน้า",
      },
      { employee_id: "e2", subject_role: "member", name: "สมหญิง" },
    ]);

    const jobs = inserted(store, "job_queue");
    expect((jobs[0].payload as { oa: string }).oa).toBe("care");
    expect((jobs[0].payload as { survey_type: string }).survey_type).toBe("B");
  });

  it("บล็อก OA ทั้งหมด → หยุด ไม่สร้าง B (FR-SC-04)", async () => {
    const store = makeStore({
      customers: [
        {
          id: "c1",
          tenant_id: "t1",
          service_start_date: "2026-07-01",
          status: "active",
          deleted_at: null,
        },
      ],
      survey_invitations: [],
      line_users: [{ id: "lu1", is_blocked: true, linked_at: "2026-07-05" }],
      customer_assignments: [{ employee_id: "e1", role: "member" }],
      employees: [{ id: "e1", first_name: "สมหญิง" }],
    });

    const r = await runScheduling(deps(store) as never);
    expect(r.accountant.skipped).toBe(1);
    expect(r.accountant.created).toBe(0);
    expect(inserted(store, "survey_invitations")).toHaveLength(0);
  });

  it("unique constraint ชนตอน insert (race) → existed ไม่ throw", async () => {
    const store = makeStore({
      customers: [
        {
          id: "c1",
          tenant_id: "t1",
          service_start_date: "2026-07-01",
          status: "active",
          deleted_at: null,
        },
      ],
      survey_invitations: [],
      line_users: [{ id: "lu1", is_blocked: false, linked_at: "2026-07-05" }],
      customer_assignments: [{ employee_id: "e1", role: "member" }],
      employees: [{ id: "e1", first_name: "สมหญิง" }],
    });
    store.uniqueViolationOnInsert = true;

    const r = await runScheduling(deps(store) as never);
    expect(r.accountant.existed).toBe(1);
    expect(r.accountant.created).toBe(0);
  });
});
