import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type Capture, type Resolver } from "../helpers/fake-supabase";

/**
 * เทสต์ server actions ของหน้า "ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล" (/chat-audit/accounting/sales-documents — เฟส 3 ส่วน K)
 *   mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern tests/accounting/credit-debit-notes-actions.test.ts
 *   ★ เน้นเทสต์บังคับตาม DoD (K10): guard สโคปลูกค้า · draft แก้ได้/issued แก้ไม่ได้ ·
 *     issue ได้เลขจริงไม่ซ้ำ (จำลองเรียกซ้อนด้วย Promise.all) · void เฉพาะจาก issued
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
  createDraftAction,
  updateDraftAction,
  deleteDraftAction,
  issueDocumentAction,
  voidDocumentAction,
} from "@/app/chat-audit/accounting/sales-documents/actions";

const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const DOC_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const DOC_ID_2 = "ffffffff-ffff-ffff-ffff-ffffffffffff";

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

type ScopeRow = { customer_id: string; status: string; document_type: string };

function makeResolver(
  opts: {
    scope?: ScopeRow | null;
    /**
     * ★ จำลอง TOCTOU race (bug ที่แก้): issueDocument() แทรกเข้ามาพอดีระหว่างที่ updateDraftDocument()/
     *   softDeleteDraft() เช็คสถานะ (getDocumentScope — ยังเห็น "draft" เดิม) กับตอนเขียนจริง — คำสั่งเขียน
     *   จริงกำกับ .eq("status","draft").select("id").maybeSingle() เอง ต้องไม่ match แถวใดเลย (คืน null)
     *   แม้ scope check ก่อนหน้าจะยังเห็นเป็น "draft" อยู่ก็ตาม
     */
    raceOnWrite?: boolean;
  } = {}
): Resolver {
  let rpcSeq = 0;
  return ({ table, op, terminal, payload }) => {
    if (table === "sales_documents") {
      if (op === "select" && terminal === "maybeSingle") {
        return "scope" in opts
          ? { data: opts.scope, error: null }
          : { data: { customer_id: CUSTOMER_ID, status: "draft", document_type: "quotation" }, error: null };
      }
      if (op === "insert" && terminal === "maybeSingle") {
        return { data: { id: "new-doc-id" }, error: null };
      }
      // updateDraftDocument/softDeleteDraft — เขียนจริงกำกับ .eq("status","draft") แล้ว .select("id").maybeSingle()
      if (op === "update" && terminal === "maybeSingle") {
        return opts.raceOnWrite ? { data: null, error: null } : { data: { id: DOC_ID }, error: null };
      }
      if ((op === "update" || op === "delete") && terminal === "await") {
        return { data: null, error: null };
      }
    }
    if (table === "sales_document_lines") {
      if ((op === "insert" || op === "delete") && terminal === "await") {
        return { data: null, error: null };
      }
    }
    if (table === "rpc:issue_sales_document") {
      rpcSeq += 1;
      const p = payload as { p_prefix: string; p_be_year: number; p_document_id: string };
      return {
        data: { id: p.p_document_id, doc_no: `${p.p_prefix}-${p.p_be_year}-${String(rpcSeq).padStart(4, "0")}` },
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

const validDocInput = {
  documentType: "quotation",
  docDate: "2026-08-01",
  counterpartyName: "บริษัท ทดสอบ จำกัด",
  lines: [{ description: "สินค้า A", quantity: 1, unitPrice: 100, amount: 100, vatAmount: 7 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  setupDb();
});

describe("createDraftAction", () => {
  it("customerId ในสโคป + input ถูกต้อง → สร้าง draft สำเร็จ", async () => {
    const res = await createDraftAction(CUSTOMER_ID, validDocInput);
    expect(res.ok).toBe(true);
    const ins = currentCapture.inserts.find((i) => i.table === "sales_documents");
    expect(ins).toBeTruthy();
    expect((ins!.payload as Record<string, unknown>).status).toBe("draft");
    expect((ins!.payload as Record<string, unknown>).doc_no).toBeUndefined();
  });

  it("customerId ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await createDraftAction("not-a-uuid", validDocInput);
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts).toHaveLength(0);
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ (ไม่แตะ DB)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await createDraftAction(CUSTOMER_ID, validDocInput);
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "sales_documents")).toBeUndefined();
  });

  it("input ไม่ผ่าน validate (lines ว่าง) → ปฏิเสธ ไม่ insert", async () => {
    const res = await createDraftAction(CUSTOMER_ID, { ...validDocInput, lines: [] });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "sales_documents")).toBeUndefined();
  });
});

