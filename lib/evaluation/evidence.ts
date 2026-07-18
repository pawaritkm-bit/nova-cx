/**
 * สร้าง evaluation_evidence จาก signal (Phase 4) — ★ ฟังก์ชันบริสุทธิ์
 *   หลักฐานต้องอ้าง "ข้อเท็จจริง" จากเคส (เวลา/สถานะ/ข้อความ) แยก gain (ทำได้ดี) vs loss (ต้องปรับ)
 *   ★ ไม่สร้าง evidence เชิงลบจาก "จำนวนข้อความ" — อิงคุณภาพ/ตรงเวลา/ผลลัพธ์เท่านั้น
 */
import { businessMinutesBetween } from "./business-hours";
import type { CaseSignal } from "./scoring";

export type EvidenceItem = {
  chat_message_id: string | null;
  dimension: string;
  impact: "gain" | "loss";
  note: string;
  sent_at: string | null;
};

const CLOSED = new Set(["resolved", "closed"]);

export type BuildEvidenceOpts = {
  firstResponseTargetMinutes: number;
  holidays?: ReadonlySet<string>;
};

/** สร้างหลักฐานต่อเคส (sla/ownership/resolution/sop) */
export function buildEvidence(cases: CaseSignal[], opts: BuildEvidenceOpts): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  const holidays = opts.holidays ?? new Set<string>();

  for (const c of cases) {
    // --- SLA ---
    if (c.firstRespondedAt) {
      const mins = businessMinutesBetween(new Date(c.requestAt), new Date(c.firstRespondedAt), holidays);
      out.push({
        chat_message_id: c.firstResponseMessageId ?? null,
        dimension: "sla",
        impact: mins <= opts.firstResponseTargetMinutes ? "gain" : "loss",
        note:
          mins <= opts.firstResponseTargetMinutes
            ? `ตอบครั้งแรกภายใน ${mins} นาทีทำการ (ทันเป้าหมาย)`
            : `ตอบครั้งแรกใช้ ${mins} นาทีทำการ (เกินเป้าหมาย ${opts.firstResponseTargetMinutes} นาที)`,
        sent_at: c.firstRespondedAt,
      });
    } else {
      out.push({
        chat_message_id: null,
        dimension: "sla",
        impact: "loss",
        note: "ยังไม่พบการตอบรับครั้งแรกในบทสนทนา",
        sent_at: null,
      });
    }

    // --- resolution ---
    if (CLOSED.has(c.status)) {
      out.push({
        chat_message_id: null,
        dimension: "resolution",
        impact: "gain",
        note: "ปิดงานเรียบร้อย",
        sent_at: c.closedAt,
      });
    } else if (c.reopened) {
      out.push({
        chat_message_id: null,
        dimension: "resolution",
        impact: "loss",
        note: "เคสถูกเปิดใหม่ (reopened) — ปิดงานยังไม่สมบูรณ์",
        sent_at: null,
      });
    }

    // --- ownership ---
    if (!c.hasOwner) {
      out.push({
        chat_message_id: null,
        dimension: "ownership",
        impact: "loss",
        note: "ไม่มีผู้รับผิดชอบชัดเจนในเคสนี้",
        sent_at: null,
      });
    }

    // --- SOP ---
    for (const v of c.sopViolations) {
      out.push({
        chat_message_id: null,
        dimension: "sop",
        impact: "loss",
        note: `พบประเด็นผิดมาตรฐานระดับ ${v.severity}`,
        sent_at: null,
      });
    }
  }

  return out;
}
