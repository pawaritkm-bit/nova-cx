import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import { getSurveyOverview, type SurveyOverview } from "@/lib/surveys/overview";
import type { RoleCode } from "@/lib/dashboard/types";
import AppNav, { type AppNavActive } from "../_components/AppNav";
import "../dashboard/dashboard.css";
import "../admin/admin.css";
import "./surveys.css";

export const dynamic = "force-dynamic";

/**
 * หน้า /surveys — ดูแบบประเมิน A/B/C/D แบบ read-only
 * (ตรวจสอบว่าฟอร์มมีอะไรบ้าง: รอบ/ความถี่ · version · จำนวนคำถาม · รายการคำถาม)
 * guard: ต้อง login + บทบาท admin/executive เท่านั้น (reuse resolveAdminContext เดียวกับหน้า admin)
 */

// ★ bridge type: เจ้าของ AppNav (dev อีกคน) จะเพิ่ม "surveys"/"settings" เข้า AppNavActive เอง
//   ระหว่างนี้ cast ผ่าน unknown เพื่อให้ tsc ผ่าน โดยไม่แตะไฟล์ AppNav.tsx
const NAV_ACTIVE: AppNavActive = "surveys";

/** ป้ายชนิดคำถามภาษาไทย */
const QUESTION_TYPE_LABEL: Record<string, string> = {
  rating: "ให้คะแนน",
  single: "เลือกข้อเดียว",
  multi: "เลือกหลายข้อ",
  open: "ปลายเปิด",
  nps: "NPS (0–10)",
};

function Frame({
  role = null,
  authed = false,
  children,
}: {
  role?: RoleCode | null;
  authed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className="nova-dash">
      <header>
        <AppNav
          active={NAV_ACTIVE}
          role={role}
          authed={authed}
          title="NOVA-CX · แบบประเมิน"
          subtitle="ดูแบบฟอร์ม A/B/C/D · รอบการส่ง · คำถาม (อ่านอย่างเดียว)"
        />
      </header>
      {children}
    </main>
  );
}

/** การ์ดฟอร์ม 1 ใบ (A/B/C/D) */
function SurveyCard({ form }: { form: SurveyOverview["forms"][number] }) {
  return (
    <div className="card survey-card">
      <div className="survey-card-head">
        <span className="survey-type-chip" aria-hidden="true">
          {form.surveyType}
        </span>
        <div className="survey-card-title">
          <h3>{form.name}</h3>
          <p className="muted">{form.frequencyLabel}</p>
        </div>
        <span className={`admin-badge ${form.isActive ? "on" : "off"}`}>
          {form.isActive ? "เปิดใช้งาน" : "ปิด"}
        </span>
      </div>

      <div className="survey-meta">
        <span>
          เวอร์ชัน:{" "}
          <strong>{form.versionNo != null ? `v${form.versionNo}` : "—"}</strong>
        </span>
        <span>
          จำนวนคำถาม: <strong>{form.questionCount}</strong> ข้อ
        </span>
        <span>
          เผยแพร่:{" "}
          <strong>
            {form.publishedAt
              ? new Date(form.publishedAt).toLocaleDateString("th-TH")
              : "ยังไม่เผยแพร่"}
          </strong>
        </span>
      </div>

      {form.questions.length > 0 ? (
        <details className="survey-questions">
          <summary>ดูรายการคำถาม ({form.questions.length} ข้อ)</summary>
          <ol className="survey-q-list">
            {form.questions.map((q) => (
              <li key={q.code}>
                <span className="survey-q-text">{q.text}</span>
                <span className="survey-q-type">
                  {QUESTION_TYPE_LABEL[q.type] ?? q.type}
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : (
        <p className="muted survey-empty-q">
          ยังไม่มีคำถามในฟอร์มนี้ (ยังไม่ได้ตั้งค่า/เผยแพร่เวอร์ชัน)
        </p>
      )}
    </div>
  );
}

export default async function SurveysPage() {
  // 1) ยังไม่ตั้ง env DB → degrade สุภาพ
  if (!getSupabaseEnv()) {
    return (
      <Frame>
        <div className="card">
          ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY) —
          ตั้งค่า env แล้วหน้านี้จะแสดงแบบประเมินจริงได้
        </div>
      </Frame>
    );
  }

  // 2) guard: login + admin/executive เท่านั้น
  const authed = await createClient();
  const ctx = await resolveAdminContext(authed);

  if (!ctx.hasSession) {
    redirect("/login?redirect=/surveys");
  }
  if (!ctx.isAdmin || !ctx.tenantId) {
    return (
      <Frame role={ctx.role} authed={ctx.hasSession && !!ctx.role}>
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>
            คุณไม่มีสิทธิ์เข้าถึงหน้าแบบประเมิน
          </p>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            หน้านี้เปิดเฉพาะบทบาทผู้ดูแลระบบ (admin) และผู้บริหาร (executive)
          </p>
          <p style={{ marginTop: 12 }}>
            <Link href="/dashboard" className="font-medium underline">
              ← กลับ Dashboard
            </Link>
          </p>
        </div>
      </Frame>
    );
  }

  // 3) โหลด config ฟอร์มด้วย service-role (config ไม่ใช่ PII) แต่ scope ด้วย tenant จาก session
  let overview: SurveyOverview;
  try {
    const service = createServiceRoleClient();
    overview = await getSurveyOverview(service, ctx.tenantId);
  } catch {
    return (
      <Frame role={ctx.role} authed>
        <div className="card">
          อ่านข้อมูลแบบประเมินไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY
          แล้ว และ apply migration ครบ
        </div>
      </Frame>
    );
  }

  return (
    <Frame role={ctx.role} authed>
      <section className="dash-views">
        <div className="section-head">
          <h2>แบบฟอร์มประเมิน (A/B/C/D)</h2>
          <p>คลิก “ดูรายการคำถาม” เพื่อเปิดดูคำถามในแต่ละฟอร์ม (อ่านอย่างเดียว)</p>
        </div>

        <div className="survey-grid">
          {overview.forms.map((form) => (
            <SurveyCard key={form.surveyType} form={form} />
          ))}
        </div>

        <div className="card">
          <div className="section-title">รอบการส่ง (แคมเปญ)</div>
          {overview.campaigns.length > 0 ? (
            <div className="table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>ฟอร์ม</th>
                    <th>รอบ</th>
                    <th>เริ่ม</th>
                    <th>สิ้นสุด</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.campaigns.map((c, i) => (
                    <tr key={`${c.surveyType}-${c.cycleLabel}-${i}`}>
                      <td>{c.surveyType}</td>
                      <td>{c.cycleLabel}</td>
                      <td>{c.periodStart ?? "—"}</td>
                      <td>{c.periodEnd ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">ยังไม่มีแคมเปญ</p>
          )}
        </div>
      </section>
    </Frame>
  );
}
