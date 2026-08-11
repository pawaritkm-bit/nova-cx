import { describe, it, expect } from "vitest";
import { ageBucket, buildAgingReport, AGING_BUCKET_ORDER } from "@/lib/accounting/aging";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import { defaultFlowAccountSync } from "@/lib/accounting/queries";
import type { BillPayment } from "@/lib/accounting/bill-payments";

/**
 * aging.ts — เฟส 2 ส่วน E (docs/06-accounting-features-roadmap.md, 0.9/0.10)
 *   เน้น: ageBucket ทุก branch (รวมขอบเขตวันพอดี) + buildAgingReport (กรอง eligible/outstanding + กลุ่มคู่ค้า)
 */

// ---------------------------------------------------------------------
// ageBucket — 6 กลุ่ม + ขอบเขตวันพอดี (0.9)
// ---------------------------------------------------------------------
describe("ageBucket", () => {
  const asOf = "2026-08-08";

  it("dueDate = null → no_due_date", () => {
    expect(ageBucket(null, asOf)).toBe("no_due_date");
  });

  it("dueDate ≥ asOfDate (ยังไม่ถึงกำหนด/ถึงพอดี) → current", () => {
    expect(ageBucket("2026-08-08", asOf)).toBe("current"); // ถึงกำหนดพอดี (0 วัน)
    expect(ageBucket("2026-09-01", asOf)).toBe("current"); // ยังไม่ถึงกำหนด
  });

  it("เกินกำหนด 1 วัน → 1_30", () => {
    expect(ageBucket("2026-08-07", asOf)).toBe("1_30");
  });

  it("★ ขอบเขตวันพอดี 30/31 → 1_30 / 31_60", () => {
    expect(ageBucket("2026-07-09", asOf)).toBe("1_30"); // เกิน 30 วันพอดี
    expect(ageBucket("2026-07-08", asOf)).toBe("31_60"); // เกิน 31 วัน
  });

  it("★ ขอบเขตวันพอดี 60/61 → 31_60 / 61_90", () => {
    expect(ageBucket("2026-06-09", asOf)).toBe("31_60"); // เกิน 60 วันพอดี
    expect(ageBucket("2026-06-08", asOf)).toBe("61_90"); // เกิน 61 วัน
  });

  it("★ ขอบเขตวันพอดี 90/91 → 61_90 / over_90", () => {
    expect(ageBucket("2026-05-10", asOf)).toBe("61_90"); // เกิน 90 วันพอดี
    expect(ageBucket("2026-05-09", asOf)).toBe("over_90"); // เกิน 91 วัน
  });

  it("รูปแบบวันที่พัง → no_due_date (defensive)", () => {
    expect(ageBucket("bad-date", asOf)).toBe("no_due_date");
  });
});

// ---------------------------------------------------------------------
// buildAgingReport
// ---------------------------------------------------------------------
function mkLine(p: Partial<BillEntryLine> = {}): BillEntryLine {
  return {
    id: "l1",
    entryId: p.entryId ?? "e",
    lineNo: 1,
    vatType: "vat",
    description: null,
    accountCode: null,
    accountName: null,
    amount: p.amount ?? 1000,
    vatAmount: p.vatAmount ?? 0,
    whtRate: 0,
    whtAmount: p.whtAmount ?? 0,
    aiFilled: false,
    aiLowConfidence: false,
  };
}

