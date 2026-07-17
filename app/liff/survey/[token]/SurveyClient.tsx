"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isAnswered } from "@/lib/survey/submit";
import {
  buildSteps,
  type ApiTemplate,
  type Option,
  type Question,
  type Reference,
  type Step,
} from "@/lib/survey/steps";
import { oaForSurveyType } from "@/lib/line/routing";
import {
  LIFF_TOKEN_STORAGE_KEY,
  extractLiffToken,
  getBestEffortLineUserId,
  hasOAuthReturnParams,
  resolveSurveyToken,
  type LiffClient,
} from "@/lib/line/liff";
import NovaMascot from "./NovaMascot";
import "./liff.css";

/**
 * LIFF Survey wizard (step-by-step) — render จาก API จริง
 *   - โหลด template ตาม token → render ทีละส่วน (ไม่มีหน้า review — FR)
 *   - conditional follow-up ตามคะแนน + "ยังไม่พบปัญหา" เลือกเดี่ยว
 *   - auto-save คำตอบลง localStorage (กันหลุด/เน็ตช้า)
 *   - submit → /api/survey/submit → หน้า confirmation
 *   - LINE LIFF init แบบ best-effort (ไม่มี env = dev mode, ไม่ crash)
 *   - ⚠️ ห้าม redirect ไป LINE Login: token คือตัวยืนยันสิทธิ์ — LIFF ใช้แค่ดึง profile
 *     ถ้ามี (ไม่มีก็ตอบได้ปกติ). login() ทำให้ ?token= หลุด → "ไม่พบลิงก์แบบประเมิน"
 */

// ---- โครง schema/step ย้ายไป lib/survey/steps.ts (เพื่อ unit test buildSteps ได้) ----
type AnswerValue = number | string | string[] | null;
type Answers = Record<string, AnswerValue>;

// ใช้ LiffClient จาก lib/line/liff (subset ที่ใช้จริง — ไม่มี login โดยเจตนา)
declare global {
  interface Window {
    liff?: LiffClient;
  }
}

const LIFF_SDK_URL = "https://static.line-scdn.net/liff/edge/2/sdk.js";

/**
 * โหลด LIFF SDK แบบครั้งเดียว (idempotent) แล้ว resolve เมื่อพร้อมใช้
 *   - ถ้า window.liff มีอยู่แล้ว = resolve ทันที (ไม่ยัด script ซ้ำ)
 *   - ถ้า script ถูกฝังไว้แล้ว = รอ onload ของตัวเดิม
 * แยกเป็น helper เพื่อให้ boot() (เฟสโหลดเดียว) await ได้ตรง ๆ
 */
function loadLiffSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    if (window.liff) return resolve();

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${LIFF_SDK_URL}"]`
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("liff sdk load error")),
        { once: true }
      );
      return;
    }

    const script = document.createElement("script");
    script.src = LIFF_SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("liff sdk load error"));
    document.body.appendChild(script);
  });
}

