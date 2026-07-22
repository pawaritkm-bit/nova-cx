import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  upsertCustomer,
  upsertDealAndMaybeInvite,
} from "@/lib/integrations/nova-sales-service";
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

describe("upsertDealAndMaybeInvite — attribution เซลด้วยชื่อ", () => {
  it("Won + sales_employee_name ตรง 1 คน → invitation มี snapshot เซล (subject_role: sales) + response resolved", async () => {
    const store = makeStore();
    tplType(store, "C");
    store.data.employees = [
      {
        id: "emp-joe",
        tenant_id: TENANT,
        first_name: "สมชาย",
        nickname: "โจ",
        employee_type: "sales",
        is_active: true,
        deleted_at: null,
      },
    ];

    const r = await upsertDealAndMaybeInvite(makeDb(store), {
      ...dealPayload("won"),
      sales_employee_name: "โจ",
    } as DealStatusPayload);

    expect(r.salesEmployee?.resolved).toBe(true);
    const snap = invites(store)[0].row.assignee_snapshot as Row[];
    expect(snap).toHaveLength(1);
    expect(snap[0].employee_id).toBe("emp-joe");
    expect(snap[0].subject_role).toBe("sales");
    // opportunity ผูก sales_employee_id ที่ resolve ได้
    const opp = store.inserts.find((i) => i.table === "sales_opportunities");
    expect(opp?.row.sales_employee_id).toBe("emp-joe");
  });

  it("Won + ชื่อไม่เจอ → invitation ยังสร้างได้ (unattributed) + response reason=not_found", async () => {
    const store = makeStore();
    tplType(store, "C");
    store.data.employees = []; // ไม่มีพนักงานตรงชื่อ

    const r = await upsertDealAndMaybeInvite(makeDb(store), {
      ...dealPayload("won"),
      sales_employee_name: "ไม่มีจริง",
    } as DealStatusPayload);

    expect(r.salesEmployee?.resolved).toBe(false);
    expect(r.salesEmployee?.reason).toBe("not_found");
    // invitation ยังสร้าง (unattributed) — snapshot ว่าง
    expect(invites(store)).toHaveLength(1);
    expect(invites(store)[0].row.assignee_snapshot as Row[]).toHaveLength(0);
    expect(r.invitation?.token).toBeTruthy();
  });

  it("ไม่ส่งเซลมาเลย → response ไม่มี sales_employee (undefined)", async () => {
    const store = makeStore();
    tplType(store, "C");
    const r = await upsertDealAndMaybeInvite(makeDb(store), dealPayload("won"));
    expect(r.salesEmployee).toBeUndefined();
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

describe("upsertCustomer — NOVA Sales เป็นเจ้าของรหัส (ตัวที่เข้ามาได้รหัสจริงเสมอ)", () => {
  // mock customers แบบ stateful ที่จำลอง partial unique index (0042):
  //   unique (tenant_id, customer_code) where customer_code is not null and deleted_at is null
  type CRow = {
    id: string;
    tenant_id: string;
    external_ref: string | null;
    customer_code: string | null;
    deleted_at: string | null;
    name?: string;
    status?: string;
  };
  type CStore = { rows: CRow[]; seq: number };

  class CustomersMock {
    private eqFilters: { col: string; val: unknown }[] = [];
    private isFilters: { col: string; val: unknown }[] = [];
    private mode: "select" | "insert" | "update" = "select";
    private payload?: Record<string, unknown>;
    constructor(private store: CStore) {}

    select() { return this; }
    eq(col: string, val: unknown) { this.eqFilters.push({ col, val }); return this; }
    is(col: string, val: unknown) { this.isFilters.push({ col, val }); return this; }
    order() { return this; }
    limit() { return this; }
    insert(row: Record<string, unknown>) { this.mode = "insert"; this.payload = row; return this; }
    update(fields: Record<string, unknown>) { this.mode = "update"; this.payload = fields; return this; }

    private match(r: CRow): boolean {
      const rec = r as unknown as Record<string, unknown>;
      return (
        this.eqFilters.every((f) => rec[f.col] === f.val) &&
        this.isFilters.every((f) => rec[f.col] === f.val)
      );
    }

    single() { return Promise.resolve(this.exec("single")); }
    maybeSingle() { return Promise.resolve(this.exec("maybe")); }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T) {
      return Promise.resolve(this.exec("list")).then(onF);
    }

    private exec(want: "single" | "maybe" | "list"): { data: unknown; error: unknown } {
      if (this.mode === "insert") {
        const row = this.payload ?? {};
        const code = (row.customer_code as string | null) ?? null;
        // จำลอง partial unique: ชนเฉพาะเมื่อ code ไม่ null และมี active row ถือรหัสนี้อยู่
        if (code !== null) {
          const clash = this.store.rows.find(
            (r) =>
              r.tenant_id === row.tenant_id &&
              r.customer_code === code &&
              r.deleted_at === null
          );
          if (clash) {
            return { data: null, error: { code: "23505", message: "dup customer_code" } };
          }
        }
        const id = (row.id as string) ?? `cust-${++this.store.seq}`;
        this.store.rows.push({
          id,
          tenant_id: row.tenant_id as string,
          external_ref: (row.external_ref as string | null) ?? null,
          customer_code: code,
          deleted_at: (row.deleted_at as string | null) ?? null,
          name: row.name as string | undefined,
          status: row.status as string | undefined,
        });
        return { data: { id }, error: null };
      }
      if (this.mode === "update") {
        for (const r of this.store.rows) {
          if (this.match(r)) Object.assign(r, this.payload);
        }
        return { data: null, error: null };
      }
      const rows = this.store.rows.filter((r) => this.match(r));
      if (want === "single" || want === "maybe") return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }
  }

  function custDb(store: CStore): SupabaseClient {
    return {
      from(table: string) {
        if (table !== "customers") throw new Error(`unexpected table ${table}`);
        return new CustomersMock(store);
      },
    } as unknown as SupabaseClient;
  }

  const find = (s: CStore, ext: string) => s.rows.find((r) => r.external_ref === ext);

  it("(ก) รหัสชนกับ active คนอื่น → ตัวเก่าสละรหัส (code→null), ตัวใหม่ได้ payload.customer_code", async () => {
    const store: CStore = {
      rows: [
        { id: "cust-old", tenant_id: TENANT, external_ref: "EXT-OLD", customer_code: "P648", deleted_at: null },
      ],
      seq: 0,
    };
    const r = await upsertCustomer(custDb(store), {
      tenant_id: TENANT,
      external_customer_id: "EXT-NEW",
      customer_code: "P648",
      name: "ลูกค้าใหม่จาก NOVA Sales",
      status: "active",
    } as never);

    expect(r.created).toBe(true);
    // ตัวเก่าถูกปลดรหัส (สละให้ NOVA Sales)
    expect(find(store, "EXT-OLD")?.customer_code).toBeNull();
    // ตัวใหม่ได้รหัสจริง P648 (ไม่ bump เป็น P648-2)
    const created = find(store, "EXT-NEW");
    expect(created?.id).toBe(r.id);
    expect(created?.customer_code).toBe("P648");
  });

  it("(ข) external_ref race (row เดิม active) → update ตัวเดิม ไม่สร้างใหม่", async () => {
    const store: CStore = {
      rows: [
        { id: "cust-1", tenant_id: TENANT, external_ref: "EXT-1", customer_code: "N100", deleted_at: null, name: "เก่า" },
      ],
      seq: 0,
    };
    const r = await upsertCustomer(custDb(store), {
      tenant_id: TENANT,
      external_customer_id: "EXT-1",
      customer_code: "N100",
      name: "ชื่อใหม่",
      status: "active",
    } as never);

    expect(r.created).toBe(false);
    expect(r.id).toBe("cust-1");
    expect(store.rows).toHaveLength(1); // ไม่มีการ insert เพิ่ม
    expect(find(store, "EXT-1")?.name).toBe("ชื่อใหม่");
  });

  it("(ค) ไม่ชนอะไร → insert ปกติด้วย customer_code จริง", async () => {
    const store: CStore = { rows: [], seq: 0 };
    const r = await upsertCustomer(custDb(store), {
      tenant_id: TENANT,
      external_customer_id: "EXT-Z",
      customer_code: "P999",
      name: "ลูกค้าใหม่",
    } as never);

    expect(r.created).toBe(true);
    expect(store.rows).toHaveLength(1);
    expect(find(store, "EXT-Z")?.customer_code).toBe("P999");
  });

  it("(ง) update ตัวเดิม (external_ref เดิม) → เปลี่ยน customer_code ตาม payload", async () => {
    const store: CStore = {
      rows: [
        { id: "cust-2", tenant_id: TENANT, external_ref: "EXT-2", customer_code: "OLDCODE", deleted_at: null },
      ],
      seq: 0,
    };
    const r = await upsertCustomer(custDb(store), {
      tenant_id: TENANT,
      external_customer_id: "EXT-2",
      customer_code: "NEWCODE",
      name: "ลูกค้า",
    } as never);

    expect(r.created).toBe(false);
    expect(r.id).toBe("cust-2");
    expect(find(store, "EXT-2")?.customer_code).toBe("NEWCODE");
  });
});
