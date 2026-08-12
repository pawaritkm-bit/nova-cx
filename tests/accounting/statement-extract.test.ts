import { describe, it, expect, vi, afterEach } from "vitest";
import { extractStatementFromTextChunks, extractStatementFromText } from "@/lib/accounting/statement-extract";

/**
 * เทสต์ `statement-extract.ts` ส่วน chunked extraction (แก้บั๊ก A/D, 2026-08-12)
 *   - หลายชุดยิง AI พร้อมกัน แล้วรวมผลลัพธ์ถูกต้อง
 *   - แยก "ชุดที่อ่านแล้วไม่มีธุรกรรมจริง ๆ" ออกจาก "ชุดที่ล้มเหลว" (error/timeout/parse ไม่ได้)
 */

function mockContent(txns: unknown[]): { choices: { message: { content: string } }[] } {
  return { choices: [{ message: { content: JSON.stringify({ transactions: txns }) } }] };
}

describe("extractStatementFromTextChunks", () => {
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
    const r = await extractStatementFromTextChunks([]);
    expect(r).toEqual({ txns: [], chunkCount: 0, failedChunks: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ไม่มี OPENAI_API_KEY → ทุกชุดถือเป็น failed (ไม่ใช่ 'ไม่มีธุรกรรม')", async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await extractStatementFromTextChunks(["chunk1", "chunk2"]);
    expect(r.txns).toEqual([]);
    expect(r.chunkCount).toBe(2);
    expect(r.failedChunks).toBe(2);
  });

  it("หลายชุดสำเร็จหมด → รวมธุรกรรมจากทุกชุดถูกต้อง (ไม่ปนกัน/ไม่หาย)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        call += 1;
        const n = call; // แต่ละชุดตอบธุรกรรมยอดต่างกัน แยกแยะได้ว่าไม่ปนกัน
        return { ok: true, json: async () => mockContent([{ date: "2026-07-01", amount: n * 100 }]) };
      })
    );
    const r = await extractStatementFromTextChunks(["chunk1", "chunk2", "chunk3"]);
    expect(r.chunkCount).toBe(3);
    expect(r.failedChunks).toBe(0);
    expect(r.txns.length).toBe(3);
    expect(r.txns.map((t) => t.amount).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([100, 200, 300]);
  });

  it("ชุดหนึ่งอ่านแล้วไม่มีธุรกรรมจริง ๆ (transactions:[]) → ไม่นับเป็น failed", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ({ ok: true, json: async () => mockContent([]) }))
    );
    const r = await extractStatementFromTextChunks(["chunk1", "chunk2"]);
    expect(r.txns).toEqual([]);
    expect(r.failedChunks).toBe(0); // ★ ต้องไม่ถือว่าล้มเหลว — parse ได้ปกติ แค่ไม่มีธุรกรรมในชุดนั้นจริง ๆ
  });

  it("บาง chunk ล้มเหลว (HTTP error) บาง chunk สำเร็จ → รวมได้เฉพาะที่สำเร็จ + นับ failedChunks ถูกต้อง", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        call += 1;
        if (call % 2 === 0) return { ok: false, status: 500 };
        return { ok: true, json: async () => mockContent([{ date: "2026-07-01", amount: 1 }]) };
      })
    );
    const r = await extractStatementFromTextChunks(["c1", "c2", "c3", "c4"]);
    expect(r.chunkCount).toBe(4);
    expect(r.failedChunks).toBe(2);
    expect(r.txns.length).toBe(2);
  });

  it("output JSON ถูกตัดกลางคัน (parse ไม่ผ่าน) → ถือเป็น failed ไม่ใช่ 'ไม่มีธุรกรรม' (แก้บั๊ก D)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"transactions":[{"date":"2026-07-01"' } }] }), // ตัดกลางคัน
      })
    );
    const r = await extractStatementFromTextChunks(["chunk1"]);
    expect(r.failedChunks).toBe(1);
    expect(r.txns).toEqual([]);
  });

  it("fetch throw (network error) → นับเป็น failed", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const r = await extractStatementFromTextChunks(["chunk1"]);
    expect(r.failedChunks).toBe(1);
  });
});

describe("extractStatementFromText — ยังคงคืน StatementTxn[] ตรง ๆ เหมือนเดิม (backward compatible)", () => {
  const origKey = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (origKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origKey;
    vi.restoreAllMocks();
  });

  it("ข้อความว่าง → [] ไม่เรียก fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await extractStatementFromText("   ")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ตอบสำเร็จ → คืน array ตรง ๆ (ไม่ห่อ {txns,failed})", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => mockContent([{ date: "2026-07-01", amount: 5 }]) })
    );
    const out = await extractStatementFromText("some text");
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].amount).toBe(5);
  });
});
