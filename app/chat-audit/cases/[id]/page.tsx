import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { canAccessChatViewer } from "@/lib/chat-dashboard/access";
import { getCaseChatView, violationLabel } from "@/lib/chat-dashboard/queries";
import ChatAuditFrame from "../../_Frame";

export const dynamic = "force-dynamic";
const DEV_FALLBACK = process.env.NODE_ENV !== "production";

/** map สถานะขั้นตอน flow → class ของ dot */
function stepDot(status: unknown): { cls: string; icon: string } {
  const s = String(status ?? "").toLowerCase();
  if (["ok", "done", "pass", "good"].includes(s)) return { cls: "ok", icon: "✓" };
  if (["bad", "fail", "missed", "violation"].includes(s)) return { cls: "bad", icon: "✕" };
  if (["warn", "partial", "warning"].includes(s)) return { cls: "warn", icon: "!" };
  return { cls: "wait", icon: "…" };
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** ขั้นตอน flow ที่ normalize แล้ว (รองรับทั้ง item เป็น string และ object) */
type FlowStep = {
  title: string;
  status: unknown;
  desc: string;
  evidence: Record<string, unknown> | null;
};

/**
 * ★ L1: normalize flow_steps — รับได้ทั้ง string array และ object array
 *   (asArray เดิม filter object ทิ้ง → flow_steps ที่เป็น string array หายทั้งชุด)
 */
function normalizeFlowSteps(v: unknown, itemLabel: (x: unknown) => string): FlowStep[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x !== null && x !== undefined)
    .map((x, i) => {
      if (typeof x === "object") {
        const o = x as Record<string, unknown>;
        return {
          title: itemLabel(o.title ?? o.step ?? o.name ?? `ขั้นที่ ${i + 1}`),
          status: o.status ?? o.state,
          desc: str(o.desc ?? o.description),
          evidence: (o.evidence ?? null) as Record<string, unknown> | null,
        };
      }
      // item เป็น string (หรืออื่น ๆ) → ใช้เป็นชื่อขั้น
      return { title: itemLabel(x), status: undefined, desc: "", evidence: null };
    });
}
/** ข้อความในรายการที่อาจเป็น string หรือ object */
function itemText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o.text ?? o.title ?? o.label ?? o.note ?? o.description ?? o.fact ?? JSON.stringify(o));
  }
  return str(v);
}
function toList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(itemText).filter(Boolean) : [];
}

