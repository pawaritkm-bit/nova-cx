import { describe, it, expect } from "vitest";
import {
  txnKey,
  mergeIntoBank,
  mergeProfile,
  emptyAlbum,
  parseAlbumStore,
  serializeAlbumStore,
  albumStoreName,
  albumXlsxName,
  UNKNOWN_BANK,
} from "@/lib/accounting/statement-album";
import { buildStatementAlbumWorkbook, readAlbumFromWorkbook, monthlyAgg, partyAgg, totalsOf } from "@/lib/accounting/statement-album-excel";
import type { StatementTxn } from "@/lib/accounting/statement-analyze";

function tx(over: Partial<StatementTxn> = {}): StatementTxn {
  return {
    date: "2026-08-01",
    description: "โอนเงิน",
    counterparty_name: "นายสมชาย",
    counterparty_account_no: null,
    direction: "in",
    amount: 1000,
    ...over,
  } as StatementTxn;
}

describe("txnKey + mergeIntoBank (dedup ต่อธนาคาร กันไฟล์ซ้ำ)", () => {
  it("รายการเหมือนกันเป๊ะ → คีย์เท่ากัน · ยอด/ทิศทางต่าง → คีย์ต่าง", () => {
    expect(txnKey(tx())).toBe(txnKey(tx()));
    expect(txnKey(tx({ amount: 1000 }))).not.toBe(txnKey(tx({ amount: 2000 })));
    expect(txnKey(tx({ direction: "in" }))).not.toBe(txnKey(tx({ direction: "out" })));
  });

  it("ไฟล์ซ้ำ (รายการเดิม) → added=0, กองไม่โต", () => {
    let store = emptyAlbum();
    store = mergeIntoBank(store, "กสิกร", [tx({ amount: 100 }), tx({ amount: 200 })]).store;
    const r = mergeIntoBank(store, "กสิกร", [tx({ amount: 100 }), tx({ amount: 200 })]);
    expect(r.added).toBe(0);
    expect(r.store.banks["กสิกร"]).toHaveLength(2);
  });

  it("แยกธนาคาร → คนละกอง (ลูกค้าหลายแบงก์)", () => {
    let store = emptyAlbum();
    store = mergeIntoBank(store, "กสิกร", [tx({ amount: 100 })]).store;
    store = mergeIntoBank(store, "ไทยพาณิชย์", [tx({ amount: 100 })]).store; // ยอดเท่ากันแต่คนละแบงก์ = ไม่ dedup ข้ามแบงก์
    expect(Object.keys(store.banks).sort()).toEqual(["กสิกร", "ไทยพาณิชย์"]);
    expect(store.banks["กสิกร"]).toHaveLength(1);
    expect(store.banks["ไทยพาณิชย์"]).toHaveLength(1);
  });

  it("bankLabel ว่าง → ลงกอง UNKNOWN_BANK", () => {
    const { store } = mergeIntoBank(emptyAlbum(), null, [tx()]);
    expect(store.banks[UNKNOWN_BANK]).toHaveLength(1);
  });

  it("สะสมหลายไฟล์ต่อเนื่อง → ครบไม่ซ้ำ", () => {
    let store = emptyAlbum();
    store = mergeIntoBank(store, "กสิกร", [tx({ amount: 1 }), tx({ amount: 2 })]).store;
    store = mergeIntoBank(store, "กสิกร", [tx({ amount: 2 }), tx({ amount: 3 })]).store;
    expect(store.banks["กสิกร"].map((t) => t.amount).sort()).toEqual([1, 2, 3]);
  });
});

describe("serialize/parse store (JSON round-trip)", () => {
  it("round-trip คงค่า", () => {
    const store = mergeIntoBank(emptyAlbum(), "กสิกร", [tx({ amount: 100 })]).store;
    expect(parseAlbumStore(serializeAlbumStore(store))).toEqual(store);
  });
  it("null/พัง → store ว่าง", () => {
    expect(parseAlbumStore(null)).toEqual(emptyAlbum());
    expect(parseAlbumStore(Buffer.from("ไม่ใช่ json", "utf8"))).toEqual(emptyAlbum());
  });
});

describe("ชื่อไฟล์", () => {
  it("store คงที่ (ทับไฟล์เดิม = สะสม)", () => {
    expect(albumStoreName).toBe("statement-banks.json");
  });
  it("xlsx 1 ไฟล์/ลูกค้า · sanitize อักขระต้องห้าม", () => {
    expect(albumXlsxName("ร้าน A/B")).toBe("ร้าน A B - สรุปสเตทเมนต์.xlsx");
  });
});

