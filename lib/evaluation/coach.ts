/**
 * AI Coach (Phase 4) — สร้าง coaching_recommendations จากผลคะแนน + breakdown
 *   ★ โทน "โค้ช" (ให้กำลังใจ + แนะวิธีทำให้ดีขึ้น) ไม่ใช่ "จับผิด"
 *   ★ ฟังก์ชันบริสุทธิ์ (deterministic) — testable โดยไม่ต้องเรียก AI
 *     (worker อาจต่อยอดด้วย LLM ภายหลัง แต่ baseline นี้ใช้ได้ทันทีและคาดเดาได้)
 *
 * โครง coaching: strengths / improvements / example_answers / checklist /
 *   repeated_errors / training_topics (ตรงกับตาราง coaching_recommendations 0035)
 */

import { classifyDimensions, type CaseSignal, type ScoreBreakdown } from "./scoring";
import type { Dimension, DimensionScores } from "./weights";

/** ป้ายไทยของแต่ละมิติ */
export const DIMENSION_LABELS: Record<Dimension, string> = {
  correctness: "ความถูกต้องของคำตอบ",
  completeness: "ความครบถ้วนของข้อมูล",
  sla: "การตอบตรงเวลา",
  clarity: "ความชัดเจน เข้าใจง่าย",
  politeness: "ความสุภาพและใส่ใจ",
  ownership: "ความเป็นเจ้าของงานและการติดตาม",
  resolution: "การปิดงานให้จบ",
  sop: "การทำตามมาตรฐาน (SOP)",
};

/** คำแนะนำเชิงบวกต่อมิติที่ควรพัฒนา (โทนโค้ช) */
const IMPROVEMENT_TIPS: Record<Dimension, string> = {
  correctness:
    "ลองทวนตัวเลข/ข้อกฎหมายกับแหล่งอ้างอิงก่อนตอบ ถ้าไม่แน่ใจให้บอกลูกค้าว่าขอตรวจสอบแล้วรีบกลับมา",
  completeness:
    "ตอบให้ครบทุกประเด็นที่ลูกค้าถามในครั้งเดียว สรุปเป็นข้อ ๆ จะช่วยไม่ให้ตกหล่น",
  sla: "ตั้งเป้าตอบรับภายในเวลาทำการ แม้ยังไม่มีคำตอบก็แจ้ง 'รับเรื่องแล้ว กำลังดำเนินการ' ก่อน",
  clarity: "เลี่ยงศัพท์เทคนิค อธิบายเป็นภาษาที่ลูกค้าเข้าใจ พร้อมยกตัวอย่างสั้น ๆ",
  politeness: "เปิด/ปิดข้อความด้วยคำทักทายที่อบอุ่น แสดงความเข้าใจก่อนเข้าเนื้อหา",
  ownership: "รับเป็นเจ้าของเรื่องชัดเจน แจ้งกำหนดเสร็จ และอัปเดตความคืบหน้าเป็นระยะ",
  resolution: "ติดตามจนปิดงานได้จริง สรุปผลตอนจบและยืนยันกับลูกค้าว่าเรียบร้อยแล้ว",
  sop: "ทำตามขั้นตอนมาตรฐานทุกครั้ง โดยเฉพาะเรื่องบัญชี/ภาษีที่เสี่ยงสูงให้ตรวจซ้ำ",
};

/** ตัวอย่างคำตอบที่ดีกว่า (ต่อมิติที่อ่อน) — โค้ชให้เห็นภาพ */
const EXAMPLE_ANSWERS: Record<Dimension, string> = {
  correctness:
    "\"ขอเช็กตัวเลขให้แม่นยำก่อนนะคะ เดี๋ยวยืนยันกลับภายในวันนี้ค่ะ\"",
  completeness:
    "\"สรุปคำตอบเป็น 3 ข้อนะคะ 1)... 2)... 3)... หากมีข้อไหนไม่ชัดเจนแจ้งได้เลยค่ะ\"",
  sla: "\"รับเรื่องแล้วนะคะ กำลังตรวจสอบให้ คาดว่าจะแจ้งผลภายในเวลา 15:00 ค่ะ\"",
  clarity: "\"พูดง่าย ๆ คือภาษีตัวนี้คิดจากยอดขายรวม เดี๋ยวยกตัวอย่างให้ดูนะคะ\"",
  politeness: "\"สวัสดีค่ะคุณลูกค้า เข้าใจความกังวลเลยค่ะ เดี๋ยวช่วยดูให้ทันทีนะคะ\"",
  ownership: "\"เรื่องนี้ให้เป็นคนดูแลเองค่ะ จะอัปเดตความคืบหน้าทุกวันจนกว่าจะเรียบร้อยนะคะ\"",
  resolution: "\"งานปิดเรียบร้อยแล้วนะคะ สรุปคือ... หากมีอะไรเพิ่มเติมแจ้งได้เสมอค่ะ\"",
  sop: "\"ขอทำตามขั้นตอนตรวจสอบเอกสารก่อนนะคะ เพื่อความถูกต้องปลอดภัยของงานค่ะ\"",
};

