import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type Capture, type Resolver } from "../helpers/fake-supabase";

/**
 * เทสต์ server actions ของหน้า "ใบลดหนี้/ใบเพิ่มหนี้" (/chat-audit/accounting/credit-debit-notes — เฟส 3 ส่วน J)
 *   mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern tests/accounting/payments-actions.test.ts
 *   ★ เน้นเทสต์บังคับตาม DoD: guard สโคปลูกค้า · ปฏิเสธบิลไม่ eligible · confirmed ล็อกแก้ไม่ได้ · void ทำงาน
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

import { upsertNoteAction, confirmNoteAction, voidNoteAction } from "@/app/chat-audit/accounting/credit-debit-notes/actions";

const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const ENTRY_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const NOTE_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

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
type NoteHeadRow = { entry_id: string; status: string };

function makeResolver(
  opts: {
    scope?: ScopeRow | null;
    lineAmounts?: { amount: number; vat_amount: number; wht_amount: number }[];
    noteHead?: NoteHeadRow | null;
    noteLineCount?: number;
    /** ★ จำลอง TOCTOU race: confirmNote() แทรกเข้ามาพอดีระหว่างเช็คสถานะกับเขียนจริงของ updateDraftNote() */
    raceOnWrite?: boolean;
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
    if (table === "credit_debit_notes") {
      if (op === "insert" && terminal === "maybeSingle") {
        return { data: { id: "new-note-id" }, error: null };
      }
      if (op === "select" && terminal === "maybeSingle") {
        return "noteHead" in opts
          ? { data: opts.noteHead, error: null }
          : { data: { entry_id: ENTRY_ID, status: "draft" }, error: null };
      }
      // updateDraftNote — เขียนจริงกำกับ .eq("status","draft") แล้ว .select("id").maybeSingle() (TOCTOU guard,
      //   ดู lib/accounting/credit-debit-notes.ts) — default: ไม่ชนแข่ง ให้ผ่านเสมอ (คืน id จริง)
      if (op === "update" && terminal === "maybeSingle") {
        return opts.raceOnWrite ? { data: null, error: null } : { data: { id: NOTE_ID }, error: null };
      }
      if (op === "update" && terminal === "await") {
        return { data: null, error: null };
      }
      if (op === "delete" && terminal === "await") {
        return { data: null, error: null };
      }
    }
    if (table === "credit_debit_note_lines") {
      if (op === "insert" && terminal === "await") {
        return { data: null, error: null };
      }
      if (op === "delete" && terminal === "await") {
        return { data: null, error: null };
      }
      if (op === "select" && terminal === "await") {
        const n = opts.noteLineCount ?? 1;
        return { data: Array.from({ length: n }, () => ({ amount: 100 })), error: null };
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

const validNoteInput = {
  entryId: ENTRY_ID,
  docType: "credit_note",
  docDate: "2026-08-01",
  docNo: "CN-001",
  reason: "สินค้าชำรุด",
  lines: [{ accountCode: "4010", amount: 500, vatAmount: 35 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  setupDb();
});

describe("upsertNoteAction — สร้างใหม่ (ไม่มี id)", () => {
  it("บิลเชื่อยืนยันแล้ว + input ถูกต้อง → สร้าง draft สำเร็จ", async () => {
    const res = await upsertNoteAction(validNoteInput);
    expect(res.ok).toBe(true);
    const ins = currentCapture.inserts.find((i) => i.table === "credit_debit_notes");
    expect(ins).toBeTruthy();
    expect((ins!.payload as Record<string, unknown>).status).toBe("draft");
  });

  it("★ บิลไม่ eligible (payment_method ไม่ใช่ credit) → ปฏิเสธ ไม่ insert", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, entry_type: "sale", payment_method: "cash", status: "confirmed" } });
    const res = await upsertNoteAction(validNoteInput);
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "credit_debit_notes")).toBeUndefined();
  });

  it("บิลยังไม่ยืนยัน (draft) → ปฏิเสธ", async () => {
    setupDb({ scope: { customer_id: CUSTOMER_ID, entry_type: "sale", payment_method: "credit", status: "draft" } });
    const res = await upsertNoteAction(validNoteInput);
    expect(res.ok).toBe(false);
  });

  it("★ ลูกค้าไม่อยู่ในสโคปของนักบัญชี → ปฏิเสธ (ไม่แตะ DB)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await upsertNoteAction(validNoteInput);
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "credit_debit_notes")).toBeUndefined();
  });

  it("ไม่พบบิล (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ scope: null });
    const res = await upsertNoteAction(validNoteInput);
    expect(res.ok).toBe(false);
  });

  it("reason ว่าง → ปฏิเสธ (validate ที่ server)", async () => {
    const res = await upsertNoteAction({ ...validNoteInput, reason: "" });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts.find((i) => i.table === "credit_debit_notes")).toBeUndefined();
  });

  it("entryId ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await upsertNoteAction({ ...validNoteInput, entryId: "not-a-uuid" });
    expect(res.ok).toBe(false);
    expect(currentCapture.inserts).toHaveLength(0);
  });
});

