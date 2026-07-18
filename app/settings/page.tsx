import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import {
  collectIntegrationStatus,
  getSettingsSnapshot,
  type SettingsSnapshot,
} from "@/lib/settings/status";
import type { RoleCode } from "@/lib/dashboard/types";
import AppNav, { type AppNavActive } from "../_components/AppNav";
import "../dashboard/dashboard.css";
import "../admin/admin.css";
import "./settings.css";

export const dynamic = "force-dynamic";

/**
 * หน้า /settings — สถานะระบบ/การเชื่อมต่อ แบบ read-only
 * ★ ความปลอดภัย: แสดงแค่ "ตั้งค่าแล้ว/ยังไม่ตั้ง" (boolean) — ไม่โชว์ค่า secret จริงเด็ดขาด
 *   การแก้ค่าเชื่อมต่อ (LINE/API key) ทำผ่าน env/ผู้ดูแลระบบ ไม่แก้ผ่านหน้านี้
 * guard: login + admin/executive เท่านั้น
 */

// ★ bridge type: เจ้าของ AppNav จะเพิ่ม "surveys"/"settings" เข้า AppNavActive เอง
const NAV_ACTIVE: AppNavActive = "settings";

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
          title="NOVA-CX · ตั้งค่า/สถานะระบบ"
          subtitle="สถานะการเชื่อมต่อ · สุขภาพ cron · ภาพรวม tenant (อ่านอย่างเดียว)"
        />
      </header>
      {children}
    </main>
  );
}

/** 1 แถวสถานะ: ป้าย + จุดสี + ข้อความ (ตั้งค่าแล้ว/ยังไม่ตั้ง) */
function StatusRow({
  label,
  ok,
  okText = "ตั้งค่าแล้ว",
  offText = "ยังไม่ตั้ง",
  detail,
}: {
  label: string;
  ok: boolean;
  okText?: string;
  offText?: string;
  detail?: string;
}) {
  return (
    <div className="status-row">
      <span className="status-label">{label}</span>
      <span className="status-value">
        <span className={`status-dot ${ok ? "on" : "off"}`} aria-hidden="true" />
        <span>{ok ? okText : offText}</span>
        {detail ? <span className="status-detail">· {detail}</span> : null}
      </span>
    </div>
  );
}

/** ป้ายสี cron ตามสถานะ */
function cronBadgeClass(status: string): string {
  if (status === "ok") return "on";
  if (status === "failed") return "off";
  return "unknown";
}