/** checklist ปฏิบัติต่อมิติที่อ่อน */
const CHECKLIST_ITEMS: Record<Dimension, string> = {
  correctness: "ตรวจตัวเลข/ข้ออ้างอิงก่อนกดส่งทุกครั้ง",
  completeness: "ทวนว่าตอบครบทุกคำถามของลูกค้าก่อนปิดข้อความ",
  sla: "ตอบรับเรื่องภายในเวลาทำการ แม้ยังไม่มีคำตอบสุดท้าย",
  clarity: "อ่านข้อความซ้ำ 1 รอบ ว่าคนนอกสายบัญชีเข้าใจไหม",
  politeness: "มีคำทักทาย/ขอบคุณ/แสดงความเข้าใจในทุกบทสนทนา",
  ownership: "ระบุผู้รับผิดชอบ + กำหนดเสร็จ ในเคสที่รับ",
  resolution: "ติดตามเคสค้างทุกวันจนปิดงาน",
  sop: "เรื่องบัญชี/ภาษีเสี่ยงสูง ส่งผู้เชี่ยวชาญตรวจซ้ำ",
};

/** หัวข้ออบรมแนะนำต่อมิติที่อ่อน */
const TRAINING_TOPICS: Record<Dimension, string> = {
  correctness: "ความรู้บัญชี/ภาษีเชิงลึกและการตรวจทานงาน",
  completeness: "เทคนิคสรุปประเด็นและตอบให้ครบในครั้งเดียว",
  sla: "การบริหารเวลาและจัดลำดับงานให้ทันกำหนด",
  clarity: "การสื่อสารกับลูกค้าด้วยภาษาที่เข้าใจง่าย",
  politeness: "ทักษะการบริการและการสื่อสารเชิงบวก",
  ownership: "ความเป็นเจ้าของงานและการติดตามเคส",
  resolution: "การบริหารเคสให้ปิดงานได้จริง",
  sop: "มาตรฐานการทำงาน (SOP) และการควบคุมคุณภาพ",
};

export type Coaching = {
  period: string | null;
  strengths: string[];
  improvements: string[];
  example_answers: string[];
  checklist: string[];
  repeated_errors: string[];
  training_topics: string[];
};

export type BuildCoachingInput = {
  scores: Partial<DimensionScores>;
  breakdown: ScoreBreakdown;
  cases: CaseSignal[];
  period?: string | null;
};

/** นับปัญหา/ประเภท sop_violation ที่เกิดซ้ำ ≥ 2 ครั้ง → repeated_errors */
function repeatedErrors(cases: CaseSignal[]): string[] {
  const sopBySeverity = new Map<string, number>();
  let highRisk = 0;
  for (const c of cases) {
    for (const v of c.sopViolations) {
      sopBySeverity.set(v.severity, (sopBySeverity.get(v.severity) ?? 0) + 1);
      if (v.severity === "high") highRisk += 1;
    }
  }
  const out: string[] = [];
  const high = sopBySeverity.get("high") ?? 0;
  const medium = sopBySeverity.get("medium") ?? 0;
  if (highRisk >= 2) out.push(`พบประเด็นผิดมาตรฐานระดับสูงซ้ำ ${high} ครั้ง — ควรทบทวนขั้นตอนด่วน`);
  else if (high >= 1) out.push(`พบประเด็นผิดมาตรฐานระดับสูง ${high} ครั้ง`);
  if (medium >= 2) out.push(`พบประเด็นระดับกลางซ้ำ ${medium} ครั้ง`);
  return out;
}

/**
 * สร้าง coaching (โทนโค้ช) จากคะแนน + breakdown + signals
 *   - strengths : มิติ >= 80 (คำชม)
 *   - improvements/example_answers/checklist/training_topics : มิติ < 60
 *   - repeated_errors : ปัญหา/violation ที่เกิดซ้ำ
 */
export function buildCoaching(inp: BuildCoachingInput): Coaching {
  const { strengths: strongDims, improvements: weakDims } = classifyDimensions(inp.scores);

  const strengths =
    strongDims.length > 0
      ? strongDims.map((d) => `ทำได้ดีเรื่อง${DIMENSION_LABELS[d]} เยี่ยมมาก รักษาระดับนี้ไว้นะ`)
      : ["ยังไม่มีมิติที่เด่นชัดในช่วงนี้ แต่พัฒนาได้แน่นอน มาลุยไปด้วยกัน"];

  const improvements = weakDims.map((d) => `${DIMENSION_LABELS[d]}: ${IMPROVEMENT_TIPS[d]}`);
  const example_answers = weakDims.map((d) => EXAMPLE_ANSWERS[d]);
  const checklist = weakDims.map((d) => CHECKLIST_ITEMS[d]);
  const training_topics = weakDims.map((d) => TRAINING_TOPICS[d]);

  return {
    period: inp.period ?? null,
    strengths,
    improvements,
    example_answers,
    checklist,
    repeated_errors: repeatedErrors(inp.cases),
    training_topics,
  };
}
