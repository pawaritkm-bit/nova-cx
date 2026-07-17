import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import {
  getExecDashboard,
  getMemberDashboard,
  getLeadDashboard,
} from "@/lib/dashboard/queries";
import {
  resolveViewer,
  dashboardViewForRole,
} from "@/lib/dashboard/session";
import { ROLE_CODES, type RoleCode } from "@/lib/dashboard/types";
import { ExecView, MemberView, LeadView } from "./_components";
import "./dashboard.css";

export const dynamic = "force-dynamic";

// โหมด demo ?role= เปิดเฉพาะตอน dev เท่านั้น (production ต้อง login จริง)
const DEV_FALLBACK = process.env.NODE_ENV !== "production";

const ROLE_LABEL: Record<RoleCode, string> = {
  executive: "ผู้บริหาร",
  acc_lead: "หัวหน้าทีมบัญชี",
  accountant: "นักบัญชี",
  sales_lead: "หัวหน้าฝ่ายขาย",
  sales: "เซลล์",
  cs: "CS",
  admin: "Admin",
};

function Frame({
  activeRole,
  fromSession,
  children,
}: {
  activeRole: RoleCode | null;
  fromSession: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className="nova-dash">
      <header>
        <div className="dash-top">
          <div className="dash-title">
            <h1>NOVA-CX Dashboard</h1>
            <p>
              มุมมองตามบทบาท · แสดง Sample Size (n) ทุกคะแนน ·
              คะแนนตัวอย่างน้อยไม่สรุปดี/แย่สุด
            </p>
          </div>
          {/* แสดงบทบาท + ปุ่มออกจากระบบเฉพาะเมื่อ login จริง */}
          {fromSession && activeRole ? (
            <div className="flex shrink-0 items-center gap-3">
              <span className="role-chip">{ROLE_LABEL[activeRole]}</span>
              <form method="post" action="/auth/logout">
                <button type="submit" className="logout-btn">
                  ออกจากระบบ
                </button>
              </form>
            </div>
          ) : null}
        </div>

        {/* โหมดตัวอย่าง (dev เท่านั้น) — ปุ่มสลับบทบาทเพื่อพรีวิวหน้าตา */}
        {!fromSession && DEV_FALLBACK ? (
          <>
            <p className="dev-hint">
              โหมดตัวอย่าง (dev — ยังไม่ได้ login): เลือกบทบาทเพื่อดูหน้าตา —
              ข้อมูลจริงยังบังคับด้วย view/RLS ตามผู้ล็อกอินเสมอ · เข้าสู่ระบบจริงที่{" "}
              <Link href="/login">/login</Link>
            </p>
            <nav className="role-switch" style={{ marginBottom: 18 }}>
              {ROLE_CODES.map((r) => (
                <Link
                  key={r}
                  href={`/dashboard?role=${r}`}
                  className={r === activeRole ? "active" : ""}
                >
                  {ROLE_LABEL[r]}
                </Link>
              ))}
            </nav>
          </>
        ) : null}
      </header>
      {children}
    </main>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const { role: roleParam } = await searchParams;

  // 1) ยังไม่ตั้ง env DB → degrade อย่างสุภาพ
  if (!getSupabaseEnv()) {
    return (
      <Frame activeRole={null} fromSession={false}>
        <div className="card">
          ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY) —
          ตั้งค่า env แล้ว dashboard จะอ่านข้อมูลจริงจาก Supabase
        </div>
      </Frame>
    );
  }

  const db = await createClient();
  // ★ session จริงมาก่อนเสมอ; ?role= ใช้ได้เฉพาะโหมด dev fallback (พรีวิว)
  //   เมื่อมี session จริง resolveViewer จะเมิน param อยู่แล้ว (session ชนะ param)
  const viewer = await resolveViewer(db, DEV_FALLBACK ? roleParam : undefined);

  // 2a) ไม่มี session จริง และไม่ใช่ dev → บังคับ login
  //     (defense-in-depth ซ้ำ middleware เผื่อเข้าถึงหน้าโดยตรง)
  if (!viewer.hasSession && !DEV_FALLBACK) {
    redirect("/login");
  }

  // 2b) login แล้วแต่บัญชีไม่มีบทบาทพนักงานผูกอยู่ → แจ้งอย่างสุภาพ + ให้ออกจากระบบ
  if (viewer.hasSession && !viewer.role) {
    return (
      <Frame activeRole={null} fromSession={false}>
        <div className="card">
          <p>บัญชีนี้ยังไม่ได้ผูกบทบาทพนักงานสำหรับดู dashboard</p>
          <p className="mt-1 text-sm text-brand/50">
            กรุณาติดต่อผู้ดูแลระบบเพื่อกำหนดบทบาท
          </p>
          <form method="post" action="/auth/logout" style={{ marginTop: 16 }}>
            <button type="submit" className="logout-btn">
              ออกจากระบบ
            </button>
          </form>
        </div>
      </Frame>
    );
  }

  // 2c) dev, ไม่ login, ไม่ส่ง ?role= → ให้เลือกบทบาทตัวอย่าง
  if (!viewer.role) {
    return (
      <Frame activeRole={null} fromSession={viewer.fromSession}>
        <div className="card">
          เลือกบทบาทด้านบนเพื่อดู dashboard (หรือ{" "}
          <Link href="/login" className="font-medium underline">
            เข้าสู่ระบบ
          </Link>
          )
        </div>
      </Frame>
    );
  }

  const role = viewer.role;
  const view = dashboardViewForRole(role);

  // 3) ดึงข้อมูล (degrade เมื่อ query ล้ม เช่นยัง apply migration ไม่ครบ)
  try {
    if (view === "exec") {
      const d = await getExecDashboard(db);
      return (
        <Frame activeRole={role} fromSession={viewer.fromSession}>
          <ExecView d={d} />
        </Frame>
      );
    }
    if (view === "lead") {
      const d = await getLeadDashboard(
        db,
        role === "sales_lead" ? "sales_lead" : "acc_lead"
      );
      return (
        <Frame activeRole={role} fromSession={viewer.fromSession}>
          <LeadView d={d} />
        </Frame>
      );
    }
    const d = await getMemberDashboard(
      db,
      role === "sales" ? "sales" : "accountant"
    );
    return (
      <Frame activeRole={role} fromSession={viewer.fromSession}>
        <MemberView d={d} />
      </Frame>
    );
  } catch {
    return (
      <Frame activeRole={role} fromSession={viewer.fromSession}>
        <div className="card">
          อ่านข้อมูล dashboard ไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0025) และมี session พนักงาน
        </div>
      </Frame>
    );
  }
}
