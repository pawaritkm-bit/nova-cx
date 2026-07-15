import type { AiOutput, Urgency } from "./schema";

/**
 * Guardrail post-filter (C-01..C-04) — ตรวจ/ปรับผลลัพธ์ AI ก่อนบันทึก
 *
 *   C-01/C-02: draft_reply ห้ามมีคำรับปากชดเชย/คืนเงิน/ลดราคา/ผลลัพธ์,
 *              ห้าม "รับรองว่าจะไม่เกิดขึ้นอีก", ห้ามยอมรับผิด/วินิจฉัยข้อพิพาทแทนบริษัท
 *              → ถ้าพบ: ตัด draft_reply ทิ้ง + flag needs_human_review
 *   C-03:      ข้อสรุปที่กล่าวโทษพนักงานต้องมี evidence; ถ้า ai_assumptions มีการชี้ผิด
 *              แต่ evidence ว่าง → flag needs_human_review
 *   C-04:      keyword เสี่ยง (สรรพากร/ค่าปรับ/ฟ้อง/ข้อมูลรั่ว/ยกเลิก/คืนเงิน ฯลฯ)
 *              ใช้ "ประกอบ" การยกระดับ ไม่ตัดสินจาก keyword เดี่ยว —
 *              ยกระดับเฉพาะเมื่อ (มี keyword) AND (บริบทลบ/มีข้อเท็จจริงรองรับ)
 */

/** วลีที่ห้ามปรากฏใน draft_reply (คำรับปากผูกมัดบริษัท) — C-01/C-02 */
const FORBIDDEN_REPLY_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /คืนเงิน/, reason: "รับปากคืนเงิน (C-01)" },
  { re: /ชดเชย|ชดใช้|เยียวยา/, reason: "รับปากชดเชย/เยียวยา (C-01)" },
  { re: /ลดราคา|ส่วนลด|ลดค่า(?:บริการ|ธรรมเนียม)/, reason: "รับปากลดราคา (C-01)" },
  { re: /ฟรี|ไม่คิดค่า|ยกเว้นค่า/, reason: "รับปากให้ฟรี/ยกเว้นค่าใช้จ่าย (C-01)" },
  {
    re: /(?:รับรอง|รับประกัน|ยืนยัน|สัญญา)(?:ว่า)?[^。\n]{0,20}(?:ไม่เกิด|จะไม่เกิด|ไม่มีอีก|ไม่เกิดขึ้นอีก)/,
    reason: 'รับรองว่า "จะไม่เกิดขึ้นอีก" (C-02)',
  },
  { re: /จะไม่เกิดขึ้นอีก|ไม่เกิดขึ้นอีกแน่นอน/, reason: 'รับรอง "จะไม่เกิดขึ้นอีก" (C-02)' },
  { re: /(?:บริษัท|เรา|ทางเรา)[^。\n]{0,10}(?:ยอมรับผิด|เป็นความผิดของ|ผิดจริง)/, reason: "ยอมรับผิดแทนบริษัท (C-02)" },
  { re: /รับประกันผล|การันตี/, reason: "การันตีผลลัพธ์ (C-01)" },
];

/** keyword เสี่ยงระดับสูง (ใช้ประกอบการยกระดับ ไม่ตัดสินเดี่ยว) — C-04 */
export const RISK_KEYWORDS = [
  "สรรพากร",
  "ค่าปรับ",
  "เบี้ยปรับ",
  "ฟ้อง",
  "ฟ้องร้อง",
  "คดี",
  "ทนาย",
  "ข้อมูลรั่ว",
  "ข้อมูลหลุด",
  "เอกสารหาย",
  "ยกเลิก",
  "เลิกใช้บริการ",
  "คืนเงิน",
  "ทุจริต",
  "โกง",
];

/** คำที่บ่งชี้ว่า assumption กำลัง "ชี้ผิด" พนักงาน — ต้องมี evidence (C-03) */
const BLAME_PATTERNS = /พนักงาน|นักบัญชี|เจ้าหน้าที่|ทีมงาน|เซล|พี่|น้อง/;
const FAULT_PATTERNS = /ผิด|บกพร่อง|ละเลย|ไม่ทำ|ไม่รับผิดชอบ|จงใจ|ประมาท|โกหก/;

export type GuardrailResult = {
  output: AiOutput;
  needsHumanReview: boolean;
  violations: string[];
};

