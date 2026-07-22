import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getMeChatDashboard,
  getCaseChatView,
  getRiskDashboard,
  getExecChatDashboard,
  summarizeExecCases,
  computeOwnerBacklog,
  topProblemsFromViolations,
  computeRepeatRate,
  attributeExpertViolations,
  buildGroupSingleOwner,
  parseProblems,
  computeCareHealth7d,
  buildIncidents,
  countAiPendingReview,
  latestAnalysisByGroup,
  hasRealProblem,
  firstRealProblem,
  realProblemsOf,
  type GroupAnalysis,
} from "@/lib/chat-dashboard/queries";
import type { ChatProblem } from "@/lib/chat-dashboard/types";
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
        // ★ ต้องมี analysis เจอปัญหาจริง แถวถึงจะผ่านตัวกรอง
        conversation_cases: [{ id: "c1", chat_group_id: "g1", customer_id: "cust1", owner_employee_id: "e1" }],
        chat_groups: [{ id: "g1", customer_id: "cust1", responsible_employee_id: "e1" }],
        ai_chat_analysis: [
          { chat_group_id: "g1", summary: "ทวงซ้ำ", problems: [{ type: "sla_risk", detail: "ทวงเอกสารซ้ำ 3 ครั้ง" }], insufficient_data: false, window_end: "2026-07-18T00:00:00Z" },
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

describe("computeOwnerBacklog — ★ นับเฉพาะเคสเปิดที่ AI เจอปัญหาจริง", () => {
  const realProblem = (detail: string): GroupAnalysis => ({
    problems: [{ type: "sla_risk", detail }],
    summary: null,
    insufficientData: false,
  });
  // g1,g2,g3 มีปัญหาจริง; g-noise = other/ข้อมูลไม่พอ (ต้องไม่ถูกนับ)
  const analysis = new Map<string, GroupAnalysis>([
    ["g1", realProblem("ยังไม่ตอบ 3 ชม.")],
    ["g2", realProblem("ยังไม่ตอบ")],
    ["g3", realProblem("ทวงซ้ำ")],
    ["g-other", { problems: [{ type: "other", detail: "ข้อมูลน้อย" }], summary: null, insufficientData: false }],
    ["g-insuf", { problems: [{ type: "sla_risk", detail: "x" }], summary: null, insufficientData: true }],
  ]);

  it("รวมงานค้าง+เกิน ต่อ owner (เฉพาะปัญหาจริง) เรียงมาก→น้อย + map ชื่อ", () => {
    const names = new Map([["a", "แมน"], ["b", "นุ่น"]]);
    const cases = [
      mkCase({ id: "1", chat_group_id: "g1", owner_employee_id: "a", status: "open", resolution_due_at: new Date(NOW - H).toISOString() }),
      mkCase({ id: "2", chat_group_id: "g2", owner_employee_id: "a", status: "in_progress", resolution_due_at: null }),
      mkCase({ id: "3", chat_group_id: "g3", owner_employee_id: "b", status: "open", resolution_due_at: null }),
      mkCase({ id: "4", chat_group_id: "g1", owner_employee_id: "a", status: "closed", resolution_due_at: null }), // ปิด → ไม่นับ
    ];
    const bl = computeOwnerBacklog(cases, NOW, names, analysis);
    expect(bl[0]).toEqual({ employeeId: "a", name: "แมน", open: 2, overdue: 1 });
    expect(bl[1]).toEqual({ employeeId: "b", name: "นุ่น", open: 1, overdue: 0 });
  });

  it("★ เคส noise (other / insufficient_data) ไม่ถูกนับเป็นงานค้าง", () => {
    const names = new Map([["a", "แมน"]]);
    const cases = [
      mkCase({ id: "1", chat_group_id: "g1", owner_employee_id: "a", status: "open" }), // ปัญหาจริง → นับ
      mkCase({ id: "2", chat_group_id: "g-other", owner_employee_id: "a", status: "open" }), // other → ไม่นับ
      mkCase({ id: "3", chat_group_id: "g-insuf", owner_employee_id: "a", status: "open" }), // insufficient → ไม่นับ
      mkCase({ id: "4", chat_group_id: "g-none", owner_employee_id: "a", status: "open" }), // ไม่มี analysis → ไม่นับ
    ];
    const bl = computeOwnerBacklog(cases, NOW, names, analysis);
    expect(bl).toHaveLength(1);
    expect(bl[0]).toEqual({ employeeId: "a", name: "แมน", open: 1, overdue: 0 });
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

// ---------------------------------------------------------------------
// ★ เหตุการณ์เจาะจง — parse problems / incident / care health / AI รอตรวจ
// ---------------------------------------------------------------------
describe("parseProblems — อ่าน problems[] จาก jsonb แบบ defensive", () => {
  it("array ปกติ → เก็บ type+detail", () => {
    const out = parseProblems([
      { type: "sla_risk", detail: "ถาม VAT ยังไม่มีผู้ตอบ 3 ชม.", msg_idx: 2 },
      { type: "complaint", detail: "ลูกค้าบ่นช้า", msg_idx: null },
    ]);
    expect(out).toEqual([
      { type: "sla_risk", detail: "ถาม VAT ยังไม่มีผู้ตอบ 3 ชม." },
      { type: "complaint", detail: "ลูกค้าบ่นช้า" },
    ]);
  });
  it("ไม่ใช่ array (null/สตริง) → []", () => {
    expect(parseProblems(null)).toEqual([]);
    expect(parseProblems("x")).toEqual([]);
  });
  it("item ที่มีแต่ detail (type หาย) → type=other; item ว่างเปล่า → ข้าม", () => {
    const out = parseProblems([{ detail: "เหตุการณ์" }, {}, { type: 123 }]);
    expect(out).toEqual([{ type: "other", detail: "เหตุการณ์" }]);
  });
});

describe("latestAnalysisByGroup — เอาวิเคราะห์ล่าสุดต่อกลุ่ม (ตัวแรก = desc)", () => {
  it("กลุ่มเดียวหลาย window → ใช้ตัวแรก (ล่าสุด)", () => {
    const m = latestAnalysisByGroup([
      { chat_group_id: "g1", summary: "ใหม่", problems: [{ type: "sla_risk", detail: "a" }], insufficient_data: false },
      { chat_group_id: "g1", summary: "เก่า", problems: [], insufficient_data: true },
      { chat_group_id: "g2", summary: "อีกกลุ่ม", problems: [], insufficient_data: true },
    ]);
    expect(m.get("g1")?.summary).toBe("ใหม่");
    expect(m.get("g1")?.problems[0].type).toBe("sla_risk");
    expect(m.get("g1")?.insufficientData).toBe(false); // ★ carry ธง insufficient_data (ตัวล่าสุด)
    expect(m.get("g2")?.insufficientData).toBe(true);
    expect(m.size).toBe(2);
  });
});

describe("countAiPendingReview — needs_review หรือ confidence ต่ำ (นับต่อกลุ่ม ไม่ซ้ำ)", () => {
  it("นับกลุ่มที่ needs_human_review หรือ confidence < 0.5 (ตัวล่าสุดของกลุ่ม)", () => {
    const n = countAiPendingReview([
      { chat_group_id: "g1", summary: null, problems: null, confidence: 0.9, needs_human_review: true }, // นับ (flag)
      { chat_group_id: "g2", summary: null, problems: null, confidence: 0.3, needs_human_review: false }, // นับ (conf ต่ำ)
      { chat_group_id: "g3", summary: null, problems: null, confidence: 0.8, needs_human_review: false }, // ไม่นับ
      { chat_group_id: "g2", summary: null, problems: null, confidence: 0.95, needs_human_review: false }, // window เก่าของ g2 → ข้าม
    ]);
    expect(n).toBe(2);
  });
});

describe("computeCareHealth7d — อัตราตอบภายใน SLA รายวัน (7 วัน)", () => {
  it("bucket ตามวันเปิดเคส + คิด rate = ตอบทัน/ครบกำหนด", () => {
    const today = new Date(NOW);
    today.setHours(9, 0, 0, 0);
    const dueLater = new Date(today.getTime() + 4 * H).toISOString();
    const cases = [
      // เปิดวันนี้ 2 เคส: 1 ตอบทัน, 1 ตอบเกิน (respond หลัง due)
      mkCase({ id: "1", opened_at: today.toISOString(), first_response_due_at: dueLater, first_responded_at: new Date(today.getTime() + 1 * H).toISOString() }),
      mkCase({ id: "2", opened_at: today.toISOString(), first_response_due_at: dueLater, first_responded_at: new Date(today.getTime() + 10 * H).toISOString() }),
      // เคสไม่มี due → ไม่นับ
      mkCase({ id: "3", opened_at: today.toISOString(), first_response_due_at: null, first_responded_at: null }),
    ];
    const h = computeCareHealth7d(cases, NOW);
    expect(h.length).toBe(7);
    const last = h[6]; // วันนี้ (ตัวสุดท้าย)
    expect(last.total).toBe(2);
    expect(last.withinSla).toBe(1);
    expect(last.rate).toBe(0.5);
    // วันก่อนหน้าที่ไม่มีเคส → rate null
    expect(h[0].total).toBe(0);
    expect(h[0].rate).toBeNull();
  });
});

describe("hasRealProblem / firstRealProblem / realProblemsOf — ★ นิยาม 'AI เจอปัญหาจริง'", () => {
  const mk = (over: Partial<GroupAnalysis>): GroupAnalysis => ({
    problems: [],
    summary: null,
    insufficientData: false,
    ...over,
  });

  it("มี problem ใน 5 หมวดจริง + detail ไม่ว่าง → true", () => {
    for (const type of ["sla_risk", "complaint", "dropped_work", "slow_reply", "no_response"]) {
      expect(hasRealProblem(mk({ problems: [{ type, detail: "เหตุการณ์จริง" }] }))).toBe(true);
    }
  });
  it("insufficient_data = true → false (แม้มี problem จริง)", () => {
    expect(hasRealProblem(mk({ problems: [{ type: "sla_risk", detail: "x" }], insufficientData: true }))).toBe(false);
  });
  it("มีแต่ 'other' → false (ตัดอื่นๆ ออก)", () => {
    expect(hasRealProblem(mk({ problems: [{ type: "other", detail: "อื่นๆ" }] }))).toBe(false);
  });
  it("problem จริงแต่ detail ว่าง → false", () => {
    expect(hasRealProblem(mk({ problems: [{ type: "sla_risk", detail: "   " }] }))).toBe(false);
  });
  it("ไม่มี problem / null / undefined → false", () => {
    expect(hasRealProblem(mk({ problems: [] }))).toBe(false);
    expect(hasRealProblem(null)).toBe(false);
    expect(hasRealProblem(undefined)).toBe(false);
  });
  it("firstRealProblem: ข้าม other → คืน problem จริงตัวแรก; realProblemsOf: กรอง other/detail ว่างทิ้ง", () => {
    const a = mk({
      problems: [
        { type: "other", detail: "อื่นๆ" },
        { type: "slow_reply", detail: "ตอบช้า 2 วัน" },
        { type: "complaint", detail: "" },
        { type: "complaint", detail: "ลูกค้าบ่น" },
      ],
    });
    expect(firstRealProblem(a)?.type).toBe("slow_reply");
    expect(realProblemsOf(a)).toEqual([
      { type: "slow_reply", detail: "ตอบช้า 2 วัน" },
      { type: "complaint", detail: "ลูกค้าบ่น" },
    ]);
  });
});

describe("buildIncidents — ★ กรองเฉพาะปัญหาจริง + เรียงความด่วน + fallback ลูกค้า/เจ้าของ", () => {
  const custCode = new Map([["cust1", "CUST-001"]]);
  const names = new Map([["e1", "พิม"], ["e2", "ผู้ดูแลกลุ่ม"]]);
  const analysis = new Map<string, GroupAnalysis>([
    ["g1", { problems: [{ type: "sla_risk", detail: "ถาม VAT ยังไม่มีผู้ตอบ 3 ชม." }], summary: "สรุป", insufficientData: false }],
    // g2 = ปัญหาจริง (no_response) มี fallback ลูกค้า/เจ้าของจากกลุ่ม
    ["g2", { problems: [{ type: "no_response", detail: "ลูกค้าถามยังไม่มีใครตอบ" }], summary: "สรุปกลุ่มสอง", insufficientData: false }],
    // g-other = มีแต่ other → ต้องถูกกรองออก
    ["g-other", { problems: [{ type: "other", detail: "เหตุการณ์อื่น" }], summary: "สรุป", insufficientData: false }],
    // g-insuf = insufficient_data → ต้องถูกกรองออก
    ["g-insuf", { problems: [{ type: "sla_risk", detail: "x" }], summary: "สั้นเกินไป", insufficientData: true }],
  ]);
  const groupFb = new Map([["g2", { customerId: "cust1", responsibleId: "e2" }]]);

  it("เคส overdue มาก่อน + ใช้ problem จริงตัวแรกเป็นเหตุการณ์ + fallback กลุ่ม", () => {
    const cases = [
      mkCase({ id: "c-ok", chat_group_id: "g2", owner_employee_id: null, customer_id: null, level: "high", resolution_due_at: new Date(NOW + 5 * H).toISOString() }),
      mkCase({ id: "c-late", chat_group_id: "g1", owner_employee_id: "e1", customer_id: "cust1", level: "critical", resolution_due_at: new Date(NOW - 2 * H).toISOString() }),
    ];
    const inc = buildIncidents(cases, analysis, groupFb, custCode, names, NOW);
    expect(inc).toHaveLength(2);
    // overdue (c-late) ต้องมาก่อน
    expect(inc[0].caseId).toBe("c-late");
    expect(inc[0].problemType).toBe("sla_risk");
    expect(inc[0].detail).toContain("VAT");
    expect(inc[0].customerLabel).toBe("CUST-001");
    expect(inc[0].ownerName).toBe("พิม");
    expect(inc[0].overdue).toBe(true);
    // c-ok: มี problem จริง (no_response); ลูกค้า/เจ้าของ fallback จากกลุ่ม
    const ok = inc.find((x) => x.caseId === "c-ok")!;
    expect(ok.problemType).toBe("no_response");
    expect(ok.detail).toBe("ลูกค้าถามยังไม่มีใครตอบ");
    expect(ok.customerLabel).toBe("CUST-001");
    expect(ok.ownerName).toBe("ผู้ดูแลกลุ่ม");
  });

  it("★ เคส noise (other / insufficient_data / ไม่มี analysis) ถูกตัดออกหมด", () => {
    const cases = [
      mkCase({ id: "c-other", chat_group_id: "g-other", level: "critical", resolution_due_at: new Date(NOW - 5 * H).toISOString() }),
      mkCase({ id: "c-insuf", chat_group_id: "g-insuf", level: "critical", resolution_due_at: new Date(NOW - 5 * H).toISOString() }),
      mkCase({ id: "c-none", chat_group_id: "g-none", level: "critical", resolution_due_at: new Date(NOW - 5 * H).toISOString() }),
    ];
    const inc = buildIncidents(cases, analysis, groupFb, custCode, names, NOW);
    expect(inc).toHaveLength(0);
  });
});

describe("getRiskDashboard — ★ เหตุการณ์เจาะจง + fallback เจ้าของจากเคส/กลุ่ม", () => {
  it("alert ไม่มี owner → ดึงจากเคส; problems/summary มาจาก ai_chat_analysis ของกลุ่ม", async () => {
    const calls: CallRec[] = [];
    const db = makeDb(
      {
        risk_alerts: [
          { id: "r1", case_id: "c1", customer_id: null, level: "red", reason: "sentiment ลบ", owner_employee_id: null, status: "open", escalated_at: null },
        ],
        conversation_cases: [
          { id: "c1", chat_group_id: "g1", customer_id: "cust1", owner_employee_id: "e1" },
        ],
        chat_groups: [
          { id: "g1", customer_id: null, responsible_employee_id: "e2" },
        ],
        ai_chat_analysis: [
          { chat_group_id: "g1", summary: "ลูกค้าถาม VAT", problems: [{ type: "sla_risk", detail: "ถาม VAT ยังไม่มีผู้ตอบ 3 ชม." }], window_end: "2026-07-18T00:00:00Z" },
        ],
        customers: [{ id: "cust1", customer_code: "CUST-001" }],
        employees: [{ id: "e1", first_name: "พิม", nickname: "พิม" }],
      },
      calls
    );
    const rows = await getRiskDashboard(db, accountant("e1"));
    // ★ scope: ยังบังคับ eq owner_employee_id ตัวเองบน risk_alerts
    expect(hasFilter(calls, "risk_alerts", "eq", "owner_employee_id", "e1")).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].problems[0]).toEqual({ type: "sla_risk", detail: "ถาม VAT ยังไม่มีผู้ตอบ 3 ชม." });
    expect(rows[0].summary).toBe("ลูกค้าถาม VAT");
    expect(rows[0].customerLabel).toBe("CUST-001"); // fallback จากเคส
    expect(rows[0].ownerName).toBe("พิม"); // fallback owner จากเคส
  });

  it("★ กรอง noise: risk ที่ analysis เป็น other/insufficient/ไม่มี → ไม่แสดง; แสดงเฉพาะปัญหาจริง", async () => {
    const calls: CallRec[] = [];
    const db = makeDb(
      {
        risk_alerts: [
          { id: "r-real", case_id: "c1", customer_id: null, level: "red", reason: "x", owner_employee_id: "e1", status: "open", escalated_at: null },
          { id: "r-other", case_id: "c2", customer_id: null, level: "orange", reason: "แค่ sentiment", owner_employee_id: "e1", status: "open", escalated_at: null },
          { id: "r-insuf", case_id: "c3", customer_id: null, level: "yellow", reason: "ข้อมูลน้อย", owner_employee_id: "e1", status: "open", escalated_at: null },
          { id: "r-nocase", case_id: null, customer_id: null, level: "yellow", reason: "ไม่มีเคส", owner_employee_id: "e1", status: "open", escalated_at: null },
        ],
        conversation_cases: [
          { id: "c1", chat_group_id: "g1", customer_id: null, owner_employee_id: "e1" },
          { id: "c2", chat_group_id: "g2", customer_id: null, owner_employee_id: "e1" },
          { id: "c3", chat_group_id: "g3", customer_id: null, owner_employee_id: "e1" },
        ],
        chat_groups: [
          { id: "g1", customer_id: null, responsible_employee_id: "e1" },
          { id: "g2", customer_id: null, responsible_employee_id: "e1" },
          { id: "g3", customer_id: null, responsible_employee_id: "e1" },
        ],
        ai_chat_analysis: [
          { chat_group_id: "g1", summary: "จริง", problems: [{ type: "complaint", detail: "ลูกค้าบ่นแรง" }, { type: "other", detail: "อื่นๆ" }], insufficient_data: false, window_end: "2026-07-18T00:00:00Z" },
          { chat_group_id: "g2", summary: "other ล้วน", problems: [{ type: "other", detail: "อื่นๆ" }], insufficient_data: false, window_end: "2026-07-18T00:00:00Z" },
          { chat_group_id: "g3", summary: "ข้อมูลไม่พอ", problems: [{ type: "sla_risk", detail: "x" }], insufficient_data: true, window_end: "2026-07-18T00:00:00Z" },
        ],
        employees: [{ id: "e1", first_name: "พิม", nickname: "พิม" }],
      },
      calls
    );
    const rows = await getRiskDashboard(db, accountant("e1"));
    // เหลือเฉพาะ r-real (complaint จริง); r-other/r-insuf/r-nocase ถูกตัด
    expect(rows).toHaveLength(1);
    expect(rows[0].alertId).toBe("r-real");
    // ★ โชว์เฉพาะ problem จริง — ตัด other ออกจาก signal cell
    expect(rows[0].problems).toEqual([{ type: "complaint", detail: "ลูกค้าบ่นแรง" }]);
  });
});

describe("getExecChatDashboard — ★ KPI ใหม่ + เหตุการณ์เร่งด่วน", () => {
  it("นับ waiting/activeRisk/aiPendingReview + สร้าง incidents จาก analysis", async () => {
    const calls: CallRec[] = [];
    const opened = new Date(NOW).toISOString();
    const db = makeDb(
      {
        conversation_cases: [
          { id: "c1", customer_id: "cust1", chat_group_id: "g1", owner_employee_id: "e1", title: "t", summary: "s", status: "open", urgency: "high", level: "critical", first_response_due_at: opened, resolution_due_at: new Date(NOW - 2 * H).toISOString(), first_responded_at: null, opened_at: opened, closed_at: null },
          { id: "c2", customer_id: null, chat_group_id: "g1", owner_employee_id: "e1", title: "t2", summary: "s2", status: "in_progress", urgency: "low", level: "medium", first_response_due_at: opened, resolution_due_at: new Date(NOW + 5 * H).toISOString(), first_responded_at: opened, opened_at: opened, closed_at: null },
        ],
        chat_groups: [{ id: "g1", customer_id: "cust1", responsible_employee_id: "e2", is_active: true, group_kind: "group" }],
        // ★ risk แดงผูกกับ c1 (กลุ่ม g1 เจอปัญหาจริง) → นับ; ส้มไม่มีเคส → ไม่นับ (activeRisk=1)
        risk_alerts: [
          { case_id: "c1", level: "red", status: "open" },
          { case_id: null, level: "orange", status: "open" },
        ],
        sop_violations: [],
        ai_chat_analysis: [
          { chat_group_id: "g1", summary: "ลูกค้าถาม VAT", problems: [{ type: "sla_risk", detail: "ยังไม่มีผู้ตอบ 3 ชม." }], confidence: 0.3, needs_human_review: false, insufficient_data: false, window_end: "2026-07-18T00:00:00Z" },
        ],
        customers: [{ id: "cust1", customer_code: "CUST-001" }],
        employees: [{ id: "e1", first_name: "พิม", nickname: "พิม" }],
      },
      calls
    );
    const d = await getExecChatDashboard(db, NOW);
    expect(d.waitingCases).toBe(1); // c1 ยังไม่ตอบครั้งแรก (c2 ตอบแล้ว)
    expect(d.activeRisk).toBe(1); // ★ เฉพาะ risk ที่กลุ่มมีปัญหาจริง (แดง→c1→g1); ส้มไม่มีเคส → ไม่นับ
    expect(d.complaints).toBe(2); // ส้ม+แดง (คงตรรกะเดิม)
    expect(d.aiPendingReview).toBe(1); // confidence 0.3 < 0.5
    expect(d.incidents.length).toBeGreaterThan(0);
    // เคส overdue critical (c1) ต้องมาเป็นเหตุการณ์แรก + detail จาก problem
    expect(d.incidents[0].caseId).toBe("c1");
    expect(d.incidents[0].detail).toContain("ยังไม่มีผู้ตอบ");
    expect(d.incidents[0].problemType).toBe("sla_risk");
    // ยิง query ai_chat_analysis จริง
    expect(calls.some((c) => c.table === "ai_chat_analysis")).toBe(true);
  });
});
