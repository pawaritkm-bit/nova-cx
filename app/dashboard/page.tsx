import Link from "next/link";
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

export const dynamic = "force-dynamic";

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
    <main className="mx-auto max-w-5xl px-5 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-brand">NOVA-CX Dashboard</h1>
        <p className="mt-1 text-sm text-brand/50">
          มุมมองตามบทบาท · แสดง Sample Size (n) ทุกคะแนน · คะแนนตัวอย่างน้อยไม่สรุปดี/แย่สุด
        </p>
        {!fromSession ? (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            โหมดตัวอย่าง (ยังไม่มี auth login เต็มใน chunk นี้): เลือกบทบาทจากลิงก์ด้านล่างเพื่อดูหน้าตา —
            ข้อมูลจริงยังบังคับด้วย view/RLS ตามผู้ล็อกอินเสมอ
          </p>
        ) : null}
        <nav className="mt-3 flex flex-wrap gap-2">
          {ROLE_CODES.map((r) => (
            <Link
              key={r}
              href={`/dashboard?role=${r}`}
              className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-black/10 transition ${
                r === activeRole
                  ? "bg-brand text-white"
                  : "bg-white text-brand/70 hover:bg-brand/5"
              }`}
            >
              {ROLE_LABEL[r]}
            </Link>
          ))}
        </nav>
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
        <div className="rounded-2xl bg-white p-6 text-brand/70 shadow-sm ring-1 ring-black/5">
          ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY) —
          ตั้งค่า env แล้ว dashboard จะอ่านข้อมูลจริงจาก Supabase
        </div>
      </Frame>
    );
  }

  const db = await createClient();
  const viewer = await resolveViewer(db, roleParam);

  // 2) ยังไม่มีบทบาท (ไม่ล็อกอิน + ไม่ส่ง ?role=) → ให้เลือก
  if (!viewer.role) {
    return (
      <Frame activeRole={null} fromSession={viewer.fromSession}>
        <div className="rounded-2xl bg-white p-6 text-brand/70 shadow-sm ring-1 ring-black/5">
          เลือกบทบาทด้านบนเพื่อดู dashboard
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
        <div className="rounded-2xl bg-white p-6 text-brand/70 shadow-sm ring-1 ring-black/5">
          อ่านข้อมูล dashboard ไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0025) และมี session พนักงาน
        </div>
      </Frame>
    );
  }
}
