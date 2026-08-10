import { describe, it, expect } from "vitest";
import { buildCashFlowStatement, aggregateCashFlowLines } from "@/lib/accounting/cash-flow";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import type { JournalLine } from "@/lib/accounting/journal";
import { TEST_CHART } from "@/tests/accounting/fixtures/chart";

/**
 * cash-flow.ts — เฟส 4 ส่วน O2 (docs/06-accounting-features-roadmap.md, หมวด 0.5–0.9)
 *   ★ เทสต์หนักสุดของเฟส — ครอบทุกกรณีในตาราง O2: บิลขายเงินสด/บิลซื้อเชื่อ+รับชำระทีหลัง/
 *   manual JE ทุกกิจกรรม/โอนภายในกลุ่ม(ไม่ปรากฏเลย)/หลายขาไม่ใช่เงินสด(allocate)/หลายขาเงินสด
 *   (proportional โดยธรรมชาติของ double-entry)/CN-DN(ไม่ปรากฏเลย)/reconciled=true ทุกกรณี
 */

const chartByCode = buildChartByCode(TEST_CHART);

function line(p: Partial<JournalLine> & Pick<JournalLine, "entryId" | "accountCode" | "debit" | "credit">): JournalLine {
  return {
    date: p.date ?? "2026-03-15",
    docNo: p.docNo ?? "DOC-1",
    accountName: p.accountName ?? chartByCode[p.accountCode]?.name ?? p.accountCode,
    side: p.debit > 0 ? "debit" : "credit",
    customerId: p.customerId ?? "c1",
    counterparty: p.counterparty ?? null,
    ...p,
  };
}

describe("buildCashFlowStatement — 0.6: ตัดรายการโอนภายในกลุ่มเงินสดออกทั้งหมด", () => {
  it("ฝากเงินสดเข้าธนาคาร (ทั้ง 2 ขาอยู่ใน cash pool) → ไม่ปรากฏใน CF เลย", () => {
    const lines: JournalLine[] = [
      line({ entryId: "je-deposit", accountCode: "1020", debit: 2000, credit: 0 }),
      line({ entryId: "je-deposit", accountCode: "1010", debit: 0, credit: 2000 }),
    ];
    const cf = buildCashFlowStatement(lines, 0, chartByCode, TEST_CHART);
    expect(cf.operating).toHaveLength(0);
    expect(cf.investing).toHaveLength(0);
    expect(cf.financing).toHaveLength(0);
    expect(cf.netChange).toBe(0);
    expect(cf.closingCash).toBe(0);
    expect(cf.reconciled).toBe(true);
  });

  it("โอนระหว่างบัญชีธนาคาร 2 บัญชี (ทั้งคู่ is_bank) → ไม่ปรากฏใน CF เลย", () => {
    const lines: JournalLine[] = [
      line({ entryId: "je-transfer", accountCode: "1025", debit: 1500, credit: 0 }),
      line({ entryId: "je-transfer", accountCode: "1020", debit: 0, credit: 1500 }),
    ];
    const cf = buildCashFlowStatement(lines, 500, chartByCode, TEST_CHART);
    expect(cf.operating).toHaveLength(0);
    expect(cf.investing).toHaveLength(0);
    expect(cf.financing).toHaveLength(0);
    expect(cf.netChange).toBe(0);
    expect(cf.closingCash).toBe(500);
    expect(cf.reconciled).toBe(true);
  });
});

