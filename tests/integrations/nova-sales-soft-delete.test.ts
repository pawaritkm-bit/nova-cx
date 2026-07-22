import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  softDeleteCustomerByExternalRef,
  upsertCustomer,
} from "@/lib/integrations/nova-sales-service";
import type { CustomerUpsertPayload } from "@/lib/integrations/nova-sales";

/**
 * ทดสอบ delete-sync (soft-delete ลูกค้าตาม NOVA Sales):
 *   - deleted → soft-delete + เคลียร์ chat_groups.customer_id + คง responsible_employee_id
 *   - idempotent: ยิงลบซ้ำ / ไม่เจอ = no-op (ไม่ error)
 *   - cross-tenant: ลบข้าม tenant ไม่ได้ (ลูกค้า tenant อื่นต้องไม่ถูกแตะ)
 *   - upsert ปกติ (deleted ไม่ส่ง) ยังทำงานเหมือนเดิม
 *
 * mock Supabase client แบบ stateful ที่ "เข้าใจ" eq/is filter จริง แล้ว apply update
 * ลง store → assert ผลข้างเคียงได้ตรง (deleted_at/status/customer_id/responsible)
 */

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const CUSTOMER = "22222222-2222-2222-2222-222222222222";
const EMPLOYEE = "33333333-3333-3333-3333-333333333333";

type Row = Record<string, unknown>;
type Store = { data: Record<string, Row[]> };

class MockQB {
  private mode: "select" | "insert" | "update" = "select";
  private want: "single" | "maybe" | "list" = "list";
  private eqFilters: [string, unknown][] = [];
  private isFilters: [string, unknown][] = [];
  private payload: Row = {};
  private insertRow?: Row;
  constructor(private table: string, private store: Store) {}

  select() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.eqFilters.push([col, val]);
    return this;
  }
  is(col: string, val: unknown) {
    this.isFilters.push([col, val]);
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
  update(payload: Row) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  insert(row: Row | Row[]) {
    this.mode = "insert";
    this.insertRow = Array.isArray(row) ? row[0] : row;
    return this;
  }
  single() {
    this.want = "single";
    return Promise.resolve(this.run());
  }
  maybeSingle() {
    this.want = "maybe";
    return Promise.resolve(this.run());
  }
  then<T>(onF: (v: { data: unknown; error: unknown }) => T) {
    return Promise.resolve(this.run()).then(onF);
  }

  private rows(): Row[] {
    return this.store.data[this.table] ?? [];
  }
  private matched(): Row[] {
    return this.rows().filter(
      (r) =>
        this.eqFilters.every(([c, v]) => r[c] === v) &&
        this.isFilters.every(([c, v]) => (r[c] ?? null) === v)
    );
  }

  private run(): { data: unknown; error: unknown } {
    if (this.mode === "update") {
      for (const row of this.matched()) Object.assign(row, this.payload);
      return { data: null, error: null };
    }
    if (this.mode === "insert") {
      const row = { ...(this.insertRow ?? {}) };
      if (!("id" in row)) row.id = `${this.table}-${this.rows().length + 1}`;
      (this.store.data[this.table] ??= []).push(row);
      if (this.want === "single") return { data: { id: row.id }, error: null };
      return { data: null, error: null };
    }
    const matched = this.matched();
    if (this.want === "single" || this.want === "maybe") {
      return { data: matched[0] ?? null, error: null };
    }
    return { data: matched, error: null };
  }
}

function makeDb(store: Store): SupabaseClient {
  return {
    from(table: string) {
      return new MockQB(table, store);
    },
  } as unknown as SupabaseClient;
}

/** store ตั้งต้น: ลูกค้า 1 ราย (active) + กลุ่มแชท 1 กลุ่มที่ผูกลูกค้า + มีผู้ดูแล */
function makeStore(): Store {
  return {
    data: {
      customers: [
        {
          id: CUSTOMER,
          tenant_id: TENANT,
          external_ref: "EXT-1",
          name: "ลูกค้าเอ",
          status: "active",
          deleted_at: null,
        },
      ],
      chat_groups: [
        {
          id: "grp-1",
          tenant_id: TENANT,
          customer_id: CUSTOMER,
          responsible_employee_id: EMPLOYEE,
          deleted_at: null,
        },
      ],
      customer_assignments: [
        { id: "asg-1", tenant_id: TENANT, customer_id: CUSTOMER },
      ],
    },
  };
}

