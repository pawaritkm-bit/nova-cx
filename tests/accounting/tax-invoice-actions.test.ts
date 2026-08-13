import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type Capture, type Resolver } from "../helpers/fake-supabase";

/**
 * เทสต์ server actions ของหน้า "ใบกำกับภาษี" (/chat-audit/accounting/tax-invoices — wishlist backlog)
 *   mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern tests/accounting/sales-documents-actions.test.ts
 *   ★ เน้นเทสต์บังคับ: guard สโคปลูกค้า (customerId ตอนออก + IDOR ผ่าน getTaxInvoiceScope ตอนยกเลิก) ·
 *     ออกได้เลขจริงไม่ซ้ำ (จำลองเรียกซ้อนด้วย Promise.all) · ยกเลิกเฉพาะจาก issued
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

import { issueTaxInvoiceAction, voidTaxInvoiceAction } from "@/app/chat-audit/accounting/tax-invoices/actions";

const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const BILL_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const BILL_ID_2 = "abababab-abab-abab-abab-abababababab";
const INVOICE_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

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

type BillRow = { id: string; customer_id: string; entry_type: string; status: string } | null;
type ScopeRow = { customer_id: string; status: string } | null;

function makeResolver(
  opts: {
    bill?: BillRow;
    invoiceScope?: ScopeRow;
    voidSucceeds?: boolean;
  } = {}
): Resolver {
  let rpcSeq = 0;
  const bill: BillRow =
    "bill" in opts ? opts.bill! : { id: BILL_ID, customer_id: CUSTOMER_ID, entry_type: "sale", status: "confirmed" };

  return ({ table, op, terminal, payload }) => {
    if (table === "bill_entries") {
      if (op === "select" && terminal === "maybeSingle") {
        return { data: bill, error: null };
      }
    }
    if (table === "bill_entry_lines") {
      if (terminal === "await") {
        return {
          data: [{ id: "l1", description: "สินค้า A", quantity: 2, amount: 200, vat_type: "vat", vat_amount: 14 }],
          error: null,
        };
      }
    }
    if (table === "tax_invoices") {
      if (op === "select" && terminal === "maybeSingle") {
        return "invoiceScope" in opts
          ? { data: opts.invoiceScope, error: null }
          : { data: { customer_id: CUSTOMER_ID, status: "issued" }, error: null };
      }
      if (op === "update" && terminal === "maybeSingle") {
        return opts.voidSucceeds === false ? { data: null, error: null } : { data: { id: INVOICE_ID }, error: null };
      }
    }
    if (table === "rpc:issue_tax_invoice") {
      rpcSeq += 1;
      const p = payload as { p_prefix: string; p_be_year: number; p_source_bill_entry_id: string };
      return {
        data: { id: `ti-${p.p_source_bill_entry_id}`, doc_no: `${p.p_prefix}-${p.p_be_year}-${String(rpcSeq).padStart(5, "0")}` },
        error: null,
      };
    }
    return { data: null, error: null };
  };
}

function setupDb(opts: Parameters<typeof makeResolver>[0] = {}) {
  const { db, capture } = makeFakeDb(makeResolver(opts));
  currentDb = db;
  currentCapture = capture;
}

const validIssueInput = {
  customerId: CUSTOMER_ID,
  billEntryId: BILL_ID,
  formType: "full",
  docDate: "2026-08-01",
  buyerName: "บริษัท เอบีซี",
  buyerTaxId: "1234567890123",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  setupDb();
});

describe("issueTaxInvoiceAction", () => {
  it("customerId ในสโคป + บิล eligible → ออกใบกำกับภาษีสำเร็จ ได้เลขที่ตามรูปแบบ", async () => {
    const res = await issueTaxInvoiceAction(validIssueInput);
    expect(res.ok).toBe(true);
    expect(res.docNo).toMatch(/^TX-\d{4}-\d{5}$/);
  });

  it("★ เรียกซ้อนพร้อมกัน (Promise.all) กับบิลคนละใบ → ได้เลขไม่ซ้ำกันเสมอ (จำลอง atomic ของ RPC จริง)", async () => {
    const [res1, res2] = await Promise.all([
      issueTaxInvoiceAction(validIssueInput),
      issueTaxInvoiceAction({ ...validIssueInput, billEntryId: BILL_ID_2 }),
    ]);
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(res1.docNo).not.toBe(res2.docNo);
    expect(currentCapture.rpcs).toHaveLength(2);
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ (ไม่เรียก RPC)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await issueTaxInvoiceAction(validIssueInput);
    expect(res.ok).toBe(false);
    expect(currentCapture.rpcs).toHaveLength(0);
  });

  it("★ ลูกค้าที่ส่งมาไม่ตรงกับลูกค้าเจ้าของบิล → ปฏิเสธ (ไม่เรียก RPC)", async () => {
    setupDb({ bill: { id: BILL_ID, customer_id: CUSTOMER_OTHER, entry_type: "sale", status: "confirmed" } });
    const res = await issueTaxInvoiceAction(validIssueInput);
    expect(res.ok).toBe(false);
    expect(currentCapture.rpcs).toHaveLength(0);
  });

  it("★ บิลไม่ eligible (ซื้อ/ยังไม่ยืนยัน) → ปฏิเสธ", async () => {
    setupDb({ bill: { id: BILL_ID, customer_id: CUSTOMER_ID, entry_type: "purchase", status: "confirmed" } });
    const res = await issueTaxInvoiceAction(validIssueInput);
    expect(res.ok).toBe(false);
  });

  it("ไม่พบบิล (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ bill: null });
    const res = await issueTaxInvoiceAction(validIssueInput);
    expect(res.ok).toBe(false);
  });

  it("customerId/billEntryId ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res1 = await issueTaxInvoiceAction({ ...validIssueInput, customerId: "not-a-uuid" });
    expect(res1.ok).toBe(false);
    const res2 = await issueTaxInvoiceAction({ ...validIssueInput, billEntryId: "not-a-uuid" });
    expect(res2.ok).toBe(false);
    expect(currentCapture.rpcs).toHaveLength(0);
  });

  it("input ไม่ผ่าน validate (เต็มรูปไม่ระบุผู้ซื้อ) → ปฏิเสธ ไม่เรียก RPC", async () => {
    const res = await issueTaxInvoiceAction({ ...validIssueInput, buyerName: undefined, buyerTaxId: undefined });
    expect(res.ok).toBe(false);
    expect(currentCapture.rpcs).toHaveLength(0);
  });
});

describe("voidTaxInvoiceAction", () => {
  it("เอกสาร issued → ยกเลิกสำเร็จ", async () => {
    setupDb({ invoiceScope: { customer_id: CUSTOMER_ID, status: "issued" } });
    const res = await voidTaxInvoiceAction(INVOICE_ID);
    expect(res.ok).toBe(true);
    const upd = currentCapture.updates.find((u) => u.table === "tax_invoices");
    expect((upd!.payload as Record<string, unknown>).status).toBe("void");
  });

  it("★ ยกเลิกได้เฉพาะจาก status='issued' — ถ้าเป็น void แล้ว ปฏิเสธ", async () => {
    setupDb({ invoiceScope: { customer_id: CUSTOMER_ID, status: "issued" }, voidSucceeds: false });
    const res = await voidTaxInvoiceAction(INVOICE_ID);
    expect(res.ok).toBe(false);
  });

  it("★ ลูกค้าไม่อยู่ในสโคป (derive จาก scope จริงใน DB — ไม่เชื่อ client) → ปฏิเสธ ไม่แตะ DB", async () => {
    setupDb({ invoiceScope: { customer_id: CUSTOMER_ID, status: "issued" } });
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await voidTaxInvoiceAction(INVOICE_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.find((u) => u.table === "tax_invoices")).toBeUndefined();
  });

  it("ไม่พบใบกำกับภาษี (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ invoiceScope: null });
    const res = await voidTaxInvoiceAction(INVOICE_ID);
    expect(res.ok).toBe(false);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await voidTaxInvoiceAction("not-a-uuid");
    expect(res.ok).toBe(false);
    expect(currentCapture.updates).toHaveLength(0);
  });
});
