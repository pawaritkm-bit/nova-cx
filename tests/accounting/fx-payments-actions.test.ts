import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type Capture, type Resolver } from "../helpers/fake-supabase";

/**
 * เทสต์ suggestFxGainLossNoteAction (เฟส 10 ส่วน AA, docs/06-accounting-features-roadmap.md, 0.5/0.14) —
 *   mock ชั้นล่างเหมือน payments-actions.test.ts เดิม (เฟส 2)
 *   ★ เน้นเทสต์บังคับ: never-auto-confirm (draft เสมอ) + dedupe (0.14) + guard สโคป (IDOR-safe)
 */

const { requireAccountingAccessMock } = vi.hoisted(() => ({
  requireAccountingAccessMock: vi.fn(),
}));

let currentDb: ReturnType<typeof makeFakeDb>["db"];
let currentCapture: Capture;

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ __authed: true })),
  createServiceRoleClient: vi.fn(() => currentDb),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/accounting/access", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/accounting/access")>();
  return {
    ...actual,
    requireAccountingAccess: (...args: unknown[]) => requireAccountingAccessMock(...args),
  };
});

import { suggestFxGainLossNoteAction } from "@/app/chat-audit/accounting/payments/actions";

const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const ENTRY_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const PAYMENT_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const OLD_NOTE_ID = "11111111-1111-1111-1111-111111111111";

const adminCtx = {
  tenantId: "tenant-1",
  mode: "admin" as const,
  employeeId: null,
  name: null,
  allowedCustomerIds: null,
  navRole: "admin" as const,
};

function accountantCtx(allowed: string[]) {
  return {
    tenantId: "tenant-1",
    mode: "accountant" as const,
    employeeId: "emp-1",
    name: "นักบัญชี",
    allowedCustomerIds: new Set(allowed),
    navRole: "accountant" as const,
  };
}

// ★ QC เฟส 10 (fix): บัญชีคู่ของ JV แนะนำเปลี่ยนจาก AR/AP → เงินสด/ธนาคารจริงของงวดนั้น (contraAccountFor) —
//   ต้องมี 1010 (เงินสด, fixture ทุกงวดในไฟล์นี้ใช้ method='cash') ในผังบัญชีทดสอบด้วย ไม่งั้น
//   validateManualEntryInput จะปฏิเสธ ("รหัสบัญชีไม่อยู่ในผังบัญชี")
const RAW_CHART = [
  { code: "1010", name: "เงินสด", category: "สินทรัพย์", is_bank: false },
  { code: "1140", name: "ลูกหนี้การค้า", category: "สินทรัพย์", is_bank: false },
  { code: "2010", name: "เจ้าหนี้การค้า", category: "หนี้สิน", is_bank: false },
  { code: "4025", name: "กำไร(ขาดทุน)จากอัตราแลกเปลี่ยน", category: "รายได้", is_bank: false },
];

type PaymentRow = {
  id: string;
  entry_id: string;
  customer_id: string | null;
  pay_date: string;
  amount: number;
  method: string;
  bank_account_id: string | null;
  notes: string | null;
  created_at: string;
  currency: string | null;
  fx_rate: number | null;
  fx_amount: number | null;
  fx_gain_loss_note_id: string | null;
};

type EntryScopeRow = {
  customer_id: string | null;
  entry_type: string;
  payment_method: string | null;
  status: string;
  doc_no?: string | null;
  currency?: string | null;
  fx_rate?: number | null;
};