export default async function SettingsPage() {
  // 1) ยังไม่ตั้ง env DB → แสดงสถานะ integration (จาก env) ได้แต่ degrade ส่วน DB
  const status = collectIntegrationStatus();

  if (!getSupabaseEnv()) {
    return (
      <Frame>
        <div className="card">
          ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY) —
          ตั้งค่า env แล้วหน้านี้จะแสดงสถานะระบบครบได้
        </div>
      </Frame>
    );
  }

  // 2) guard: login + admin/executive เท่านั้น
  const authed = await createClient();
  const ctx = await resolveAdminContext(authed);

  if (!ctx.hasSession) {
    redirect("/login?redirect=/settings");
  }
  if (!ctx.isAdmin || !ctx.tenantId) {
    return (
      <Frame role={ctx.role} authed={ctx.hasSession && !!ctx.role}>
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>
            คุณไม่มีสิทธิ์เข้าถึงหน้าตั้งค่า
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

  // 3) อ่านสถานะจาก DB (ชื่อ tenant, จำนวน, cron health) ด้วย service-role scope ด้วย tenant
  let snapshot: SettingsSnapshot;
  try {
    const service = createServiceRoleClient();
    snapshot = await getSettingsSnapshot(service, ctx.tenantId);
  } catch {
    snapshot = {
      tenantName: null,
      employeeCount: 0,
      customerCount: 0,
      cronHealth: [],
      dbError: true,
    };
  }

  return (
    <Frame role={ctx.role} authed>
      <section className="dash-views">
        {/* ภาพรวม tenant */}
        <div className="card">
          <div className="section-title">ภาพรวมองค์กร (tenant)</div>
          <div className="settings-kpis">
            <div className="settings-kpi">
              <span className="label">องค์กร</span>
              <span className="value">{snapshot.tenantName ?? "—"}</span>
            </div>
            <div className="settings-kpi">
              <span className="label">พนักงาน</span>
              <span className="value">{snapshot.employeeCount}</span>
            </div>
            <div className="settings-kpi">
              <span className="label">ลูกค้า</span>
              <span className="value">{snapshot.customerCount}</span>
            </div>
          </div>
          {snapshot.dbError ? (
            <p className="muted" style={{ marginTop: 10 }}>
              อ่านข้อมูลบางส่วนไม่สำเร็จ — ตรวจ SUPABASE_SERVICE_ROLE_KEY /
              migration
            </p>
          ) : null}
        </div>

        {/* สถานะการเชื่อมต่อ */}
        <div className="card">
          <div className="section-title">สถานะการเชื่อมต่อระบบ</div>
          <div className="status-list">
            <StatusRow
              label="ฐานข้อมูล (Supabase)"
              ok={status.supabase.configured}
              okText="เชื่อมต่อแล้ว"
              detail={
                status.supabase.serviceRole
                  ? "มี service-role key"
                  : "ยังไม่มี service-role key"
              }
            />
            <StatusRow
              label="AI (วิเคราะห์ความเห็น)"
              ok={status.ai.configured}
              okText="พร้อมใช้งาน"
              offText="ยังไม่ตั้ง API key"
              detail={`${status.ai.provider} · ${status.ai.model}`}
            />
            <StatusRow
              label="LINE OA — Care (ฟอร์ม A/B)"
              ok={status.lineCare.credentials}
              okText="ตั้งค่า credential แล้ว"
              detail={status.lineCare.liff ? "มี LIFF ID" : "ยังไม่ตั้ง LIFF ID"}
            />
            <StatusRow
              label="LINE OA — Sale (ฟอร์ม C/D)"
              ok={status.lineSale.credentials}
              okText="ตั้งค่า credential แล้ว"
              detail={status.lineSale.liff ? "มี LIFF ID" : "ยังไม่ตั้ง LIFF ID"}
            />
            <StatusRow
              label="โหมด LINE"
              ok={!status.lineDevMode}
              okText="โหมดใช้งานจริง (มี LIFF)"
              offText="โหมด dev (ยังไม่ตั้ง LIFF)"
            />
            <StatusRow
              label="NOVA Sales Integration API"
              ok={status.novaSales.apiKey}
              okText="เปิดรับข้อมูล (มี API key)"
              offText="ปิด (ยังไม่ตั้ง API key)"
              detail={
                status.novaSales.tenantBound
                  ? "ผูก tenant แล้ว"
                  : "ยังไม่ผูก tenant"
              }
            />
          </div>
          <p className="settings-note">
            🔒 หน้านี้แสดงเฉพาะสถานะ “ตั้งค่าแล้ว/ยังไม่ตั้ง” เท่านั้น
            ไม่แสดงค่าคีย์/ความลับใด ๆ — การแก้ค่าเชื่อมต่อ (LINE / API key)
            ทำผ่าน environment variable โดยผู้ดูแลระบบ ไม่แก้ในหน้านี้
          </p>
        </div>

        {/* สุขภาพ cron */}
        <div className="card">
          <div className="section-title">สุขภาพงานตามเวลา (CRON)</div>
          {snapshot.cronHealth.length > 0 ? (
            <div className="table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>งาน</th>
                    <th>สถานะ</th>
                    <th>รันล่าสุด</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.cronHealth.map((c) => (
                    <tr key={c.jobName}>
                      <td>{c.jobName}</td>
                      <td>
                        <span
                          className={`admin-badge ${cronBadgeClass(c.status)}`}
                        >
                          {c.status}
                        </span>
                      </td>
                      <td>
                        {c.lastRunAt
                          ? new Date(c.lastRunAt).toLocaleString("th-TH")
                          : "ยังไม่เคยรัน"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">ยังไม่มีข้อมูลสุขภาพ cron</p>
          )}
        </div>
      </section>
    </Frame>
  );
}