function mkEntry(p: Partial<BillEntry> & { id: string }): BillEntry {
  return {
    id: p.id,
    tenantId: "t1",
    attachmentId: null,
    customerId: "c1",
    customerName: null,
    attachmentObjectPath: null,
    uploadPath: null,
    uploadName: null,
    uploadMime: null,
    entryType: p.entryType ?? "sale",
    docDate: p.docDate ?? "2026-07-01",
    docNo: p.docNo ?? "DOC-1",
    // ★ ใช้ "in" เช็ค (ไม่ใช้ ??) — counterpartyName:null เป็นค่าที่ตั้งใจส่งมาทดสอบ ต้องไม่ถูกบังคับเป็น default
    counterpartyName: "counterpartyName" in p ? p.counterpartyName! : "ลูกค้า A",
    counterpartyTaxId: null,
    sellerName: null,
    sellerTaxId: null,
    buyerName: null,
    buyerTaxId: null,
    whtForm: null,
    paymentMethod: p.paymentMethod ?? "credit",
    paymentBankAccountId: null,
    paymentBankAccountCode: null,
    dueDate: p.dueDate ?? null,
    status: p.status ?? "confirmed",
    source: "ai",
    aiConfidence: null,
    notes: null,
    createdAt: "2026-07-01T00:00:00Z",
    confirmedAt: null,
    inputTaxMonth: null,
    flowaccountSync: defaultFlowAccountSync(),
    lines: p.lines ?? [mkLine()],
  };
}

const ASOF = "2026-08-08";

type PaymentLite = Pick<BillPayment, "amount" | "payDate">;

/** helper ประกอบ Map payments — payDate default = ก่อน ASOF เสมอ (สถานการณ์ปกติทั่วไป) เว้นแต่ระบุมาเอง */
function payments(
  map: Record<string, (Partial<PaymentLite> & { amount: number })[]>
): Map<string, PaymentLite[]> {
  return new Map(
    Object.entries(map).map(([k, v]) => [k, v.map((p) => ({ amount: p.amount, payDate: p.payDate ?? "2026-08-01" }))])
  );
}

