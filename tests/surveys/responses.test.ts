/**
 * Unit test — getIndividualResponses (คำตอบแบบประเมินรายบุคคล)
 *
 * โฟกัส:
 *  (1) scope: query ต้อง .eq("tenant_id", tenantId) เสมอ
 *  (2) ต้องคืน customer_code + ชื่อลูกค้า (หัวใจของฟีเจอร์)
 *  (3) Form B: ดึงนักบัญชีที่ถูกประเมินถูกต้อง (nickname ก่อน first_name) จาก employee_evaluations
 *  (4) กรอง soft-deleted ของคะแนน/AI/employee_evaluations + เลือก CSAT overall
 *
 * ใช้ fake db แบบ chainable ที่จบด้วย await (thenable) + บันทึกการเรียก .eq()
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getIndividualResponses } from "@/lib/surveys/responses";

type EqCall = { col: string; val: unknown };

/**
 * fake query builder: chainable (.select/.eq/.is/.order/.limit) และ await ได้ (thenable)
 * เก็บ eqCalls เพื่อ assert การ scope tenant
 */
function makeDb(rows: unknown[]) {
  const eqCalls: EqCall[] = [];
  const builder: Record<string, unknown> = {};
  const chain = () => builder;

  builder.select = chain;
  builder.is = chain;
  builder.order = chain;
  builder.limit = chain;
  builder.eq = (col: string, val: unknown) => {
    eqCalls.push({ col, val });
    return builder;
  };
  // thenable: await builder → { data, error }
  builder.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
    resolve({ data: rows, error: null });

  const db = {
    from() {
      return builder;
    },
  } as unknown as SupabaseClient;

  return { db, eqCalls };
}

const TENANT = "11111111-1111-1111-1111-111111111111";

function baseRow(over: Record<string, unknown> = {}) {
  return {
    id: "resp-1",
    submitted_at: "2026-07-10T08:00:00Z",
    survey_invitations: { survey_type: "A", deleted_at: null },
    customers: { name: "บริษัท ก จำกัด", customer_code: "CUS-001" },
    satisfaction_scores: [{ dimension: "overall", score: 4.5, deleted_at: null }],
    nps_scores: [{ score_0_10: 9, category: "promoter", deleted_at: null }],
    ai_feedback_analysis: [
      { sentiment: "positive", urgency: "medium", summary: "ลูกค้าพอใจ", deleted_at: null },
    ],
    employee_evaluations: [],
    ...over,
  };
}

