import { describe, it, expect } from "vitest";
import {
  sessionDateKey,
  txnKey,
  mergeTxns,
  serializeAlbum,
  parseAlbum,
  albumJsonName,
  albumCsvName,
} from "@/lib/accounting/statement-album";
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

describe("sessionDateKey", () => {
  it("ดึงวันที่ (YYYY-MM-DD) จาก sent_at ISO", () => {
    expect(sessionDateKey("2026-08-24T09:21:00+07:00")).toBe("2026-08-24");
    expect(sessionDateKey("2026-08-24 09:21:00")).toBe("2026-08-24");
  });
  it("รูปที่ส่งวันเดียวกัน (เวลาต่างกัน) → คีย์เดียวกัน (ชุดเดียว)", () => {
    expect(sessionDateKey("2026-08-24T09:00:00Z")).toBe(sessionDateKey("2026-08-24T09:08:00Z"));
  });
  it("ว่าง/พัง → unknown", () => {
    expect(sessionDateKey(null)).toBe("unknown");
    expect(sessionDateKey("ไม่ใช่วันที่")).toBe("unknown");
  });
});

describe("txnKey + mergeTxns (dedup กันรูปซ้ำ)", () => {
  it("รายการเหมือนกันเป๊ะ → คีย์เท่ากัน", () => {
    expect(txnKey(tx())).toBe(txnKey(tx()));
  });
  it("ยอด/ทิศทางต่าง → คีย์ต่าง (ไม่ตัดรายการจริง)", () => {
    expect(txnKey(tx({ amount: 1000 }))).not.toBe(txnKey(tx({ amount: 2000 })));
    expect(txnKey(tx({ direction: "in" }))).not.toBe(txnKey(tx({ direction: "out" })));
  });

  it("รูปซ้ำ (รายการเดิมทั้งชุด) → added=0, กองไม่โต", () => {
    const a = [tx({ amount: 100 }), tx({ amount: 200 })];
    const { merged, added } = mergeTxns(a, [tx({ amount: 100 }), tx({ amount: 200 })]);
    expect(added).toBe(0);
    expect(merged).toHaveLength(2);
  });

  it("รูปใหม่มีรายการใหม่บางส่วน → เพิ่มเฉพาะที่ใหม่", () => {
    const a = [tx({ amount: 100 })];
    const { merged, added } = mergeTxns(a, [tx({ amount: 100 }), tx({ amount: 300 })]);
    expect(added).toBe(1);
    expect(merged).toHaveLength(2);
  });

  it("รวมหลายรูปสะสมต่อเนื่อง → ครบทุกรายการไม่ซ้ำ", () => {
    let acc: StatementTxn[] = [];
    acc = mergeTxns(acc, [tx({ amount: 1 }), tx({ amount: 2 })]).merged; // รูป 1
    acc = mergeTxns(acc, [tx({ amount: 2 }), tx({ amount: 3 })]).merged; // รูป 2 (มีซ้ำ 2)
    acc = mergeTxns(acc, [tx({ amount: 1 })]).merged; // รูป 3 (ซ้ำ)
    expect(acc.map((t) => t.amount).sort()).toEqual([1, 2, 3]);
  });
});

describe("serialize/parse album (JSON round-trip)", () => {
  it("round-trip คงค่า", () => {
    const txns = [tx({ amount: 100 }), tx({ amount: 200, direction: "out" })];
    expect(parseAlbum(serializeAlbum(txns))).toEqual(txns);
  });
  it("null/buffer พัง → [] (เริ่มกองใหม่ ไม่ throw)", () => {
    expect(parseAlbum(null)).toEqual([]);
    expect(parseAlbum(Buffer.from("ไม่ใช่ json", "utf8"))).toEqual([]);
  });
});

describe("ชื่อไฟล์", () => {
  it("json ชื่อสม่ำเสมอตามวัน (ทับไฟล์เดิม = สะสม)", () => {
    expect(albumJsonName("2026-08-24")).toBe("statement-2026-08-24.json");
  });
  it("csv สรุปไฟล์เดียวต่อวัน", () => {
    expect(albumCsvName("2026-08-24")).toBe("สเตทเมนต์รวม 2026-08-24.csv");
  });
});
