/**
 * ส่วนประกอบ UI ของ dashboard (server components — render จากข้อมูลที่ query มาแล้ว)
 * โฟกัส: อ่านง่าย + แสดง Sample Size (n) ทุกคะแนน + ไม่สรุปดี/แย่เมื่อ n น้อย
 */
import type {
  ExecDashboard,
  AccountantDashboard,
  LeadDashboard,
} from "@/lib/dashboard/types";
import type { ScoredItem, BestWorstResult } from "@/lib/dashboard/sample-size";
import { SAMPLE_SIZE_MIN, isSufficientSample } from "@/lib/dashboard/sample-size";

// ---- primitives -------------------------------------------------------
export function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand/60">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** คะแนนใหญ่ + ป้าย Sample Size (n) — n น้อยจะเตือน */
export function Metric({
  label,
  value,
  unit,
  n,
}: {
  label: string;
  value: string | number | null;
  unit?: string;
  n?: number;
}) {
  const low = typeof n === "number" && !isSufficientSample(n);
  return (
    <div className="rounded-xl bg-brand/5 p-4">
      <div className="text-xs text-brand/50">{label}</div>
      <div className="mt-1 text-2xl font-bold text-brand">
        {value ?? "—"}
        {unit && value !== null ? (
          <span className="ml-1 text-base font-medium text-brand/60">{unit}</span>
        ) : null}
      </div>
      {typeof n === "number" ? (
        <div
          className={`mt-1 text-xs ${low ? "text-amber-600" : "text-brand/40"}`}
          title={low ? `ตัวอย่างน้อยกว่า ${SAMPLE_SIZE_MIN} — ตีความอย่างระวัง` : undefined}
        >
          n = {n}
          {low ? " · ตัวอย่างน้อย" : ""}
        </div>
      ) : null}
    </div>
  );
}