describe("getIndividualResponses", () => {
  it("scope ด้วย tenant_id เสมอ + คืน customer_code และชื่อลูกค้า (ไม่ truncate)", async () => {
    const { db, eqCalls } = makeDb([baseRow()]);
    const out = await getIndividualResponses(db, TENANT);

    // (1) ต้อง scope tenant
    expect(eqCalls.some((c) => c.col === "tenant_id" && c.val === TENANT)).toBe(true);

    // (2) customer_code + ชื่อ
    expect(out.rows).toHaveLength(1);
    expect(out.truncated).toBe(false);
    expect(out.rows[0].customerCode).toBe("CUS-001");
    expect(out.rows[0].customerName).toBe("บริษัท ก จำกัด");
    expect(out.rows[0].surveyType).toBe("A");
    expect(out.rows[0].csatOverall).toBe(4.5);
    expect(out.rows[0].npsScore).toBe(9);
    expect(out.rows[0].aiSentiment).toBe("positive");
  });

  it("truncated: มีแถวเกิน limit (query ดึง limit+1) → slice กลับเหลือ limit + truncated=true", async () => {
    // limit=2 → query .limit(3) จึงจำลอง db คืน 3 แถว
    const rows = [
      baseRow({ id: "r1" }),
      baseRow({ id: "r2" }),
      baseRow({ id: "r3" }),
    ];
    const { db } = makeDb(rows);
    const out = await getIndividualResponses(db, TENANT, { limit: 2 });

    expect(out.truncated).toBe(true);
    expect(out.limit).toBe(2);
    expect(out.rows).toHaveLength(2); // ตัดกลับเหลือ limit
    expect(out.rows.map((r) => r.responseId)).toEqual(["r1", "r2"]);
  });

  it("ไม่ truncate เมื่อได้พอดี limit (db คืน = limit ไม่เกิน)", async () => {
    const { db } = makeDb([baseRow({ id: "r1" }), baseRow({ id: "r2" })]);
    const out = await getIndividualResponses(db, TENANT, { limit: 2 });

    expect(out.truncated).toBe(false);
    expect(out.rows).toHaveLength(2);
  });

  it("Form B: ดึงนักบัญชีที่ถูกประเมิน (ใช้ nickname ก่อน ไม่มีค่อยใช้ first_name)", async () => {
    const row = baseRow({
      id: "resp-b",
      survey_invitations: { survey_type: "B", deleted_at: null },
      employee_evaluations: [
        {
          employee_id: "emp-1",
          subject_role: "lead",
          deleted_at: null,
          employees: { first_name: "สมชาย", nickname: "ชาย" },
        },
        {
          employee_id: "emp-2",
          subject_role: "member",
          deleted_at: null,
          employees: { first_name: "สมหญิง", nickname: null },
        },
        // แถวถูกลบ → ต้องไม่ถูกนับ
        {
          employee_id: "emp-3",
          subject_role: "member",
          deleted_at: "2026-07-11T00:00:00Z",
          employees: { first_name: "ลบแล้ว", nickname: "ลบ" },
        },
      ],
    });

    const { db } = makeDb([row]);
    const out = await getIndividualResponses(db, TENANT);

    expect(out.rows[0].surveyType).toBe("B");
    expect(out.rows[0].evaluatedEmployees).toHaveLength(2);
    expect(out.rows[0].evaluatedEmployees[0]).toEqual({
      employeeId: "emp-1",
      name: "ชาย", // nickname
      subjectRole: "lead",
    });
    expect(out.rows[0].evaluatedEmployees[1].name).toBe("สมหญิง"); // fallback first_name
  });

  it("CSAT: ไม่มี overall → เฉลี่ยมิติที่ active + ข้ามคะแนน/AI ที่ถูกลบ", async () => {
    const row = baseRow({
      satisfaction_scores: [
        { dimension: "speed", score: 4, deleted_at: null },
        { dimension: "quality", score: 5, deleted_at: null },
        { dimension: "old", score: 1, deleted_at: "2026-07-01T00:00:00Z" }, // ถูกลบ → ไม่คิด
      ],
      nps_scores: [{ score_0_10: 3, category: "detractor", deleted_at: "2026-07-01T00:00:00Z" }],
      ai_feedback_analysis: [
        { sentiment: "negative", urgency: "high", summary: "x", deleted_at: "2026-07-01T00:00:00Z" },
      ],
    });

    const { db } = makeDb([row]);
    const out = await getIndividualResponses(db, TENANT);

    expect(out.rows[0].csatOverall).toBe(4.5); // (4+5)/2
    expect(out.rows[0].npsScore).toBeNull(); // nps ถูกลบ
    expect(out.rows[0].aiSentiment).toBeNull(); // ai ถูกลบ
    expect(out.rows[0].evaluatedEmployees).toEqual([]);
  });

  it("ส่ง opts.surveyType → เพิ่ม filter survey_type (scope tenant คงอยู่)", async () => {
    const { db, eqCalls } = makeDb([]);
    await getIndividualResponses(db, TENANT, { surveyType: "B" });

    expect(eqCalls.some((c) => c.col === "tenant_id" && c.val === TENANT)).toBe(true);
    expect(
      eqCalls.some((c) => c.col === "survey_invitations.survey_type" && c.val === "B")
    ).toBe(true);
  });
});
