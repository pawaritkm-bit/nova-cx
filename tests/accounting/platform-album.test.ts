import { describe, it, expect } from "vitest";
import {
  toPlatformRecord,
  mergePlatformFile,
  emptyPlatformAlbum,
  byPlatform,
  byMonth,
  grandTotals,
  netOf,
} from "@/lib/accounting/platform-album";
import { buildPlatformAlbumWorkbook, readPlatformAlbumFromWorkbook } from "@/lib/accounting/platform-album-excel";

describe("platform-album — สะสม/dedup/สรุป", () => {
  it("netOf = ยอดขาย − ค่าธรรมเนียม − ขนส่ง − ส่วนลด", () => {
    expect(netOf({ grossSales: 1000, platformFee: 100, shippingFee: 50, discount: 20 })).toBe(830);
  });

  it("mergePlatformFile dedup ด้วย sig (ไฟล์เดิมส่งซ้ำ → added=false)", () => {
    let store = emptyPlatformAlbum();
    const rec = toPlatformRecord("shopee", { grossSales: 1000, platformFee: 100, shippingFee: 50, discount: 20 });
    const r1 = mergePlatformFile(store, rec);
    expect(r1.added).toBe(true);
    store = r1.store;
    const r2 = mergePlatformFile(store, toPlatformRecord("shopee", { grossSales: 1000, platformFee: 100, shippingFee: 50, discount: 20 }));
    expect(r2.added).toBe(false); // sig เดิม
    expect(r2.store.files).toHaveLength(1);
  });

  it("byPlatform — รวมต่อแพลตฟอร์ม + net", () => {
    let store = emptyPlatformAlbum();
    store = mergePlatformFile(store, toPlatformRecord("shopee", { grossSales: 1000, platformFee: 100, shippingFee: 0, discount: 0 })).store;
    store = mergePlatformFile(store, toPlatformRecord("lazada", { grossSales: 500, platformFee: 50, shippingFee: 0, discount: 0 })).store;
    const bp = byPlatform(store);
    expect(bp.map((x) => x.platform)).toEqual(["lazada", "shopee"]);
    expect(bp.find((x) => x.platform === "shopee")!.totals.net).toBe(900);
    expect(grandTotals(store).grossSales).toBe(1500);
    expect(grandTotals(store).net).toBe(1350);
  });

  it("byMonth — รวมรายเดือน (จาก figures.monthly)", () => {
    const rec = toPlatformRecord("shopee", {
      grossSales: 300, platformFee: 30, shippingFee: 0, discount: 0,
      monthly: [
        { month: "2026-01", grossSales: 100, platformFee: 10, shippingFee: 0, discount: 0 },
        { month: "2026-02", grossSales: 200, platformFee: 20, shippingFee: 0, discount: 0 },
      ],
    });
    const store = mergePlatformFile(emptyPlatformAlbum(), rec).store;
    const bm = byMonth(store);
    expect(bm.map((x) => x.month)).toEqual(["2026-01", "2026-02"]);
    expect(bm[1].totals.grossSales).toBe(200);
  });

  it("round-trip build → read (_pdata) คงกอง", async () => {
    let store = emptyPlatformAlbum();
    store = mergePlatformFile(store, toPlatformRecord("tiktok", { grossSales: 800, platformFee: 80, shippingFee: 10, discount: 5 })).store;
    const buf = await buildPlatformAlbumWorkbook({ customerName: "ร้านทดสอบ", store });
    const back = await readPlatformAlbumFromWorkbook(buf);
    expect(back.files).toHaveLength(1);
    expect(grandTotals(back).grossSales).toBe(800);
    // dedup ยังทำงานหลัง round-trip (sig เดิม)
    expect(mergePlatformFile(back, toPlatformRecord("tiktok", { grossSales: 800, platformFee: 80, shippingFee: 10, discount: 5 })).added).toBe(false);
  });
});