/** ตารางคะแนนต่อกลุ่ม (ทีม/พนักงาน/รอบ) + n; สรุปดี/แย่เฉพาะเมื่อ n พอ */
export function ScoreTable({
  items,
  ranking,
  labelHead,
}: {
  items: ScoredItem[];
  ranking?: BestWorstResult;
  labelHead: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-brand/40">ยังไม่มีข้อมูล</p>;
  }
  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-brand/50">
            <th className="pb-2 font-medium">{labelHead}</th>
            <th className="pb-2 text-right font-medium">คะแนน</th>
            <th className="pb-2 text-right font-medium">n</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const low = !isSufficientSample(it.n);
            return (
              <tr key={it.label} className="border-t border-black/5">
                <td className="py-2 text-brand/80">{it.label}</td>
                <td className="py-2 text-right font-medium text-brand">
                  {it.score ?? "—"}
                </td>
                <td
                  className={`py-2 text-right ${low ? "text-amber-600" : "text-brand/50"}`}
                >
                  {it.n}
                  {low ? " ⚠︎" : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {ranking ? (
        <p className="mt-3 text-xs text-brand/50">
          {ranking.canRank ? (
            <>
              ดีสุด: <b>{ranking.best?.label}</b> ({ranking.best?.score}) · แย่สุด:{" "}
              <b>{ranking.worst?.label}</b> ({ranking.worst?.score})
            </>
          ) : (
            <span className="text-amber-600">⚠︎ {ranking.reason}</span>
          )}
        </p>
      ) : null}
    </div>
  );
}

// ---- Executive --------------------------------------------------------
export function ExecView({ d }: { d: ExecDashboard }) {
  const rr =
    d.responseRate.rate !== null
      ? `${Math.round(d.responseRate.rate * 100)}%`
      : null;
  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="CSAT (ความพึงพอใจ)" value={d.csat.avg} n={d.csat.n} />
        <Metric label="NPS" value={d.nps.nps} n={d.nps.n} />
        <Metric
          label="Response Rate"
          value={rr}
          n={d.responseRate.invited}
        />
        <Metric label="เคสเปิดอยู่" value={d.cases.open} />
      </div>

      <Card title="คะแนน CSAT รายทีม">
        <ScoreTable items={d.teamCsat} ranking={d.teamRanking} labelHead="ทีม" />
      </Card>

      <div className="grid gap-5 sm:grid-cols-2">
        <Card title="สรุปสถานะเคส">
          <ul className="space-y-1 text-sm text-brand/80">
            <li>เคสเร่งด่วนที่ยังไม่ปิด: <b>{d.cases.urgent}</b></li>
            <li>ลูกค้าเสี่ยงยกเลิก (retention): <b>{d.cases.retentionRisk}</b></li>
            <li>
              เวลาปิดเคสเฉลี่ย:{" "}
              <b>
                {d.cases.avgResolutionHours !== null
                  ? `${d.cases.avgResolutionHours} ชม.`
                  : "—"}
              </b>
            </li>
          </ul>
        </Card>

        <Card title="เคสเร่งด่วนที่ต้องดูแล">
          {d.urgentCases.length === 0 ? (
            <p className="text-sm text-brand/40">ไม่มีเคสเร่งด่วนค้าง</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.urgentCases.map((c) => (
                <li key={c.case_id} className="flex justify-between">
                  <span className="text-brand/80">
                    {c.case_no}
                    <span className="ml-2 text-brand/40">
                      {c.customer_code ?? "—"}
                    </span>
                  </span>
                  <span className="font-medium text-red-600">{c.level}</span>
                </li>
              ))}
            </ul>
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
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Metric label="คะแนนของฉัน (เฉลี่ย)" value={d.ownScore.avg} n={d.ownScore.n} />
        <Metric label="อัตราการประเมิน" value={rr} n={d.tracking.total} />
        <Metric label="ยังไม่ประเมิน" value={d.tracking.notResponded} />
      </div>

      <Card title="แนวโน้มคะแนนรายรอบ">
        <ScoreTable items={d.trendByCycle} labelHead="รอบ" />
      </Card>

      <div className="grid gap-5 sm:grid-cols-2">
        <Card title="คำชม (จากความเห็นลูกค้า)">
          {d.praises.length === 0 ? (
            <p className="text-sm text-brand/40">ยังไม่มี</p>
          ) : (
            <ul className="space-y-2 text-sm text-brand/80">
              {d.praises.map((p) => (
                <li key={p.evaluation_id} className="rounded-lg bg-emerald-50 p-2">
                  {p.summary ?? "(ไม่มีสรุป)"}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="จุดที่ควรปรับปรุง">
          {d.improvements.length === 0 ? (
            <p className="text-sm text-brand/40">ยังไม่มี</p>
          ) : (
            <ul className="space-y-2 text-sm text-brand/80">
              {d.improvements.map((p) => (
                <li key={p.evaluation_id} className="rounded-lg bg-amber-50 p-2">
                  {p.summary ?? "(ไม่มีสรุป)"}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="รอติดตาม / โทรตาม (เฉพาะลูกค้าที่ยังไม่ประเมิน)">
        <p className="mb-2 text-xs text-brand/40">
          หมายเหตุ: รายการนี้เป็นลูกค้าที่ฉันดูแลและยังไม่ตอบแบบประเมิน —
          ไม่เชื่อมกับคะแนนใด ๆ (คะแนนไม่ผูกกับชื่อ)
        </p>
        {d.callList.length === 0 ? (
          <p className="text-sm text-brand/40">ตอบครบแล้ว 🎉</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-brand/50">
                <th className="pb-2 font-medium">ลูกค้า</th>
                <th className="pb-2 font-medium">รอบ</th>
                <th className="pb-2 font-medium">สถานะ</th>
                <th className="pb-2 text-center font-medium">เตือนแล้ว</th>
                <th className="pb-2 text-center font-medium">เบอร์</th>
              </tr>
            </thead>
            <tbody>
              {d.callList.map((c) => (
                <tr key={c.invitation_id} className="border-t border-black/5">
                  <td className="py-2 text-brand/80">{c.customer_name}</td>
                  <td className="py-2 text-brand/60">{c.cycle_period}</td>
                  <td className="py-2 text-brand/60">{c.invitation_status}</td>
                  <td className="py-2 text-center text-brand/60">
                    {c.reminder_count}
                  </td>
                  <td className="py-2 text-center">
                    {c.has_phone ? "✓" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
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
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Metric label="คะแนนทีม (เฉลี่ย)" value={d.teamScore.avg} n={d.teamScore.n} />
        <Metric label="อัตราการประเมินทีม" value={rr} n={d.tracking.total} />
        <Metric label="ยังไม่ประเมิน" value={d.tracking.notResponded} />
      </div>

      <Card title="ประเมินนักบัญชี (Internal Review) — คะแนนรายคน">
        <p className="mb-2 text-xs text-brand/40">
          การประเมินภายใน ไม่เกี่ยวกับชื่อลูกค้า · คะแนนตัวอย่างน้อยไม่ใช้ตัดสินผลงาน
        </p>
        <ScoreTable
          items={d.memberScores}
          ranking={d.memberRanking}
          labelHead="พนักงาน"
        />
      </Card>
    </div>
  );
}
