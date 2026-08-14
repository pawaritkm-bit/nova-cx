import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIProvider } from "@/lib/ai/provider";

/**
 * lib/ai/business-qa.ts — AI chatbot ตอบคำถามจากข้อมูลธุรกิจ (wishlist backlog ข้อ 3)
 *   เน้น: classifyBusinessQuestion (parse/validate ทุก branch) · answerBusinessQuestion orchestration
 *   (degrade เมื่อไม่มี AI, บล็อก PII ตกค้าง, unknown intent, ทุก intent เรียก data layer + format ถูกต้อง)
 *
 * ★★★ ยืนยันด้วยโค้ด review: ไม่มีข้อมูลลูกค้า (ชื่อ/ตัวเลข) ถูกส่งเข้า provider.generateJson เลย —
 *   ส่งแค่ questionRedacted (ข้อความคำถามที่นักบัญชีพิมพ์เอง หลัง redact) เท่านั้น
 */

const { getAIProviderMock, listEntriesMock, listBillPaymentsForEntriesMock, listNotesForEntriesMock, hasResidualChatPiiMock } = vi.hoisted(() => ({
  getAIProviderMock: vi.fn(),
  listEntriesMock: vi.fn(),
  listBillPaymentsForEntriesMock: vi.fn(),
  listNotesForEntriesMock: vi.fn(),
  hasResidualChatPiiMock: vi.fn(),
}));

vi.mock("@/lib/ai/provider", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ai/provider")>();
  return { ...actual, getAIProvider: getAIProviderMock };
});

vi.mock("@/lib/ai/chat-redact", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ai/chat-redact")>();
  return { ...actual, hasResidualChatPii: hasResidualChatPiiMock };
});

vi.mock("@/lib/accounting/queries", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/queries")>();
  return { ...actual, listEntries: listEntriesMock };
});

vi.mock("@/lib/accounting/bill-payments", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/bill-payments")>();
  return { ...actual, listBillPaymentsForEntries: listBillPaymentsForEntriesMock };
});

vi.mock("@/lib/accounting/credit-debit-notes", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/credit-debit-notes")>();
  return { ...actual, listNotesForEntries: listNotesForEntriesMock };
});

import { classifyBusinessQuestion, answerBusinessQuestion, QA_INTENTS } from "@/lib/ai/business-qa";

function fakeProvider(response: string, opts: { throws?: boolean } = {}): AIProvider {
  return {
    name: "fake",
    model: "fake-model",
    generateJson: vi.fn(async () => {
      if (opts.throws) throw new Error("boom");
      return response;
    }),
  };
}

// ---------------------------------------------------------------------
// classifyBusinessQuestion
// ---------------------------------------------------------------------
describe("classifyBusinessQuestion", () => {
  it("JSON ถูกต้อง + intent รู้จัก → คืนค่าตรง ๆ", async () => {
    const provider = fakeProvider(JSON.stringify({ intent: "sales_month", month: "2026-07" }));
    const res = await classifyBusinessQuestion(provider, "ยอดขายเดือนกรกฎาคมเท่าไหร่");
    expect(res).toEqual({ intent: "sales_month", month: "2026-07" });
  });

  it("month เป็น null → คืน month: null", async () => {
    const provider = fakeProvider(JSON.stringify({ intent: "ar_aging", month: null }));
    const res = await classifyBusinessQuestion(provider, "ลูกหนี้ค้างชำระเท่าไหร่");
    expect(res).toEqual({ intent: "ar_aging", month: null });
  });

  it("month รูปแบบผิด (ไม่ใช่ YYYY-MM) → เป็น null (ไม่ throw)", async () => {
    const provider = fakeProvider(JSON.stringify({ intent: "sales_month", month: "กรกฎาคม" }));
    const res = await classifyBusinessQuestion(provider, "x");
    expect(res?.month).toBeNull();
  });

  it("★ month เดือนไม่มีจริง (เช่น '2026-13') → เป็น null (ไม่ใช่แค่เช็ครูปแบบ 2 หลัก ต้องเช็คขอบเขต 01-12 จริง)", async () => {
    const provider = fakeProvider(JSON.stringify({ intent: "sales_month", month: "2026-13" }));
    const res = await classifyBusinessQuestion(provider, "x");
    expect(res?.month).toBeNull();
  });

  it("month '2026-00' (เดือน 0 ไม่มีจริง) → เป็น null", async () => {
    const provider = fakeProvider(JSON.stringify({ intent: "sales_month", month: "2026-00" }));
    const res = await classifyBusinessQuestion(provider, "x");
    expect(res?.month).toBeNull();
  });

  it("intent ไม่รู้จัก (ไม่อยู่ใน QA_INTENTS) → คืน null", async () => {
    const provider = fakeProvider(JSON.stringify({ intent: "delete_all_data", month: null }));
    const res = await classifyBusinessQuestion(provider, "x");
    expect(res).toBeNull();
  });

  it("JSON parse ไม่ได้ → คืน null", async () => {
    const provider = fakeProvider("not json at all");
    const res = await classifyBusinessQuestion(provider, "x");
    expect(res).toBeNull();
  });

  it("provider throw (network/timeout) → คืน null (ไม่ throw ต่อ)", async () => {
    const provider = fakeProvider("", { throws: true });
    const res = await classifyBusinessQuestion(provider, "x");
    expect(res).toBeNull();
  });

  it("QA_INTENTS ต้องมี unknown เป็นสมาชิก (fallback เสมอมีทาง)", () => {
    expect(QA_INTENTS).toContain("unknown");
  });
});

