import { describe, it, expect } from "vitest";
import {
  filterEntriesForReport,
  periodLabel,
  validMonth,
} from "@/lib/accounting/report-filter";
import type { BillEntry } from "@/lib/accounting/queries";
import { defaultFlowAccountSync } from "@/lib/accounting/queries";

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
    status,
    source: "ai",
    aiConfidence: null,
    notes: null,
    createdAt: "2026-07-01T00:00:00Z",
    confirmedAt: null,
    inputTaxMonth: null,
    flowaccountSync: defaultFlowAccountSync(),
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
