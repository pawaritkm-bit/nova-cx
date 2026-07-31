import { describe, it, expect, afterEach, vi } from "vitest";
import { normalizeExtraction, extractBillData } from "@/lib/ai/bill-extract";

/**
 * bill-extract — สกัดข้อมูลบิลด้วย AI vision (★ high-confidence only)
 *   เน้นกฎ: ช่อง confidence < 0.8 → null (เว้นว่างให้คนคีย์) โดยเฉพาะตัวเลข
 */

describe("normalizeExtraction — high-confidence gating", () => {
  it("field confidence สูง (>=0.8) → เก็บค่า (seller+buyer แยกกัน)", () => {
    const r = normalizeExtraction({
      doc_date: { value: "2026-07-15", confidence: 0.95 },
      doc_no: { value: "INV-001", confidence: 0.9 },
      seller_name: { value: "บริษัท ก", confidence: 0.85 },
      seller_tax_id: { value: "0105500000001", confidence: 0.9 },
      buyer_name: { value: "บริษัท ข", confidence: 0.9 },
      buyer_tax_id: { value: "0105500000002", confidence: 0.9 },
      lines: [{ vat_type: "vat", amount: { value: 100, confidence: 0.9 }, vat_amount: { value: 7, confidence: 0.9 } }],
      overall_confidence: 0.9,
    });
    expect(r).not.toBeNull();
    expect(r?.doc_date).toBe("2026-07-15");
    expect(r?.doc_no).toBe("INV-001");
    expect(r?.seller_name).toBe("บริษัท ก");
    expect(r?.buyer_name).toBe("บริษัท ข");
    expect(r?.lines[0].amount).toBe(100);
    expect(r?.lines[0].vat_amount).toBe(7);
  });

  it("★ ตัวเลข confidence ต่ำ (<0.8) → null (เว้นว่าง ห้ามเดา)", () => {
    const r = normalizeExtraction({
      lines: [
        {
          vat_type: "vat",
          amount: { value: 999, confidence: 0.5 },
          vat_amount: { value: 70, confidence: 0.79 },
        },
      ],
      overall_confidence: 0.6,
    });
    expect(r?.lines[0].amount).toBeNull();
    expect(r?.lines[0].vat_amount).toBeNull();
  });

  it("string field confidence ต่ำ → null", () => {
    const r = normalizeExtraction({
      doc_no: { value: "เดามา", confidence: 0.3 },
      seller_name: { value: "ชื่อเบลอ", confidence: 0.7 },
      lines: [],
      overall_confidence: 0.4,
    });
    expect(r?.doc_no).toBeNull();
    expect(r?.seller_name).toBeNull();
  });

  it("ไม่มี line เลย → สร้าง 1 line ว่าง (vat, ค่า null) ไม่ทิ้งทั้งใบ", () => {
    const r = normalizeExtraction({ lines: [], overall_confidence: 0.2 });
    expect(r?.lines.length).toBe(1);
    expect(r?.lines[0].vat_type).toBe("vat");
    expect(r?.lines[0].amount).toBeNull();
  });

  it("vat_type novat อ่านได้ · ค่าแปลก → default vat", () => {
    const r = normalizeExtraction({
      lines: [
        { vat_type: "novat", amount: { value: 50, confidence: 0.9 } },
        { vat_type: "weird", amount: { value: 10, confidence: 0.9 } },
      ],
    });
    expect(r?.lines[0].vat_type).toBe("novat");
    expect(r?.lines[1].vat_type).toBe("vat");
  });

  it("amount เป็น string มี comma + confidence สูง → parse เป็นเลข", () => {
    const r = normalizeExtraction({
      lines: [{ vat_type: "vat", amount: { value: "1,234.50", confidence: 0.9 } }],
    });
    expect(r?.lines[0].amount).toBe(1234.5);
  });

  it("amount ติดลบ → null (ค่าผิดปกติ)", () => {
    const r = normalizeExtraction({
      lines: [{ vat_type: "vat", amount: { value: -5, confidence: 0.99 } }],
    });
    expect(r?.lines[0].amount).toBeNull();
  });

  it("overall_confidence เกินช่วง → clamp 0..1", () => {
    expect(normalizeExtraction({ lines: [], overall_confidence: 5 })?.overall_confidence).toBe(1);
    expect(normalizeExtraction({ lines: [], overall_confidence: -3 })?.overall_confidence).toBe(0);
  });

  it("parse ไม่ได้ (null) → คืน null", () => {
    expect(normalizeExtraction(null)).toBeNull();
  });
});

describe("extractBillData — degrade & error → null", () => {
  const origKey = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (origKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origKey;
    vi.restoreAllMocks();
  });

  it("ไม่มี OPENAI_API_KEY → คืน null", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await extractBillData(Buffer.from("IMG"), "image/jpeg")).toBeNull();
  });

  it("fetch error → คืน null", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await extractBillData(Buffer.from("IMG"), "image/jpeg")).toBeNull();
  });

  it("HTTP ไม่ ok → คืน null", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await extractBillData(Buffer.from("IMG"), "image/jpeg")).toBeNull();
  });

  it("ตอบ JSON ปกติ → สกัด + gate ตามเกณฑ์", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const content = JSON.stringify({
      doc_no: { value: "R-99", confidence: 0.9 },
      seller_name: { value: "ผู้ขาย", confidence: 0.9 },
      lines: [{ vat_type: "vat", amount: { value: 200, confidence: 0.9 }, vat_amount: { value: 14, confidence: 0.4 } }],
      overall_confidence: 0.8,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })
    );
    const r = await extractBillData(Buffer.from("IMG"), "image/jpeg");
    expect(r?.doc_no).toBe("R-99");
    expect(r?.seller_name).toBe("ผู้ขาย");
    expect(r?.lines[0].amount).toBe(200);
    expect(r?.lines[0].vat_amount).toBeNull(); // confidence 0.4 < 0.8 → เว้นว่าง
  });
});