describe("buildStatementAlbumWorkbook", () => {
  it("สร้าง xlsx ได้ (มีชีตสรุป + ชีตต่อธนาคาร) ไม่ throw", async () => {
    const buf = await buildStatementAlbumWorkbook({
      customerName: "ทดสอบ",
      banks: {
        กสิกร: [tx({ amount: 100, direction: "in" }), tx({ amount: 40, direction: "out" })],
        ไทยพาณิชย์: [tx({ amount: 200, direction: "in" })],
      },
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it("ไม่มีธนาคาร (ว่าง) → ยังสร้างไฟล์ได้ (ชีตสรุปอย่างเดียว)", async () => {
    const buf = await buildStatementAlbumWorkbook({ customerName: "ว่าง", banks: {} });
    expect(buf.length).toBeGreaterThan(0);
  });

  it("★ round-trip: build → readAlbumFromWorkbook (ชีตซ่อน _data) คืนกองเดิม (ไม่ต้องมี sidecar)", async () => {
    const banks = {
      กสิกรไทย: [tx({ amount: 100, direction: "in", date: "2026-08-01", description: "รับโอน", counterparty_name: "เอ" })],
      ไทยพาณิชย์: [tx({ amount: 40, direction: "out", date: "2026-08-02" }), tx({ amount: 200, direction: "in", date: "2026-08-03" })],
    };
    const buf = await buildStatementAlbumWorkbook({ customerName: "ทดสอบ", banks });
    const store = await readAlbumFromWorkbook(buf);
    expect(Object.keys(store.banks).sort()).toEqual(["กสิกรไทย", "ไทยพาณิชย์"]);
    expect(store.banks["กสิกรไทย"]).toHaveLength(1);
    expect(store.banks["ไทยพาณิชย์"]).toHaveLength(2);
    expect(store.banks["กสิกรไทย"][0]).toMatchObject({ amount: 100, direction: "in", date: "2026-08-01", counterparty_name: "เอ" });
  });

  it("readAlbumFromWorkbook(null) / ไฟล์ไม่มี _data → กองว่าง", async () => {
    expect((await readAlbumFromWorkbook(null)).banks).toEqual({});
  });

  it("round-trip เก็บเลขบัญชีคู่ค้า (account_no) ด้วย", async () => {
    const banks = { กสิกรไทย: [tx({ amount: 100, direction: "in", counterparty_account_no: "004-123" })] };
    const store = await readAlbumFromWorkbook(await buildStatementAlbumWorkbook({ customerName: "x", banks }));
    expect(store.banks["กสิกรไทย"][0].counterparty_account_no).toBe("004-123");
  });

  it("round-trip เก็บโปรไฟล์ KYC (บัตร ปชช.) ในชีตซ่อน _profile", async () => {
    const profile = { name: "น.ส.พรกนก อยู่ไทย", idNo: "1709700228659", address: "142 ต.ป่าซาง", laserCode: "JC4195837718" };
    const buf = await buildStatementAlbumWorkbook({ customerName: profile.name, banks: { กสิกรไทย: [tx({ amount: 100, direction: "in" })] }, profile });
    const store = await readAlbumFromWorkbook(buf);
    expect(store.profile).toMatchObject({ name: "น.ส.พรกนก อยู่ไทย", idNo: "1709700228659", laserCode: "JC4195837718" });
  });
});

describe("mergeProfile", () => {
  it("เติมเฉพาะช่องที่มีค่าใหม่ ไม่ลบของเดิม · คืน added ถูก", () => {
    const base = emptyAlbum();
    const r1 = mergeProfile(base, { name: "นายเอ", idNo: "1111111111111" });
    expect(r1.added).toBe(true);
    expect(r1.store.profile).toMatchObject({ name: "นายเอ", idNo: "1111111111111" });
    const r2 = mergeProfile(r1.store, { name: "นายเอ" }); // เหมือนเดิม
    expect(r2.added).toBe(false);
    const r3 = mergeProfile(r1.store, { address: "กทม" }); // เพิ่มช่องใหม่
    expect(r3.added).toBe(true);
    expect(r3.store.profile).toMatchObject({ name: "นายเอ", address: "กทม" });
  });
  it("profile null → ไม่เปลี่ยน", () => {
    expect(mergeProfile(emptyAlbum(), null).added).toBe(false);
  });
});

describe("monthlyAgg / partyAgg / totalsOf", () => {
  const txns: StatementTxn[] = [
    tx({ date: "2026-01-05", direction: "in", amount: 100, counterparty_name: "เอ" }),
    tx({ date: "2026-01-20", direction: "in", amount: 200, counterparty_name: "เอ" }),
    tx({ date: "2026-02-03", direction: "in", amount: 50, counterparty_name: "บี" }),
    tx({ date: "2026-01-10", direction: "out", amount: 30, counterparty_name: "ร้านซี" }),
  ];

  it("monthlyAgg — รวมรายเดือนเฉพาะทิศทาง เรียงเก่า→ใหม่ + label ไทย", () => {
    const inM = monthlyAgg(txns, "in");
    expect(inM.map((m) => m.key)).toEqual(["2026-01", "2026-02"]);
    expect(inM[0]).toMatchObject({ label: "มกราคม 2026", count: 2, amount: 300 });
    expect(inM[1]).toMatchObject({ count: 1, amount: 50 });
    expect(monthlyAgg(txns, "out")).toHaveLength(1);
  });

  it("partyAgg — กอง ≥2 ครั้ง เรียงยอดมาก→น้อย + others สำหรับ <2", () => {
    const { groups, others } = partyAgg(txns, "in");
    expect(groups).toHaveLength(1); // เอา 2 ครั้ง
    expect(groups[0]).toMatchObject({ party: "เอ", count: 2, amount: 300 });
    expect(others).toMatchObject({ count: 1, amount: 50 }); // บี 1 ครั้ง
  });

  it("totalsOf — นับ+รวมยอดตามทิศทาง", () => {
    expect(totalsOf(txns, "in")).toEqual({ count: 3, amount: 350 });
    expect(totalsOf(txns, "out")).toEqual({ count: 1, amount: 30 });
  });
});
