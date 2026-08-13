import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type Capture, type Resolver } from "../helpers/fake-supabase";

/**
 * เทสต์ server actions ของหน้า "รับ/จ่ายเงินแยกจากบิล" (/chat-audit/accounting/payments — เฟส 2 ส่วน F)
 *   mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern tests/accounting/journal-entry-actions.test.ts
 *   ★ เน้นเทสต์บังคับตาม DoD: ปฏิเสธ overpay/บิลไม่ eligible เสมอ (server-side) + guard สโคปลูกค้า
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

import {
  recordBillPaymentAction,
  voidBillPaymentAction,
  setInstallmentPlanAction,
  clearInstallmentPlanAction,
} from "@/app/chat-audit/accounting/payments/actions";

const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const ENTRY_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const PAYMENT_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

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

type ScopeRow = { customer_id: string | null; entry_type: string; payment_method: string | null; status: string };
type PaymentExistsRow = { id: string; entry_id?: string };

function makeResolver(
  opts: {
    scope?: ScopeRow | null;
    lineAmounts?: { amount: number; vat_amount: number; wht_amount: number }[];
    existingPayments?: { id: string; amount: number }[];
    paymentExists?: PaymentExistsRow | null;
    installmentInsertError?: boolean;
  } = {}
): Resolver {
  return ({ table, op, terminal }) => {
    if (table === "bill_entries" && op === "select" && terminal === "maybeSingle") {
      return "scope" in opts
        ? { data: opts.scope, error: null }
        : { data: { customer_id: CUSTOMER_ID, entry_type: "sale", payment_method: "credit", status: "confirmed" }, error: null };
    }
    if (table === "bill_entry_lines" && terminal === "await") {
      return { data: opts.lineAmounts ?? [{ amount: 1000, vat_amount: 70, wht_amount: 0 }], error: null };
    }
    if (table === "rpc:set_bill_installment_plan") {
      return opts.installmentInsertError ? { data: null, error: { message: "insert failed" } } : { data: null, error: null };
    }
    if (table === "bill_installments" && op === "delete" && terminal === "await") {
      return { data: null, error: null };
    }
    if (table === "bill_payments") {
      if (op === "select" && terminal === "await") {
        return { data: opts.existingPayments ?? [], error: null };
      }
      if (op === "insert" && terminal === "maybeSingle") {
        return { data: { id: "new-payment-id" }, error: null };
      }
      if (op === "select" && terminal === "maybeSingle") {
        // ★ ใช้ maybeSingle ทั้ง "getPaymentScope" (ต้องมี entry_id) และ "voidBillPayment" (แค่ id) —
        //   คืน paymentExists ตัวเดียวกันให้ทั้งสอง (entry_id เดฟอลต์ = ENTRY_ID ถ้าไม่ระบุ)
        return "paymentExists" in opts
          ? { data: opts.paymentExists, error: null }
          : { data: { id: PAYMENT_ID, entry_id: ENTRY_ID }, error: null };
      }
      if (op === "update") {
        return { data: null, error: null };
      }
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

describe("recordBillPaymentAction", () => {
  it("บิลเชื่อยืนยันแล้ว + ยอดไม่เกินค้าง → บันทึกสำเร็จ", async () => {
    const res = await recordBillPaymentAction({
      entryId: ENTRY_ID,
      payDate: "2026-07-01",
      amount: 500,
      method: "cash",
    });
    expect(res.ok).toBe(true);
    const ins = currentCapture.inserts.find((i) => i.table === "bill_payments");
    expect(ins).toBeTruthy();
    expect((ins!.payload as Record<string, unknown>).amount).toBe(500);
  });

  it("★ ยอดเกินยอดค้างชำระ → ปฏิเสธ (server-side ไม่เชื่อ client)", async () => {
    const res = await recordBillPaymentAction({
      entryId: ENTRY_ID,
      payDate: "2026-07-01",
      amount: 5000, // net = 1000+70 = 1070 → เกิน
      method: "cash",
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "bill_payments")).toBeUndefined();
  });

  it("★ บิลไม่ eligible (payment_method ไม่ใช่ credit) → ปฏิเสธ", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, entry_type: "sale", payment_method: "cash", status: "confirmed" } });
    const res = await recordBillPaymentAction({
      entryId: ENTRY_ID,
      payDate: "2026-07-01",
      amount: 100,
      method: "cash",
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "bill_payments")).toBeUndefined();
  });

  it("บิลยังไม่ยืนยัน (draft) → ปฏิเสธ", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, entry_type: "sale", payment_method: "credit", status: "draft" } });
    const res = await recordBillPaymentAction({
      entryId: ENTRY_ID,
      payDate: "2026-07-01",
      amount: 100,
      method: "cash",
    });
    expect(res.ok).toBe(false);
  });

  it("วิธีชำระ = credit → ปฏิเสธเสมอ (การชำระจริงไม่มีทางเชื่อต่อได้อีก)", async () => {
    const res = await recordBillPaymentAction({
      entryId: ENTRY_ID,
      payDate: "2026-07-01",
      amount: 100,
      method: "credit",
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "bill_payments")).toBeUndefined();
  });

  it("ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ (ไม่แตะ DB)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await recordBillPaymentAction({
      entryId: ENTRY_ID,
      payDate: "2026-07-01",
      amount: 100,
      method: "cash",
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "bill_payments")).toBeUndefined();
  });

  it("ไม่พบบิล (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ scope: null });
    const res = await recordBillPaymentAction({
      entryId: ENTRY_ID,
      payDate: "2026-07-01",
      amount: 100,
      method: "cash",
    });
    expect(res.ok).toBe(false);
  });

  it("entryId ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await recordBillPaymentAction({
      entryId: "not-a-uuid",
      payDate: "2026-07-01",
      amount: 100,
      method: "cash",
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts).toHaveLength(0);
  });

  it("จ่ายบางส่วนไปแล้ว → ยอดค้างชำระลดตาม แล้วยอดใหม่เกินคงเหลือ → ปฏิเสธ", async () => {
    setupDb({ existingPayments: [{ id: "p1", amount: 1000 }] }); // net=1070 เหลือ 70
    const res = await recordBillPaymentAction({
      entryId: ENTRY_ID,
      payDate: "2026-07-01",
      amount: 100, // เกิน 70 ที่เหลือ
      method: "cash",
    });
    expect(res.ok).toBe(false);
  });
});

describe("voidBillPaymentAction", () => {
  it("ยกเลิกสำเร็จ (soft-delete)", async () => {
    const res = await voidBillPaymentAction(PAYMENT_ID);
    expect(res.ok).toBe(true);
    const upd = currentCapture.updates.find((u) => u.table === "bill_payments");
    expect(upd).toBeTruthy();
    expect((upd!.payload as Record<string, unknown>).deleted_at).toBeTruthy();
  });

  it("ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ (ไม่แตะ DB)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await voidBillPaymentAction(PAYMENT_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.find((u) => u.table === "bill_payments")).toBeUndefined();
  });

  it("ไม่พบบิลต้นทาง (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ scope: null });
    const res = await voidBillPaymentAction(PAYMENT_ID);
    expect(res.ok).toBe(false);
  });

  it("ไม่พบรายการรับ/จ่ายเงิน (ยกเลิกไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ paymentExists: null });
    const res = await voidBillPaymentAction(PAYMENT_ID);
    expect(res.ok).toBe(false);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await voidBillPaymentAction("not-a-uuid");
    expect(res.ok).toBe(false);
    expect(currentCapture.updates).toHaveLength(0);
  });

  it(
    "★★★ IDOR regression — payment จริงเป็นของลูกค้านอกสโคป (ผ่านสโคปของบิลต้นทางจริงของ payment นั้น) " +
      "แม้เคย exploit ได้ด้วย entryId ปลอมที่อยู่ในสโคป (ช่องโหว่เดิม: ตรวจสโคปจาก entryId ที่ client " +
      "ส่งมาแยกจาก paymentId ที่เขียนจริง) → ต้องปฏิเสธเสมอ ไม่แตะ DB",
    async () => {
      requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_ID]));
      // payment ตัวจริง (PAYMENT_ID) ผูกกับ ENTRY_ID ซึ่งบิลต้นทางเป็นของ CUSTOMER_OTHER (นอกสโคป)
      setupDb({
        paymentExists: { id: PAYMENT_ID, entry_id: ENTRY_ID },
        scope: { customer_id: CUSTOMER_OTHER, entry_type: "sale", payment_method: "credit", status: "confirmed" },
      });
      const res = await voidBillPaymentAction(PAYMENT_ID);
      expect(res.ok).toBe(false);
      expect(currentCapture.updates.find((u) => u.table === "bill_payments")).toBeUndefined();
    }
  );
});

// ★ wishlist ข้อ 7 — แผนงวดผ่อนชำระบนบิลเชื่อ AR/AP
describe("setInstallmentPlanAction", () => {
  it("แผนถูกต้อง (ยอดรวมเท่ายอดเต็มบิล net=1000) → บันทึกสำเร็จผ่าน RPC เดียว (atomic ลบของเก่า+insert ชุดใหม่)", async () => {
    setupDb({ lineAmounts: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }] });
    const res = await setInstallmentPlanAction(ENTRY_ID, [
      { dueDate: "2026-09-01", amount: 500 },
      { dueDate: "2026-10-01", amount: 500 },
    ]);
    expect(res.ok).toBe(true);
    const rpcCall = currentCapture.rpcs?.find((r) => r.fn === "set_bill_installment_plan");
    expect(rpcCall).toBeTruthy();
    expect((rpcCall!.params as { p_entry_id: string }).p_entry_id).toBe(ENTRY_ID);
  });

  it("★ ยอดรวมไม่เท่ายอดเต็มบิล → ปฏิเสธ ไม่แตะ DB", async () => {
    setupDb({ lineAmounts: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }] });
    const res = await setInstallmentPlanAction(ENTRY_ID, [
      { dueDate: "2026-09-01", amount: 500 },
      { dueDate: "2026-10-01", amount: 400 },
    ]);
    expect(res.ok).toBe(false);
    expect(currentCapture.rpcs?.find((r) => r.fn === "set_bill_installment_plan")).toBeUndefined();
  });

  it("★ บิลไม่ eligible (payment_method ไม่ใช่ credit) → ปฏิเสธ", async () => {
    setupDb({
      scope: { customer_id: CUSTOMER_ID, entry_type: "sale", payment_method: "cash", status: "confirmed" },
      lineAmounts: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }],
    });
    const res = await setInstallmentPlanAction(ENTRY_ID, [
      { dueDate: "2026-09-01", amount: 500 },
      { dueDate: "2026-10-01", amount: 500 },
    ]);
    expect(res.ok).toBe(false);
  });

  it("ไม่พบบิล (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ scope: null });
    const res = await setInstallmentPlanAction(ENTRY_ID, [
      { dueDate: "2026-09-01", amount: 500 },
      { dueDate: "2026-10-01", amount: 500 },
    ]);
    expect(res.ok).toBe(false);
  });

  it("ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ (ไม่แตะ DB)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    setupDb({ lineAmounts: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }] });
    const res = await setInstallmentPlanAction(ENTRY_ID, [
      { dueDate: "2026-09-01", amount: 500 },
      { dueDate: "2026-10-01", amount: 500 },
    ]);
    expect(res.ok).toBe(false);
    expect(currentCapture.rpcs?.find((r) => r.fn === "set_bill_installment_plan")).toBeUndefined();
  });

  it("entryId ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await setInstallmentPlanAction("not-a-uuid", [
      { dueDate: "2026-09-01", amount: 500 },
      { dueDate: "2026-10-01", amount: 500 },
    ]);
    expect(res.ok).toBe(false);
    expect(currentCapture.rpcs ?? []).toHaveLength(0);
  });

  it("DB insert ล้มเหลว → คืนข้อความปฏิเสธ", async () => {
    setupDb({ lineAmounts: [{ amount: 1000, vat_amount: 0, wht_amount: 0 }], installmentInsertError: true });
    const res = await setInstallmentPlanAction(ENTRY_ID, [
      { dueDate: "2026-09-01", amount: 500 },
      { dueDate: "2026-10-01", amount: 500 },
    ]);
    expect(res.ok).toBe(false);
  });
});

describe("clearInstallmentPlanAction", () => {
  it("ลบแผนสำเร็จ", async () => {
    setupDb();
    const res = await clearInstallmentPlanAction(ENTRY_ID);
    expect(res.ok).toBe(true);
    expect(currentCapture.deletes?.find((d) => d.table === "bill_installments")).toBeTruthy();
  });

  it("ไม่พบบิล (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ scope: null });
    const res = await clearInstallmentPlanAction(ENTRY_ID);
    expect(res.ok).toBe(false);
  });

  it("ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ (ไม่แตะ DB)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    setupDb();
    const res = await clearInstallmentPlanAction(ENTRY_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.deletes?.find((d) => d.table === "bill_installments")).toBeUndefined();
  });

  it("entryId ไม่ใช่ uuid → ปฏิเสธทันที", async () => {
    const res = await clearInstallmentPlanAction("not-a-uuid");
    expect(res.ok).toBe(false);
  });
});
