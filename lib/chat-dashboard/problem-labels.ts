/**
 * ป้าย/โทนสีของ "หมวดปัญหา" (problems[].type) ที่ใช้แสดงบนหน้า chat-audit
 *   ★ reuse PROBLEM_LABELS จาก lib/ai/chat-schema.ts (อีก dev เป็นเจ้าของ) — import อย่างเดียว ไม่แก้ไฟล์นั้น
 *     เพื่อให้ป้าย/หมวดตรงกับที่ AI ผลิตจริง (ชุดคงที่ 6 หมวด) ไม่เพี้ยนกันคนละที่
 *   ★ level ใน PROBLEM_LABELS = red|amber → map เป็นคลาส badge เดิมของธีม (b-red / b-yellow)
 *   type ที่ไม่รู้จัก/ว่าง → ป้ายกลาง โทนเหลือง (ไม่ทำให้หน้าแตก)
 */
import { PROBLEM_LABELS, type ProblemCategory } from "@/lib/ai/chat-schema";

export type ProblemTone = "red" | "yellow";
export type ProblemMeta = { label: string; tone: ProblemTone };

/** map หมวดปัญหา → {label, tone}; type ไม่รู้จัก/ว่าง → ป้ายกลาง โทนเหลือง */
export function problemMeta(type: string | null | undefined): ProblemMeta {
  if (!type) return { label: "อื่น ๆ", tone: "yellow" };
  const entry = PROBLEM_LABELS[type as ProblemCategory];
  if (!entry) return { label: type, tone: "yellow" };
  return { label: entry.label, tone: entry.level === "red" ? "red" : "yellow" };
}

/** โทน → คลาส badge เดิมของธีม (b-red / b-yellow) */
export function problemBadgeClass(tone: ProblemTone): string {
  return tone === "red" ? "b-red" : "b-yellow";
}
