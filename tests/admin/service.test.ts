import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTeam,
  createCustomer,
  updateCustomer,
  updateEmployee,
  createAssignment,
  deactivateTeam,
  setEmployeeActive,
  setCustomerAutoSurvey,
  deactivateCustomer,
  endAssignment,
} from "@/lib/admin/service";

const T = "tenant-1";
const UUID_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const UUID_E = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const UUID_TEAM = "aaaa1111-aaaa-1111-aaaa-111111111111";
const UUID_TEAM_OLD = "bbbb2222-bbbb-2222-bbbb-222222222222";

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
    not() {
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

  it("inject handles_customer_type (ทีมดูแลประเภทไหน) — null เมื่อไม่ระบุ", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, terminal }) => {
      if (table === "teams" && terminal === "single") return { data: { id: "team-2" } };
      return { data: null };
    }, cap);

    // ระบุ company
    await createTeam(db, T, {
      name: "ทีมนิติ",
      type: "accounting",
      handles_customer_type: "company",
    });
    let ins = cap.inserts.find((i) => i.table === "teams");
    expect(ins.payload.handles_customer_type).toBe("company");

    // ไม่ระบุ → null (ดูแลทั้งสอง)
    cap.inserts.length = 0;
    await createTeam(db, T, { name: "ทีมรวม", type: "accounting" });
    ins = cap.inserts.find((i) => i.table === "teams");
    expect(ins.payload.handles_customer_type).toBeNull();
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
    // ไม่ระบุประเภท → null (ยังไม่จัดประเภท)
    expect(ins.payload.customer_type).toBeNull();
  });

  it("inject customer_type เมื่อระบุ (company)", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, terminal }) => {
      if (table === "customers" && terminal === "single") return { data: { id: "cus-2" } };
      return { data: null };
    }, cap);
    await createCustomer(db, T, { name: "บริษัท ข", customer_type: "company" });
    const ins = cap.inserts.find((i) => i.table === "customers");
    expect(ins.payload.customer_type).toBe("company");
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

describe("updateCustomer — แก้ไขฟิลด์ลูกค้ารายคน", () => {
  it("update payload มีเฉพาะ key ที่ส่ง (undefined = ไม่แตะ) + สำเร็จเมื่อ 1 แถว", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, op, terminal }) => {
      if (table === "customers" && op === "update" && terminal === "await")
        return { data: [{ id: UUID_C }] };
      return { data: null };
    }, cap);

    await expect(
      updateCustomer(db, T, UUID_C, { name: "ชื่อใหม่", customer_code: "C-9" })
    ).resolves.toBeUndefined();
    const upd = cap.updates.find((u) => u.table === "customers");
    expect(upd.payload.name).toBe("ชื่อใหม่");
    expect(upd.payload.customer_code).toBe("C-9");
    // ไม่ได้ส่ง business_name/service_start_date → ต้องไม่อยู่ใน payload
    expect("business_name" in upd.payload).toBe(false);
    expect("service_start_date" in upd.payload).toBe(false);
  });

  it("null = เคลียร์ค่า (customer_code:null อยู่ใน payload)", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(() => ({ data: [{ id: UUID_C }] }), cap);
    await updateCustomer(db, T, UUID_C, { customer_code: null });
    const upd = cap.updates.find((u) => u.table === "customers");
    expect(upd.payload.customer_code).toBeNull();
  });

  it("customer_type: set เป็น individual อยู่ใน payload", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(() => ({ data: [{ id: UUID_C }] }), cap);
    await updateCustomer(db, T, UUID_C, { customer_type: "individual" });
    const upd = cap.updates.find((u) => u.table === "customers");
    expect(upd.payload.customer_type).toBe("individual");
  });

  it("customer_type: null = เคลียร์กลับเป็นยังไม่ระบุ (อยู่ใน payload)", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(() => ({ data: [{ id: UUID_C }] }), cap);
    await updateCustomer(db, T, UUID_C, { customer_type: null });
    const upd = cap.updates.find((u) => u.table === "customers");
    expect(upd.payload.customer_type).toBeNull();
  });

  it("ไม่ส่ง customer_type (undefined) → ไม่อยู่ใน payload (ไม่แตะ)", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(() => ({ data: [{ id: UUID_C }] }), cap);
    await updateCustomer(db, T, UUID_C, { name: "x" });
    const upd = cap.updates.find((u) => u.table === "customers");
    expect("customer_type" in upd.payload).toBe(false);
  });

  it("0 แถว (id ผิด/ข้าม tenant) → throw ไม่พบรายการ", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(() => ({ data: [] }), cap);
    await expect(updateCustomer(db, T, UUID_C, { name: "x" })).rejects.toThrow(
      /ไม่พบรายการที่ต้องการแก้ไข/
    );
  });

  it("รหัสลูกค้าซ้ำ (23505) → ข้อความสุภาพ", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(() => ({ error: { code: "23505", message: "duplicate" } }), cap);
    await expect(
      updateCustomer(db, T, UUID_C, { customer_code: "C-1" })
    ).rejects.toThrow(/รหัสลูกค้านี้ถูกใช้แล้ว/);
  });

  it("patch ว่าง → ยืนยันลูกค้ามีจริง (maybeSingle) แล้ว no-op ไม่ update", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, terminal }) => {
      if (table === "customers" && terminal === "maybeSingle") return { data: { id: UUID_C } };
      return { data: null };
    }, cap);
    await expect(updateCustomer(db, T, UUID_C, {})).resolves.toBeUndefined();
    expect(cap.updates.length).toBe(0);
  });

  it("patch ว่าง + ลูกค้าไม่พบใน tenant → throw", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, terminal }) => {
      if (table === "customers" && terminal === "maybeSingle") return { data: null };
      return { data: null };
    }, cap);
    await expect(updateCustomer(db, T, UUID_C, {})).rejects.toThrow(/ลูกค้า/);
  });
});

