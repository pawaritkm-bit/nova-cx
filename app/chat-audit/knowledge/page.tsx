import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { isAdminRole } from "@/lib/admin/guard";
import {
  getKnowledgeList,
  KNOWLEDGE_STATUSES,
  type KnowledgeList,
  type KnowledgeStatus,
} from "@/lib/knowledge/queries";
import ChatAuditFrame from "../_Frame";
import ReviewButtons from "./ReviewButtons";

export const dynamic = "force-dynamic";

const DEV_FALLBACK = process.env.NODE_ENV !== "production";
const TITLE = "ตรวจแชต · คลังคำตอบ AI";
const SUBTITLE =
  "คลังคู่ถาม-ตอบที่ AI สกัดจากแชตกลุ่ม เพื่อให้ทีมเรียนรู้แนวทางการตอบลูกค้า — รีวิว/คัดกรองก่อนเก็บเป็นความรู้ (เฟสนี้เก็บ+เรียนรู้เท่านั้น AI ยังไม่ตอบลูกค้า)";

const STATUS_LABEL: Record<string, string> = {
  new: "รอรีวิว",
  approved: "อนุมัติแล้ว",
  rejected: "ตัดออก",
};

const STATUS_BADGE: Record<string, string> = {
  new: "b-yellow",
  approved: "b-green",
  rejected: "b-red",
};

