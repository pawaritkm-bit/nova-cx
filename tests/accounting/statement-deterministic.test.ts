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
