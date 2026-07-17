import { describe, it, expect } from "vitest";
import { buildSteps, type ApiTemplate } from "@/lib/survey/steps";

/**
 * ทดสอบ buildSteps (ตัวสร้างขั้นตอน wizard ฝั่ง LIFF)
 * โฟกัส 3 พฤติกรรมที่ปรับตาม feedback ผู้ใช้:
 *   - Form B = 2 หน้า (ดาวทุกคนในหน้าเดียว + ความเห็น/consent)
 *   - ไม่มี follow-up ปลายเปิดแทรกระหว่างดาว
 *   - มีช่องความเห็นท้ายเดียว (open_questions)
 */

const schemaB = {
  type: "B",
  question_sets: {
    member: [
      { code: "mem_correct", text: "ถูกต้อง", type: "rating" as const, scale: 5 },
      { code: "mem_overall", text: "ภาพรวม", type: "rating" as const, scale: 5 },
    ],
  },
  open_questions: [
    { code: "open_feedback", text: "ความเห็นเพิ่มเติม", type: "open" as const },
  ],
};

function templateB(subjects: ApiTemplate["subjects"]): ApiTemplate {
  return {
    token: "tok_1234567890",
    survey_type: "B",
    survey_slug: "b",
    schema: schemaB,
    reference: null,
    subjects,
  };
}

describe("survey/steps — buildSteps Form B (2 หน้า)", () => {
  const subjects = [
    { employee_id: "emp-1", name: "สมหญิง", subject_role: "member" },
    { employee_id: "emp-2", name: "วิภา", subject_role: "member" },
  ];

  it("Form B ที่มีผู้ถูกประเมิน → 2 หน้าเป๊ะ", () => {
    const steps = buildSteps(templateB(subjects));
    expect(steps).toHaveLength(2);
  });

  it("หน้า 1 = ให้ดาวนักบัญชีทุกคนในหน้าเดียว (แยกการ์ดต่อคน)", () => {
    const [page1] = buildSteps(templateB(subjects));
    expect(page1.groups).toBeDefined();
    expect(page1.groups).toHaveLength(2);
    expect(page1.groups?.map((g) => g.subjectName)).toEqual(["สมหญิง", "วิภา"]);
    // คำถามรวมทุกคน = 2 คน × 2 คำถาม = 4 (ใช้ validate required ต่อหน้า)
    expect(page1.questions).toHaveLength(4);
  });

  it("per-subject answer key คงสูตร <employee_id>__<code> (submit B ต้องไม่พัง)", () => {
    const [page1] = buildSteps(templateB(subjects));
    const codes = page1.questions.map((q) => q.code);
    expect(codes).toContain("emp-1__mem_correct");
    expect(codes).toContain("emp-1__mem_overall");
    expect(codes).toContain("emp-2__mem_correct");
    expect(codes).toContain("emp-2__mem_overall");
  });

  it("หน้า 2 = ช่องความเห็นช่องเดียว (open_feedback)", () => {
    const steps = buildSteps(templateB(subjects));
    const last = steps[steps.length - 1];
    expect(last.groups).toBeUndefined();
    expect(last.questions.map((q) => q.code)).toEqual(["open_feedback"]);
    expect(last.questions.filter((q) => q.type === "open")).toHaveLength(1);
  });

  it("ทุกคำถามในหน้าดาวเป็น rating เท่านั้น — ไม่มี follow-up open แทรกระหว่างดาว", () => {
    const [page1] = buildSteps(templateB(subjects));
    expect(page1.questions.every((q) => q.type === "rating")).toBe(true);
    // ไม่มี code ที่ลงท้าย __followup หลุดเข้ามาใน steps
    const allCodes = buildSteps(templateB(subjects)).flatMap((s) =>
      s.questions.map((q) => q.code)
    );
    expect(allCodes.some((c) => c.endsWith("__followup"))).toBe(false);
  });

  it("Form B ไม่มี subject → fallback 1 หน้าดาว + 1 หน้าความเห็น", () => {
    const steps = buildSteps(templateB([]));
    expect(steps).toHaveLength(2);
    expect(steps[0].groups).toBeUndefined();
    expect(steps[0].questions.map((q) => q.code)).toEqual([
      "mem_correct",
      "mem_overall",
    ]);
    expect(steps[1].questions.map((q) => q.code)).toEqual(["open_feedback"]);
  });
});

describe("survey/steps — buildSteps Form A/C/D (sections ไม่ regression)", () => {
  const schemaA = {
    type: "A",
    sections: [
      { code: "ref", title: "ข้อมูลอ้างอิง", auto_fill: true },
      {
        code: "ratings",
        title: "ให้คะแนนบริการ",
        questions: [
          { code: "acc_correct", text: "ถูกต้อง", type: "rating" as const, scale: 5 },
        ],
      },
    ],
    open_questions: [
      { code: "open_feedback", text: "ความเห็น", type: "open" as const },
    ],
  };

  const templateA: ApiTemplate = {
    token: "tok_1234567890",
    survey_type: "A",
    survey_slug: "a",
    schema: schemaA,
    reference: {
      customer_code: "C001",
      name: "ลูกค้า ก",
      business_name: null,
      service_start_date: null,
    },
    subjects: [],
  };

  it("A: section ref = การ์ดข้อมูล, ratings = คำถาม, ปิดท้าย open_questions", () => {
    const steps = buildSteps(templateA);
    // ref + ratings + open = 3 step (A ไม่ถูกบังคับ 2 หน้า)
    expect(steps).toHaveLength(3);
    expect(steps[0].ref).toBeTruthy();
    expect(steps[0].questions).toHaveLength(0);
    expect(steps[1].questions.map((q) => q.code)).toEqual(["acc_correct"]);
    expect(steps[2].questions.map((q) => q.code)).toEqual(["open_feedback"]);
  });

  it("A: ไม่มี groups (per-subject เป็นของ Form B เท่านั้น)", () => {
    const steps = buildSteps(templateA);
    expect(steps.every((s) => s.groups === undefined)).toBe(true);
  });
});
