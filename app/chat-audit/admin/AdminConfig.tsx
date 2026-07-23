"use client";

import { useRef, useState } from "react";
import { useActionState } from "react";
import Link from "next/link";
import { EVAL_DIMENSIONS } from "@/lib/chat-dashboard/evaluation-detail";
import { DIMENSIONS, type Weights } from "@/lib/evaluation/weights";
import {
  mapGroupAction,
  setGroupAccountantAction,
  deleteChatGroupAction,
  saveWeightsAction,
  createSlaRuleAction,
  deleteSlaRuleAction,
  toggleSlaRuleAction,
  backfillGroupNamesAction,
  type ActionResult,
} from "@/lib/chat-admin/actions";
import type { ChatGroupRow } from "@/lib/chat-admin/mapping";
import type { SlaRuleRow } from "@/lib/chat-admin/sla";
import { filterChatGroups } from "@/lib/chat-admin/group-filter";

type CustomerOpt = { id: string; name: string; code: string | null };
type EmployeeOpt = { id: string; name: string };
type TeamOpt = { id: string; name: string };
type CustomerSuggestionOpt = { customerId: string; customerName: string };
type AccountantSuggestionOpt = { employeeId: string; employeeName: string };

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
  accountants,
  suggestions,
  accountantSuggestion,
}: {
  group: ChatGroupRow;
  customers: CustomerOpt[];
  accountants: EmployeeOpt[];
  suggestions: CustomerSuggestionOpt[];
  accountantSuggestion: AccountantSuggestionOpt | null;
}) {
  const [state, formAction] = useActionState(mapGroupAction, null);
  const [delState, delAction] = useActionState(deleteChatGroupAction, null);
  const [accState, accAction] = useActionState(setGroupAccountantAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const delFormRef = useRef<HTMLFormElement>(null);
  const [customerId, setCustomerId] = useState(group.customerId ?? "");
  // ค่าเริ่มต้น dropdown นักบัญชี: ผูกแล้ว→คนนั้น, ยังไม่ผูก→คนที่ระบบเดา (ยังไม่บันทึกจนกดปุ่ม)
  const [employeeId, setEmployeeId] = useState(
    group.responsibleEmployeeId ?? accountantSuggestion?.employeeId ?? ""
  );

  // กดปุ่มแนะนำ → ตั้งค่าลูกค้าแล้ว submit ฟอร์มเดิม (ผ่าน mapGroupAction + audit)
  function pickSuggestion(id: string) {
    setCustomerId(id);
    // ให้ state อัปเดต value ก่อนแล้วค่อย submit
    requestAnimationFrame(() => formRef.current?.requestSubmit());
  }

  // กดลบ → confirm ก่อนเสมอ (soft-delete กลุ่ม + ข้อมูลแชตในกลุ่ม) สำหรับกลุ่มทดสอบ
  function confirmDelete() {
    const label = group.groupName ? `"${group.groupName}"` : "กลุ่มนี้";
    if (window.confirm(`ลบ${label} และข้อมูลแชตในกลุ่ม? ใช้สำหรับกลุ่มทดสอบ`)) {
      delFormRef.current?.requestSubmit();
    }
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
      <td>
        {/* ตัวช่วย 3: นักบัญชีผู้ดูแล — preselect คนที่ระบบเดา (badge "เดา:") ยังไม่บันทึกจนกดปุ่ม */}
        {!group.responsibleEmployeeId && accountantSuggestion ? (
          <div className="suggest-chips">
            <span className="muted" style={{ fontSize: 11 }}>เดา: {accountantSuggestion.employeeName}</span>
          </div>
        ) : null}
        <form action={accAction} className="inline-form">
          <input type="hidden" name="chat_group_id" value={group.id} />
          <select name="employee_id" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">— ยังไม่ผูก —</option>
            {accountants.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button type="submit" className="btn">บันทึกนักบัญชี</button>
        </form>
        <div style={{ marginTop: 4 }}>
          {group.responsibleEmployeeId ? (
            <span className="badge b-green">✓ ผูกแล้ว ({group.responsibleName ?? "—"})</span>
          ) : (
            <span className="badge b-orange">รอผูกนักบัญชี</span>
          )}
        </div>
        <Msg state={accState} />
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
        <div className="inline-form" style={{ justifyContent: "center" }}>
          <Link href={`/chat-audit/admin/groups/${group.id}`} className="btn">จัดการสมาชิก</Link>
          {/* ปุ่มลบ (เคลียร์กลุ่มทดสอบ) — confirm ก่อนเสมอ, submit ผ่าน delFormRef */}
          <form action={delAction} ref={delFormRef}>
            <input type="hidden" name="chat_group_id" value={group.id} />
            <button type="button" className="btn danger" onClick={confirmDelete} title="ลบกลุ่มทดสอบและข้อมูลแชตในกลุ่ม">
              ลบ
            </button>
          </form>
        </div>
        <Msg state={delState} />
      </td>
    </tr>
  );
}

function MappingPanel({
  groups,
  customers,
  accountants,
  suggestionsByGroup,
  accountantSuggestionByGroup,
}: {
  groups: ChatGroupRow[];
  customers: CustomerOpt[];
  accountants: EmployeeOpt[];
  suggestionsByGroup: Record<string, CustomerSuggestionOpt[]>;
  accountantSuggestionByGroup: Record<string, AccountantSuggestionOpt>;
}) {
  const mapped = groups.filter((g) => g.customerId).length;
  const noName = groups.filter((g) => !g.groupName).length;
  const [backfillState, backfillAction] = useActionState(backfillGroupNamesAction, null);
  // ค้นหากลุ่มแบบ client-side (กรองตามชื่อกลุ่ม + ชื่อลูกค้า + ชื่อนักบัญชี) — ไม่แตะ server
  const [query, setQuery] = useState("");
  // ตัวกรองสถานะการผูก (client-side) — ยังไม่ผูกลูกค้า / ยังไม่ผูกนักบัญชี / ทั้งหมด
  const [bindFilter, setBindFilter] = useState<"all" | "no-customer" | "no-accountant">("all");
  // นับจาก groups ทั้งหมด (ไม่ใช่ที่กรองแล้ว) เพื่อโชว์ badge บนปุ่ม
  const noCustomer = groups.filter((g) => !g.customerId).length;
  const noAccountant = groups.filter((g) => !g.responsibleEmployeeId).length;
  const filtered = filterChatGroups(groups, query).filter((g) =>
    bindFilter === "no-customer"
      ? !g.customerId
      : bindFilter === "no-accountant"
        ? !g.responsibleEmployeeId
        : true
  );
  const trimmedQuery = query.trim();
  // โชว์ตัวนับผลลัพธ์เมื่อมีการค้นหา หรือมีตัวกรองสถานะการผูก
  const hasActiveFilter = Boolean(trimmedQuery) || bindFilter !== "all";
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
      {/* backfill: ดึงชื่อกลุ่มที่ยังไม่มีชื่อ (ช่วยกลุ่มเก่าที่เชิญบอทก่อนมีฟีเจอร์ดึงชื่ออัตโนมัติ) */}
      <div className="btn-row" style={{ marginBottom: 12, alignItems: "center", gap: 8 }}>
        <form action={backfillAction}>
          <button type="submit" className="btn">ดึงชื่อกลุ่มที่ยังไม่มีชื่อ{noName > 0 ? ` (${noName})` : ""}</button>
        </form>
        <Msg state={backfillState} />
      </div>
      {groups.length === 0 ? (
        <p className="empty">ยังไม่มีกลุ่ม LINE (รอบอทเข้ากลุ่มและเก็บข้อความ)</p>
      ) : (
        <>
          {/* แถวปุ่มกรองสถานะการผูก (client-side) — กรองเฉพาะกลุ่มที่ยังต้องจัดการ */}
          <div className="bind-filter" role="group" aria-label="กรองสถานะการผูก">
            <button
              type="button"
              className={`bind-filter-btn${bindFilter === "all" ? " is-active" : ""}`}
              aria-pressed={bindFilter === "all"}
              onClick={() => setBindFilter("all")}
            >
              ทั้งหมด
            </button>
            <button
              type="button"
              className={`bind-filter-btn${bindFilter === "no-customer" ? " is-active" : ""}`}
              aria-pressed={bindFilter === "no-customer"}
              onClick={() => setBindFilter("no-customer")}
            >
              ยังไม่ผูกลูกค้า ({noCustomer})
            </button>
            <button
              type="button"
              className={`bind-filter-btn${bindFilter === "no-accountant" ? " is-active" : ""}`}
              aria-pressed={bindFilter === "no-accountant"}
              onClick={() => setBindFilter("no-accountant")}
            >
              ยังไม่ผูกนักบัญชี ({noAccountant})
            </button>
          </div>
          {/* ช่องค้นหากลุ่ม (client-side) — พิมพ์แล้วกรองทันทีตามชื่อกลุ่ม/ลูกค้า/นักบัญชี */}
          <div className="group-search">
            <input
              type="search"
              className="group-search-input"
              placeholder="ค้นหาชื่อกลุ่ม…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="ค้นหากลุ่ม LINE"
            />
            {trimmedQuery ? (
              <button
                type="button"
                className="group-search-clear"
                onClick={() => setQuery("")}
                title="ล้างคำค้นหา"
                aria-label="ล้างคำค้นหา"
              >
                ×
              </button>
            ) : null}
            {hasActiveFilter ? (
              <span className="muted group-search-count">
                พบ {filtered.length} จาก {groups.length} กลุ่ม
              </span>
            ) : null}
          </div>
          {filtered.length === 0 ? (
            trimmedQuery ? (
              <p className="empty">ไม่พบกลุ่มที่ตรงกับ &quot;{trimmedQuery}&quot;</p>
            ) : bindFilter === "no-customer" ? (
              <p className="empty">ไม่มีกลุ่มที่ยังไม่ผูกลูกค้า — จับคู่ครบทุกกลุ่มแล้ว</p>
            ) : bindFilter === "no-accountant" ? (
              <p className="empty">ไม่มีกลุ่มที่ยังไม่ผูกนักบัญชี — ผูกครบทุกกลุ่มแล้ว</p>
            ) : (
              <p className="empty">ไม่พบกลุ่ม</p>
            )
          ) : (
            <div className="table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>กลุ่ม LINE</th>
                    <th>ลูกค้าที่จับคู่</th>
                    <th>นักบัญชีผู้ดูแล</th>
                    <th className="center">สมาชิก</th>
                    <th className="center">สถานะ</th>
                    <th className="center"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((g) => (
                    <GroupRow
                      key={g.id}
                      group={g}
                      customers={customers}
                      accountants={accountants}
                      suggestions={suggestionsByGroup[g.id] ?? []}
                      accountantSuggestion={accountantSuggestionByGroup[g.id] ?? null}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
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
  accountants,
  teams,
  weights,
  slaRules,
  suggestionsByGroup,
  accountantSuggestionByGroup,
}: {
  groups: ChatGroupRow[];
  customers: CustomerOpt[];
  accountants: EmployeeOpt[];
  teams: TeamOpt[];
  weights: Weights;
  slaRules: SlaRuleRow[];
  suggestionsByGroup: Record<string, CustomerSuggestionOpt[]>;
  accountantSuggestionByGroup: Record<string, AccountantSuggestionOpt>;
}) {
  const [tab, setTab] = useState<"mapping" | "weights" | "sla">("mapping");
  return (
    <div className="dash-views">
      <div className="ca-tabs">
        <button className={`ca-tab${tab === "mapping" ? " active" : ""}`} onClick={() => setTab("mapping")}>จับคู่กลุ่ม→ลูกค้า</button>
        <button className={`ca-tab${tab === "weights" ? " active" : ""}`} onClick={() => setTab("weights")}>น้ำหนักคะแนน 8 มิติ</button>
        <button className={`ca-tab${tab === "sla" ? " active" : ""}`} onClick={() => setTab("sla")}>SLA (เวลามาตรฐาน)</button>
      </div>

      {tab === "mapping" ? (
        <MappingPanel
          groups={groups}
          customers={customers}
          accountants={accountants}
          suggestionsByGroup={suggestionsByGroup}
          accountantSuggestionByGroup={accountantSuggestionByGroup}
        />
      ) : null}
      {tab === "weights" ? <WeightsPanel weights={weights} /> : null}
      {tab === "sla" ? <SlaPanel rules={slaRules} teams={teams} /> : null}
    </div>
  );
}
