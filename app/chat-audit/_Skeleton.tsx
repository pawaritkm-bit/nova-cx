import "../dashboard/dashboard.css";
import "./chat-audit.css";

/**
 * โครงหน้า (skeleton) ระหว่างรอ query ของหน้าตรวจแชต
 *   - ใช้ธีมเดิม (.nova-dash + .card/.kpi) → กดเมนูปุ๊บเห็นโครงทันที ไม่ค้างขาว
 *   - loading.tsx ของ Next จะ replace ทั้ง page (รวม AppNav) → วางแถบเมนูจำลอง (skel-nav) ไว้ด้วย
 *   - เป็น presentation ล้วน ไม่แตะ data/สิทธิ์ (หน้าจริงบังคับสิทธิ์เมื่อ query เสร็จ)
 */

/** การ์ดหัวข้อ + หลายบรรทัด (ใช้ซ้ำในทุก variant) */
function CardSkeleton({ lines = 4 }: { lines?: number }) {
  const widths = ["w-100", "w-80", "w-60", "w-100", "w-80", "w-60"];
  return (
    <section className="card" aria-hidden>
      <div className="skel skel-title" />
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className={`skel skel-line ${widths[i % widths.length]}`} />
      ))}
    </section>
  );
}

function KpiSkeleton() {
  return (
    <div className="kpi" aria-hidden>
      <div className="skel skel-line w-60" />
      <div className="skel skel-value" />
      <div className="skel skel-line w-40" />
    </div>
  );
}

function KpiGrid({ n = 4 }: { n?: number }) {
  return (
    <div className="kpi-grid">
      {Array.from({ length: n }).map((_, i) => (
        <KpiSkeleton key={i} />
      ))}
    </div>
  );
}

export type SkeletonVariant = "dashboard" | "list" | "detail" | "report" | "case";

/**
 * โครงหน้าตามชนิดหน้า
 *   - dashboard : KPI 2 แถว + การ์ด 2 ใบ (exec/team/me/risk)
 *   - list      : การ์ดรายการยาว (admin/members/reports)
 *   - detail    : การ์ดข้อมูล 2 คอลัมน์ (admin group detail)
 *   - report    : KPI 1 แถว + ตารางคะแนน
 *   - case      : ไทม์ไลน์แชต + การ์ดวิเคราะห์ (case/eval)
 */
export default function ChatAuditSkeleton({ variant }: { variant: SkeletonVariant }) {
  return (
    <main className="nova-dash" aria-busy="true" aria-label="กำลังโหลด">
      <header>
        <div className="skel skel-nav" aria-hidden />
      </header>

      {variant === "dashboard" && (
        <div className="dash-views">
          <KpiGrid n={4} />
          <KpiGrid n={4} />
          <div className="grid-2">
            <CardSkeleton lines={5} />
            <CardSkeleton lines={4} />
          </div>
        </div>
      )}

      {variant === "list" && (
        <div className="dash-views">
          <KpiGrid n={3} />
          <section className="card" aria-hidden>
            <div className="skel skel-title" />
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skel skel-row" />
            ))}
          </section>
        </div>
      )}

      {variant === "detail" && (
        <div className="dash-views">
          <div className="grid-2b">
            <CardSkeleton lines={6} />
            <CardSkeleton lines={6} />
          </div>
        </div>
      )}

      {variant === "report" && (
        <div className="dash-views">
          <KpiGrid n={4} />
          <section className="card" aria-hidden>
            <div className="skel skel-title" />
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skel skel-row" />
            ))}
          </section>
        </div>
      )}

      {variant === "case" && (
        <div className="dash-views">
          <div className="grid-2">
            <section className="card" aria-hidden>
              <div className="skel skel-title" />
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={`skel skel-line ${i % 2 ? "w-60" : "w-80"}`} />
              ))}
            </section>
            <section className="card" aria-hidden>
              <div className="score-hero">
                <div className="skel skel-ring" />
                <div style={{ flex: 1 }}>
                  <div className="skel skel-line w-80" />
                  <div className="skel skel-line w-60" />
                </div>
              </div>
              <div className="skel skel-line w-100" style={{ marginTop: 16 }} />
              <div className="skel skel-line w-80" />
            </section>
          </div>
        </div>
      )}
    </main>
  );
}