describe("updateEmployee — แก้ไขพนักงานรายคน + ย้ายทีม", () => {
  it("แก้ field: update payload เฉพาะ key ที่ส่ง + ไม่ส่ง teamId = ไม่แตะ team_members", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, op, terminal }) => {
      if (table === "employees" && op === "update" && terminal === "await")
        return { data: [{ id: UUID_E }] };
      return { data: null };
    }, cap);

    await expect(
      updateEmployee(db, T, UUID_E, {
        first_name: "สมชาย ใหม่",
        nickname: "ชาย",
        employee_type: "sales",
      })
    ).resolves.toBeUndefined();

    const upd = cap.updates.find((u) => u.table === "employees");
    expect(upd.payload.first_name).toBe("สมชาย ใหม่");
    expect(upd.payload.nickname).toBe("ชาย");
    expect(upd.payload.employee_type).toBe("sales");
    // ไม่ได้ส่ง position → ต้องไม่อยู่ใน payload
    expect("position" in upd.payload).toBe(false);
    // teamId undefined → ไม่แตะ team_members เลย
    expect(cap.inserts.find((i) => i.table === "team_members")).toBeUndefined();
    expect(cap.updates.find((u) => u.table === "team_members")).toBeUndefined();
  });

  it("nickname:null = เคลียร์ค่า (อยู่ใน payload)", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, op, terminal }) => {
      if (table === "employees" && op === "update" && terminal === "await")
        return { data: [{ id: UUID_E }] };
      return { data: null };
    }, cap);
    await updateEmployee(db, T, UUID_E, { nickname: null });
    const upd = cap.updates.find((u) => u.table === "employees");
    expect(upd.payload.nickname).toBeNull();
  });

  it("เปลี่ยนทีม: ปิด membership เดิม (valid_to=วันนี้) + insert ใหม่ role=member", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, op, terminal }) => {
      if (table === "employees" && op === "update" && terminal === "await")
        return { data: [{ id: UUID_E }] };
      // ตรวจทีมอยู่ tenant เดียวกัน
      if (table === "teams" && terminal === "maybeSingle")
        return { data: { id: UUID_TEAM } };
      // membership ปัจจุบัน = อยู่ทีมเก่า
      if (table === "team_members" && op === "select" && terminal === "await")
        return { data: [{ id: "m-old", team_id: UUID_TEAM_OLD }] };
      if (table === "team_members" && op === "update" && terminal === "await")
        return { error: null };
      if (table === "team_members" && op === "insert" && terminal === "await")
        return { error: null };
      return { data: null };
    }, cap);

    await expect(
      updateEmployee(db, T, UUID_E, { first_name: "x", teamId: UUID_TEAM })
    ).resolves.toBeUndefined();

    // ปิดของเดิม
    const tmUpd = cap.updates.find((u) => u.table === "team_members");
    expect(tmUpd.payload.valid_to).toBe(todayISO());
    // insert ทีมใหม่
    const tmIns = cap.inserts.find((i) => i.table === "team_members");
    expect(tmIns.payload.tenant_id).toBe(T);
    expect(tmIns.payload.team_id).toBe(UUID_TEAM);
    expect(tmIns.payload.employee_id).toBe(UUID_E);
    expect(tmIns.payload.role_in_team).toBe("member");
    expect(tmIns.payload.valid_from).toBe(todayISO());
  });

  it("teamId=null: เอาออกจากทีม (ปิดของเดิม, ไม่ insert ใหม่)", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, op, terminal }) => {
      // ไม่มี field employees ให้แก้ → ยืนยันพนักงานมีจริง (maybeSingle)
      if (table === "employees" && terminal === "maybeSingle")
        return { data: { id: UUID_E } };
      if (table === "team_members" && op === "select" && terminal === "await")
        return { data: [{ id: "m-old", team_id: UUID_TEAM_OLD }] };
      if (table === "team_members" && op === "update" && terminal === "await")
        return { error: null };
      return { data: null };
    }, cap);

    await expect(
      updateEmployee(db, T, UUID_E, { teamId: null })
    ).resolves.toBeUndefined();
    // ปิดของเดิม แต่ไม่ insert ใหม่
    expect(cap.updates.find((u) => u.table === "team_members")).toBeTruthy();
    expect(cap.inserts.find((i) => i.table === "team_members")).toBeUndefined();
  });

  it("อยู่ทีมเดิมอยู่แล้ว (teamId เท่ากับปัจจุบัน) → ไม่ปิด/ไม่ insert (no-op)", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, op, terminal }) => {
      if (table === "teams" && terminal === "maybeSingle")
        return { data: { id: UUID_TEAM } };
      if (table === "employees" && terminal === "maybeSingle")
        return { data: { id: UUID_E } };
      if (table === "team_members" && op === "select" && terminal === "await")
        return { data: [{ id: "m-cur", team_id: UUID_TEAM }] };
      return { data: null };
    }, cap);

    await updateEmployee(db, T, UUID_E, { teamId: UUID_TEAM });
    expect(cap.updates.find((u) => u.table === "team_members")).toBeUndefined();
    expect(cap.inserts.find((i) => i.table === "team_members")).toBeUndefined();
  });

  it("0 แถว (id ผิด/ข้าม tenant) เมื่อแก้ field → throw ไม่พบรายการ", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(() => ({ data: [] }), cap);
    await expect(
      updateEmployee(db, T, UUID_E, { first_name: "x" })
    ).rejects.toThrow(/ไม่พบรายการที่ต้องการแก้ไข/);
  });

  it("ย้ายเข้าทีมนอก tenant → throw (assertBelongsToTenant ทีมไม่พบ)", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, op, terminal }) => {
      if (table === "employees" && op === "update" && terminal === "await")
        return { data: [{ id: UUID_E }] };
      // teams maybeSingle → ไม่พบ (นอก tenant)
      if (table === "teams" && terminal === "maybeSingle") return { data: null };
      return { data: null };
    }, cap);

    await expect(
      updateEmployee(db, T, UUID_E, { first_name: "x", teamId: UUID_TEAM })
    ).rejects.toThrow(/ทีม/);
    // ต้องไม่ insert team_members เมื่อ guard ทีมไม่ผ่าน
    expect(cap.inserts.find((i) => i.table === "team_members")).toBeUndefined();
  });
});

