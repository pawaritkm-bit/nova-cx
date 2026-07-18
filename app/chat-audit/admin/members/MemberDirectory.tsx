"use client";

import { useActionState, useMemo, useState } from "react";
import { propagateMemberAction, type ActionResult } from "@/lib/chat-admin/actions";
import type { MemberDirectoryEntry } from "@/lib/chat-admin/member-directory";

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

function Msg({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return <p className={`action-msg ${state.ok ? "ok" : "err"}`}>{state.message}</p>;
}

function MemberRow({ entry, employees }: { entry: MemberDirectoryEntry; employees: EmployeeOpt[] }) {
  const [state, formAction, pending] = useActionState(propagateMemberAction, null);
  const [kind, setKind] = useState(needsEmployee(entry.memberKind) ? entry.memberKind : "accountant");
  const [empId, setEmpId] = useState(entry.boundEmployeeId ?? "");
  const [expanded, setExpanded] = useState(false);
  // กลุ่มที่ติ๊กเลือก (สำหรับโหมด "ผูกเฉพาะที่เลือก") — ค่าเริ่มต้น: เฉพาะที่ยังไม่ผูก
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(entry.groups.filter((g) => !g.employeeId).map((g) => g.groupId))
  );

  const unlinkedCount = useMemo(() => entry.groups.filter((g) => !g.employeeId).length, [entry.groups]);

  function toggle(groupId: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  return (
    <>
      <tr>
        <td>
          {entry.displayName ?? <span className="muted">— (ไม่มีชื่อ/ยังไม่มีคีย์ถอดรหัส) —</span>}
          <div className="muted" style={{ fontSize: 11 }}>{entry.lineUserId.slice(0, 10)}…</div>
        </td>
        <td className="center">
          <span className={`badge ${entry.groupCount >= 10 ? "b-orange" : "b-blue"}`}>
            {entry.groupCount} กลุ่ม
          </span>
        </td>
        <td className="center">
          {entry.isLinked ? (
            <span className="badge b-green">✓ ผูกแล้ว</span>
          ) : (
            <span className="badge b-yellow">ยังไม่ผูก</span>
          )}
        </td>
        <td className="center">
          <button type="button" className="btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "ปิด" : "ผูกตัวตน"}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={4}>
            <form action={formAction} className="propagate-box">
              <input type="hidden" name="line_user_id" value={entry.lineUserId} />
              <div className="inline-form" style={{ flexWrap: "wrap", gap: 8 }}>
                <label className="muted" style={{ fontSize: 13 }}>บทบาท</label>
                <select name="member_kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                  {Object.entries(KIND_LABEL).map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
                <label className="muted" style={{ fontSize: 13 }}>พนักงาน</label>
                <select
                  name="employee_id"
                  value={empId}
                  onChange={(e) => setEmpId(e.target.value)}
                  disabled={!needsEmployee(kind)}
                >
                  <option value="">— เลือกพนักงาน —</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
              </div>

              <p className="muted" style={{ fontSize: 13, margin: "8px 0" }}>
                คนนี้อยู่ <b>{entry.groupCount}</b> กลุ่ม (ยังไม่ผูก {unlinkedCount} กลุ่ม)
                {entry.groupCount >= 10 ? " — อยู่หลายกลุ่มมาก อาจเป็นหัวหน้า/ทีมกลาง ตรวจก่อนผูก" : ""}
              </p>

              {/* preview รายชื่อกลุ่ม + เลือกบางกลุ่ม (review ก่อนผูก) */}
              <details className="group-preview">
                <summary>ดูรายชื่อกลุ่มที่อยู่ ({entry.groupCount})</summary>
                <div className="group-list">
                  {entry.groups.map((g) => (
                    <label key={g.groupId} className="group-item">
                      <input
                        type="checkbox"
                        name="group_ids"
                        value={g.groupId}
                        checked={checked.has(g.groupId)}
                        onChange={() => toggle(g.groupId)}
                      />
                      <span>{g.groupName ?? <span className="muted">— (ไม่มีชื่อ) —</span>}</span>
                      {g.employeeId ? <span className="badge b-green" style={{ marginLeft: 6 }}>ผูกแล้ว</span> : null}
                    </label>
                  ))}
                </div>
              </details>

              <div className="btn-row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
                <button type="submit" name="scope" value="all" className="btn green" disabled={pending}>
                  ผูกทุกกลุ่มที่ยังไม่ผูก ({unlinkedCount})
                </button>
                <button type="submit" name="scope" value="selected" className="btn" disabled={pending || checked.size === 0}>
                  ผูกเฉพาะที่เลือก ({checked.size})
                </button>
              </div>
              <Msg state={state} />
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function MemberDirectory({
  entries,
  employees,
}: {
  entries: MemberDirectoryEntry[];
  employees: EmployeeOpt[];
}) {
  const linked = entries.filter((e) => e.isLinked).length;
  return (
    <div className="card">
      <div className="section-title">
        <span>จับคู่สมาชิก (ภาพรวมทั้งสำนักงาน)</span>
        <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
          ผูกแล้ว {linked}/{entries.length} คน
        </span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        รวมสมาชิก LINE ทุกคนจากทุกกลุ่ม (คนเดียวกันแม้อยู่หลายกลุ่ม = 1 แถว) เรียงตามจำนวนกลุ่มมาก→น้อย
        — คนที่อยู่หลายกลุ่มมักเป็นนักบัญชี/หัวหน้า/ทีมกลาง <b>ตรวจก่อนผูก</b> แล้วผูกทีเดียวหลายกลุ่มได้
      </p>
      {entries.length === 0 ? (
        <p className="empty">ยังไม่มีสมาชิก (รอเก็บข้อความจากกลุ่ม)</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>ชื่อใน LINE</th>
                <th className="center">จำนวนกลุ่ม</th>
                <th className="center">สถานะ</th>
                <th className="center">จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <MemberRow key={e.lineUserId} entry={e} employees={employees} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
