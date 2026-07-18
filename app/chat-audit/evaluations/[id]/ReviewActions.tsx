"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * ปุ่มตัดสินของหัวหน้า [ยืนยัน][แก้ไข][ยกเลิก] + [อุทธรณ์] ของนักบัญชี
 *   - เรียก API เดิม: POST /api/evaluations/review , /api/evaluations/appeal
 *   - สิทธิ์จริงบังคับที่ API (resolve session + access.ts) — ปุ่มนี้เป็นแค่ UI
 */
export default function ReviewActions({
  evaluationId,
  canReview,
  canAppeal,
}: {
  evaluationId: string;
  canReview: boolean;
  canAppeal: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [overall, setOverall] = useState("");
  const [appealing, setAppealing] = useState(false);
  const [reason, setReason] = useState("");

  async function post(url: string, body: Record<string, unknown>, okText: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) {
        setMsg(`ไม่สำเร็จ: ${data.message ?? data.error ?? res.status}`);
      } else {
        setMsg(okText);
        setEditing(false);
        setAppealing(false);
        router.refresh();
      }
    } catch {
      setMsg("เกิดข้อผิดพลาดในการเชื่อมต่อ");
    } finally {
      setBusy(false);
    }
  }

  function doReview(action: "confirm" | "edit" | "reject") {
    const body: Record<string, unknown> = { action: "review", reviewAction: action, evaluationId };
    if (action === "edit") {
      const n = Number(overall);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        setMsg("กรุณากรอกคะแนนรวม 0–100");
        return;
      }
      body.adjustedOverall = n;
    }
    const okText = action === "confirm" ? "✓ ยืนยันคะแนนแล้ว" : action === "edit" ? "✎ แก้ไขคะแนนแล้ว" : "✕ ยกเลิกการประเมินแล้ว";
    void post("/api/evaluations/review", body, okText);
  }

  function doAppeal() {
    if (reason.trim().length < 5) {
      setMsg("กรุณาระบุเหตุผลอุทธรณ์อย่างน้อย 5 ตัวอักษร");
      return;
    }
    void post("/api/evaluations/appeal", { evaluationId, reason: reason.trim() }, "🙋 ส่งคำอุทธรณ์ถึงหัวหน้าแล้ว");
  }

  return (
    <div>
      {canReview ? (
        <>
          <div className="section-title" style={{ fontSize: 14 }}>การตัดสินของหัวหน้า</div>
          <div className="btn-row">
            <button className="btn green" disabled={busy} onClick={() => doReview("confirm")}>✓ ยืนยันคะแนน</button>
            <button className="btn amber" disabled={busy} onClick={() => setEditing((v) => !v)}>✎ แก้ไขคะแนน</button>
            <button className="btn danger" disabled={busy} onClick={() => doReview("reject")}>✕ ยกเลิก</button>
          </div>
          {editing ? (
            <div className="btn-row" style={{ marginTop: 10, alignItems: "center" }}>
              <input
                type="number"
                min={0}
                max={100}
                value={overall}
                onChange={(e) => setOverall(e.target.value)}
                placeholder="คะแนนรวมใหม่ (0–100)"
                style={{ padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 10, width: 180, fontFamily: "inherit" }}
              />
              <button className="btn amber" disabled={busy} onClick={() => doReview("edit")}>บันทึกคะแนนใหม่</button>
            </div>
          ) : null}
        </>
      ) : null}

      {canAppeal ? (
        <>
          <hr className="hr" />
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>สำหรับนักบัญชี (เจ้าของผลประเมิน):</div>
          {appealing ? (
            <div>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="เหตุผลที่ขออุทธรณ์คะแนน..."
                rows={3}
                style={{ width: "100%", padding: 10, border: "1px solid var(--line)", borderRadius: 10, fontFamily: "inherit", fontSize: 13 }}
              />
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn" disabled={busy} onClick={doAppeal}>ส่งคำอุทธรณ์</button>
                <button className="btn" disabled={busy} onClick={() => setAppealing(false)}>ยกเลิก</button>
              </div>
            </div>
          ) : (
            <button className="btn" disabled={busy} onClick={() => setAppealing(true)}>🙋 อุทธรณ์คะแนน</button>
          )}
        </>
      ) : null}

      {msg ? <p style={{ marginTop: 10, fontSize: 13, fontWeight: 700, color: "var(--navy-800)" }}>{msg}</p> : null}
    </div>
  );
}
