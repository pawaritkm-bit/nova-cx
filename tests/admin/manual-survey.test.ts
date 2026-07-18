import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendManualSurvey, ManualSurveyError } from "@/lib/admin/manual-survey";

const T = "tenant-1";
const CUS = "cccccccc-cccc-cccc-cccc-cccccccccccc";

/**
 * Mock DB ครอบ pattern ที่ sendManualSurvey ใช้:
 *   customers(maybeSingle), survey_templates/versions(maybeSingle),
 *   customer_assignments/employees(await list), line_users(maybeSingle),
 *   survey_invitations insert(single), job_queue insert(await)
 * store.data ต่อ table + store.inserts เก็บ insert ไว้ตรวจ
 */
type Store = {
  data: Record<string, Record<string, unknown>[]>;
  inserts: { table: string; row: Record<string, unknown> }[];
};

function makeStore(data: Store["data"] = {}): Store {
  return { data, inserts: [] };
}

class QB {
  private mode: "select" | "insert" = "select";
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
  in() {
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
  insert(row: Record<string, unknown>) {
    this.mode = "insert";
    this.store.inserts.push({ table: this.table, row });
    return this;
  }
  single() {
    if (this.mode === "insert") return Promise.resolve({ data: { id: "inv-1" }, error: null });
    return Promise.resolve({ data: this.rows()[0] ?? null, error: null });
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows()[0] ?? null, error: null });
  }
  then<R>(onF: (v: { data: unknown; error: unknown }) => R) {
    if (this.mode === "insert") return Promise.resolve({ data: null, error: null }).then(onF);
    return Promise.resolve({ data: this.rows(), error: null }).then(onF);
  }
  private rows() {
    return this.store.data[this.table] ?? [];
  }
}

function makeDb(store: Store): SupabaseClient {
  return {
    from(table: string) {
      return new QB(table, store);
    },
  } as unknown as SupabaseClient;
}

/** ข้อมูล template A/B active + version พร้อมส่ง (getActiveVersionByType ผ่าน) */
function withActiveTemplate(extra: Store["data"] = {}): Store["data"] {
  return {
    customers: [{ id: CUS }],
    survey_templates: [{ id: "tpl-1", tenant_id: T, survey_type: "A", name: "t", is_active: true }],
    survey_versions: [{ id: "ver-1", tenant_id: T, template_id: "tpl-1", version_no: 1, published_at: "2026-01-01" }],
    ...extra,
  };
}

const deps = { now: () => new Date("2026-07-18T14:30:00Z"), generateToken: () => "tok-manual" };

describe("sendManualSurvey — ปุ่มส่งเอง", () => {
  it("ลูกค้าแอด OA (มี line_user) → push + enqueue notification, pushed=true", async () => {
    const store = makeStore(
      withActiveTemplate({ line_users: [{ id: "lu-1" }] })
    );
    const out = await sendManualSurvey(makeDb(store), T, { customerId: CUS, surveyType: "A" }, deps);

    expect(out.pushed).toBe(true);
    expect(out.surveyUrl).toContain("/liff/survey?token=tok-manual");

    const inv = store.inserts.find((i) => i.table === "survey_invitations");
    expect(inv?.row.survey_type).toBe("A");
    expect(inv?.row.line_user_id).toBe("lu-1");
    expect(String(inv?.row.cycle_period)).toMatch(/^manual:2026-07-18T14:30:/);
    expect(String(inv?.row.idempotency_key)).toMatch(/^manual:/);

    const job = store.inserts.find((i) => i.table === "job_queue");
    expect(job?.row.queue).toBe("notification");
    expect((job?.row.payload as { oa: string }).oa).toBe("care");
  });

  it("ลูกค้าไม่ได้แอด OA (ไม่มี line_user) → ไม่ push, คืนลิงก์ pushed=false", async () => {
    const store = makeStore(withActiveTemplate({ line_users: [] }));
    const out = await sendManualSurvey(makeDb(store), T, { customerId: CUS, surveyType: "A" }, deps);

    expect(out.pushed).toBe(false);
    expect(out.surveyUrl).toContain("token=tok-manual");
    // ไม่มี job_queue → ไม่ push
    expect(store.inserts.find((i) => i.table === "job_queue")).toBeUndefined();
    const inv = store.inserts.find((i) => i.table === "survey_invitations");
    expect(inv?.row.line_user_id).toBeNull();
  });

  it("ชนิด B → snapshot นักบัญชีผู้ดูแลปัจจุบัน + oa care", async () => {
    const store = makeStore({
      customers: [{ id: CUS }],
      survey_templates: [{ id: "tpl-b", tenant_id: T, survey_type: "B", name: "t", is_active: true }],
      survey_versions: [{ id: "ver-b", tenant_id: T, template_id: "tpl-b", version_no: 1, published_at: "2026-01-01" }],
      customer_assignments: [{ employee_id: "e1", role: "member" }],
      employees: [{ id: "e1", first_name: "สมหญิง", nickname: null, position: null }],
      line_users: [{ id: "lu-1" }],
    });
    const out = await sendManualSurvey(makeDb(store), T, { customerId: CUS, surveyType: "B" }, deps);

    expect(out.pushed).toBe(true);
    const inv = store.inserts.find((i) => i.table === "survey_invitations");
    expect(inv?.row.survey_type).toBe("B");
    expect(inv?.row.assignee_snapshot).toEqual([
      { employee_id: "e1", subject_role: "member", name: "สมหญิง" },
    ]);
    const job = store.inserts.find((i) => i.table === "job_queue");
    expect((job?.row.payload as { oa: string }).oa).toBe("care");
  });

  it("ชนิด C → oa sale + assignee_snapshot ว่าง (A/C/D ไม่ผูกบุคคล)", async () => {
    const store = makeStore({
      customers: [{ id: CUS }],
      survey_templates: [{ id: "tpl-c", tenant_id: T, survey_type: "C", name: "t", is_active: true }],
      survey_versions: [{ id: "ver-c", tenant_id: T, template_id: "tpl-c", version_no: 1, published_at: "2026-01-01" }],
      line_users: [{ id: "lu-1" }],
    });
    const out = await sendManualSurvey(makeDb(store), T, { customerId: CUS, surveyType: "C" }, deps);

    expect(out.pushed).toBe(true);
    const inv = store.inserts.find((i) => i.table === "survey_invitations");
    expect(inv?.row.assignee_snapshot).toEqual([]);
    const job = store.inserts.find((i) => i.table === "job_queue");
    expect((job?.row.payload as { oa: string }).oa).toBe("sale");
  });

  it("ลูกค้าไม่อยู่ tenant → ManualSurveyError (ไม่ insert)", async () => {
    const store = makeStore({ customers: [] }); // maybeSingle คืน null
    await expect(
      sendManualSurvey(makeDb(store), T, { customerId: CUS, surveyType: "A" }, deps)
    ).rejects.toBeInstanceOf(ManualSurveyError);
    expect(store.inserts.length).toBe(0);
  });

  it("ยังไม่ตั้งแบบฟอร์มชนิดนั้น → ManualSurveyError (ไม่ insert)", async () => {
    const store = makeStore({ customers: [{ id: CUS }], survey_templates: [], survey_versions: [] });
    await expect(
      sendManualSurvey(makeDb(store), T, { customerId: CUS, surveyType: "A" }, deps)
    ).rejects.toBeInstanceOf(ManualSurveyError);
    expect(store.inserts.find((i) => i.table === "survey_invitations")).toBeUndefined();
  });
});
