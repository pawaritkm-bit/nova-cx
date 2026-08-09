import { describe, it, expect, afterEach, vi } from "vitest";
import { normalizeExtraction, extractBillData } from "@/lib/ai/bill-extract";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { TEST_CHART } from "@/tests/accounting/fixtures/chart";

/**
 * bill-extract — สกัดข้อมูลบิลด้วย AI vision (★ high-confidence only)
 *   เน้นกฎ: ช่อง confidence < 0.8 → null (เว้นว่างให้คนคีย์) โดยเฉพาะตัวเลข
 *   ★ normalizeExtraction รับ chartByCode เป็นพารามิเตอร์ (validate account_code) — ใช้ TEST_CHART fixture
 *     เฉพาะเทสต์ account_code (เทสต์อื่นไม่เกี่ยว ใช้ default {} ได้)
 */

const TEST_CHART_BY_CODE = buildChartByCode(TEST_CHART);

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
    // เติมด้วยความมั่นใจสูง → ไม่ mark เดา
    expect(r?.lines[0].low_confidence).toBe(false);
  });

  it("★ ตัวเลข conf ปานกลาง (>=0.3, <0.8) → เติมค่า + mark low_confidence (เดา)", () => {
    const r = normalizeExtraction({
      lines: [
        {
          vat_type: "vat",
          amount: { value: 999, confidence: 0.5 },
          vat_amount: { value: 70, confidence: 0.5 },
        },
      ],
      overall_confidence: 0.6,
    });
    expect(r?.lines[0].amount).toBe(999);
    expect(r?.lines[0].vat_amount).toBe(70);
    expect(r?.lines[0].low_confidence).toBe(true);
  });

  it("★ ตัวเลข conf ต่ำมาก (<0.3) → null (ต่ำเกินจะเดา, ไม่ mark)", () => {
    const r = normalizeExtraction({
      lines: [
        {
          vat_type: "vat",
          amount: { value: 999, confidence: 0.2 },
          vat_amount: { value: 70, confidence: 0.1 },
        },
      ],
      overall_confidence: 0.2,
    });
    expect(r?.lines[0].amount).toBeNull();
    expect(r?.lines[0].vat_amount).toBeNull();
    expect(r?.lines[0].low_confidence).toBe(false);
  });

  it("string: doc_no/ชื่อ เติมเชิงรุก (>=0.3) · doc_date/tax_id คงเกณฑ์สูง", () => {
    const r = normalizeExtraction({
      doc_no: { value: "R-1", confidence: 0.4 }, // >=0.3 → เก็บ
      seller_name: { value: "ผู้ขาย", confidence: 0.5 }, // >=0.3 → เก็บ
      doc_date: { value: "2026-07-15", confidence: 0.5 }, // <0.8 → null (วันที่ผิด=ยุ่ง)
      seller_tax_id: { value: "0105500000001", confidence: 0.5 }, // <0.8 → null (เลขภาษี)
      lines: [],
      overall_confidence: 0.4,
    });
    expect(r?.doc_no).toBe("R-1");
    expect(r?.seller_name).toBe("ผู้ขาย");
    expect(r?.doc_date).toBeNull();
    expect(r?.seller_tax_id).toBeNull();
  });

  it("string conf ต่ำมาก (<0.3) → null (ต่ำเกินจะเดา)", () => {
    const r = normalizeExtraction({
      doc_no: { value: "เดามา", confidence: 0.2 },
      lines: [],
      overall_confidence: 0.2,
    });
    expect(r?.doc_no).toBeNull();
  });

  it("ไม่มี line เลย → สร้าง 1 line ว่าง (vat, ค่า null) ไม่ทิ้งทั้งใบ", () => {
    const r = normalizeExtraction({ lines: [], overall_confidence: 0.2 });
    expect(r?.lines.length).toBe(1);
    expect(r?.lines[0].vat_type).toBe("vat");
    expect(r?.lines[0].amount).toBeNull();
    expect(r?.lines[0].low_confidence).toBe(false);
  });

  it("vat_type: AI ติ๊กเฉพาะที่มั่นใจ · ไม่ชัด/ค่าแปลก → default novat (ไม่เคลม VAT มั่ว)", () => {
    const r = normalizeExtraction({
      lines: [
        // string ตรง ๆ (เก่า) = เชื่อ conf=1
        { vat_type: "novat", amount: { value: 50, confidence: 0.9 } },
        // ค่าแปลก → default novat (เดิม default vat)
        { vat_type: "weird", amount: { value: 10, confidence: 0.9 } },
        // {value,confidence} มั่นใจ vat → vat
        { vat_type: { value: "vat", confidence: 0.9 }, amount: { value: 20, confidence: 0.9 } },
        // {value,confidence} vat แต่ conf ต่ำ → novat (gate ไม่ผ่าน)
        { vat_type: { value: "vat", confidence: 0.3 }, amount: { value: 30, confidence: 0.9 } },
      ],
    });
    expect(r?.lines[0].vat_type).toBe("novat");
    expect(r?.lines[1].vat_type).toBe("novat");
    expect(r?.lines[2].vat_type).toBe("vat");
    expect(r?.lines[3].vat_type).toBe("novat");
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

describe("normalizeExtraction — account_code (บัญชีที่ AI แนะนำ)", () => {
  it("code non-bank ในผัง + confidence สูง → เก็บ (เช่น 5340 ค่าน้ำมัน) + ไม่ mark เดา", () => {
    const r = normalizeExtraction(
      {
        lines: [{ vat_type: "vat", amount: { value: 100, confidence: 0.9 }, account_code: { value: "5340", confidence: 0.9 } }],
      },
      TEST_CHART_BY_CODE
    );
    expect(r?.lines[0].account_code).toBe("5340");
    expect(r?.lines[0].low_confidence).toBe(false);
  });

  it("★ code หมวดเงินฝากธนาคาร (bank:true เช่น 1020) → null (ห้าม AI เลือก)", () => {
    const r = normalizeExtraction(
      {
        lines: [{ vat_type: "vat", account_code: { value: "1020", confidence: 0.99 } }],
      },
      TEST_CHART_BY_CODE
    );
    expect(r?.lines[0].account_code).toBeNull();
  });

  it("★ code นอกผัง (มั่ว) → null", () => {
    const r = normalizeExtraction(
      {
        lines: [{ vat_type: "vat", account_code: { value: "9999", confidence: 0.99 } }],
      },
      TEST_CHART_BY_CODE
    );
    expect(r?.lines[0].account_code).toBeNull();
  });

  it("★ conf ปานกลาง (>=0.3, <0.7) → เติมบัญชี + mark low_confidence (เดา)", () => {
    const r = normalizeExtraction(
      {
        lines: [{ vat_type: "vat", account_code: { value: "5340", confidence: 0.5 } }],
      },
      TEST_CHART_BY_CODE
    );
    expect(r?.lines[0].account_code).toBe("5340");
    expect(r?.lines[0].low_confidence).toBe(true);
  });

  it("conf ต่ำมาก (<0.3) → null (ต่ำเกินจะเดา ให้คนเลือก)", () => {
    const r = normalizeExtraction(
      {
        lines: [{ vat_type: "vat", account_code: { value: "5340", confidence: 0.2 } }],
      },
      TEST_CHART_BY_CODE
    );
    expect(r?.lines[0].account_code).toBeNull();
    expect(r?.lines[0].low_confidence).toBe(false);
  });

  it("value=null → null", () => {
    const r = normalizeExtraction(
      {
        lines: [{ vat_type: "vat", account_code: { value: null, confidence: 0.9 } }],
      },
      TEST_CHART_BY_CODE
    );
    expect(r?.lines[0].account_code).toBeNull();
  });

  it("ไม่ส่ง account_code มาเลย → null (ไม่ล้ม)", () => {
    const r = normalizeExtraction(
      {
        lines: [{ vat_type: "vat", amount: { value: 50, confidence: 0.9 } }],
      },
      TEST_CHART_BY_CODE
    );
    expect(r?.lines[0].account_code).toBeNull();
  });

  it("code เป็น string ตรง ๆ (ไม่มี confidence) แต่อยู่ในผัง → เก็บ", () => {
    const r = normalizeExtraction(
      {
        lines: [{ vat_type: "vat", account_code: "5010" }],
      },
      TEST_CHART_BY_CODE
    );
    expect(r?.lines[0].account_code).toBe("5010");
  });
});

describe("normalizeExtraction — wht_rate / wht_amount (หัก ณ ที่จ่าย)", () => {
  it("WHT confidence สูง (>=0.8) → เก็บค่า", () => {
    const r = normalizeExtraction({
      lines: [
        {
          vat_type: "vat",
          amount: { value: 1000, confidence: 0.9 },
          wht_rate: { value: 3, confidence: 0.9 },
          wht_amount: { value: 30, confidence: 0.9 },
        },
      ],
    });
    expect(r?.lines[0].wht_rate).toBe(3);
    expect(r?.lines[0].wht_amount).toBe(30);
  });

  it("★ WHT confidence ต่ำ (<0.8) → null (ไม่เดา — worker แนะนำจากบัญชีแทน)", () => {
    const r = normalizeExtraction({
      lines: [
        {
          vat_type: "vat",
          amount: { value: 1000, confidence: 0.9 },
          wht_rate: { value: 3, confidence: 0.5 },
          wht_amount: { value: 30, confidence: 0.7 },
        },
      ],
    });
    expect(r?.lines[0].wht_rate).toBeNull();
    expect(r?.lines[0].wht_amount).toBeNull();
  });

  it("ไม่ส่ง WHT มาเลย → null ทั้งคู่ (ไม่ล้ม)", () => {
    const r = normalizeExtraction({
      lines: [{ vat_type: "vat", amount: { value: 50, confidence: 0.9 } }],
    });
    expect(r?.lines[0].wht_rate).toBeNull();
    expect(r?.lines[0].wht_amount).toBeNull();
  });

  it("wht_rate ติดลบ → null (ค่าผิดปกติ)", () => {
    const r = normalizeExtraction({
      lines: [{ vat_type: "vat", wht_rate: { value: -3, confidence: 0.99 } }],
    });
    expect(r?.lines[0].wht_rate).toBeNull();
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
    // ★ โหมดเติมเชิงรุก: vat conf 0.4 (>=0.3) → เดาเติม 14 + mark low_confidence
    expect(r?.lines[0].vat_amount).toBe(14);
    expect(r?.lines[0].low_confidence).toBe(true);
  });
});