describe("buildCashFlowStatement — 0.5: CN/DN ไม่ปรากฏใน CF เลย (contra คงที่ AR/AP เสมอ)", () => {
  it("credit note ลดยอดขาย (Dr ขายสินค้า / Cr AR) — ไม่แตะเงินสด → ไม่ปรากฏใน CF", () => {
    const lines: JournalLine[] = [
      line({ entryId: "cn-1", accountCode: "4010", debit: 200, credit: 0 }),
      line({ entryId: "cn-1", accountCode: "1140", debit: 0, credit: 200 }),
    ];
    const cf = buildCashFlowStatement(lines, 1000, chartByCode, TEST_CHART);
    expect(cf.operating).toHaveLength(0);
    expect(cf.investing).toHaveLength(0);
    expect(cf.financing).toHaveLength(0);
    expect(cf.netChange).toBe(0);
    expect(cf.closingCash).toBe(1000);
    expect(cf.reconciled).toBe(true);
  });

  it("debit note เพิ่มยอดซื้อ (Dr ซื้อสินค้า / Cr AP) — ไม่แตะเงินสด → ไม่ปรากฏใน CF", () => {
    const lines: JournalLine[] = [
      line({ entryId: "dn-1", accountCode: "5010", debit: 100, credit: 0 }),
      line({ entryId: "dn-1", accountCode: "2010", debit: 0, credit: 100 }),
    ];
    const cf = buildCashFlowStatement(lines, 1000, chartByCode, TEST_CHART);
    expect(cf.operating).toHaveLength(0);
    expect(cf.reconciled).toBe(true);
  });
});

describe("buildCashFlowStatement — บิลขายเงินสด → operating inflow", () => {
  it("ขายสินค้าเงินสด 1000 → operating +1000", () => {
    const lines: JournalLine[] = [
      line({ entryId: "sale-1", accountCode: "1010", debit: 1000, credit: 0 }),
      line({ entryId: "sale-1", accountCode: "4010", debit: 0, credit: 1000 }),
    ];
    const cf = buildCashFlowStatement(lines, 0, chartByCode, TEST_CHART);
    expect(cf.operating).toHaveLength(1);
    expect(cf.operating[0]).toMatchObject({ accountCode: "4010", amount: 1000, entryId: "sale-1" });
    expect(cf.totalOperating).toBe(1000);
    expect(cf.totalInvesting).toBe(0);
    expect(cf.totalFinancing).toBe(0);
    expect(cf.netChange).toBe(1000);
    expect(cf.closingCash).toBe(1000);
    expect(cf.reconciled).toBe(true);
  });
});

describe("buildCashFlowStatement — บิลซื้อเชื่อ + รับชำระทีหลัง (bill_payments) → operating outflow", () => {
  it("จ่ายชำระเจ้าหนี้การค้าด้วยเงินสด 500 → operating -500", () => {
    const lines: JournalLine[] = [
      line({ entryId: "pay-1", accountCode: "2010", debit: 500, credit: 0, date: "2026-03-20" }),
      line({ entryId: "pay-1", accountCode: "1010", debit: 0, credit: 500, date: "2026-03-20" }),
    ];
    const cf = buildCashFlowStatement(lines, 2000, chartByCode, TEST_CHART);
    expect(cf.operating).toHaveLength(1);
    expect(cf.operating[0]).toMatchObject({ accountCode: "2010", amount: -500 });
    expect(cf.totalOperating).toBe(-500);
    expect(cf.netChange).toBe(-500);
    expect(cf.closingCash).toBe(1500);
    expect(cf.reconciled).toBe(true);
  });

  it("รับชำระลูกหนี้บางส่วน (partial) → เห็นเฉพาะยอดที่รับชำระจริง ไม่ใช่ยอดเต็มบิล", () => {
    const lines: JournalLine[] = [
      line({ entryId: "recv-1", accountCode: "1020", debit: 300, credit: 0 }), // รับผ่านธนาคาร
      line({ entryId: "recv-1", accountCode: "1140", debit: 0, credit: 300 }),
    ];
    const cf = buildCashFlowStatement(lines, 0, chartByCode, TEST_CHART);
    expect(cf.totalOperating).toBe(300);
    expect(cf.operating[0].amount).toBe(300);
    expect(cf.reconciled).toBe(true);
  });
});

describe("buildCashFlowStatement — manual JE ซื้อสินทรัพย์ถาวรด้วยเงินสด → investing", () => {
  it("ซื้ออุปกรณ์สำนักงาน 5000 จ่ายเงินสด → investing -5000", () => {
    const lines: JournalLine[] = [
      line({ entryId: "je-asset", accountCode: "1640", debit: 5000, credit: 0 }),
      line({ entryId: "je-asset", accountCode: "1010", debit: 0, credit: 5000 }),
    ];
    const cf = buildCashFlowStatement(lines, 10000, chartByCode, TEST_CHART);
    expect(cf.investing).toHaveLength(1);
    expect(cf.investing[0]).toMatchObject({ accountCode: "1640", amount: -5000 });
    expect(cf.totalInvesting).toBe(-5000);
    expect(cf.totalOperating).toBe(0);
    expect(cf.netChange).toBe(-5000);
    expect(cf.closingCash).toBe(5000);
    expect(cf.reconciled).toBe(true);
  });
});

