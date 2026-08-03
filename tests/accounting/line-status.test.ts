import { describe, it, expect } from "vitest";
import { lineBadge, entryNeedsReview, countNeedsReview } from "@/lib/accounting/line-status";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";

/**
 * line-status — ป้ายช่วยตรวจ 🟢/🟡 + ตัวนับ "รอตรวจ N" (pure)
 */

const line = (p: Partial<BillEntryLine>): BillEntryLine => ({
  id: p.id ?? "l1",
  entryId: "e1",
  lineNo: 1,
  vatType: "vat",
  description: null,
  accountCode: p.accountCode ?? null,
  accountName: null,
  amount: p.amount ?? 0,
  vatAmount: 0,
  whtRate: 0,
  whtAmount: 0,
  aiFilled: p.aiFilled ?? false,
  aiLowConfidence: p.aiLowConfidence ?? false,
});

describe("lineBadge — 3 สถานะ (มั่นใจ / เดา / ว่าง)", () => {
  it("🟢 confident = ai_filled + มี account_code + amount>0 + ไม่เดา", () => {
    expect(lineBadge({ accountCode: "5340", amount: 100, aiFilled: true, aiLowConfidence: false }, "ai")).toBe("confident");
  });

  it("🟡 guess = เติมครบ แต่ AI เดา (ai_low_confidence)", () => {
    expect(lineBadge({ accountCode: "5340", amount: 100, aiFilled: true, aiLowConfidence: true }, "ai")).toBe("guess");
  });

  it("🟡 check = account_code ว่าง (แม้มียอด) — ว่างสำคัญกว่าเดา", () => {
    expect(lineBadge({ accountCode: null, amount: 100, aiFilled: true, aiLowConfidence: true }, "ai")).toBe("check");
    expect(lineBadge({ accountCode: "  ", amount: 100, aiFilled: true, aiLowConfidence: false }, "ai")).toBe("check");
  });

  it("🟡 check = amount<=0 (แม้มีบัญชี)", () => {
    expect(lineBadge({ accountCode: "5340", amount: 0, aiFilled: true, aiLowConfidence: false }, "ai")).toBe("check");
  });

  it("🟡 check = ai_filled=false (AI ไม่ได้เติมบรรทัดนี้)", () => {
    expect(lineBadge({ accountCode: "5340", amount: 100, aiFilled: false, aiLowConfidence: false }, "ai")).toBe("check");
  });

  it("บิลคีย์เอง (manual) → null (ไม่มีป้าย AI)", () => {
    expect(lineBadge({ accountCode: "5340", amount: 100, aiFilled: true, aiLowConfidence: false }, "manual")).toBeNull();
    expect(lineBadge({ accountCode: null, amount: 0, aiFilled: false, aiLowConfidence: false }, "manual")).toBeNull();
  });
});

/** ประกอบ BillEntry ขั้นต่ำสำหรับเทสต์ (เติม field ที่ไม่เกี่ยวด้วยค่า dummy) */
const entry = (p: { source: "ai" | "manual"; status: "draft" | "confirmed"; lines: BillEntryLine[] }): BillEntry =>
  ({
    id: "e1",
    tenantId: "t1",
    attachmentId: null,
    customerId: null,
    customerName: null,
    attachmentObjectPath: null,
    uploadPath: null,
    uploadName: null,
    uploadMime: null,
    entryType: "purchase",
    docDate: null,
    docNo: null,
    counterpartyName: null,
    counterpartyTaxId: null,
    sellerName: null,
    sellerTaxId: null,
    buyerName: null,
    buyerTaxId: null,
    whtForm: null,
    source: p.source,
    status: p.status,
    aiConfidence: null,
    notes: null,
    createdAt: "2026-07-15",
    confirmedAt: null,
    lines: p.lines,
  }) as BillEntry;

describe("entryNeedsReview / countNeedsReview", () => {
  it("บิล AI ร่าง + มีบรรทัด 🟡 → รอตรวจ", () => {
    const e = entry({ source: "ai", status: "draft", lines: [line({ accountCode: null, amount: 100, aiFilled: true })] });
    expect(entryNeedsReview(e)).toBe(true);
  });

  it("บิล AI ร่าง + ทุกบรรทัด 🟢 → ไม่รอตรวจ", () => {
    const e = entry({ source: "ai", status: "draft", lines: [line({ accountCode: "5340", amount: 100, aiFilled: true })] });
    expect(entryNeedsReview(e)).toBe(false);
  });

  it("บิล AI ร่าง + มีบรรทัด 🟡 guess (AI เดา) → รอตรวจ", () => {
    const e = entry({ source: "ai", status: "draft", lines: [line({ accountCode: "5340", amount: 100, aiFilled: true, aiLowConfidence: true })] });
    expect(entryNeedsReview(e)).toBe(true);
  });

  it("บิล AI ร่าง + ไม่มีบรรทัดเลย → รอตรวจ (ต้องคีย์)", () => {
    const e = entry({ source: "ai", status: "draft", lines: [] });
    expect(entryNeedsReview(e)).toBe(true);
  });

  it("ยืนยันแล้ว → ไม่รอตรวจ (แม้บรรทัดว่าง)", () => {
    const e = entry({ source: "ai", status: "confirmed", lines: [line({ accountCode: null, amount: 0, aiFilled: false })] });
    expect(entryNeedsReview(e)).toBe(false);
  });

  it("บิลคีย์เอง → ไม่นับรอตรวจ", () => {
    const e = entry({ source: "manual", status: "draft", lines: [line({ accountCode: null, amount: 0, aiFilled: false })] });
    expect(entryNeedsReview(e)).toBe(false);
  });

  it("countNeedsReview นับเฉพาะที่รอตรวจ", () => {
    const entries = [
      entry({ source: "ai", status: "draft", lines: [line({ accountCode: null, amount: 100, aiFilled: true })] }), // 🟡 นับ
      entry({ source: "ai", status: "draft", lines: [line({ accountCode: "5340", amount: 100, aiFilled: true })] }), // 🟢 ไม่นับ
      entry({ source: "ai", status: "confirmed", lines: [line({ accountCode: null, amount: 0, aiFilled: false })] }), // ยืนยันแล้ว ไม่นับ
      entry({ source: "manual", status: "draft", lines: [] }), // manual ไม่นับ
    ];
    expect(countNeedsReview(entries)).toBe(1);
  });
});
