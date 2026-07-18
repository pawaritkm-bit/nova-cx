import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveViewer } from "@/lib/dashboard/session";
import { canExportReports } from "@/lib/reports";
import { getExecDashboard } from "@/lib/dashboard/queries";
import type { ExecDashboard, RoleCode } from "@/lib/dashboard/types";
import AppNav from "../_components/AppNav";
import "../dashboard/dashboard.css";

export const dynamic = "force-dynamic";

// โหมด demo ?role= เปิดเฉพาะตอน dev เท่านั้น (production ต้อง login จริง)
const DEV_FALLBACK = process.env.NODE_ENV !== "production";

/** กรอบหน้า /reports (ใช้ธีม .nova-dash + แถบเมนูร่วม) */
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
          active="reports"
          role={role}
          authed={authed}
          title="NOVA-CX · รายงาน"
          subtitle="สรุปภาพรวม + ดาวน์โหลด CSV (Excel ไทยไม่เพี้ยน) · ข้อมูลไม่ผูกชื่อลูกค้า (ปลอมนาม)"
        />
      </header>
      {children}
    </main>
  );
}

/** การ์ด KPI แบบเรียบ (reuse .kpi) */
function StatCard({
  label,
  value,
  sample,
  tone,
}: {
  label: string;
  value: string | number | null;
  sample?: string;
  tone?: "red" | "green" | "amber";
}) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className={`value${tone ? ` v-${tone}` : ""}`}>{value ?? "—"}</div>
      {sample ? <div className="sample">{sample}</div> : null}
    </div>
  );
}

export default async function ReportsPage() {
  // 1) ยังไม่ตั้ง env DB → degrade อย่างสุภาพ
  if (!getSupabaseEnv()) {
    return (
      <Frame>
        <div className="card">
          ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY) —
          ตั้งค่า env แล้วหน้านี้จะสรุป/ออกรายงานจริงจาก Supabase
        </div>
      </Frame>
    );
  }

  // 2) guard: ต้อง login + เป็นบทบาทที่ export ได้ (executive/admin/acc_lead/sales_lead/cs)
  const db = await createClient();
  const viewer = await resolveViewer(db);

  // 2a) ไม่มี session จริง และไม่ใช่ dev → บังคับ login
  if (!viewer.hasSession && !DEV_FALLBACK) {
    redirect("/login?redirect=/reports");
  }

  // 2b) login แล้วแต่ไม่มีสิทธิ์ออกรายงาน → แจ้งอย่างสุภาพ
  if (!canExportReports(viewer.role)) {
    return (
      <Frame role={viewer.role} authed={viewer.hasSession && !!viewer.role}>
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>
            คุณไม่มีสิทธิ์ออกรายงาน
          </p>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            หน้านี้เปิดเฉพาะผู้บริหาร (executive), ผู้ดูแลระบบ (admin),
            หัวหน้าทีมบัญชี/ฝ่ายขาย และทีม CS — หากต้องการสิทธิ์ กรุณาติดต่อผู้ดูแลระบบ
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

  const role = viewer.role;
  const authed = viewer.fromSession && !!role;

  // 3) สรุปภาพรวม (อ่านผ่าน scoped client → ข้อมูลถูก scope ด้วย view/RLS ตามบทบาท)
  let d: ExecDashboard | null = null;
  try {
    d = await getExecDashboard(db, Date.now());
  } catch {
    d = null;
  }

  const rr =
    d && d.responseRate.rate !== null
      ? `${Math.round(d.responseRate.rate * 100)}%`
      : null;
  const npsValue =
    !d || d.nps.nps === null
      ? null
      : d.nps.nps > 0
        ? `+${d.nps.nps}`
        : `${d.nps.nps}`;

  return (
    <Frame role={role} authed={authed}>
      <div className="dash-views">
        {/* สรุปภาพรวมบนหน้า ก่อนดาวน์โหลด */}
        <section>
          <div className="section-head">
            <h2>สรุปภาพรวม</h2>
            <p>ตัวเลขถูก scope ตามสิทธิ์ของคุณ (view/RLS) · แสดง n ของแต่ละคะแนน</p>
          </div>

          {d === null ? (
            <div className="card">
              อ่านข้อมูลสรุปไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0025)
              ยังดาวน์โหลด CSV ด้านล่างได้
            </div>
          ) : (
            <div className="kpi-grid">
              <StatCard
                label="CSAT (ความพึงพอใจ)"
                value={d.csat.avg}
                sample={`n = ${d.csat.n}`}
              />
              <StatCard label="NPS" value={npsValue} sample={`n = ${d.nps.n}`} />
              <StatCard
                label="Response Rate"
                value={rr}
                sample={`ส่ง ${d.responseRate.invited} · ตอบ ${d.responseRate.responded}`}
              />
              <StatCard
                label="เคสที่เปิดอยู่"
                value={d.cases.open}
                sample={`เร่งด่วน (Critical/High) ${d.cases.urgent}`}
                tone={d.cases.urgent > 0 ? "amber" : undefined}
              />
            </div>
          )}
        </section>

        {/* ดาวน์โหลดรายงาน CSV */}
        <section className="card">
          <div className="section-title">
            <span>ดาวน์โหลดรายงาน (CSV)</span>
          </div>

          <div className="prob-row">
            <div>
              <b>รายงานรายรอบ (Monthly)</b>
              <div className="muted" style={{ fontSize: 12 }}>
                CSAT / NPS / sentiment ต่อคำตอบ · รหัสลูกค้า (ปลอมนาม) ไม่มีชื่อจริง
              </div>
            </div>
            {/* ลิงก์ดาวน์โหลดตรงไป endpoint เดิม (สิทธิ์บังคับซ้ำที่ API) */}
            <a
              href="/api/reports/export?type=monthly"
              className="app-nav-link active"
              download
            >
              ⬇ ดาวน์โหลด
            </a>
          </div>

          <div className="prob-row">
            <div>
              <b>รายงานทีม/พนักงาน (Team)</b>
              <div className="muted" style={{ fontSize: 12 }}>
                คะแนนเฉลี่ยต่อพนักงาน/ทีม (Internal Review) · ไม่มีชื่อลูกค้า
              </div>
            </div>
            <a
              href="/api/reports/export?type=team"
              className="app-nav-link active"
              download
            >
              ⬇ ดาวน์โหลด
            </a>
          </div>

          <div className="note-box">
            📄 ไฟล์ CSV มี BOM ให้ Excel ภาษาไทยไม่เพี้ยน · สิทธิ์ถูกตรวจซ้ำที่ API
            (default deny) — <b>XLSX/PDF เป็นเฟสถัดไป</b>
          </div>
        </section>
      </div>
    </Frame>
  );
}
