import Link from "next/link";
import { isAdminRole } from "@/lib/admin/guard";
import { isPrivilegedRole } from "@/lib/dashboard/access";
import { canExportReports } from "@/lib/reports";
import { canSeeAccountantReport } from "@/lib/reports/report-access";
import {
  canSeeExecDashboard,
  canSeeTeamDashboard,
  canSeeMeDashboard,
  canSeeRiskDashboard,
} from "@/lib/chat-dashboard/access";
import type { RoleCode } from "@/lib/dashboard/types";
import NovaMascot from "../liff/survey/[token]/NovaMascot";

/**
 * AppNav — แถบเมนูนำทางร่วมของหน้าหลังบ้าน (dashboard + admin + cases + reports + surveys + settings)
 *
 * รวมทุกหน้าที่ต้อง login ไว้ในเมนูเดียว: พอเข้าสู่ระบบแล้วสลับหน้าได้จากที่เดียว
 * โดยไม่ต้องพิมพ์ URL เอง
 *   - โลโก้/ชื่อ NOVA-CX + มาสคอตน้อง NOVA (reuse NovaMascot variant="profile")
 *   - ลิงก์แต่ละอันโผล่เฉพาะบทบาทที่เข้าได้ (allow-list) — กันงงว่ากดแล้วโดน redirect
 *       · Dashboard          — ทุกบทบาทที่ login
 *       · เคสร้องเรียน /cases — privileged (executive/admin/cs)
 *       · รายงาน /reports     — export ได้ (executive/admin/acc_lead/sales_lead/cs)
 *       · แบบประเมิน /surveys — admin/executive
 *       · จัดการข้อมูล /admin  — admin/executive
 *       · ตั้งค่า /settings    — admin/executive
 *   - ฝั่งขวา: ป้ายบทบาทผู้ใช้ + ปุ่มออกจากระบบ (POST /auth/logout)
 *
 * เป็น server component (ไม่มี state/hook) — รับ active/role/authed เป็น prop จากหน้าที่ resolve session แล้ว
 * ★ ไม่มีการเปลี่ยน URL/guard — เป็นชั้น presentation ล้วน ๆ (สิทธิ์จริงบังคับที่หน้า/view/RLS)
 */

/** ป้ายบทบาทภาษาไทย (ตรงกับ roles.code — ต้องครบทุกบทบาทใน RoleCode) */
export const ROLE_LABEL: Record<RoleCode, string> = {
  executive: "ผู้บริหาร",
  acc_lead: "หัวหน้าทีมบัญชี",
  accountant: "นักบัญชี",
  sales_lead: "หัวหน้าฝ่ายขาย",
  sales: "เซลล์",
  cs: "CS",
  admin: "Admin",
  auditor_qa: "ผู้ตรวจสอบ/QA",
  hr: "ฝ่ายบุคคล",
};

export type AppNavActive =
  | "dashboard"
  | "cases"
  | "chat-exec"
  | "chat-team"
  | "chat-me"
  | "chat-risk"
  | "chat-office"
  | "chat-viewer"
  | "chat-eval"
  | "chat-admin"
  | "chat-report"
  | "reports"
  | "surveys"
  | "admin"
  | "settings";

/** นิยามลิงก์เมนูหนึ่งอัน + เงื่อนไขบทบาทที่เห็นได้ */
type NavItem = {
  key: AppNavActive;
  href: string;
  label: string;
  /** true = แสดงลิงก์นี้สำหรับบทบาทนี้ (allow-list) */
  canSee: (role: RoleCode) => boolean;
};

/** กลุ่มเมนู — จัดตามวัตถุประสงค์/ความสำคัญ (เรียงบน→ล่าง) เพื่อให้ nav อ่านง่าย */
type NavGroup = {
  id: string;
  /** หัวข้อกลุ่ม (label เล็ก ๆ สีจาง) */
  label: string;
  /** เน้นกลุ่มนี้ให้เด่น (หัวใจระบบ) */
  emphasis?: boolean;
  /** ทำกลุ่มนี้ให้จางลง (ใช้นาน ๆ ครั้ง) */
  muted?: boolean;
  items: NavItem[];
};

