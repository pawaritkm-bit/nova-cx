import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import {
  listTeams,
  listEmployees,
  listCustomers,
  listCurrentAssignments,
} from "@/lib/admin/service";
import type { RoleCode } from "@/lib/dashboard/types";
import AppNav from "../_components/AppNav";
import AdminTabs from "./AdminTabs";
import "../dashboard/dashboard.css";
import "./admin.css";

export const dynamic = "force-dynamic";

/** กรอบหน้า admin (ใช้ธีม .nova-dash + แถบเมนูร่วมเดียวกับ dashboard) */
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
          active="admin"
          role={role}
          authed={authed}
          title="NOVA-CX · จัดการข้อมูล"
          subtitle="ทีมบัญชี · พนักงาน · ลูกค้า · มอบหมายผู้ดูแล (ข้อมูลจริง)"
        />
      </header>
      {children}
    </main>
  );
}

export default async function AdminPage() {
  // 1) ยังไม่ตั้ง env DB → degrade อย่างสุภาพ
  if (!getSupabaseEnv()) {
    return (
      <Frame>
        <div className="card">
          ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY) —
          ตั้งค่า env แล้วหน้านี้จะจัดการข้อมูลจริงได้
        </div>
      </Frame>
    );
  }

  // 2) guard: ต้อง login + เป็น admin/executive เท่านั้น
  const authed = await createClient();
  const ctx = await resolveAdminContext(authed);

  if (!ctx.hasSession) {
    redirect("/login?redirect=/admin");
  }
  if (!ctx.isAdmin || !ctx.tenantId) {
    return (
      <Frame role={ctx.role} authed={ctx.hasSession && !!ctx.role}>
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>
            คุณไม่มีสิทธิ์เข้าถึงหน้าจัดการข้อมูล
          </p>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            หน้านี้เปิดเฉพาะบทบาทผู้ดูแลระบบ (admin) และผู้บริหาร (executive) —
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

  // 3) โหลดข้อมูลด้วย service-role (อ่านข้าม RLS) แต่ scope ด้วย tenant จาก session
  try {
    const service = createServiceRoleClient();
    const tenantId = ctx.tenantId;
    const [teams, employees, customers, assignments] = await Promise.all([
      listTeams(service, tenantId),
      listEmployees(service, tenantId),
      listCustomers(service, tenantId),
      listCurrentAssignments(service, tenantId),
    ]);

    return (
      <Frame role={ctx.role} authed>
        <AdminTabs
          teams={teams}
          employees={employees}
          customers={customers}
          assignments={assignments}
        />
      </Frame>
    );
  } catch {
    return (
      <Frame role={ctx.role} authed>
        <div className="card">
          อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY แล้ว
          และ apply migration ครบ
        </div>
      </Frame>
    );
  }
}
