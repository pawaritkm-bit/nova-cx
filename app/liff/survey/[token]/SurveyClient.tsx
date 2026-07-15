"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ratingFollowup,
  type Followup,
} from "@/lib/survey/conditional";
import { isAnswered } from "@/lib/survey/submit";
import { oaForSurveyType } from "@/lib/line/routing";

/**
 * LIFF Survey wizard (step-by-step) — render จาก API จริง
 *   - โหลด template ตาม token → render ทีละส่วน (ไม่มีหน้า review — FR)
 *   - conditional follow-up ตามคะแนน + "ยังไม่พบปัญหา" เลือกเดี่ยว
 *   - auto-save คำตอบลง localStorage (กันหลุด/เน็ตช้า)
 *   - submit → /api/survey/submit → หน้า confirmation
 *   - LINE LIFF init แบบ best-effort (ไม่มี env = dev mode, ไม่ crash)
 */

// ---- โครง schema (หลวม — มาจาก API) ----
type Option = { value: string; label: string; is_exclusive?: boolean };
type Question = {
  code: string;
  text?: string;
  type: "rating" | "single" | "multi" | "open" | "nps";
  scale?: number;
  options?: Option[];
};
type Section = {
  code?: string;
  title?: string;
  auto_fill?: boolean;
  questions?: Question[];
};
type SchemaJson = {
  title?: string;
  intro?: string;
  estimated_minutes?: number;
  sections?: Section[];
  question_sets?: Record<string, Question[]>;
  open_questions?: Question[];
};
type Reference = {
  customer_code: string | null;
  name: string;
  business_name: string | null;
  service_start_date: string | null;
} | null;
type Subject = { employee_id?: string; name?: string; subject_role?: string };

type ApiTemplate = {
  token: string;
  survey_type: "A" | "B" | "C" | "D";
  survey_slug: string;
  schema: SchemaJson;
  reference: Reference;
  subjects: Subject[];
};

type AnswerValue = number | string | string[] | null;
type Answers = Record<string, AnswerValue>;

type Step = { title: string; questions: Question[]; ref?: Reference };

type LiffLike = {
  init: (config: { liffId: string }) => Promise<void>;
  isLoggedIn: () => boolean;
  login: () => void;
  getProfile: () => Promise<{ userId: string }>;
};
declare global {
  interface Window {
    liff?: LiffLike;
  }
}

const LIFF_SDK_URL = "https://static.line-scdn.net/liff/edge/2/sdk.js";