export default async function ChatCaseViewerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-viewer" role={null} authed={false} title="ดูแชต + วิเคราะห์เคส" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล</div>
      </ChatAuditFrame>
    );
  }

  const db = await createClient();
  const viewer = await resolveEvalViewer(db);

  if (!viewer.role && !DEV_FALLBACK) redirect(`/login?redirect=/chat-audit/cases/${id}`);
  if (!canAccessChatViewer(viewer.role)) {
    return (
      <ChatAuditFrame active="chat-viewer" role={viewer.role} authed={!!viewer.role} title="ดูแชต + วิเคราะห์เคส" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card"><p style={{ fontWeight: 700 }}>คุณไม่มีสิทธิ์ดูเนื้อหาแชต</p><p className="muted" style={{ fontSize: 13 }}><Link href="/dashboard" className="underline">← กลับ Dashboard</Link></p></div>
      </ChatAuditFrame>
    );
  }

  let view;
  try {
    view = await getCaseChatView(db, viewer, id);
  } catch {
    return (
      <ChatAuditFrame active="chat-viewer" role={viewer.role} authed={!!viewer.role} title="ดูแชต + วิเคราะห์เคส" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0035)</div>
      </ChatAuditFrame>
    );
  }

  if (view.denied || !view.case) {
    return (
      <ChatAuditFrame active="chat-viewer" role={viewer.role} authed={!!viewer.role} title="ดูแชต + วิเคราะห์เคส" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card"><p style={{ fontWeight: 700 }}>ไม่พบเคส หรือคุณไม่มีสิทธิ์เข้าถึงเคสนี้</p><p className="muted" style={{ fontSize: 13 }}><Link href="/chat-audit" className="underline">← กลับ</Link></p></div>
      </ChatAuditFrame>
    );
  }

  const c = view.case;
  const a = view.analysis;
  const flow = normalizeFlowSteps(a?.flow_steps, itemText);
  const problems = toList(a?.problems);
  const facts = toList(a?.customer_facts);
  const assumptions = toList(a?.ai_assumptions);

  return (
    <ChatAuditFrame
      active="chat-viewer"
      role={viewer.role}
      authed={!!viewer.role}
      title="ดูแชต + วิเคราะห์เคส"
      subtitle={`${c.title ?? "เคส"} · ลูกค้า ${view.customerLabel} · ผู้ดูแล ${view.ownerName}`}
    >
      <div className="dash-views">
        <div className="note-box">
          ⏱️ ทุกการวิเคราะห์อ้างอิง <b>เวลาของข้อความ (timestamp)</b> เป็นหลักฐาน — ระบบวัดจาก “ลูกค้าส่ง → นักบัญชีตอบ” เท่านั้น (ไม่มีข้อมูลอ่านแล้ว/ยังไม่อ่าน)
        </div>

        <div className="grid-2">
          {/* บทสนทนา */}
          <section className="card">
            <div className="section-title"><span>บทสนทนา (กลุ่ม LINE)</span>{!view.canDecrypt ? <span className="badge b-gray">🔒 ซ่อนเนื้อหา (ไม่มีสิทธิ์)</span> : null}</div>
            <div className="chat">
              {view.timeline.length === 0 ? (
                <p className="empty">ไม่มีข้อความในเคสนี้</p>
              ) : (
                view.timeline.map((m) => (
                  <div className={`msg ${m.senderKind}`} key={m.id}>
                    <span className="who">{m.senderLabel}</span>
                    <div className={`bubble${m.redacted ? " redacted" : ""}`}>{m.content}</div>
                    {m.sentAt ? <span className="time">{new Date(m.sentAt).toLocaleString("th-TH")}</span> : null}
                  </div>
                ))
              )}
            </div>
          </section>

          {/* AI analysis */}
          <section className="card">
            <div className="section-title"><span>🤖 NOVA AI วิเคราะห์ Flow เคส</span></div>
            {!a ? (
              <p className="empty">ยังไม่มีผลวิเคราะห์ AI ของกลุ่มนี้</p>
            ) : (
              <>
                {a.summary ? <p style={{ fontSize: 13, marginBottom: 12 }}>{a.summary}</p> : null}

                {flow.length > 0 ? (
                  <div className="steps">
                    {flow.map((s, i) => {
                      const dot = stepDot(s.status);
                      const ev = s.evidence;
                      return (
                        <div className="step" key={i}>
                          <div className={`dot ${dot.cls}`}>{dot.icon}</div>
                          <div className="sbody">
                            <div className="stitle">{s.title}</div>
                            {s.desc ? <div className="sdesc">{s.desc}</div> : null}
                            {ev ? (
                              <div className="evidence">
                                {ev.quote || ev.text ? <span className="q">“{str(ev.quote ?? ev.text)}”</span> : null}
                                {ev.at || ev.time ? <><br /><span className="e-time">🕐 {str(ev.at ?? ev.time)}</span></> : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {problems.length > 0 ? (
                  <>
                    <hr className="hr" />
                    <div className="section-title" style={{ fontSize: 14 }}>ปัญหาที่ตรวจพบ</div>
                    <div className="pill-list" style={{ marginBottom: 8 }}>
                      {problems.map((p, i) => <span className="badge b-orange" key={i}>{p}</span>)}
                    </div>
                  </>
                ) : null}

                {view.violations.length > 0 ? (
                  <div className="pill-list" style={{ marginBottom: 8 }}>
                    {view.violations.map((v) => (
                      <span key={v.id} className={`badge ${v.severity === "high" ? "b-red" : v.severity === "medium" ? "b-orange" : "b-yellow"}`}>
                        {violationLabel(v.violation_type)}{v.needs_expert_review ? " ⚠ ตรวจ" : ""}
                      </span>
                    ))}
                  </div>
                ) : null}

                {/* ★ แยกข้อเท็จจริง / สันนิษฐาน / ข้อมูลไม่พอ */}
                {facts.length > 0 ? (
                  <div className="note-box fact">
                    <b><span className="badge b-fact">ข้อเท็จจริง</span></b> อ้างจากข้อความ+เวลาโดยตรง:
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
                  </div>
                ) : null}
                {assumptions.length > 0 ? (
                  <div className="note-box guess" style={{ marginTop: 10 }}>
                    <b><span className="badge b-guess">ข้อสันนิษฐาน AI</span></b> ต้องให้คนยืนยัน:
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{assumptions.map((f, i) => <li key={i}>{f}</li>)}</ul>
                  </div>
                ) : null}
                {a.insufficient_data ? (
                  <div className="note-box warn" style={{ marginTop: 10 }}>
                    <span className="badge b-insufficient">⚠ ข้อมูลไม่เพียงพอ</span> ประเมินจากข้อความในกลุ่มเท่านั้น — อาจมีการคุยนอก LINE ที่ระบบไม่เห็น
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>

        {view.case.owner_employee_id ? (
          <p className="muted" style={{ fontSize: 13 }}>
            <Link href="/chat-audit" className="underline">← กลับภาพรวม</Link>
          </p>
        ) : null}
      </div>
    </ChatAuditFrame>
  );
}
