import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { canAccessChatViewer } from "@/lib/chat-dashboard/access";
import { getEvaluationDetail, EVAL_DIMENSIONS } from "@/lib/chat-dashboard/evaluation-detail";
import ChatAuditFrame from "../../_Frame";
import ReviewActions from "./ReviewActions";

export const dynamic = "force-dynamic";
const DEV_FALLBACK = process.env.NODE_ENV !== "production";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function toList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? String((x as Record<string, unknown>).text ?? (x as Record<string, unknown>).note ?? JSON.stringify(x)) : String(x)))
    .filter(Boolean);
}

export default async function EvaluationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-eval" role={null} authed={false} title="ประเมินนักบัญชี" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล</div>
      </ChatAuditFrame>
    );
  }

  const db = await createClient();
  const viewer = await resolveEvalViewer(db);

  // ★ guard เบื้องต้น (accountant/lead/privileged เข้าหน้าประเมินได้; RLS + access คุมข้อมูลจริง)
  if (!viewer.role && !DEV_FALLBACK) redirect(`/login?redirect=/chat-audit/evaluations/${id}`);
  if (!viewer.role || (!canAccessChatViewer(viewer.role) && viewer.role !== "hr")) {
    return (
      <ChatAuditFrame active="chat-eval" role={viewer.role} authed={!!viewer.role} title="ประเมินนักบัญชี" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card"><p style={{ fontWeight: 700 }}>คุณไม่มีสิทธิ์เข้าถึงหน้านี้</p></div>
      </ChatAuditFrame>
    );
  }

  let detail;
  try {
    detail = await getEvaluationDetail(db, viewer, id);
  } catch {
    return (
      <ChatAuditFrame active="chat-eval" role={viewer.role} authed={!!viewer.role} title="ประเมินนักบัญชี" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0035)</div>
      </ChatAuditFrame>
    );
  }

  // ★ RLS คืน 0 แถวเมื่อไม่มีสิทธิ์ → detail = null (default-deny)
  if (!detail) {
    return (
      <ChatAuditFrame active="chat-eval" role={viewer.role} authed={!!viewer.role} title="ประเมินนักบัญชี" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card"><p style={{ fontWeight: 700 }}>ไม่พบผลประเมิน หรือคุณไม่มีสิทธิ์เข้าถึง</p><p className="muted" style={{ fontSize: 13 }}><Link href="/chat-audit" className="underline">← กลับ</Link></p></div>
      </ChatAuditFrame>
    );
  }

  const ev = detail.evaluation;
  const dims = (ev.dimension_scores ?? {}) as Record<string, unknown>;
  const overall = num(ev.overall_score);
  const strengths = toList(ev.strengths);
  const improvements = toList(ev.improvements);
  const betterExamples = toList(ev.better_examples);
  const ringColor = overall !== null && overall >= 70 ? "var(--green)" : "var(--amber)";

  return (
    <ChatAuditFrame
      active="chat-eval"
      role={viewer.role}
      authed={!!viewer.role}
      title="ประเมินนักบัญชี"
      subtitle={`${detail.employeeName} · สถานะ ${ev.status} · คะแนนเต็ม 100 แบ่ง 8 มิติ`}
    >
      <div className="dash-views">
        <div className="note-box danger">
          <b>⚖️ AI ไม่ใช้ลงโทษอัตโนมัติ</b> — คะแนนนี้เป็นเพียงข้อเสนอของ AI พร้อมหลักฐาน <b>หัวหน้าต้องตรวจและยืนยันก่อนเสมอ</b> และนักบัญชีมีสิทธิ์อุทธรณ์
        </div>

        <div className="grid-2">
          <section className="card">
            <div className="section-title"><span>คะแนนรวม (AI เสนอ)</span></div>
            <div className="score-hero">
              <div className="score-ring" style={{ background: `conic-gradient(${ringColor} 0 ${overall ?? 0}%, #e2e8f0 ${overall ?? 0}% 100%)` }}>
                <div className="inner"><div className="num" style={{ color: ringColor }}>{overall !== null ? Math.round(overall) : "—"}</div><div className="den">/ 100</div></div>
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div className="pill-list" style={{ marginBottom: 8 }}>
                  {overall !== null && overall < 70 ? <span className="badge b-orange">ต่ำกว่าเกณฑ์ (70)</span> : <span className="badge b-green">ผ่านเกณฑ์</span>}
                  {ev.confidence !== null ? <span className="badge b-blue">ความมั่นใจ AI: {Math.round((ev.confidence ?? 0) * 100)}%</span> : null}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>ขอบเขต: {ev.scope}{ev.needs_review ? " · รอหัวหน้ายืนยัน" : ""}</div>
              </div>
            </div>

            <hr className="hr" />
            <div className="section-title" style={{ fontSize: 14 }}>คะแนนแยก 8 มิติ <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>(คะแนน 0–100 · ตัวเลขคือน้ำหนัก%)</span></div>
            {EVAL_DIMENSIONS.map((dim, i) => {
              const raw = num(dims[dim.key]);
              const weight = detail.weights[dim.key] ?? 0;
              const low = raw !== null && raw < 60;
              return (
                <div className="dim-row" key={dim.key}>
                  <div className="dname">{i + 1}. {dim.label} <small>น้ำหนัก {weight}</small></div>
                  <div className="bar-track"><div className={`bar-fill${low ? " bad" : raw !== null && raw < 75 ? " low" : ""}`} style={{ width: `${raw ?? 0}%` }} /></div>
                  <div className="dscore">{raw !== null ? Math.round(raw) : "—"}/100</div>
                </div>
              );
            })}
          </section>

          <section className="card">
            <div className="section-title"><span>หลักฐาน & ข้อเสนอแนะ</span></div>
            {strengths.map((s, i) => <div className="fb pos" key={`s${i}`}><span className="fb-tag">✅ ทำได้ดี</span><p>{s}</p></div>)}
            {improvements.map((s, i) => <div className="fb neg" key={`i${i}`}><span className="fb-tag">⚠️ ควรปรับ</span><p>{s}</p></div>)}
            {betterExamples.map((s, i) => <div className="fb better" key={`b${i}`}><span className="fb-tag">💬 ตัวอย่างคำตอบที่ดีกว่า</span><p>{s}</p></div>)}
            {strengths.length + improvements.length + betterExamples.length === 0 ? <p className="empty">ยังไม่มีข้อเสนอแนะ</p> : null}

            {detail.canSeeEvidence && detail.evidence.length > 0 ? (
              <>
                <hr className="hr" />
                <div className="section-title" style={{ fontSize: 14 }}>หลักฐานอ้างอิง (จากแชต)</div>
                {detail.evidence.slice(0, 12).map((e) => (
                  <div className="kv" key={e.id}>
                    <span className="k"><span className={`badge ${e.impact === "gain" ? "b-green" : "b-orange"}`}>{e.impact === "gain" ? "ได้แต้ม" : "หักแต้ม"}</span></span>
                    <span>{e.note ?? "—"} {e.sent_at ? <span className="muted">· {new Date(e.sent_at).toLocaleString("th-TH")}</span> : null}</span>
                  </div>
                ))}
              </>
            ) : null}

            <hr className="hr" />
            {/* ★ ปุ่ม review/appeal — สิทธิ์บังคับที่ API เดิม */}
            <ReviewActions evaluationId={ev.id} canReview={detail.canReview} canAppeal={detail.canAppealNow} />
          </section>
        </div>

        {detail.reviews.length > 0 || detail.appeals.length > 0 ? (
          <section className="card">
            <div className="section-title"><span>ประวัติการตัดสิน / อุทธรณ์</span></div>
            {detail.reviews.map((r) => (
              <div className="kv" key={r.id}>
                <span className="k">{new Date(r.reviewed_at).toLocaleDateString("th-TH")}</span>
                <span>หัวหน้า <b>{r.action === "confirm" ? "ยืนยัน" : r.action === "edit" ? "แก้ไข" : "ยกเลิก"}</b>{r.adjusted_overall !== null ? ` → ${Math.round(r.adjusted_overall)}` : ""} {r.note ? `· ${r.note}` : ""}</span>
              </div>
            ))}
            {detail.appeals.map((ap) => (
              <div className="kv" key={ap.id}>
                <span className="k">{new Date(ap.created_at).toLocaleDateString("th-TH")}</span>
                <span>อุทธรณ์ (<b>{ap.status}</b>): {ap.reason}{ap.manager_response ? ` · หัวหน้าตอบ: ${ap.manager_response}` : ""}</span>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </ChatAuditFrame>
  );
}
