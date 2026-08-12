/**
 * สร้าง input ของ manual JE (draft เสมอ) จากสรุปรายงานแพลตฟอร์ม — pure mapper (ไม่แตะ DB/network)
 *
 * บริบท: ข้อ C ต่อเนื่อง — "auto-สร้างสมุดรายวัน/รายการบัญชีจากข้อมูลที่อ่านได้" (ยืนยันกับผู้ใช้แล้วว่า
 *   ต้องเป็นดราฟต์เสมอ รอนักบัญชีกดยืนยันเองผ่านหน้าสมุดรายวันที่มีอยู่แล้ว — ไม่ auto-confirm)
 *
 * โครง JE: Cr ยอดขาย (grossSales+otherCredit) = Dr ค่าใช้จ่ายแต่ละประเภท (ตาม settings) + Dr/Cr
 *   บัญชีเงินที่ได้รับจริง (clearing) ด้วยยอดสุทธิ — สมดุลเสมอโดยโครงสร้าง (พิสูจน์ทางคณิตศาสตร์:
 *   netAmount = grossSales+otherCredit−totalDeductions ดังนั้น totalDeductions+netAmount = grossSales+otherCredit
 *   เสมอ ไม่ว่า netAmount จะเป็นบวกหรือลบ) — ยังส่งเข้า validateManualEntryInput ซ้ำที่ชั้น action อยู่ดี
 *   (defense-in-depth เดียวกับทั้งระบบ ไม่เชื่อผลจาก pure function ฝั่งนี้อย่างเดียว)
 *
 * ★ รวมยอดต่อรหัสบัญชีก่อนสร้างบรรทัด (เผื่อผู้ใช้ตั้งค่าหลายประเภทไปที่บัญชีเดียวกัน — เช่น
 *   refund/sales ชี้ไปบัญชีเดียวกันเป็นค่า default เพื่อให้เป็น contra-revenue ที่ถูกต้อง) — ถ้ารหัสบัญชี
 *   เดียวกันโผล่ทั้งสองฝั่ง (เดบิต+เครดิต) จะหักลบกันเหลือฝั่งเดียวเสมอ (ตรงตามกฎ validateManualEntryInput
 *   ที่ห้ามบรรทัดมีทั้งสองฝั่ง)
 */
import { round2 } from "@/lib/accounting/queries";
import { EPSILON } from "@/lib/accounting/statement-config";
import type { PlatformReportSummary } from "@/lib/accounting/platform-report-analyze";
import { accountCodeForDeductionCategory, type PlatformReportSettings } from "@/lib/accounting/platform-report-settings";
import type { ManualEntryInput, ManualEntryLineInput } from "@/lib/accounting/manual-journal";

export type BuildPlatformReportJeResult = { ok: true; value: ManualEntryInput } | { ok: false; message: string };

/**
 * @param docDate 'YYYY-MM-DD' — วันที่เอกสาร (ผู้เรียกเป็นคนกำหนด เช่น วันที่ล่าสุดของไฟล์ หรือวันนี้)
 */
export function buildPlatformReportJournalEntryInput(
  summary: PlatformReportSummary,
  settings: PlatformReportSettings,
  docDate: string,
  memo?: string | null
): BuildPlatformReportJeResult {
  if (summary.count === 0) {
    return { ok: false, message: "ไม่มีรายการให้สร้างสมุดรายวัน" };
  }

  const debitByCode = new Map<string, number>();
  const creditByCode = new Map<string, number>();

  function addCredit(code: string, amount: number): void {
    if (amount <= EPSILON) return;
    creditByCode.set(code, round2((creditByCode.get(code) ?? 0) + amount));
  }
  function addDebit(code: string, amount: number): void {
    if (amount <= EPSILON) return;
    debitByCode.set(code, round2((debitByCode.get(code) ?? 0) + amount));
  }

  addCredit(settings.salesAccountCode, summary.grossSales + summary.otherCredit);
  for (const d of summary.deductions) {
    addDebit(accountCodeForDeductionCategory(settings, d.category), d.total);
  }

  const net = round2(summary.grossSales + summary.otherCredit - summary.totalDeductions);
  if (net >= EPSILON) addDebit(settings.clearingAccountCode, net);
  else if (net <= -EPSILON) addCredit(settings.clearingAccountCode, -net);

  // ยุบรวมรหัสบัญชีเดียวกันที่โผล่ทั้งสองฝั่ง (เดบิต−เครดิต) ให้เหลือฝั่งเดียวต่อบรรทัด
  const allCodes = new Set([...debitByCode.keys(), ...creditByCode.keys()]);
  const lines: ManualEntryLineInput[] = [];
  for (const code of allCodes) {
    const netAtCode = round2((debitByCode.get(code) ?? 0) - (creditByCode.get(code) ?? 0));
    if (Math.abs(netAtCode) < EPSILON) continue; // หักลบกันหมดพอดี ไม่ต้องมีบรรทัดนี้
    lines.push({
      accountCode: code,
      debit: netAtCode > 0 ? netAtCode : 0,
      credit: netAtCode < 0 ? -netAtCode : 0,
    });
  }

  if (lines.length < 2) {
    return { ok: false, message: "ยอดสุทธิเป็น 0 หรือไม่พอสร้างสมุดรายวัน (ต้องมีอย่างน้อย 2 บรรทัดที่มียอด)" };
  }

  return {
    ok: true,
    value: {
      docType: "JV",
      docDate,
      docNo: null,
      memo: memo ?? "สร้างจากรายงานแพลตฟอร์ม (AI แยกรายการ) — ดราฟต์ ตรวจสอบก่อนยืนยัน",
      lines,
    },
  };
}
