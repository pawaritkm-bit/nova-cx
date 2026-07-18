"use client";

/**
 * ตารางคำตอบแบบประเมินรายบุคคล (client) — เรียง/กรองฝั่ง client
 *   - ข้อมูลถูกดึงฝั่ง server (service-role + guard admin/exec) แล้วส่งมาเป็น props
 *   - ผู้ใช้กรองตามชนิดฟอร์ม (A/B/C/D) + เรียงตามวันที่/ตามลูกค้า
 */
import { useMemo, useState } from "react";
import type { IndividualResponseView } from "@/lib/surveys/responses";
import type { SurveyType } from "@/lib/survey/types";

type SortKey = "date" | "customer";
type SortDir = "asc" | "desc";
type FormFilter = "all" | SurveyType;

const FORM_LABEL: Record<SurveyType, string> = {
  A: "A · สำนักงาน",
  B: "B · นักบัญชี",
  C: "C · ปิดการขายได้",
  D: "D · ปิดการขายไม่ได้",
};

const SENTIMENT_LABEL: Record<string, string> = {
  positive: "บวก",
  neutral: "กลาง",
  negative: "ลบ",
};

const URGENCY_LABEL: Record<string, string> = {
  critical: "วิกฤต",
  high: "สูง",
  medium: "กลาง",
  positive: "เชิงบวก",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("th-TH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ResponsesTable({
  rows,
  truncated = false,
  limit = 0,
}: {
  rows: IndividualResponseView[];
  /** true = ข้อมูลถูกตัดที่ limit (มีคำตอบมากกว่านี้) → แสดงแบนเนอร์เตือน */
  truncated?: boolean;
  limit?: number;
}) {
  const [formFilter, setFormFilter] = useState<FormFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const view = useMemo(() => {
    const filtered =
      formFilter === "all" ? rows : rows.filter((r) => r.surveyType === formFilter);

    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "date") {
        const ta = a.submittedAt ? Date.parse(a.submittedAt) : 0;
        const tb = b.submittedAt ? Date.parse(b.submittedAt) : 0;
        cmp = ta - tb;
      } else {
        // เรียงตามชื่อลูกค้า — ★ null ลงท้ายเสมอ (ไม่ว่าจะ asc/desc) จึง return ก่อน apply sortDir
        const aNull = a.customerName == null;
        const bNull = b.customerName == null;
        if (aNull && bNull) return 0;
        if (aNull) return 1;
        if (bNull) return -1;
        cmp = a.customerName!.localeCompare(b.customerName!, "th");
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [rows, formFilter, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "date" ? "desc" : "asc");
    }
  }

  const sortMark = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  return (
    <div className="card">
      {truncated && (
        <div className="responses-truncated" role="status">
          แสดงเฉพาะ {limit} คำตอบล่าสุด — มีคำตอบมากกว่านี้ (กรองชนิดฟอร์มเพื่อจำกัดขอบเขตการดู)
        </div>
      )}
      <div className="responses-toolbar">
        <div className="responses-filter">
          <label htmlFor="form-filter">ชนิดฟอร์ม</label>
          <select
            id="form-filter"
            value={formFilter}
            onChange={(e) => setFormFilter(e.target.value as FormFilter)}
          >
            <option value="all">ทั้งหมด</option>
            <option value="A">{FORM_LABEL.A}</option>
            <option value="B">{FORM_LABEL.B}</option>
            <option value="C">{FORM_LABEL.C}</option>
            <option value="D">{FORM_LABEL.D}</option>
          </select>
        </div>
        <p className="muted responses-count">
          แสดง <strong>{view.length}</strong> คำตอบ
          {formFilter !== "all" ? ` (ฟอร์ม ${formFilter})` : ""}
        </p>
      </div>

      {view.length === 0 ? (
        <p className="muted" style={{ padding: "8px 2px" }}>
          ยังไม่มีคำตอบที่ตรงเงื่อนไข
        </p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table responses-table">
            <thead>
              <tr>
                <th
                  className="sortable"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleSort("customer")}
                  onKeyDown={(e) => e.key === "Enter" && toggleSort("customer")}
                >
                  ลูกค้า{sortMark("customer")}
                </th>
                <th>ฟอร์ม</th>
                <th
                  className="sortable"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleSort("date")}
                  onKeyDown={(e) => e.key === "Enter" && toggleSort("date")}
                >
                  วันที่ส่ง{sortMark("date")}
                </th>
                <th>CSAT</th>
                <th>NPS</th>
                <th>นักบัญชีที่ถูกประเมิน (B)</th>
                <th>ผล AI</th>
              </tr>
            </thead>
            <tbody>
              {view.map((r) => (
                <tr key={r.responseId}>
                  <td>
                    <div className="responses-customer">
                      <span className="responses-cust-name">
                        {r.customerName ?? "(ไม่ระบุชื่อ)"}
                      </span>
                      <span className="responses-cust-code muted">
                        {r.customerCode ?? "—"}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="survey-type-chip" aria-hidden="true">
                      {r.surveyType}
                    </span>
                  </td>
                  <td>{formatDate(r.submittedAt)}</td>
                  <td>{r.csatOverall != null ? r.csatOverall.toFixed(2) : "—"}</td>
                  <td>
                    {r.npsScore != null ? (
                      <span>
                        {r.npsScore}
                        {r.npsCategory ? (
                          <span className="muted"> · {r.npsCategory}</span>
                        ) : null}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {r.evaluatedEmployees.length > 0
                      ? r.evaluatedEmployees.map((e) => e.name).join(", ")
                      : "—"}
                  </td>
                  <td>
                    {r.aiSentiment || r.aiUrgency || r.aiSummary ? (
                      <div className="responses-ai">
                        {(r.aiSentiment || r.aiUrgency) && (
                          <span className="responses-ai-tags">
                            {r.aiSentiment
                              ? SENTIMENT_LABEL[r.aiSentiment] ?? r.aiSentiment
                              : null}
                            {r.aiSentiment && r.aiUrgency ? " · " : null}
                            {r.aiUrgency
                              ? URGENCY_LABEL[r.aiUrgency] ?? r.aiUrgency
                              : null}
                          </span>
                        )}
                        {r.aiSummary ? (
                          <span className="responses-ai-summary muted" title={r.aiSummary}>
                            {r.aiSummary}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