/**
 * normalize ข้อความก่อน match คำต้องห้าม (C-01/C-02)
 *   ตัด whitespace + zero-width + soft hyphen ภายในคำ กันเลี่ยง guardrail ด้วยการแทรกช่องว่าง
 *   เช่น "คืน​เงิน" / "ค ื น เ ง ิ น" → "คืนเงิน"
 */
// whitespace + zero-width (U+200B..U+200D) + BOM (U+FEFF) + soft hyphen (U+00AD)
const STRIP_FOR_MATCH_RE = /[\s​-‍﻿­]/g;
function normalizeForMatch(s: string): string {
  return s.replace(STRIP_FOR_MATCH_RE, "");
}

/**
 * true เมื่อบริบท "ลบพอ" ที่จะใช้ keyword ประกอบการยกระดับได้ (C-04)
 *   ยึด sentiment==negative เป็นหลัก — ไม่ยกระดับเพียงเพราะมี facts/evidence array ไม่ว่าง
 *   (กัน over-escalate: การมีข้อเท็จจริง/หลักฐานไม่ได้แปลว่าเป็นเรื่องร้องเรียนเชิงลบ)
 */
function hasNegativeContext(o: AiOutput): boolean {
  return o.sentiment === "negative";
}

/** นับ keyword เสี่ยงที่พบในข้อความรวม (summary + facts + evidence quotes) */
export function countRiskKeywords(o: AiOutput): { hits: string[] } {
  const haystack = [
    o.summary,
    o.urgency_reason,
    ...o.customer_facts,
    ...o.evidence.map((e) => `${e.claim} ${e.quote}`),
  ]
    .join(" ")
    .toLowerCase();
  const hits = RISK_KEYWORDS.filter((k) => haystack.includes(k.toLowerCase()));
  return { hits };
}

/** ยกระดับ urgency ขึ้น (positive < medium < high < critical) */
function raiseUrgency(current: Urgency, to: Urgency): Urgency {
  const rank: Record<Urgency, number> = {
    positive: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return rank[to] > rank[current] ? to : current;
}

/**
 * ใช้ guardrail ทั้งหมดกับผลลัพธ์ AI
 * @returns output ที่ปรับแล้ว + needsHumanReview + รายการ violation (สำหรับ log/debug)
 */
export function applyGuardrails(input: AiOutput): GuardrailResult {
  const output: AiOutput = {
    ...input,
    customer_facts: [...input.customer_facts],
    ai_assumptions: [...input.ai_assumptions],
    evidence: [...input.evidence],
    categories: [...input.categories],
  };
  const violations: string[] = [];
  let needsHumanReview = false;

  // --- C-01/C-02: ตรวจ draft_reply หาคำรับปากผูกมัด ---
  //   ตรวจทั้งข้อความดิบและข้อความ normalize (กันเลี่ยงด้วยเว้นวรรค/zero-width)
  const reply = output.draft_reply ?? "";
  const replyNorm = normalizeForMatch(reply);
  for (const { re, reason } of FORBIDDEN_REPLY_PATTERNS) {
    if (re.test(reply) || re.test(replyNorm)) {
      violations.push(reason);
    }
  }
  if (violations.length > 0) {
    // ตัดร่างที่ผิด guardrail ทิ้ง → บังคับมนุษย์ร่างใหม่
    output.draft_reply = "";
    needsHumanReview = true;
  }

  // --- C-03: ชี้ผิดพนักงานต้องมี evidence ---
  const hasBlameAssumption = output.ai_assumptions.some(
    (a) => BLAME_PATTERNS.test(a) && FAULT_PATTERNS.test(a)
  );
  if (hasBlameAssumption && output.evidence.length === 0) {
    violations.push("ชี้ว่าพนักงานผิดโดยไม่มี evidence (C-03)");
    needsHumanReview = true;
  }

  // --- C-04: keyword เสี่ยง + บริบท → ยกระดับ (ไม่ตัดสินจาก keyword เดี่ยว) ---
  const { hits } = countRiskKeywords(output);
  if (hits.length > 0 && hasNegativeContext(output)) {
    const before = output.urgency;
    output.urgency = raiseUrgency(output.urgency, "high");
    if (output.urgency !== before) {
      violations.push(
        `ยกระดับเป็น ${output.urgency} จาก keyword เสี่ยง [${hits.join(", ")}] + บริบทลบ (C-04)`
      );
    }
  }
  // keyword พบแต่ไม่มีบริบทลบ → ไม่ยกระดับ (เคารพ C-04: ห้ามตัดสินจาก keyword เดี่ยว)

  return { output, needsHumanReview, violations };
}