describe("buildCashFlowStatement — manual JE เพิ่มทุน/ออกหุ้นกู้ → financing", () => {
  it("เพิ่มทุนเรือนหุ้น รับเป็นเงินสด 10000 → financing +10000", () => {
    const lines: JournalLine[] = [
      line({ entryId: "je-capital", accountCode: "1010", debit: 10000, credit: 0 }),
      line({ entryId: "je-capital", accountCode: "3010", debit: 0, credit: 10000 }),
    ];
    const cf = buildCashFlowStatement(lines, 0, chartByCode, TEST_CHART);
    expect(cf.financing).toHaveLength(1);
    expect(cf.financing[0]).toMatchObject({ accountCode: "3010", amount: 10000 });
    expect(cf.totalFinancing).toBe(10000);
    expect(cf.netChange).toBe(10000);
    expect(cf.closingCash).toBe(10000);
    expect(cf.reconciled).toBe(true);
  });

  it("ออกหุ้นกู้รับเป็นเงินโอนเข้าธนาคาร 20000 → financing +20000", () => {
    const lines: JournalLine[] = [
      line({ entryId: "je-bond", accountCode: "1020", debit: 20000, credit: 0 }),
      line({ entryId: "je-bond", accountCode: "2110", debit: 0, credit: 20000 }),
    ];
    const cf = buildCashFlowStatement(lines, 0, chartByCode, TEST_CHART);
    expect(cf.financing[0]).toMatchObject({ accountCode: "2110", amount: 20000 });
    expect(cf.reconciled).toBe(true);
  });

  it("จ่ายเงินปันผลจริง (เคลียร์เงินปันผลค้างจ่ายด้วยเงินสด) → financing -3000", () => {
    const lines: JournalLine[] = [
      line({ entryId: "je-dividend", accountCode: "2035", debit: 3000, credit: 0 }),
      line({ entryId: "je-dividend", accountCode: "1010", debit: 0, credit: 3000 }),
    ];
    const cf = buildCashFlowStatement(lines, 5000, chartByCode, TEST_CHART);
    expect(cf.financing[0]).toMatchObject({ accountCode: "2035", amount: -3000 });
    expect(cf.reconciled).toBe(true);
  });
});

describe("buildCashFlowStatement — 0.8: manual JE เงินสดจ่ายก้อนเดียวแบ่งหลายบัญชี (allocate ตามยอดจริง)", () => {
  it("จ่ายเงินสด 1000 ก้อนเดียว แบ่งเข้าเงินเดือน(600, operating) + อุปกรณ์สำนักงาน(400, investing)", () => {
    const lines: JournalLine[] = [
      line({ entryId: "je-mixed", accountCode: "5310", debit: 600, credit: 0 }),
      line({ entryId: "je-mixed", accountCode: "1640", debit: 400, credit: 0 }),
      line({ entryId: "je-mixed", accountCode: "1010", debit: 0, credit: 1000 }),
    ];
    const cf = buildCashFlowStatement(lines, 2000, chartByCode, TEST_CHART);
    // ★ allocate ตามยอดจริง (ไม่หารเฉลี่ย 500/500)
    expect(cf.operating).toHaveLength(1);
    expect(cf.operating[0]).toMatchObject({ accountCode: "5310", amount: -600 });
    expect(cf.investing).toHaveLength(1);
    expect(cf.investing[0]).toMatchObject({ accountCode: "1640", amount: -400 });
    expect(cf.totalOperating).toBe(-600);
    expect(cf.totalInvesting).toBe(-400);
    expect(cf.netChange).toBe(-1000);
    expect(cf.closingCash).toBe(1000);
    expect(cf.reconciled).toBe(true);
  });
});

