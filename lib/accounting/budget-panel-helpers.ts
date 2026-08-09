/**
 * ตัวช่วย pure (ไม่แตะ DB/React) สำหรับ BudgetPanel.tsx (เฟส 6 ส่วน S)
 *   แยกออกมาเป็นไฟล์ .ts ล้วนเพื่อ unit test ได้ตรง ๆ โดยไม่ต้อง render component (โปรเจกต์นี้ยังไม่มี
 *   test runner สำหรับ React component)
 *
 * ★ บั๊กที่แก้: BudgetPanel เดิมกรองทิ้งทุกแถว amount<=0 ก่อนส่งไป saveBudgetYearAction ทำให้เคลียร์งบ
 *   ทั้งปีของบัญชีหนึ่งไม่ได้จริง — upsertBudgetYear (budget.ts) ใช้ "รหัสบัญชีที่ปรากฏใน rows" (touchedCodes)
 *   เป็นตัวกำหนดว่าต้องลบของเดิมของบัญชีไหนออกบ้าง ถ้าบัญชีที่ผู้ใช้เคลียร์ค่าไม่ปรากฏใน rows เลย (ถูกกรองทิ้ง
 *   หมดเพราะทุกเดือน=0) เดือนเก่าที่เคยตั้งไว้จะไม่ถูกลบ (ค้างอยู่ใน DB)
 *
 * แนวทางแก้: ส่งครบทั้ง 12 เดือนของ "บัญชีที่ผู้ใช้แก้ไขในรอบนี้" เท่านั้น (แม้ amount จะเป็น 0) — ไม่ส่งบัญชี
 *   ที่ไม่ได้แก้เลย (กันไม่ให้ payload บวมด้วยผังบัญชีทั้งระบบที่ไม่เกี่ยวข้อง)
 */

/** ตาราง accountCode -> เดือน(1-12, index 0-11) -> ข้อความในช่อง (ชนิดเดียวกับ Grid ใน BudgetPanel.tsx) */
export type BudgetGrid = Record<string, string[]>;

export type BudgetSaveRow = { accountCode: string; month: number; amount: number };

/**
 * สร้างชุดแถวสำหรับส่งไป saveBudgetYearAction จาก grid ปัจจุบัน + เซตรหัสบัญชีที่ "ถูกแก้ไขจริง" ในรอบนี้
 *   - ส่งครบทั้ง 12 เดือนของทุกบัญชีที่อยู่ใน dirtyCodes เสมอ (รวมช่องที่ amount=0/ว่าง) เพื่อให้
 *     upsertBudgetYear รู้ว่าต้องลบเดือนที่ผู้ใช้เคลียร์ค่าออกจริง ไม่ใช่แค่ไม่แตะ
 *   - บัญชีที่ไม่ได้อยู่ใน dirtyCodes (ผู้ใช้ไม่ได้แก้เลย) จะไม่ถูกส่งเลย แม้ grid จะมี key ของบัญชีนั้นอยู่
 *     (เช่น ผังบัญชีทั้งระบบที่ initial โหลดมาแสดงในกริดแต่ผู้ใช้ไม่ได้แตะ)
 */
export function buildBudgetSaveRows(
  grid: BudgetGrid,
  dirtyCodes: ReadonlySet<string>,
  parseAmount: (v: string) => number
): BudgetSaveRow[] {
  const rows: BudgetSaveRow[] = [];
  for (const accountCode of dirtyCodes) {
    const months = grid[accountCode] ?? [];
    for (let idx = 0; idx < months.length; idx++) {
      rows.push({ accountCode, month: idx + 1, amount: parseAmount(months[idx] ?? "") });
    }
  }
  return rows;
}
