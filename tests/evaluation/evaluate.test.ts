import { describe, it, expect } from "vitest";
import { evaluateAccountant } from "@/lib/evaluation/evaluate";
import { makeDb, makeStore, type Store } from "./fake-db";

const NOW_CASE = {
  id: "case-1",
  tenant_id: "t1",
  chat_group_id: "g1",
  owner_employee_id: "emp-1",
  status: "closed",
  opened_at: "2026-07-20T03:00:00Z",
  first_responded_at: "2026-07-20T03:30:00Z",
  first_response_due_at: "2026-07-20T07:00:00Z",
  resolution_due_at: "2026-07-20T09:00:00Z",
  closed_at: "2026-07-20T08:00:00Z",
  deleted_at: null,
};

function baseStore(overrides: Partial<Store> = {}): Store {
  return makeStore({
    data: {
      conversation_cases: [NOW_CASE],
      ai_chat_analysis: [
        {
          tenant_id: "t1",
          chat_group_id: "g1",
          flow_steps: [{ step: "close", status: "done" }],
          problems: [],
          sentiment: "neutral",
          window_end: "2026-07-20T08:00:00Z",
          deleted_at: null,
        },
      ],
      sop_violations: [],
      case_status_history: [],
      evaluation_weights: [
        {
          tenant_id: "t1",
          is_active: true,
          deleted_at: null,
          weights: {
            correctness: 20,
            completeness: 10,
            sla: 15,
            clarity: 10,
            politeness: 10,
            ownership: 15,
            resolution: 10,
            sop: 10,
          },
        },
      ],
    },
    ...overrides,
  });
}

describe("evaluateAccountant — orchestrator สร้าง draft (idempotent + audit ผ่าน RPC)", () => {
  it("ไม่มีเคส → skipped (no_cases_to_evaluate) ไม่เรียก RPC", async () => {
    const store = makeStore({ data: { conversation_cases: [] } });
    const res = await evaluateAccountant(makeDb(store), {
      tenantId: "t1",
      employeeId: "emp-1",
      scope: "case",
      conversationCaseId: "case-x",
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("no_cases_to_evaluate");
    expect(store.rpcCalls).toHaveLength(0);
  });

  it("มีเคส → คำนวณ overall + เรียก persist_accountant_evaluation ด้วย scope/case/คะแนน", async () => {
    const store = baseStore();
    const res = await evaluateAccountant(makeDb(store), {
      tenantId: "t1",
      employeeId: "emp-1",
      scope: "case",
      conversationCaseId: "case-1",
      qualitative: { correctness: 90, completeness: 90, clarity: 90, politeness: 90 },
    });
    expect(res.skipped).toBe(false);
    expect(res.evaluationId).toBe("eval-1");
    expect(typeof res.overall).toBe("number");
    expect(store.rpcCalls).toHaveLength(1);
    const call = store.rpcCalls[0];
    expect(call.name).toBe("persist_accountant_evaluation");
    expect(call.params.p_scope).toBe("case");
    expect(call.params.p_conversation_case_id).toBe("case-1");
    // ★ ส่ง evidence + coaching ให้ RPC (RPC เป็นคนบันทึก audit)
    expect(Array.isArray(call.params.p_evidence)).toBe(true);
    expect(call.params.p_coaching).toBeTruthy();
    // dimension_scores มีทั้งเชิงปริมาณ (sla/ownership/resolution/sop) และคุณภาพ
    const dims = call.params.p_dimension_scores as Record<string, number>;
    expect(dims.sla).toBe(100);
    expect(dims.correctness).toBe(90);
  });

  it("★ SLA guard: ตอบข้ามสุดสัปดาห์ยังได้ sla=100 (ไม่โดนโทษนอกเวลา)", async () => {
    const store = baseStore({
      data: {
        conversation_cases: [
          {
            ...NOW_CASE,
            opened_at: "2026-07-24T10:30:00Z", // ศุกร์ 17:30 ไทย
            first_responded_at: "2026-07-27T02:30:00Z", // จันทร์ 9:30 ไทย
          },
        ],
        ai_chat_analysis: [
          {
            tenant_id: "t1",
            chat_group_id: "g1",
            flow_steps: [],
            problems: [],
            sentiment: "neutral",
            window_end: "x",
            deleted_at: null,
          },
        ],
        sop_violations: [],
        case_status_history: [],
        evaluation_weights: [],
      },
    });
    await evaluateAccountant(makeDb(store), {
      tenantId: "t1",
      employeeId: "emp-1",
      scope: "case",
      conversationCaseId: "case-1",
      firstResponseTargetMinutes: 240,
    });
    const dims = store.rpcCalls[0].params.p_dimension_scores as Record<string, number>;
    expect(dims.sla).toBe(100);
  });

  it("RPC error → skipped=true (ไม่ throw ให้ล้ม worker)", async () => {
    const store = baseStore({
      rpcResults: { persist_accountant_evaluation: { data: null, error: { code: "P0002" } } },
    });
    const res = await evaluateAccountant(makeDb(store), {
      tenantId: "t1",
      employeeId: "emp-1",
      scope: "case",
      conversationCaseId: "case-1",
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toContain("rpc_failed");
  });
});
