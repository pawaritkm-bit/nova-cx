/**
 * ประกอบ "แถวเทียบงวด" ของงบกำไรขาดทุน/งบแสดงฐานะการเงิน — pure ทั้งไฟล์ (ไม่แตะ DB)
 *
 * บริบท: เฟส 4 ส่วน N (docs/06-accounting-features-roadmap.md, N1/N2/N3) — จอ/หน้าพิมพ์/Excel export
 *   ทั้ง 3 จุดต้อง "รวม 2 ชุด StatementLine[] (งวดปัจจุบัน + งวดเทียบ) เป็นแถวเดียวกันตามรหัสบัญชี" เหมือน
 *   กันเป๊ะ — สกัดเป็นฟังก์ชันเดียวที่นี่ (0.13 spirit) กันโค้ดคำนวณซ้ำ/เพี้ยนกันระหว่าง 3 จุดเรียก
 *
 * กติกา: ถ้ารหัสบัญชีมีเฉพาะฝั่งใดฝั่งหนึ่ง (เช่น งวดปัจจุบันมีบัญชีนี้แต่งวดเทียบไม่มี หรือกลับกัน — ผังบัญชี
 *   แก้ไขได้เองโดย tenant ตั้งแต่เฟส 1 เพิ่ม/ลบรหัสได้ตลอด) ให้ยังคงแสดงแถวนั้น (อีกฝั่ง = 0 ถ้าไม่มีข้อมูล
 *   จริง หรือ null ถ้าไม่มีงวดเทียบเลย) — ไม่ตัดทิ้งเงียบ ๆ (audit-friendly)
 * ★ ลำดับแถว: เรียงตามลำดับที่ปรากฏในงวดปัจจุบันก่อนเสมอ แล้วต่อท้ายด้วยรหัสที่มีเฉพาะในงวดเทียบ (ตามลำดับ
 *   ที่ปรากฏในงวดเทียบ) — กันงบดูสับสนเวลาไม่มีโหมดเทียบ (ผลลัพธ์ต้องเรียงเหมือนเดิมเป๊ะ)
 */
import type { StatementLine } from "@/lib/accounting/financial-statements";

/** 1 แถวเทียบงวด — `compare` = null หมายถึง "ไม่มีโหมดเทียบเลย" (ต่างจาก 0 ที่แปลว่ามีโหมดเทียบแต่ไม่มียอด) */
export type CompareLine = {
  code: string;
  name: string;
  current: number;
  compare: number | null;
};

/**
 * รวม 2 ชุด StatementLine[] เป็นแถวเทียบงวดเดียวกันตามรหัสบัญชี
 *   @param current งวดปัจจุบัน (แสดงเสมอ)
 *   @param compare งวดเทียบ — null = ไม่ได้เลือกโหมดเทียบ (ทุกแถวได้ compare=null)
 */
export function mergeCompareLines(
  current: StatementLine[],
  compare: StatementLine[] | null
): CompareLine[] {
  const order: string[] = [];
  const byCode = new Map<string, CompareLine>();

  for (const l of current) {
    if (!byCode.has(l.code)) order.push(l.code);
    byCode.set(l.code, { code: l.code, name: l.name, current: l.amount, compare: null });
  }

  if (compare) {
    for (const l of compare) {
      const existing = byCode.get(l.code);
      if (existing) {
        existing.compare = l.amount;
      } else {
        order.push(l.code);
        byCode.set(l.code, { code: l.code, name: l.name, current: 0, compare: l.amount });
      }
    }
    // รหัสที่มีในงวดปัจจุบันแต่ไม่มีในงวดเทียบ → compare ควรเป็น 0 (มีโหมดเทียบจริง แค่ไม่มียอด) ไม่ใช่ null
    for (const code of order) {
      const row = byCode.get(code)!;
      if (row.compare === null) row.compare = 0;
    }
  }

  return order.map((code) => byCode.get(code)!);
}

/** ผลรวม `current`/`compare` ของชุดแถวเทียบ (ใช้ทำแถว "รวม") */
export function sumCompareLines(lines: CompareLine[]): { current: number; compare: number | null } {
  const current = lines.reduce((s, l) => s + l.current, 0);
  const hasCompare = lines.some((l) => l.compare !== null);
  const compare = hasCompare ? lines.reduce((s, l) => s + (l.compare ?? 0), 0) : null;
  return { current, compare };
}
