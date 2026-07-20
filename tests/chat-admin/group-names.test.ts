import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeFakeDb, makeCapture } from "../helpers/fake-supabase";
import { backfillGroupNames } from "@/lib/chat-admin/group-names";
import { decryptField } from "@/lib/crypto/field";
import type { LineOa } from "@/lib/env";
import type { LineClient } from "@/lib/line/client";

/**
 * backfillGroupNames — ดึงชื่อกลุ่มที่ยังไม่มีชื่อ (display_name_enc null) มาเก็บ ciphertext
 *   ครอบคลุม: loop + update ciphertext (ถอดได้), นับ updated, audit,
 *   ไม่มีคีย์ = ไม่ทำ, summary null = ข้าม, เลือก OA ตาม channel oa_type
 */

const T = "tenant-1";
const ACTOR = "99999999-9999-9999-9999-999999999999";
const ENC_KEY = "efad676ec53aec07f1dae8d6da957bd9c8bc76e679264c7f8aaf9b8362d6b1db";

/** client ปลอมต่อ OA — คืนชื่อกลุ่มตาม map (groupRef → name); ไม่มีใน map = null */
function makeGetClient(namesByRef: Record<string, string>, counter?: { n: number }) {
  return (oa: LineOa): LineClient | null => ({
    oa,
    async push() {
      return { ok: true };
    },
    async reply() {
      return { ok: true };
    },
    async getProfile() {
      return null;
    },
    async getGroupMemberProfile() {
      return null;
    },
    async getGroupSummary(groupId) {
      if (counter) counter.n += 1;
      const name = namesByRef[groupId];
      return name ? { groupName: name } : null;
    },
  });
}

describe("backfillGroupNames", () => {
  const prev = process.env.CREDENTIAL_ENC_KEY;
  beforeEach(() => {
    process.env.CREDENTIAL_ENC_KEY = ENC_KEY;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CREDENTIAL_ENC_KEY;
    else process.env.CREDENTIAL_ENC_KEY = prev;
  });

  it("loop กลุ่มที่ไม่มีชื่อ → update display_name_enc (ถอดได้เป็นชื่อจริง) + audit + นับ updated", async () => {
    const cap = makeCapture();
    const groups = [
      { id: "g1", group_ref: "C1", group_kind: "group", chat_channels: { oa_type: "care" } },
      { id: "g2", group_ref: "C2", group_kind: "group", chat_channels: { oa_type: "care" } },
    ];
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.op === "select") return { data: groups };
      if (q.table === "chat_groups" && q.op === "update") return { error: null };
      if (q.table === "audit_logs" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);

    const res = await backfillGroupNames(
      db,
      T,
      makeGetClient({ C1: "บจ.หนึ่ง", C2: "บจ.สอง" }),
      ACTOR
    );

    expect(res.updated).toBe(2);
    expect(res.scanned).toBe(2);
    const upds = cap.updates.filter((u) => u.table === "chat_groups") as {
      payload: { display_name_enc: string };
    }[];
    expect(upds).toHaveLength(2);
    const decrypted = upds.map((u) => decryptField(u.payload.display_name_enc)).sort();
    expect(decrypted).toEqual(["บจ.สอง", "บจ.หนึ่ง"]);
    // audit สรุปผล
    const audit = cap.inserts.find((i) => i.table === "audit_logs") as {
      payload: { action: string; meta: { updated: number; scanned: number } };
    };
    expect(audit.payload.action).toBe("chat_group_names_backfilled");
    expect(audit.payload.meta.updated).toBe(2);
  });

  it("summary คืน null (ดึงไม่ได้) → ข้ามกลุ่มนั้น ไม่ update, ไม่ throw", async () => {
    const cap = makeCapture();
    const groups = [{ id: "g1", group_ref: "C1", group_kind: "group", chat_channels: { oa_type: "care" } }];
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.op === "select") return { data: groups };
      if (q.table === "audit_logs" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);

    const res = await backfillGroupNames(db, T, makeGetClient({}), ACTOR); // ไม่มีชื่อใน map → null
    expect(res.updated).toBe(0);
    expect(res.scanned).toBe(1);
    expect(cap.updates.filter((u) => u.table === "chat_groups")).toHaveLength(0);
  });

  it("ไม่มีคีย์เข้ารหัส → ไม่ทำอะไร คืน reason (ตาม pattern เดิม)", async () => {
    delete process.env.CREDENTIAL_ENC_KEY;
    const cap = makeCapture();
    const { db } = makeFakeDb(() => ({ data: [] }), cap);
    const res = await backfillGroupNames(db, T, makeGetClient({ C1: "x" }), ACTOR);
    expect(res.updated).toBe(0);
    expect(res.reason).toBeTruthy();
    expect(cap.inserts).toHaveLength(0); // ไม่แม้แต่ query/audit
  });

  it("channel มี oa_type='sale' → ลอง client sale ก่อน (ได้ชื่อ)", async () => {
    const cap = makeCapture();
    const groups = [{ id: "g1", group_ref: "C1", group_kind: "group", chat_channels: { oa_type: "sale" } }];
    let seenOa: LineOa | null = null;
    const getClient = (oa: LineOa): LineClient | null => ({
      oa,
      async push() {
        return { ok: true };
      },
      async reply() {
        return { ok: true };
      },
      async getProfile() {
        return null;
      },
      async getGroupMemberProfile() {
        return null;
      },
      async getGroupSummary() {
        if (seenOa === null) seenOa = oa; // OA แรกที่ถูกลอง
        return { groupName: "บจ.เซล" };
      },
    });
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.op === "select") return { data: groups };
      if (q.table === "chat_groups" && q.op === "update") return { error: null };
      if (q.table === "audit_logs" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);

    const res = await backfillGroupNames(db, T, getClient, ACTOR);
    expect(res.updated).toBe(1);
    expect(seenOa).toBe("sale"); // ใช้ oa ของ channel ก่อน
  });

  it("ไม่มีกลุ่มที่ต้อง backfill → updated 0, scanned 0", async () => {
    const cap = makeCapture();
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.op === "select") return { data: [] };
      if (q.table === "audit_logs" && q.op === "insert") return { error: null };
      return { data: null };
    }, cap);
    const res = await backfillGroupNames(db, T, makeGetClient({}), ACTOR);
    expect(res.updated).toBe(0);
    expect(res.scanned).toBe(0);
  });
});