export default function SurveyClient({
  token: initialToken,
  liffCareId,
  liffSaleId,
  devMode,
}: {
  // token อาจเป็น null: หน้า base /liff/survey อาจ render โดยยังไม่มี token
  // (เพิ่งกลับจาก OAuth) แล้วให้ client กู้จาก sessionStorage
  token: string | null;
  liffCareId: string | null;
  liffSaleId: string | null;
  devMode: boolean;
}) {
  // token ที่ใช้จริง (กู้แล้ว) + สถานะว่ากู้เสร็จหรือยัง
  const [token, setToken] = useState<string | null>(
    () => initialToken?.trim() || null
  );
  const [tokenResolved, setTokenResolved] = useState<boolean>(
    () => Boolean(initialToken?.trim())
  );
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

  const storageKey = token ? `nova-cx:survey:${token}` : "";

  // ---- กู้/ยืนยัน token (กัน "ไม่พบลิงก์แบบประเมิน" จาก OAuth redirect เดิม) ----
  // 1) มี token (props/URL) → เก็บลง sessionStorage เป็น safety net
  // 2) ไม่มี token แต่ URL มีร่องรอย OAuth (code/state/liffRedirectUri) → กู้จาก storage
  //    (เป้าหลักคือไม่ให้เกิด OAuth redirect ตั้งแต่แรกอยู่แล้ว — นี่คือกันเหนียว legacy/edge)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const initial = initialToken?.trim() || null;

    if (initial) {
      try {
        window.sessionStorage.setItem(LIFF_TOKEN_STORAGE_KEY, initial);
      } catch {
        // ignore storage error (private mode ฯลฯ)
      }
      setToken(initial);
      setTokenResolved(true);
      return;
    }

    const url = new URL(window.location.href);

    // กันเหนียว: ถ้า server ไม่ได้ส่ง token มา (edge) ลองแยกจาก URL ปัจจุบันเองก่อน
    // — สำคัญ: ต้องแยก token จาก liff.state ให้ได้ "ก่อน" effect ลบ liff.state ทิ้ง
    //   (ไม่งั้น token หายก่อนใช้). extractLiffToken รองรับทั้ง ?token= และ liff.state
    //   ทุกรูปแบบ (path-style "/{token}" และ query-style "?token={token}")
    const fromUrl = extractLiffToken({
      token: url.searchParams.get("token") ?? undefined,
      liffState: url.searchParams.get("liff.state") ?? undefined,
    });
    if (fromUrl) {
      try {
        window.sessionStorage.setItem(LIFF_TOKEN_STORAGE_KEY, fromUrl);
      } catch {
        // ignore storage error
      }
      setToken(fromUrl);
      setTokenResolved(true);
      return;
    }

    const isOAuthReturn = hasOAuthReturnParams({
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      liffRedirectUri: url.searchParams.get("liffRedirectUri"),
    });
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(LIFF_TOKEN_STORAGE_KEY);
    } catch {
      // ignore
    }
    setToken(
      resolveSurveyToken({ initialToken: initial, storedToken: stored, isOAuthReturn })
    );
    setTokenResolved(true);
  }, [initialToken]);

  // ---- กัน loader วิ่ง 2 รอบ ----
  // LINE เปิดหน้า base /liff/survey?liff.state=%2F<token> ก่อนเสมอ (หน้านี้ render loader รอบ 1)
  // แล้ว liff.init() จะ redirect ตาม liff.state ไป /liff/survey/<token> → remount → loader รอบ 2
  // แก้: ลบ liff.state ออกจาก URL แบบ client-side (history.replaceState, ไม่ full navigation)
  // ก่อน liff.init() ทำงาน → SDK ไม่ redirect → เหลือ loader รอบเดียว ลื่น ๆ
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!token) return; // ยังไม่มี token → ยังไม่ต้องจัดการ URL
    const url = new URL(window.location.href);
    if (!url.searchParams.has("liff.state")) return;
    url.searchParams.delete("liff.state");
    const qs = url.searchParams.toString();
    window.history.replaceState(
      null,
      "",
      `/liff/survey/${encodeURIComponent(token)}${qs ? `?${qs}` : ""}`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ---- โหลด template + init LIFF ใน "เฟสโหลดเดียวต่อเนื่อง" ----
  // ทำไมรวมเป็นเฟสเดียว: เดิมแยกเป็น (1) fetch template → setLoading(false) โชว์แบบประเมิน
  //   แล้วค่อย (2) init LIFF ทีหลัง — พอ LIFF ต้อง login()/redirect หน้าจะรีโหลด → มาสคอตวิ่ง "รอบ 2"
  //   (ผู้ใช้เห็นเป็น 2 จังหวะ: วิ่ง → โผล่หน้าแบบประเมินแวบ → วิ่งใหม่)
  // แก้: คง loading=true ต่อเนื่องตั้งแต่ mount จน "template พร้อม + init LIFF เสร็จ" ค่อยเผยแบบประเมิน
  //   → <NovaMascot variant="loader"> mount ครั้งเดียว/unmount ครั้งเดียว = CSS animation วิ่งต่อเนื่องไม่รีสตาร์ท
  useEffect(() => {
    if (!token) return; // ยังไม่มี token → รอ effect กู้ token ก่อน (หรือจะโชว์ "ไม่พบ")
    const activeToken = token; // narrow ให้แน่ (ใช้ใน closure ด้านล่าง)
    let cancelled = false;

    // best-effort init LIFF → คืน lineUserId (หรือ null); มี timeout กัน SDK ค้างทำ loader ค้าง
    async function initLiffUserId(surveyType: ApiTemplate["survey_type"]) {
      if (devMode) return null;
      const oa = oaForSurveyType(surveyType);
      const liffId = oa === "sale" ? liffSaleId : liffCareId;
      if (!liffId) return null;

      const run = async (): Promise<string | null> => {
        try {
          await loadLiffSdk();
          const liff = window.liff;
          if (!liff) return null;
          await liff.init({ liffId });
          // ⚠️ ห้ามเรียก liff.login()/redirect: แบบประเมินยืนยันสิทธิ์ด้วย token
          // ถ้ายังไม่ล็อกอิน → getBestEffortLineUserId คืน null แล้วตอบผ่าน token ต่อได้
          return await getBestEffortLineUserId(liff);
        } catch {
          return null; // LIFF ล้ม → ปล่อยเป็น dev-like (ยังตอบได้ผ่าน token)
        }
      };

      // ถ้า init ช้า/ค้างเกิน 6s → เผยแบบประเมินไปก่อน (best-effort) ยังตอบผ่าน token ได้
      const timeout = new Promise<string | null>((resolve) =>
        setTimeout(() => resolve(null), 6000)
      );
      return Promise.race([run(), timeout]);
    }

    async function boot() {
      // 1) โหลดคำตอบที่ค้างจาก localStorage (auto-save)
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) setAnswers(JSON.parse(saved) as Answers);
      } catch {
        // ignore storage error
      }

      // 2) โหลด template
      let tpl: ApiTemplate | null = null;
      try {
        const res = await fetch(
          `/api/liff/survey/${encodeURIComponent(activeToken)}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data?.message ?? "โหลดแบบประเมินไม่สำเร็จ");
          setLoading(false);
          return;
        }
        tpl = data as ApiTemplate;
      } catch {
        if (!cancelled) {
          setLoadError("เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่");
          setLoading(false);
        }
        return;
      }

      // 3) init LIFF ในเฟสเดียวกัน (รู้ survey_type แล้วจึงเลือก OA/LIFF id ได้ถูก)
      const uid = await initLiffUserId(tpl.survey_type);
      if (cancelled) return;
      if (uid) setLineUserId(uid);

      // 4) เผยแบบประเมิน "ครั้งเดียว" — loader หายไปตรงนี้จุดเดียว
      setTemplate(tpl);
      setLoading(false);
    }

    boot();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ---- auto-save ----
  useEffect(() => {
    if (!storageKey) return; // ยังไม่มี token → ยังไม่ต้อง save
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
  // กู้ token ไม่ได้จริง (ไม่มีทั้ง props/URL และ sessionStorage) → โชว์ "ไม่พบ" ฝั่ง client
  if (tokenResolved && !token) {
    return (
      <Centered>
        <div className="warn-text" style={{ fontWeight: 600 }}>
          ไม่พบลิงก์แบบประเมิน
        </div>
        <div className="nova-loading-sub">
          กรุณาเปิดแบบประเมินจากลิงก์ที่ได้รับใน LINE อีกครั้งค่ะ
        </div>
      </Centered>
    );
  }
  if (loading) {
    // หน้าโหลด: น้อง NOVA วิ่ง (พอร์ตจาก prototype loaderScene) + ข้อความ
    return (
      <Centered>
        <NovaMascot variant="loader" width={150} />
        <div className="nova-loading-text">น้อง NOVA กำลังเตรียมแบบประเมิน…</div>
        <div className="nova-loading-sub">ขอเวลาแป๊บเดียวนะคะ</div>
      </Centered>
    );
  }
  if (loadError) {
    return (
      <Centered>
        <div className="warn-text" style={{ fontWeight: 600 }}>
          {loadError}
        </div>
      </Centered>
    );
  }
  if (submitted) {
    return (
      <Centered>
        <NovaMascot variant="full" width={150} />
        <div className="confirm-title">ขอบคุณมากค่ะ 🙏</div>
        <div className="confirm-sub">
          น้อง NOVA รับเรื่องเรียบร้อยแล้ว
          <br />
          ความคิดเห็นของคุณช่วยให้เราดูแลคุณได้ดีขึ้นค่ะ
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

  const progressPct = Math.round(((stepIndex + 1) / steps.length) * 100);

  return (
    <div className="liff-survey">
      <div className="liff-shell">
        {/* header แบรนด์ Finovas (navy) */}
        <header className="liff-header">
          <div className="liff-title">
            <span className="dot" />
            {template.schema.title ?? "แบบประเมิน • น้อง NOVA"}
          </div>
        </header>

        <main className="liff-body">
          {/* progress step */}
          <div className="progress-wrap">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="progress-time">
              {isLast ? "พร้อมส่ง" : `~${Math.max(1, steps.length - stepIndex - 1)} นาที`}
            </span>
          </div>
          <p className="step-meta">
            ขั้น {stepIndex + 1}/{steps.length}
          </p>

          {stepIndex === 0 && template.schema.intro && (
            <p className="form-intro">{template.schema.intro}</p>
          )}

          <h2 className="step-title">{step.title}</h2>

          {step.ref && <ReferenceCard reference={step.ref} />}

          {/* Form B หน้าดาว: แสดงคำถาม "แยกการ์ดต่อคน" (ทุกคนในหน้าเดียว) */}
          {step.groups && step.groups.length > 0 ? (
            <div>
              {step.groups.map((group) => (
                <div className="subject-group" key={group.subjectName}>
                  <SubjectHeader name={group.subjectName} />
                  {group.questions.map((q) => (
                    <QuestionField
                      key={q.code}
                      question={q}
                      value={answers[q.code] ?? null}
                      onChange={(v) => setAnswer(q.code, v)}
                      onToggleMulti={(val) => toggleMulti(q, val)}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div>
              {step.questions.map((q) => (
                <QuestionField
                  key={q.code}
                  question={q}
                  value={answers[q.code] ?? null}
                  onChange={(v) => setAnswer(q.code, v)}
                  onToggleMulti={(val) => toggleMulti(q, val)}
                />
              ))}
            </div>
          )}

          {showRequiredWarn && !stepComplete && (
            <p className="warn-text">
              กรุณาตอบคำถามที่มีคะแนน (จำเป็น) ให้ครบก่อนดำเนินการต่อ
            </p>
          )}

          {/* consent PDPA จริง (ต้องติ๊กก่อนส่ง — ไม่ hardcode) */}
          {isLast && (
            <div className="consent-box">
              <label>
                <input
                  type="checkbox"
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

          {submitError && <p className="warn-text">{submitError}</p>}
        </main>

        {/* footer nav */}
        <footer className="liff-footer">
          <button
            type="button"
            className="btn btn-ghost"
            style={{ flex: "0 0 auto" }}
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={stepIndex === 0 || submitting}
          >
            ← ย้อนกลับ
          </button>
          {isLast ? (
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={onSubmitClick}
              disabled={!canSubmit}
            >
              {submitting ? "กำลังส่ง…" : "ส่งแบบประเมิน ✓"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={goNext}
              disabled={!canProceed}
            >
              ถัดไป →
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

// ==========================================================================
// ส่วนย่อย
// ==========================================================================

function Centered({ children }: { children: React.ReactNode }) {
  // ครอบด้วย .liff-survey เพื่อให้ CSS var/สไตล์ prototype มีผล (loading/error/submitted)
  return (
    <div className="liff-survey">
      <div className="center-col">{children}</div>
    </div>
  );
}

function ReferenceCard({ reference }: { reference: NonNullable<Reference> }) {
  return (
    <div className="ref-card">
      <div className="ref-lock">🔒 ข้อมูลนี้ดึงให้อัตโนมัติ ไม่ต้องกรอกซ้ำ</div>
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
    <div className="ref-row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

/** หัวการ์ดต่อคน (Form B หน้าดาว) — บอกชัดว่ากำลังให้ดาวใคร */
function SubjectHeader({ name }: { name: string }) {
  return (
    <div className="ref-card subject-head">
      <div className="ref-lock">กำลังให้คะแนน</div>
      <div className="ref-row">
        <span className="v" style={{ textAlign: "left" }}>
          {name}
        </span>
      </div>
    </div>
  );
}

function QuestionField({
  question,
  value,
  onChange,
  onToggleMulti,
}: {
  question: Question;
  value: AnswerValue;
  onChange: (v: AnswerValue) => void;
  onToggleMulti: (optionValue: string) => void;
}) {
  const scale = question.scale ?? 5;

  return (
    <div className="q-block">
      <div className="q-title">{question.text}</div>

      {question.type === "rating" && (
        <RatingStars
          scale={scale}
          value={typeof value === "number" ? value : null}
          options={question.options}
          onChange={onChange}
        />
      )}

      {question.type === "nps" && (
        <div className="nps">
          {Array.from({ length: 11 }, (_, i) => i).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              className={`nps-btn${value === n ? " sel" : ""}`}
            >
              {n}
            </button>
          ))}
        </div>
      )}

      {question.type === "single" && (
        <div className="chips">
          {(question.options ?? []).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={`chip${value === o.value ? " sel" : ""}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      {question.type === "multi" && (
        <div className="chips">
          {(question.options ?? []).map((o) => {
            const arr = Array.isArray(value) ? value : [];
            const active = arr.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onToggleMulti(o.value)}
                className={`chip${o.is_exclusive ? " exclusive" : ""}${active ? " sel" : ""}`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}

      {question.type === "open" && (
        <textarea
          className="txtin"
          rows={3}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="พิมพ์ความเห็นของคุณ…"
        />
      )}
      {/* หมายเหตุ: ตัด conditional follow-up ปลายเปิดต่อดาวออกแล้ว (ตาม feedback ผู้ใช้)
          เหลือช่องความเห็นช่องเดียวท้ายแบบประเมิน (open_questions → step สุดท้าย) */}
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

/* ดาวมุมมน (rounded star) — path เดียวกับ prototype (assets/mascot star)
   สี fill+stroke = currentColor คุมด้วย CSS .star / .star.on (stroke-linejoin round) */
function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">
      <path d="M12 2.6l2.72 5.51 6.08.88-4.4 4.29 1.04 6.06L12 16.48 6.56 19.34l1.04-6.06-4.4-4.29 6.08-.88z" />
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
    <div className="star-rating">
      <div className="stars" role="radiogroup" aria-label="ให้คะแนนความพึงพอใจ">
        {stars.map((n) => {
          const on = value !== null && n <= value; // เติมสีถึงดาวที่เลือก
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              aria-label={`${n} ดาว — ${ratingLabel(n, options)}`}
              onClick={() => onChange(n)}
              className={`star${on ? " on" : ""}`}
            >
              <StarIcon />
            </button>
          );
        })}
      </div>
      <span className={`star-label${value !== null ? " chosen" : ""}`} aria-live="polite">
        {value !== null
          ? `${value} ★ · ${ratingLabel(value, options)}`
          : "แตะดาวเพื่อให้คะแนน"}
      </span>
    </div>
  );
}

// buildSteps + โครง Step/Question ย้ายไป lib/survey/steps.ts (unit-testable)