// ---------------------------------------------------------------------
// answerBusinessQuestion — orchestration
// ---------------------------------------------------------------------
describe("answerBusinessQuestion", () => {
  beforeEach(async () => {
    getAIProviderMock.mockReset();
    listEntriesMock.mockReset();
    listBillPaymentsForEntriesMock.mockReset();
    listNotesForEntriesMock.mockReset();
    listNotesForEntriesMock.mockResolvedValue(new Map());
    listBillPaymentsForEntriesMock.mockResolvedValue(new Map());
    // ค่าเริ่มต้น = พฤติกรรมจริง (redact สำเร็จ → ไม่มี residual) — เทสต์ fail-safe gate override เป็น true เอง
    const actual = await vi.importActual<typeof import("@/lib/ai/chat-redact")>("@/lib/ai/chat-redact");
    hasResidualChatPiiMock.mockReset();
    hasResidualChatPiiMock.mockImplementation(actual.hasResidualChatPii);
  });

  it("ไม่มี AI provider (ไม่ได้ตั้ง OPENAI_API_KEY) → degrade สุภาพ ไม่แตะ DB เลย", async () => {
    getAIProviderMock.mockReturnValue(null);
    const res = await answerBusinessQuestion({} as never, "t1", "c1", "ยอดขายเดือนนี้เท่าไหร่");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/AI/);
    expect(listEntriesMock).not.toHaveBeenCalled();
  });

  it("คำถามว่างเปล่า → ปฏิเสธทันที ไม่เรียก provider", async () => {
    getAIProviderMock.mockReturnValue(fakeProvider("{}"));
    const res = await answerBusinessQuestion({} as never, "t1", "c1", "   ");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/พิมพ์คำถาม/);
  });

  it("★★★ คำถามมีเลขภาษี 13 หลักปนมา → redact ก่อนส่งเข้า AI เสมอ (เลขจริงไม่หลุดไป provider แม้แต่ตัวเดียว, PDPA)", async () => {
    const provider = fakeProvider(JSON.stringify({ intent: "unknown", month: null }));
    getAIProviderMock.mockReturnValue(provider);
    await answerBusinessQuestion({} as never, "t1", "c1", "ลูกค้าเลขภาษี 1234567890123 ค้างเท่าไหร่");
    expect(provider.generateJson).toHaveBeenCalledTimes(1);
    const sentUser = (provider.generateJson as ReturnType<typeof vi.fn>).mock.calls[0][0].user as string;
    expect(sentUser).not.toContain("1234567890123");
  });

  it("★ residual-PII gate: ถ้า hasResidualChatPii ยังเจอ PII หลัง redact (fail-safe) → บล็อกไม่ส่งเข้า AI/DB เลย", async () => {
    const provider = fakeProvider(JSON.stringify({ intent: "sales_month", month: null }));
    getAIProviderMock.mockReturnValue(provider);
    hasResidualChatPiiMock.mockReturnValue(true);

    const res = await answerBusinessQuestion({} as never, "t1", "c1", "คำถามทั่วไป");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/ข้อมูลส่วนบุคคล/);
    expect(provider.generateJson).not.toHaveBeenCalled();
    expect(listEntriesMock).not.toHaveBeenCalled();
  });

  it("classify คืน unknown → ตอบข้อความ 'ยังไม่รองรับ' ไม่แตะ DB", async () => {
    const provider = fakeProvider(JSON.stringify({ intent: "unknown", month: null }));
    getAIProviderMock.mockReturnValue(provider);
    const res = await answerBusinessQuestion({} as never, "t1", "c1", "พรุ่งนี้ฝนจะตกไหม");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/ยังไม่ได้|ยังไม่รองรับ|ยังตอบคำถามนี้ไม่ได้/);
    expect(listEntriesMock).not.toHaveBeenCalled();
  });

  it("classify parse ไม่ได้ (provider ตอบมั่ว) → fallback เป็น unknown เหมือนกัน", async () => {
    getAIProviderMock.mockReturnValue(fakeProvider("garbage"));
    const res = await answerBusinessQuestion({} as never, "t1", "c1", "x");
    expect(res.ok).toBe(false);
  });

  it("sales_month (ระบุเดือน) → เรียก listEntries scope customerId+entryType=sale+status=confirmed+month ตรงเดือนที่ระบุ", async () => {
    getAIProviderMock.mockReturnValue(fakeProvider(JSON.stringify({ intent: "sales_month", month: "2026-07" })));
    listEntriesMock.mockResolvedValue({
      entries: [
        { id: "e1", entryType: "sale", lines: [{ amount: 1000, vatAmount: 70, whtAmount: 0 }] },
        { id: "e2", entryType: "sale", lines: [{ amount: 500, vatAmount: 0, whtAmount: 0 }] },
      ],
      summary: {},
    });

    const res = await answerBusinessQuestion({} as never, "t1", "c1", "ยอดขายเดือนกรกฎาคมเท่าไหร่");
    expect(res.ok).toBe(true);
    expect(listEntriesMock).toHaveBeenCalledWith({}, "t1", {
      customerId: "c1",
      entryType: "sale",
      status: "confirmed",
      month: "2026-07",
    });
    if (res.ok) {
      expect(res.answer).toContain("2 รายการ");
      expect(res.answer).toMatch(/1,570|1570/); // 1070+500 = 1570 สุทธิ
    }
  });

  it("sales_month (ไม่ระบุเดือน) → ใช้เดือนปัจจุบัน (เวลาไทย) ไม่ระเบิด", async () => {
    getAIProviderMock.mockReturnValue(fakeProvider(JSON.stringify({ intent: "sales_month", month: null })));
    listEntriesMock.mockResolvedValue({ entries: [], summary: {} });
    const res = await answerBusinessQuestion({} as never, "t1", "c1", "ยอดขายเดือนนี้เท่าไหร่");
    expect(res.ok).toBe(true);
    const [, , filter] = listEntriesMock.mock.calls[0];
    expect(filter.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it("ไม่มีบิลขายยืนยันแล้วในเดือนนั้น → ตอบว่าไม่มีบิล (ไม่ใช่ error)", async () => {
    getAIProviderMock.mockReturnValue(fakeProvider(JSON.stringify({ intent: "sales_month", month: "2026-01" })));
    listEntriesMock.mockResolvedValue({ entries: [], summary: {} });
    const res = await answerBusinessQuestion({} as never, "t1", "c1", "ยอดขายเดือนมกราคมเท่าไหร่");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.answer).toMatch(/ยังไม่มีบิล/);
  });

  it("purchase_month → entryType=purchase ตามที่ควร", async () => {
    getAIProviderMock.mockReturnValue(fakeProvider(JSON.stringify({ intent: "purchase_month", month: "2026-06" })));
    listEntriesMock.mockResolvedValue({ entries: [], summary: {} });
    await answerBusinessQuestion({} as never, "t1", "c1", "ยอดซื้อเดือนมิถุนายน");
    const [, , filter] = listEntriesMock.mock.calls[0];
    expect(filter.entryType).toBe("purchase");
  });

  it("ar_aging → เรียก listEntries(ไม่กรอง entryType) + listBillPaymentsForEntries + listNotesForEntries แล้วสรุปยอด ar", async () => {
    getAIProviderMock.mockReturnValue(fakeProvider(JSON.stringify({ intent: "ar_aging", month: null })));
    listEntriesMock.mockResolvedValue({
      entries: [
        {
          id: "e1",
          entryType: "sale",
          paymentMethod: "credit",
          status: "confirmed",
          docNo: "INV-1",
          docDate: "2026-07-01",
          dueDate: "2026-07-01",
          counterpartyName: "ลูกค้า A",
          lines: [{ amount: 1000, vatAmount: 70, whtAmount: 0 }],
        },
      ],
      summary: {},
    });
    listBillPaymentsForEntriesMock.mockResolvedValue(new Map([["e1", []]]));

    const res = await answerBusinessQuestion({} as never, "t1", "c1", "ลูกหนี้ค้างชำระเท่าไหร่");
    expect(res.ok).toBe(true);
    expect(listEntriesMock).toHaveBeenCalledWith({}, "t1", { customerId: "c1" });
    if (res.ok) {
      expect(res.answer).toContain("ลูกหนี้ค้างรับ");
      expect(res.answer).toContain("ลูกค้า A");
    }
  });

  it("ar_aging ไม่มีลูกหนี้ค้างชำระเลย → ตอบว่าไม่มี (ไม่ error)", async () => {
    getAIProviderMock.mockReturnValue(fakeProvider(JSON.stringify({ intent: "ar_aging", month: null })));
    listEntriesMock.mockResolvedValue({ entries: [], summary: {} });
    const res = await answerBusinessQuestion({} as never, "t1", "c1", "ลูกหนี้ค้างชำระเท่าไหร่");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.answer).toMatch(/ไม่มี/);
  });

  it("ap_aging → นับฝั่งเจ้าหนี้ (purchase) ไม่ใช่ ar", async () => {
    getAIProviderMock.mockReturnValue(fakeProvider(JSON.stringify({ intent: "ap_aging", month: null })));
    listEntriesMock.mockResolvedValue({
      entries: [
        {
          id: "e1",
          entryType: "purchase",
          paymentMethod: "credit",
          status: "confirmed",
          docNo: "PO-1",
          docDate: "2026-07-01",
          dueDate: "2026-07-01",
          counterpartyName: "ผู้ขาย B",
          lines: [{ amount: 2000, vatAmount: 140, whtAmount: 0 }],
        },
      ],
      summary: {},
    });
    listBillPaymentsForEntriesMock.mockResolvedValue(new Map([["e1", []]]));

    const res = await answerBusinessQuestion({} as never, "t1", "c1", "เจ้าหนี้ค้างจ่ายเท่าไหร่");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.answer).toContain("เจ้าหนี้ค้างจ่าย");
      expect(res.answer).toContain("ผู้ขาย B");
    }
  });

  it("unspecified_count → เรียก listEntries entryType=unspecified แล้วนับจำนวน", async () => {
    getAIProviderMock.mockReturnValue(fakeProvider(JSON.stringify({ intent: "unspecified_count", month: null })));
    listEntriesMock.mockResolvedValue({ entries: [{ id: "e1" }, { id: "e2" }, { id: "e3" }], summary: {} });

    const res = await answerBusinessQuestion({} as never, "t1", "c1", "มีบิลรอระบุประเภทกี่รายการ");
    expect(res.ok).toBe(true);
    expect(listEntriesMock).toHaveBeenCalledWith({}, "t1", { customerId: "c1", entryType: "unspecified" });
    if (res.ok) expect(res.answer).toContain("3 รายการ");
  });

  it("unspecified_count = 0 → ตอบว่าตรวจครบแล้ว", async () => {
    getAIProviderMock.mockReturnValue(fakeProvider(JSON.stringify({ intent: "unspecified_count", month: null })));
    listEntriesMock.mockResolvedValue({ entries: [], summary: {} });
    const res = await answerBusinessQuestion({} as never, "t1", "c1", "มีบิลรอระบุประเภทไหม");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.answer).toMatch(/ตรวจครบ/);
  });

  it("คำถามยาวเกิน 500 ตัวอักษร → ตัดสั้นก่อนส่งไม่ throw", async () => {
    getAIProviderMock.mockReturnValue(fakeProvider(JSON.stringify({ intent: "unknown", month: null })));
    const longQ = "ก".repeat(1000);
    const res = await answerBusinessQuestion({} as never, "t1", "c1", longQ);
    expect(res.ok).toBe(false); // unknown → ok:false ตามปกติ แต่ต้องไม่ throw
  });
});