// key/href/label/canSee ของแต่ละลิงก์คงเดิมทุกอย่าง — จัดเข้ากลุ่มตามความสำคัญเท่านั้น
const NAV_GROUPS: NavGroup[] = [
  {
    id: "overview",
    label: "ภาพรวม",
    items: [
      // Dashboard เห็นเสมอเมื่อ login (ทุกบทบาทมีหน้า dashboard ของตัวเอง)
      { key: "dashboard", href: "/dashboard", label: "Dashboard", canSee: () => true },
    ],
  },
  {
    id: "service",
    label: "ดูแลงานบริการลูกค้า",
    emphasis: true, // หัวใจระบบ — เด่นสุด
    items: [
      // ตรวจแชต (โมดูล AI วิเคราะห์แชท) — แสดงตามบทบาทที่มีสิทธิ์ในแต่ละหน้า
      { key: "chat-exec", href: "/chat-audit", label: "ตรวจแชต (ภาพรวม)", canSee: canSeeExecDashboard },
      { key: "chat-team", href: "/chat-audit/team", label: "ตรวจแชต (ทีม)", canSee: canSeeTeamDashboard },
      { key: "chat-me", href: "/chat-audit/me", label: "งานแชตของฉัน", canSee: canSeeMeDashboard },
      { key: "chat-risk", href: "/chat-audit/risk", label: "ลูกค้าเสี่ยง", canSee: canSeeRiskDashboard },
      // เคสร้องเรียนทั้งหมด — เฉพาะ privileged (executive/admin/cs)
      { key: "cases", href: "/cases", label: "เคสร้องเรียน", canSee: isPrivilegedRole },
    ],
  },
  {
    id: "assess",
    label: "ประเมิน & เสียงลูกค้า",
    items: [
      // รายงานประเมินนักบัญชี (รายเดือน) — exec/admin/auditor/lead/hr/accountant (scope จริงในหน้า)
      { key: "chat-report", href: "/chat-audit/reports", label: "รายงานประเมิน", canSee: canSeeAccountantReport },
      // ★ ประเมินสำนักงาน (แชต 1-1 ฝั่งลูกค้า) — คนละส่วนกับประเมินนักบัญชี/ทีม — admin/executive
      { key: "chat-office", href: "/chat-audit/office", label: "ประเมินสำนักงาน", canSee: isAdminRole },
      // แบบประเมิน — admin/executive
      { key: "surveys", href: "/surveys", label: "แบบประเมิน", canSee: isAdminRole },
    ],
  },
  {
    id: "config",
    label: "ตั้งค่า & ข้อมูล",
    muted: true, // ใช้นาน ๆ ครั้ง — จางลง ล่างสุด
    items: [
      // ตั้งค่าตรวจแชต (จับคู่กลุ่ม/น้ำหนัก/SLA) — admin/executive
      { key: "chat-admin", href: "/chat-audit/admin", label: "ตั้งค่าตรวจแชต", canSee: isAdminRole },
      // จัดการข้อมูล — admin/executive
      { key: "admin", href: "/admin", label: "จัดการข้อมูล", canSee: isAdminRole },
      // รายงาน/Export — บทบาทที่ export ข้อมูลผูกลูกค้าได้
      { key: "reports", href: "/reports", label: "รายงาน", canSee: canExportReports },
      // ตั้งค่า — admin/executive
      { key: "settings", href: "/settings", label: "ตั้งค่า", canSee: isAdminRole },
    ],
  },
];

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
  // กรองลิงก์ในแต่ละกลุ่มด้วย allow-list เดิม แล้วตัดกลุ่มที่ไม่มีลิงก์ให้บทบาทนี้เห็นทิ้ง
  // (ไม่โชว์หัวข้อกลุ่มลอย ๆ)
  const visibleGroups = role
    ? NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => item.canSee(role)),
      })).filter((group) => group.items.length > 0)
    : [];

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

      {/* แถบเมนูร่วม — จัดกลุ่มตามความสำคัญ มีหัวข้อกลุ่ม (wrap ได้บนจอแคบ) */}
      {showControls ? (
        <nav className="app-nav" aria-label="เมนูหลัก">
          {visibleGroups.map((group) => (
            <div
              key={group.id}
              className={`app-nav-group${group.emphasis ? " is-primary" : ""}${group.muted ? " is-muted" : ""}`}
              role="group"
              aria-label={group.label}
            >
              <span className="app-nav-group-label">{group.label}</span>
              <div className="app-nav-group-links">
                {group.items.map((item) => (
                  <Link
                    key={item.key}
                    href={item.href}
                    aria-current={active === item.key ? "page" : undefined}
                    className={`app-nav-link${active === item.key ? " active" : ""}`}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
      ) : null}
    </>
  );
}
