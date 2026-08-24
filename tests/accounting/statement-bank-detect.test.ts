import { describe, it, expect } from "vitest";
import { normalizeBankName } from "@/lib/accounting/statement-extract";

describe("normalizeBankName", () => {
  it("map ชื่อ/ตัวย่อ → ป้ายมาตรฐาน", () => {
    expect(normalizeBankName("KBANK")).toBe("กสิกรไทย");
    expect(normalizeBankName("ธนาคารกสิกรไทย จำกัด (มหาชน)")).toBe("กสิกรไทย");
    expect(normalizeBankName("SCB")).toBe("ไทยพาณิชย์");
    expect(normalizeBankName("Bangkok Bank")).toBe("กรุงเทพ");
    expect(normalizeBankName("KKP")).toBe("เกียรตินาคินภัทร");
    expect(normalizeBankName("ttb")).toBe("ทหารไทยธนชาต");
  });

  it("null/ไม่ระบุ/ค่าว่าง → null (ลงชีตไม่ระบุธนาคาร)", () => {
    expect(normalizeBankName(null)).toBeNull();
    expect(normalizeBankName("")).toBeNull();
    expect(normalizeBankName("null")).toBeNull();
    expect(normalizeBankName("ไม่ทราบ")).toBeNull();
    expect(normalizeBankName("-")).toBeNull();
  });

  it("ธนาคารไม่รู้จัก → ตัดคำ 'ธนาคาร/bank/จำกัด/มหาชน' ออก คืนที่อ่านได้", () => {
    expect(normalizeBankName("ธนาคารแลนด์ แอนด์ เฮ้าส์")).toBe("แลนด์ แอนด์ เฮ้าส์");
  });
});
