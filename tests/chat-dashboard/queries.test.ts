import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getMeChatDashboard,
  getCaseChatView,
  getRiskDashboard,
  summarizeExecCases,
  computeOwnerBacklog,
  topProblemsFromViolations,
  computeRepeatRate,
  attributeExpertViolations,
  buildGroupSingleOwner,
} from "@/lib/chat-dashboard/queries";
import type { ConversationCaseRow } from "@/lib/chat-dashboard/types";
import type { Viewer } from "@/lib/evaluation/access";

const H = 3_600_000;
const NOW = Date.parse("2026-07-18T12:00:00Z");

type Filter = [string, string, unknown];
type CallRec = { table: string; filters: Filter[] };

/** fake db แบบ chainable + thenable (บันทึก eq/in ต่อ table) */
function makeDb(dataByTable: Record<string, unknown[]>, calls: CallRec[]): SupabaseClient {
  const make = (table: string) => {
    const rec: CallRec = { table, filters: [] };
    calls.push(rec);
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => {
      rec.filters.push(["eq", c, v]);
      return b;
    };
    b.in = (c: string, v: unknown) => {
      rec.filters.push(["in", c, v]);
      return b;
    };
    b.is = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.maybeSingle = () =>
      Promise.resolve({ data: (dataByTable[table] ?? [])[0] ?? null, error: null });
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: dataByTable[table] ?? [], error: null }).then(res, rej);
    return b;
  };
  return { from: (t: string) => make(t) } as unknown as SupabaseClient;
}

const accountant = (id: string): Viewer => ({ role: "accountant", employeeId: id, tenantId: "t1" });
const hr: Viewer = { role: "hr", employeeId: "hr1", tenantId: "t1" };

function hasFilter(calls: CallRec[], table: string, kind: string, col: string, val: unknown): boolean {
  return calls.some(
    (c) =>
      c.table === table &&
      c.filters.some(([k, cc, vv]) => k === kind && cc === col && JSON.stringify(vv) === JSON.stringify(val))
  );
}

describe("getMeChatDashboard — ★ accountant เห็นเฉพาะของตัวเอง (scoped query)", () => {
  it("บังคับ eq owner_employee_id ของตัวเอง บนเคส + eq employee_id บน eval", async () => {
    const calls: CallRec[] = [];
    const db = makeDb(
      {
        conversation_cases: [],
        accountant_evaluations: [],
        coaching_recommendations: [],
      },
      calls
    );
    await getMeChatDashboard(db, accountant("e1"), NOW);
    // ★ เคสถูก scope ด้วย owner = e1 (ไม่ใช่ทั้ง tenant)
    expect(hasFilter(calls, "conversation_cases", "eq", "owner_employee_id", "e1")).toBe(true);
    // ★ eval ถูก scope ด้วย employee_id = e1
    expect(hasFilter(calls, "accountant_evaluations", "eq", "employee_id", "e1")).toBe(true);
  });

  it("hr (ไม่มี owner scope) → คืนค่าว่าง ไม่ query เคส", async () => {
    const calls: CallRec[] = [];
    const db = makeDb({}, calls);
    const d = await getMeChatDashboard(db, hr, NOW);
    expect(d.myCases).toEqual([]);
    // ต้องไม่มีการ query conversation_cases เลย (default-deny ก่อน fetch)
    expect(calls.some((c) => c.table === "conversation_cases")).toBe(false);
  });
});

describe("getRiskDashboard — scope ต่อบทบาท", () => {
  it("accountant → eq owner_employee_id ตัวเอง", async () => {
    const calls: CallRec[] = [];
    const db = makeDb(
      {
        risk_alerts: [
          {
            id: "r1",
            case_id: "c1",
            customer_id: "cust1",
            level: "red",
            reason: "ทวงซ้ำ",
            owner_employee_id: "e1",
            status: "open",
            escalated_at: null,
          },
        ],
        employees: [{ id: "e1", first_name: "พิม", nickname: "พิม" }],
        customers: [{ id: "cust1", customer_code: "CUST-001" }],
      },
      calls
    );
    const rows = await getRiskDashboard(db, accountant("e1"));
    expect(hasFilter(calls, "risk_alerts", "eq", "owner_employee_id", "e1")).toBe(true);
    // ★ pseudonymity: แสดงรหัสลูกค้า ไม่ใช่ชื่อจริง
    expect(rows[0].customerLabel).toBe("CUST-001");
    expect(rows[0].ownerName).toBe("พิม");
  });

  it("★ hr → deny → คืน [] ไม่ query risk_alerts", async () => {
    const calls: CallRec[] = [];
    const db = makeDb({}, calls);
    const rows = await getRiskDashboard(db, hr);
    expect(rows).toEqual([]);
    expect(calls.some((c) => c.table === "risk_alerts")).toBe(false);
  });
});

