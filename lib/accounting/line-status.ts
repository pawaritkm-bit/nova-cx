/**
 * ลงบันทึกบัญชี — ป้ายช่วยตรวจต่อบรรทัด (pure, ทดสอบได้) — ★ 3 สถานะ
 *
 * แนวคิด "AI ลงให้ก่อน นักบัญชีตรวจ":
 *   🟢 confident = AI เติมครบ + มั่นใจสูง (มี account_code + amount + ai_filled + ไม่มีช่องเดา)
 *   🟡 guess     = AI เติมครบ "แต่เดาบางช่อง" (ai_low_confidence) → "AI เดา — ตรวจ" ก่อนยืนยัน
 *   🟡 check     = ยังมีช่องสำคัญว่าง (amount<=0 หรือ account_code ว่าง) → ให้คนตรวจ/เติม
 *
 * ★ infer จาก account_code/amount/ai_filled/ai_low_confidence/source
 * ★ บิลคีย์เอง (source='manual') ไม่มีป้าย AI (คืน null)
 */
import type { BillEntry, EntrySource } from "@/lib/accounting/queries";

export type LineBadge = "confident" | "guess" | "check";

/** ข้อมูลบรรทัดขั้นต่ำที่ใช้ตัดสินป้าย (subset ของ BillEntryLine) */
export type LineBadgeInput = {
  accountCode: string | null;
  amount: number;
  aiFilled: boolean;
  /** AI "เดาเติม" ช่องเสี่ยง (ยอด/VAT/บัญชี conf ต่ำ) — แยกป้าย "เดา" ออกจาก "มั่นใจ" */
  aiLowConfidence: boolean;
};

/**
 * ป้ายช่วยตรวจของ 1 บรรทัด — คืน null เมื่อบิลคีย์เอง (ไม่ต้องมีป้าย AI)
 *   🟢 confident: AI เติมครบ (ai_filled + account_code + amount>0) และไม่มีช่องเดา
 *   🟡 guess    : เติมครบเหมือนกัน แต่มีช่อง "เดา" (ai_low_confidence) → ต้องตรวจก่อนยืนยัน
 *   🟡 check    : ช่องสำคัญยังว่าง (ต้องตรวจ/เติม)
 */
export function lineBadge(line: LineBadgeInput, source: EntrySource): LineBadge | null {
  if (source !== "ai") return null;
  const hasAccount = !!(line.accountCode && line.accountCode.trim());
  const hasAmount = line.amount > 0;
  if (line.aiFilled && hasAccount && hasAmount) {
    return line.aiLowConfidence ? "guess" : "confident";
  }
  return "check";
}

/** entry ที่ใช้ประเมิน "รอตรวจ" (subset ของ BillEntry) */
type ReviewableEntry = Pick<BillEntry, "source" | "status" | "lines">;

/**
 * entry นี้ยัง "รอตรวจ" ไหม — บิล AI ที่ยังเป็นร่าง (draft) และ
 *   มีบรรทัดที่ยัง 🟡 (ช่องสำคัญว่าง=check หรือ AI เดา=guess) หรือยังไม่มีบรรทัดเลย
 *   บิลที่ยืนยันแล้ว / คีย์เอง / ทุกบรรทัด 🟢 (confident) = ไม่นับ
 */
export function entryNeedsReview(e: ReviewableEntry): boolean {
  if (e.source !== "ai" || e.status !== "draft") return false;
  if (e.lines.length === 0) return true; // ยังไม่มีบรรทัด = ต้องคีย์
  return e.lines.some((l) => {
    const badge = lineBadge(
      { accountCode: l.accountCode, amount: l.amount, aiFilled: l.aiFilled, aiLowConfidence: l.aiLowConfidence },
      "ai"
    );
    return badge === "check" || badge === "guess";
  });
}

/** นับจำนวน entry ที่ยัง "รอตรวจ" ในชุด (โชว์ตัวนับ "รอตรวจ N" บนการ์ดลูกค้า) */
export function countNeedsReview(entries: ReviewableEntry[]): number {
  return entries.reduce((n, e) => n + (entryNeedsReview(e) ? 1 : 0), 0);
}