const customer = (s: Store) => s.data.customers[0];
const group = (s: Store) => s.data.chat_groups[0];

describe("softDeleteCustomerByExternalRef — ลบสำเร็จ", () => {
  it("soft-delete ลูกค้า + เคลียร์ chat_groups.customer_id + คง responsible_employee_id", async () => {
    const store = makeStore();

    const r = await softDeleteCustomerByExternalRef(makeDb(store), TENANT, "EXT-1");

    expect(r.deleted).toBe(true);
    expect(r.customerId).toBe(CUSTOMER);

    // ลูกค้าถูก soft-delete + status cancelled
    expect(customer(store).deleted_at).not.toBeNull();
    expect(customer(store).status).toBe("cancelled");

    // กลุ่มแชทถูกเคลียร์ customer_id แต่คงผู้ดูแล
    expect(group(store).customer_id).toBeNull();
    expect(group(store).responsible_employee_id).toBe(EMPLOYEE);

    // ไม่แตะ customer_assignments
    expect(store.data.customer_assignments[0].customer_id).toBe(CUSTOMER);
  });
});

describe("softDeleteCustomerByExternalRef — idempotent", () => {
  it("ยิงลบซ้ำ → ครั้งที่สอง no-op (deleted:false) ไม่ error", async () => {
    const store = makeStore();

    const r1 = await softDeleteCustomerByExternalRef(makeDb(store), TENANT, "EXT-1");
    const r2 = await softDeleteCustomerByExternalRef(makeDb(store), TENANT, "EXT-1");

    expect(r1.deleted).toBe(true);
    // ลบไปแล้ว (deleted_at != null) → หาไม่เจอ → no-op
    expect(r2.deleted).toBe(false);
    expect(r2.customerId).toBeNull();
  });

  it("ไม่พบ external_ref → no-op (deleted:false)", async () => {
    const store = makeStore();
    const r = await softDeleteCustomerByExternalRef(
      makeDb(store),
      TENANT,
      "EXT-ไม่มีจริง"
    );
    expect(r.deleted).toBe(false);
    expect(r.customerId).toBeNull();
    // ลูกค้าเดิมไม่ถูกแตะ
    expect(customer(store).deleted_at).toBeNull();
  });
});

describe("softDeleteCustomerByExternalRef — cross-tenant", () => {
  it("ลบด้วย tenant อื่น → ไม่เจอ (no-op) และลูกค้า tenant เดิมไม่ถูกแตะ", async () => {
    const store = makeStore();

    const r = await softDeleteCustomerByExternalRef(
      makeDb(store),
      OTHER_TENANT,
      "EXT-1"
    );

    expect(r.deleted).toBe(false);
    expect(r.customerId).toBeNull();
    // ลูกค้าของ tenant เดิมต้องยัง active + กลุ่มยังผูกอยู่
    expect(customer(store).deleted_at).toBeNull();
    expect(customer(store).status).toBe("active");
    expect(group(store).customer_id).toBe(CUSTOMER);
  });
});

describe("upsertCustomer — ยังทำงานปกติเมื่อไม่มี deleted", () => {
  it("ลูกค้าใหม่ (external_ref ยังไม่มี) → สร้างใหม่ status active", async () => {
    const store: Store = { data: { customers: [] } };

    const payload = {
      tenant_id: TENANT,
      external_customer_id: "EXT-NEW",
      name: "ลูกค้าใหม่",
    } as CustomerUpsertPayload;

    const r = await upsertCustomer(makeDb(store), payload);

    expect(r.created).toBe(true);
    expect(store.data.customers).toHaveLength(1);
    expect(store.data.customers[0].name).toBe("ลูกค้าใหม่");
    expect(store.data.customers[0].status).toBe("active");
    expect(store.data.customers[0].deleted_at ?? null).toBeNull();
  });
});
