"use client";

/**
 * UI จัดการข้อมูล admin — 4 แท็บ (ทีม / พนักงาน / ลูกค้า / มอบหมาย)
 * - แต่ละฟอร์มยิง server action ผ่าน useActionState (React 19) → แสดงผลสำเร็จ/ผิดพลาด
 * - list มาจาก server (props) และ revalidate หลังเขียน; ฟอร์ม reset เมื่อบันทึกสำเร็จ
 */
import { useActionState, useEffect, useRef, useState } from "react";
import type {
  TeamRow,
  EmployeeRow,
  CustomerRow,
  AssignmentRow,
} from "@/lib/admin/service";
import {
  createTeamAction,
  createEmployeeAction,
  createCustomerAction,
  createAssignmentAction,
  deactivateTeamAction,
  deactivateCustomerAction,
  toggleEmployeeActiveAction,
  endAssignmentAction,
  type ActionResult,
} from "./actions";

// ---- ป้ายกำกับภาษาไทย -----------------------------------------------
const TEAM_TYPE_LABEL: Record<string, string> = {
  accounting: "บัญชี",
  sales: "ขาย",
  cs: "บริการลูกค้า (CS)",
};
const EMPLOYEE_TYPE_LABEL: Record<string, string> = {
  accountant: "นักบัญชี",
  sales: "เซล",
  cs: "CS",
  other: "อื่น ๆ",
};
const ROLE_LABEL: Record<string, string> = {
  lead: "หัวหน้า (lead)",
  member: "นักบัญชี/สมาชิก (member)",
  coordinator: "ผู้ประสานงาน (coordinator)",
};

type TabKey = "teams" | "employees" | "customers" | "assignments";

const TABS: { key: TabKey; label: string }[] = [
  { key: "teams", label: "ทีมบัญชี" },
  { key: "employees", label: "พนักงาน" },
  { key: "customers", label: "ลูกค้า" },
  { key: "assignments", label: "มอบหมาย" },
];

