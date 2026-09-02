import { describe, it, expect } from "vitest";
import { buildEquityChangeStatement, buildClosingEntryLines } from "@/lib/accounting/equity-change";
import type { TrialBalance, TrialBalanceRow } from "@/lib/accounting/trial-balance";

/**
 * ★ 2026-09-02 (ขั้น 8 ครบ) — งบการเปลี่ยนแปลงส่วนของผู้ถือหุ้น + บรรทัดปิดบัญชีสิ้นงวด
 */

function tb(rows: Partial<TrialBalanceRow>[]): TrialBalance {
  const full = rows.map((r) => ({
    code: r.code ?? "",
    name: r.name ?? r.code ?? "",
    digit: r.digit ?? (r.code?.[0] as TrialBalanceRow["digit"]) ?? "6",
    balance: r.balance ?? 0,
    debit: 0,
    credit: 0,
  })) as TrialBalanceRow[];
  return {
    rows: full,
    totalDebit: 0,
    totalCredit: 0,
    balanced: true,
  } as unknown as TrialBalance;
}

describe("buildEquityChangeStatement", () => {
  it("ต้นงวด→เปลี่ยนแปลง→ปลายงวด ต่อบัญชีหมวด 3 + แถวกำไรสะสมที่ยังไม่ปิด", () => {
    // ต้นงวด: ทุน 100,000 (เครดิต = balance ลบ) · กำไรจากงวดก่อนยังไม่ปิด 20,000 (รายได้เครดิต 20,000)
    const opening = tb([
      { code: "3010", name: "ทุนจดทะเบียน", digit: "3", balance: -100000 },
      { code: "4030", name: "รายได้บริการ", digit: "4", balance: -20000 },
    ]);
    // ปลายงวด: เพิ่มทุนเป็น 150,000 · รายได้สะสม 50,000 · ค่าใช้จ่ายสะสม 10,000
    const closing = tb([
      { code: "3010", name: "ทุนจดทะเบียน", digit: "3", balance: -150000 },
      { code: "4030", name: "รายได้บริการ", digit: "4", balance: -50000 },
      { code: "5310", name: "เงินเดือน", digit: "5", balance: 10000 },
    ]);
    const eq = buildEquityChangeStatement(opening, closing);
    const capital = eq.rows.find((r) => r.code === "3010")!;
    expect(capital.opening).toBe(100000);
    expect(capital.change).toBe(50000);
    expect(capital.closing).toBe(150000);
    // กำไรที่ยังไม่ปิด: ต้นงวด 20,000 → ปลายงวด 40,000 (50,000−10,000)
    expect(eq.unclosedProfit.opening).toBe(20000);
    expect(eq.unclosedProfit.closing).toBe(40000);
    expect(eq.unclosedProfit.change).toBe(20000);
    expect(eq.openingTotal).toBe(120000);
    expect(eq.closingTotal).toBe(190000);
    expect(eq.changeTotal).toBe(70000);
  });

  it("บัญชีทุนที่เพิ่งเกิดในงวด (ไม่มีต้นงวด) → ต้นงวด 0", () => {
    const eq = buildEquityChangeStatement(
      tb([]),
      tb([{ code: "3020", name: "กำไรสะสม", digit: "3", balance: -5000 }])
    );
    expect(eq.rows[0]).toMatchObject({ code: "3020", opening: 0, change: 5000, closing: 5000 });
  });
});

describe("buildClosingEntryLines — ปิดรายได้/ค่าใช้จ่ายเข้ากำไรสะสม", () => {
  it("เดบิตรายได้ล้างยอด · เครดิตค่าใช้จ่ายล้างยอด · กำไรเข้าเครดิตกำไรสะสม + สมดุล", () => {
    const plan = buildClosingEntryLines(
      tb([
        { code: "4030", name: "รายได้บริการ", digit: "4", balance: -50000 },
        { code: "5310", name: "เงินเดือน", digit: "5", balance: 30000 },
        { code: "1020", name: "ธนาคาร", digit: "1", balance: 20000 }, // ไม่เกี่ยว — ห้ามแตะ
      ]),
      { code: "3020", name: "กำไรสะสม" }
    )!;
    expect(plan.netProfit).toBe(20000);
    expect(plan.lines.find((l) => l.accountCode === "4030")).toMatchObject({ debit: 50000, credit: 0 });
    expect(plan.lines.find((l) => l.accountCode === "5310")).toMatchObject({ debit: 0, credit: 30000 });
    expect(plan.lines.find((l) => l.accountCode === "3020")).toMatchObject({ debit: 0, credit: 20000 });
    expect(plan.lines.some((l) => l.accountCode === "1020")).toBe(false);
    const d = plan.lines.reduce((s, l) => s + l.debit, 0);
    const c = plan.lines.reduce((s, l) => s + l.credit, 0);
    expect(d).toBe(c);
  });

  it("ขาดทุน → เดบิตกำไรสะสม", () => {
    const plan = buildClosingEntryLines(
      tb([
        { code: "4030", digit: "4", balance: -1000 },
        { code: "5310", digit: "5", balance: 4000 },
      ])
    )!;
    expect(plan.netProfit).toBe(-3000);
    const re = plan.lines.find((l) => l.accountCode === "3020")!;
    expect(re.debit).toBe(3000);
    expect(re.credit).toBe(0);
  });

  it("P&L เป็นศูนย์หมด (ปิดไปแล้ว) → null", () => {
    expect(buildClosingEntryLines(tb([{ code: "1020", digit: "1", balance: 500 }]))).toBeNull();
    expect(buildClosingEntryLines(tb([{ code: "4030", digit: "4", balance: 0 }]))).toBeNull();
  });
});
