import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * เทสต์ action รายบรรทัดบนการ์ดหลายรายการ (★ 2026-09-03 "โอเคทำเลย")
 *   - patchBillLineAmountsAction: หัก ณ ที่จ่าย = round2(มูลค่า×อัตรา/100) · บิลยืนยันแล้วแก้ไม่ได้
 *   - setBillLineAccountAction: เขียนเฉพาะบรรทัดที่ชี้ + รหัสผิดรูปแบบ → ปฏิเสธ
 */

const { requireAccountingAccessMock } = vi.hoisted(() => ({
  requireAccountingAccessMock: vi.fn(),
}));

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
vi.mock("@/lib/accounting/account-learning", () => ({
  recordAccountRules: vi.fn(async () => {}),
}));

import { patchBillLineAmountsAction, setBillLineAccountAction } from "@/app/chat-audit/accounting/workspace/quickfix-actions";

const CID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ctx = {
  tenantId: "t1",
  mode: "accountant" as const,
  employeeId: "emp-1",
  name: "สวย",
  allowedCustomerIds: new Set([CID]),
  navRole: "accountant" as const,
};

type FakeState = {
  entryStatus: string;
  line: { id: string; amount: number; vat_amount: number; wht_rate: number } | null;
  updates: Record<string, unknown>[];
};
let state: FakeState;
let currentDb: unknown;

function makeDb(): unknown {
  function builder(table: string) {
    const b: Record<string, unknown> = {};
    let op: "select" | "update" = "select";
    let patch: Record<string, unknown> | null = null;
    const chain = () => b;
    b.select = () => ((op = "select"), b);
    b.update = (p: Record<string, unknown>) => ((op = "update"), (patch = p), b);
    b.eq = chain;
    b.is = chain;
    b.maybeSingle = async () => {
      if (table === "bill_entries") return { data: { id: EID, entry_type: "purchase", status: state.entryStatus } };
      if (table === "bill_entry_lines") return { data: state.line };
      return { data: null };
    };
    b.then = (resolve: (v: { error: null }) => void) => {
      if (op === "update" && patch) state.updates.push({ table, ...patch });
      resolve({ error: null });
    };
    return b;
  }
  return { from: (t: string) => builder(t) };
}

beforeEach(() => {
  state = { entryStatus: "draft", line: { id: LID, amount: 500, vat_amount: 0, wht_rate: 0 }, updates: [] };
  currentDb = makeDb();
  requireAccountingAccessMock.mockReset();
  requireAccountingAccessMock.mockResolvedValue(ctx);
});

describe("patchBillLineAmountsAction", () => {
  it("แก้อัตราหักเป็น 3% → หัก ณ ที่จ่าย = 500×3% = 15.00 (คำนวณให้เอง)", async () => {
    const r = await patchBillLineAmountsAction({ customerId: CID, entryId: EID, lineId: LID, whtRate: 3 });
    expect(r.ok).toBe(true);
    expect(r.whtAmount).toBe(15);
    expect(state.updates[0]).toMatchObject({ table: "bill_entry_lines", wht_rate: 3, wht_amount: 15 });
  });

  it("แก้มูลค่า + อัตราพร้อมกัน → ใช้ค่าใหม่ทั้งคู่ (1000×1% = 10)", async () => {
    const r = await patchBillLineAmountsAction({ customerId: CID, entryId: EID, lineId: LID, amount: 1000, whtRate: 1 });
    expect(r.ok).toBe(true);
    expect(r.whtAmount).toBe(10);
    expect(state.updates[0]).toMatchObject({ amount: 1000, wht_amount: 10 });
  });

  it("บิลยืนยันแล้ว → ปฏิเสธ ไม่แตะ DB", async () => {
    state.entryStatus = "confirmed";
    const r = await patchBillLineAmountsAction({ customerId: CID, entryId: EID, lineId: LID, amount: 999 });
    expect(r.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("อัตราหักเกิน 100 → ปฏิเสธ", async () => {
    const r = await patchBillLineAmountsAction({ customerId: CID, entryId: EID, lineId: LID, whtRate: 101 });
    expect(r.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });
});

describe("setBillLineAccountAction", () => {
  it("เขียนบัญชีลงบรรทัดที่ชี้ (สำเร็จ)", async () => {
    const r = await setBillLineAccountAction({
      customerId: CID, entryId: EID, lineId: LID, accountCode: "5340", accountName: "ค่าน้ำมัน", amount: 500,
    });
    expect(r.ok).toBe(true);
    expect(state.updates[0]).toMatchObject({ table: "bill_entry_lines", account_code: "5340" });
  });

  it("รหัสผิดรูปแบบ → ปฏิเสธ", async () => {
    const r = await setBillLineAccountAction({
      customerId: CID, entryId: EID, lineId: LID, accountCode: "abc!!$", accountName: "x",
    });
    expect(r.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("ไม่พบบรรทัด (คนละบิล) → ปฏิเสธ", async () => {
    state.line = null;
    const r = await setBillLineAccountAction({
      customerId: CID, entryId: EID, lineId: LID, accountCode: "5340", accountName: "ค่าน้ำมัน",
    });
    expect(r.ok).toBe(false);
  });
});
