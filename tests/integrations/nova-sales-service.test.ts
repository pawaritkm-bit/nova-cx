import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertDealAndMaybeInvite } from "@/lib/integrations/nova-sales-service";
import type { DealStatusPayload } from "@/lib/integrations/nova-sales";

/**
 * ทดสอบพฤติกรรม Won (C) / Lost (D) ของ deal-status:
 *   - Won  → สร้าง invitation C + enqueue job_queue (push OA) + คืน token
 *   - Lost → สร้าง invitation D แต่ "ไม่" enqueue job_queue (ไม่ push OA) + คืน token
 *   - idempotent: ยิงซ้ำ external_deal_id เดิม → ไม่สร้าง invitation ซ้ำ, คืน token เดิม
 *
 * ใช้ mock Supabase client แบบ stateful เฉพาะ pattern ที่ service เรียก
 * (insert จะถูกดันเข้า store.data เพื่อให้ select รอบถัดไปเจอ → จำลอง idempotency จริง)
 */

const TENANT = "11111111-1111-1111-1111-111111111111";
const CUSTOMER = "22222222-2222-2222-2222-222222222222";

type Row = Record<string, unknown>;
type Store = {
  data: Record<string, Row[]>;
  inserts: { table: string; row: Row }[];
  seq: number;
};

function makeStore(): Store {
  return {
    data: {
      customers: [{ id: CUSTOMER, tenant_id: TENANT, deleted_at: null }],
      sales_opportunities: [],
      sales_status_history: [],
      survey_invitations: [],
      survey_templates: [
        { id: "tpl", tenant_id: TENANT, survey_type: "C", is_active: true },
      ],
      survey_versions: [
        { id: "ver", tenant_id: TENANT, template_id: "tpl", published_at: "x" },
      ],
      line_users: [], // prospect ไม่ได้แอด OA → ไม่มี line_user
    },
    inserts: [],
    seq: 0,
  };
}

class MockQB {
  private mode: "select" | "insert" = "select";
  private want: "single" | "maybe" | "list" = "list";
  private insertRow?: Row;
  constructor(private table: string, private store: Store) {}

  select() {
    return this;
  }
  eq() {
    return this;
  }
  is() {
    return this;
  }
  not() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  insert(row: Row | Row[]) {
    this.mode = "insert";
    this.insertRow = Array.isArray(row) ? row[0] : row;
    return this;
  }
  update() {
    // update ไม่มี terminal ในโค้ด (await ตรง ๆ) → เป็น thenable ที่ resolve เฉย ๆ
    return this;
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
      const row = { ...(this.insertRow ?? {}) };
      if (!("id" in row)) row.id = `${this.table}-${++this.store.seq}`;
      this.store.inserts.push({ table: this.table, row });
      // ดันเข้า store เพื่อให้ select รอบถัดไปเจอ (จำลอง persistence → idempotency)
      (this.store.data[this.table] ??= []).push(row);
      if (this.want === "single") return { data: { id: row.id }, error: null };
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

function tplType(store: Store, type: "C" | "D") {
  store.data.survey_templates = [
    { id: "tpl", tenant_id: TENANT, survey_type: type, is_active: true },
  ];
}

const jobs = (s: Store) => s.inserts.filter((i) => i.table === "job_queue");
const invites = (s: Store) =>
  s.inserts.filter((i) => i.table === "survey_invitations");

function dealPayload(status: DealStatusPayload["status"]): DealStatusPayload {
  return {
    tenant_id: TENANT,
    external_deal_id: "D-100",
    customer_id: CUSTOMER,
    status,
  } as DealStatusPayload;
}

describe("upsertDealAndMaybeInvite — Won (C)", () => {
  it("สร้าง invitation C + enqueue OA push job + คืน token", async () => {
    const store = makeStore();
    tplType(store, "C");

    const r = await upsertDealAndMaybeInvite(makeDb(store), dealPayload("won"));

    expect(r.invitation?.surveyType).toBe("C");
    expect(r.invitation?.token).toBeTruthy();
    // Won ต้องมี OA push job
    expect(jobs(store)).toHaveLength(1);
    expect(jobs(store)[0].row.queue).toBe("notification");
    const payload = jobs(store)[0].row.payload as Row;
    expect(payload.oa).toBe("sale");
    expect(payload.survey_type).toBe("C");
    // token ใน invitation ตรงกับ token ที่ถูก insert ลง survey_invitations
    expect(invites(store)[0].row.token).toBe(r.invitation?.token);
  });
});

describe("upsertDealAndMaybeInvite — Lost (D)", () => {
  it("สร้าง invitation D + คืน token แต่ 'ไม่' enqueue OA push job", async () => {
    const store = makeStore();
    tplType(store, "D");

    const r = await upsertDealAndMaybeInvite(makeDb(store), dealPayload("lost"));

    expect(r.invitation?.surveyType).toBe("D");
    expect(r.invitation?.token).toBeTruthy();
    // Lost ต้องไม่มี OA push job เลย
    expect(jobs(store)).toHaveLength(0);
    // แต่ยังสร้าง invitation อยู่
    expect(invites(store)).toHaveLength(1);
    expect(invites(store)[0].row.token).toBe(r.invitation?.token);
  });
});

describe("upsertDealAndMaybeInvite — idempotent", () => {
  it("ยิงซ้ำ external_deal_id เดิม (Lost) → ไม่สร้าง invitation ซ้ำ, token เดิม, ไม่ push", async () => {
    const store = makeStore();
    tplType(store, "D");

    const r1 = await upsertDealAndMaybeInvite(makeDb(store), dealPayload("lost"));
    const r2 = await upsertDealAndMaybeInvite(makeDb(store), dealPayload("lost"));

    expect(r1.invitation?.created).toBe(true);
    expect(r2.invitation?.created).toBe(false);
    expect(r2.invitation?.token).toBe(r1.invitation?.token);
    // insert survey_invitations แค่ครั้งเดียว
    expect(invites(store)).toHaveLength(1);
    // ยังคงไม่มี OA push job (D)
    expect(jobs(store)).toHaveLength(0);
  });
});
