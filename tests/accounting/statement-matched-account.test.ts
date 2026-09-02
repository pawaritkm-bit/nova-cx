import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression — คำถามผู้ใช้ 2026-09-02: "กระทบยอดสเตทเมนต์กับบิลเสร็จแล้ว ทำไมไม่ไหลไป
 * สมุดบัญชี 5 เล่ม" — เพราะสมุดรายวันข้ามบิลที่ "บรรทัดยังไม่มีบัญชี" (บัญชีขาด) และหน้า
 * กระทบยอดเดิมถือว่าจับคู่แล้ว=จบ ไม่มีช่องใส่บัญชีให้บิลที่จับคู่
 *
 * กติกาถาวรหลังแก้:
 *  1) ฝั่งบิลที่จับคู่ต้องส่งสถานะบัญชีมาด้วย (accountCode/accountMissing ใน BillForMatch)
 *  2) หน้ากระทบยอดต้องเติมบัญชีลง "บรรทัดบิลจริง" ได้ (applyStatementAccountToBillAction)
 *     — บิลบรรทัดเดียวเขียนทับได้ (แก้ AI ผิดหมวด) · หลายบรรทัดเติมเฉพาะที่ว่าง
 *  3) แถวที่บิลยังไม่มีบัญชีต้องได้คำแนะนำจาก learning (ไม่ใช่เฉพาะแถวไม่พบบิล)
 */
const ROOT = join(__dirname, "..", "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("กระทบยอดแล้วบิลต้องไหลเข้าสมุด 5 เล่มได้ (เติมบัญชีจากหน้ากระทบยอด)", () => {
  it("BillForMatch มีสถานะบัญชีของบิล (accountCode/accountMissing)", () => {
    const s = src("lib/accounting/statement-bill-match.ts");
    expect(s).toMatch(/accountCode\?:\s*string \| null/);
    expect(s).toMatch(/accountMissing\?:\s*boolean/);
  });

  it("มี action เติมบัญชีลงบรรทัดบิลจริง + สอน learning", () => {
    const s = src("app/chat-audit/accounting/statement-actions.ts");
    const i = s.indexOf("applyStatementAccountToBillAction");
    expect(i).toBeGreaterThan(-1);
    const fn = s.slice(i, i + 4000);
    // บิลต้องเป็นของลูกค้า+tenant เดียวกัน (กันชี้ข้ามลูกค้า)
    expect(fn).toMatch(/eq\("customer_id", input\.customerId\)/);
    // บรรทัดเดียว = เขียนทับ · หลายบรรทัด = เติมเฉพาะที่ว่าง
    expect(fn).toMatch(/ls\.length === 1 \? ls : ls\.filter/);
    // สอน learning ต่อ (ชื่อหรือยอด — กติกา 0128)
    expect(fn).toMatch(/recordAccountRules/);
  });

  it("คำแนะนำบัญชีครอบคลุมแถวที่ 'พบบิลแต่บิลยังไม่มีบัญชี' ด้วย", () => {
    const s = src("app/chat-audit/accounting/statement-actions.ts");
    expect(s).toMatch(/billById\.get\(m\.billId\)\?\.accountMissing !== true/);
  });

  it("การ์ดบิลที่จับคู่ มีช่องบัญชี (combobox) และเตือนเมื่อบัญชีขาด", () => {
    const s = src("app/chat-audit/accounting/StatementAnalyzer.tsx");
    expect(s).toMatch(/onPickAccountForBill/);
    expect(s).toMatch(/บิลยังไม่มีบัญชี/);
    expect(s).toMatch(/applyStatementAccountToBillAction\(\{/);
  });
});
