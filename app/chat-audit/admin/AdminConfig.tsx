"use client";

import { useRef, useState } from "react";
import { useActionState } from "react";
import Link from "next/link";
import { EVAL_DIMENSIONS } from "@/lib/chat-dashboard/evaluation-detail";
import { DIMENSIONS, type Weights } from "@/lib/evaluation/weights";
import {
  mapGroupAction,
  saveWeightsAction,
  createSlaRuleAction,
  deleteSlaRuleAction,
  toggleSlaRuleAction,
  type ActionResult,
} from "@/lib/chat-admin/actions";
import type { ChatGroupRow } from "@/lib/chat-admin/mapping";
import type { SlaRuleRow } from "@/lib/chat-admin/sla";

type CustomerOpt = { id: string; name: string; code: string | null };
type TeamOpt = { id: string; name: string };
type CustomerSuggestionOpt = { customerId: string; customerName: string };

const URGENCY_LABEL: Record<string, string> = {
  critical: "ด่วนมาก",
  high: "เร่ง",
  medium: "ปกติ",
  low: "ต่ำ",
};

/** ข้อความผลลัพธ์ของ action (ok/err) */
function Msg({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return <p className={`action-msg ${state.ok ? "ok" : "err"}`}>{state.message}</p>;
}

// ---------------------------------------------------------------------
// แท็บ 1: จับคู่กลุ่ม → ลูกค้า
// ---------------------------------------------------------------------
function GroupRow({
  group,
  customers,
  suggestions,
}: {
  group: ChatGroupRow;
  customers: CustomerOpt[];
  suggestions: CustomerSuggestionOpt[];
}) {
  const [state, formAction] = useActionState(mapGroupAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const [customerId, setCustomerId] = useState(group.customerId ?? "");

  // กดปุ่มแนะนำ → ตั้งค่าลูกค้าแล้ว submit ฟอร์มเดิม (ผ่าน mapGroupAction + audit)
  function pickSuggestion(id: string) {
    setCustomerId(id);
    // ให้ state อัปเดต value ก่อนแล้วค่อย submit
    requestAnimationFrame(() => formRef.current?.requestSubmit());
  }

  return (
    <tr>
      <td>{group.groupName ?? <span className="muted">— (ไม่มีชื่อ/ยังไม่มีคีย์ถอดรหัส) —</span>}</td>
      <td>
        {/* ตัวช่วย 2: ปุ่มแนะนำลูกค้าจากชื่อกลุ่ม (เหนือ dropdown เดิม) — กดเลือกเร็ว */}
        {!group.customerId && suggestions.length > 0 ? (
          <div className="suggest-chips">
            <span className="muted" style={{ fontSize: 11 }}>แนะนำ:</span>
            {suggestions.map((s) => (
              <button
                key={s.customerId}
                type="button"
                className="chip"
                title="กดเพื่อจับคู่ลูกค้ารายนี้"
                onClick={() => pickSuggestion(s.customerId)}
              >
                {s.customerName}
              </button>
            ))}
          </div>
        ) : null}
        <form action={formAction} className="inline-form" ref={formRef}>
          <input type="hidden" name="chat_group_id" value={group.id} />
          <select name="customer_id" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">— ยังไม่จับคู่ —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.code ? ` (${c.code})` : ""}
              </option>
            ))}
          </select>
          <button type="submit" className="btn">บันทึก</button>
        </form>
        <Msg state={state} />
      </td>
      <td className="center">{group.memberCount}</td>
      <td className="center">
        {group.customerId ? (
          <span className="badge b-green">✓ จับคู่แล้ว</span>
        ) : (
          <span className="badge b-orange">รอจับคู่</span>
        )}
      </td>
      <td className="center">
        <Link href={`/chat-audit/admin/groups/${group.id}`} className="btn">จัดการสมาชิก</Link>
      </td>
    </tr>
  );
}

