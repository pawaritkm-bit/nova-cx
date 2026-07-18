"use client";

import { useActionState, useState } from "react";
import { setMemberAction, type ActionResult } from "@/lib/chat-admin/actions";
import type { ChatMemberRow } from "@/lib/chat-admin/mapping";

type EmployeeOpt = { id: string; name: string };

const KIND_LABEL: Record<string, string> = {
  customer: "ลูกค้า",
  accountant: "นักบัญชี",
  lead: "หัวหน้า",
  system: "ระบบ",
  unknown: "ยังไม่ระบุ",
};

/** ต้องผูกพนักงานเมื่อบทบาทเป็นนักบัญชี/หัวหน้า */
function needsEmployee(kind: string): boolean {
  return kind === "accountant" || kind === "lead";
}

function MemberRow({ member, employees }: { member: ChatMemberRow; employees: EmployeeOpt[] }) {
  const [state, formAction] = useActionState(setMemberAction, null);
  const [kind, setKind] = useState(member.memberKind);

  return (
    <tr>
      <td>{member.memberName ?? <span className="muted">— (ไม่มีชื่อ/ยังไม่มีคีย์ถอดรหัส) —</span>}</td>
      <td>
        <form action={formAction} className="inline-form">
          <input type="hidden" name="chat_member_id" value={member.id} />
          <select name="member_kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KIND_LABEL).map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          <select name="employee_id" defaultValue={member.employeeId ?? ""} disabled={!needsEmployee(kind)}>
            <option value="">— เลือกพนักงาน —</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          <button type="submit" className="btn">บันทึก</button>
        </form>
        <Msg state={state} />
      </td>
      <td className="center">
        {member.employeeName ? (
          <span className="badge b-blue">{member.employeeName}</span>
        ) : member.memberKind === "unknown" ? (
          <span className="badge b-yellow">ยังไม่ระบุ</span>
        ) : (
          <span className="badge b-green">✓</span>
        )}
      </td>
    </tr>
  );
}

function Msg({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return <p className={`action-msg ${state.ok ? "ok" : "err"}`}>{state.message}</p>;
}

export default function MembersPanel({
  members,
  employees,
}: {
  members: ChatMemberRow[];
  employees: EmployeeOpt[];
}) {
  const unknownCount = members.filter((m) => m.memberKind === "unknown").length;
  return (
    <div className="card">
      <div className="section-title">
        <span>สมาชิกในกลุ่ม</span>
        {unknownCount > 0 ? (
          <span className="badge b-yellow">ยังไม่ระบุ {unknownCount} คน</span>
        ) : (
          <span className="badge b-green">ระบุครบแล้ว</span>
        )}
      </div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        LINE ไม่บอกว่าใครเป็นนักบัญชี — เลือกบทบาทให้แต่ละคน (นักบัญชี/หัวหน้า ต้องผูกกับพนักงาน) เพื่อให้ระบบรู้ว่าใครตอบช้า/เร็ว
      </p>
      {members.length === 0 ? (
        <p className="empty">ยังไม่มีสมาชิกในกลุ่มนี้ (รอเก็บข้อความจากกลุ่ม)</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>ชื่อใน LINE</th>
                <th>บทบาท + ผูกพนักงาน</th>
                <th className="center">สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <MemberRow key={m.id} member={m} employees={employees} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