describe("buildCashFlowStatement — 0.8: manual JE ที่มีหลายขาเงินสดพร้อมกัน (edge case)", () => {
  it("เพิ่มทุน รับเป็นเงินสด 400 + เงินโอนเข้าธนาคาร 600 พร้อมกันใน 1 รายการ → financing +1000 เต็มจำนวน", () => {
    const lines: JournalLine[] = [
      line({ entryId: "je-multi-cash", accountCode: "1010", debit: 400, credit: 0 }),
      line({ entryId: "je-multi-cash", accountCode: "1020", debit: 600, credit: 0 }),
      line({ entryId: "je-multi-cash", accountCode: "3010", debit: 0, credit: 1000 }),
    ];
    const cf = buildCashFlowStatement(lines, 0, chartByCode, TEST_CHART);
    expect(cf.financing).toHaveLength(1);
    expect(cf.financing[0]).toMatchObject({ accountCode: "3010", amount: 1000 });
    expect(cf.totalFinancing).toBe(1000);
    expect(cf.netChange).toBe(1000);
    expect(cf.closingCash).toBe(1000);
    // ★ reconciled ต้อง true แม้มีหลายขาเงินสด — ผลรวม cash-pool ทุกบรรทัด (400+600) ตรงกับ netChange เป๊ะ
    expect(cf.reconciled).toBe(true);
  });

  it("หลายขาเงินสด + หลายขาไม่ใช่เงินสดพร้อมกัน (N:M) — ยังคง allocate ถูกต้องต่อบัญชี และ reconciled=true", () => {
    const lines: JournalLine[] = [
      line({ entryId: "je-nm", accountCode: "5310", debit: 300, credit: 0 }), // operating
      line({ entryId: "je-nm", accountCode: "1640", debit: 700, credit: 0 }), // investing
      line({ entryId: "je-nm", accountCode: "1010", debit: 0, credit: 400 }),
      line({ entryId: "je-nm", accountCode: "1020", debit: 0, credit: 600 }),
    ];
    const cf = buildCashFlowStatement(lines, 1000, chartByCode, TEST_CHART);
    expect(cf.totalOperating).toBe(-300);
    expect(cf.totalInvesting).toBe(-700);
    expect(cf.netChange).toBe(-1000);
    expect(cf.closingCash).toBe(0);
    expect(cf.reconciled).toBe(true);
  });
});

describe("buildCashFlowStatement — รวมหลายธุรกรรมในงวดเดียว (สถานการณ์จริง)", () => {
  it("ผสมทุกกรณี (ขายเงินสด + จ่าย AP + ซื้อสินทรัพย์ + เพิ่มทุน + ฝากธนาคาร + CN) → รวมถูกต้องและ reconciled=true", () => {
    const lines: JournalLine[] = [
      // ขายเงินสด 1000 (operating +1000)
      line({ entryId: "e1", accountCode: "1010", debit: 1000, credit: 0 }),
      line({ entryId: "e1", accountCode: "4010", debit: 0, credit: 1000 }),
      // จ่าย AP ด้วยเงินสด 500 (operating -500)
      line({ entryId: "e2", accountCode: "2010", debit: 500, credit: 0 }),
      line({ entryId: "e2", accountCode: "1010", debit: 0, credit: 500 }),
      // ซื้อสินทรัพย์ถาวรด้วยเงินโอน 2000 (investing -2000)
      line({ entryId: "e3", accountCode: "1645", debit: 2000, credit: 0 }),
      line({ entryId: "e3", accountCode: "1020", debit: 0, credit: 2000 }),
      // เพิ่มทุนรับเงินสด 3000 (financing +3000)
      line({ entryId: "e4", accountCode: "1010", debit: 3000, credit: 0 }),
      line({ entryId: "e4", accountCode: "3010", debit: 0, credit: 3000 }),
      // ฝากเงินสดเข้าธนาคาร 800 (ตัดออกทั้งหมด)
      line({ entryId: "e5", accountCode: "1020", debit: 800, credit: 0 }),
      line({ entryId: "e5", accountCode: "1010", debit: 0, credit: 800 }),
      // credit note ลดยอดขาย (ไม่แตะเงินสด — ไม่ปรากฏใน CF)
      line({ entryId: "e6", accountCode: "4010", debit: 100, credit: 0 }),
      line({ entryId: "e6", accountCode: "1140", debit: 0, credit: 100 }),
    ];
    const cf = buildCashFlowStatement(lines, 5000, chartByCode, TEST_CHART);
    expect(cf.totalOperating).toBe(500); // 1000 - 500
    expect(cf.totalInvesting).toBe(-2000);
    expect(cf.totalFinancing).toBe(3000);
    expect(cf.netChange).toBe(1500);
    expect(cf.openingCash).toBe(5000);
    expect(cf.closingCash).toBe(6500);
    expect(cf.reconciled).toBe(true);
    // e5 (ฝากธนาคาร) ไม่ปรากฏในทั้ง 3 กิจกรรมเลย
    const allLines = [...cf.operating, ...cf.investing, ...cf.financing];
    expect(allLines.some((l) => l.entryId === "e5")).toBe(false);
    // e6 (CN) ไม่ปรากฏเลย
    expect(allLines.some((l) => l.entryId === "e6")).toBe(false);
  });
});

