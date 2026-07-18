import Link from "next/link";
import { isAdminRole } from "@/lib/admin/guard";
import type { RoleCode } from "@/lib/dashboard/types";
import NovaMascot from "../liff/survey/[token]/NovaMascot";

/**
 * AppNav — แถบเมนูนำทางร่วมของหน้าหลังบ้าน (dashboard + admin)
 *
 * รวมทุกหน้าที่ต้อง login ไว้ในเมนูเดียว: พอเข้าสู่ระบบแล้วสลับ Dashboard ↔ จัดการข้อมูล ได้
 * โดยไม่ต้องพิมพ์ URL เอง
 *   - โลโก้/ชื่อ NOVA-CX + มาสคอตน้อง NOVA (reuse NovaMascot variant="profile")
 *   - ลิงก์ Dashboard (เห็นเสมอ) + จัดการข้อมูล/Admin (เห็นเฉพาะ role ที่เข้าได้)
 *   - ฝั่งขวา: ป้ายบทบาทผู้ใช้ + ปุ่มออกจากระบบ (POST /auth/logout)
 *
 * เป็น server component (ไม่มี state/hook) — รับ active/role/authed เป็น prop จากหน้าที่ resolve session แล้ว
 * ★ ไม่มีการเปลี่ยน URL/guard — เป็นชั้น presentation ล้วน ๆ
 */

/** ป้ายบทบาทภาษาไทย (ตรงกับ roles.code — 7 บทบาท) */
export const ROLE_LABEL: Record<RoleCode, string> = {
  executive: "ผู้บริหาร",
  acc_lead: "หัวหน้าทีมบัญชี",
  accountant: "นักบัญชี",
  sales_lead: "หัวหน้าฝ่ายขาย",
  sales: "เซลล์",
  cs: "CS",
  admin: "Admin",
};

export type AppNavActive = "dashboard" | "admin";

export default function AppNav({
  active,
  role,
  authed,
  title,
  subtitle,
}: {
  /** หน้าปัจจุบัน (ใช้ทำ active state ของลิงก์) */
  active: AppNavActive;
  /** บทบาทผู้ใช้จาก session (null = ยังไม่ได้ผูกบทบาท/ยังไม่ login) */
  role: RoleCode | null;
  /** true = มี session พนักงานจริง → แสดงเมนู/ปุ่มออกจากระบบ */
  authed: boolean;
  title: string;
  subtitle: string;
}) {
  // แสดงเมนู/ควบคุมเฉพาะเมื่อ login จริงและมีบทบาท (หน้าถูก guard redirect อยู่แล้วถ้าไม่มี session)
  const showControls = authed && !!role;
  // ลิงก์ Admin โผล่เฉพาะบทบาทที่เข้าได้ (admin/executive) — กันงงว่ากดแล้วโดน redirect
  const canSeeAdmin = isAdminRole(role);

  return (
    <>
      <div className="dash-top">
        <div className="dash-title">
          {/* avatar น้อง NOVA (คาปิบาร่าวงกลม) ข้างชื่อระบบ */}
          <div className="dash-mascot" aria-hidden="true">
            <NovaMascot variant="profile" width={52} />
          </div>
          <div>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
        </div>

        {showControls ? (
          <div className="flex shrink-0 items-center gap-3">
            <span className="role-chip">{ROLE_LABEL[role]}</span>
            <form method="post" action="/auth/logout">
              <button type="submit" className="logout-btn">
                ออกจากระบบ
              </button>
            </form>
          </div>
        ) : null}
      </div>

      {/* แถบเมนูร่วม — สลับหน้าได้จากที่เดียว */}
      {showControls ? (
        <nav className="app-nav" aria-label="เมนูหลัก">
          <Link
            href="/dashboard"
            aria-current={active === "dashboard" ? "page" : undefined}
            className={`app-nav-link${active === "dashboard" ? " active" : ""}`}
          >
            Dashboard
          </Link>
          {canSeeAdmin ? (
            <Link
              href="/admin"
              aria-current={active === "admin" ? "page" : undefined}
              className={`app-nav-link${active === "admin" ? " active" : ""}`}
            >
              จัดการข้อมูล
            </Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