/** เวลาแบบสั้นภาษาไทย (best-effort) */
function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("th-TH", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** สร้าง query string คงค่า filter อื่นไว้ */
function qs(params: { category?: string | null; status?: string | null }): string {
  const sp = new URLSearchParams();
  if (params.category) sp.set("category", params.category);
  if (params.status) sp.set("status", params.status);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; status?: string }>;
}) {
  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-knowledge" role={null} authed={false} title={TITLE} subtitle={SUBTITLE}>
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const db = await createClient();
  const viewer = await resolveEvalViewer(db);

  // ★ guard: default-deny — เข้าได้เฉพาะ admin/executive
  if (!viewer.role && !DEV_FALLBACK) redirect("/login?redirect=/chat-audit/knowledge");
  if (!isAdminRole(viewer.role) || !viewer.tenantId) {
    return (
      <ChatAuditFrame active="chat-knowledge" role={viewer.role} authed={!!viewer.role} title={TITLE} subtitle={SUBTITLE}>
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>หน้านี้เปิดเฉพาะผู้ดูแลระบบ / ผู้บริหาร</p>
          <p className="muted" style={{ fontSize: 13 }}>
            <Link href="/dashboard" className="underline">← กลับ Dashboard</Link>
          </p>
        </div>
      </ChatAuditFrame>
    );
  }

  const sp = await searchParams;
  const categoryFilter = sp.category?.trim() || null;
  const statusFilter =
    sp.status && (KNOWLEDGE_STATUSES as readonly string[]).includes(sp.status)
      ? (sp.status as KnowledgeStatus)
      : null;

  let d: KnowledgeList;
  try {
    d = await getKnowledgeList(db, viewer.tenantId, {
      category: categoryFilter,
      status: statusFilter,
    });
  } catch {
    return (
      <ChatAuditFrame active="chat-knowledge" role={viewer.role} authed={!!viewer.role} title={TITLE} subtitle={SUBTITLE}>
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0041)</div>
      </ChatAuditFrame>
    );
  }

  return (
    <ChatAuditFrame active="chat-knowledge" role={viewer.role} authed={!!viewer.role} title={TITLE} subtitle={SUBTITLE}>
      <div className="dash-views">
        {/* ตัวกรองสถานะ */}
        <nav className="risk-legend" aria-label="สถานะ">
          <Link
            href={`/chat-audit/knowledge${qs({ category: categoryFilter, status: null })}`}
            className={`badge ${!statusFilter ? "b-orange" : "b-green"}`}
          >
            ทุกสถานะ
          </Link>
          {KNOWLEDGE_STATUSES.map((s) => (
            <Link
              key={s}
              href={`/chat-audit/knowledge${qs({ category: categoryFilter, status: s })}`}
              className={`badge ${statusFilter === s ? "b-orange" : "b-green"}`}
            >
              {STATUS_LABEL[s]}
            </Link>
          ))}
        </nav>

        {/* ตัวกรองหมวด (นับจำนวนต่อหมวด) */}
        {d.categories.length > 0 ? (
          <nav className="risk-legend" aria-label="หมวด">
            <Link
              href={`/chat-audit/knowledge${qs({ category: null, status: statusFilter })}`}
              className={`badge ${!categoryFilter ? "b-orange" : "b-green"}`}
            >
              ทุกหมวด ({d.total})
            </Link>
            {d.categories.map((c) => (
              <Link
                key={c.category}
                href={`/chat-audit/knowledge${qs({ category: c.category, status: statusFilter })}`}
                className={`badge ${categoryFilter === c.category ? "b-orange" : "b-green"}`}
              >
                {c.category} ({c.count})
              </Link>
            ))}
          </nav>
        ) : null}

        {d.items.length === 0 ? (
          <section className="card">
            <p className="empty">
              {d.total === 0 ? "ยังไม่มีคลังคำตอบ" : "ไม่มีรายการตรงตัวกรองที่เลือก"}
            </p>
            <p className="muted" style={{ fontSize: 13, textAlign: "center" }}>
              {d.total === 0
                ? "เมื่อมีบทสนทนากลุ่มที่ลูกค้าถามแล้วทีมงานตอบ และระบบสกัดแล้ว คู่ถาม-ตอบจะปรากฏที่นี่ให้รีวิว"
                : "ลองเปลี่ยนหมวด/สถานะ เพื่อดูรายการอื่น"}
            </p>
          </section>
        ) : (
          <section className="card">
            <div className="section-title">
              <span>คู่ถาม-ตอบ</span>
              <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                {d.items.length} รายการ
              </span>
            </div>
            <div className="table-wrap">
              <table className="dlv-table">
                <thead>
                  <tr>
                    <th>หมวด</th>
                    <th>คำถามลูกค้า</th>
                    <th>แนวคำตอบของทีม</th>
                    <th className="center">ผู้ตอบ</th>
                    <th className="center">สถานะ</th>
                    <th>เวลา</th>
                    <th className="center">จัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((it) => (
                    <tr key={it.id}>
                      <td><b style={{ color: "var(--navy-800)" }}>{it.category}</b></td>
                      <td>
                        {it.blockedReason ? (
                          <span className="muted">⚠ ถูกระงับ (พบ PII ตกค้าง) — ไม่ได้สกัดเนื้อหา</span>
                        ) : (
                          (it.question ?? <span className="muted">— (ถอดข้อความไม่ได้/ไม่มีคีย์) —</span>)
                        )}
                      </td>
                      <td>{it.blockedReason ? "—" : (it.answer ?? <span className="muted">—</span>)}</td>
                      <td className="center">{it.staffRole ?? "—"}</td>
                      <td className="center">
                        <span className={`badge ${STATUS_BADGE[it.status] ?? "b-yellow"}`}>
                          {STATUS_LABEL[it.status] ?? it.status}
                        </span>
                      </td>
                      <td>{fmtTime(it.at)}</td>
                      <td className="center">
                        <ReviewButtons id={it.id} status={it.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <div className="note-box warn">
          🤖 คู่ถาม-ตอบ/หมวด เป็นการสกัดของ AI จากแชตกลุ่ม (ปิดบัง PII + เข้ารหัสเนื้อหาแล้ว) — <b>เก็บเพื่อเรียนรู้เท่านั้น</b> ·
          เฟสนี้ AI <b>ยังไม่ตอบลูกค้า/ไม่ร่างคำตอบ</b> · หน้านี้ <b>ไม่เกี่ยวข้อง</b> กับการประเมินนักบัญชี/ประเมินสำนักงาน
        </div>
      </div>
    </ChatAuditFrame>
  );
}