function makeResolver(
  opts: {
    payment?: PaymentRow | null;
    entryScope?: EntryScopeRow | null;
    manualEntryTarget?: { customer_id: string; status: string } | null;
    claimSucceeds?: boolean;
  } = {}
): Resolver {
  const payment: PaymentRow | null =
    "payment" in opts
      ? opts.payment ?? null
      : {
          id: PAYMENT_ID,
          entry_id: ENTRY_ID,
          customer_id: CUSTOMER_ID,
          pay_date: "2026-08-01",
          amount: 3500,
          method: "cash",
          bank_account_id: null,
          notes: null,
          created_at: "2026-08-01T00:00:00Z",
          currency: "USD",
          fx_rate: 36.0,
          fx_amount: 100,
          fx_gain_loss_note_id: null,
        };
  const entryScope: EntryScopeRow | null =
    "entryScope" in opts
      ? opts.entryScope ?? null
      : { customer_id: CUSTOMER_ID, entry_type: "sale", payment_method: "credit", status: "confirmed", doc_no: "INV-001", currency: "USD", fx_rate: 35.0 };

  return ({ table, op, terminal }) => {
    if (table === "bill_payments" && op === "select" && terminal === "maybeSingle") {
      return { data: payment, error: null };
    }
    if (table === "bill_payments" && op === "update" && terminal === "maybeSingle") {
      return opts.claimSucceeds === false ? { data: null, error: null } : { data: { id: PAYMENT_ID }, error: null };
    }
    if (table === "bill_payments" && op === "update") {
      return { data: null, error: null };
    }
    if (table === "bill_entries" && op === "select" && terminal === "maybeSingle") {
      return { data: entryScope, error: null };
    }
    if (table === "chart_of_accounts" && terminal === "await") {
      return { data: RAW_CHART, error: null };
    }
    if (table === "manual_journal_entries" && op === "select" && terminal === "maybeSingle") {
      return { data: opts.manualEntryTarget ?? null, error: null };
    }
    if (table === "manual_journal_entries" && op === "insert" && terminal === "maybeSingle") {
      return { data: { id: "new-je-id" }, error: null };
    }
    if (table === "manual_journal_entry_lines" && terminal === "await") {
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };
}

function setupDb(opts: Parameters<typeof makeResolver>[0] = {}) {
  const { db, capture } = makeFakeDb(makeResolver(opts));
  currentDb = db;
  currentCapture = capture;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  setupDb();
});

