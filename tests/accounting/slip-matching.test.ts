import { describe, it, expect } from "vitest";
import {
  normalizeNameForMatch,
  namesLooselyMatch,
  matchSlipToOutstanding,
  type OutstandingBillLite,
} from "@/lib/accounting/slip-matching";

/**
 * เทสต์จับคู่สลิป↔บิลเชื่อค้าง — ★ 2026-09-04 ผู้ใช้ ("ทำจริง"):
 * "ลูกหนี้/เจ้าหนี้ คือบิลที่ไม่มีสลิปมาจับคู่" — จับจากชื่อผู้โอน/ผู้รับโอน + ยอด
 */

describe("normalizeNameForMatch", () => {
  it("ตัดคำนำหน้านิติบุคคล/สาขา/ช่องว่าง", () => {
    expect(normalizeNameForMatch("บจก. นีเวียโคขุน ฮาลาล (สำนักงานใหญ่)")).toBe("นีเวียโคขุนฮาลาล");
    expect(normalizeNameForMatch("บริษัท พามี แท็กซ์ จำกัด")).toBe("พามีแท็กซ์");
    expect(normalizeNameForMatch("นางสาว พีรนุช ทองรอด")).toBe("พีรนุชทองรอด");
    expect(normalizeNameForMatch("MR IYARAT ADIREK")).toBe("iyaratadirek");
  });
  it("ค่าว่าง/null → ว่าง", () => {
    expect(normalizeNameForMatch(null)).toBe("");
    expect(normalizeNameForMatch("  ")).toBe("");
  });
});

describe("namesLooselyMatch", () => {
  it("สลิปชื่อย่อ ↔ บิลชื่อเต็ม (substring) → จับคู่ได้", () => {
    expect(namesLooselyMatch("นีเวียโคขุน", "บจก. นีเวียโคขุน ฮาลาล จำกัด")).toBe(true);
    expect(namesLooselyMatch("บริษัท พามี แท็กซ์ จำกัด", "พามี แท็กซ์")).toBe(true);
  });
  it("คนละชื่อ → ไม่จับ", () => {
    expect(namesLooselyMatch("นาย สมชาย ใจดี", "บจก. นีเวียโคขุน")).toBe(false);
  });
  it("ชื่อสั้นกว่า 4 ตัว → ไม่เดา (กันจับมั่ว)", () => {
    expect(namesLooselyMatch("กข", "กขคง จำกัด")).toBe(false);
  });
});

describe("matchSlipToOutstanding", () => {
  const bill = (p: Partial<OutstandingBillLite> & { entryId: string }): OutstandingBillLite => ({
    docNo: null, docDate: null, counterpartyName: null, outstanding: 0, ...p,
  });
  const candidates = [
    bill({ entryId: "a", docNo: "BL-1", docDate: "2026-08-01", counterpartyName: "บจก. นีเวียโคขุน ฮาลาล", outstanding: 3500 }),
    bill({ entryId: "b", docNo: "BL-2", docDate: "2026-09-02", counterpartyName: "บจก. นีเวียโคขุน ฮาลาล", outstanding: 1070 }),
    bill({ entryId: "c", docNo: "BL-3", docDate: "2026-09-01", counterpartyName: "นาย สมชาย ใจดี", outstanding: 1070 }),
  ];

  it("เรียงความมั่นใจ: ชื่อ+ยอดตรง → ยอดตรง (ชื่อไม่ตรง) → ชื่อตรงอย่างเดียว", () => {
    const m = matchSlipToOutstanding("นีเวียโคขุน", 1070, candidates);
    // b = ชื่อ+ยอดตรง · c = ยอดตรง (คนละชื่อ — เผื่อโอนบัญชีส่วนตัว) · a = ชื่อตรงแต่ยอดไม่เท่า
    expect(m.map((x) => x.entryId)).toEqual(["b", "c", "a"]);
    expect(m[0].nameMatch && m[0].amountExact).toBe(true);
    expect(m[1].amountExact && !m[1].nameMatch).toBe(true);
    expect(m[2].nameMatch && !m[2].amountExact).toBe(true);
  });

  it("ยอดไม่ตรงสักใบ → เรียงใบเก่าก่อน (FIFO)", () => {
    const m = matchSlipToOutstanding("นีเวียโคขุน", 500, candidates);
    expect(m.map((x) => x.entryId)).toEqual(["a", "b"]);
  });

  it("★ ชื่อไม่ตรงแต่ยอดตรงเป๊ะ → จับคู่ให้ (ลูกค้าโอนบัญชีส่วนตัว) พร้อมธง nameMatch=false", () => {
    const m = matchSlipToOutstanding("นาย ส่วนตัว โอนแทน", 1070, candidates);
    // ยอด 1070 ตรงทั้งใบ b (นีเวียโคขุน) และ c (สมชาย) — เสนอทั้งคู่ เรียงใบเก่าก่อน
    expect(m.map((x) => x.entryId)).toEqual(["c", "b"]);
    expect(m[0].amountExact).toBe(true);
    expect(m[0].nameMatch).toBe(false);
  });

  it("ชื่อ+ยอดตรง ชนะ ยอดตรงอย่างเดียว", () => {
    const m = matchSlipToOutstanding("สมชาย", 1070, candidates);
    expect(m[0].entryId).toBe("c"); // ชื่อ+ยอดตรง
    expect(m[0].nameMatch && m[0].amountExact).toBe(true);
  });

  it("ชื่อไม่ตรง + ยอดไม่ตรง → [] (การ์ดลงรายได้/ค่าใช้จ่ายตามปกติ)", () => {
    expect(matchSlipToOutstanding("บจก. อื่นไกล", 999, candidates)).toEqual([]);
  });

  it("ใบที่ค้าง 0 ไม่ติดมา", () => {
    const m = matchSlipToOutstanding("นีเวียโคขุน", 1070, [
      bill({ entryId: "z", counterpartyName: "นีเวียโคขุน", outstanding: 0 }),
    ]);
    expect(m).toEqual([]);
  });
});
