import { describe, it, expect } from "vitest";
import {
  filterEntriesForReport,
  filterManualEntriesForReport,
  filterBillPaymentsForReport,
  filterCreditDebitNotesForReport,
  periodLabel,
  validMonth,
} from "@/lib/accounting/report-filter";
import type { BillEntry } from "@/lib/accounting/queries";
import type { ManualJournalEntry } from "@/lib/accounting/manual-journal";
import type { BillPayment } from "@/lib/accounting/bill-payments";
import type { CreditDebitNote } from "@/lib/accounting/credit-debit-notes";

/** สร้าง BillEntry ขั้นต่ำสำหรับทดสอบตัวกรอง (สนใจแค่ docDate + status) */
function e(id: string, docDate: string | null, status: "draft" | "confirmed"): BillEntry {
  return {
    id,
    tenantId: "t",
    attachmentId: null,
    customerId: "c",
    customerName: null,
    attachmentObjectPath: null,
    uploadPath: null,
    uploadName: null,
    uploadMime: null,
    entryType: "purchase",
    docDate,
    docNo: null,
    counterpartyName: null,
    counterpartyTaxId: null,
    sellerName: null,
    sellerTaxId: null,
    buyerName: null,
    buyerTaxId: null,
    whtForm: null,
    paymentMethod: "cash",
    paymentBankAccountId: null,
    paymentBankAccountCode: null,
    dueDate: null,
    status,
    source: "ai",
    aiConfidence: null,
    notes: null,
    createdAt: "2026-07-01T00:00:00Z",
    confirmedAt: null,
    inputTaxMonth: null,
    lines: [],
  };
}

const data = [
  e("a", "2026-06-15", "confirmed"),
  e("b", "2026-07-05", "confirmed"),
  e("c", "2026-07-20", "draft"),
  e("d", "2026-08-10", "confirmed"),
  e("e", null, "confirmed"), // ยังไม่ลงวันที่
];