describe("createAssignment — ตั้งผู้ดูแลกลุ่มแชตของลูกค้า (chat_groups)", () => {
  /** resolver มาตรฐาน: customer/employee valid, มีกลุ่ม N กลุ่ม, update สำเร็จ */
  function okDb(opts: {
    employeeType?: string;
    active?: boolean;
    groups?: { id: string }[];
    updated?: { id: string }[];
  } = {}) {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, op, terminal }) => {
      if (table === "customers" && terminal === "maybeSingle") return { data: { id: UUID_C } };
      if (table === "employees" && terminal === "maybeSingle")
        return {
          data: {
            id: UUID_E,
            employee_type: opts.employeeType ?? "accountant",
            is_active: opts.active ?? true,
          },
        };
      // find groups ของลูกค้า
      if (table === "chat_groups" && op === "select" && terminal === "await")
        return { data: opts.groups ?? [{ id: "g-1" }, { id: "g-2" }] };
      // update ตั้ง responsible
      if (table === "chat_groups" && op === "update" && terminal === "await")
        return { data: opts.updated ?? [{ id: "g-1" }, { id: "g-2" }] };
      return { data: null };
    }, cap);
    return { db, cap };
  }

  it("สำเร็จ: set responsible_employee_id บนทุกกลุ่มของลูกค้า + คืน groupCount", async () => {
    const { db, cap } = okDb();
    const out = await createAssignment(db, T, {
      customer_id: UUID_C,
      employee_id: UUID_E,
    });
    expect(out.groupCount).toBe(2);
    const upd = cap.updates.find((u) => u.table === "chat_groups");
    expect(upd.payload.responsible_employee_id).toBe(UUID_E);
    // ไม่เขียน customer_assignments อีกต่อไป
    expect(cap.inserts.length).toBe(0);
    expect(cap.updates.some((u) => u.table === "customer_assignments")).toBe(false);
  });

  it("ลูกค้ายังไม่มีกลุ่มแชต → error สุภาพ + ไม่แตะ update", async () => {
    const { db, cap } = okDb({ groups: [] });
    await expect(
      createAssignment(db, T, { customer_id: UUID_C, employee_id: UUID_E })
    ).rejects.toThrow(/ยังไม่มีกลุ่มแชต/);
    expect(cap.updates.some((u) => u.table === "chat_groups")).toBe(false);
  });

  it("พนักงานไม่ใช่นักบัญชี/CS → throw", async () => {
    const { db } = okDb({ employeeType: "sales" });
    await expect(
      createAssignment(db, T, { customer_id: UUID_C, employee_id: UUID_E })
    ).rejects.toThrow(/นักบัญชีหรือทีมบริการลูกค้า/);
  });

  it("พนักงานถูกปิดใช้งาน → throw", async () => {
    const { db } = okDb({ active: false });
    await expect(
      createAssignment(db, T, { customer_id: UUID_C, employee_id: UUID_E })
    ).rejects.toThrow(/ปิดใช้งาน/);
  });

  it("customer นอก tenant → throw ก่อนแตะกลุ่ม", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table, terminal }) => {
      if (table === "customers" && terminal === "maybeSingle") return { data: null };
      return { data: null };
    }, cap);
    await expect(
      createAssignment(db, T, { customer_id: UUID_C, employee_id: UUID_E })
    ).rejects.toThrow(/ลูกค้า/);
    expect(cap.updates.length).toBe(0);
  });
});

