"use client";

/**
 * UI จัดการข้อมูล admin — 4 แท็บ (ทีม / พนักงาน / ลูกค้า / มอบหมาย)
 * - แต่ละฟอร์มยิง server action ผ่าน useActionState (React 19) → แสดงผลสำเร็จ/ผิดพลาด
 * - list มาจาก server (props) และ revalidate หลังเขียน; ฟอร์ม reset เมื่อบันทึกสำเร็จ
 */
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import type {
  TeamRow,
  EmployeeRow,
  CustomerRow,
  AssignmentRow,
} from "@/lib/admin/service";
import type { WorkloadRow } from "@/lib/admin/workload";
import {
  filterLeadCandidates,
  leadEmployeeTypeForTeam,
} from "@/lib/admin/team-lead-filter";
import {
  createTeamAction,
  createEmployeeAction,
  createCustomerAction,
  updateCustomerAction,
  createAssignmentAction,
  deactivateTeamAction,
  deactivateCustomerAction,
  toggleEmployeeActiveAction,
  setCustomerAutoSurveyAction,
  sendManualSurveyAction,
  endAssignmentAction,
  type ActionResult,
  type ManualSurveyActionResult,
} from "./actions";

/** ชนิดแบบประเมินสำหรับปุ่มส่งเอง (A/B/C/D) */
const SURVEY_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "A", label: "A — สำนักงาน" },
  { value: "B", label: "B — นักบัญชี" },
  { value: "C", label: "C — เซล (ขายได้)" },
  { value: "D", label: "D — เซล (ขายไม่ได้)" },
];

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
/** ป้ายประเภทลูกค้า (0037) — ใช้ทั้งลูกค้าและทีม */
const CUSTOMER_TYPE_LABEL: Record<string, string> = {
  company: "นิติบุคคล",
  individual: "บุคคลธรรมดา",
};

type TabKey =
  | "teams"
  | "employees"
  | "customers"
  | "assignments"
  | "workload";

const TABS: { key: TabKey; label: string }[] = [
  { key: "teams", label: "ทีมบัญชี" },
  { key: "employees", label: "พนักงาน" },
  { key: "customers", label: "ลูกค้า" },
  { key: "assignments", label: "มอบหมาย" },
  { key: "workload", label: "ภาระงาน" },
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

  // ประเภททีม + หัวหน้าที่เลือก คุมด้วย state เพื่อกรอง dropdown หัวหน้าตามประเภท
  const [teamType, setTeamType] = useState<string>("accounting");
  const [leadId, setLeadId] = useState<string>("");
  // เปิด/ปิดฟอร์มเพิ่มพนักงานแบบ inline (ไม่ต้องสลับแท็บ)
  const [showAddEmployee, setShowAddEmployee] = useState(false);

  // หัวหน้าที่เลือกได้ = พนักงานที่ประเภทตรงกับประเภททีม (กันตันถ้าไม่มี mapping)
  const leadCandidates = useMemo(
    () => filterLeadCandidates(employees, teamType),
    [employees, teamType]
  );

  // ถ้าหัวหน้าที่เลือกไว้ไม่อยู่ในรายชื่อที่กรองได้แล้ว (เปลี่ยนประเภททีม) → reset
  useEffect(() => {
    if (leadId && !leadCandidates.some((e) => e.id === leadId)) setLeadId("");
  }, [leadCandidates, leadId]);

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      // reset ค่าที่คุมด้วย state เองด้วย (form.reset ไม่แตะ controlled)
      setTeamType("accounting");
      setLeadId("");
    }
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
          <select
            name="type"
            value={teamType}
            onChange={(e) => setTeamType(e.target.value)}
          >
            <option value="accounting">บัญชี</option>
            <option value="sales">ขาย</option>
            <option value="cs">บริการลูกค้า (CS)</option>
          </select>
        </label>
        <label>
          หัวหน้าทีม (ไม่บังคับ)
          <div className="admin-inline-row">
            <select
              name="lead_employee_id"
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
            >
              <option value="">— ไม่ระบุ —</option>
              {leadCandidates.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.nickname ? `${e.first_name} (${e.nickname})` : e.first_name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="admin-row-btn"
              onClick={() => setShowAddEmployee(true)}
              title="เพิ่มพนักงาน/หัวหน้าใหม่โดยไม่ต้องสลับแท็บ"
            >
              + เพิ่มพนักงาน
            </button>
          </div>
          {leadCandidates.length === 0 && (
            <span className="admin-hint">
              ยังไม่มีพนักงานประเภทนี้ — กด “+ เพิ่มพนักงาน” เพื่อสร้าง
            </span>
          )}
        </label>
        <label>
          ทีมนี้ดูแลประเภท
          <select name="handles_customer_type" defaultValue="">
            <option value="">ทั้งสองประเภท (ไม่ระบุ)</option>
            <option value="company">นิติบุคคล</option>
            <option value="individual">บุคคลธรรมดา</option>
          </select>
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "กำลังบันทึก…" : "เพิ่มทีม"}
        </button>
        <ResultNote state={state} />
      </form>

      {showAddEmployee && (
        <AddEmployeeInlineModal
          // default ประเภทพนักงาน = ตามประเภททีมที่เลือกอยู่ (ถ้ามี mapping)
          defaultEmployeeType={leadEmployeeTypeForTeam(teamType) ?? "accountant"}
          onClose={() => setShowAddEmployee(false)}
        />
      )}

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
                <th>ดูแลประเภท</th>
                <th>หัวหน้าทีม</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{TEAM_TYPE_LABEL[t.type] ?? t.type}</td>
                  <td>
                    {t.handles_customer_type
                      ? CUSTOMER_TYPE_LABEL[t.handles_customer_type] ??
                        t.handles_customer_type
                      : "ทั้งสอง"}
                  </td>
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

