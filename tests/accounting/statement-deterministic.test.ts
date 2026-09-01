import { describe, it, expect } from "vitest";
import { parseStatementDeterministic } from "@/lib/accounting/statement-deterministic";

/**
 * statement-deterministic — จุดที่เคยพังจริง (สเตทเมนต์ SCB ของลูกค้า 2026-09-01):
 *   หัวไฟล์พิมพ์ "ยอดยกมา (Balance Forward)\t285,353.06" — ป้ายอังกฤษยาว 21+ ตัวอักษร
 *   regex เดิมเผื่อช่องว่างแค่ 20 → หา opening ไม่เจอ → เสียแถวแรก (firstSkipped)
 *   → fullyReconciled=false ทั้งไฟล์ → ตกไป AI แล้วผู้ใช้เจอ "ไม่พบธุรกรรม"
 */

const HEAD =
  "รายการเดินบัญชีย้อนหลัง\nHistorical Statement\n" +
  "ชื่อบัญชี:\tบริษัท ทดสอบ จำกัด\tเลขที่บัญชี:\t123-456789-0\n" +
  "ธนาคารไทยพาณิชย์\n" +
  "วัน/เวลา\tรายการ\tช่องทาง\tยอดเงินหักบัญชี\tยอดเงินเข้าบัญชี\tยอดเงิน\tรายละเอียด\n";

describe("parseStatementDeterministic — opening balance 'ยอดยกมา (Balance Forward)'", () => {
  it("หัวแบบ SCB (มีวงเล็บอังกฤษคั่นก่อนตัวเลข) → เจอ opening + ไม่เสียแถวแรก + fullyReconciled", () => {
    const text =
      HEAD +
      "ยอดยกมา (Balance Forward)\t \t285,353.06\n" +
      "01/06/2026 10:00\tX1\tENET\t3,880.00\t289,233.06\tรับโอนจาก KBANK x7135\n" +
      "02/06/2026 11:00\tX1\tENET\t1,000.00\t288,233.06\tโอนเงินไป SCB x2333\n" +
      "03/06/2026 12:00\tX1\tENET\t500.00\t288,733.06\tรับโอนจาก BBL x9999\n";
    const det = parseStatementDeterministic(text);
    expect(det.transactions.length).toBe(3); // แถวแรกต้องไม่หาย
    expect(det.fullyReconciled).toBe(true);
    expect(det.transactions[0].direction).toBe("in");
    expect(det.transactions[0].amount).toBeCloseTo(3880, 2);
    expect(det.transactions[1].direction).toBe("out");
  });

  it("แถวแรกยอด 0 บาท (เช่น ONBOARDING JURISTIC) + ยอดยกมา 0.00 → ไม่ทำ reconcile ตกทั้งไฟล์", () => {
    const text =
      HEAD +
      "ยอดยกมา (Balance Forward)\t \t0.00\n" +
      "30/03/2026 14:10\tCO\tOBJU\t0.00\t0.00\tONBOARDING JURISTIC\n" +
      "01/04/2026 09:00\tX1\tENET\t5,000.00\t5,000.00\tรับโอนจาก KBANK x8610\n" +
      "02/04/2026 09:00\tX1\tENET\t2,000.00\t7,000.00\tรับโอนจาก KBANK x0742\n";
    const det = parseStatementDeterministic(text);
    expect(det.fullyReconciled).toBe(true);
    // แถว 0 บาทไม่เป็นธุรกรรม (Δbalance=0) — เหลือ 2 รายการจริง
    expect(det.transactions.length).toBe(2);
    expect(det.transactions[0].amount).toBeCloseTo(5000, 2);
  });

  it("หัวแบบเดิม 'ยอดยกมา 1,000.00' (ไม่มีคำอังกฤษ) → ยังใช้ได้เหมือนเดิม", () => {
    const text =
      HEAD +
      "ยอดยกมา 1,000.00\n" +
      "01/06/2026 10:00\tX1\tENET\t500.00\t1,500.00\tรับโอนจาก KBANK x1111\n" +
      "02/06/2026 11:00\tX1\tENET\t300.00\t1,200.00\tโอนเงินไป SCB x2222\n";
    const det = parseStatementDeterministic(text);
    expect(det.transactions.length).toBe(2);
    expect(det.fullyReconciled).toBe(true);
  });
});

