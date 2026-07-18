import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeFakeDb } from "../helpers/fake-supabase";
import { rankCustomerSuggestions, suggestCustomersForGroup } from "@/lib/chat-admin/customer-suggest";
import { encryptField } from "@/lib/crypto/field";

const T = "tenant-1";
const ENC_KEY = "efad676ec53aec07f1dae8d6da957bd9c8bc76e679264c7f8aaf9b8362d6b1db";

const CUSTOMERS = [
  { id: "c1", name: "เอบีซี", business_name: "บริษัท เอบีซี จำกัด" },
  { id: "c2", name: "ร้านสมชายพาณิชย์", business_name: null },
  { id: "c3", name: "XYZ Trading", business_name: "หจก. เอ็กซ์วายแซด" },
  { id: "c4", name: "ครัวคุณแม่", business_name: null },
];

describe("rankCustomerSuggestions — fuzzy + normalize ไทย (pure)", () => {
  it("ชื่อกลุ่มว่าง/undefined → คืน []", () => {
    expect(rankCustomerSuggestions("", CUSTOMERS)).toEqual([]);
    expect(rankCustomerSuggestions(null, CUSTOMERS)).toEqual([]);
    expect(rankCustomerSuggestions("   ", CUSTOMERS)).toEqual([]);
  });

  it("ตัดคำนำหน้า 'บริษัท ... จำกัด' แล้วยัง match ลูกค้าที่ตรง", () => {
    // ชื่อกลุ่มมีคำนำหน้า/ต่อท้ายกิจการ → normalize แล้วเหลือ 'เอบีซี'
    const res = rankCustomerSuggestions("บริษัท เอบีซี จำกัด (กลุ่มงานบัญชี)", CUSTOMERS);
    expect(res[0].customerId).toBe("c1");
    expect(res[0].score).toBeGreaterThan(0.5);
  });

  it("ตัด 'ร้าน'/'คุณ' นำหน้า + จับ substring", () => {
    const res = rankCustomerSuggestions("ร้าน สมชายพาณิชย์", CUSTOMERS);
    expect(res[0].customerId).toBe("c2");
  });

  it("ไม่มีลูกค้าใกล้เคียง → คืน [] (ต่ำกว่าเกณฑ์)", () => {
    const res = rankCustomerSuggestions("กลุ่มลูกค้าใหม่ไม่เคยมีในระบบเลย", CUSTOMERS);
    expect(res).toEqual([]);
  });

  it("เรียงคะแนนมาก→น้อย และจำกัด top N", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `x${i}`,
      name: `เอบีซี สาขา ${i}`,
      business_name: null,
    }));
    const res = rankCustomerSuggestions("เอบีซี", many, 5);
    expect(res.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < res.length; i++) {
      expect(res[i - 1].score).toBeGreaterThanOrEqual(res[i].score);
    }
  });
});

describe("suggestCustomersForGroup — ดึงจาก DB + decrypt (server)", () => {
  const prev = process.env.CREDENTIAL_ENC_KEY;
  beforeEach(() => {
    process.env.CREDENTIAL_ENC_KEY = ENC_KEY;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CREDENTIAL_ENC_KEY;
    else process.env.CREDENTIAL_ENC_KEY = prev;
  });

  it("decrypt ชื่อกลุ่ม + match customers → คืน candidate เรียงคะแนน", async () => {
    const enc = encryptField("บริษัท เอบีซี จำกัด");
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.terminal === "maybeSingle") return { data: { display_name_enc: enc } };
      if (q.table === "customers" && q.op === "select") return { data: CUSTOMERS };
      return { data: null };
    });
    const res = await suggestCustomersForGroup(db, T, "g1");
    expect(res[0].customerId).toBe("c1");
  });

  it("กลุ่มไม่มีชื่อ (display_name_enc null) → คืน []", async () => {
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.terminal === "maybeSingle") return { data: { display_name_enc: null } };
      return { data: null };
    });
    expect(await suggestCustomersForGroup(db, T, "g1")).toEqual([]);
  });

  it("ไม่มีคีย์ถอดรหัส → คืน [] (degrade)", async () => {
    delete process.env.CREDENTIAL_ENC_KEY;
    const enc = "v1:xxx.yyy.zzz";
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.terminal === "maybeSingle") return { data: { display_name_enc: enc } };
      return { data: null };
    });
    expect(await suggestCustomersForGroup(db, T, "g1")).toEqual([]);
  });
});