/**
 * ฟอร์มเพิ่มพนักงาน/หัวหน้าแบบ modal เล็ก (เรียกจากฟอร์มทีม — ไม่ต้องสลับแท็บ)
 * - reuse createEmployeeAction เดิม (guard/schema/audit เดิมทั้งหมด)
 * - สำเร็จ → revalidatePath('/admin') ใน action ทำให้ props employees อัปเดต
 *   → พนักงานใหม่โผล่ใน dropdown หัวหน้าให้เลือกได้ทันที แล้วปิด modal
 * หมายเหตุ: แยกเป็น modal (นอก <form> ทีม) เพื่อเลี่ยง nested form ที่ HTML ไม่รองรับ
 */
function AddEmployeeInlineModal({
  defaultEmployeeType,
  onClose,
}: {
  defaultEmployeeType: string;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState(createEmployeeAction, null);

  // สำเร็จ → ปิด modal (list refresh จาก revalidate ของ action)
  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  // ปิดด้วยปุ่ม Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="admin-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="admin-modal"
        role="dialog"
        aria-modal="true"
        aria-label="เพิ่มพนักงาน/หัวหน้า"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-modal-header">
          <h3>เพิ่มพนักงาน/หัวหน้า</h3>
          <button
            type="button"
            className="admin-modal-close"
            onClick={onClose}
            aria-label="ปิด"
          >
            ✕
          </button>
        </div>

        <form action={action} className="admin-form admin-modal-form">
          <label>
            ชื่อ-นามสกุล *
            <input
              name="first_name"
              required
              maxLength={200}
              placeholder="เช่น สมชาย ใจดี"
            />
          </label>
          <label>
            ชื่อเล่น
            <input name="nickname" maxLength={200} placeholder="เช่น ชาย" />
          </label>
          <label>
            ประเภทพนักงาน *
            <select name="employee_type" defaultValue={defaultEmployeeType}>
              <option value="accountant">นักบัญชี</option>
              <option value="sales">เซล</option>
              <option value="cs">CS</option>
              <option value="other">อื่น ๆ</option>
            </select>
          </label>
          {/* บันทึกเป็น active เสมอ ให้เลือกเป็นหัวหน้าได้เลย */}
          <input type="hidden" name="is_active" value="true" />
          <button type="submit" disabled={pending}>
            {pending ? "กำลังบันทึก…" : "บันทึกพนักงาน"}
          </button>
          <ResultNote state={state} />
          <p className="admin-hint">
            บันทึกแล้วพนักงานจะปรากฏใน dropdown หัวหน้าทีมให้เลือกได้ทันที
          </p>
        </form>
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

  // ลูกค้าที่กำลังเปิดแผงแก้ไข — เก็บเป็น id แล้ว lookup จาก list ล่าสุด
  //   (หลัง revalidate ค่าใน editing จะ fresh; ถ้าลูกค้าถูกปิดใช้งาน list จะไม่มี → แผงปิดเอง)
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = customers.find((c) => c.id === editingId) ?? null;

  // ตัวกรองตามประเภทลูกค้า (ทั้งหมด/นิติบุคคล/บุคคลธรรมดา/ยังไม่ระบุ)
  const [typeFilter, setTypeFilter] = useState<
    "all" | "company" | "individual" | "none"
  >("all");
  const filtered = useMemo(() => {
    if (typeFilter === "all") return customers;
    if (typeFilter === "none")
      return customers.filter((c) => !c.customer_type);
    return customers.filter((c) => c.customer_type === typeFilter);
  }, [customers, typeFilter]);

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
          ประเภทลูกค้า
          <select name="customer_type" defaultValue="">
            <option value="">— ยังไม่ระบุ —</option>
            <option value="company">นิติบุคคล (บริษัท)</option>
            <option value="individual">บุคคลธรรมดา</option>
          </select>
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
        <h3>รายชื่อลูกค้า ({filtered.length}/{customers.length})</h3>
        <p className="admin-hint">
          กด “แก้ไข” เพื่อเปิดแผงจัดการลูกค้ารายคน — แก้ข้อมูล, สลับ “ส่งอัตโนมัติ”,
          ส่งแบบประเมินเอง (A/B/C/D) และปิดใช้งาน รวมไว้ที่เดียว
        </p>
        <label className="admin-filter">
          กรองตามประเภท
          <select
            value={typeFilter}
            onChange={(e) =>
              setTypeFilter(
                e.target.value as "all" | "company" | "individual" | "none"
              )
            }
          >
            <option value="all">ทั้งหมด</option>
            <option value="company">นิติบุคคล</option>
            <option value="individual">บุคคลธรรมดา</option>
            <option value="none">ยังไม่ระบุ</option>
          </select>
        </label>
        {customers.length === 0 ? (
          <p className="admin-empty">ยังไม่มีลูกค้า</p>
        ) : filtered.length === 0 ? (
          <p className="admin-empty">ไม่มีลูกค้าตรงกับตัวกรองที่เลือก</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>รหัส</th>
                <th>ชื่อ</th>
                <th>ประเภท</th>
                <th>ธุรกิจ</th>
                <th>เริ่มบริการ</th>
                <th>ส่งอัตโนมัติ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td>{c.customer_code ?? "—"}</td>
                  <td>{c.name}</td>
                  <td>
                    {c.customer_type ? (
                      <span className="admin-badge type">
                        {CUSTOMER_TYPE_LABEL[c.customer_type] ?? c.customer_type}
                      </span>
                    ) : (
                      <span className="admin-badge off">ยังไม่ระบุ</span>
                    )}
                  </td>
                  <td>{c.business_name ?? "—"}</td>
                  <td>{c.service_start_date ?? "—"}</td>
                  <td>
                    <span
                      className={`admin-badge ${c.auto_survey_enabled ? "on" : "off"}`}
                    >
                      {c.auto_survey_enabled ? "เปิด" : "ปิด"}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="admin-edit-btn"
                      onClick={() => setEditingId(c.id)}
                    >
                      แก้ไข
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <CustomerEditPanel
          customer={editing}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

/**
 * แผงแก้ไขลูกค้ารายคน (modal) — รวมทุก control ของลูกค้าคนนั้นไว้ที่เดียว:
 *   1) ฟอร์มแก้ฟิลด์ (รหัส/ชื่อ/ธุรกิจ/วันเริ่มบริการ) → updateCustomerAction
 *   2) สวิตช์ "ส่งอัตโนมัติ"  3) ปุ่มส่งแบบประเมินเอง  4) ปิดใช้งานลูกค้า
 * ค่าทั้งหมดมาจาก server (props) และ revalidate หลังเขียน — modal อ่านค่าล่าสุดเสมอ
 */
function CustomerEditPanel({
  customer,
  onClose,
}: {
  customer: CustomerRow;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState(updateCustomerAction, null);

  // ปิดแผงด้วยปุ่ม Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="admin-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="admin-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`แก้ไขลูกค้า ${customer.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-modal-header">
          <h3>แก้ไขลูกค้า</h3>
          <button
            type="button"
            className="admin-modal-close"
            onClick={onClose}
            aria-label="ปิดแผงแก้ไข"
          >
            ✕
          </button>
        </div>

        {/* 1) แก้ฟิลด์ลูกค้า — key=id ให้ remount ค่า default เมื่อสลับลูกค้า */}
        <form
          key={customer.id}
          action={action}
          className="admin-form admin-modal-form"
        >
          <input type="hidden" name="customerId" value={customer.id} />
          <label>
            รหัสลูกค้า
            <input
              name="customer_code"
              maxLength={200}
              defaultValue={customer.customer_code ?? ""}
              placeholder="เช่น C-00123"
            />
          </label>
          <label>
            ชื่อลูกค้า *
            <input
              name="name"
              required
              maxLength={200}
              defaultValue={customer.name}
            />
          </label>
          <label>
            ชื่อธุรกิจ
            <input
              name="business_name"
              maxLength={200}
              defaultValue={customer.business_name ?? ""}
              placeholder="เช่น ร้านอาหาร ก"
            />
          </label>
          <label>
            ประเภทลูกค้า
            <select
              name="customer_type"
              defaultValue={customer.customer_type ?? ""}
            >
              <option value="">— ยังไม่ระบุ —</option>
              <option value="company">นิติบุคคล (บริษัท)</option>
              <option value="individual">บุคคลธรรมดา</option>
            </select>
          </label>
          <label>
            วันเริ่มบริการ
            <input
              type="date"
              name="service_start_date"
              defaultValue={customer.service_start_date ?? ""}
            />
          </label>
          <button type="submit" disabled={pending}>
            {pending ? "กำลังบันทึก…" : "บันทึกการแก้ไข"}
          </button>
          <ResultNote state={state} />
        </form>

        {/* 2) สวิตช์ส่งอัตโนมัติ */}
        <div className="admin-modal-section admin-modal-row">
          <div>
            <strong>ส่งแบบประเมินอัตโนมัติ</strong>
            <p className="admin-hint">
              คุมเฉพาะรอบอัตโนมัติ (สำนักงานราย 3 เดือน / นักบัญชีรายเดือน) —
              ปิดไว้ = ระบบจะไม่ส่งเองจนกว่าจะเปิด
            </p>
          </div>
          <AutoSurveyToggle
            customerId={customer.id}
            enabled={customer.auto_survey_enabled}
          />
        </div>

        {/* 3) ส่งแบบประเมินเอง (A/B/C/D) */}
        <div className="admin-modal-section">
          <strong>ส่งแบบประเมินเอง</strong>
          <p className="admin-hint">
            ส่งได้ทันทีไม่ว่าสวิตช์ส่งอัตโนมัติจะเปิดหรือปิด
          </p>
          <ManualSendCell customerId={customer.id} customerName={customer.name} />
        </div>

        {/* 4) ปิดใช้งานลูกค้า (destructive) */}
        <div className="admin-modal-section admin-modal-danger admin-modal-row">
          <div>
            <strong>ปิดใช้งานลูกค้า</strong>
            <p className="admin-hint">
              ลูกค้าจะถูกซ่อนจากรายการและการมอบหมาย (เก็บประวัติไว้)
            </p>
          </div>
          <RowAction
            action={deactivateCustomerAction}
            fields={{ id: customer.id }}
            label="ปิดใช้งานลูกค้า"
            confirm={`ปิดใช้งานลูกค้า “${customer.name}” ?`}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * สวิตช์ "ส่งอัตโนมัติ" ต่อลูกค้า — กดสลับสถานะ (ส่งค่าเป้าหมายไปเป็น hidden field)
 * ค่าจริงมาจาก server (props) ไม่เชื่อ state ฝั่ง client; revalidate หลังบันทึก
 */
function AutoSurveyToggle({
  customerId,
  enabled,
}: {
  customerId: string;
  enabled: boolean;
}) {
  const [, formAction, pending] = useActionState(
    setCustomerAutoSurveyAction,
    null
  );
  const next = !enabled;
  return (
    <form action={formAction}>
      <input type="hidden" name="customer_id" value={customerId} />
      <input type="hidden" name="enabled" value={String(next)} />
      <button
        type="submit"
        className={`admin-toggle ${enabled ? "on" : "off"}`}
        disabled={pending}
        title={enabled ? "กดเพื่อปิดส่งอัตโนมัติ" : "กดเพื่อเปิดส่งอัตโนมัติ"}
      >
        {pending ? "…" : enabled ? "เปิด" : "ปิด"}
      </button>
    </form>
  );
}

/**
 * ปุ่ม "ส่งแบบประเมิน" (กดเอง) ต่อลูกค้า — เลือกชนิด A/B/C/D แล้วส่ง
 *   สำเร็จ + push → แจ้ง "ส่งเข้า LINE แล้ว"
 *   สำเร็จ + ไม่ push → แสดงลิงก์ + ปุ่มคัดลอกให้ส่งเอง
 */
function ManualSendCell({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const [state, formAction, pending] = useActionState<
    ManualSurveyActionResult | null,
    FormData
  >(sendManualSurveyAction, null);
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    if (!state?.surveyUrl) return;
    try {
      await navigator.clipboard.writeText(state.surveyUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="admin-manual-send">
      <form
        action={formAction}
        onSubmit={(e) => {
          const type = new FormData(e.currentTarget).get("survey_type");
          if (
            !window.confirm(
              `ส่งแบบประเมิน ${type} ให้ “${customerName}” ใช่หรือไม่?`
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="customer_id" value={customerId} />
        <select name="survey_type" defaultValue="A" aria-label="ชนิดแบบประเมิน">
          {SURVEY_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="submit" className="admin-row-btn" disabled={pending}>
          {pending ? "กำลังส่ง…" : "ส่ง"}
        </button>
      </form>

      {state && (
        <div className={`admin-note ${state.ok ? "ok" : "err"}`} role="status">
          <span>{state.message}</span>
          {state.ok && !state.pushed && state.surveyUrl && (
            <div className="admin-link-copy">
              <input readOnly value={state.surveyUrl} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="admin-row-btn" onClick={copyLink}>
                {copied ? "คัดลอกแล้ว" : "คัดลอก"}
              </button>
            </div>
          )}
        </div>
      )}
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

// =====================================================================
// แท็บ 5: ภาระงาน (นักบัญชีแต่ละคนดูแลลูกค้ากี่ราย)
// =====================================================================
function WorkloadTab({ workload }: { workload: WorkloadRow[] }) {
  // ยอดรวมท้ายตาราง (นับทั้งทีม) — ช่วยเห็นภาพรวม
  const totals = workload.reduce(
    (acc, r) => {
      acc.total += r.total;
      acc.company += r.company;
      acc.individual += r.individual;
      acc.unspecified += r.unspecified;
      return acc;
    },
    { total: 0, company: 0, individual: 0, unspecified: 0 }
  );

  return (
    <div className="admin-grid">
      <div className="card admin-card-wide">
        <h3>ภาระงานนักบัญชี ({workload.length} คน)</h3>
        <p className="admin-hint">
          นับจาก “ผู้ดูแลปัจจุบัน” ของลูกค้าที่ยังใช้งานอยู่ — แยกตามประเภทลูกค้า
          (นิติบุคคล / บุคคลธรรมดา / ยังไม่ระบุ) เรียงจากมากไปน้อย
        </p>
        {workload.length === 0 ? (
          <p className="admin-empty">ยังไม่มีการมอบหมายลูกค้าให้นักบัญชี</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>นักบัญชี</th>
                <th>ทีม</th>
                <th className="num">รวม</th>
                <th className="num">นิติบุคคล</th>
                <th className="num">บุคคลธรรมดา</th>
                <th className="num">ยังไม่ระบุ</th>
              </tr>
            </thead>
            <tbody>
              {workload.map((r) => (
                <tr key={r.employee_id}>
                  <td>
                    {r.employee_name ?? "—"}
                    {r.employee_nickname ? ` (${r.employee_nickname})` : ""}
                  </td>
                  <td>{r.team_name ?? "—"}</td>
                  <td className="num">
                    <strong>{r.total}</strong>
                  </td>
                  <td className="num">{r.company}</td>
                  <td className="num">{r.individual}</td>
                  <td className="num">{r.unspecified}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>
                  <strong>รวมทั้งหมด</strong>
                </td>
                <td className="num">
                  <strong>{totals.total}</strong>
                </td>
                <td className="num">{totals.company}</td>
                <td className="num">{totals.individual}</td>
                <td className="num">{totals.unspecified}</td>
              </tr>
            </tfoot>
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
  workload,
}: {
  teams: TeamRow[];
  employees: EmployeeRow[];
  customers: CustomerRow[];
  assignments: AssignmentRow[];
  workload: WorkloadRow[];
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
      {tab === "workload" && <WorkloadTab workload={workload} />}
    </>
  );
}
