/**
 * Unit test ชั้น dashboard queries (pure aggregation จาก view rows)
 *   - ★ escalation summary ต้องนับจาก "ชุดเคสเต็ม" (ก่อน cap list) → ตรงกับ cases.urgent
 *   - ★ callList ต้องกรองเฉพาะคน "ยังไม่ประเมิน + มีเบอร์" (has_phone)
 *
 * ใช้ fake db แบบ thenable: db.from(table).select(cols) → Promise<{ data }>
 *   (queries เรียก await db.from(...).select(...) เป็น terminal)
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getExecDashboard, getMemberDashboard } from "@/lib/dashboard/queries";

const H = 3_600_000;
const NOW = Date.parse("2026-07-17T12:00:00Z");

/** fake db: คืน rows ตามชื่อ table; select() เป็น terminal (thenable) */
function makeDb(rowsByTable: Record<string, unknown[]>): SupabaseClient {
  return {
    from(table: string) {
      return {
        select() {
          return Promise.resolve({ data: rowsByTable[table] ?? [], error: null });
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe("getExecDashboard — escalation นับจากชุดเต็ม (regression: เดิม slice ก่อนนับ)", () => {
  it("เคสด่วน 150 (เกิน cap 100) → escalation.total = 150 และตรงกับ cases.urgent, list ถูก cap ที่ 100", async () => {
    // สร้างเคสด่วนเปิดอยู่ 150 (critical 90 + high 60) + เคสปิด/ระดับกลางที่ต้องไม่ถูกนับ
    const cases: unknown[] = [];
    for (let i = 0; i < 90; i++) {
      cases.push({
        case_id: `crit-${i}`,
        case_no: `C-${i}`,
        customer_id: null,
        customer_code: null,
        type: "complaint",
        level: "critical",
        status: "open",
        // ครึ่งแรกเกิน SLA (overdue), ครึ่งหลังยังไม่เกิน
        sla_due_at: new Date(NOW + (i < 45 ? -1 : 5) * H).toISOString(),
        created_at: new Date(NOW - 10 * H).toISOString(),
        closed_at: null,
        post_resolution_csat: null,
      });
    }
    for (let i = 0; i < 60; i++) {
      cases.push({
        case_id: `high-${i}`,
        case_no: `H-${i}`,
        customer_id: null,
        customer_code: null,
        type: "complaint",
        level: "high",
        status: "in_progress",
        sla_due_at: new Date(NOW + 3 * H).toISOString(),
        created_at: new Date(NOW - 10 * H).toISOString(),
        closed_at: null,
        post_resolution_csat: null,
      });
    }
    // เคสที่ต้องไม่ถูกนับเป็น urgent: critical แต่ปิดแล้ว + medium เปิดอยู่
    cases.push({
      case_id: "closed-crit",
      case_no: "X-1",
      type: "complaint",
      level: "critical",
      status: "closed",
      sla_due_at: null,
      created_at: new Date(NOW - 20 * H).toISOString(),
      closed_at: new Date(NOW - 1 * H).toISOString(),
      post_resolution_csat: 5,
    });
    cases.push({
      case_id: "med-open",
      case_no: "M-1",
      type: "inquiry",
      level: "medium",
      status: "open",
      sla_due_at: null,
      created_at: new Date(NOW - 5 * H).toISOString(),
      closed_at: null,
      post_resolution_csat: null,
    });

    const db = makeDb({
      v_dashboard_response_facts: [],
      v_team_score_facts: [],
      v_dashboard_case_facts: cases,
    });

    const d = await getExecDashboard(db, NOW);

    // escalation นับจากชุดเต็ม (ไม่ถูก slice)
    expect(d.escalation.total).toBe(150);
    expect(d.escalation.critical).toBe(90);
    expect(d.escalation.high).toBe(60);
    expect(d.escalation.overdue).toBe(45); // critical 45 ตัวแรกที่เกิน SLA
    // ★ ตรงกับการ์ด KPI "สรุปสถานะเคส"
    expect(d.cases.urgent).toBe(150);
    expect(d.escalation.total).toBe(d.cases.urgent);
    // urgentTotal = ชุดเต็ม, list แสดง cap ที่ 100
    expect(d.urgentTotal).toBe(150);
    expect(d.urgentCases.length).toBe(100);
    // list เรียงตามความเร่งด่วน → 100 ตัวแรกต้องเป็นเคสที่เกิน SLA/critical มาก่อน
    expect(d.urgentCases[0].level).toBe("critical");
  });

  it("ไม่มีเคสด่วน → escalation ทุกค่าเป็น 0", async () => {
    const db = makeDb({
      v_dashboard_response_facts: [],
      v_team_score_facts: [],
      v_dashboard_case_facts: [],
    });
    const d = await getExecDashboard(db, NOW);
    expect(d.escalation).toEqual({ total: 0, critical: 0, high: 0, overdue: 0 });
    expect(d.urgentTotal).toBe(0);
    expect(d.urgentCases.length).toBe(0);
  });
});

describe("getMemberDashboard — callList กรอง has_phone (ตรงกับคอมเมนต์: โทรตามเฉพาะมีเบอร์)", () => {
  function track(
    id: string,
    isResponded: boolean | null,
    hasPhone: boolean,
    reminder = 0
  ) {
    return {
      invitation_id: id,
      customer_id: `cus-${id}`,
      customer_name: `ลูกค้า ${id}`,
      customer_code: id,
      survey_type: "A",
      cycle_period: "2026-Q3",
      invitation_status: "sent",
      is_responded: isResponded,
      reminder_count: reminder,
      has_phone: hasPhone,
      invited_at: new Date(NOW).toISOString(),
      last_reminded_at: null,
    };
  }

  it("ตัดคนไม่มีเบอร์ออกจาก callList (แต่ tracking total ยังนับทุกคน)", async () => {
    const tracking = [
      track("a", false, true, 2), // ยังไม่ตอบ + มีเบอร์ → อยู่ใน callList
      track("b", false, false, 1), // ยังไม่ตอบ + ไม่มีเบอร์ → ต้องถูกตัด
      track("c", true, true, 0), // ตอบแล้ว → ไม่อยู่ใน callList
      track("d", null, true, 5), // ยังไม่ตอบ (null) + มีเบอร์ → อยู่ใน callList
    ];
    const db = makeDb({
      v_feedback_for_evaluatee: [],
      v_customer_tracking: tracking,
    });

    const d = await getMemberDashboard(db, "accountant");

    const ids = d.callList.map((r) => r.invitation_id);
    expect(ids).toContain("a");
    expect(ids).toContain("d");
    expect(ids).not.toContain("b"); // ★ ไม่มีเบอร์ ต้องไม่โผล่
    expect(ids).not.toContain("c"); // ตอบแล้ว
    // เรียงตาม reminder_count มาก→น้อย
    expect(d.callList[0].invitation_id).toBe("d");
    // tracking total ยังนับทุกแถว (4) — การกรองมีผลเฉพาะ callList
    expect(d.tracking.total).toBe(4);
    expect(d.tracking.responded).toBe(1);
    expect(d.tracking.notResponded).toBe(3);
  });
});