function MappingPanel({
  groups,
  customers,
  suggestionsByGroup,
}: {
  groups: ChatGroupRow[];
  customers: CustomerOpt[];
  suggestionsByGroup: Record<string, CustomerSuggestionOpt[]>;
}) {
  const mapped = groups.filter((g) => g.customerId).length;
  return (
    <div className="card">
      <div className="section-title">
        <span>จับคู่กลุ่ม LINE → ลูกค้า</span>
        <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
          จับคู่แล้ว {mapped}/{groups.length} กลุ่ม
        </span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        จับคู่กลุ่มที่บอทเข้าไปแล้วให้ตรงกับ &quot;ลูกค้า&quot; แล้วกด &quot;จัดการสมาชิก&quot; เพื่อระบุว่าใครคือนักบัญชี/ลูกค้า
        — หรือใช้ <Link href="/chat-audit/admin/members" className="underline">จับคู่สมาชิก (ภาพรวม)</Link> เพื่อผูกนักบัญชีทีเดียวหลายกลุ่ม
      </p>
      {groups.length === 0 ? (
        <p className="empty">ยังไม่มีกลุ่ม LINE (รอบอทเข้ากลุ่มและเก็บข้อความ)</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>กลุ่ม LINE</th>
                <th>ลูกค้าที่จับคู่</th>
                <th className="center">สมาชิก</th>
                <th className="center">สถานะ</th>
                <th className="center"></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupRow key={g.id} group={g} customers={customers} suggestions={suggestionsByGroup[g.id] ?? []} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// แท็บ 2: น้ำหนักคะแนน 8 มิติ
// ---------------------------------------------------------------------
function WeightsPanel({ weights }: { weights: Weights }) {
  const [state, formAction] = useActionState(saveWeightsAction, null);
  const [vals, setVals] = useState<Record<string, number>>({ ...weights });
  const total = DIMENSIONS.reduce((s, d) => s + (Number(vals[d]) || 0), 0);
  const ok = Math.abs(total - 100) < 0.01;

  return (
    <div className="card">
      <div className="section-title">
        <span>น้ำหนักการให้คะแนน 8 มิติ</span>
        <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>ปรับให้รวมได้ 100</span>
      </div>
      <form action={formAction}>
        {EVAL_DIMENSIONS.map((dim, i) => (
          <div className="weight-row" key={dim.key}>
            <div className="wlabel">{i + 1}. {dim.label}</div>
            <input
              type="range"
              min={0}
              max={40}
              value={vals[dim.key] ?? 0}
              onChange={(e) => setVals((v) => ({ ...v, [dim.key]: Number(e.target.value) }))}
            />
            <input
              type="number"
              name={dim.key}
              className="wval"
              min={0}
              max={100}
              value={vals[dim.key] ?? 0}
              onChange={(e) => setVals((v) => ({ ...v, [dim.key]: Number(e.target.value) }))}
              style={{ width: 64, textAlign: "right", border: "1px solid var(--line)", borderRadius: 8, padding: "4px 8px", fontFamily: "inherit" }}
            />
          </div>
        ))}
        <div className={`weight-total ${ok ? "good" : ""}`}>
          <span>{ok ? "รวมน้ำหนักทั้งหมด (ครบ 100 ✓)" : "รวมน้ำหนักทั้งหมด (ต้องเท่ากับ 100)"}</span>
          <span className="tnum">{total}</span>
        </div>
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button type="submit" className="btn green" disabled={!ok}>บันทึกน้ำหนัก</button>
        </div>
        <Msg state={state} />
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------
// แท็บ 3: SLA rules
// ---------------------------------------------------------------------
function SlaRow({ rule, teams }: { rule: SlaRuleRow; teams: TeamOpt[] }) {
  const [delState, delAction] = useActionState(deleteSlaRuleAction, null);
  const [togState, togAction] = useActionState(toggleSlaRuleAction, null);
  const teamName = teams.find((t) => t.id === rule.team_id)?.name ?? (rule.team_id ? "—" : "ทุกทีม");
  return (
    <tr className={rule.is_active ? "" : "row-off"}>
      <td>{rule.name}</td>
      <td>{rule.work_type ?? "ทุกประเภท"}</td>
      <td>{rule.customer_type ?? "ทุกประเภท"}</td>
      <td>{rule.urgency ? URGENCY_LABEL[rule.urgency] ?? rule.urgency : "ทุกระดับ"}</td>
      <td>{teamName}</td>
      <td className="center">{rule.first_response_minutes ?? "—"}</td>
      <td className="center">{rule.resolution_minutes ?? "—"}</td>
      <td className="center">{rule.priority}</td>
      <td className="center">
        <div className="inline-form" style={{ justifyContent: "center" }}>
          <form action={togAction}>
            <input type="hidden" name="id" value={rule.id} />
            <input type="hidden" name="next" value={(!rule.is_active).toString()} />
            <button type="submit" className="btn">{rule.is_active ? "ปิด" : "เปิด"}</button>
          </form>
          <form action={delAction}>
            <input type="hidden" name="id" value={rule.id} />
            <button type="submit" className="btn danger">ลบ</button>
          </form>
        </div>
        <Msg state={delState ?? togState} />
      </td>
    </tr>
  );
}

function SlaPanel({ rules, teams }: { rules: SlaRuleRow[]; teams: TeamOpt[] }) {
  const [state, formAction] = useActionState(createSlaRuleAction, null);
  return (
    <div className="dash-views">
      <div className="card">
        <div className="section-title"><span>เงื่อนไข SLA (เวลาที่ต้องตอบ/ปิดเคส)</span></div>
        {rules.length === 0 ? (
          <p className="empty">ยังไม่มีเงื่อนไข SLA — เพิ่มด้านล่าง</p>
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>ชื่อเงื่อนไข</th>
                  <th>ประเภทงาน</th>
                  <th>ประเภทลูกค้า</th>
                  <th>ความเร่งด่วน</th>
                  <th>ทีม</th>
                  <th className="center">ตอบแรก(นาที)</th>
                  <th className="center">ปิดเคส(นาที)</th>
                  <th className="center">ลำดับ</th>
                  <th className="center">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <SlaRow key={r.id} rule={r} teams={teams} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="note-box" style={{ marginTop: 12 }}>
          <b>เวลาทำการ:</b> จันทร์–ศุกร์ 09:00–18:00 (นับ SLA เฉพาะในเวลาทำการ · นอกเวลาหยุดนับ)
        </div>
      </div>

      <div className="card">
        <div className="section-title"><span>+ เพิ่มเงื่อนไข SLA ใหม่</span></div>
        <form action={formAction} className="admin-form">
          <label>
            ชื่อเงื่อนไข *
            <input name="name" required placeholder="เช่น ขอเอกสาร/ภาษี (VIP)" />
          </label>
          <label>
            ประเภทงาน
            <input name="work_type" placeholder="ว่าง = ทุกประเภท" />
          </label>
          <label>
            ประเภทลูกค้า
            <input name="customer_type" placeholder="ว่าง = ทุกประเภท" />
          </label>
          <label>
            ความเร่งด่วน
            <select name="urgency" defaultValue="">
              <option value="">ทุกระดับ</option>
              <option value="critical">ด่วนมาก</option>
              <option value="high">เร่ง</option>
              <option value="medium">ปกติ</option>
              <option value="low">ต่ำ</option>
            </select>
          </label>
          <label>
            ทีม
            <select name="team_id" defaultValue="">
              <option value="">ทุกทีม</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <label>
            เวลาตอบครั้งแรก (นาที)
            <input name="first_response_minutes" type="number" min={0} placeholder="เช่น 60" />
          </label>
          <label>
            เวลาปิดเคส (นาที)
            <input name="resolution_minutes" type="number" min={0} placeholder="เช่น 480" />
          </label>
          <label>
            ลำดับความสำคัญ
            <input name="priority" type="number" min={0} defaultValue={100} />
          </label>
          <label className="admin-check">
            <input name="is_active" type="checkbox" defaultChecked /> เปิดใช้งานทันที
          </label>
          <div className="btn-row">
            <button type="submit" className="btn green">เพิ่มเงื่อนไข</button>
          </div>
          <Msg state={state} />
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Container + tabs
// ---------------------------------------------------------------------
export default function AdminConfig({
  groups,
  customers,
  teams,
  weights,
  slaRules,
  suggestionsByGroup,
}: {
  groups: ChatGroupRow[];
  customers: CustomerOpt[];
  teams: TeamOpt[];
  weights: Weights;
  slaRules: SlaRuleRow[];
  suggestionsByGroup: Record<string, CustomerSuggestionOpt[]>;
}) {
  const [tab, setTab] = useState<"mapping" | "weights" | "sla">("mapping");
  return (
    <div className="dash-views">
      <div className="ca-tabs">
        <button className={`ca-tab${tab === "mapping" ? " active" : ""}`} onClick={() => setTab("mapping")}>จับคู่กลุ่ม→ลูกค้า</button>
        <button className={`ca-tab${tab === "weights" ? " active" : ""}`} onClick={() => setTab("weights")}>น้ำหนักคะแนน 8 มิติ</button>
        <button className={`ca-tab${tab === "sla" ? " active" : ""}`} onClick={() => setTab("sla")}>SLA (เวลามาตรฐาน)</button>
      </div>

      {tab === "mapping" ? <MappingPanel groups={groups} customers={customers} suggestionsByGroup={suggestionsByGroup} /> : null}
      {tab === "weights" ? <WeightsPanel weights={weights} /> : null}
      {tab === "sla" ? <SlaPanel rules={slaRules} teams={teams} /> : null}
    </div>
  );
}