describe("upsertNoteAction — แก้ไข (มี id)", () => {
  it("รายการ draft → แก้ไขได้", async () => {
    setupDb({ noteHead: { entry_id: ENTRY_ID, status: "draft" } });
    const res = await upsertNoteAction({ ...validNoteInput, id: NOTE_ID });
    expect(res.ok).toBe(true);
    const upd = currentCapture.updates.find((u) => u.table === "credit_debit_notes");
    expect(upd).toBeTruthy();
  });

  it("★ รายการ confirmed แล้ว → ปฏิเสธ (0.4 — ล็อกแก้ไม่ได้)", async () => {
    setupDb({ noteHead: { entry_id: ENTRY_ID, status: "confirmed" } });
    const res = await upsertNoteAction({ ...validNoteInput, id: NOTE_ID });
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.find((u) => u.table === "credit_debit_notes")).toBeUndefined();
  });

  it("ไม่พบรายการ (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ noteHead: null });
    const res = await upsertNoteAction({ ...validNoteInput, id: NOTE_ID });
    expect(res.ok).toBe(false);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที", async () => {
    const res = await upsertNoteAction({ ...validNoteInput, id: "not-a-uuid" });
    expect(res.ok).toBe(false);
  });

  it("★ TOCTOU race: confirmNote() แทรกเข้ามาพอดีระหว่างเช็คสถานะกับเขียนจริง → ปฏิเสธ ไม่ใช่เขียนทับสำเร็จ", async () => {
    setupDb({ noteHead: { entry_id: ENTRY_ID, status: "draft" }, raceOnWrite: true });
    const res = await upsertNoteAction({ ...validNoteInput, id: NOTE_ID });
    expect(res.ok).toBe(false);
  });

  it(
    "★★★ IDOR regression — note จริง (id) เป็นของลูกค้านอกสโคป แต่ input.entryId ที่ client ส่งมาเป็นของ " +
      "ลูกค้าในสโคป → ต้องปฏิเสธเสมอ (ช่องโหว่เดิม: ตรวจสโคปจาก input.entryId แทนที่จะ derive จาก id " +
      "ของ note ที่กำลังจะแก้ไขจริง) ไม่แตะ DB",
    async () => {
      requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_ID]));
      // note ตัวจริง (NOTE_ID) ผูกกับ ENTRY_ID ซึ่งบิลต้นทางเป็นของ CUSTOMER_OTHER (นอกสโคป) — แต่
      // input.entryId ที่ client ส่งมา (validNoteInput.entryId = ENTRY_ID เดียวกัน) ในโลกจริงอาจเป็น
      // entryId คนละตัวที่อยู่ในสโคป ก็ต้องไม่ถูกใช้ตัดสินอยู่ดี เพราะ path นี้ไม่อ่าน input.entryId เลย
      setupDb({
        noteHead: { entry_id: ENTRY_ID, status: "draft" },
        scope: { customer_id: CUSTOMER_OTHER, entry_type: "sale", payment_method: "credit", status: "confirmed" },
      });
      const res = await upsertNoteAction({ ...validNoteInput, id: NOTE_ID });
      expect(res.ok).toBe(false);
      expect(currentCapture.updates.find((u) => u.table === "credit_debit_notes")).toBeUndefined();
    }
  );
});

