/**
 * ส่วนประกอบ UI ของ dashboard (server components — render จากข้อมูลที่ query มาแล้ว)
 * ดีไซน์: พอร์ตจาก prototype/dashboard.html (การ์ด KPI, bar chart รายทีม, note-box navy)
 * โฟกัสตรรกะ (ไม่เปลี่ยน): แสดง Sample Size (n) ทุกคะแนน + ไม่สรุปดี/แย่เมื่อ n น้อย
 *                          + pseudonymity (คะแนน/ฟีดแบ็กไม่ผูกชื่อลูกค้า)
 */
import type {
  ExecDashboard,
  AccountantDashboard,
  LeadDashboard,
} from "@/lib/dashboard/types";
import type { ScoredItem, BestWorstResult } from "@/lib/dashboard/sample-size";
import { SAMPLE_SIZE_MIN, isSufficientSample } from "@/lib/dashboard/sample-size";
import {
  computeSlaStatus,
  formatSlaLabel,
  compareUrgency,
} from "@/lib/dashboard/sla";

// ---- primitives -------------------------------------------------------

/** การ์ด KPI ใหญ่ (สไตล์ prototype .kpi) + ป้าย Sample Size (n) — n น้อยจะเตือน */
function Kpi({
  label,
  value,
  unit,
  n,
  sample,
  tone,
}: {
  label: string;
  value: string | number | null;
  unit?: string;
  n?: number;
  sample?: string;
  tone?: "red" | "green" | "amber";
}) {
  const low = typeof n === "number" && !isSufficientSample(n);
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className={`value${tone ? ` v-${tone}` : ""}`}>
        {value ?? "—"}
        {unit && value !== null ? <span className="unit">{unit}</span> : null}
      </div>
      {sample ? <div className="sample">{sample}</div> : null}
      {typeof n === "number" ? (
        <div
          className={`sample${low ? " low" : ""}`}
          title={
            low ? `ตัวอย่างน้อยกว่า ${SAMPLE_SIZE_MIN} — ตีความอย่างระวัง` : undefined
          }
        >
          n = {n}
          {low ? " · ตัวอย่างน้อย" : ""}
        </div>
      ) : null}
    </div>
  );
}

/** การ์ดเนื้อหา (สไตล์ prototype .card + .section-title) */
function Card({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="section-title">
        <span>{title}</span>
        {right ?? null}
      </div>
      {children}
    </section>
  );
}

/**
 * แถบคะแนนต่อกลุ่ม (ทีม/รอบ/พนักงาน) — สไตล์ prototype .bar-row
 * ความยาวแถบ = score / max · n น้อยใช้แถบสีเหลือง + ⚠︎
 * ranking: สรุปดี/แย่สุดเฉพาะเมื่อ sample-size guard อนุญาต (canRank)
 */
