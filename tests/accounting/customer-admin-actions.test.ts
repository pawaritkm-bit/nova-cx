import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeDb, type Capture, type Resolver } from "../helpers/fake-supabase";
import { decryptField } from "@/lib/crypto/field";

/**
 * เทสต์ server actions "จัดการลูกค้า" เฉพาะส่วน FlowAccount credential (M2 — T19):
 *   - updateCustomerFieldsAction: flowaccountClientId/flowaccountClientSecret
 *   - clearFlowAccountCredentialAction: ล้างรหัสลับทันที
 * mock ชั้นล่าง (supabase/access/next-cache) ตาม pattern tests/accounting/flowaccount-actions.test.ts
 *   ★ ใช้ makeFakeDb (tests/helpers/fake-supabase.ts) จำลอง service-role client จริง (ไม่ mock ทั้ง action)
 *     เพื่อยืนยัน encrypt/clear round-trip จริง (ไม่ mock encryptField/decryptField)
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
  updateCustomerFieldsAction,
  clearFlowAccountCredentialAction,
} from "@/app/chat-audit/accounting/customer-admin-actions";

const CUSTOMER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CUSTOMER_OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";

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

/** resolver มาตรฐาน: ลูกค้ามีอยู่จริงในเทแนนต์ + ทุก update สำเร็จ (เว้นแต่ระบุ failColumn) */
function makeResolver(opts: { customerFound?: boolean; failColumn?: string | null } = {}): Resolver {
  const found = opts.customerFound ?? true;
  const failColumn = opts.failColumn ?? null;
  return ({ table, op, terminal, payload }) => {
    if (table !== "customers") return { data: null, error: null };
    if (op === "select" && terminal === "maybeSingle") {
      // customerBelongsToTenant
      return found ? { data: { id: CUSTOMER_ID }, error: null } : { data: null, error: null };
    }
    if (op === "update" && terminal === "maybeSingle") {
      // patch หลัก (name/code/taxId) + select กลับ
      return { data: { id: CUSTOMER_ID, external_ref: null, customer_code: null }, error: null };
    }
    if (op === "update" && terminal === "await") {
      const p = (payload ?? {}) as Record<string, unknown>;
      if (failColumn && Object.prototype.hasOwnProperty.call(p, failColumn)) {
        return { data: null, error: { message: "column does not exist" } };
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };
}

function setupDb(opts: { customerFound?: boolean; failColumn?: string | null } = {}) {
  const { db, capture } = makeFakeDb(makeResolver(opts));
  currentDb = db;
  currentCapture = capture;
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  requireAccountingAccessMock.mockResolvedValue(adminCtx);
  setupDb();
  process.env.CREDENTIAL_ENC_KEY = "test-only-encryption-key-for-unit-tests";
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe("updateCustomerFieldsAction — FlowAccount credential", () => {
  it("ตั้ง client id + secret ใหม่ → เก็บ client id เป็น plain, secret เป็น ciphertext ที่ decrypt กลับได้ตรง", async () => {
    const res = await updateCustomerFieldsAction(CUSTOMER_ID, {
      flowaccountClientId: "client-123",
      flowaccountClientSecret: "super-secret-value",
    });
    expect(res.ok).toBe(true);

    const idUpdate = currentCapture.updates.find(
      (u) => u.table === "customers" && (u.payload as Record<string, unknown>).flowaccount_client_id !== undefined
    );
    expect(idUpdate).toBeTruthy();
    expect((idUpdate!.payload as Record<string, unknown>).flowaccount_client_id).toBe("client-123");

    const secretUpdate = currentCapture.updates.find(
      (u) =>
        u.table === "customers" &&
        (u.payload as Record<string, unknown>).flowaccount_client_secret_enc !== undefined
    );
    expect(secretUpdate).toBeTruthy();
    const ciphertext = (secretUpdate!.payload as Record<string, unknown>).flowaccount_client_secret_enc as string;
    expect(ciphertext).not.toBe("super-secret-value"); // ★ ต้องไม่ใช่ plaintext
    expect(ciphertext.startsWith("v1:")).toBe(true);
    expect(decryptField(ciphertext)).toBe("super-secret-value"); // round-trip จริง
  });

  it("ไม่ส่ง flowaccountClientSecret/flowaccountClientId มาเลย (แก้แค่ที่อยู่) → ไม่มี update เรียกคอลัมน์ FlowAccount เลย", async () => {
    const res = await updateCustomerFieldsAction(CUSTOMER_ID, { address: "ที่อยู่ใหม่" });
    expect(res.ok).toBe(true);
    const touchedFlowAccountCol = currentCapture.updates.some((u) => {
      const p = u.payload as Record<string, unknown>;
      return (
        Object.prototype.hasOwnProperty.call(p, "flowaccount_client_id") ||
        Object.prototype.hasOwnProperty.call(p, "flowaccount_client_secret_enc")
      );
    });
    expect(touchedFlowAccountCol).toBe(false);
  });

  it('ส่ง flowaccountClientSecret: "" → เขียนเป็น null (ล้าง)', async () => {
    const res = await updateCustomerFieldsAction(CUSTOMER_ID, { flowaccountClientSecret: "" });
    expect(res.ok).toBe(true);
    const secretUpdate = currentCapture.updates.find(
      (u) =>
        u.table === "customers" &&
        (u.payload as Record<string, unknown>).flowaccount_client_secret_enc !== undefined
    );
    expect(secretUpdate).toBeTruthy();
    expect((secretUpdate!.payload as Record<string, unknown>).flowaccount_client_secret_enc).toBeNull();
  });

  it("ไม่มี CREDENTIAL_ENC_KEY แล้วส่ง secret ใหม่ที่ไม่ว่าง → {ok:false} และไม่มี update ใด ๆ เกิดขึ้นเลย", async () => {
    delete process.env.CREDENTIAL_ENC_KEY;
    const res = await updateCustomerFieldsAction(CUSTOMER_ID, {
      flowaccountClientSecret: "new-secret-value",
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.length).toBe(0); // ★ ปฏิเสธก่อนแตะ DB เลย กัน plaintext หลุด
  });

  it("migration ยังไม่ apply (คอลัมน์ flowaccount_client_id ไม่มี) → save ช่องอื่นสำเร็จ + แจ้งเตือน", async () => {
    setupDb({ failColumn: "flowaccount_client_id" });
    const res = await updateCustomerFieldsAction(CUSTOMER_ID, {
      address: "ที่อยู่ทดสอบ",
      flowaccountClientId: "client-x",
    });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/FlowAccount/);
    expect(res.message).toMatch(/0062/);
  });

  it("นักบัญชีนอกสโคป — ลูกค้าไม่อยู่ในชุดที่ดูแล → แก้ credential ไม่ได้", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await updateCustomerFieldsAction(CUSTOMER_ID, {
      flowaccountClientId: "client-x",
    });
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.length).toBe(0);
  });

  it("นักบัญชีในสโคป — แก้ credential ของลูกค้าที่ตัวเองดูแลได้", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_ID]));
    const res = await updateCustomerFieldsAction(CUSTOMER_ID, {
      flowaccountClientId: "client-x",
    });
    expect(res.ok).toBe(true);
  });

  // ★ EDGE CASE (พบระหว่าง QA — ยังไม่มีเทสต์เดิมครอบ): แก้ client_id อย่างเดียว (แก้ typo) โดยไม่กรอก
  //   secret ใหม่ → action ไม่ error และไม่แตะคอลัมน์ secret เลย (ตามสเปก undefined = ไม่แตะ) ผลคือ
  //   client_id ใหม่ถูกจับคู่กับ secret_enc *เดิม* ต่อไปโดยไม่มีการเตือนใด ๆ — ถ้า client_id เดิม/ใหม่เป็นคนละ
  //   บริษัทกัน (พิมพ์ผิดไปเป็นของลูกค้ารายอื่น) จะได้คู่ client_id/secret ที่ไม่ตรงกันจริง แล้วไปพังตอนยิง
  //   FlowAccount จริง (auth_failed) แทนที่จะเตือนตั้งแต่ตอนบันทึก — ไม่ใช่บั๊ก (เป็นไปตามสเปก "แก้ทีละช่องได้")
  //   แต่เป็นความเสี่ยงด้าน UX ที่ควรพิจารณา (ดูสรุปผลทดสอบ)
  it("EDGE: แก้ flowaccountClientId อย่างเดียว (ไม่แตะ secret) → บันทึกสำเร็จ โดยไม่แตะคอลัมน์ secret เลย (คงคู่เดิมที่อาจไม่ตรงกันได้)", async () => {
    const res = await updateCustomerFieldsAction(CUSTOMER_ID, {
      flowaccountClientId: "client-new-typo-fixed",
    });
    expect(res.ok).toBe(true);
    const idUpdate = currentCapture.updates.find(
      (u) => u.table === "customers" && (u.payload as Record<string, unknown>).flowaccount_client_id !== undefined
    );
    expect(idUpdate).toBeTruthy();
    expect((idUpdate!.payload as Record<string, unknown>).flowaccount_client_id).toBe("client-new-typo-fixed");
    const touchedSecret = currentCapture.updates.some((u) =>
      Object.prototype.hasOwnProperty.call(u.payload as Record<string, unknown>, "flowaccount_client_secret_enc")
    );
    expect(touchedSecret).toBe(false); // ★ ยืนยันพฤติกรรม: secret เดิมถูกทิ้งไว้ ไม่ได้ล้าง ไม่ได้เตือน
  });
});

