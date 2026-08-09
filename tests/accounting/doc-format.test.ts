import { describe, it, expect } from "vitest";
import {
  DOC_TYPE_LABELS,
  DOC_TYPE_PREFIX,
  asSalesDocType,
  beYearNowThai,
  formatSalesDocNo,
} from "@/lib/accounting/doc-format";

/**
 * เฟส 3 ส่วน K (K2, K10) — doc-format.ts: labels/prefix/beYearNowThai/formatSalesDocNo
 *   ★ 0.13: asymmetry กับ CN/DN (free text) — K auto-generate เลขที่เอกสาร
 */

describe("DOC_TYPE_PREFIX / DOC_TYPE_LABELS", () => {
  it("prefix ตรงตามสเปก (quotation→QT, purchase_order→PO, billing_note→BN)", () => {
    expect(DOC_TYPE_PREFIX.quotation).toBe("QT");
    expect(DOC_TYPE_PREFIX.purchase_order).toBe("PO");
    expect(DOC_TYPE_PREFIX.billing_note).toBe("BN");
  });

  it("มีป้ายภาษาไทยครบทั้ง 3 ประเภท", () => {
    expect(DOC_TYPE_LABELS.quotation).toBe("ใบเสนอราคา");
    expect(DOC_TYPE_LABELS.purchase_order).toBe("ใบสั่งซื้อ");
    expect(DOC_TYPE_LABELS.billing_note).toBe("ใบวางบิล");
  });
});

describe("asSalesDocType", () => {
  it("ค่าที่ถูกต้องทั้ง 3 ประเภท → คืนตรงตัว", () => {
    expect(asSalesDocType("quotation")).toBe("quotation");
    expect(asSalesDocType("purchase_order")).toBe("purchase_order");
    expect(asSalesDocType("billing_note")).toBe("billing_note");
  });

  it("ค่าอื่น/undefined/null/ตัวเลข → null", () => {
    expect(asSalesDocType("invoice")).toBeNull();
    expect(asSalesDocType(undefined)).toBeNull();
    expect(asSalesDocType(null)).toBeNull();
    expect(asSalesDocType(123)).toBeNull();
    expect(asSalesDocType("")).toBeNull();
  });
});

describe("formatSalesDocNo", () => {
  it("seq=1 → zero-pad 4 หลัก (0001) ทุก prefix", () => {
    expect(formatSalesDocNo("QT", 2569, 1)).toBe("QT-2569-0001");
    expect(formatSalesDocNo("PO", 2569, 1)).toBe("PO-2569-0001");
    expect(formatSalesDocNo("BN", 2569, 1)).toBe("BN-2569-0001");
  });

  it("seq=42 → \"0042\"", () => {
    expect(formatSalesDocNo("QT", 2569, 42)).toBe("QT-2569-0042");
  });

  it("seq=9999 → \"9999\" (เต็ม 4 หลักพอดี)", () => {
    expect(formatSalesDocNo("QT", 2569, 9999)).toBe("QT-2569-9999");
  });

  it("seq เกิน 4 หลัก (10000) → ไม่ครอบตัด แสดงตามจริง (\"10000\")", () => {
    expect(formatSalesDocNo("QT", 2569, 10000)).toBe("QT-2569-10000");
  });

  it("seq=0/ติดลบ/NaN → ปฏิบัติเป็น 0 (\"0000\") ไม่พัง", () => {
    expect(formatSalesDocNo("QT", 2569, 0)).toBe("QT-2569-0000");
    expect(formatSalesDocNo("QT", 2569, -5)).toBe("QT-2569-0000");
    expect(formatSalesDocNo("QT", 2569, NaN)).toBe("QT-2569-0000");
  });
});

describe("beYearNowThai", () => {
  it("แปลงปี ค.ศ. → พ.ศ. ถูกต้อง (mock เวลา 2026-08-08 UTC ตอนกลางวันไทย)", () => {
    // 2026-08-08T10:00:00Z = 17:00 เวลาไทย (UTC+7) ยังอยู่ปี 2026 ทั้งคู่ฝั่ง
    const d = new Date("2026-08-08T10:00:00Z");
    expect(beYearNowThai(d)).toBe(2026 + 543);
  });

  it("กันเหลื่อมวัน/ปีข้าม timezone — เที่ยงคืน UTC 31 ธ.ค. = เช้าวันที่ 1 ม.ค. เวลาไทย (ปีถัดไป)", () => {
    // 2026-12-31T18:00:00Z = 2027-01-01T01:00:00 เวลาไทย → ต้องนับเป็นปี 2027 (พ.ศ. 2570) ไม่ใช่ 2026 (พ.ศ. 2569)
    const d = new Date("2026-12-31T18:00:00Z");
    expect(beYearNowThai(d)).toBe(2027 + 543);
  });

  it("ไม่ส่งพารามิเตอร์ → ใช้เวลาปัจจุบัน (ไม่พัง คืนตัวเลขที่สมเหตุสมผล)", () => {
    const y = beYearNowThai();
    expect(Number.isInteger(y)).toBe(true);
    expect(y).toBeGreaterThan(2560);
  });
});