describe("confirmNoteAction", () => {
  it("รายการ draft มีบรรทัด → ยืนยันสำเร็จ", async () => {
    const res = await confirmNoteAction(NOTE_ID);
    expect(res.ok).toBe(true);
    const upd = currentCapture.updates.find((u) => u.table === "credit_debit_notes");
    expect((upd!.payload as Record<string, unknown>).status).toBe("confirmed");
  });

  it("ยืนยันรายการที่ไม่มีบรรทัด → ปฏิเสธ", async () => {
    setupDb({ noteLineCount: 0 });
    const res = await confirmNoteAction(NOTE_ID);
    expect(res.ok).toBe(false);
  });

  it("ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ (ไม่แตะ DB)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await confirmNoteAction(NOTE_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.find((u) => u.table === "credit_debit_notes")).toBeUndefined();
  });

  it("ไม่พบบิลต้นทาง → ปฏิเสธ", async () => {
    setupDb({ scope: null });
    const res = await confirmNoteAction(NOTE_ID);
    expect(res.ok).toBe(false);
  });

  it("ไม่พบรายการ (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ noteHead: null });
    const res = await confirmNoteAction(NOTE_ID);
    expect(res.ok).toBe(false);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที", async () => {
    const res = await confirmNoteAction("not-a-uuid");
    expect(res.ok).toBe(false);
  });

  it(
    "★★★ IDOR regression — note จริงเป็นของลูกค้านอกสโคป (ผ่านสโคปของบิลต้นทางจริงของ note นั้น) " +
      "แม้เคย exploit ได้ด้วย entryId ปลอมที่อยู่ในสโคป (ช่องโหว่เดิม: ตรวจสโคปจาก entryId ที่ client " +
      "ส่งมาแยกจาก id ที่เขียนจริง) → ต้องปฏิเสธเสมอ ไม่แตะ DB",
    async () => {
      requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_ID]));
      // note ตัวจริง (NOTE_ID) ผูกกับ ENTRY_ID ซึ่งบิลต้นทางเป็นของ CUSTOMER_OTHER (นอกสโคป)
      setupDb({
        noteHead: { entry_id: ENTRY_ID, status: "draft" },
        scope: { customer_id: CUSTOMER_OTHER, entry_type: "sale", payment_method: "credit", status: "confirmed" },
      });
      const res = await confirmNoteAction(NOTE_ID);
      expect(res.ok).toBe(false);
      expect(currentCapture.updates.find((u) => u.table === "credit_debit_notes")).toBeUndefined();
    }
  );
});

describe("voidNoteAction", () => {
  it("ยกเลิกสำเร็จ (soft-delete)", async () => {
    const res = await voidNoteAction(NOTE_ID);
    expect(res.ok).toBe(true);
    const upd = currentCapture.updates.find((u) => u.table === "credit_debit_notes");
    expect(upd).toBeTruthy();
    expect((upd!.payload as Record<string, unknown>).deleted_at).toBeTruthy();
  });

  it("★ ยกเลิกได้แม้ confirmed แล้ว (ผิดพลาดต้องยกเลิกแล้วออกใบใหม่ — ไม่ใช่แก้ตัวเลขย้อนหลัง)", async () => {
    setupDb({ noteHead: { entry_id: ENTRY_ID, status: "confirmed" } });
    const res = await voidNoteAction(NOTE_ID);
    expect(res.ok).toBe(true);
  });

  it("ลูกค้าไม่อยู่ในสโคป → ปฏิเสธ (ไม่แตะ DB)", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await voidNoteAction(NOTE_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.find((u) => u.table === "credit_debit_notes")).toBeUndefined();
  });

  it("ไม่พบบิลต้นทาง (ถูกลบไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ scope: null });
    const res = await voidNoteAction(NOTE_ID);
    expect(res.ok).toBe(false);
  });

  it("ไม่พบรายการ (ยกเลิกไปแล้ว) → ปฏิเสธ", async () => {
    setupDb({ noteHead: null });
    const res = await voidNoteAction(NOTE_ID);
    expect(res.ok).toBe(false);
  });

  it("id ไม่ใช่ uuid → ปฏิเสธทันที (ไม่แตะ DB)", async () => {
    const res = await voidNoteAction("not-a-uuid");
    expect(res.ok).toBe(false);
    expect(currentCapture.updates).toHaveLength(0);
  });

  it(
    "★★★ IDOR regression — note จริงเป็นของลูกค้านอกสโคป → ยกเลิกไม่ได้เสมอ ไม่ว่า entryId เดิมที่เคย " +
      "ส่งมาคู่กันจะอยู่ในสโคปหรือไม่ (ช่องโหว่เดิม — ดู confirmNoteAction ด้านบน)",
    async () => {
      requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_ID]));
      setupDb({
        noteHead: { entry_id: ENTRY_ID, status: "draft" },
        scope: { customer_id: CUSTOMER_OTHER, entry_type: "sale", payment_method: "credit", status: "confirmed" },
      });
      const res = await voidNoteAction(NOTE_ID);
      expect(res.ok).toBe(false);
      expect(currentCapture.updates.find((u) => u.table === "credit_debit_notes")).toBeUndefined();
    }
  );
});
