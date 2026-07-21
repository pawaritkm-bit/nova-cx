import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  summarizeOffice,
  countSentiments,
  aggregateTopics,
  selectAttention,
  getOfficeDashboard,
  type OfficeAnalysisRow,
} from "@/lib/office/queries";

// ---------------------------------------------------------------------
// helper สร้างแถวดิบ
// ---------------------------------------------------------------------
function row(p: Partial<OfficeAnalysisRow>): OfficeAnalysisRow {
  return {
    id: p.id ?? "a1",
    chat_group_id: p.chat_group_id ?? "g1",
    window_start: p.window_start ?? null,
    window_end: p.window_end ?? null,
    message_count: p.message_count ?? 0,
    summary: p.summary ?? null,
    sentiment: p.sentiment ?? null,
    urgency: p.urgency ?? null,
    topics: p.topics ?? [],
    is_complaint: p.is_complaint ?? false,
    needs_attention: p.needs_attention ?? false,
    created_at: p.created_at ?? "2026-07-20T00:00:00Z",
  };
}

// ---------------------------------------------------------------------
// aggregate (pure)
// ---------------------------------------------------------------------
describe("summarizeOffice — รวมข้อความ + นับ needs_attention/complaint", () => {
  it("รวม message_count และนับ flag ถูกต้อง", () => {
    const s = summarizeOffice([
      row({ message_count: 3, needs_attention: true }),
      row({ message_count: 2, is_complaint: true }),
      row({ message_count: 5, needs_attention: true, is_complaint: true }),
    ]);
    expect(s.inboundMessageCount).toBe(10);
    expect(s.needsAttentionCount).toBe(2);
    expect(s.complaintCount).toBe(2);
    expect(s.analyzedCount).toBe(3);
  });

  it("ว่าง → ศูนย์ทั้งหมด", () => {
    expect(summarizeOffice([])).toEqual({
      inboundMessageCount: 0,
      needsAttentionCount: 0,
      complaintCount: 0,
      analyzedCount: 0,
    });
  });
});

describe("countSentiments — นับสัดส่วนอารมณ์ (ข้าม null/ไม่รู้จัก)", () => {
  it("นับเฉพาะค่า valid", () => {
    const c = countSentiments([
      row({ sentiment: "positive" }),
      row({ sentiment: "positive" }),
      row({ sentiment: "negative" }),
      row({ sentiment: null }),
      row({ sentiment: "weird" }),
    ]);
    expect(c).toEqual({ positive: 2, neutral: 0, negative: 1 });
  });
});

describe("aggregateTopics — นับความถี่หัวข้อ เรียงมาก→น้อย top N", () => {
  it("รวมแบบ case-insensitive + เรียงถูก + ตัด limit", () => {
    const top = aggregateTopics(
      [
        row({ topics: ["ภาษี", "เอกสาร"] }),
        row({ topics: ["ภาษี", "ทวงเอกสาร"] }),
        row({ topics: ["ภาษี"] }),
        row({ topics: ["เอกสาร"] }),
      ],
      2
    );
    expect(top).toHaveLength(2);
    expect(top[0]).toEqual({ topic: "ภาษี", count: 3 });
    expect(top[1]).toEqual({ topic: "เอกสาร", count: 2 });
  });

  it("รองรับ topics เป็น object {topic/label} และข้ามค่าว่าง/ไม่ใช่ array", () => {
    const top = aggregateTopics([
      row({ topics: [{ topic: "VAT" }, { label: "งบ" }, "  "] }),
      row({ topics: "not-array" as unknown }),
      row({ topics: [{ topic: "VAT" }] }),
    ]);
    expect(top.find((t) => t.topic === "VAT")?.count).toBe(2);
    expect(top.find((t) => t.topic === "งบ")?.count).toBe(1);
    // ค่าว่าง "  " ต้องไม่ถูกนับ
    expect(top.some((t) => t.topic.trim() === "")).toBe(false);
  });
});

describe("selectAttention — คัด+เรียงบทสนทนาที่ต้องดูด่วน", () => {
  it("คัดเฉพาะ needs_attention/is_complaint แล้วเรียง urgency critical→low", () => {
    const sorted = selectAttention([
      row({ id: "low", urgency: "low", needs_attention: true }),
      row({ id: "crit", urgency: "critical", is_complaint: true }),
      row({ id: "skip" }), // ไม่เข้าเงื่อนไข
      row({ id: "high", urgency: "high", needs_attention: true }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["crit", "high", "low"]);
  });

  it("urgency เท่ากัน → เรียงเวลาใหม่→เก่า (window_end ก่อน created_at)", () => {
    const sorted = selectAttention([
      row({ id: "old", urgency: "high", needs_attention: true, window_end: "2026-07-01T00:00:00Z" }),
      row({ id: "new", urgency: "high", needs_attention: true, window_end: "2026-07-10T00:00:00Z" }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["new", "old"]);
  });
});

// ---------------------------------------------------------------------
// getOfficeDashboard — fake db (ยืนยัน filter tenant + group_kind='user')
// ---------------------------------------------------------------------
type Filter = [string, string, unknown];
type CallRec = { table: string; filters: Filter[] };

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
    b.gte = (c: string, v: unknown) => {
      rec.filters.push(["gte", c, v]);
      return b;
    };
    b.is = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: dataByTable[table] ?? [], error: null }).then(res, rej);
    return b;
  };
  return { from: (t: string) => make(t) } as unknown as SupabaseClient;
}

