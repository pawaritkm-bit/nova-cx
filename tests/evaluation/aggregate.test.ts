import { describe, it, expect } from "vitest";
import { aggregateAccountantSignals } from "@/lib/evaluation/aggregate";
import { makeStore, makeDb, type Store } from "./fake-db";

/**
 * aggregate — กันปนเปื้อน (REGRESSION-CRITICAL, Phase A)
 *   พิสูจน์ว่า flow ประเมินนักบัญชีรายคน "ไม่หยิบ" บทสนทนา 1-1 (group_kind='user')
 *   แม้จะมี conversation_case ที่อ้างกลุ่ม 1-1 หลุดเข้ามา ก็ต้องถูกตัดทิ้ง
 */

const INPUT = {
  tenantId: "t-1",
  employeeId: "emp-1",
  periodStart: "2026-07-01T00:00:00Z",
  periodEnd: "2026-08-01T00:00:00Z",
};

function caseRow(id: string, chatGroupId: string) {
  return {
    id,
    chat_group_id: chatGroupId,
    owner_employee_id: "emp-1",
    tenant_id: "t-1",
    status: "open",
    opened_at: "2026-07-10T10:00:00Z",
    first_responded_at: null,
    first_response_due_at: null,
    resolution_due_at: null,
    closed_at: null,
    deleted_at: null,
  };
}

describe("aggregateAccountantSignals — กันปน 1-1", () => {
  it("★ เคสที่อ้างกลุ่ม 1-1 (group_kind='user') → ถูกตัดทิ้ง ไม่เข้าคะแนนนักบัญชี", async () => {
    const store: Store = makeStore({
      data: {
        conversation_cases: [caseRow("case-dm", "dm-1")],
        chat_groups: [{ id: "dm-1", tenant_id: "t-1", group_kind: "user" }],
        ai_chat_analysis: [],
        sop_violations: [],
        case_status_history: [],
        chat_messages: [],
      },
    });
    const res = await aggregateAccountantSignals(makeDb(store), INPUT);
    expect(res.cases).toHaveLength(0);
    expect(res.chatGroupIds).toHaveLength(0);
  });

  it("control: เคสของกลุ่มจริง (group_kind='group') → นับปกติ", async () => {
    const store: Store = makeStore({
      data: {
        conversation_cases: [caseRow("case-g", "grp-1")],
        chat_groups: [{ id: "grp-1", tenant_id: "t-1", group_kind: "group" }],
        ai_chat_analysis: [],
        sop_violations: [],
        case_status_history: [],
        chat_messages: [],
      },
    });
    const res = await aggregateAccountantSignals(makeDb(store), INPUT);
    expect(res.cases).toHaveLength(1);
    expect(res.chatGroupIds).toEqual(["grp-1"]);
  });

  it("★ ปนกัน: เคสกลุ่มจริง + เคส 1-1 → เหลือเฉพาะกลุ่มจริง", async () => {
    const store: Store = makeStore({
      data: {
        conversation_cases: [caseRow("case-g", "grp-1"), caseRow("case-dm", "dm-1")],
        chat_groups: [
          { id: "grp-1", tenant_id: "t-1", group_kind: "group" },
          { id: "dm-1", tenant_id: "t-1", group_kind: "user" },
        ],
        ai_chat_analysis: [],
        sop_violations: [],
        case_status_history: [],
        chat_messages: [],
      },
    });
    const res = await aggregateAccountantSignals(makeDb(store), INPUT);
    expect(res.cases).toHaveLength(1);
    expect(res.cases[0].caseId).toBe("case-g");
    expect(res.chatGroupIds).toEqual(["grp-1"]);
  });
});
