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

  it("ชื่อตรง + ยอดตรง → ใบยอดตรงขึ้นก่อน แม้ใบอื่นเก่ากว่า", () => {
    const m = matchSlipToOutstanding("นีเวียโคขุน", 1070, candidates);
    expect(m.map((x) => x.entryId)).toEqual(["b", "a"]);
    expect(m[0].amountExact).toBe(true);
    expect(m[1].amountExact).toBe(false);
  });

  it("ยอดไม่ตรงสักใบ → เรียงใบเก่าก่อน (FIFO)", () => {
    const m = matchSlipToOutstanding("นีเวียโคขุน", 500, candidates);
    expect(m.map((x) => x.entryId)).toEqual(["a", "b"]);
  });

  it("ชื่อไม่ตรงใครเลย → [] (การ์ดลงรายได้/ค่าใช้จ่ายตามปกติ)", () => {
    expect(matchSlipToOutstanding("บจก. อื่นไกล", 1070, candidates)).toEqual([]);
  });

  it("ใบที่ค้าง 0 ไม่ติดมา", () => {
    const m = matchSlipToOutstanding("นีเวียโคขุน", 1070, [
      bill({ entryId: "z", counterpartyName: "นีเวียโคขุน", outstanding: 0 }),
    ]);
    expect(m).toEqual([]);
  });
});
