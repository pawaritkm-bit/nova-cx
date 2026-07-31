import { describe, it, expect } from "vitest";
import {
  computeBillStats,
  filterBills,
  groupBillsByCustomer,
  paginate,
  monthKeyOf,
  currentMonthKey,
  isValidMonth,
  isDocKind,
  normalizeDocKind,
  UNASSIGNED_CUSTOMER,
  type BillItem,
} from "@/lib/chat-audit/bills";

/** ตัวช่วยสร้าง BillItem แบบสั้น */
function bill(p: Partial<BillItem> & { id: string; billDate: string }): BillItem {
  return {
    id: p.id,
    objectPath: p.objectPath ?? `path/${p.id}.jpg`,
    billDate: p.billDate,
    customerId: p.customerId ?? null,
    customerCode: p.customerCode ?? null,
    customerName: p.customerName ?? null,
    docKind: p.docKind ?? null,
  };
}

const NOW = new Date("2026-07-15T00:00:00Z");

describe("monthKeyOf / currentMonthKey / isValidMonth", () => {
  it("monthKeyOf คืน YYYY-MM (UTC)", () => {
    expect(monthKeyOf("2026-07-15T10:00:00Z")).toBe("2026-07");
    expect(monthKeyOf("2026-01-01T00:00:00Z")).toBe("2026-01");
  });
  it("monthKeyOf คืน null เมื่อ parse ไม่ได้/ว่าง", () => {
    expect(monthKeyOf("ไม่ใช่วันที่")).toBeNull();
    expect(monthKeyOf(null)).toBeNull();
    expect(monthKeyOf(undefined)).toBeNull();
  });
  it("currentMonthKey อิงวันที่ที่ส่งเข้ามา", () => {
    expect(currentMonthKey(NOW)).toBe("2026-07");
  });
  it("isValidMonth รับเฉพาะ YYYY-MM ที่ถูกต้อง", () => {
    expect(isValidMonth("2026-07")).toBe(true);
    expect(isValidMonth("2026-13")).toBe(false);
    expect(isValidMonth("2026-00")).toBe(false);
    expect(isValidMonth("2026-7")).toBe(false);
    expect(isValidMonth("")).toBe(false);
    expect(isValidMonth(null)).toBe(false);
  });
});

