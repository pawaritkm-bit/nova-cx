import ExcelJS from "exceljs";
import { effectiveAiCost, type AiUsageRow } from "./usage-report";

const LABELS: Record<string, string> = {
  bill_classify: "คัดประเภทรูป/บิล", bill_extract: "อ่านข้อมูลบิล", bill_verify: "ตรวจทานบิลยาก",
  statement_extract: "อ่าน Statement", platform_report_extract: "อ่านรายงานแพลตฟอร์ม",
  id_card_extract: "อ่านบัตรประชาชน", document_purpose: "วิเคราะห์วัตถุประสงค์เอกสาร",
  finance_document_classify: "คัดประเภทเอกสารการเงิน", share_circle_classify: "คัดลิสต์วงแชร์",
};

export async function buildAiUsageWorkbook(rows: AiUsageRow[], from: string, to: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Nova CX";
  const summary = wb.addWorksheet("สรุป");
  const detail = wb.addWorksheet("รายการใช้งาน");
  const header = { font: { bold: true, color: { argb: "FFFFFFFF" } }, fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF24479B" } }, alignment: { vertical: "middle" as const } };

  summary.addRow(["รายงานการใช้ AI", `${from} ถึง ${to}`]);
  summary.getRow(1).font = { bold: true, size: 16, color: { argb: "FF24479B" } };
  summary.addRow(["จำนวนครั้ง", rows.length]);
  summary.addRow(["Token รวม", rows.reduce((s, r) => s + (r.total_tokens ?? 0), 0)]);
  summary.addRow(["ค่าใช้จ่ายโดยประมาณ (บาท)", rows.reduce((s, r) => s + effectiveAiCost(r).thb, 0)]);
  summary.addRow([]);
  summary.addRow(["ฟังก์ชัน", "จำนวนครั้ง", "Input Token", "Output Token", "Token รวม", "ประมาณ (USD)", "ประมาณ (บาท)"]);
  Object.assign(summary.getRow(6), header);
  const grouped = new Map<string, { calls: number; input: number; output: number; total: number; usd: number; thb: number }>();
  for (const r of rows) {
    const v = grouped.get(r.source) ?? { calls: 0, input: 0, output: 0, total: 0, usd: 0, thb: 0 };
    v.calls++; v.input += r.prompt_tokens ?? 0; v.output += r.output_tokens ?? 0; v.total += r.total_tokens ?? 0;
    const cost = effectiveAiCost(r); v.usd += cost.usd; v.thb += cost.thb; grouped.set(r.source, v);
  }
  for (const [source, v] of [...grouped].sort((a, b) => b[1].thb - a[1].thb)) summary.addRow([LABELS[source] ?? source, v.calls, v.input, v.output, v.total, v.usd, v.thb]);
  summary.columns = [{ width: 34 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 18 }];
  summary.getColumn(6).numFmt = "$#,##0.000000"; summary.getColumn(7).numFmt = "฿#,##0.0000"; summary.views = [{ state: "frozen", ySplit: 6 }];

  detail.addRow(["เวลา (ประเทศไทย)", "ฟังก์ชัน", "Provider", "โมเดล", "Input Token", "Output Token", "Thinking Token", "Token รวม", "ประมาณ (USD)", "ประมาณ (บาท)"]);
  Object.assign(detail.getRow(1), header);
  for (const r of rows) { const cost = effectiveAiCost(r); detail.addRow([new Date(new Date(r.created_at).getTime() + 7 * 3_600_000), LABELS[r.source] ?? r.source, r.provider, r.model, r.prompt_tokens, r.output_tokens, cost.thinking, r.total_tokens, cost.usd, cost.thb]); }
  detail.columns = [{ width: 22 }, { width: 32 }, { width: 14 }, { width: 24 }, { width: 15 }, { width: 15 }, { width: 16 }, { width: 15 }, { width: 16 }, { width: 18 }];
  detail.getColumn(1).numFmt = "yyyy-mm-dd hh:mm:ss"; detail.getColumn(9).numFmt = "$#,##0.000000"; detail.getColumn(10).numFmt = "฿#,##0.0000";
  detail.autoFilter = "A1:J1"; detail.views = [{ state: "frozen", ySplit: 1 }];
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