function BarList({
  items,
  ranking,
  max = 5,
}: {
  items: ScoredItem[];
  ranking?: BestWorstResult;
  max?: number;
}) {
  if (items.length === 0) {
    return <p className="empty">ยังไม่มีข้อมูล</p>;
  }
  return (
    <div>
      {items.map((it) => {
        const low = !isSufficientSample(it.n);
        const pct =
          it.score !== null
            ? Math.max(0, Math.min(100, (it.score / max) * 100))
            : 0;
        return (
          <div className="bar-row" key={it.label}>
            <span className="name">{it.label}</span>
            <div className="bar-track">
              <div
                className={`bar-fill${low ? " low" : ""}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="bar-val">
              <b>{it.score ?? "—"}</b> · n={it.n}
              {low ? " ⚠︎" : ""}
            </span>
          </div>
        );
      })}
      {ranking ? (
        <div className={`note-box${ranking.canRank ? "" : " warn"}`}>
          {ranking.canRank ? (
            <>
              ดีสุด: <b>{ranking.best?.label}</b> ({ranking.best?.score}) · แย่สุด:{" "}
              <b>{ranking.worst?.label}</b> ({ranking.worst?.score})
            </>
          ) : (
            <>⚠︎ {ranking.reason}</>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** เลือก class badge ตามระดับความรุนแรงเคส */
function levelBadgeClass(level: string): string {
  const l = level.toLowerCase();
  if (l === "critical") return "badge-critical";
  if (l === "high") return "badge-high";
  return "badge-medium";
}

/** จำนวนเคสด่วนสูงสุดที่แสดงใน section (ที่เหลือสรุปไว้ที่แถบ escalation) */
const URGENT_DISPLAY_LIMIT = 20;

// ---- Executive --------------------------------------------------------
// `now` = เวลา ณ ตอน render (ms) ส่งจาก server component — ใช้คำนวณสถานะ SLA/escalation
export function ExecView({ d, now }: { d: ExecDashboard; now: number }) {
  const rr =
    d.responseRate.rate !== null
      ? `${Math.round(d.responseRate.rate * 100)}%`
      : null;
  // NPS แสดงเครื่องหมาย + เมื่อเป็นบวก (มาตรฐาน NPS)
  const npsValue =
    d.nps.nps === null ? null : d.nps.nps > 0 ? `+${d.nps.nps}` : `${d.nps.nps}`;

  // ★ สรุป escalation นับจาก "ชุดเต็ม" ที่ query คำนวณไว้ (ก่อน cap list)
  //   → ตัวเลขแถบนี้ตรงกับการ์ด KPI "สรุปสถานะเคส" (d.cases.urgent) เสมอ
  const esc = d.escalation;
  const critCount = esc.critical;
  const highCount = esc.high;

  // เรียงเคสด่วนตาม urgency (เกิน SLA ก่อน → critical ก่อน high → sla ใกล้สุด)
  // แล้วตัดจำนวนที่แสดงในการ์ด — จำนวนที่ซ่อนอ้างจาก urgentTotal (ชุดเต็ม)
  const sortedUrgent = [...d.urgentCases].sort((a, b) =>
    compareUrgency(a, b, now)
  );
  const visibleUrgent = sortedUrgent.slice(0, URGENT_DISPLAY_LIMIT);
  const hiddenUrgent = d.urgentTotal - visibleUrgent.length;

  return (
    <div className="dash-views">
      {/* แถบ escalation เด่นบนสุด — แสดงเฉพาะเมื่อมีเคสด่วนค้าง (ไม่มี = ไม่แสดง ไม่รก) */}
      {esc.total > 0 ? (
        <div
          className={`escalation-bar${esc.overdue > 0 ? " has-overdue" : ""}`}
          role="alert"
        >
          <span className="esc-icon" aria-hidden="true">
            ⚠️
          </span>
          <div className="esc-body">
            <div className="esc-headline">
              มีเคสด่วน {esc.total} รายการต้องดูแล
            </div>
            <div className="esc-detail">
              <span className="badge badge-critical">
                Critical {esc.critical}
              </span>
              <span className="badge badge-high">High {esc.high}</span>
              {esc.overdue > 0 ? (
                <span className="badge badge-overdue">
                  เกิน SLA {esc.overdue}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* KPI: CSAT / NPS / Response Rate / ลูกค้าเสี่ยงยกเลิก — แสดง n เสมอ */}
      <div className="kpi-grid">
        <Kpi label="CSAT (ความพึงพอใจ)" value={d.csat.avg} unit="/5" n={d.csat.n} />
        <Kpi label="NPS" value={npsValue} n={d.nps.n} />
        <Kpi
          label="Response Rate"
          value={rr}
          sample={`ส่ง ${d.responseRate.invited} · ตอบ ${d.responseRate.responded}`}
        />
        <Kpi
          label="ลูกค้าเสี่ยงยกเลิก"
          value={d.cases.retentionRisk}
          sample="ราย (ต้องติดตามด่วน)"
          tone="red"
        />
      </div>

      <div className="grid-2">
        <Card
          title="เคสเร่งด่วนที่ต้องดูแล"
          right={
            <span>
              <span className="badge badge-critical">Critical {critCount}</span>{" "}
              <span className="badge badge-high">High {highCount}</span>
            </span>
          }
        >
          {visibleUrgent.length === 0 ? (
            <p className="empty">ไม่มีเคสเร่งด่วนค้าง</p>
          ) : (
            <>
              {visibleUrgent.map((c) => {
                const sla = computeSlaStatus(c.sla_due_at, now);
                return (
                  <div className="case-row" key={c.case_id}>
                    <span className="cid">{c.case_no}</span>
                    <span className="cdesc">
                      {c.type}
                      <br />
                      <span className="cmeta">
                        ลูกค้า: {c.customer_code ?? "—"} · สถานะ: {c.status}
                      </span>
                    </span>
                    <span className="case-badges">
                      <span className={`badge ${levelBadgeClass(c.level)}`}>
                        {c.level}
                      </span>
                      <span className={`sla-badge sla-${sla.state}`}>
                        {formatSlaLabel(sla)}
                      </span>
                    </span>
                  </div>
                );
              })}
              {hiddenUrgent > 0 ? (
                <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                  และอีก {hiddenUrgent} เคส (แสดง {URGENT_DISPLAY_LIMIT} เคสแรกตามความเร่งด่วน)
                </p>
              ) : null}
            </>
          )}
          <div className="note-box">
            <b>AI น้อง NOVA:</b> เคส Critical/High ต้องให้มนุษย์ตรวจก่อนตอบลูกค้าเสมอ
            — AI แยก &ldquo;ข้อเท็จจริงจากลูกค้า&rdquo; ออกจาก &ldquo;ข้อสันนิษฐาน&rdquo;
            และแสดงหลักฐานประกอบ
          </div>
        </Card>

        <Card title="คะแนน CSAT รายทีม">
          <BarList items={d.teamCsat} ranking={d.teamRanking} />
        </Card>
      </div>

      <div className="grid-2b">
        <Card title="สรุปสถานะเคส">
          <div className="prob-row">
            <span>เคสที่เปิดอยู่ทั้งหมด</span>
            <span className="cnt">{d.cases.open}</span>
          </div>
          <div className="prob-row">
            <span>🔴 เร่งด่วน (Critical/High) ที่ยังไม่ปิด</span>
            <span className="cnt">{d.cases.urgent}</span>
          </div>
          <div className="prob-row">
            <span>⚠ ลูกค้าเสี่ยงยกเลิก (Retention)</span>
            <span className="cnt">{d.cases.retentionRisk}</span>
          </div>
          <div className="prob-row">
            <span>เวลาปิดเคสเฉลี่ย</span>
            <span className="cnt">
              {d.cases.avgResolutionHours !== null
                ? `${d.cases.avgResolutionHours} ชม.`
                : "—"}
            </span>
          </div>
        </Card>

        <Card title="สถานะเคสแยกระดับ">
          {Object.keys(d.cases.byLevel).length === 0 ? (
            <p className="empty">ยังไม่มีข้อมูล</p>
          ) : (
            Object.entries(d.cases.byLevel).map(([level, count]) => (
              <div className="prob-row" key={level}>
                <span>{level}</span>
                <span className="cnt">{count}</span>
              </div>
            ))
          )}
        </Card>
      </div>
    </div>
  );
}

// ---- Accountant / Sales (member) -------------------------------------
export function MemberView({ d }: { d: AccountantDashboard }) {
  const rr =
    d.tracking.responseRate.rate !== null
      ? `${Math.round(d.tracking.responseRate.rate * 100)}%`
      : null;
  return (
    <div className="dash-views">
      {/* แจ้ง pseudonymity: เห็นคะแนน/ฟีดแบ็กของตัวเอง แต่ไม่ผูกกับชื่อลูกค้า */}
      <div className="note-box lock">
        🔒 มุมมอง <b>ของฉัน</b>: เห็นเฉพาะคะแนน/คำชม/จุดปรับปรุงของตนเอง —
        <b> คะแนนและความเห็นไม่ผูกกับชื่อลูกค้า</b> (บังคับที่ชั้น view/RLS ไม่ใช่แค่ซ่อนหน้าจอ)
      </div>

      <div className="kpi-grid">
        <Kpi
          label="คะแนนของฉัน (เฉลี่ย)"
          value={d.ownScore.avg}
          unit="/5"
          n={d.ownScore.n}
        />
        <Kpi
          label="คำชมที่ได้รับ"
          value={d.praises.length}
          sample="ความเห็นเชิงบวก"
          tone="green"
        />
        <Kpi
          label="จุดที่ควรปรับปรุง"
          value={d.improvements.length}
          sample="หัวข้อที่ควรพัฒนา"
          tone="amber"
        />
        <Kpi
          label="ยังไม่ประเมิน"
          value={d.tracking.notResponded}
          sample="รอติดตาม / โทรตาม"
          tone="amber"
        />
      </div>

      <div className="grid-2">
        <Card title="แนวโน้มคะแนนรายรอบ (ของฉัน)">
          <BarList items={d.trendByCycle} />
        </Card>

        <Card title="คำชม & จุดที่ควรปรับปรุง">
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 12 }}>
            ความเห็นแสดง<b>โดยไม่ระบุชื่อลูกค้า</b>
          </p>
          {d.praises.length === 0 && d.improvements.length === 0 ? (
            <p className="empty">ยังไม่มีความเห็น</p>
          ) : (
            <>
              {d.praises.map((p) => (
                <div className="fb pos" key={p.evaluation_id}>
                  <span className="fb-tag">👍 คำชม</span>
                  <p>{p.summary ?? "(ไม่มีสรุป)"}</p>
                </div>
              ))}
              {d.improvements.map((p) => (
                <div className="fb neg" key={p.evaluation_id}>
                  <span className="fb-tag">⚠ ควรปรับปรุง</span>
                  <p>{p.summary ?? "(ไม่มีสรุป)"}</p>
                </div>
              ))}
            </>
          )}
        </Card>
      </div>

      {/* สถานะการประเมินของลูกค้าที่ฉันดูแล (call-list ล้วน — ไม่มีคะแนน) */}
      <div>
        <div className="section-head">
          <h2>📨 สถานะการประเมินของลูกค้าที่ฉันดูแล</h2>
          <p>
            เฉพาะลูกค้าที่คุณดูแล — เห็นแค่สถานะว่าประเมินแล้ว/ยังไม่ประเมิน
            (ไม่เชื่อมกับคะแนนใด ๆ)
          </p>
        </div>

        <div className="kpi-grid cols-3">
          <Kpi
            label="ประเมินแล้ว"
            value={d.tracking.responded}
            sample="รายที่ตอบแล้ว"
            tone="green"
          />
          <Kpi
            label="ยังไม่ประเมิน"
            value={d.tracking.notResponded}
            sample="รอติดตาม / โทรตาม"
            tone="amber"
          />
          <Kpi
            label="อัตราการประเมิน"
            value={rr}
            sample={`${d.tracking.responded} / ${d.tracking.total} ราย`}
          />
        </div>

        <Card title="รอติดตาม / โทรตาม (เฉพาะลูกค้าที่ยังไม่ประเมิน)">
          {d.callList.length === 0 ? (
            <p className="empty">ตอบครบแล้ว 🎉</p>
          ) : (
            <div className="table-wrap">
              <table className="dlv-table">
                <thead>
                  <tr>
                    <th>ลูกค้า</th>
                    <th>รอบ</th>
                    <th>สถานะ</th>
                    <th className="center">เตือนแล้ว</th>
                    <th className="center">เบอร์</th>
                  </tr>
                </thead>
                <tbody>
                  {d.callList.map((c) => (
                    <tr key={c.invitation_id}>
                      <td>
                        <b>{c.customer_name}</b>
                      </td>
                      <td>{c.cycle_period}</td>
                      <td>{c.invitation_status}</td>
                      <td className="center">{c.reminder_count}</td>
                      <td className="center">{c.has_phone ? "✓" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="note-box">
            👀 เห็นแค่<b>สถานะ (ประเมิน/ยังไม่ประเมิน)</b>ของลูกค้าที่คุณดูแล —
            <b> ไม่เห็นเนื้อหาคำตอบ</b> และรายการนี้ไม่ผูกกับคะแนนใด ๆ
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---- Lead (internal review) ------------------------------------------
export function LeadView({ d }: { d: LeadDashboard }) {
  const rr =
    d.tracking.responseRate.rate !== null
      ? `${Math.round(d.tracking.responseRate.rate * 100)}%`
      : null;
  return (
    <div className="dash-views">
      <div className="note-box lock">
        🧑‍💼 มุมมอง <b>หัวหน้าทีม</b> — ส่วน <b>&ldquo;ประเมินภายใน (Internal Review)&rdquo;</b>
        เป็นการประเมินภายในเพื่อพัฒนา/บริหารทีม <b>ไม่เกี่ยวกับลูกค้า</b> และผลอยู่ใน dashboard เท่านั้น
      </div>

      <div className="kpi-grid cols-3">
        <Kpi
          label="คะแนนทีม (เฉลี่ย)"
          value={d.teamScore.avg}
          unit="/5"
          n={d.teamScore.n}
        />
        <Kpi
          label="อัตราการประเมินทีม"
          value={rr}
          sample={`${d.tracking.responded} / ${d.tracking.total} ราย`}
        />
        <Kpi
          label="ยังไม่ประเมิน"
          value={d.tracking.notResponded}
          sample="รอติดตาม"
          tone="amber"
        />
      </div>

      <Card title="ประเมินนักบัญชี (Internal Review) — คะแนนรายคน">
        <p className="muted" style={{ margin: "0 0 12px", fontSize: 12 }}>
          การประเมินภายใน ไม่เกี่ยวกับชื่อลูกค้า · คะแนนตัวอย่างน้อยไม่ใช้ตัดสินผลงาน
        </p>
        <BarList items={d.memberScores} ranking={d.memberRanking} />
      </Card>
    </div>
  );
}
