import ExcelJS from "exceljs";
import type { AlbumProfile } from "@/lib/accounting/statement-album";
import type { StatementTxn } from "@/lib/accounting/statement-analyze";
import type { PlatformAlbumStore } from "@/lib/accounting/platform-album";
import { buildStatementAlbumWorkbook } from "@/lib/accounting/statement-album-excel";
import { appendPlatformAlbumSheets } from "@/lib/accounting/platform-album-excel";

export const PROSPECT_ANALYSIS_SUFFIX = "สรุปวิเคราะห์ก่อนเริ่มบริการ.xlsx";

export function prospectAnalysisXlsxName(customerName: string): string {
  const safe = (customerName || "ลูกค้า")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${safe} - ${PROSPECT_ANALYSIS_SUFFIX}`;
}

/**
 * Workbook เดียวของ NOVA-Bills: Statement + วิเคราะห์รายรับ/ภาษี + Platform
 * ใช้ชีตซ่อนเดิม (_data/_profile/_pdata) เพื่ออ่านกองกลับมา merge ไฟล์ใหม่โดยไม่อ่านไฟล์เก่าซ้ำ
 */
export async function buildProspectAnalysisWorkbook(input: {
  customerName: string;
  banks: Record<string, StatementTxn[]>;
  profile?: AlbumProfile;
  platformStore: PlatformAlbumStore;
}): Promise<Buffer> {
  const statement = await buildStatementAlbumWorkbook({
    customerName: input.customerName,
    banks: input.banks,
    profile: input.profile,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(statement as unknown as ArrayBuffer);
  appendPlatformAlbumSheets(
    wb,
    { customerName: input.customerName, store: input.platformStore },
    { summary: "สรุปแพลตฟอร์ม", monthly: "แพลตฟอร์มรายเดือน" }
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}