function hasFilter(calls: CallRec[], table: string, kind: string, col: string, val: unknown): boolean {
  return calls.some(
    (c) =>
      c.table === table &&
      c.filters.some(([k, cc, vv]) => k === kind && cc === col && JSON.stringify(vv) === JSON.stringify(val))
  );
}

describe("getOfficeDashboard — กรอง tenant + group_kind='user' และประกอบผล", () => {
  it("บังคับ eq tenant_id ทั้งสองตาราง + eq group_kind='user' บน chat_groups", async () => {
    const calls: CallRec[] = [];
    const db = makeDb({ office_inbound_analysis: [], chat_groups: [] }, calls);
    await getOfficeDashboard(db, "t1", { sinceMs: null });

    expect(hasFilter(calls, "office_inbound_analysis", "eq", "tenant_id", "t1")).toBe(true);
    expect(hasFilter(calls, "chat_groups", "eq", "tenant_id", "t1")).toBe(true);
    // ★ กันปนกับกลุ่ม/ห้อง (per-accountant) — ต้องอ่านเฉพาะบทสนทนา 1-1
    expect(hasFilter(calls, "chat_groups", "eq", "group_kind", "user")).toBe(true);
    // ★ ห้ามแตะตารางของ flow ประเมินนักบัญชีรายคน
    for (const forbidden of ["conversation_cases", "ai_chat_analysis", "accountant_evaluations", "risk_alerts"]) {
      expect(calls.some((c) => c.table === forbidden)).toBe(false);
    }
  });

  it("มี sinceMs → เพิ่ม gte created_at (ตัดช่วงเวลา)", async () => {
    const calls: CallRec[] = [];
    const db = makeDb({ office_inbound_analysis: [], chat_groups: [] }, calls);
    const since = Date.parse("2026-07-01T00:00:00Z");
    await getOfficeDashboard(db, "t1", { sinceMs: since });
    expect(
      calls.some(
        (c) =>
          c.table === "office_inbound_analysis" &&
          c.filters.some(([k, cc]) => k === "gte" && cc === "created_at")
      )
    ).toBe(true);
  });

  it("ประกอบ conversationCount จาก chat_groups + สรุป/หัวข้อ/attention จาก analysis", async () => {
    const calls: CallRec[] = [];
    const db = makeDb(
      {
        chat_groups: [
          { id: "g1", display_name_enc: null },
          { id: "g2", display_name_enc: null },
        ],
        office_inbound_analysis: [
          {
            id: "a1",
            chat_group_id: "g1",
            window_start: null,
            window_end: "2026-07-20T00:00:00Z",
            message_count: 4,
            summary: "ลูกค้าโมโหเรื่องเอกสารช้า",
            sentiment: "negative",
            urgency: "critical",
            topics: ["เอกสาร", "ภาษี"],
            is_complaint: true,
            needs_attention: true,
            created_at: "2026-07-20T00:00:00Z",
          },
          {
            id: "a2",
            chat_group_id: "g2",
            window_start: null,
            window_end: "2026-07-19T00:00:00Z",
            message_count: 2,
            summary: "สอบถามทั่วไป",
            sentiment: "positive",
            urgency: "low",
            topics: ["ภาษี"],
            is_complaint: false,
            needs_attention: false,
            created_at: "2026-07-19T00:00:00Z",
          },
        ],
      },
      calls
    );

    const d = await getOfficeDashboard(db, "t1", { sinceMs: null });
    expect(d.conversationCount).toBe(2);
    expect(d.inboundMessageCount).toBe(6);
    expect(d.needsAttentionCount).toBe(1);
    expect(d.complaintCount).toBe(1);
    expect(d.sentiment).toEqual({ positive: 1, neutral: 0, negative: 1 });
    expect(d.topTopics[0]).toEqual({ topic: "ภาษี", count: 2 });
    // attention เฉพาะ a1 (needs_attention/complaint) + มี label fallback (ไม่มีคีย์ decrypt)
    expect(d.attention).toHaveLength(1);
    expect(d.attention[0].id).toBe("a1");
    expect(d.attention[0].customerLabel).toBeTruthy();
    // recent เรียงตาม created_at desc ที่ query คืนมา
    expect(d.recent.map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  it("ตารางว่าง → ค่าเริ่มต้น empty ไม่ throw", async () => {
    const calls: CallRec[] = [];
    const db = makeDb({ office_inbound_analysis: [], chat_groups: [] }, calls);
    const d = await getOfficeDashboard(db, "t1", {});
    expect(d.conversationCount).toBe(0);
    expect(d.analyzedCount).toBe(0);
    expect(d.attention).toEqual([]);
    expect(d.recent).toEqual([]);
    expect(d.topTopics).toEqual([]);
  });
});
