import { describe, it, expect } from "vitest";
import { scanCaseEvaluations } from "@/lib/evaluation/enqueue";
import { makeDb, makeStore, type Store } from "./fake-db";

const NOW = () => new Date("2026-07-20T12:00:00Z");

function closedCase(id: string, owner: string | null = "emp-1") {
  return {
    id,
    tenant_id: "t1",
    owner_employee_id: owner,
    status: "closed",
    closed_at: "2026-07-20T08:00:00Z",
    deleted_at: null,
  };
}

describe("scanCaseEvaluations — enqueue idempotent", () => {
  it("เคสปิด มี owner ยังไม่มี eval/job → enqueue 1 งาน (payload ครบ)", async () => {
    const store = makeStore({
      data: { conversation_cases: [closedCase("case-1")], accountant_evaluations: [], job_queue: [] },
    });
    const res = await scanCaseEvaluations({ db: makeDb(store), now: NOW });
    expect(res.candidates).toBe(1);
    expect(res.enqueued).toBe(1);
    const job = store.inserts.job_queue?.[0];
    expect(job).toMatchObject({ queue: "evaluation", tenant_id: "t1" });
    expect((job?.payload as Record<string, unknown>)).toMatchObject({
      scope: "case",
      conversation_case_id: "case-1",
      employee_id: "emp-1",
    });
  });

  it("★ idempotent: มี eval ของเคสอยู่แล้ว → skip (hasEval)", async () => {
    const store = makeStore({
      data: {
        conversation_cases: [closedCase("case-1")],
        accountant_evaluations: [
          { id: "e1", conversation_case_id: "case-1", deleted_at: null },
        ],
        job_queue: [],
      },
    });
    const res = await scanCaseEvaluations({ db: makeDb(store), now: NOW });
    expect(res.hasEval).toBe(1);
    expect(res.enqueued).toBe(0);
    expect(store.inserts.job_queue ?? []).toHaveLength(0);
  });

  it("★ idempotent: มี job evaluation ค้างอยู่ → skip (existed)", async () => {
    const store = makeStore({
      data: {
        conversation_cases: [closedCase("case-1")],
        accountant_evaluations: [],
        job_queue: [
          {
            id: "j1",
            queue: "evaluation",
            status: "pending",
            payload: { conversation_case_id: "case-1" },
          },
        ],
      },
    });
    const res = await scanCaseEvaluations({ db: makeDb(store), now: NOW });
    expect(res.existed).toBe(1);
    expect(res.enqueued).toBe(0);
  });

  it("★ insert ชน 23505 (partial unique) → นับ existed ไม่ใช่ failed", async () => {
    const store = makeStore({
      data: { conversation_cases: [closedCase("case-1")], accountant_evaluations: [], job_queue: [] },
      insertError: { job_queue: { code: "23505" } },
    });
    const res = await scanCaseEvaluations({ db: makeDb(store), now: NOW });
    expect(res.existed).toBe(1);
    expect(res.failed).toBe(0);
  });
});