/**
 * ชื่อผู้โอน + เวลาโอน (requirement 2026-09-01):
 *   "คู่ค้า ต้องเป็นชื่อผู้โอน จากใคร" — SCB พิมพ์ชื่อท้ายแถว "รับโอนจาก KBANK x7501 นาย จิรายุ ปราณี"
 *   และแถว 2 บรรทัดที่ pdf text merge กันต้องไม่ทำให้ชื่อคนแรกลากติดคำโอนของแถวถัดไป
 */
describe("parseStatementDeterministic — ชื่อผู้โอน + เวลาโอน", () => {
  it("ดึงชื่อผู้โอนท้ายแถว + เวลาโอน HH:MM", () => {
    const text =
      HEAD +
      "ยอดยกมา (Balance Forward)\t \t300,000.00\n" +
      "04/05/2026 12:51\tX1\tENET\t5,000.00\t305,000.00\tรับโอนจาก KBANK x7501 นาย จิรายุ ปราณี\n" +
      "05/05/2026 09:03\tX2\tBCMS\t2,400.00\t302,600.00\tโอนไป GSB x1369 นางสาว ธนัญญา แก้วแก้ว\n";
    const det = parseStatementDeterministic(text);
    expect(det.fullyReconciled).toBe(true);
    expect(det.transactions[0].counterparty_name).toBe("นาย จิรายุ ปราณี");
    expect(det.transactions[0].time).toBe("12:51");
    expect(det.transactions[0].description).toContain("นาย จิรายุ ปราณี");
    expect(det.transactions[1].counterparty_name).toBe("นางสาว ธนัญญา แก้วแก้ว");
    expect(det.transactions[1].direction).toBe("out");
  });

  it("แถวที่ merge ข้อความแถวถัดไปเข้ามา → ชื่อถูกตัดก่อนคำโอนถัดไป (ไม่ลากยาว)", () => {
    const text =
      HEAD +
      "ยอดยกมา (Balance Forward)\t \t100,000.00\n" +
      "01/05/2026 10:00\tX1\tENET\t1,000.00\t101,000.00\tรับโอนจาก GSB x4280 นางสาว อลิชา บุญยิ่ง รับโอนจาก KTB PATTARAWADEE\n" +
      "02/05/2026 11:00\tX1\tENET\t2,000.00\t103,000.00\tรับโอนจาก KTB x5555 PATTARAWADEE SUKJAI\n";
    const det = parseStatementDeterministic(text);
    expect(det.transactions[0].counterparty_name).toBe("นางสาว อลิชา บุญยิ่ง");
    expect(det.transactions[0].counterparty_name).not.toContain("รับโอน");
  });

  it("ค่าธรรมเนียมขาออก → description ขึ้นต้น 'ค่าธรรมเนียม' + ยังได้ชื่อผู้รับ", () => {
    const text =
      HEAD +
      "ยอดยกมา (Balance Forward)\t \t50,000.00\n" +
      "14/05/2026 21:40\tFE\tBCMS\t5.00\t49,995.00\tค่าธรรมเนียมโอนไป KBANK x8111 น.ส. กรรภิรมย์ ปัญญา\n";
    const det = parseStatementDeterministic(text);
    expect(det.transactions[0].description).toMatch(/^ค่าธรรมเนียม/);
    expect(det.transactions[0].counterparty_name).toBe("น.ส. กรรภิรมย์ ปัญญา");
  });

  it("แถวไม่มีคำ จาก/ไป (QR/เงินสด) → ชื่อ null ไม่พังอะไร", () => {
    const text =
      HEAD +
      "ยอดยกมา (Balance Forward)\t \t10,000.00\n" +
      "01/05/2026 08:00\tX1\tQRC\t900.00\t10,900.00\tรับเงินจากการขาย Thai QR\n";
    const det = parseStatementDeterministic(text);
    expect(det.transactions[0].counterparty_name).toBeNull();
    expect(det.transactions[0].time).toBe("08:00");
  });
});