/** กล่องแจ้งผล (สำเร็จ/ผิดพลาด) */
function ResultNote({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return (
    <p className={`admin-note ${state.ok ? "ok" : "err"}`} role="status">
      {state.message}
    </p>
  );
}

// =====================================================================
// แท็บ 1: ทีม
// =====================================================================
function TeamsTab({
  teams,
  employees,
}: {
  teams: TeamRow[];
  employees: EmployeeRow[];
}) {
  const [state, action, pending] = useActionState(createTeamAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  const empName = (id: string | null) => {
    if (!id) return "—";
    const e = employees.find((x) => x.id === id);
    return e ? e.nickname || e.first_name : "—";
  };

  return (
    <div className="admin-grid">
      <form ref={formRef} action={action} className="card admin-form">
        <h3>เพิ่มทีม</h3>
        <label>
          ชื่อทีม *
          <input name="name" required maxLength={200} placeholder="เช่น ทีมบัญชี A" />
        </label>
        <label>
          ประเภททีม *
          <select name="type" defaultValue="accounting">
            <option value="accounting">บัญชี</option>
            <option value="sales">ขาย</option>
            <option value="cs">บริการลูกค้า (CS)</option>
          </select>
        </label>
        <label>
          หัวหน้าทีม (ไม่บังคับ)
          <select name="lead_employee_id" defaultValue="">
            <option value="">— ไม่ระบุ —</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nickname ? `${e.first_name} (${e.nickname})` : e.first_name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "กำลังบันทึก…" : "เพิ่มทีม"}
        </button>
        <ResultNote state={state} />
      </form>

      <div className="card">
        <h3>รายการทีม ({teams.length})</h3>
        {teams.length === 0 ? (
          <p className="admin-empty">ยังไม่มีทีม</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>ชื่อทีม</th>
                <th>ประเภท</th>
                <th>หัวหน้าทีม</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{TEAM_TYPE_LABEL[t.type] ?? t.type}</td>
                  <td>{empName(t.lead_employee_id)}</td>
                  <td>
                    <RowAction
                      action={deactivateTeamAction}
                      fields={{ id: t.id }}
                      label="ปิดใช้งาน"
                      confirm="ปิดใช้งานทีมนี้?"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// แท็บ 2: พนักงาน
// =====================================================================
function EmployeesTab({
  employees,
  teams,
}: {
  employees: EmployeeRow[];
  teams: TeamRow[];
}) {
  const [state, action, pending] = useActionState(createEmployeeAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <div className="admin-grid">
      <form ref={formRef} action={action} className="card admin-form">
        <h3>เพิ่มพนักงาน</h3>
        <label>
          ชื่อ-นามสกุล *
          <input name="first_name" required maxLength={200} placeholder="เช่น สมชาย ใจดี" />
        </label>
        <label>
          ชื่อเล่น
          <input name="nickname" maxLength={200} placeholder="เช่น ชาย" />
        </label>
        <label>
          ตำแหน่ง
          <input name="position" maxLength={200} placeholder="เช่น นักบัญชีอาวุโส" />
        </label>
        <label>
          ประเภทพนักงาน *
          <select name="employee_type" defaultValue="accountant">
            <option value="accountant">นักบัญชี</option>
            <option value="sales">เซล</option>
            <option value="cs">CS</option>
            <option value="other">อื่น ๆ</option>
          </select>
        </label>
        <label>
          ผูกเข้าทีม (ไม่บังคับ)
          <select name="team_id" defaultValue="">
            <option value="">— ไม่ระบุ —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-check">
          <input type="checkbox" name="is_active" defaultChecked />
          เปิดใช้งาน (active)
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "กำลังบันทึก…" : "เพิ่มพนักงาน"}
        </button>
        <ResultNote state={state} />
      </form>

      <div className="card">
        <h3>รายชื่อพนักงาน ({employees.length})</h3>
        {employees.length === 0 ? (
          <p className="admin-empty">ยังไม่มีพนักงาน</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>ชื่อ</th>
                <th>ประเภท</th>
                <th>ตำแหน่ง</th>
                <th>สถานะ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id} className={e.is_active ? "" : "row-off"}>
                  <td>
                    {e.first_name}
                    {e.nickname ? ` (${e.nickname})` : ""}
                  </td>
                  <td>{EMPLOYEE_TYPE_LABEL[e.employee_type] ?? e.employee_type}</td>
                  <td>{e.position ?? "—"}</td>
                  <td>
                    <span className={`admin-badge ${e.is_active ? "on" : "off"}`}>
                      {e.is_active ? "ใช้งาน" : "ปิด"}
                    </span>
                  </td>
                  <td>
                    <RowAction
                      action={toggleEmployeeActiveAction}
                      fields={{ id: e.id, next: String(!e.is_active) }}
                      label={e.is_active ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// แท็บ 3: ลูกค้า
// =====================================================================
function CustomersTab({ customers }: { customers: CustomerRow[] }) {
  const [state, action, pending] = useActionState(createCustomerAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <div className="admin-grid">
      <form ref={formRef} action={action} className="card admin-form">
        <h3>เพิ่มลูกค้า</h3>
        <label>
          รหัสลูกค้า
          <input name="customer_code" maxLength={200} placeholder="เช่น C-00123" />
        </label>
        <label>
          ชื่อลูกค้า *
          <input name="name" required maxLength={200} placeholder="เช่น บริษัท ก จำกัด" />
        </label>
        <label>
          ชื่อธุรกิจ
          <input name="business_name" maxLength={200} placeholder="เช่น ร้านอาหาร ก" />
        </label>
        <label>
          วันเริ่มบริการ
          <input type="date" name="service_start_date" />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "กำลังบันทึก…" : "เพิ่มลูกค้า"}
        </button>
        <ResultNote state={state} />
      </form>

      <div className="card">
        <h3>รายชื่อลูกค้า ({customers.length})</h3>
        {customers.length === 0 ? (
          <p className="admin-empty">ยังไม่มีลูกค้า</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>รหัส</th>
                <th>ชื่อ</th>
                <th>ธุรกิจ</th>
                <th>เริ่มบริการ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td>{c.customer_code ?? "—"}</td>
                  <td>{c.name}</td>
                  <td>{c.business_name ?? "—"}</td>
                  <td>{c.service_start_date ?? "—"}</td>
                  <td>
                    <RowAction
                      action={deactivateCustomerAction}
                      fields={{ id: c.id }}
                      label="ปิดใช้งาน"
                      confirm="ปิดใช้งานลูกค้านี้?"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// แท็บ 4: มอบหมาย
// =====================================================================
function AssignmentsTab({
  assignments,
  customers,
  employees,
  teams,
}: {
  assignments: AssignmentRow[];
  customers: CustomerRow[];
  employees: EmployeeRow[];
  teams: TeamRow[];
}) {
  const [state, action, pending] = useActionState(createAssignmentAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  const activeEmployees = employees.filter((e) => e.is_active);

  return (
    <div className="admin-grid">
      <form ref={formRef} action={action} className="card admin-form">
        <h3>มอบหมายลูกค้า → พนักงาน</h3>
        <label>
          ลูกค้า *
          <select name="customer_id" required defaultValue="">
            <option value="" disabled>
              — เลือกลูกค้า —
            </option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.customer_code ? `[${c.customer_code}] ` : ""}
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          พนักงาน (ผู้ดูแล) *
          <select name="employee_id" required defaultValue="">
            <option value="" disabled>
              — เลือกพนักงาน —
            </option>
            {activeEmployees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nickname ? `${e.first_name} (${e.nickname})` : e.first_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          บทบาท *
          <select name="role" defaultValue="member">
            <option value="member">นักบัญชี/สมาชิก (member)</option>
            <option value="lead">หัวหน้า (lead)</option>
            <option value="coordinator">ผู้ประสานงาน (coordinator)</option>
          </select>
        </label>
        <label>
          ทีม (ไม่บังคับ)
          <select name="team_id" defaultValue="">
            <option value="">— ไม่ระบุ —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "กำลังบันทึก…" : "มอบหมาย"}
        </button>
        <ResultNote state={state} />
        <p className="admin-hint">
          หากมอบหมายลูกค้าคนนี้ให้พนักงานคนเดิมอยู่แล้ว ระบบจะปิดรายการเดิม
          แล้วสร้างใหม่ให้อัตโนมัติ (เก็บประวัติไว้)
        </p>
      </form>

      <div className="card">
        <h3>ผู้ดูแลปัจจุบัน ({assignments.length})</h3>
        {assignments.length === 0 ? (
          <p className="admin-empty">ยังไม่มีการมอบหมาย</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>ลูกค้า</th>
                <th>ผู้ดูแล</th>
                <th>บทบาท</th>
                <th>ตั้งแต่</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.customer_code ? `[${a.customer_code}] ` : ""}
                    {a.customer_name ?? "—"}
                  </td>
                  <td>
                    {a.employee_name ?? "—"}
                    {a.employee_nickname ? ` (${a.employee_nickname})` : ""}
                  </td>
                  <td>{ROLE_LABEL[a.role] ?? a.role}</td>
                  <td>{a.valid_from}</td>
                  <td>
                    <RowAction
                      action={endAssignmentAction}
                      fields={{ id: a.id }}
                      label="สิ้นสุด"
                      confirm="สิ้นสุดการมอบหมายนี้?"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * ปุ่มทำ action ต่อแถว (ปิดใช้งาน/สลับสถานะ/สิ้นสุด) — ใช้ form + hidden fields
 * ยืนยันก่อนทำถ้ากำหนด confirm
 */
function RowAction({
  action,
  fields,
  label,
  confirm,
}: {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  fields: Record<string, string>;
  label: string;
  confirm?: string;
}) {
  const [, formAction, pending] = useActionState(action, null);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" className="admin-row-btn" disabled={pending}>
        {pending ? "…" : label}
      </button>
    </form>
  );
}

// =====================================================================
// container: แท็บ
// =====================================================================
export default function AdminTabs({
  teams,
  employees,
  customers,
  assignments,
}: {
  teams: TeamRow[];
  employees: EmployeeRow[];
  customers: CustomerRow[];
  assignments: AssignmentRow[];
}) {
  const [tab, setTab] = useState<TabKey>("teams");

  return (
    <>
      <nav className="admin-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={t.key === tab ? "active" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "teams" && <TeamsTab teams={teams} employees={employees} />}
      {tab === "employees" && (
        <EmployeesTab employees={employees} teams={teams} />
      )}
      {tab === "customers" && <CustomersTab customers={customers} />}
      {tab === "assignments" && (
        <AssignmentsTab
          assignments={assignments}
          customers={customers}
          employees={employees}
          teams={teams}
        />
      )}
    </>
  );
}
