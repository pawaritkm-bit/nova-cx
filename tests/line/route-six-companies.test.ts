import { describe, it, expect } from "vitest";

/**
 * ★ 2026-09-02 — กติกากระจายบิลกลุ่มรวม (ผู้ใช้กำหนด):
 *   สลิปโอนเงิน → จับจาก "ชื่อผู้รับโอน" บนสลิป · บิลอื่น → จับจาก "เลขภาษีหรือชื่อบริษัท"
 *   ทดสอบด้วยชื่อจริงทั้ง 6 บริษัทของพี่สวย — 4 รายขึ้นต้น "พามี" เหมือนกัน ต้องไม่จับข้าม
 *   และชื่อสั้นกำกวมต้องไม่เดา (คืน null → บิลเข้า "ยังไม่จับคู่")
 */
import { routeBillToCustomer } from "@/lib/line/bill-extract-worker";

const SIX = [
  { id: "N218", name: "บริษัท สำนักงานบัญชีพามี จำกัด", businessName: null, taxId: "0735566003480" },
  { id: "N219", name: "บริษัท เจริญดี การบัญชี จำกัด", businessName: null, taxId: "0735568005099" },
  { id: "N220", name: "บริษัท วรรณวนัช เบเกอรี่ จำกัด", businessName: null, taxId: "0735562002462" },
  { id: "N221", name: "บริษัท พามี แท็กซ์ จำกัด", businessName: null, taxId: "0135569008470" },
  { id: "N222", name: "บริษัท พามีคอนซัลท์ จำกัด", businessName: null, taxId: "0735568009965" },
  { id: "N223", name: "บริษัท พามีกรุ๊ปการบัญชี จำกัด", businessName: null, taxId: "0135568030471" },
];
const payer = { name: "นาย ทดสอบ โอนเงิน", taxId: null };

describe("route 6 บริษัทพี่สวย — ชื่อคล้ายกัน (พามี×4) ต้องไม่จับข้าม", () => {
  const cases: [string, string | null][] = [
    ["บริษัท พามี แท็กซ์ จำกัด", "N221"],
    ["บริษัท พามีคอนซัลท์ จำกัด", "N222"],
    ["บริษัท พามีกรุ๊ปการบัญชี จำกัด", "N223"],
    ["บริษัท สำนักงานบัญชีพามี จำกัด", "N218"],
    ["บริษัท เจริญดี การบัญชี จำกัด", "N219"],
    ["บริษัท วรรณวนัช เบเกอรี่ จำกัด", "N220"],
    // ชื่อโดนตัดท้ายแบบสลิปจริง
    ["บริษัท พามี แท็กซ์ จ", "N221"],
    ["บริษัท พามีกรุ๊ปการบัญ", "N223"],
    // สั้นกำกวม — ต้องไม่เดา
    ["พามี", null],
  ];
  for (const [slipName, expected] of cases) {
    it(`ผู้รับ "${slipName}" → ${expected ?? "ไม่ผูก (กำกวม)"}`, () => {
      const r = routeBillToCustomer(SIX, { name: slipName, taxId: null }, payer);
      if (expected === null) expect(r).toBeNull();
      else {
        expect(r?.customerId).toBe(expected);
        expect(r?.decision.entryType).toBe("sale");
      }
    });
  }

  it("บิลอื่น (ใบเสร็จค่าใช้จ่าย): ผู้ซื้อ=เลขภาษี N221 → purchase คู่ค้า=ผู้ขาย", () => {
    const r = routeBillToCustomer(SIX, { name: "บจ.ผู้ขายวัสดุ", taxId: "0105536099999" }, { name: "บ.พามี แทกซ", taxId: "0135569008470" });
    expect(r?.customerId).toBe("N221");
    expect(r?.decision.entryType).toBe("purchase");
    expect(r?.decision.counterpartyName).toBe("บจ.ผู้ขายวัสดุ");
  });
});
