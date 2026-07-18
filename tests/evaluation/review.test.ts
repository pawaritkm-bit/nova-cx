import { describe, it, expect } from "vitest";
import {
  applyManagerReview,
  submitAppeal,
  resolveAppeal,
  EvalAuthError,
} from "@/lib/evaluation/review";
import type { Viewer } from "@/lib/evaluation/access";
import { makeDb, makeStore, type Store } from "./fake-db";

const lead: Viewer = { role: "acc_lead", employeeId: "L", teamMemberIds: new Set(["emp-1"]) };
const admin: Viewer = { role: "admin", employeeId: "adm" };
const accountant: Viewer = { role: "accountant", employeeId: "emp-1" };

function storeWithEval(status = "ai_draft", employeeId = "emp-1"): Store {
  return makeStore({
    data: {
      accountant_evaluations: [
        { id: "eval-1", tenant_id: "t1", employee_id: employeeId, status, deleted_at: null },
      ],
    },
  });
}

describe("applyManagerReview — confirm/edit/reject + guard tier", () => {
  it("★ accountant review 'ไม่ได้' → EvalAuthError (ไม่เรียก RPC)", async () => {
    const store = storeWithEval();
    await expect(
      applyManagerReview(makeDb(store), accountant, {
        tenantId: "t1",
        evaluationId: "eval-1",
        action: "confirm",
      })
    ).rejects.toBeInstanceOf(EvalAuthError);
    expect(store.rpcCalls).toHaveLength(0);
  });

  it("acc_lead ของทีม confirm ได้ → เรียก record_manager_review", async () => {
    const store = storeWithEval();
    store.rpcResults.record_manager_review = {
      data: { from_status: "ai_draft", to_status: "manager_confirmed" },
      error: null,
    };
    const res = await applyManagerReview(makeDb(store), lead, {
      tenantId: "t1",
      evaluationId: "eval-1",
      action: "confirm",
    });
    expect(res.toStatus).toBe("manager_confirmed");
    expect(store.rpcCalls[0].name).toBe("record_manager_review");
    expect(store.rpcCalls[0].params.p_action).toBe("confirm");
    expect(store.rpcCalls[0].params.p_reviewer_emp_id).toBe("L");
  });

  it("admin edit ปรับคะแนน → ส่ง adjusted ให้ RPC", async () => {
    const store = storeWithEval("ai_draft");
    store.rpcResults.record_manager_review = {
      data: { from_status: "ai_draft", to_status: "manager_edited" },
      error: null,
    };
    await applyManagerReview(makeDb(store), admin, {
      tenantId: "t1",
      evaluationId: "eval-1",
      action: "edit",
      adjustedOverall: 75,
      adjustedDimensionScores: { sla: 60 },
    });
    expect(store.rpcCalls[0].params.p_adjusted_overall).toBe(75);
    expect(store.rpcCalls[0].params.p_adjusted_dimension).toEqual({ sla: 60 });
  });

  it("acc_lead นอกทีม → EvalAuthError", async () => {
    const store = storeWithEval("ai_draft", "emp-9");
    await expect(
      applyManagerReview(makeDb(store), lead, {
        tenantId: "t1",
        evaluationId: "eval-1",
        action: "reject",
      })
    ).rejects.toBeInstanceOf(EvalAuthError);
  });

  it("ไม่พบ eval → EvalAuthError", async () => {
    const store = makeStore({ data: { accountant_evaluations: [] } });
    await expect(
      applyManagerReview(makeDb(store), admin, {
        tenantId: "t1",
        evaluationId: "nope",
        action: "confirm",
      })
    ).rejects.toBeInstanceOf(EvalAuthError);
  });
});

describe("submitAppeal — ★ เฉพาะเจ้าของ + สถานะอุทธรณ์ได้", () => {
  it("เจ้าของอุทธรณ์ eval ที่ confirmed ได้ → เรียก submit_evaluation_appeal", async () => {
    const store = storeWithEval("manager_confirmed");
    store.rpcResults.submit_evaluation_appeal = {
      data: { appeal_id: "ap-1" },
      error: null,
    };
    const res = await submitAppeal(makeDb(store), accountant, {
      tenantId: "t1",
      evaluationId: "eval-1",
      reason: "คะแนน SLA ไม่เป็นธรรม ตอบนอกเวลางาน",
    });
    expect(res.appealId).toBe("ap-1");
    expect(store.rpcCalls[0].name).toBe("submit_evaluation_appeal");
    expect(store.rpcCalls[0].params.p_employee_id).toBe("emp-1");
  });

  it("★ ไม่ใช่เจ้าของ (หัวหน้า) อุทธรณ์ไม่ได้ → EvalAuthError", async () => {
    const store = storeWithEval("manager_confirmed");
    await expect(
      submitAppeal(makeDb(store), lead, {
        tenantId: "t1",
        evaluationId: "eval-1",
        reason: "x",
      })
    ).rejects.toBeInstanceOf(EvalAuthError);
  });

  it("ยังเป็น draft → อุทธรณ์ไม่ได้", async () => {
    const store = storeWithEval("ai_draft");
    await expect(
      submitAppeal(makeDb(store), accountant, {
        tenantId: "t1",
        evaluationId: "eval-1",
        reason: "x",
      })
    ).rejects.toBeInstanceOf(EvalAuthError);
  });

  it("เหตุผลว่าง → EvalAuthError", async () => {
    const store = storeWithEval("manager_confirmed");
    await expect(
      submitAppeal(makeDb(store), accountant, {
        tenantId: "t1",
        evaluationId: "eval-1",
        reason: "   ",
      })
    ).rejects.toBeInstanceOf(EvalAuthError);
  });
});

describe("resolveAppeal — หัวหน้าตัดสินอุทธรณ์ + guard", () => {
  it("acc_lead ของทีม resolve accepted → เรียก resolve_evaluation_appeal", async () => {
    const store = makeStore();
    store.rpcResults.resolve_evaluation_appeal = { data: { decision: "accepted" }, error: null };
    const res = await resolveAppeal(makeDb(store), lead, {
      tenantId: "t1",
      appealId: "ap-1",
      evaluationEmployeeId: "emp-1",
      decision: "accepted",
      adjustedOverall: 80,
    });
    expect(res.decision).toBe("accepted");
    expect(store.rpcCalls[0].params.p_adjusted_overall).toBe(80);
  });

  it("★ accountant resolve ไม่ได้ → EvalAuthError", async () => {
    const store = makeStore();
    await expect(
      resolveAppeal(makeDb(store), accountant, {
        tenantId: "t1",
        appealId: "ap-1",
        evaluationEmployeeId: "emp-1",
        decision: "rejected",
      })
    ).rejects.toBeInstanceOf(EvalAuthError);
  });
});
