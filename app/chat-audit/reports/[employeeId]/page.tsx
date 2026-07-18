import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { canSeeAccountantReport } from "@/lib/reports/report-access";
import {
  buildMonthlyReport,
  isValidPeriod,
  ReportAccessError,
  type MonthlyReport,
} from "@/lib/reports/accountant-report";
import ChatAuditFrame from "../../_Frame";
import PrintButton from "./PrintButton";
import "../../chat-admin.css";

export const dynamic = "force-dynamic";
const DEV_FALLBACK = process.env.NODE_ENV !== "production";

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** แถวเทียบเดือนก่อน → ป้ายเปลี่ยนแปลง (เขียว=ดีขึ้น) */
function DeltaBadge({ now, prev, betterWhen }: { now: number | null; prev: number | null; betterWhen: "higher" | "lower" }) {
  if (now === null || prev === null) return <span className="muted">—</span>;
  const diff = Math.round((now - prev) * 10) / 10;
  if (diff === 0) return <span className="badge b-gray">เท่าเดิม</span>;
  const improved = betterWhen === "higher" ? diff > 0 : diff < 0;
  return (
    <span className={`badge ${improved ? "b-green" : "b-orange"}`}>
      {diff > 0 ? "▲" : "▼"} {Math.abs(diff)}
    </span>
  );
}