describe("clearFlowAccountCredentialAction", () => {
  it("ล้างรหัสลับ → ตั้ง flowaccount_client_id และ flowaccount_client_secret_enc เป็น null ในการ update เดียวกัน", async () => {
    const res = await clearFlowAccountCredentialAction(CUSTOMER_ID);
    expect(res.ok).toBe(true);
    const clearUpdate = currentCapture.updates.find(
      (u) =>
        u.table === "customers" &&
        (u.payload as Record<string, unknown>).flowaccount_client_id === null &&
        (u.payload as Record<string, unknown>).flowaccount_client_secret_enc === null
    );
    expect(clearUpdate).toBeTruthy();
  });

  it("นักบัญชีนอกสโคปล้างรหัสลับของลูกค้าอื่นไม่ได้", async () => {
    requireAccountingAccessMock.mockResolvedValue(accountantCtx([CUSTOMER_OTHER]));
    const res = await clearFlowAccountCredentialAction(CUSTOMER_ID);
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.length).toBe(0);
  });

  it("customerId ไม่ใช่ uuid → ปฏิเสธทันที ไม่แตะ DB", async () => {
    const res = await clearFlowAccountCredentialAction("not-a-uuid");
    expect(res.ok).toBe(false);
    expect(currentCapture.updates.length).toBe(0);
  });
});
