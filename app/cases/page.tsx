import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveViewer } from "@/lib/dashboard/session";
import { isPrivilegedRole } from "@/lib/dashboard/access";
import {
  computeSlaStatus,
  formatSlaLabel,
} from "@/lib/dashboard/sla";
import {
  filterAndSortCases,
  isClosedStatus,
  normalizeLevelFilter,
  normalizeStatusFilter,
  CASE_LEVEL_FILTERS,
  CASE_STATUS_FILTERS,
  type CaseLevelFilter,
  type CaseStatusFilter,
} from "@/lib/dashboard/cases";
import type { CaseFactRow, RoleCode } from "@/lib/dashboard/types";
import AppNav from "../_components/AppNav";
import "../dashboard/dashboard.css";

export const dynamic = "force-dynamic";

// โหมด demo ?role= เปิดเฉพาะตอน dev เท่านั้น (production ต้อง login จริง)
const DEV_FALLBACK = process.env.NODE_ENV !== "production";

/** กรอบหน้า /cases (ใช้ธีม .nova-dash + แถบเมนูร่วม) */
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
          active="cases"
          role={role}
          authed={authed}
          title="NOVA-CX · เคสร้องเรียน"
          subtitle="เคสร้องเรียนทั้งหมด · เรียงตามความเร่งด่วน (เกิน SLA ก่อน) · แสดงรหัสลูกค้า (ปลอมนาม)"
        />
      </header>
      {children}
    </main>
  );
}

/** เลือก class badge ตามระดับความรุนแรงเคส (ตรงกับ dashboard) */
function levelBadgeClass(level: string): string {
  const l = level.toLowerCase();
  if (l === "critical") return "badge-critical";
  if (l === "high") return "badge-high";
  return "badge-medium";
}

const LEVEL_LABEL: Record<CaseLevelFilter, string> = {
  all: "ทุกระดับ",
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};
const STATUS_LABEL: Record<CaseStatusFilter, string> = {
  all: "ทั้งหมด",
  open: "เปิดอยู่",
  closed: "ปิดแล้ว",
};