export default async function ReportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ employeeId: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { employeeId } = await params;
  const sp = await searchParams;
  const period = sp.period && isValidPeriod(sp.period) ? sp.period : currentPeriod();

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-report" role={null} authed={false} title="รายงานประเมิน" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล</div>
      </ChatAuditFrame>
    );
  }

  const db = await createClient();
  const viewer = await resolveEvalViewer(db);
  if (!viewer.role && !DEV_FALLBACK) redirect(`/login?redirect=/chat-audit/reports/${employeeId}`);
  if (!canSeeAccountantReport(viewer.role) || !viewer.tenantId) {
    return (
      <ChatAuditFrame active="chat-report" role={viewer.role} authed={!!viewer.role} title="รายงานประเมิน" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card"><p style={{ fontWeight: 700 }}>คุณไม่มีสิทธิ์ดูรายงานนี้</p></div>
      </ChatAuditFrame>
    );
  }

  let report: MonthlyReport;
  try {
    const service = createServiceRoleClient();
    report = await buildMonthlyReport(service, viewer, { employeeId, period });
  } catch (e) {
    const msg = e instanceof ReportAccessError ? e.message : "อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0035)";
    return (
      <ChatAuditFrame active="chat-report" role={viewer.role} authed title="รายงานประเมิน" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card"><p style={{ fontWeight: 700 }}>{msg}</p><p style={{ marginTop: 10 }}><Link href="/chat-audit/reports" className="underline">← กลับ</Link></p></div>
      </ChatAuditFrame>
    );
  }

  const c = report.cases;
  const s = report.scores;

  return (
    <ChatAuditFrame
      active="chat-report"
      role={viewer.role}
      authed
      title="รายงานประเมินรายเดือน"
      subtitle={`${report.employeeName} · รอบ ${report.period}`}
    >
      <div className="dash-views">
        <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <Link href="/chat-audit/reports" className="underline">← เลือกพนักงาน/รอบอื่น</Link>
          <div className="report-actions">
            <PrintButton />
            <a href={`/api/reports/accountant/export?employeeId=${report.employeeId}&period=${report.period}`} className="btn" download>
              📊 Export Excel
            </a>
          </div>
        </div>

        {report.confirmedOnly ? (
          <div className="note-box">🔒 ฝ่ายบุคคล: คะแนนนับเฉพาะผลที่หัวหน้ายืนยันแล้ว (ไม่รวมฉบับร่าง AI)</div>
        ) : null}

        <div className="sheet">
          <h3>รายงานประเมินผลงาน — {report.employeeName}</h3>
          <div className="sheet-sub">ตำแหน่ง: นักบัญชี · รอบเดือน: {report.period}</div>

          <div className="kpi-grid" style={{ marginBottom: 0 }}>
            <div className="kpi"><div className="label">ลูกค้าที่ดูแล</div><div className="value">{c.customerCount}</div></div>
            <div className="kpi"><div className="label">เคสทั้งหมด</div><div className="value">{c.totalCases}</div></div>
            <div className="kpi"><div className="label">ปิดสำเร็จ</div><div className="value v-green">{c.closedCases}</div><div className="sample">{c.closedPct !== null ? `${c.closedPct}%` : "—"}</div></div>
            <div className="kpi"><div className="label">เวลาตอบเฉลี่ย</div><div className="value">{c.avgFirstResponseMin ?? "—"}<span className="unit">นาที</span></div></div>
          </div>
          <div className="kpi-grid cols-3" style={{ marginBottom: 0 }}>
            <div className="kpi"><div className="label">เกิน SLA</div><div className={`value ${c.overSlaCases > 0 ? "v-red" : "v-green"}`}>{c.overSlaCases}</div></div>
            <div className="kpi"><div className="label">ทวงซ้ำ/เปิดใหม่</div><div className="value v-amber">{c.reopenedCases}</div></div>
            <div className="kpi"><div className="label">คะแนนรวมเฉลี่ย</div><div className="value">{s.overallAvg ?? "—"}<span className="unit">/100</span></div></div>
          </div>

          <div className="sheet-sec">
            <h4>คะแนนแยก 8 มิติ (เฉลี่ย 0–100)</h4>
            {s.dimensions.map((d) => {
              const val = d.avg;
              const low = val !== null && val < 60;
              return (
                <div className="dim-row" key={d.key}>
                  <div className="dname">{d.label}</div>
                  <div className="bar-track"><div className={`bar-fill${low ? " bad" : val !== null && val < 75 ? " low" : ""}`} style={{ width: `${val ?? 0}%` }} /></div>
                  <div className="dscore">{val !== null ? Math.round(val) : "—"}/100</div>
                </div>
              );
            })}
            {s.evalCount === 0 ? <p className="muted" style={{ fontSize: 12 }}>ยังไม่มีผลประเมินในรอบนี้{report.confirmedOnly ? " (ที่ยืนยันแล้ว)" : ""}</p> : null}
          </div>

          <div className="sheet-sec">
            <h4>จุดแข็ง / จุดที่ควรปรับ</h4>
            {report.strengths.length > 0 ? (
              <div className="fb pos"><span className="fb-tag">✅ จุดแข็ง</span><p>{report.strengths.join(" · ")}</p></div>
            ) : null}
            {report.improvements.length > 0 ? (
              <div className="fb neg"><span className="fb-tag">💡 ควรปรับ</span><p>{report.improvements.join(" · ")}</p></div>
            ) : null}
            {report.strengths.length + report.improvements.length === 0 ? <p className="muted" style={{ fontSize: 12 }}>ยังไม่มีข้อมูล coaching ในรอบนี้</p> : null}
          </div>

          {report.repeatedErrors.length > 0 ? (
            <div className="sheet-sec">
              <h4>ปัญหาซ้ำที่ต้องระวัง</h4>
              <ul className="checklist">{report.repeatedErrors.map((r, i) => <li key={i}><span className="cbox" />{r}</li>)}</ul>
            </div>
          ) : null}

          <div className="sheet-sec">
            <h4>แผนพัฒนาเดือนหน้า</h4>
            {report.nextPlan.length > 0 || report.trainingTopics.length > 0 ? (
              <ul className="checklist">
                {report.nextPlan.map((p, i) => <li key={`p${i}`}><span className="cbox" />{p}</li>)}
                {report.trainingTopics.map((t, i) => <li key={`t${i}`}><span className="cbox" />อบรม: {t}</li>)}
              </ul>
            ) : <p className="muted" style={{ fontSize: 12 }}>ยังไม่มีแผน</p>}
          </div>

          <div className="sheet-sec">
            <h4>เทียบเดือนก่อน ({report.compare.prevPeriod})</h4>
            <div className="table-wrap">
              <table className="admin-table">
                <thead><tr><th>ตัวชี้วัด</th><th className="center">เดือนก่อน</th><th className="center">รอบนี้</th><th className="center">เปลี่ยนแปลง</th></tr></thead>
                <tbody>
                  <tr>
                    <td>คะแนนรวม</td>
                    <td className="center">{report.compare.prevOverall ?? "—"}</td>
                    <td className="center">{s.overallAvg ?? "—"}</td>
                    <td className="center"><DeltaBadge now={s.overallAvg} prev={report.compare.prevOverall} betterWhen="higher" /></td>
                  </tr>
                  <tr>
                    <td>เวลาตอบเฉลี่ย (นาที)</td>
                    <td className="center">{report.compare.prevAvgFirstResponseMin ?? "—"}</td>
                    <td className="center">{c.avgFirstResponseMin ?? "—"}</td>
                    <td className="center"><DeltaBadge now={c.avgFirstResponseMin} prev={report.compare.prevAvgFirstResponseMin} betterWhen="lower" /></td>
                  </tr>
                  <tr>
                    <td>เกิน SLA (เคส)</td>
                    <td className="center">{report.compare.prevOverSlaCases ?? "—"}</td>
                    <td className="center">{c.overSlaCases}</td>
                    <td className="center"><DeltaBadge now={c.overSlaCases} prev={report.compare.prevOverSlaCases} betterWhen="lower" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="approve-box">
            <div style={{ flex: 1 }}>
              <div className="sign-line" />
              <div className="sign-cap">ลงชื่อหัวหน้าผู้อนุมัติ &nbsp; วันที่ ______</div>
            </div>
          </div>
        </div>

        <div className="note-box warn no-print">
          🤖 คะแนน/ข้อเสนอแนะเป็นการประเมินของ AI จากพฤติกรรมในแชต — <b>ไม่ใช่คำตัดสิน</b> หัวหน้าควรตรวจบริบทจริงก่อนอนุมัติ · กด &quot;Export Excel&quot; เพื่อดาวน์โหลดไฟล์ .xlsx หรือ &quot;พิมพ์/บันทึก PDF&quot; เพื่อสั่งพิมพ์/บันทึกเป็น PDF
        </div>
      </div>
    </ChatAuditFrame>
  );
}