describe("report-filter — กรองงวด + สถานะ", () => {
  it("ไม่เลือกงวด + รวมร่าง → ได้ทุกใบ", () => {
    const r = filterEntriesForReport(data, { includeDraft: true });
    expect(r.map((x) => x.id).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("เฉพาะยืนยันแล้ว → ตัดร่าง (c) ออก", () => {
    const r = filterEntriesForReport(data, { includeDraft: false });
    expect(r.map((x) => x.id)).not.toContain("c");
    expect(r.map((x) => x.id).sort()).toEqual(["a", "b", "d", "e"]);
  });

  it("เลือกเดือน ก.ค. เดียว (from=to=2026-07) → เฉพาะ b, c (ตัดใบไม่มีวันที่)", () => {
    const r = filterEntriesForReport(data, { from: "2026-07", to: "2026-07", includeDraft: true });
    expect(r.map((x) => x.id).sort()).toEqual(["b", "c"]);
  });

  it("ช่วง มิ.ย.–ก.ค. → a, b, c", () => {
    const r = filterEntriesForReport(data, { from: "2026-06", to: "2026-07", includeDraft: true });
    expect(r.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("ตั้งแต่ ก.ค. เป็นต้นไป (ไม่ระบุ to) → b, c, d", () => {
    const r = filterEntriesForReport(data, { from: "2026-07", includeDraft: true });
    expect(r.map((x) => x.id).sort()).toEqual(["b", "c", "d"]);
  });

  it("เลือกงวด → บิลไม่มีวันที่ (e) ถูกตัดออกเสมอ", () => {
    const r = filterEntriesForReport(data, { from: "2026-06", to: "2026-08", includeDraft: true });
    expect(r.map((x) => x.id)).not.toContain("e");
  });
});

/** สร้าง manual JE ขั้นต่ำสำหรับทดสอบตัวกรอง (สนใจแค่ docDate + status — เฟส 1 ส่วน C) */
function mje(id: string, docDate: string | null, status: "draft" | "confirmed"): ManualJournalEntry {
  return {
    id,
    tenantId: "t",
    customerId: "c",
    docType: "JV",
    docDate: docDate ?? "",
    docNo: null,
    memo: null,
    status,
    createdAt: "2026-07-01T00:00:00Z",
    confirmedAt: null,
    lines: [],
  };
}

const manualData = [
  mje("a", "2026-06-15", "confirmed"),
  mje("b", "2026-07-05", "confirmed"),
  mje("c", "2026-07-20", "draft"),
  mje("d", "2026-08-10", "confirmed"),
];

describe("report-filter — filterManualEntriesForReport (semantics เดียวกับ filterEntriesForReport เดิม)", () => {
  it("ไม่เลือกงวด + รวมร่าง → ได้ทุกใบ", () => {
    const r = filterManualEntriesForReport(manualData, { includeDraft: true });
    expect(r.map((x) => x.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("เฉพาะยืนยันแล้ว → ตัดร่าง (c) ออก", () => {
    const r = filterManualEntriesForReport(manualData, { includeDraft: false });
    expect(r.map((x) => x.id).sort()).toEqual(["a", "b", "d"]);
  });

  it("เลือกเดือน ก.ค. เดียว → เฉพาะ b, c", () => {
    const r = filterManualEntriesForReport(manualData, { from: "2026-07", to: "2026-07", includeDraft: true });
    expect(r.map((x) => x.id).sort()).toEqual(["b", "c"]);
  });

  it("ช่วง มิ.ย.–ก.ค. → a, b, c", () => {
    const r = filterManualEntriesForReport(manualData, { from: "2026-06", to: "2026-07", includeDraft: true });
    expect(r.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("manual JE ไม่มีวันที่ (docDate ว่าง) + เลือกงวด → ถูกตัดออก", () => {
    const withEmpty = [...manualData, mje("e", "", "confirmed")];
    const r = filterManualEntriesForReport(withEmpty, { from: "2026-06", to: "2026-08", includeDraft: true });
    expect(r.map((x) => x.id)).not.toContain("e");
  });
});

/** สร้าง bill payment ขั้นต่ำสำหรับทดสอบตัวกรอง (สนใจแค่ pay_date — เฟส 2 ส่วน E) */
function bp(id: string, payDate: string): BillPayment {
  return {
    id,
    tenantId: "t",
    entryId: "e1",
    customerId: "c",
    payDate,
    amount: 100,
    method: "cash",
    bankAccountId: null,
    bankAccountCode: null,
    notes: null,
    createdAt: "2026-07-01T00:00:00Z",
    currency: null,
    fxRate: null,
    fxAmount: null,
    fxGainLossNoteId: null,
  };
}

const paymentData = [
  bp("a", "2026-06-15"),
  bp("b", "2026-07-05"),
  bp("c", "2026-07-20"),
  bp("d", "2026-08-10"),
];

describe("report-filter — filterBillPaymentsForReport (กรองตาม pay_date เท่านั้น — ไม่มี includeDraft)", () => {
  it("ไม่เลือกงวด → ได้ทุกรายการ", () => {
    const r = filterBillPaymentsForReport(paymentData, {});
    expect(r.map((x) => x.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("เลือกเดือน ก.ค. เดียว (from=to=2026-07) → เฉพาะ b, c", () => {
    const r = filterBillPaymentsForReport(paymentData, { from: "2026-07", to: "2026-07" });
    expect(r.map((x) => x.id).sort()).toEqual(["b", "c"]);
  });

  it("ช่วง มิ.ย.–ก.ค. → a, b, c", () => {
    const r = filterBillPaymentsForReport(paymentData, { from: "2026-06", to: "2026-07" });
    expect(r.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("ตั้งแต่ ก.ค. เป็นต้นไป (ไม่ระบุ to) → b, c, d", () => {
    const r = filterBillPaymentsForReport(paymentData, { from: "2026-07" });
    expect(r.map((x) => x.id).sort()).toEqual(["b", "c", "d"]);
  });

  it("ถึง ก.ค. เท่านั้น (ไม่ระบุ from) → a, b, c", () => {
    const r = filterBillPaymentsForReport(paymentData, { to: "2026-07" });
    expect(r.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
  });
});

/** สร้าง CN/DN ขั้นต่ำสำหรับทดสอบตัวกรอง (สนใจแค่ docDate + status — เฟส 3 ส่วน J) */
function note(id: string, docDate: string, status: "draft" | "confirmed"): CreditDebitNote {
  return {
    id,
    tenantId: "t",
    entryId: "e1",
    customerId: "c",
    docType: "credit_note",
    docDate,
    docNo: null,
    reason: "เหตุผล",
    status,
    createdAt: "2026-07-01T00:00:00Z",
    confirmedAt: null,
    lines: [],
  };
}

const noteData = [
  note("a", "2026-06-15", "confirmed"),
  note("b", "2026-07-05", "confirmed"),
  note("c", "2026-07-20", "draft"),
  note("d", "2026-08-10", "confirmed"),
];

describe("report-filter — filterCreditDebitNotesForReport (กรอง confirmed เท่านั้น ต่างจาก bill_payments)", () => {
  it("★ กรอง draft ออกเสมอ แม้ไม่เลือกงวด", () => {
    const r = filterCreditDebitNotesForReport(noteData, {});
    expect(r.map((x) => x.id).sort()).toEqual(["a", "b", "d"]);
  });

  it("เลือกเดือน ก.ค. เดียว (from=to=2026-07) → เฉพาะ b (c ถูกตัดเพราะ draft)", () => {
    const r = filterCreditDebitNotesForReport(noteData, { from: "2026-07", to: "2026-07" });
    expect(r.map((x) => x.id)).toEqual(["b"]);
  });

  it("ช่วง มิ.ย.–ก.ค. → a, b (c ยังถูกตัดเพราะ draft)", () => {
    const r = filterCreditDebitNotesForReport(noteData, { from: "2026-06", to: "2026-07" });
    expect(r.map((x) => x.id).sort()).toEqual(["a", "b"]);
  });

  it("ตั้งแต่ ก.ค. เป็นต้นไป (ไม่ระบุ to) → b, d", () => {
    const r = filterCreditDebitNotesForReport(noteData, { from: "2026-07" });
    expect(r.map((x) => x.id).sort()).toEqual(["b", "d"]);
  });
});

describe("report-filter — validMonth + periodLabel", () => {
  it("validMonth รับเฉพาะ YYYY-MM ที่ถูก", () => {
    expect(validMonth("2026-07")).toBe("2026-07");
    expect(validMonth("2026-13")).toBe("");
    expect(validMonth("bad")).toBe("");
    expect(validMonth(null)).toBe("");
  });

  it("periodLabel อ่านง่าย (พ.ศ.)", () => {
    expect(periodLabel("", "")).toBe("ทุกงวด");
    expect(periodLabel("2026-07", "2026-07")).toContain("2569");
    expect(periodLabel("2026-01", "2026-03")).toContain("–");
  });
});
