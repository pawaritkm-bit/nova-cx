import { describe, it, expect, vi, afterEach } from "vitest";
import {
  extractPlatformReportFromTextChunks,
  extractPlatformReportFromText,
  isUsablePlatformExtraction,
  normalizePlatformExtraction,
} from "@/lib/accounting/platform-report-extract";

/**
 * เทสต์ `platform-report-extract.ts` (ข้อ C, 2026-08-12) — mirror ของ statement-extract.test.ts
 *   - หลายชุดยิง AI พร้อมกัน แล้วรวมผลลัพธ์ถูกต้อง
 *   - แยก "ชุดที่อ่านแล้วไม่มีรายการจริง ๆ" ออกจาก "ชุดที่ล้มเหลว" (error/timeout/parse ไม่ได้)
 */

function mockContent(lines: unknown[]): { choices: { message: { content: string } }[] } {
  return { choices: [{ message: { content: JSON.stringify({ lines }) } }] };
}

describe("extractPlatformReportFromTextChunks", () => {
  const origKey = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (origKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origKey;
    vi.restoreAllMocks();
  });

  it("chunks ว่าง → คืนค่าว่างทันที ไม่เรียก fetch เลย", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await extractPlatformReportFromTextChunks([]);
    expect(r).toEqual({ lines: [], chunkCount: 0, failedChunks: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ไม่มี OPENAI_API_KEY → ทุกชุดถือเป็น failed (ไม่ใช่ 'ไม่มีรายการ')", async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await extractPlatformReportFromTextChunks(["chunk1", "chunk2"]);
    expect(r.lines).toEqual([]);
    expect(r.chunkCount).toBe(2);
    expect(r.failedChunks).toBe(2);
  });

  it("หลายชุดสำเร็จหมด → รวมรายการจากทุกชุดถูกต้อง (ไม่ปนกัน/ไม่หาย)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        call += 1;
        const n = call;
        return {
          ok: true,
          json: async () => mockContent([{ date: "2026-07-01", category: "sales", direction: "credit", amount: n * 100 }]),
        };
      })
    );
    const r = await extractPlatformReportFromTextChunks(["chunk1", "chunk2", "chunk3"]);
    expect(r.chunkCount).toBe(3);
    expect(r.failedChunks).toBe(0);
    expect(r.lines.length).toBe(3);
    expect(r.lines.map((l) => l.amount).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([100, 200, 300]);
  });

  it("ชุดหนึ่งอ่านแล้วไม่มีรายการจริง ๆ (lines:[]) → ไม่นับเป็น failed", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ({ ok: true, json: async () => mockContent([]) })));
    const r = await extractPlatformReportFromTextChunks(["chunk1", "chunk2"]);
    expect(r.lines).toEqual([]);
    expect(r.failedChunks).toBe(0);
  });

  it("บาง chunk ล้มเหลว (HTTP error) บาง chunk สำเร็จ → รวมได้เฉพาะที่สำเร็จ + นับ failedChunks ถูกต้อง", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        call += 1;
        if (call % 2 === 0) return { ok: false, status: 500 };
        return {
          ok: true,
          json: async () => mockContent([{ date: "2026-07-01", category: "sales", direction: "credit", amount: 1 }]),
        };
      })
    );
    const r = await extractPlatformReportFromTextChunks(["c1", "c2", "c3", "c4"]);
    expect(r.chunkCount).toBe(4);
    expect(r.failedChunks).toBe(2);
    expect(r.lines.length).toBe(2);
  });

  it("output JSON ถูกตัดกลางคัน (parse ไม่ผ่าน) → ถือเป็น failed ไม่ใช่ 'ไม่มีรายการ'", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"lines":[{"date":"2026-07-01"' } }] }),
      })
    );
    const r = await extractPlatformReportFromTextChunks(["chunk1"]);
    expect(r.failedChunks).toBe(1);
    expect(r.lines).toEqual([]);
  });

  it("fetch throw (network error) → นับเป็น failed", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const r = await extractPlatformReportFromTextChunks(["chunk1"]);
    expect(r.failedChunks).toBe(1);
  });
});

describe("extractPlatformReportFromText — คืน PlatformReportLine[] ตรง ๆ (backward compatible กับ pattern เดิม)", () => {
  const origKey = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (origKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origKey;
    vi.restoreAllMocks();
  });

  it("ข้อความว่าง → [] ไม่เรียก fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await extractPlatformReportFromText("   ")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ตอบสำเร็จ → คืน array ตรง ๆ", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockContent([{ date: "2026-07-01", category: "sales", direction: "credit", amount: 5 }]),
      })
    );
    const out = await extractPlatformReportFromText("some text");
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].amount).toBe(5);
  });
});

describe("normalizePlatformExtraction (ผลดิบจากโมเดล)", () => {
  it("แปลง พ.ศ.→ค.ศ. ในวันที่ถูกต้อง", () => {
    const out = normalizePlatformExtraction({ lines: [{ date: "2569-07-15", amount: 100, category: "sales" }] });
    expect(out[0].date).toBe("2026-07-15");
  });

  it("amount ติดลบ → เก็บเป็นค่าสัมบูรณ์ (บวก)", () => {
    const out = normalizePlatformExtraction({ lines: [{ amount: -300, category: "sales", description: "x" }] });
    expect(out[0].amount).toBe(300);
  });

  it("category ไม่รู้จัก (ค่าแปลก ๆ จากโมเดล) → null (ไม่เดา/ไม่ผูกกับค่าไม่รู้จัก)", () => {
    const out = normalizePlatformExtraction({ lines: [{ amount: 10, category: "ค่าธรรมเนียมแปลกๆ" }] });
    expect(out[0].category).toBeNull();
  });

  it("category='sales' ไม่ระบุ direction → fallback เป็น 'credit'", () => {
    const out = normalizePlatformExtraction({ lines: [{ amount: 10, category: "sales" }] });
    expect(out[0].direction).toBe("credit");
  });

  it("category='commission_fee' ไม่ระบุ direction → fallback เป็น 'deduct'", () => {
    const out = normalizePlatformExtraction({ lines: [{ amount: 10, category: "commission_fee" }] });
    expect(out[0].direction).toBe("deduct");
  });

  it("amount เป็น string มีลูกน้ำคั่นหลักพัน → parse ได้ถูกต้อง", () => {
    const out = normalizePlatformExtraction({ lines: [{ amount: "12,500.50", category: "sales", order_no: "x" }] });
    expect(out[0].amount).toBe(12500.5);
  });

  it("แถวขยะ (ไม่มีวันที่/ยอด/คำอธิบาย/เลขคำสั่งซื้อ) → ข้าม", () => {
    const out = normalizePlatformExtraction({ lines: [{ category: "sales" }] });
    expect(out).toEqual([]);
  });

  it("raw เป็น null → คืน []", () => {
    expect(normalizePlatformExtraction(null)).toEqual([]);
  });

  it("รับ order_no จากหลาย alias (orderNo/order_id/reference)", () => {
    const out = normalizePlatformExtraction({ lines: [{ order_id: "ORD-1", amount: 5, category: "sales" }] });
    expect(out[0].order_no).toBe("ORD-1");
  });

  it("quality gate ปฏิเสธผลที่ไม่มี direction", () => {
    expect(isUsablePlatformExtraction([{ date: "2026-07-01", order_no: null, description: null, category: "sales", direction: "credit", amount: 100 }])).toBe(true);
    expect(isUsablePlatformExtraction([{ date: "2026-07-01", order_no: null, description: null, category: null, direction: null, amount: 100 }])).toBe(false);
  });
});