describe("computeBillStats", () => {
  const items: BillItem[] = [
    bill({ id: "a", billDate: "2026-07-10T00:00:00Z", customerId: "c1", customerCode: "N003", customerName: "เอ" }),
    bill({ id: "b", billDate: "2026-07-20T00:00:00Z", customerId: "c1", customerCode: "N003", customerName: "เอ" }),
    bill({ id: "c", billDate: "2026-06-05T00:00:00Z", customerId: "c2", customerCode: "N026", customerName: "บี" }),
    bill({ id: "d", billDate: "2026-05-01T00:00:00Z", customerId: null }), // ยังไม่จับคู่
  ];

  it("นับ total / customerCount / thisMonth ถูกต้อง (customer_id null ไม่นับเป็นลูกค้า)", () => {
    const s = computeBillStats(items, NOW);
    expect(s.total).toBe(4);
    expect(s.customerCount).toBe(2); // c1, c2 (null ไม่นับ)
    expect(s.thisMonth).toBe(2); // เดือน 2026-07 = a,b
  });

  it("customerOptions รวมจำนวนบิลต่อลูกค้า + เรียงตามรหัส natural", () => {
    const s = computeBillStats(items, NOW);
    expect(s.customerOptions.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(s.customerOptions[0].count).toBe(2);
    expect(s.customerOptions[1].count).toBe(1);
  });

  it("monthOptions เรียงใหม่→เก่า และไม่ซ้ำ", () => {
    const s = computeBillStats(items, NOW);
    expect(s.monthOptions).toEqual(["2026-07", "2026-06", "2026-05"]);
  });

  it("ลูกค้าไม่มีรหัสไปท้ายสุด (เรียงตามชื่อไทย)", () => {
    const s = computeBillStats(
      [
        bill({ id: "x", billDate: "2026-07-01T00:00:00Z", customerId: "cz", customerCode: null, customerName: "ศักดา" }),
        bill({ id: "y", billDate: "2026-07-01T00:00:00Z", customerId: "cy", customerCode: "P139", customerName: "พี" }),
      ],
      NOW
    );
    expect(s.customerOptions.map((c) => c.id)).toEqual(["cy", "cz"]); // มีรหัสมาก่อน
  });
});

describe("filterBills", () => {
  const items: BillItem[] = [
    bill({ id: "a", billDate: "2026-07-10T00:00:00Z", customerId: "c1" }),
    bill({ id: "b", billDate: "2026-06-20T00:00:00Z", customerId: "c1" }),
    bill({ id: "c", billDate: "2026-07-05T00:00:00Z", customerId: "c2" }),
    bill({ id: "d", billDate: "2026-07-01T00:00:00Z", customerId: null }),
  ];

  it("ไม่ใส่ตัวกรอง → คืนทั้งหมด เรียงใหม่→เก่า", () => {
    const r = filterBills(items, {});
    expect(r.map((x) => x.id)).toEqual(["a", "c", "d", "b"]);
  });

  it("กรองตามลูกค้า", () => {
    const r = filterBills(items, { customerId: "c1" });
    expect(r.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("กรองตามเดือน", () => {
    const r = filterBills(items, { month: "2026-07" });
    expect(r.map((x) => x.id)).toEqual(["a", "c", "d"]);
  });

  it("กรองลูกค้า + เดือน พร้อมกัน", () => {
    const r = filterBills(items, { customerId: "c1", month: "2026-07" });
    expect(r.map((x) => x.id)).toEqual(["a"]);
  });

  it("customerId = UNASSIGNED_CUSTOMER → เฉพาะบิลที่ยังไม่จับคู่", () => {
    const r = filterBills(items, { customerId: UNASSIGNED_CUSTOMER });
    expect(r.map((x) => x.id)).toEqual(["d"]);
  });

  it("กรองตามชนิดเอกสาร (docKind)", () => {
    const typed: BillItem[] = [
      bill({ id: "s1", billDate: "2026-07-10T00:00:00Z", customerId: "c1", docKind: "slip" }),
      bill({ id: "x1", billDate: "2026-07-09T00:00:00Z", customerId: "c1", docKind: "sale" }),
      bill({ id: "s2", billDate: "2026-07-08T00:00:00Z", customerId: "c1", docKind: "slip" }),
    ];
    expect(filterBills(typed, { docKind: "slip" }).map((x) => x.id)).toEqual(["s1", "s2"]);
  });

  it("ค้นหาลูกค้า/รหัส (search, ไม่สนตัวพิมพ์)", () => {
    const named: BillItem[] = [
      bill({ id: "a", billDate: "2026-07-10T00:00:00Z", customerId: "c1", customerCode: "N003", customerName: "ร้านเอ" }),
      bill({ id: "b", billDate: "2026-07-09T00:00:00Z", customerId: "c2", customerCode: "P139", customerName: "บริษัทบี" }),
    ];
    expect(filterBills(named, { search: "n003" }).map((x) => x.id)).toEqual(["a"]);
    expect(filterBills(named, { search: "บี" }).map((x) => x.id)).toEqual(["b"]);
    expect(filterBills(named, { search: "ไม่มี" })).toEqual([]);
  });
});

describe("isDocKind / normalizeDocKind", () => {
  it("isDocKind รับเฉพาะค่าที่รู้จัก", () => {
    expect(isDocKind("slip")).toBe(true);
    expect(isDocKind("sale")).toBe(true);
    expect(isDocKind("nope")).toBe(false);
    expect(isDocKind(null)).toBe(false);
    expect(isDocKind(undefined)).toBe(false);
  });
  it("normalizeDocKind แปลงค่าไม่รู้จัก/ว่าง → null", () => {
    expect(normalizeDocKind("purchase")).toBe("purchase");
    expect(normalizeDocKind("weird")).toBeNull();
    expect(normalizeDocKind(null)).toBeNull();
    expect(normalizeDocKind(undefined)).toBeNull();
  });
});

describe("groupBillsByCustomer", () => {
  const items: BillItem[] = [
    // c2 มี 3 ใบ (มากสุด)
    bill({ id: "c2a", billDate: "2026-07-20T00:00:00Z", customerId: "c2", customerCode: "N026", customerName: "บี", docKind: "sale" }),
    bill({ id: "c2b", billDate: "2026-07-21T00:00:00Z", customerId: "c2", customerCode: "N026", customerName: "บี", docKind: "slip" }),
    bill({ id: "c2c", billDate: "2026-07-05T00:00:00Z", customerId: "c2", customerCode: "N026", customerName: "บี", docKind: "slip" }),
    // c1 มี 2 ใบ
    bill({ id: "c1a", billDate: "2026-07-10T00:00:00Z", customerId: "c1", customerCode: "N003", customerName: "เอ", docKind: "handwritten" }),
    bill({ id: "c1b", billDate: "2026-06-10T00:00:00Z", customerId: "c1", customerCode: "N003", customerName: "เอ", docKind: null }),
    // ยังไม่จับคู่ 2 ใบ (มากกว่า c1 ไม่ได้ แต่ต้องอยู่ท้ายสุดเสมอ)
    bill({ id: "u1", billDate: "2026-07-15T00:00:00Z", customerId: null, docKind: "purchase" }),
    bill({ id: "u2", billDate: "2026-07-16T00:00:00Z", customerId: null, docKind: "cash" }),
  ];

  it("เรียงจำนวนบิลมาก→น้อย และ unassigned ท้ายสุดเสมอ", () => {
    const g = groupBillsByCustomer(items);
    expect(g.map((x) => x.customerId)).toEqual(["c2", "c1", null]);
    expect(g[0].total).toBe(3);
    expect(g[1].total).toBe(2);
    expect(g[2].customerId).toBeNull();
    expect(g[2].total).toBe(2);
  });

  it("นับ type breakdown (kinds) ถูกต้อง — doc_kind=null นับใน total ไม่เข้า kinds", () => {
    const g = groupBillsByCustomer(items);
    const c2 = g.find((x) => x.customerId === "c2")!;
    expect(c2.kinds).toEqual({ slip: 2, sale: 1, handwritten: 0, purchase: 0, cash: 0, other: 0 });
    const c1 = g.find((x) => x.customerId === "c1")!;
    expect(c1.total).toBe(2);
    expect(c1.kinds.handwritten).toBe(1);
    // c1b มี doc_kind=null → ไม่เข้า kinds ใด (รวม kinds = 1 แต่ total = 2)
    const sumC1 = Object.values(c1.kinds).reduce((a, b) => a + b, 0);
    expect(sumC1).toBe(1);
  });

  it("latestAt = วันที่บิลล่าสุดในกลุ่ม + คง code/name", () => {
    const g = groupBillsByCustomer(items);
    const c2 = g.find((x) => x.customerId === "c2")!;
    expect(c2.latestAt).toBe("2026-07-21T00:00:00Z");
    expect(c2.code).toBe("N026");
    expect(c2.name).toBe("บี");
    const un = g.find((x) => x.customerId === null)!;
    expect(un.latestAt).toBe("2026-07-16T00:00:00Z");
  });

  it("เสมอกันที่จำนวน → เรียงบิลล่าสุดก่อน", () => {
    const tie: BillItem[] = [
      bill({ id: "a1", billDate: "2026-07-01T00:00:00Z", customerId: "ca", customerCode: "N100" }),
      bill({ id: "b1", billDate: "2026-07-30T00:00:00Z", customerId: "cb", customerCode: "N200" }),
    ];
    const g = groupBillsByCustomer(tie);
    expect(g.map((x) => x.customerId)).toEqual(["cb", "ca"]); // cb ล่าสุดกว่า
  });

  it("ลิสต์ว่าง → []", () => {
    expect(groupBillsByCustomer([])).toEqual([]);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);

  it("แบ่งหน้าถูกต้อง + clamp page เกินช่วง", () => {
    const p1 = paginate(items, 1, 48);
    expect(p1.items).toHaveLength(48);
    expect(p1.totalPages).toBe(3);
    expect(p1.page).toBe(1);

    const p3 = paginate(items, 3, 48);
    expect(p3.items).toHaveLength(4); // 100 - 96

    const over = paginate(items, 99, 48);
    expect(over.page).toBe(3); // clamp

    const under = paginate(items, 0, 48);
    expect(under.page).toBe(1); // clamp
  });

  it("ลิสต์ว่าง → totalPages=1, items=[]", () => {
    const p = paginate([], 1, 48);
    expect(p.items).toEqual([]);
    expect(p.totalPages).toBe(1);
    expect(p.totalItems).toBe(0);
  });
});