export default function SurveyClient({
  token,
  liffCareId,
  liffSaleId,
  devMode,
}: {
  token: string;
  liffCareId: string | null;
  liffSaleId: string | null;
  devMode: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [template, setTemplate] = useState<ApiTemplate | null>(null);
  const [lineUserId, setLineUserId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [showRequiredWarn, setShowRequiredWarn] = useState(false);

  const storageKey = `nova-cx:survey:${token}`;

  // ---- โหลด template จาก API + init LIFF ----
  useEffect(() => {
    let cancelled = false;

    async function boot() {
      // 1) โหลดคำตอบที่ค้างจาก localStorage (auto-save)
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) setAnswers(JSON.parse(saved) as Answers);
      } catch {
        // ignore storage error
      }

      // 2) โหลด template
      try {
        const params = new URLSearchParams();
        if (lineUserId) params.set("lineUserId", lineUserId);
        const res = await fetch(
          `/api/liff/survey/${encodeURIComponent(token)}?${params.toString()}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data?.message ?? "โหลดแบบประเมินไม่สำเร็จ");
        } else {
          setTemplate(data as ApiTemplate);
        }
      } catch {
        if (!cancelled) setLoadError("เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    boot();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ---- LIFF init (best-effort; dev mode = ข้าม) ----
  // เลือก LIFF id ตาม OA ของ invitation (A/B = Care, C/D = Sale)
  // รอ template โหลดก่อนเพื่อรู้ survey_type → ใช้ OA ที่ถูกต้อง
  useEffect(() => {
    if (devMode) return;
    if (!template) return;
    const oa = oaForSurveyType(template.survey_type);
    const liffId = oa === "sale" ? liffSaleId : liffCareId;
    if (!liffId) return;

    const script = document.createElement("script");
    script.src = LIFF_SDK_URL;
    script.async = true;
    script.onload = async () => {
      try {
        const liff = window.liff;
        if (!liff) return;
        await liff.init({ liffId });
        if (!liff.isLoggedIn()) {
          liff.login();
          return;
        }
        const profile = await liff.getProfile();
        setLineUserId(profile.userId);
      } catch {
        // LIFF init ล้ม → ปล่อยเป็น dev-like (ยังตอบได้ผ่าน token)
      }
    };
    document.body.appendChild(script);
    return () => {
      script.remove();
    };
  }, [devMode, liffCareId, liffSaleId, template]);

  // ---- auto-save ----
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(answers));
    } catch {
      // ignore
    }
  }, [answers, storageKey]);

  // ---- สร้าง steps จาก schema ----
  const steps = useMemo<Step[]>(() => {
    if (!template) return [];
    return buildSteps(template);
  }, [template]);

  const setAnswer = useCallback((code: string, value: AnswerValue) => {
    setAnswers((prev) => ({ ...prev, [code]: value }));
  }, []);

  const toggleMulti = useCallback(
    (q: Question, optionValue: string) => {
      setAnswers((prev) => {
        const current = Array.isArray(prev[q.code])
          ? (prev[q.code] as string[])
          : [];
        const opt = (q.options ?? []).find((o) => o.value === optionValue);
        const isExclusive = !!opt?.is_exclusive;
        const exclusiveVals = (q.options ?? [])
          .filter((o) => o.is_exclusive)
          .map((o) => o.value);

        let next: string[];
        if (current.includes(optionValue)) {
          next = current.filter((v) => v !== optionValue);
        } else if (isExclusive) {
          next = [optionValue]; // เลือก exclusive = ล้างที่เหลือ
        } else {
          next = [...current.filter((v) => !exclusiveVals.includes(v)), optionValue];
        }
        return { ...prev, [q.code]: next };
      });
    },
    []
  );

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/survey/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          lineUserId: lineUserId ?? undefined,
          consent: consentChecked, // consent จริงจาก checkbox (ไม่ hardcode)
          answers,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setSubmitted(true);
        try {
          window.localStorage.removeItem(storageKey);
        } catch {
          // ignore
        }
      } else if (res.status === 409) {
        setSubmitted(true); // ตอบไปแล้ว = ถือว่าจบ
      } else {
        setSubmitError(data?.message ?? "ส่งไม่สำเร็จ กรุณาลองใหม่");
      }
    } catch {
      setSubmitError("เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่");
    } finally {
      setSubmitting(false);
    }
  }

  // ---- UI states ----
  if (loading) {
    return <Centered>กำลังโหลดแบบประเมิน…</Centered>;
  }
  if (loadError) {
    return (
      <Centered>
        <div className="text-status-critical font-medium">{loadError}</div>
      </Centered>
    );
  }
  if (submitted) {
    return (
      <Centered>
        <div className="text-4xl mb-3">✅</div>
        <div className="text-lg font-semibold text-brand">ส่งแบบประเมินเรียบร้อย</div>
        <div className="text-sm text-brand/70 mt-2">
          ขอบคุณสำหรับความคิดเห็น ทีมงานจะนำไปพัฒนาบริการค่ะ
        </div>
      </Centered>
    );
  }
  if (!template || steps.length === 0) {
    return <Centered>ไม่พบเนื้อหาแบบประเมิน</Centered>;
  }

  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  // บังคับตอบคำถามหลัก (rating/nps) ในส่วนนี้ก่อนไปต่อ/ส่ง (FR-SC-04c)
  const requiredInStep = step.questions
    .filter((q) => q.type === "rating" || q.type === "nps")
    .map((q) => q.code);
  const stepComplete = requiredInStep.every((code) => isAnswered(answers[code]));
  const canProceed = stepComplete;
  const canSubmit = stepComplete && consentChecked && !submitting;

  const goNext = () => {
    if (!canProceed) {
      setShowRequiredWarn(true);
      return;
    }
    setShowRequiredWarn(false);
    setStepIndex((i) => Math.min(steps.length - 1, i + 1));
  };

  const onSubmitClick = () => {
    if (!stepComplete) {
      setShowRequiredWarn(true);
      return;
    }
    handleSubmit();
  };

  return (
    <div className="min-h-screen flex flex-col max-w-md mx-auto bg-white">
      {/* header + progress */}
      <header className="p-4 bg-brand text-white">
        <div className="text-base font-semibold">
          {template.schema.title ?? "แบบประเมิน"}
        </div>
        <div className="text-xs opacity-80 mt-1">
          ส่วนที่ {stepIndex + 1} จาก {steps.length}
        </div>
        <div className="h-1.5 bg-white/20 rounded mt-2 overflow-hidden">
          <div
            className="h-full bg-brand-light transition-all"
            style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }}
          />
        </div>
      </header>

      <main className="flex-1 p-4 overflow-y-auto">
        {stepIndex === 0 && template.schema.intro && (
          <p className="text-sm text-brand/70 mb-4">{template.schema.intro}</p>
        )}

        {template.survey_type === "B" && template.subjects.length > 0 && (
          <SubjectCard subjects={template.subjects} />
        )}

        <h2 className="text-lg font-semibold text-brand mb-3">{step.title}</h2>

        {step.ref && <ReferenceCard reference={step.ref} />}

        <div className="space-y-5">
          {step.questions.map((q) => (
            <QuestionField
              key={q.code}
              question={q}
              value={answers[q.code] ?? null}
              followupValue={answers[`${q.code}__followup`] ?? null}
              onChange={(v) => setAnswer(q.code, v)}
              onToggleMulti={(val) => toggleMulti(q, val)}
              onFollowupChange={(v) => setAnswer(`${q.code}__followup`, v)}
            />
          ))}
        </div>

        {showRequiredWarn && !stepComplete && (
          <p className="text-status-critical text-sm mt-4">
            กรุณาตอบคำถามที่มีคะแนน (จำเป็น) ให้ครบก่อนดำเนินการต่อ
          </p>
        )}

        {/* consent PDPA จริง (ต้องติ๊กก่อนส่ง — ไม่ hardcode) */}
        {isLast && (
          <div className="mt-6 bg-brand-bg rounded-lg p-3">
            <label className="flex items-start gap-2 text-sm text-brand cursor-pointer">
              <input
                type="checkbox"
                className="mt-1"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
              />
              <span>
                ข้าพเจ้ายินยอมให้เก็บและใช้ความเห็น/คะแนนนี้เพื่อปรับปรุงบริการ
                และวิเคราะห์ด้วย AI (ระบบ redact ข้อมูลอ่อนไหวก่อนประมวลผล) ตามนโยบายข้อมูลส่วนบุคคล
              </span>
            </label>
          </div>
        )}

        {submitError && (
          <p className="text-status-critical text-sm mt-4">{submitError}</p>
        )}
      </main>

      {/* footer nav */}
      <footer className="p-4 border-t flex gap-3">
        <button
          type="button"
          className="px-4 py-3 rounded-lg border border-brand/30 text-brand disabled:opacity-40"
          onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
          disabled={stepIndex === 0 || submitting}
        >
          ย้อนกลับ
        </button>
        {isLast ? (
          <button
            type="button"
            className="flex-1 px-4 py-3 rounded-lg bg-brand-light text-white font-semibold disabled:opacity-50"
            onClick={onSubmitClick}
            disabled={!canSubmit}
          >
            {submitting ? "กำลังส่ง…" : "ส่งแบบประเมิน"}
          </button>
        ) : (
          <button
            type="button"
            className="flex-1 px-4 py-3 rounded-lg bg-brand text-white font-semibold disabled:opacity-50"
            onClick={goNext}
            disabled={!canProceed}
          >
            ถัดไป
          </button>
        )}
      </footer>
    </div>
  );
}

// ==========================================================================
// ส่วนย่อย
// ==========================================================================

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 text-center">
      <div>{children}</div>
    </div>
  );
}

function ReferenceCard({ reference }: { reference: NonNullable<Reference> }) {
  return (
    <div className="bg-brand-bg rounded-lg p-3 mb-4 text-sm">
      <div className="text-xs text-brand/60 mb-1">
        🔒 ข้อมูลนี้ดึงให้อัตโนมัติ ไม่ต้องกรอกซ้ำ
      </div>
      {reference.customer_code && (
        <Row k="รหัสลูกค้า" v={reference.customer_code} />
      )}
      <Row k="ชื่อลูกค้า" v={reference.name} />
      {reference.business_name && (
        <Row k="ชื่อกิจการ" v={reference.business_name} />
      )}
      {reference.service_start_date && (
        <Row k="วันเริ่มบริการ" v={reference.service_start_date} />
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-brand/60">{k}</span>
      <span className="text-brand font-medium">{v}</span>
    </div>
  );
}

function SubjectCard({ subjects }: { subjects: Subject[] }) {
  return (
    <div className="bg-brand-bg rounded-lg p-3 mb-4 text-sm">
      <div className="text-xs text-brand/60 mb-1">ผู้ที่คุณกำลังประเมิน</div>
      <div className="text-brand font-medium">
        {subjects.map((s) => s.name ?? s.employee_id).join(", ")}
      </div>
    </div>
  );
}

function QuestionField({
  question,
  value,
  followupValue,
  onChange,
  onToggleMulti,
  onFollowupChange,
}: {
  question: Question;
  value: AnswerValue;
  followupValue: AnswerValue;
  onChange: (v: AnswerValue) => void;
  onToggleMulti: (optionValue: string) => void;
  onFollowupChange: (v: string) => void;
}) {
  const scale = question.scale ?? 5;
  const followup: Followup =
    question.type === "rating" && typeof value === "number"
      ? ratingFollowup(value)
      : null;

  return (
    <div>
      <label className="block text-brand font-medium mb-2">
        {question.text}
      </label>

      {question.type === "rating" && (
        <RatingStars
          scale={scale}
          value={typeof value === "number" ? value : null}
          options={question.options}
          onChange={onChange}
        />
      )}

      {question.type === "nps" && (
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 11 }, (_, i) => i).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              className={`w-9 h-9 rounded border text-sm ${
                value === n
                  ? "bg-brand-light text-white border-brand-light"
                  : "border-brand/30 text-brand"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      )}

      {question.type === "single" && (
        <div className="flex flex-wrap gap-2">
          {(question.options ?? []).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={`px-3 py-2 rounded-full border text-sm ${
                value === o.value
                  ? "bg-brand-light text-white border-brand-light"
                  : "border-brand/30 text-brand"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      {question.type === "multi" && (
        <div className="flex flex-wrap gap-2">
          {(question.options ?? []).map((o) => {
            const arr = Array.isArray(value) ? value : [];
            const active = arr.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onToggleMulti(o.value)}
                className={`px-3 py-2 rounded-full border text-sm ${
                  active
                    ? "bg-brand-light text-white border-brand-light"
                    : "border-brand/30 text-brand"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}

      {question.type === "open" && (
        <textarea
          className="w-full border border-brand/30 rounded-lg p-2 text-sm"
          rows={3}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="พิมพ์ความเห็นของคุณ…"
        />
      )}

      {/* conditional follow-up ปลายเปิดตามคะแนน */}
      {followup && (
        <div className="mt-2">
          <div className="text-xs text-brand/60 mb-1">
            {followup === "PRAISE"
              ? "สิ่งที่เราทำได้ดีคืออะไร?"
              : followup === "IMPROVE"
                ? "เรื่องที่อยากให้ปรับปรุง?"
                : "เกิดอะไรขึ้น อยากให้เราช่วยแก้ไขอย่างไร?"}
          </div>
          <textarea
            className="w-full border border-brand/30 rounded-lg p-2 text-sm"
            rows={2}
            value={typeof followupValue === "string" ? followupValue : ""}
            onChange={(e) => onFollowupChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

// ==========================================================================
// Rating ดาว (presentation-only — ค่าที่ส่ง/เก็บยังเป็น number 1..scale เหมือนเดิม)
// ==========================================================================

// ป้ายระดับ default (1=ไม่พอใจมาก … 5=พอใจมาก) — ใช้เมื่อ template ไม่ได้ระบุ label
const DEFAULT_RATING_LABELS: Record<number, string> = {
  1: "ไม่พอใจมาก",
  2: "ไม่พอใจ",
  3: "เฉยๆ",
  4: "พอใจ",
  5: "พอใจมาก",
};

/** หา label ของคะแนน n: ใช้จาก template options ถ้ามี (value ตรงกับเลข) ไม่งั้น default */
function ratingLabel(n: number, options?: Option[]): string {
  const opt = (options ?? []).find((o) => o.value === String(n));
  return opt?.label ?? DEFAULT_RATING_LABELS[n] ?? String(n);
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`w-8 h-8 ${filled ? "text-status-medium" : "text-brand/25"}`}
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {/* ดาวมุมมน: stroke สีเดียวกับ fill + linejoin/linecap round ให้ปลายและมุมโค้งนุ่ม */}
      <path d="M12 3.2l2.72 5.51 6.08.88-4.4 4.29 1.04 6.05L12 17.57l-5.44 2.86 1.04-6.05-4.4-4.29 6.08-.88L12 3.2z" />
    </svg>
  );
}

function RatingStars({
  scale,
  value,
  options,
  onChange,
}: {
  scale: number;
  value: number | null;
  options?: Option[];
  onChange: (v: number) => void;
}) {
  // จำนวนดาว = scale จาก template (ไม่งั้น default 5 ถูกเซ็ตไว้ที่ผู้เรียก)
  const stars = Array.from({ length: scale }, (_, i) => i + 1);
  return (
    <div>
      <div role="radiogroup" aria-label="ให้คะแนนความพึงพอใจ" className="flex gap-1">
        {stars.map((n) => {
          const filled = value !== null && n <= value; // เติมสีถึงดาวที่เลือก
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              aria-label={`${n} ดาว — ${ratingLabel(n, options)}`}
              onClick={() => onChange(n)}
              className="w-11 h-11 flex items-center justify-center rounded-lg touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
            >
              <StarIcon filled={filled} />
            </button>
          );
        })}
      </div>
      {value !== null && (
        <div className="text-xs text-brand/70 mt-1" aria-live="polite">
          {value} ดาว · {ratingLabel(value, options)}
        </div>
      )}
    </div>
  );
}

// ==========================================================================
// helper: สร้าง steps จาก schema (รองรับ sections / question_sets / open)
// ==========================================================================
function buildSteps(template: ApiTemplate): Step[] {
  const { schema, survey_type, reference } = template;
  const steps: Step[] = [];

  if (schema.sections && schema.sections.length > 0) {
    for (const section of schema.sections) {
      const questions = section.questions ?? [];
      if (section.auto_fill || section.code === "ref") {
        // ส่วนข้อมูลอ้างอิง auto-fill → step แสดงข้อมูลอย่างเดียว
        steps.push({ title: section.title ?? "ข้อมูลอ้างอิง", questions: [], ref: reference });
        continue;
      }
      if (questions.length === 0) continue;
      steps.push({ title: section.title ?? "แบบประเมิน", questions });
    }
  }

  // Form B: ใช้ question_sets.member (ลูกค้าประเมินลูกน้องที่ดูแลจริง)
  if (survey_type === "B" && schema.question_sets) {
    const memberSet = schema.question_sets.member ?? [];
    if (memberSet.length > 0) {
      steps.push({ title: "ให้คะแนนผู้ดูแล", questions: memberSet });
    }
  }

  if (schema.open_questions && schema.open_questions.length > 0) {
    steps.push({ title: "ความเห็นเพิ่มเติม", questions: schema.open_questions });
  }

  return steps;
}
