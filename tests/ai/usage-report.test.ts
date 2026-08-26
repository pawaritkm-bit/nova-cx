import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { effectiveAiCost, resolveUsageDateRange, type AiUsageRow } from "@/lib/ai/usage-report";
import { buildAiUsageWorkbook } from "@/lib/ai/usage-excel";

describe("AI usage date range", () => {
  it("ใช้ขอบเขตวันไทยแบบรวมวันสุดท้าย", () => {
    const r = resolveUsageDateRange("2026-08-25", "2026-08-26");
    expect(r.fromIso).toBe("2026-08-24T17:00:00.000Z");
    expect(r.untilIso).toBe("2026-08-26T17:00:00.000Z");
  });

  it("สลับวันที่ให้อัตโนมัติเมื่อกรอกย้อนกัน", () => {
    const r = resolveUsageDateRange("2026-08-26", "2026-08-20");
    expect(r.from).toBe("2026-08-20");
    expect(r.to).toBe("2026-08-26");
  });

  it("คิด Gemini thinking token จากส่วนต่างของ total สำหรับข้อมูลเก่า", () => {
    const row: AiUsageRow = { id: 1, source: "statement_extract", provider: "gemini", model: "gemini-3.7-flash", prompt_tokens: 1000, output_tokens: 100, thinking_tokens: null, total_tokens: 1600, estimated_cost_usd: 0, estimated_cost_thb: 0, created_at: "2026-08-26T00:00:00Z" };
    const cost = effectiveAiCost(row);
    expect(cost.thinking).toBe(500);
    expect(cost.usd).toBeCloseTo((1000 * 0.75 + 600 * 3.75) / 1_000_000, 10);
  });
});

describe("AI usage Excel", () => {
  it("สร้าง 2 sheet และยอดสรุปตรงกับรายละเอียด", async () => {
    const rows: AiUsageRow[] = [{ id: 1, source: "bill_extract", provider: "gemini", model: "gemini-3.7-flash", prompt_tokens: 1000, output_tokens: 200, thinking_tokens: 0, total_tokens: 1200, estimated_cost_usd: 0.0015, estimated_cost_thb: 0.0525, created_at: "2026-08-26T04:00:00.000Z" }];
    const bytes = await buildAiUsageWorkbook(rows, "2026-08-26", "2026-08-26");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["สรุป", "รายการใช้งาน"]);
    expect(wb.getWorksheet("สรุป")?.getCell("B2").value).toBe(1);
    expect(wb.getWorksheet("สรุป")?.getCell("B3").value).toBe(1200);
    expect(wb.getWorksheet("รายการใช้งาน")?.getCell("H2").value).toBe(1200);
  });
});
