import { describe, it, expect } from "vitest";
import { suggestWhtRate, WHT_RATE_BY_ACCOUNT } from "@/lib/accounting/wht";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { TEST_CHART } from "@/tests/accounting/fixtures/chart";

const TEST_CHART_BY_CODE = buildChartByCode(TEST_CHART);

/**
 * suggestWhtRate — อัตรา WHT แนะนำตามประเภทบัญชี (ค่าแนะนำ ไม่ล็อก)
 *   จับเฉพาะบัญชีที่อัตรามาตรฐานชัด · ที่เหลือ 0 (ไม่เดา)
 */
describe("suggestWhtRate", () => {
  it("ค่าขนส่ง → 1%", () => {
    expect(suggestWhtRate("5341")).toBe(1); // ค่าขนส่ง
    expect(suggestWhtRate("5337")).toBe(1); // ค่าบริการค่าขนส่ง
    expect(suggestWhtRate("5010.3")).toBe(1); // ค่าขนส่งเมื่อซื้อ
  });

  it("ค่าโฆษณา → 2%", () => {
    expect(suggestWhtRate("5315")).toBe(2);
  });

  it("ค่าบริการ/ค่าจ้าง/ค่าซ่อม/ค่าธรรมเนียม → 3%", () => {
    expect(suggestWhtRate("5342")).toBe(3); // ค่าบริการ
    expect(suggestWhtRate("5343")).toBe(3); // ค่าบริการเครื่องถ่ายเอกสาร
    expect(suggestWhtRate("5344")).toBe(3); // ค่าบริการแพลตฟอร์ม
    expect(suggestWhtRate("5345")).toBe(3); // ค่าบำรุงรักษายานพาหนะ
    expect(suggestWhtRate("5352")).toBe(3); // ค่าซ่อมแซม
    expect(suggestWhtRate("5355")).toBe(3); // ค่าธรรมเนียมอื่น ๆ
  });

  it("บัญชีที่ไม่มี WHT มาตรฐาน → 0 (ไม่เดา)", () => {
    expect(suggestWhtRate("5340")).toBe(0); // ค่าน้ำมัน
    expect(suggestWhtRate("5010")).toBe(0); // ซื้อสินค้า
    expect(suggestWhtRate("5320")).toBe(0); // ค่าไฟฟ้า
    expect(suggestWhtRate("4010")).toBe(0); // ขายสินค้า (รายได้)
  });

  it("null/undefined/ว่าง/นอกผัง → 0", () => {
    expect(suggestWhtRate(null)).toBe(0);
    expect(suggestWhtRate(undefined)).toBe(0);
    expect(suggestWhtRate("")).toBe(0);
    expect(suggestWhtRate("9999")).toBe(0);
  });

  it("trim ช่องว่างรอบรหัสก่อน lookup", () => {
    expect(suggestWhtRate(" 5342 ")).toBe(3);
  });

  it("★ ทุกรหัสในตารางต้องมีอยู่จริงในผังบัญชีกลาง (กัน typo)", () => {
    for (const code of Object.keys(WHT_RATE_BY_ACCOUNT)) {
      expect(TEST_CHART_BY_CODE[code], `รหัส ${code} ต้องมีในผัง`).toBeDefined();
    }
  });
});
