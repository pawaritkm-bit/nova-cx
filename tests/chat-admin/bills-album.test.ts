import { describe, it, expect } from "vitest";
import {
  scopeBillsByAccess,
  safeAscii,
  dateStamp,
  fileExt,
  billDownloadName,
  zipName,
  withDownloadParam,
} from "@/lib/chat-audit/album";
import type { BillItem } from "@/lib/chat-audit/bills";

/** ตัวช่วยสร้าง BillItem แบบสั้น */
function bill(p: Partial<BillItem> & { id: string }): BillItem {
  return {
    id: p.id,
    objectPath: p.objectPath ?? `path/${p.id}.jpg`,
    billDate: p.billDate ?? "2026-07-31T10:00:00Z",
    customerId: p.customerId ?? null,
    customerCode: p.customerCode ?? null,
    customerName: p.customerName ?? null,
    docKind: p.docKind ?? null,
    attachmentType: p.attachmentType ?? "image",
    originalName: p.originalName ?? null,
  };
}

describe("scopeBillsByAccess", () => {
  const items = [
    bill({ id: "a", customerId: "c1" }),
    bill({ id: "b", customerId: "c2" }),
    bill({ id: "c", customerId: null }), // ยังไม่จับคู่
    bill({ id: "d", customerId: "c3" }),
  ];

  it("allowed=null (admin) → เห็นทุกบิล รวมบิลที่ยังไม่จับคู่", () => {
    const r = scopeBillsByAccess(items, null);
    expect(r.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("allowed=Set (นักบัญชี) → เฉพาะลูกค้าที่ดูแล (ไม่รวม unassigned/นอกสโคป)", () => {
    const r = scopeBillsByAccess(items, new Set(["c1", "c3"]));
    expect(r.map((x) => x.id)).toEqual(["a", "d"]);
  });

  it("allowed=Set ว่าง → ไม่เห็นบิลใดเลย", () => {
    expect(scopeBillsByAccess(items, new Set())).toEqual([]);
  });

  it("บิลที่ customerId=null ไม่ถูกดึงเข้าสโคปนักบัญชี", () => {
    const r = scopeBillsByAccess([bill({ id: "x", customerId: null })], new Set(["c1"]));
    expect(r).toEqual([]);
  });
});

describe("safeAscii", () => {
  it("เก็บเฉพาะ a-z A-Z 0-9 . _ - ", () => {
    expect(safeAscii("N151", "NA")).toBe("N151");
    expect(safeAscii("A-b_c.1", "NA")).toBe("A-b_c.1");
  });
  it("ตัดอักขระไทย/ช่องว่าง/อักขระพิเศษออก (กัน PDPA/เพี้ยน)", () => {
    expect(safeAscii("เตี๋ยวเนื้อ", "NA")).toBe("NA"); // เหลือว่าง → fallback
    expect(safeAscii("N151 ร้านเอ", "NA")).toBe("N151"); // ตัดชื่อไทย/ช่องว่างทิ้ง
    expect(safeAscii("a/b\\c:d", "NA")).toBe("abcd");
  });
  it("ว่าง/null → fallback", () => {
    expect(safeAscii("", "NA")).toBe("NA");
    expect(safeAscii(null, "NA")).toBe("NA");
    expect(safeAscii(undefined, "NA")).toBe("NA");
  });
});

describe("dateStamp", () => {
  it("ISO → YYYY-MM-DD (UTC)", () => {
    expect(dateStamp("2026-07-31T23:00:00Z")).toBe("2026-07-31");
    expect(dateStamp("2026-01-05T00:00:00Z")).toBe("2026-01-05");
  });
  it("parse ไม่ได้/ว่าง → nodate", () => {
    expect(dateStamp("ไม่ใช่วันที่")).toBe("nodate");
    expect(dateStamp(null)).toBe("nodate");
    expect(dateStamp(undefined)).toBe("nodate");
  });
});

describe("fileExt", () => {
  it("เดานามสกุลจาก original_name ก่อน", () => {
    expect(fileExt("ใบกำกับ.PDF", "path/x", false)).toBe("pdf");
    expect(fileExt("bill.png", null, true)).toBe("png");
  });
  it("ไม่มีชื่อ → ใช้ objectPath", () => {
    expect(fileExt(null, "tenant/abc.jpeg", true)).toBe("jpeg");
  });
  it("หานามสกุลไม่ได้ → รูป=jpg / ไฟล์=bin", () => {
    expect(fileExt(null, "noext", true)).toBe("jpg");
    expect(fileExt(null, "noext", false)).toBe("bin");
  });
});

describe("billDownloadName", () => {
  it("รูปแบบ {code}_{YYYY-MM-DD}_{NN}.{ext} (ASCII ล้วน)", () => {
    expect(billDownloadName("N151", "2026-07-31T10:00:00Z", 1, "jpg")).toBe("N151_2026-07-31_01.jpg");
    expect(billDownloadName("N088", "2026-07-05T00:00:00Z", 12, "png")).toBe("N088_2026-07-05_12.png");
  });
  it("ไม่มีรหัส/รหัสไทย → NA (ไม่หลุดชื่อลูกค้า)", () => {
    expect(billDownloadName(null, "2026-07-31T10:00:00Z", 3, "jpg")).toBe("NA_2026-07-31_03.jpg");
    expect(billDownloadName("ร้านเอ", "2026-07-31T10:00:00Z", 3, "jpg")).toBe("NA_2026-07-31_03.jpg");
  });
  it("idx เติม 0 เป็น 2 หลัก + อย่างน้อย 1", () => {
    expect(billDownloadName("N1", "2026-07-31T10:00:00Z", 0, "jpg")).toBe("N1_2026-07-31_01.jpg");
    expect(billDownloadName("N1", "2026-07-31T10:00:00Z", 105, "jpg")).toBe("N1_2026-07-31_105.jpg");
  });
});

describe("zipName", () => {
  it("{code}_bills.zip", () => {
    expect(zipName("N151")).toBe("N151_bills.zip");
    expect(zipName(null)).toBe("NA_bills.zip");
    expect(zipName("ไทย")).toBe("NA_bills.zip");
  });
});

describe("withDownloadParam", () => {
  it("ต่อ &download= เมื่อ URL มี query แล้ว (signed URL)", () => {
    expect(withDownloadParam("https://x/y?token=abc", "N151_2026-07-31_01.jpg")).toBe(
      "https://x/y?token=abc&download=N151_2026-07-31_01.jpg"
    );
  });
  it("ต่อ ?download= เมื่อ URL ยังไม่มี query", () => {
    expect(withDownloadParam("https://x/y", "a.jpg")).toBe("https://x/y?download=a.jpg");
  });
  it("encode ชื่อไฟล์ (กันอักขระพิเศษ)", () => {
    expect(withDownloadParam("https://x?t=1", "a b.jpg")).toBe("https://x?t=1&download=a%20b.jpg");
  });
});
