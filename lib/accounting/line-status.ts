/**
 * ลงบันทึกบัญชี — ป้ายช่วยตรวจต่อบรรทัด (pure, ทดสอบได้)
 *
 * แนวคิด "AI ลงให้ก่อน นักบัญชีตรวจ":
 *   🟢 confident = AI เติมครบพร้อมตรวจ (มี account_code + amount + ai_filled)
 *   🟡 check     = ยังมีช่องสำคัญว่าง (amount<=0 หรือ account_code ว่าง) → เน้นให้คนดู
 *
 * ★ ไม่แตะ DB / ไม่เพิ่มคอลัมน์ — infer จาก account_code/amount/ai_filled/source ที่มีอยู่แล้ว
 * ★ บิลคีย์เอง (source='manual') ไม่มีป้าย AI (คืน null)
 */
import type { BillEntry, EntrySource } from "@/lib/accounting/queries";

export type LineBadge = "confident" | "check";

/** ข้อมูลบรรทัดขั้นต่ำที่ใช้ตัดสินป้าย (subset ของ BillEntryLine) */
export type LineBadgeInput = {
  accountCode: string | null;
  amount: number;
  aiFilled: boolean;
};

/**
 * ป้ายช่วยตรวจของ 1 บรรทัด — คืน null เมื่อบิลคีย์เอง (ไม่ต้องมีป้าย AI)
 *   🟢 confident: AI เติม (ai_filled) + มี account_code + amount > 0
 *   🟡 check    : นอกนั้น (ช่องสำคัญยังว่าง — ต้องตรวจ/เติม)
 */
export function lineBadge(line: LineBadgeInput, source: EntrySource): LineBadge | null {
  if (source !== "ai") return null;
  const hasAccount = !!(line.accountCode && line.accountCode.trim());
  const hasAmount = line.amount > 0;
  if (line.aiFilled && hasAccount && hasAmount) return "confident";
  return "check";
}

/** entry ที่ใช้ประเมิน "รอตรวจ" (subset ของ BillEntry) */
type ReviewableEntry = Pick<BillEntry, "source" | "status" | "lines">;

/**
 * entry นี้ยัง "รอตรวจ" ไหม — บิล AI ที่ยังเป็นร่าง (draft) และ
 *   มีบรรทัดที่ยัง 🟡 (ช่องสำคัญว่าง) หรือยังไม่มีบรรทัดเลย
 *   บิลที่ยืนยันแล้ว / คีย์เอง / ทุกบรรทัด 🟢 = ไม่นับ
 */
export function entryNeedsReview(e: ReviewableEntry): boolean {
  if (e.source !== "ai" || e.status !== "draft") return false;
  if (e.lines.length === 0) return true; // ยังไม่มีบรรทัด = ต้องคีย์
  return e.lines.some(
    (l) => lineBadge({ accountCode: l.accountCode, amount: l.amount, aiFilled: l.aiFilled }, "ai") === "check"
  );
}

/** นับจำนวน entry ที่ยัง "รอตรวจ" ในชุด (โชว์ตัวนับ "รอตรวจ N" บนการ์ดลูกค้า) */
export function countNeedsReview(entries: ReviewableEntry[]): number {
  return entries.reduce((n, e) => n + (entryNeedsReview(e) ? 1 : 0), 0);
}