describe("suggestFxGainLossNoteAction", () => {
  it("★ งวด FX ที่ยังไม่เคยแนะนำ → สร้าง JV draft สำเร็จ + ผูก fx_gain_loss_note_id กลับถูกต้อง (never-auto-confirm)", async () => {
    const res = await suggestFxGainLossNoteAction(PAYMENT_ID);
    expect(res.ok).toBe(true);
    const ins = currentCapture.inserts.find((i) => i.table === "manual_journal_entries");
    expect(ins).toBeTruthy();
    expect((ins!.payload as Record<string, unknown>).status).toBe("draft"); // ★ ต้องเป็น draft เสมอ
    const upd = currentCapture.updates.find((u) => u.table === "bill_payments");
    expect(upd).toBeTruthy();
    expect((upd!.payload as Record<string, unknown>).fx_gain_loss_note_id).toBe("new-je-id");
  });

  it("★ เรียกซ้ำงวดเดียวกันที่เคยแนะนำไปแล้ว (fx_gain_loss_note_id ชี้ JV ที่ยังไม่ถูกลบ) → ปฏิเสธ ไม่สร้าง JV ซ้ำสอง (dedupe 0.14)", async () => {
    setupDb({
      payment: {
        id: PAYMENT_ID,
        entry_id: ENTRY_ID,
        customer_id: CUSTOMER_ID,
        pay_date: "2026-08-01",
        amount: 3500,
        method: "cash",
        bank_account_id: null,
        notes: null,
        created_at: "2026-08-01T00:00:00Z",
        currency: "USD",
        fx_rate: 36.0,
        fx_amount: 100,
        fx_gain_loss_note_id: OLD_NOTE_ID,
      },
      manualEntryTarget: { customer_id: CUSTOMER_ID, status: "draft" }, // JV เดิมยังอยู่ (ไม่ถูกลบ)
    });
    const res = await suggestFxGainLossNoteAction(PAYMENT_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "manual_journal_entries")).toBeUndefined();
  });

  it("JV เดิมที่แนะนำไว้ถูกลบไปแล้ว (soft-deleted) → reset แล้วแนะนำใหม่ได้", async () => {
    setupDb({
      payment: {
        id: PAYMENT_ID,
        entry_id: ENTRY_ID,
        customer_id: CUSTOMER_ID,
        pay_date: "2026-08-01",
        amount: 3500,
        method: "cash",
        bank_account_id: null,
        notes: null,
        created_at: "2026-08-01T00:00:00Z",
        currency: "USD",
        fx_rate: 36.0,
        fx_amount: 100,
        fx_gain_loss_note_id: OLD_NOTE_ID,
      },
      manualEntryTarget: null, // getManualEntryScope หา JV เดิมไม่พบ = ถูกลบไปแล้ว
    });
    const res = await suggestFxGainLossNoteAction(PAYMENT_ID);
    expect(res.ok).toBe(true);
    expect(currentCapture.inserts.find((i) => i.table === "manual_journal_entries")).toBeTruthy();
  });

  it("งวดที่ไม่ใช่ FX (currency=null) → ปฏิเสธ (ไม่มีอะไรให้แนะนำ)", async () => {
    setupDb({
      payment: {
        id: PAYMENT_ID,
        entry_id: ENTRY_ID,
        customer_id: CUSTOMER_ID,
        pay_date: "2026-08-01",
        amount: 500,
        method: "cash",
        bank_account_id: null,
        notes: null,
        created_at: "2026-08-01T00:00:00Z",
        currency: null,
        fx_rate: null,
        fx_amount: null,
        fx_gain_loss_note_id: null,
      },
    });
    const res = await suggestFxGainLossNoteAction(PAYMENT_ID);
    expect(res.ok).toBe(false);
  });

  it("realized=0 (อัตราวันชำระเท่ากับอัตราตอนออกบิลพอดี) → ปฏิเสธข้อความชัดเจน ไม่สร้าง JV เปล่า", async () => {
    setupDb({
      payment: {
        id: PAYMENT_ID,
        entry_id: ENTRY_ID,
        customer_id: CUSTOMER_ID,
        pay_date: "2026-08-01",
        amount: 3500,
        method: "cash",
        bank_account_id: null,
        notes: null,
        created_at: "2026-08-01T00:00:00Z",
        currency: "USD",
        fx_rate: 35.0, // เท่ากับ entryScope.fx_rate (35.0) เป๊ะ
        fx_amount: 100,
        fx_gain_loss_note_id: null,
      },
    });
    const res = await suggestFxGainLossNoteAction(PAYMENT_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "manual_journal_entries")).toBeUndefined();
  });

  it("★★★ IDOR — นักบัญชีนอกสโคปเรียกกับ payment ของลูกค้าอื่น → ปฏิเสธ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await suggestFxGainLossNoteAction(PAYMENT_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "manual_journal_entries")).toBeUndefined();
  });

  it("paymentId ไม่ใช่ uuid → ปฏิเสธทันที ไม่แตะ DB", async () => {
    const res = await suggestFxGainLossNoteAction("not-a-uuid");
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts).toHaveLength(0);
  });

  it("ไม่พบ payment (ถูกยกเลิกไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ payment: null });
    const res = await suggestFxGainLossNoteAction(PAYMENT_ID);
    expect(res.ok).toBe(false);
  });

  it("แข่งกันกดปุ่มพร้อมกัน (claim ไม่ติด) → ปฏิเสธ ไม่ทำให้ JV draft ที่สร้างไปแล้วลอยไม่มีใครอ้างอิง(รู้ผลชัดเจน)", async () => {
    setupDb({ claimSucceeds: false });
    const res = await suggestFxGainLossNoteAction(PAYMENT_ID);
    expect(res.ok).toBe(false);
  });
});
