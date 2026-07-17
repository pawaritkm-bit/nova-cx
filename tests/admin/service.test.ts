import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTeam,
  createCustomer,
  createAssignment,
} from "@/lib/admin/service";

const T = "tenant-1";
const UUID_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const UUID_E = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

/**
 * ผลลัพธ์ที่ resolver จะคืนต่อ (table, op, terminal)
 *   terminal: "single" | "maybeSingle" | "await"
 * capture: เก็บ insert/update payload ไว้ตรวจ tenant inject/valid_from
 */
type Resolver = (q: {
  table: string;
  op: string;
  terminal: string;
  payload: unknown;
}) => { data?: unknown; error?: unknown };

function makeDb(resolver: Resolver, capture: { inserts: any[]; updates: any[] }) {
  class Query {
    op: string | undefined;
    payload: unknown;
    constructor(public table: string) {}
    select() {
      if (!this.op) this.op = "select";
      return this;
    }
    insert(p: unknown) {
      this.op = "insert";
      this.payload = p;
      capture.inserts.push({ table: this.table, payload: p });
      return this;
    }
    update(p: unknown) {
      this.op = "update";
      this.payload = p;
      capture.updates.push({ table: this.table, payload: p });
      return this;
    }
    eq() {
      return this;
    }
    is() {
      return this;
    }
    in() {
      return this;
    }
    order() {
      return this;
    }
    single() {
      return Promise.resolve(
        resolver({ table: this.table, op: this.op ?? "select", terminal: "single", payload: this.payload })
      );
    }
    maybeSingle() {
      return Promise.resolve(
        resolver({ table: this.table, op: this.op ?? "select", terminal: "maybeSingle", payload: this.payload })
      );
    }
    then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
      return Promise.resolve(
        resolver({ table: this.table, op: this.op ?? "select", terminal: "await", payload: this.payload })
      ).then(onF, onR);
    }
  }
  return {
    from(table: string) {
      return new Query(table);
    },
  } as unknown as SupabaseClient;
}

const todayISO = () => new Date().toISOString().slice(0, 10);

describe("createTeam — inject tenant_id จาก session เท่านั้น", () => {
  it("insert payload มี tenant_id = tenantId ที่ส่งเข้า", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, terminal }) => {
      if (table === "teams" && terminal === "single") return { data: { id: "team-1" } };
      return { data: null };
    }, cap);

    const out = await createTeam(db, T, { name: "ทีม A", type: "accounting" });
    expect(out.id).toBe("team-1");
    const ins = cap.inserts.find((i) => i.table === "teams");
    expect(ins.payload.tenant_id).toBe(T);
    expect(ins.payload.name).toBe("ทีม A");
    expect(ins.payload.type).toBe("accounting");
  });

  it("lead_employee_id นอก tenant → throw (assertBelongsToTenant ไม่พบ)", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, terminal }) => {
      // employees maybeSingle → ไม่พบ
      if (table === "employees" && terminal === "maybeSingle") return { data: null };
      return { data: null };
    }, cap);

    await expect(
      createTeam(db, T, { name: "x", type: "sales", lead_employee_id: UUID_E })
    ).rejects.toThrow(/หัวหน้าทีม/);
    // ต้องไม่ insert ทีมเมื่อ guard ไม่ผ่าน
    expect(cap.inserts.find((i) => i.table === "teams")).toBeUndefined();
  });
});

describe("createCustomer", () => {
  it("inject tenant_id + status active", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, terminal }) => {
      if (table === "customers" && terminal === "single") return { data: { id: "cus-1" } };
      return { data: null };
    }, cap);

    await createCustomer(db, T, { name: "บริษัท ก" });
    const ins = cap.inserts.find((i) => i.table === "customers");
    expect(ins.payload.tenant_id).toBe(T);
    expect(ins.payload.status).toBe("active");
  });

  it("รหัสลูกค้าซ้ำ (23505) → ข้อความสุภาพ", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, terminal }) => {
      if (table === "customers" && terminal === "single")
        return { error: { code: "23505", message: "duplicate" } };
      return { data: null };
    }, cap);

    await expect(createCustomer(db, T, { name: "x", customer_code: "C-1" })).rejects.toThrow(
      /รหัสลูกค้านี้ถูกใช้แล้ว/
    );
  });
});

describe("createAssignment — กันชน unique ผู้ดูแลปัจจุบัน", () => {
  it("ไม่มีของเดิม → insert อย่างเดียว, replacedPrevious=false, valid_from=วันนี้", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, op, terminal }) => {
      if (table === "customers" && terminal === "maybeSingle") return { data: { id: UUID_C } };
      if (table === "employees" && terminal === "maybeSingle") return { data: { id: UUID_E } };
      // find existing (await) → ว่าง
      if (table === "customer_assignments" && op === "select" && terminal === "await")
        return { data: [] };
      if (table === "customer_assignments" && op === "insert" && terminal === "single")
        return { data: { id: "as-1" } };
      return { data: null };
    }, cap);

    const out = await createAssignment(db, T, {
      customer_id: UUID_C,
      employee_id: UUID_E,
      role: "member",
    });
    expect(out.replacedPrevious).toBe(false);
    expect(out.id).toBe("as-1");
    // ไม่มี update (ไม่ต้องปิดของเดิม)
    expect(cap.updates.length).toBe(0);
    const ins = cap.inserts.find((i) => i.table === "customer_assignments");
    expect(ins.payload.tenant_id).toBe(T);
    expect(ins.payload.valid_from).toBe(todayISO());
    expect(ins.payload.role).toBe("member");
  });

  it("มีคู่เดิมอยู่ → ปิดของเดิม (update valid_to) ก่อน insert, replacedPrevious=true", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, op, terminal }) => {
      if (table === "customers" && terminal === "maybeSingle") return { data: { id: UUID_C } };
      if (table === "employees" && terminal === "maybeSingle") return { data: { id: UUID_E } };
      if (table === "customer_assignments" && op === "select" && terminal === "await")
        return { data: [{ id: "old-1" }] };
      if (table === "customer_assignments" && op === "update" && terminal === "await")
        return { error: null };
      if (table === "customer_assignments" && op === "insert" && terminal === "single")
        return { data: { id: "as-2" } };
      return { data: null };
    }, cap);

    const out = await createAssignment(db, T, {
      customer_id: UUID_C,
      employee_id: UUID_E,
      role: "lead",
    });
    expect(out.replacedPrevious).toBe(true);
    // มีการปิดของเดิม 1 ครั้ง (set valid_to)
    const upd = cap.updates.find((u) => u.table === "customer_assignments");
    expect(upd.payload.valid_to).toBe(todayISO());
    // แล้วจึง insert ใหม่
    expect(cap.inserts.find((i) => i.table === "customer_assignments")).toBeTruthy();
  });

  it("customer นอก tenant → throw ก่อนแตะ insert", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, terminal }) => {
      if (table === "customers" && terminal === "maybeSingle") return { data: null };
      return { data: null };
    }, cap);

    await expect(
      createAssignment(db, T, { customer_id: UUID_C, employee_id: UUID_E, role: "member" })
    ).rejects.toThrow(/ลูกค้า/);
    expect(cap.inserts.length).toBe(0);
  });
});