describe("buildAgingReport", () => {
  it("บิลขาย (credit, ยังค้าง) → ไปฝั่ง ar ตาม bucket ถูกต้อง", () => {
    const entries = [
      mkEntry({ id: "e1", entryType: "sale", dueDate: "2026-08-01", lines: [mkLine({ amount: 1000 })] }), // เกิน 7 วัน → 1_30
    ];
    const report = buildAgingReport(entries, payments({}), ASOF);
    expect(report.ar).toHaveLength(1);
    expect(report.ar[0].counterpartyName).toBe("ลูกค้า A");
    expect(report.ar[0].buckets["1_30"]).toBe(1000);
    expect(report.ar[0].total).toBe(1000);
    expect(report.ap).toHaveLength(0);
    expect(report.totalsByBucket.ar["1_30"]).toBe(1000);
  });

  it("บิลซื้อ (credit, ยังค้าง) → ไปฝั่ง ap", () => {
    const entries = [mkEntry({ id: "e1", entryType: "purchase", dueDate: "2026-08-01", counterpartyName: "ผู้ขาย B" })];
    const report = buildAgingReport(entries, payments({}), ASOF);
    expect(report.ap).toHaveLength(1);
    expect(report.ap[0].counterpartyName).toBe("ผู้ขาย B");
    expect(report.ar).toHaveLength(0);
  });

  it("★ บิลไม่ credit (cash/transfer) → ไม่เข้ารายงานเลย (0.1)", () => {
    const entries = [mkEntry({ id: "e1", paymentMethod: "cash" })];
    const report = buildAgingReport(entries, payments({}), ASOF);
    expect(report.ar).toHaveLength(0);
    expect(report.ap).toHaveLength(0);
  });

  it("บิลยังไม่ confirmed → ไม่เข้ารายงาน", () => {
    const entries = [mkEntry({ id: "e1", status: "draft" })];
    const report = buildAgingReport(entries, payments({}), ASOF);
    expect(report.ar).toHaveLength(0);
  });

  it("★ บิลจ่ายครบแล้ว (outstanding ≤ EPSILON) → ไม่แสดงในรายงาน (เทสต์บังคับ)", () => {
    const entries = [mkEntry({ id: "e1", lines: [mkLine({ amount: 1000 })] })]; // net = 1000
    const report = buildAgingReport(entries, payments({ e1: [{ amount: 1000 }] }), ASOF);
    expect(report.ar).toHaveLength(0);
  });

  it("จ่ายบางส่วน → ยังแสดง ด้วยยอดค้างที่เหลือ (ไม่ใช่ยอดเต็ม)", () => {
    const entries = [mkEntry({ id: "e1", dueDate: "2026-08-01", lines: [mkLine({ amount: 1000 })] })];
    const report = buildAgingReport(entries, payments({ e1: [{ amount: 400 }] }), ASOF);
    expect(report.ar[0].total).toBe(600);
  });

  it("no_due_date → กลุ่มไม่ระบุกำหนด แยกจาก current เสมอ", () => {
    const entries = [mkEntry({ id: "e1", dueDate: null, lines: [mkLine({ amount: 500 })] })];
    const report = buildAgingReport(entries, payments({}), ASOF);
    expect(report.ar[0].buckets.no_due_date).toBe(500);
    expect(report.ar[0].buckets.current).toBe(0);
  });

  it("★ กลุ่มตาม counterpartyName — บิลหลายใบของคู่ค้าเดียวกัน รวมยอดในแถวเดียว (0.10)", () => {
    const entries = [
      mkEntry({ id: "e1", counterpartyName: "ลูกค้า A", dueDate: "2026-08-01", lines: [mkLine({ amount: 1000 })] }), // 1_30
      mkEntry({ id: "e2", counterpartyName: "ลูกค้า A", dueDate: "2026-01-01", lines: [mkLine({ amount: 500 })] }), // over_90
      mkEntry({ id: "e3", counterpartyName: "ลูกค้า B", dueDate: "2026-08-01", lines: [mkLine({ amount: 300 })] }),
    ];
    const report = buildAgingReport(entries, payments({}), ASOF);
    expect(report.ar).toHaveLength(2);
    const rowA = report.ar.find((r) => r.counterpartyName === "ลูกค้า A")!;
    expect(rowA.total).toBe(1500);
    expect(rowA.buckets["1_30"]).toBe(1000);
    expect(rowA.buckets.over_90).toBe(500);
    expect(rowA.bills).toHaveLength(2);
    expect(report.totalsByBucket.ar["1_30"]).toBe(1300); // e1 (1000) + e3 (300)
    expect(report.totalsByBucket.ar.over_90).toBe(500);
  });

  it("ไม่ระบุชื่อคู่ค้า → กลุ่มรวมเป็น '(ไม่ระบุชื่อคู่ค้า)'", () => {
    const entries = [mkEntry({ id: "e1", counterpartyName: null, dueDate: "2026-08-01" })];
    const report = buildAgingReport(entries, payments({}), ASOF);
    expect(report.ar[0].counterpartyName).toBe("(ไม่ระบุชื่อคู่ค้า)");
  });

  it("AGING_BUCKET_ORDER ครบ 6 กลุ่มตามลำดับที่กำหนด", () => {
    expect(AGING_BUCKET_ORDER).toEqual(["no_due_date", "current", "1_30", "31_60", "61_90", "over_90"]);
  });

  // -----------------------------------------------------------------
  // netAdjustmentByEntry (เฟส 3 ส่วน J, 0.6) — CN/DN confirmed ปรับยอดค้าง/bucket
  // -----------------------------------------------------------------
  it("★ ไม่ระบุ netAdjustmentByEntry → default Map ว่าง = พฤติกรรมเดิมเป๊ะ", () => {
    const entries = [mkEntry({ id: "e1", dueDate: "2026-08-01", lines: [mkLine({ amount: 1000 })] })];
    const withDefault = buildAgingReport(entries, payments({}), ASOF);
    const withEmptyMap = buildAgingReport(entries, payments({}), ASOF, new Map());
    expect(withDefault).toEqual(withEmptyMap);
  });

  it("มี CN confirmed (ลบ) → ยอดค้างชำระ/bucket ลดลงตามยอด CN", () => {
    const entries = [mkEntry({ id: "e1", dueDate: "2026-08-01", lines: [mkLine({ amount: 1000 })] })];
    const report = buildAgingReport(entries, payments({}), ASOF, new Map([["e1", -300]]));
    expect(report.ar[0].total).toBe(700);
    expect(report.ar[0].buckets["1_30"]).toBe(700);
  });

  it("มี DN confirmed (บวก) → ยอดค้างชำระเพิ่มขึ้นตามยอด DN", () => {
    const entries = [mkEntry({ id: "e1", dueDate: "2026-08-01", lines: [mkLine({ amount: 1000 })] })];
    const report = buildAgingReport(entries, payments({}), ASOF, new Map([["e1", 250]]));
    expect(report.ar[0].total).toBe(1250);
  });

  it("CN ทำให้ยอดค้างชำระเหลือ ≤ EPSILON → บิลหลุดออกจากรายงาน", () => {
    const entries = [mkEntry({ id: "e1", dueDate: "2026-08-01", lines: [mkLine({ amount: 1000 })] })];
    const report = buildAgingReport(entries, payments({}), ASOF, new Map([["e1", -1000]]));
    expect(report.ar).toHaveLength(0);
  });

  // -----------------------------------------------------------------
  // asOfDate → billOutstanding (เฟส 10b, 0.5 — bonus correctness fix: เดิมไม่ส่ง asOfDate เข้า
  //   billOutstanding เลย เป็นบั๊ก) — เคสปกติต้องไม่เปลี่ยน + เคสตั้งใจต้องแก้บั๊กได้จริง
  // -----------------------------------------------------------------
  it("★ เคสปกติ (payment ทุกแถว payDate ≤ asOfDate เสมอ — สถานการณ์จริงทั่วไป) → ผลลัพธ์เหมือนก่อนแก้เป๊ะ (regression บังคับ)", () => {
    const entries = [mkEntry({ id: "e1", dueDate: "2026-08-01", lines: [mkLine({ amount: 1000 })] })];
    const report = buildAgingReport(entries, payments({ e1: [{ amount: 400, payDate: "2026-08-01" }] }), ASOF);
    expect(report.ar[0].total).toBe(600); // เหมือนเทสต์เดิม "จ่ายบางส่วน" ข้างบนทุกประการ
  });

  it("★★★ บั๊กที่แก้ (0.5) — payment วันที่ในอนาคตเทียบกับ asOfDate (ตั้งรายงานย้อนหลัง) → ไม่ถูกหักออก (payment ยังไม่เกิดขึ้นจริง ณ วันตั้งรายงาน)", () => {
    const entries = [mkEntry({ id: "e1", dueDate: "2026-08-01", lines: [mkLine({ amount: 1000 })] })];
    // payment เกิดวันที่ 08-20 แต่ตั้งรายงาน ณ วันที่ 08-08 (ก่อนวันที่ payment) → ต้องไม่ถูกหัก
    const report = buildAgingReport(entries, payments({ e1: [{ amount: 400, payDate: "2026-08-20" }] }), ASOF);
    expect(report.ar[0].total).toBe(1000); // เต็มยอด — ไม่หัก payment ที่ยังไม่ถึงวันนั้น
  });

  it("payment บางแถว payDate ≤ asOfDate บางแถว > asOfDate (ผสม) → หักเฉพาะแถวที่เกิดจริงแล้ว", () => {
    const entries = [mkEntry({ id: "e1", dueDate: "2026-08-01", lines: [mkLine({ amount: 1000 })] })];
    const report = buildAgingReport(
      entries,
      payments({
        e1: [
          { amount: 300, payDate: "2026-08-01" }, // ≤ ASOF → หัก
          { amount: 400, payDate: "2026-08-20" }, // > ASOF → ไม่หัก
        ],
      }),
      ASOF
    );
    expect(report.ar[0].total).toBe(700); // 1000 - 300
  });
});
