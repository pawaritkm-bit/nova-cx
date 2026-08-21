import type { RoleCode } from "@/lib/dashboard/types";
import AppNav, { type AppNavActive } from "../_components/AppNav";
import "../dashboard/dashboard.css";
import "./chat-audit.css";

/**
 * กรอบหน้าโมดูลตรวจแชต (reuse ธีม .nova-dash + แถบเมนูร่วม AppNav)
 *   - server component ล้วน (ไม่มี state) — รับ role/authed จากหน้าที่ resolve session แล้ว
 */
export default function ChatAuditFrame({
  active,
  role,
  authed,
  title,
  subtitle,
  staffOnly = false,
  bare = false,
  children,
}: {
  active: AppNavActive;
  role: RoleCode | null;
  authed: boolean;
  title: string;
  subtitle: string;
  /** true = โหมด staff (นักบัญชี LINE) → เมนูจำกัดเฉพาะบัญชีของตัวเอง */
  staffOnly?: boolean;
  /** true = ซ่อนแถบเมนู (ไว้ฝังใน iframe ของหน้าอื่น เช่น โต๊ะทำงาน → กระทบยอดธนาคารในแท็บเดียว) */
  bare?: boolean;
  children: React.ReactNode;
}) {
  if (bare) {
    return <main className="nova-dash nova-dash-bare">{children}</main>;
  }
  return (
    <main className="nova-dash">
      <header>
        <AppNav
          active={active}
          role={role}
          authed={authed}
          title={title}
          subtitle={subtitle}
          staffOnly={staffOnly}
        />
      </header>
      {children}
    </main>
  );
}