describe("getCaseChatView — ★ กันข้ามเจ้าของ + hr เข้าไม่ได้", () => {
  it("hr → denied (scope deny, ไม่ query)", async () => {
    const calls: CallRec[] = [];
    const db = makeDb({}, calls);
    const v = await getCaseChatView(db, hr, "case-1");
    expect(v.denied).toBe(true);
    expect(v.canDecrypt).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("accountant เปิดเคสที่ไม่ใช่ของตัวเอง → denied", async () => {
    const calls: CallRec[] = [];
    const db = makeDb(
      {
        conversation_cases: [
          { id: "case-1", chat_group_id: "g1", owner_employee_id: "e2", status: "open", level: "high", resolution_due_at: null },
        ],
      },
      calls
    );
    const v = await getCaseChatView(db, accountant("e1"), "case-1");
    expect(v.denied).toBe(true);
  });
});

// ---------------------------------------------------------------------
// aggregation helpers (บริสุทธิ์)
// ---------------------------------------------------------------------
function mkCase(over: Partial<ConversationCaseRow>): ConversationCaseRow {
  return {
    id: "x",
    customer_id: null,
    chat_group_id: "g",
    owner_employee_id: null,
    title: null,
    summary: null,
    status: "open",
    urgency: null,
    level: "high",
    first_response_due_at: null,
    resolution_due_at: null,
    first_responded_at: null,
    opened_at: new Date(NOW).toISOString(),
    closed_at: null,
    ...over,
  };
}

describe("summarizeExecCases", () => {
  it("นับ open/overdue/urgent/newToday ถูกต้อง", () => {
    const cases = [
      mkCase({ id: "1", status: "open", level: "critical", resolution_due_at: new Date(NOW - 2 * H).toISOString() }), // open+urgent+overdue
      mkCase({ id: "2", status: "in_progress", level: "high", resolution_due_at: new Date(NOW + 5 * H).toISOString() }), // open+urgent
      mkCase({ id: "3", status: "closed", level: "critical", resolution_due_at: null }), // ปิด → ไม่นับ open
      mkCase({ id: "4", status: "open", level: "medium", resolution_due_at: null, opened_at: new Date(NOW - 40 * H).toISOString() }), // open ไม่ urgent, ไม่ใช่วันนี้
    ];
    const s = summarizeExecCases(cases, NOW);
    expect(s.openCases).toBe(3);
    expect(s.urgentCases).toBe(2);
    expect(s.overdueCases).toBe(1);
    // opened วันนี้ = case 1,2,3 (NOW), case 4 = 40 ชม.ก่อน → 3
    expect(s.newTodayCases).toBe(3);
    expect(s.casesByStatus.open).toBe(2);
  });
});

describe("computeOwnerBacklog", () => {
  it("รวมงานค้าง+เกิน ต่อ owner เรียงมาก→น้อย + map ชื่อ", () => {
    const names = new Map([["a", "แมน"], ["b", "นุ่น"]]);
    const cases = [
      mkCase({ id: "1", owner_employee_id: "a", status: "open", resolution_due_at: new Date(NOW - H).toISOString() }),
      mkCase({ id: "2", owner_employee_id: "a", status: "in_progress", resolution_due_at: null }),
      mkCase({ id: "3", owner_employee_id: "b", status: "open", resolution_due_at: null }),
      mkCase({ id: "4", owner_employee_id: "a", status: "closed", resolution_due_at: null }), // ปิด → ไม่นับ
    ];
    const bl = computeOwnerBacklog(cases, NOW, names);
    expect(bl[0]).toEqual({ employeeId: "a", name: "แมน", open: 2, overdue: 1 });
    expect(bl[1]).toEqual({ employeeId: "b", name: "นุ่น", open: 1, overdue: 0 });
  });
});

describe("topProblemsFromViolations", () => {
  it("นับตามชนิด + แปลป้ายไทย + เรียงมาก→น้อย", () => {
    const v = [
      { violation_type: "slow_reply" },
      { violation_type: "slow_reply" },
      { violation_type: "repeat_doc_request" },
    ];
    const top = topProblemsFromViolations(v);
    expect(top[0]).toEqual({ label: "ตอบช้าเกิน SLA", count: 2 });
    expect(top[1].count).toBe(1);
  });
});

describe("computeRepeatRate — ★ M2 เศษ/ส่วนมาจากชุดเดียว (เคสเปิด)", () => {
  it("นับเคสเปิดที่กลุ่มมี repeat_doc_request ÷ เคสเปิดทั้งหมด", () => {
    const openCases = [
      mkCase({ id: "1", chat_group_id: "g1" }),
      mkCase({ id: "2", chat_group_id: "g2" }),
      mkCase({ id: "3", chat_group_id: "g3" }),
      mkCase({ id: "4", chat_group_id: "g4" }),
    ];
    const violations = [
      { violation_type: "repeat_doc_request", chat_group_id: "g1" },
      { violation_type: "repeat_doc_request", chat_group_id: "g2" },
      { violation_type: "slow_reply", chat_group_id: "g3" }, // ไม่นับ (คนละชนิด)
      { violation_type: "repeat_doc_request", chat_group_id: "gX" }, // กลุ่มไม่มีเคสเปิด → ไม่นับ
    ];
    // 2 ใน 4 เคสเปิด → 0.5
    expect(computeRepeatRate(openCases, violations)).toBe(0.5);
  });
  it("ไม่มีเคสเปิด → null", () => {
    expect(computeRepeatRate([], [{ violation_type: "repeat_doc_request", chat_group_id: "g1" }])).toBeNull();
  });
  it("หลาย violation ในกลุ่มเดียว นับเคสเดียว (ไม่ปนหน่วย/ไม่เกิน 1)", () => {
    const openCases = [mkCase({ id: "1", chat_group_id: "g1" })];
    const violations = [
      { violation_type: "repeat_doc_request", chat_group_id: "g1" },
      { violation_type: "repeat_doc_request", chat_group_id: "g1" },
      { violation_type: "repeat_doc_request", chat_group_id: "g1" },
    ];
    expect(computeRepeatRate(openCases, violations)).toBe(1);
  });
});

describe("attributeExpertViolations — ★ M1 attribute ต่อเคส→owner (ไม่ last-write-wins ที่กลุ่ม)", () => {
  it("กลุ่มเดียวมี 2 เคสคนละเจ้าของ → violation โยนตามข้อความ (evidence) ไม่ใช่เจ้าของคนสุดท้าย", () => {
    // g1 มีเคส c1(owner a) + c2(owner b) → group ambiguous
    const cases = [
      { chat_group_id: "g1", owner_employee_id: "a" },
      { chat_group_id: "g1", owner_employee_id: "b" },
    ];
    const groupSingleOwner = buildGroupSingleOwner(cases);
    expect(groupSingleOwner.has("g1")).toBe(false); // ★ กลุ่มหลายเจ้าของ = ไม่ fallback

    // message m1 อยู่ในเคสของ a, m2 อยู่ในเคสของ b
    const messageOwner = new Map([
      ["m1", "a"],
      ["m2", "b"],
    ]);
    const violations = [
      { evidence_message_id: "m1", chat_group_id: "g1" }, // → a
      { evidence_message_id: "m2", chat_group_id: "g1" }, // → b
      { evidence_message_id: null, chat_group_id: "g1" }, // ระบุไม่ได้ (กลุ่ม ambiguous) → ข้าม
    ];
    const res = attributeExpertViolations(violations, messageOwner, groupSingleOwner);
    expect(res.get("a")).toBe(1);
    expect(res.get("b")).toBe(1);
    // ★ ไม่มีใครได้ 2 (เดิม last-write-wins จะโยนทั้งหมดให้ b)
    expect([...res.values()].every((n) => n === 1)).toBe(true);
  });

  it("กลุ่ม owner เดียว → fallback ใช้ groupSingleOwner เมื่อ violation ไม่มี evidence", () => {
    const cases = [{ chat_group_id: "g9", owner_employee_id: "z" }];
    const groupSingleOwner = buildGroupSingleOwner(cases);
    const res = attributeExpertViolations(
      [{ evidence_message_id: null, chat_group_id: "g9" }],
      new Map(),
      groupSingleOwner
    );
    expect(res.get("z")).toBe(1);
  });
});
