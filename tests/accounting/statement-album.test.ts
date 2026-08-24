import { describe, it, expect } from "vitest";
import {
  txnKey,
  mergeIntoBank,
  emptyAlbum,
  parseAlbumStore,
  serializeAlbumStore,
  albumStoreName,
  albumXlsxName,
  UNKNOWN_BANK,
} from "@/lib/accounting/statement-album";
import { buildStatementAlbumWorkbook } from "@/lib/accounting/statement-album-excel";
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
});