describe("mutation ที่ match 0 แถว → throw (ไม่คืน success เท็จ)", () => {
  const UUID_X = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  function dbAffected(rows: any[]) {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    // ทุก update terminal (await) คืน { data: rows }
    return makeDb(() => ({ data: rows }), cap);
  }

  it("deactivateTeam: id ไม่พบ (0 แถว) → throw ไม่พบรายการ", async () => {
    await expect(deactivateTeam(dbAffected([]), T, UUID_X)).rejects.toThrow(
      /ไม่พบรายการที่ต้องการแก้ไข/
    );
  });

  it("deactivateTeam: พบ 1 แถว → ผ่าน", async () => {
    await expect(deactivateTeam(dbAffected([{ id: UUID_X }]), T, UUID_X)).resolves.toBeUndefined();
  });

  it("setEmployeeActive: 0 แถว → throw", async () => {
    await expect(
      setEmployeeActive(dbAffected([]), T, UUID_X, false)
    ).rejects.toThrow(/ไม่พบรายการที่ต้องการแก้ไข/);
  });

  it("setCustomerAutoSurvey: 0 แถว → throw (id ผิด/ข้าม tenant)", async () => {
    await expect(
      setCustomerAutoSurvey(dbAffected([]), T, UUID_X, true)
    ).rejects.toThrow(/ไม่พบรายการที่ต้องการแก้ไข/);
  });

  it("setCustomerAutoSurvey: พบ → update auto_survey_enabled + scope tenant", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(() => ({ data: [{ id: UUID_X }] }), cap);
    await expect(
      setCustomerAutoSurvey(db, T, UUID_X, true)
    ).resolves.toBeUndefined();
    const upd = cap.updates.find((u) => u.table === "customers");
    expect(upd.payload.auto_survey_enabled).toBe(true);
  });

  it("endAssignment: 0 แถว → throw", async () => {
    await expect(endAssignment(dbAffected([]), T, UUID_X)).rejects.toThrow(
      /ไม่พบรายการที่ต้องการแก้ไข/
    );
  });

  it("deactivateCustomer: 0 แถว → throw (ก่อนถึง cascade)", async () => {
    await expect(deactivateCustomer(dbAffected([]), T, UUID_X)).rejects.toThrow(
      /ไม่พบรายการที่ต้องการแก้ไข/
    );
  });

  it("deactivateCustomer: พบ → ปิดลูกค้า + cascade ปิด assignment (valid_to=วันนี้)", async () => {
    const cap = { inserts: [] as any[], updates: [] as any[] };
    const db = makeDb(({ table }) => {
      if (table === "customers") return { data: [{ id: UUID_X }] };
      // cascade update customer_assignments → ไม่ error
      if (table === "customer_assignments") return { data: [], error: null };
      return { data: [] };
    }, cap);

    await expect(deactivateCustomer(db, T, UUID_X)).resolves.toBeUndefined();
    // ต้องมี update customer_assignments ที่ตั้ง valid_to = วันนี้ (cascade)
    const casUpd = cap.updates.find((u) => u.table === "customer_assignments");
    expect(casUpd).toBeTruthy();
    expect(casUpd.payload.valid_to).toBe(todayISO());
  });
});