/** สร้าง href ของ filter โดยคงพารามิเตอร์อีกตัวไว้ */
function filterHref(level: CaseLevelFilter, status: CaseStatusFilter): string {
  const p = new URLSearchParams();
  if (level !== "all") p.set("level", level);
  if (status !== "all") p.set("status", status);
  const qs = p.toString();
  return qs ? `/cases?${qs}` : "/cases";
}

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string; status?: string }>;
}) {
  const sp = await searchParams;
  const level = normalizeLevelFilter(sp.level);
  const status = normalizeStatusFilter(sp.status);

  // 1) ยังไม่ตั้ง env DB → degrade อย่างสุภาพ
  if (!getSupabaseEnv()) {
    return (
      <Frame>
        <div className="card">
          ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY) —
          ตั้งค่า env แล้วหน้านี้จะแสดงเคสจริงจาก Supabase
        </div>
      </Frame>
    );
  }

  // 2) guard: ต้อง login + เป็น privileged (executive/admin/cs)
  const db = await createClient();
  const viewer = await resolveViewer(db);

  // 2a) ไม่มี session จริง และไม่ใช่ dev → บังคับ login
  if (!viewer.hasSession && !DEV_FALLBACK) {
    redirect("/login?redirect=/cases");
  }

  // 2b) login แล้วแต่ไม่ใช่ privileged → แจ้งอย่างสุภาพ (ไม่ leak ข้อมูล)
  if (!isPrivilegedRole(viewer.role)) {
    return (
      <Frame role={viewer.role} authed={viewer.hasSession && !!viewer.role}>
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>
            คุณไม่มีสิทธิ์เข้าถึงหน้าเคสร้องเรียน
          </p>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            หน้านี้เปิดเฉพาะผู้บริหาร (executive), ผู้ดูแลระบบ (admin) และทีม CS —
            หากต้องการสิทธิ์ กรุณาติดต่อผู้ดูแลระบบ
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

  // 3) ดึงเคสทั้งหมดผ่าน scoped client (view/RLS บังคับ scope ให้เอง)
  let rows: CaseFactRow[] = [];
  try {
    const { data, error } = await db
      .from("v_dashboard_case_facts")
      .select(
        "case_id, case_no, customer_id, customer_code, type, level, status, sla_due_at, created_at, closed_at, post_resolution_csat"
      );
    if (error) throw error;
    rows = (data ?? []) as CaseFactRow[];
  } catch {
    return (
      <Frame role={role} authed={authed}>
        <div className="card">
          อ่านข้อมูลเคสไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0025)
          และมี session พนักงาน
        </div>
      </Frame>
    );
  }

  // now = เวลา ณ ตอน render (server) — ใช้คำนวณสถานะ SLA/urgency
  const now = Date.now();
  const visible = filterAndSortCases(rows, { level, status }, now);
  const overdueCount = visible.filter(
    (c) => computeSlaStatus(c.sla_due_at, now).state === "overdue"
  ).length;

  return (
    <Frame role={role} authed={authed}>
      <div className="dash-views">
        {/* แถบกรอง (ระดับ + สถานะ) — reuse สไตล์ .role-switch (chip) */}
        <section className="card">
          <div className="section-title">
            <span>ตัวกรอง</span>
            <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
              แสดง {visible.length} จาก {rows.length} เคส
              {overdueCount > 0 ? ` · เกิน SLA ${overdueCount}` : ""}
            </span>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            <div>
              <div
                className="muted"
                style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}
              >
                ระดับ
              </div>
              <nav className="role-switch" aria-label="กรองตามระดับ">
                {CASE_LEVEL_FILTERS.map((lv) => (
                  <Link
                    key={lv}
                    href={filterHref(lv, status)}
                    className={lv === level ? "active" : ""}
                  >
                    {LEVEL_LABEL[lv]}
                  </Link>
                ))}
              </nav>
            </div>

            <div>
              <div
                className="muted"
                style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}
              >
                สถานะ
              </div>
              <nav className="role-switch" aria-label="กรองตามสถานะ">
                {CASE_STATUS_FILTERS.map((st) => (
                  <Link
                    key={st}
                    href={filterHref(level, st)}
                    className={st === status ? "active" : ""}
                  >
                    {STATUS_LABEL[st]}
                  </Link>
                ))}
              </nav>
            </div>
          </div>
        </section>

        {/* ตารางเคสทั้งหมด (เรียงตามความเร่งด่วน) */}
        <section className="card">
          <div className="section-title">
            <span>เคสร้องเรียนทั้งหมด</span>
          </div>

          {visible.length === 0 ? (
            <p className="empty">ไม่มีเคสตรงเงื่อนไขที่เลือก</p>
          ) : (
            <div className="table-wrap">
              <table className="dlv-table">
                <thead>
                  <tr>
                    <th>เลขที่เคส</th>
                    <th>ประเภท</th>
                    <th>ลูกค้า</th>
                    <th>ระดับ</th>
                    <th>สถานะ</th>
                    <th>SLA</th>
                    <th>สร้างเมื่อ</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => {
                    const sla = computeSlaStatus(c.sla_due_at, now);
                    const closed = isClosedStatus(c.status);
                    return (
                      <tr key={c.case_id}>
                        <td>
                          <b style={{ color: "var(--navy-800)" }}>{c.case_no}</b>
                        </td>
                        <td>{c.type}</td>
                        {/* ★ pseudonymity: แสดงรหัสลูกค้า ไม่ใช่ชื่อ */}
                        <td>{c.customer_code ?? "—"}</td>
                        <td>
                          <span className={`badge ${levelBadgeClass(c.level)}`}>
                            {c.level}
                          </span>
                        </td>
                        <td>
                          <span className="muted">{c.status}</span>
                          {closed ? " ✓" : ""}
                        </td>
                        <td>
                          {/* เคสปิดแล้วไม่ต้องเน้น SLA */}
                          {closed ? (
                            <span className="muted" style={{ fontSize: 12 }}>
                              —
                            </span>
                          ) : (
                            <span className={`sla-badge sla-${sla.state}`}>
                              {formatSlaLabel(sla)}
                            </span>
                          )}
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>
                          {c.created_at
                            ? new Date(c.created_at).toLocaleDateString("th-TH")
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="note-box">
            🔒 แสดง <b>รหัสลูกค้า (ปลอมนาม)</b> ไม่ใช่ชื่อจริง — บังคับที่ชั้น
            view/RLS · เคส Critical/High ต้องให้มนุษย์ตรวจก่อนตอบลูกค้าเสมอ
          </div>
        </section>
      </div>
    </Frame>
  );
}
