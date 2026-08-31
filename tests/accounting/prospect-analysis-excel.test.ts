import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildProspectAnalysisWorkbook,
  prospectAnalysisXlsxName,
} from "@/lib/accounting/prospect-analysis-excel";
import { readAlbumFromWorkbook } from "@/lib/accounting/statement-album-excel";
import { readPlatformAlbumFromWorkbook } from "@/lib/accounting/platform-album-excel";

describe("prospect analysis workbook", () => {
  it("รวม Statement และ Platform ใน Excel เดียวและอ่านกองกลับได้", async () => {
    const buf = await buildProspectAnalysisWorkbook({
      customerName: "ร้านทดสอบ",
      banks: {
        "KBANK #1234": [
          {
            date: "2026-08-01",
            description: "รับโอน",
            counterparty_name: "ลูกค้า A",
            counterparty_account_no: null,
            direction: "in",
            amount: 12500,
          },
        ],
      },
      platformStore: {
        v: 1,
        files: [
          {
            sig: "shopee|2026-08|1000|100|20|10",
            platform: "shopee",
            months: [
              { month: "2026-08", grossSales: 1000, platformFee: 100, shippingFee: 20, discount: 10 },
            ],
          },
        ],
      },
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.getWorksheet("รายละเอียดเงินเข้า")).toBeTruthy();
    expect(wb.getWorksheet("สรุปแพลตฟอร์ม")).toBeTruthy();
    expect(wb.getWorksheet("แพลตฟอร์มรายเดือน")).toBeTruthy();

    const statement = await readAlbumFromWorkbook(buf);
    const platform = await readPlatformAlbumFromWorkbook(buf);
    expect(statement.banks["KBANK #1234"]).toHaveLength(1);
    expect(platform.files).toHaveLength(1);
    expect(platform.files[0].platform).toBe("shopee");
  });

  it("sanitize ชื่อไฟล์และใช้ suffix คงที่", () => {
    expect(prospectAnalysisXlsxName("ร้าน A/B:*?")).toBe("ร้าน A B - สรุปวิเคราะห์ก่อนเริ่มบริการ.xlsx");
  });
});