describe("buildCashFlowStatement — reconciled=true เสมอเมื่อข้อมูลสมดุล (self-check ตาม 0.9 ไม่ใช่ตรวจ opening/closing)", () => {
  it("openingCash ที่ผู้เรียกส่งมาไม่ถูกไม่กระทบ reconciled (reconciled เทียบเฉพาะ netChange กับ movement ของงวด — ไม่มี code path ที่ทำให้ reconciled=false ได้จริงตราบใดที่ classify ครบทุกบรรทัดเงินสด เพราะ allocation สมดุลกันเองเสมอโดยธรรมชาติของ double-entry)", () => {
    // reconciled ตรวจ "การจัดหมวดรายการ" ของงวดนั้น ไม่ตรวจ opening/closing ที่ caller ส่งมาผิด
    // (นั่นคือหน้าที่ของ end-to-end reconciliation ใน formal-statements.test.ts)
    const lines: JournalLine[] = [
      line({ entryId: "e1", accountCode: "1010", debit: 1000, credit: 0 }),
      line({ entryId: "e1", accountCode: "4010", debit: 0, credit: 1000 }),
    ];
    const cf = buildCashFlowStatement(lines, 999999, chartByCode, TEST_CHART);
    expect(cf.reconciled).toBe(true);
    expect(cf.closingCash).toBe(1000999);
  });
});

