import type { AIProvider } from "@/lib/ai/provider";
import { z } from "zod";
import type { QualitativeScores } from "./scoring";
import type { CaseSignal } from "./scoring";

/**
 * คะแนนมิติเชิงคุณภาพ (correctness/completeness/clarity/politeness) — Phase 4
 *   ★ 2 เส้นทาง:
 *     (A) AI  : ให้ provider ให้คะแนนจาก "ผลวิเคราะห์ที่ redact แล้ว" (summary/problems/quotes)
 *               — ไม่แตะแชตดิบ (ai_chat_analysis ผ่าน redact/guardrail มาแล้ว)
 *     (B) fallback deterministic : อนุมานจาก "ประเภทปัญหา" ที่พบจริง (ไม่ใช่จำนวนข้อความ)
 *
 *   worker ใช้ (A) ถ้ามี provider, ไม่งั้น (B) — scoring จะ fallback sentiment อีกชั้นถ้าไม่มีทั้งคู่
 */

// --- (B) fallback: อนุมานจากประเภทปัญหา ---
//   เริ่ม baseline 80 แล้วหักตามปัญหาที่กระทบแต่ละมิติ (มีหลักฐานจริงจาก problems)
const PROBLEM_IMPACT: Record<string, Partial<Record<keyof QualitativeScores, number>>> = {
  off_topic_reply: { correctness: 15, completeness: 10 },
  conflicting_info: { correctness: 20 },
  missed_request: { completeness: 20 },
  repeat_doc_request: { completeness: 10, clarity: 5 },
  jargon: { clarity: 15 },
  terse_reply: { clarity: 10, politeness: 15 },
};

const QUAL_KEYS: (keyof QualitativeScores)[] = [
  "correctness",
  "completeness",
  "clarity",
  "politeness",
];

/** ประเภทปัญหาต่อเคส (จาก ai_chat_analysis.problems) — worker ส่งมาให้ */
export type ProblemContext = { caseId: string; problemTypes: string[] };

/**
 * (B) อนุมานคะแนนคุณภาพจากประเภทปัญหาที่พบ (deterministic, testable)
 *   ★ ไม่คิดจาก "จำนวนข้อความ" — หักเฉพาะเมื่อพบปัญหาที่มีหลักฐาน
 */
export function deriveQualitativeFromProblems(problems: ProblemContext[]): QualitativeScores {
  const base = 80;
  const penalty: Record<keyof QualitativeScores, number> = {
    correctness: 0,
    completeness: 0,
    clarity: 0,
    politeness: 0,
  };
  let anyProblem = false;
  for (const p of problems) {
    for (const t of p.problemTypes) {
      const impact = PROBLEM_IMPACT[t];
      if (!impact) continue;
      anyProblem = true;
      for (const k of QUAL_KEYS) {
        if (impact[k]) penalty[k] += impact[k]!;
      }
    }
  }
  if (!anyProblem && problems.length === 0) return {}; // ไม่มีข้อมูลปัญหาเลย → ปล่อยว่าง
  const out: QualitativeScores = {};
  for (const k of QUAL_KEYS) {
    out[k] = Math.max(0, Math.min(100, base - penalty[k]));
  }
  return out;
}

/** รวม problemTypes จาก CaseSignal (แต่ signal เก็บแค่ count) — helper ดึงจาก analyses แยก */
export function problemContextFromSignals(
  cases: CaseSignal[],
  problemTypesByCase: Map<string, string[]>
): ProblemContext[] {
  return cases.map((c) => ({
    caseId: c.caseId,
    problemTypes: problemTypesByCase.get(c.caseId) ?? [],
  }));
}

// --- (A) AI qualitative scorer ---

const qualSchema = z.object({
  correctness: z.number().min(0).max(100),
  completeness: z.number().min(0).max(100),
  clarity: z.number().min(0).max(100),
  politeness: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
});

export const QUAL_JSON_SCHEMA = {
  name: "nova_qualitative_scores",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      correctness: { type: "number" },
      completeness: { type: "number" },
      clarity: { type: "number" },
      politeness: { type: "number" },
      confidence: { type: "number" },
    },
    required: ["correctness", "completeness", "clarity", "politeness", "confidence"],
  },
} as const;

/** context สรุป (redact แล้ว) ที่ป้อนให้ AI ให้คะแนน — ไม่มีแชตดิบ/ชื่อ */
export type QualitativeContext = {
  summaries: string[];
  problemTypes: string[];
  evidenceQuotes: string[];
};

function buildQualSystem(): string {
  return [
    "คุณคือ 'น้อง NOVA' ผู้ช่วยประเมินคุณภาพการตอบของนักบัญชี Finovas",
    "ให้คะแนน 4 มิติ (0-100) จากสรุปบทสนทนา+ปัญหาที่พบ (ข้อมูล redact แล้ว):",
    "- correctness ความถูกต้องของคำตอบ",
    "- completeness ความครบถ้วน ตอบครบทุกประเด็น",
    "- clarity ความชัดเจน เข้าใจง่าย ไม่ใช้ศัพท์ยากเกินไป",
    "- politeness ความสุภาพ ใส่ใจลูกค้า",
    "กฎ: ให้คะแนนจากคุณภาพเนื้อหา ไม่ใช่จำนวนข้อความ; ข้อมูลน้อย/กำกวม → confidence ต่ำ",
    "ตอบเป็น JSON ตาม schema เท่านั้น",
  ].join("\n");
}

function buildQualUser(ctx: QualitativeContext): string {
  const lines = ["สรุปบทสนทนา:"];
  ctx.summaries.forEach((s, i) => lines.push(`(${i + 1}) ${s}`));
  lines.push("", `ปัญหาที่พบ: ${ctx.problemTypes.join(", ") || "ไม่มี"}`);
  if (ctx.evidenceQuotes.length > 0) {
    lines.push("", "ตัวอย่างข้อความ (redact):");
    ctx.evidenceQuotes.slice(0, 20).forEach((q) => lines.push(`- ${q}`));
  }
  lines.push("", "ให้คะแนน 4 มิติเป็น JSON ตาม schema");
  return lines.join("\n");
}

/**
 * (A) เรียก AI ให้คะแนน 4 มิติ — คืน null เมื่อ provider ล้ม/parse ไม่ผ่าน (worker จะ fallback)
 */
export async function scoreQualitativeWithAI(
  provider: AIProvider,
  ctx: QualitativeContext
): Promise<{ scores: QualitativeScores; confidence: number } | null> {
  try {
    const raw = await provider.generateJson({
      system: buildQualSystem(),
      user: buildQualUser(ctx),
      jsonSchema: QUAL_JSON_SCHEMA,
    });
    const parsed = qualSchema.parse(JSON.parse(raw));
    return {
      scores: {
        correctness: parsed.correctness,
        completeness: parsed.completeness,
        clarity: parsed.clarity,
        politeness: parsed.politeness,
      },
      confidence: parsed.confidence,
    };
  } catch {
    return null;
  }
}
