import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeFakeDb } from "../helpers/fake-supabase";
import {
  rankAccountantSuggestions,
  extractNicknameCandidates,
  suggestAccountantsForGroup,
} from "@/lib/chat-admin/accountant-suggest";
import { encryptField } from "@/lib/crypto/field";

const T = "tenant-1";
const ENC_KEY = "efad676ec53aec07f1dae8d6da957bd9c8bc76e679264c7f8aaf9b8362d6b1db";

// พนักงานตัวอย่าง (nickname อ้างอิงระบบจริง) — first_name = ชื่อจริง
const EMPLOYEES = [
  { id: "e1", nickname: "ฟางข้าว🌻", first_name: "ณิชาปวีณ์" },
  { id: "e2", nickname: "นัท", first_name: "รสนันท์" },
  { id: "e3", nickname: "ฝน", first_name: "ดาราวดี" },
  { id: "e4", nickname: "แหม่ม", first_name: "พิไลวรรณ" },
  { id: "e5", nickname: "JOys", first_name: "วันวิสา" },
];

describe("extractNicknameCandidates — แตกชื่อเล่นจากชื่อกลุ่ม", () => {
  it("ดึงจากวงเล็บท้าย", () => {
    expect(extractNicknameCandidates("N0003บจก.พงษ์เพอร์ฟอร์แมนซ์ (ฟาง)")).toContain("ฟาง");
  });
  it("ดึงหลังเครื่องหมาย / และตัดคำนำหน้า 'คุณ'", () => {
    const cands = extractNicknameCandidates("บจก.นารายณ์พร โกลด์/คุณวิภาวี (นัท)");
    expect(cands).toContain("นัท");
    expect(cands).toContain("วิภาวี"); // ตัด "คุณ" นำหน้าแล้ว
  });
  it("ไม่มีวงเล็บ/สแลช → คืน []", () => {
    expect(extractNicknameCandidates("บจก.เอบีซี จำกัด")).toEqual([]);
  });
  it("ชื่อกลุ่มว่าง/undefined → คืน []", () => {
    expect(extractNicknameCandidates("")).toEqual([]);
    expect(extractNicknameCandidates(null)).toEqual([]);
  });
});

describe("rankAccountantSuggestions — เดานักบัญชี (pure)", () => {
  it("วงเล็บท้าย 'ฟาง' → match 'ฟางข้าว🌻' (ตัดอิโมจิ + prefix)", () => {
    const res = rankAccountantSuggestions("N0003บจก.พงษ์เพอร์ฟอร์แมนซ์ (ฟาง)", EMPLOYEES);
    expect(res[0].employeeId).toBe("e1");
    expect(res[0].score).toBeGreaterThanOrEqual(0.5);
  });

  it("'นัท' → match นักบัญชี 'นัท' (ตรงกันเป๊ะ = คะแนนเต็ม)", () => {
    const res = rankAccountantSuggestions("บจก.นารายณ์พร โกลด์/คุณวิภาวี (นัท)", EMPLOYEES);
    expect(res[0].employeeId).toBe("e2");
    expect(res[0].score).toBe(1);
  });

  it("'ฝน' → match 'ฝน'", () => {
    const res = rankAccountantSuggestions("ร้าน โปเต้.../คุณสุภัสสร (ฝน)", EMPLOYEES);
    expect(res[0].employeeId).toBe("e3");
  });

  it("ชื่อเล่นในวงเล็บที่ไม่มีในพนักงาน (นุช) → ไม่มี suggestion (ไม่ error)", () => {
    expect(rankAccountantSuggestions("บจก.เทสต์ (นุช)", EMPLOYEES)).toEqual([]);
  });

  it("ชื่อกลุ่มไม่มีวงเล็บ/สแลช → คืน []", () => {
    expect(rankAccountantSuggestions("บจก.เอบีซี จำกัด", EMPLOYEES)).toEqual([]);
  });

  it("ชื่อกลุ่มว่าง → คืน []", () => {
    expect(rankAccountantSuggestions("", EMPLOYEES)).toEqual([]);
    expect(rankAccountantSuggestions(null, EMPLOYEES)).toEqual([]);
  });

  it("จำกัด limit + เรียงคะแนนมาก→น้อย", () => {
    const res = rankAccountantSuggestions("(ฟาง) (นัท) (ฝน)", EMPLOYEES, 2);
    expect(res.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < res.length; i++) {
      expect(res[i - 1].score).toBeGreaterThanOrEqual(res[i].score);
    }
  });

  it("employeeName ใช้ nickname ก่อน (ถ้าไม่มีใช้ first_name)", () => {
    const res = rankAccountantSuggestions("(นัท)", EMPLOYEES);
    expect(res[0].employeeName).toBe("นัท");
  });
});

describe("suggestAccountantsForGroup — ดึงจาก DB + decrypt (server)", () => {
  const prev = process.env.CREDENTIAL_ENC_KEY;
  beforeEach(() => {
    process.env.CREDENTIAL_ENC_KEY = ENC_KEY;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CREDENTIAL_ENC_KEY;
    else process.env.CREDENTIAL_ENC_KEY = prev;
  });

  it("decrypt ชื่อกลุ่ม + match employees → คืน suggestion เรียงคะแนน", async () => {
    const enc = encryptField("N0003บจก.พงษ์เพอร์ฟอร์แมนซ์ (ฟาง)");
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.terminal === "maybeSingle") return { data: { display_name_enc: enc } };
      if (q.table === "employees" && q.op === "select") return { data: EMPLOYEES };
      return { data: null };
    });
    const res = await suggestAccountantsForGroup(db, T, "g1");
    expect(res[0].employeeId).toBe("e1");
  });

  it("กลุ่มไม่มีชื่อ (display_name_enc null) → คืน []", async () => {
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.terminal === "maybeSingle") return { data: { display_name_enc: null } };
      return { data: null };
    });
    expect(await suggestAccountantsForGroup(db, T, "g1")).toEqual([]);
  });

  it("ไม่มีคีย์ถอดรหัส → คืน [] (degrade)", async () => {
    delete process.env.CREDENTIAL_ENC_KEY;
    const enc = "v1:xxx.yyy.zzz";
    const { db } = makeFakeDb((q) => {
      if (q.table === "chat_groups" && q.terminal === "maybeSingle") return { data: { display_name_enc: enc } };
      return { data: null };
    });
    expect(await suggestAccountantsForGroup(db, T, "g1")).toEqual([]);
  });
});