describe("buildCashFlowStatement — เฟส 7 (0.10): จำหน่ายทรัพย์สินถาวร → investing ครบทั้งขาสินทรัพย์+ค่าเสื่อมสะสม", () => {
  it("จำหน่ายอุปกรณ์สำนักงาน ได้รับเท่ากับ NBV เป๊ะ (ไม่มีกำไร/ขาดทุน) — ขาสินทรัพย์+ค่าเสื่อมสะสมจัดเป็น investing ทั้งคู่ ผลรวม investing ตรงกับ proceeds เป๊ะ", () => {
    // ราคาทุน 30000, ค่าเสื่อมสะสม 10000 → NBV = 20000 = proceeds (ไม่มีขากำไร/ขาดทุนในธุรกรรมนี้)
    const lines: JournalLine[] = [
      // Dr ค่าเสื่อมสะสม 10000 (ล้างค่าเสื่อมสะสม)
      line({ entryId: "je-dispose", accountCode: "1640.1", debit: 10000, credit: 0 }),
      // Dr เงินสด 20000 (ได้รับจริง = NBV เป๊ะ)
      line({ entryId: "je-dispose", accountCode: "1010", debit: 20000, credit: 0 }),
      // Cr สินทรัพย์ 30000 (ตัดที่ราคาทุน)
      line({ entryId: "je-dispose", accountCode: "1640", debit: 0, credit: 30000 }),
    ];
    const cf = buildCashFlowStatement(lines, 10000, chartByCode, TEST_CHART);

    // ★ ขาสินทรัพย์ (1640) + ขาค่าเสื่อมสะสม (1640.1) ต้องจัดเป็น investing ทั้งคู่ (0.10)
    const investingCodes = cf.investing.map((l) => l.accountCode).sort();
    expect(investingCodes).toEqual(["1640", "1640.1"]);
    expect(cf.investing.find((l) => l.accountCode === "1640.1")).toMatchObject({ amount: -10000 });
    expect(cf.investing.find((l) => l.accountCode === "1640")).toMatchObject({ amount: 30000 });
    // ★ ผลรวม investing (30000 − 10000 = 20000) ตรงกับ proceeds เป๊ะ — เงินสดที่ได้รับจากการจำหน่าย
    //   แสดงเป็น "กิจกรรมลงทุน" ครบทั้งขา ไม่ตกไปเป็น operating ผิดประเภท
    expect(cf.totalInvesting).toBe(20000);
    expect(cf.operating).toHaveLength(0);
    expect(cf.netChange).toBe(20000);
    expect(cf.closingCash).toBe(10000 + 20000);
    expect(cf.reconciled).toBe(true);
  });

  it("จำหน่ายรถยนต์ ขาดทุน (proceeds < NBV) — ขาสินทรัพย์+ค่าเสื่อมสะสมยังจัดเป็น investing ครบ (รวม = NBV), ขาดทุนตกไป operating (fallback ตาม 0.10) รวมกันแล้วเท่ากับ proceeds เป๊ะ", () => {
    // ราคาทุน 500000, ค่าเสื่อมสะสม 100000 → NBV = 400000, ได้รับจริง (proceeds) = 300000 → ขาดทุน 100000
    const lines: JournalLine[] = [
      line({ entryId: "je-dispose2", accountCode: "1645.1", debit: 100000, credit: 0 }),
      line({ entryId: "je-dispose2", accountCode: "1020", debit: 300000, credit: 0 }),
      line({ entryId: "je-dispose2", accountCode: "5365", debit: 100000, credit: 0 }), // ขาดทุนจากการจำหน่าย
      line({ entryId: "je-dispose2", accountCode: "1645", debit: 0, credit: 500000 }),
    ];
    const cf = buildCashFlowStatement(lines, 0, chartByCode, TEST_CHART);

    const investingCodes = cf.investing.map((l) => l.accountCode).sort();
    expect(investingCodes).toEqual(["1645", "1645.1"]);
    expect(cf.totalInvesting).toBe(400000); // = NBV (500000 − 100000)
    expect(cf.operating).toHaveLength(1);
    expect(cf.operating[0]).toMatchObject({ accountCode: "5365", amount: -100000 });
    expect(cf.totalOperating).toBe(-100000);
    // ★ investing + operating รวมกันเท่ากับ proceeds เป๊ะ (400000 − 100000 = 300000) — สอดคล้องกับ
    //   เงินสดที่ได้รับจริงทั้งหมดของธุรกรรมนี้ แม้ขากำไร/ขาดทุนตกไปอยู่ operating (0.10 ยอมรับไว้)
    expect(cf.totalInvesting + cf.totalOperating).toBe(300000);
    expect(cf.reconciled).toBe(true);
  });
});

describe("aggregateCashFlowLines — รวมยอดต่อรหัสบัญชี (ใช้กับ mergeCompareLines)", () => {
  it("รวม CashFlowLine[] หลายรายการรหัสเดียวกันเป็นแถวเดียว", () => {
    const lines = [
      { entryId: "a", date: "2026-01-01", docNo: null, description: null, accountCode: "5310", accountName: "เงินเดือนพนักงาน", amount: -100 },
      { entryId: "b", date: "2026-01-05", docNo: null, description: null, accountCode: "5310", accountName: "เงินเดือนพนักงาน", amount: -200 },
      { entryId: "c", date: "2026-01-10", docNo: null, description: null, accountCode: "1640", accountName: "อุปกรณ์สำนักงาน", amount: -50 },
    ];
    const agg = aggregateCashFlowLines(lines);
    expect(agg).toEqual([
      { code: "5310", name: "เงินเดือนพนักงาน", amount: -300 },
      { code: "1640", name: "อุปกรณ์สำนักงาน", amount: -50 },
    ]);
  });

  it("array ว่าง → []", () => {
    expect(aggregateCashFlowLines([])).toEqual([]);
  });
});
