import { describe, it, expect } from "vitest";
import {
  matchTxnsWithBills,
  namesMatch,
  normalizeNameForMatch,
  type BillForMatch,
  type TxnForMatch,
} from "@/lib/accounting/statement-bill-match";

/**
 * กระทบสเตทเมนต์กับบิล (requirement 2026-09-01):
 *   เงินเข้า ↔ บิลขาย · เงินออก ↔ บิลซื้อ · ยอด (เต็ม/หลังหัก ณ ที่จ่าย) + วัน ±14 + ชื่อผู้โอน boost
 */

const bill = (over: Partial<BillForMatch>): BillForMatch => ({
  id: "b1",
  docNo: null,
  docDate: "2026-05-14",
  entryType: "sale",
  status: "draft",
  counterparty: null,
  totalGross: 5000,
  totalNet: 5000,
  ...over,
});

const txn = (over: Partial<TxnForMatch>): TxnForMatch => ({
  date: "2026-05-14",
  amount: 5000,
  direction: "in",
  counterparty_name: null,
  ...over,
});

describe("normalizeNameForMatch / namesMatch", () => {
  it("ตัดคำนำหน้า/บริษัท/ช่องว่าง แล้วเทียบแบบ contain (ชื่อสเตทเมนต์โดนตัดท้ายได้)", () => {
    expect(normalizeNameForMatch("นาย จิรายุ ปราณี")).toBe("จิรายุปราณี");
    expect(namesMatch("นาย จิรายุ ปราณี", "จิรายุ ปราณี")).toBe(true);
    // สเตทเมนต์ตัดชื่อท้าย (ความกว้างคอลัมน์) → ยังจับได้
    expect(namesMatch("นางสาว ธนัญญา แก้วแก", "ธนัญญา แก้วแก้ว")).toBe(true);
    expect(namesMatch("บริษัท ทดสอบ จำกัด", "ทดสอบ")).toBe(true);
    expect(namesMatch("นาย สมชาย ใจดี", "นางสาว สมหญิง รักงาน")).toBe(false);
    expect(namesMatch(null, "ใครก็ได้")).toBe(false);
    expect(namesMatch("กข", "กข")).toBe(false); // สั้นเกินเทียบ (กัน false positive)
  });
});

describe("matchTxnsWithBills", () => {
  it("เงินเข้า ↔ บิลขาย: ยอด+วันตรง → จับได้", () => {
    const m = matchTxnsWithBills([txn({})], [bill({})]);
    expect(m[0]?.billId).toBe("b1");
    expect(m[0]?.nameHit).toBe(false);
  });

  it("เงินเข้าไม่จับบิลซื้อ (ทิศทางไม่เข้ากัน) · 'รอระบุ' จับได้ทั้งสองทาง", () => {
    expect(matchTxnsWithBills([txn({})], [bill({ entryType: "purchase" })])[0]).toBeNull();
    expect(matchTxnsWithBills([txn({})], [bill({ entryType: "unspecified" })])[0]?.billId).toBe("b1");
    expect(
      matchTxnsWithBills([txn({ direction: "out" })], [bill({ entryType: "purchase" })])[0]?.billId
    ).toBe("b1");
  });

  it("ยอดหลังหัก ณ ที่จ่าย (totalNet) ก็จับได้ — เงินโอนจริงน้อยกว่ายอดบิล", () => {
    const b = bill({ totalGross: 5000, totalNet: 4850 });
    expect(matchTxnsWithBills([txn({ amount: 4850 })], [b])[0]?.billId).toBe("b1");
    expect(matchTxnsWithBills([txn({ amount: 5000 })], [b])[0]?.billId).toBe("b1");
    expect(matchTxnsWithBills([txn({ amount: 4900 })], [b])[0]).toBeNull();
  });

  it("วันห่างเกิน 14 วัน → ไม่จับ · ในกรอบจับได้", () => {
    expect(matchTxnsWithBills([txn({ date: "2026-05-29" })], [bill({})])[0]).toBeNull();
    expect(matchTxnsWithBills([txn({ date: "2026-05-27" })], [bill({})])[0]?.daysApart).toBe(13);
  });

  it("ชื่อตรงชนะวันใกล้กว่า — สองบิลยอดเท่ากัน เลือกใบที่คู่ค้าตรงชื่อผู้โอน", () => {
    const near = bill({ id: "near", docDate: "2026-05-14", counterparty: "นาย คนอื่น ทั่วไป" });
    const named = bill({ id: "named", docDate: "2026-05-10", counterparty: "จิรายุ ปราณี" });
    const m = matchTxnsWithBills([txn({ counterparty_name: "นาย จิรายุ ปราณี" })], [near, named]);
    expect(m[0]?.billId).toBe("named");
    expect(m[0]?.nameHit).toBe(true);
  });

  it("1 บิลจับได้ 1 รายการ (ไม่ใช้ซ้ำ)", () => {
    const m = matchTxnsWithBills([txn({}), txn({})], [bill({})]);
    expect(m[0]?.billId).toBe("b1");
    expect(m[1]).toBeNull();
  });

  it("รายการไม่มีวัน/ยอด/ทิศทาง → null (ไม่เดา)", () => {
    expect(matchTxnsWithBills([txn({ date: null })], [bill({})])[0]).toBeNull();
    expect(matchTxnsWithBills([txn({ amount: null })], [bill({})])[0]).toBeNull();
    expect(matchTxnsWithBills([txn({ direction: null })], [bill({})])[0]).toBeNull();
  });

  it("วันเท่ากัน ชื่อเท่ากัน → บิลยืนยันแล้วชนะร่าง", () => {
    const draft = bill({ id: "d", status: "draft" });
    const confirmed = bill({ id: "c", status: "confirmed" });
    const m = matchTxnsWithBills([txn({})], [draft, confirmed]);
    expect(m[0]?.billId).toBe("c");
  });
});
