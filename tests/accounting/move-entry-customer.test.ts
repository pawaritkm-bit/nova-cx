import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * เทสต์ moveEntryCustomerAction — ★ 2026-09-02 ผู้ใช้: "นักบัญชีสามารถแก้ ลบ และย้ายบิลเองได้
 * ไม่จำเป็นต้องเป็นสิทธิ์ฝั่งเซิร์ฟเวอร์ (admin)" — ย้ายบิลไปบริษัทอื่นในสโคปตัวเอง
 *
 * บังคับตามสัญญา:
 *   - นักบัญชีย้ายได้เฉพาะระหว่างลูกค้าในความดูแลตัวเอง (ต้นทาง+ปลายทางต้อง in-scope ทั้งคู่)
 *   - ย้ายแล้วล้าง payment_bank_account_id (FK บัญชีธนาคาร per-customer ของบริษัทเดิม)
 *   - ปลายทาง = ต้นทาง → ปฏิเสธ ไม่แตะ DB
 *   - ปลายทางไม่มีจริงใน tenant → ปฏิเสธ
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

import { moveEntryCustomerAction } from "@/app/chat-audit/accounting/actions";

const ENTRY_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SRC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OUTSIDE = "ffffffff-ffff-4fff-8fff-ffffffffffff";

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

// ---- fake supabase: บันทึก update ที่เกิดขึ้น + คืนแถวตามที่ตั้งไว้ ----
type FakeState = {
  entryCustomerId: string | null;
  targetExists: boolean;
  updates: Record<string, unknown>[];
};
let state: FakeState;
let currentDb: unknown;

function makeDb(): unknown {
  function builder(table: string) {
    const b: Record<string, unknown> = {};
    let op: "select" | "update" = "select";
    let patch: Record<string, unknown> | null = null;
    const chain = (): typeof b => b;
    b.select = () => (op = "select") && b;
    b.update = (p: Record<string, unknown>) => {
      op = "update";
      patch = p;
      return b;
    };
    b.eq = chain;
    b.is = chain;
    b.not = chain;
    b.maybeSingle = async () => {
      if (table === "bill_entries") {
        return state.entryCustomerId === undefined
          ? { data: null }
          : { data: { customer_id: state.entryCustomerId } };
      }
      if (table === "customers") {
        return state.targetExists
          ? { data: { id: DST, name: "บริษัทปลายทาง", customer_code: "N999" } }
          : { data: null };
      }
      return { data: null };
    };
    // update chain ถูก await ตรง ๆ (thenable)
    b.then = (resolve: (v: { error: null }) => void) => {
      if (op === "update" && patch) state.updates.push({ table, ...patch });
      resolve({ error: null });
    };
    return b;
  }
  return { from: (t: string) => builder(t) };
}

beforeEach(() => {
  state = { entryCustomerId: SRC, targetExists: true, updates: [] };
  currentDb = makeDb();
  requireAccountingAccessMock.mockReset();
});

describe("moveEntryCustomerAction", () => {
  it("นักบัญชีย้ายบิลระหว่างลูกค้าในสโคปตัวเองได้ — เขียน customer_id ใหม่ + ล้างบัญชีธนาคารเดิม", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([SRC, DST]));
    const res = await moveEntryCustomerAction(ENTRY_ID, DST);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("N999");
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      table: "bill_entries",
      customer_id: DST,
      payment_bank_account_id: null,
    });
  });

  it("ปลายทางนอกสโคปนักบัญชี → ปฏิเสธ ไม่แตะ DB", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([SRC]));
    const res = await moveEntryCustomerAction(ENTRY_ID, DST);
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("ต้นทางนอกสโคปนักบัญชี (บิลของคนอื่น) → ปฏิเสธ", async () => {
    state.entryCustomerId = OUTSIDE;
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([SRC, DST]));
    const res = await moveEntryCustomerAction(ENTRY_ID, DST);
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("ปลายทาง = บริษัทเดิม → ปฏิเสธ (บิลอยู่บริษัทนี้อยู่แล้ว)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([SRC, DST]));
    const res = await moveEntryCustomerAction(ENTRY_ID, SRC);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("อยู่แล้ว");
    expect(state.updates).toHaveLength(0);
  });

  it("ปลายทางไม่มีจริงใน tenant → ปฏิเสธ ไม่เขียน", async () => {
    state.targetExists = false;
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([SRC, DST]));
    const res = await moveEntryCustomerAction(ENTRY_ID, DST);
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });
});