describe("updateDraftAction", () => {
  it("เอกสาร draft → แก้ไขได้", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "draft", document_type: "quotation" } });
    const res = await updateDraftAction(DOC_ID, validDocInput);
    expect(res.ok).toBe(true);
    const upd = currentCapture.updates.find((u) => u.table === "sales_documents");
    expect(upd).toBeTruthy();
  });

  it("★ เอกสาร issued แล้ว → ปฏิเสธ (0.16 — ล็อกแก้ไม่ได้)", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "issued", document_type: "quotation" } });
    const res = await updateDraftAction(DOC_ID, validDocInput);
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.find((u) => u.table === "sales_documents")).toBeUndefined();
  });

  it("★ ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ (ไม่แตะ DB)", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "draft", document_type: "quotation" } });
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await updateDraftAction(DOC_ID, validDocInput);
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.find((u) => u.table === "sales_documents")).toBeUndefined();
  });

  it("ไม่พบเอกสาร (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ scope: null });
    const res = await updateDraftAction(DOC_ID, validDocInput);
    expect(res.ok).toBe(false);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที", async () => {
    const res = await updateDraftAction("not-a-uuid", validDocInput);
    expect(res.ok).toBe(false);
  });

  it("★ TOCTOU race: issueDocument() แทรกเข้ามาพอดีระหว่างเช็คสถานะกับเขียนจริง → ปฏิเสธ ไม่ใช่เขียนทับสำเร็จ", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "draft", document_type: "quotation" }, raceOnWrite: true });
    const res = await updateDraftAction(DOC_ID, validDocInput);
    expect(res.ok).toBe(false);
  });
});

describe("deleteDraftAction", () => {
  it("เอกสาร draft → ลบสำเร็จ (soft-delete)", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "draft", document_type: "quotation" } });
    const res = await deleteDraftAction(DOC_ID);
    expect(res.ok).toBe(true);
    const upd = currentCapture.updates.find((u) => u.table === "sales_documents");
    expect((upd!.payload as Record<string, unknown>).deleted_at).toBeTruthy();
  });

  it("★ เอกสาร issued แล้ว → ปฏิเสธ (ลบได้เฉพาะ draft ใช้ยกเลิกแทน)", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "issued", document_type: "quotation" } });
    const res = await deleteDraftAction(DOC_ID);
    expect(res.ok).toBe(false);
  });

  it("ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ (ไม่แตะ DB)", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "draft", document_type: "quotation" } });
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await deleteDraftAction(DOC_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.find((u) => u.table === "sales_documents")).toBeUndefined();
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที", async () => {
    const res = await deleteDraftAction("not-a-uuid");
    expect(res.ok).toBe(false);
  });

  it("★ TOCTOU race: issueDocument() แทรกเข้ามาพอดีระหว่างเช็คสถานะกับลบจริง → ปฏิเสธ ไม่ใช่ลบทับสำเร็จ", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "draft", document_type: "quotation" }, raceOnWrite: true });
    const res = await deleteDraftAction(DOC_ID);
    expect(res.ok).toBe(false);
  });
});

describe("issueDocumentAction", () => {
  it("draft → ออกเอกสารสำเร็จ ได้เลขที่ตามรูปแบบ", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "draft", document_type: "quotation" } });
    const res = await issueDocumentAction(DOC_ID);
    expect(res.ok).toBe(true);
    expect(res.docNo).toMatch(/^QT-\d{4}-0001$/);
  });

  it("★ เรียกซ้อนพร้อมกัน (Promise.all) → ได้เลขไม่ซ้ำกันเสมอ (จำลอง atomic ของ RPC จริง)", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "draft", document_type: "quotation" } });
    const [res1, res2] = await Promise.all([issueDocumentAction(DOC_ID), issueDocumentAction(DOC_ID_2)]);
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(res1.docNo).not.toBe(res2.docNo);
    expect(currentCapture.rpcs).toHaveLength(2);
  });

  it("ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ (ไม่เรียก RPC)", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "draft", document_type: "quotation" } });
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await issueDocumentAction(DOC_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.rpcs).toHaveLength(0);
  });

  it("ไม่พบเอกสาร (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ scope: null });
    const res = await issueDocumentAction(DOC_ID);
    expect(res.ok).toBe(false);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await issueDocumentAction("not-a-uuid");
    expect(res.ok).toBe(false);
    expect(currentCapture.rpcs).toHaveLength(0);
  });
});

describe("voidDocumentAction", () => {
  it("★ ยกเลิกได้เฉพาะจาก status='issued' เท่านั้น", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "draft", document_type: "quotation" } });
    const res = await voidDocumentAction(DOC_ID);
    expect(res.ok).toBe(false);
  });

  it("เอกสาร issued → ยกเลิกสำเร็จ", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "issued", document_type: "quotation" } });
    const res = await voidDocumentAction(DOC_ID);
    expect(res.ok).toBe(true);
    const upd = currentCapture.updates.find((u) => u.table === "sales_documents");
    expect((upd!.payload as Record<string, unknown>).status).toBe("void");
  });

  it("ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ (ไม่แตะ DB)", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, status: "issued", document_type: "quotation" } });
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await voidDocumentAction(DOC_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.find((u) => u.table === "sales_documents")).toBeUndefined();
  });

  it("ไม่พบเอกสาร (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ scope: null });
    const res = await voidDocumentAction(DOC_ID);
    expect(res.ok).toBe(false);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await voidDocumentAction("not-a-uuid");
    expect(res.ok).toBe(false);
    expect(currentCapture.updates).toHaveLength(0);
  });
});
