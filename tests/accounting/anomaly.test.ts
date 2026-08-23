import { describe, it, expect } from "vitest";
import { detectAnomalies, hasErrorAnomaly, type AnomalyInput } from "@/lib/accounting/anomaly";

function base(lines: AnomalyInput["lines"], over: Partial<AnomalyInput> = {}): AnomalyInput {
  return { entryType: "purchase", docNo: "INV-1", docDate: "2026-08-01", lines, ...over };
}

describe("detectAnomalies", () => {
  it("บิลว่าง (ยอด 0) — ไม่ตรวจ ไม่มี anomaly", () => {
    const a = detectAnomalies(base([{ vatType: "vat", amount: 0, vatAmount: 0, whtRate: 0, whtAmount: 0 }]));
    expect(a).toEqual([]);
  });

  it("VAT ตรง 7% — ไม่เตือน", () => {
    const a = detectAnomalies(base([{ vatType: "vat", amount: 1000, vatAmount: 70, whtRate: 0, whtAmount: 0 }]));
    expect(a.find((x) => x.code === "vat_mismatch")).toBeUndefined();
  });

  it("VAT ไม่ตรง 7% (เกิน tolerance) — error vat_mismatch", () => {
    const a = detectAnomalies(base([{ vatType: "vat", amount: 1000, vatAmount: 120, whtRate: 0, whtAmount: 0 }]));
    const m = a.find((x) => x.code === "vat_mismatch");
    expect(m?.severity).toBe("error");
    expect(hasErrorAnomaly(a)).toBe(true);
  });

  it("VAT ต่างเล็กน้อย (≤1 บาท) — ไม่เตือน (ผ่อนผันปัดเศษ)", () => {
    const a = detectAnomalies(base([{ vatType: "vat", amount: 1000, vatAmount: 70.5, whtRate: 0, whtAmount: 0 }]));
    expect(a.find((x) => x.code === "vat_mismatch")).toBeUndefined();
  });

  it("vatAmount=0 (ระบบคิด 7% เอง) — ไม่เตือน VAT mismatch", () => {
    const a = detectAnomalies(base([{ vatType: "vat", amount: 1000, vatAmount: 0, whtRate: 0, whtAmount: 0 }]));
    expect(a.find((x) => x.code === "vat_mismatch")).toBeUndefined();
  });

  it("WHT ตรงอัตรา — ไม่เตือน", () => {
    const a = detectAnomalies(base([{ vatType: "novat", amount: 1000, vatAmount: 0, whtRate: 3, whtAmount: 30 }]));
    expect(a.find((x) => x.code === "wht_mismatch")).toBeUndefined();
  });

  it("WHT ไม่ตรงอัตรา — error wht_mismatch", () => {
    const a = detectAnomalies(base([{ vatType: "novat", amount: 1000, vatAmount: 0, whtRate: 3, whtAmount: 99 }]));
    expect(a.find((x) => x.code === "wht_mismatch")?.severity).toBe("error");
  });

  it("อัตรา WHT นอกมาตรฐาน (7%) — warn เท่านั้น", () => {
    const a = detectAnomalies(base([{ vatType: "novat", amount: 1000, vatAmount: 0, whtRate: 7, whtAmount: 70 }]));
    const m = a.find((x) => x.code === "wht_rate_nonstandard");
    expect(m?.severity).toBe("warn");
  });

  it("ยอดรวมติดลบ — error negative_total", () => {
    const a = detectAnomalies(base([{ vatType: "novat", amount: -500, vatAmount: 0, whtRate: 0, whtAmount: 0 }]));
    // amount ติดลบ → totalAmount<0 แต่ hasValue ต้องมียอด>0 อย่างน้อย → ใช้ vat นำ
    const a2 = detectAnomalies(base([
      { vatType: "vat", amount: -500, vatAmount: 70, whtRate: 0, whtAmount: 0 },
    ]));
    expect(a2.find((x) => x.code === "negative_total")?.severity).toBe("error");
    void a;
  });

  it("บิล VAT ขาดเลขที่/วันที่ — warn missing_tax_doc_fields", () => {
    const a = detectAnomalies(base([{ vatType: "vat", amount: 1000, vatAmount: 70, whtRate: 0, whtAmount: 0 }], { docNo: null, docDate: null }));
    const m = a.find((x) => x.code === "missing_tax_doc_fields");
    expect(m?.severity).toBe("warn");
    expect(hasErrorAnomaly(a)).toBe(false);
  });

  it("บิล novat ขาดเลขที่ — ไม่เตือนเอกสารขาด (ไม่ใช่ใบกำกับภาษี)", () => {
    const a = detectAnomalies(base([{ vatType: "novat", amount: 1000, vatAmount: 0, whtRate: 0, whtAmount: 0 }], { docNo: null }));
    expect(a.find((x) => x.code === "missing_tax_doc_fields")).toBeUndefined();
  });

  it("บิลถูกต้องครบ — ไม่มี anomaly", () => {
    const a = detectAnomalies(base([{ vatType: "vat", amount: 1000, vatAmount: 70, whtRate: 3, whtAmount: 30 }]));
    expect(a).toEqual([]);
  });
});
