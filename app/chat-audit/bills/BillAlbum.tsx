"use client";

import { useMemo, useState } from "react";
import JSZip from "jszip";
import type { DocKind } from "@/lib/chat-audit/bills";
import {
  billDownloadName,
  fileExt,
  withDownloadParam,
  zipName,
} from "@/lib/chat-audit/album";
import DeleteBillButton from "./DeleteBillButton";

/**
 * BillAlbum — อัลบั้มรูปบิลของลูกค้า 1 ราย (client) : เลือกหลายรูป + ดาวน์โหลด (ทีละรูป/zip)
 *
 * ★ image-only: หน้าอัลบั้มโชว์ "รูปบิล" อย่างเดียว (ไฟล์ PDF/เอกสารไม่เข้าที่นี่ตามกติกา)
 * ★ รับ "บิลที่ sign แล้ว" (viewUrl) มาจาก server (สโคปนักบัญชีบังคับฝั่ง server แล้ว)
 *   client จึงมี signed URL เฉพาะบิลที่อยู่ในสิทธิ์ตัวเองเท่านั้น (สโคปอัตโนมัติ)
 * ★ ดาวน์โหลด:
 *   - ทีละรูป: signed URL + `&download=<ชื่อ ASCII>` (Supabase ตั้ง Content-Disposition ให้)
 *   - หลายรูป/ทั้งลูกค้า: fetch blob แล้วรวมเป็น zip ฝั่ง client ด้วย JSZip
 *     (ไม่กิน memory/timeout ฝั่ง server) — มี progress + กันกดซ้ำ + เตือนเมื่อไฟล์เยอะ
 * ★ PDPA: ชื่อไฟล์ใช้ customer_code + วันที่ + ลำดับ (ไม่มีชื่อลูกค้า/ไทย) · ไม่ log อะไร
 */

/** บิล 1 ใบพร้อม signed URL (ส่งมาจาก server) */
export type AlbumBill = {
  id: string;
  /** signed URL (null = เปิด/ดาวน์โหลดไม่ได้ → แสดง placeholder) */
  viewUrl: string | null;
  docKind: DocKind | null;
  /** ISO date ของบิล */
  billDate: string;
  attachmentType: "image" | "file";
  originalName: string | null;
  objectPath: string | null;
};

/** ป้ายชนิดเอกสาร (ตรงกับ KIND_META ใน page.tsx) */
const KIND_LABEL: Record<DocKind, { label: string; cls: string }> = {
  slip: { label: "สลิปโอน", cls: "k-slip" },
  sale: { label: "ขาย", cls: "k-sale" },
  handwritten: { label: "เขียนมือ", cls: "k-hand" },
  purchase: { label: "ซื้อ", cls: "k-purchase" },
  cash: { label: "เงินสด", cls: "k-cash" },
  other: { label: "อื่นๆ", cls: "k-other" },
};

/** เพดานจำนวนไฟล์ที่เตือนก่อนทำ zip (เยอะมากอาจใช้เวลา/หน่วยความจำเบราว์เซอร์) */
const ZIP_WARN_THRESHOLD = 200;

/** วันที่แบบไทยสั้น (fallback = "-") */
function formatDateShort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

/** ยิงดาวน์โหลด blob (object URL) — same-origin blob จึงตั้งชื่อไฟล์ได้ */
function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // คืน memory หลังเบราว์เซอร์เริ่มดาวน์โหลด
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export default function BillAlbum({
  bills,
  customerCode,
  canDelete,
  truncated = false,
}: {
  bills: AlbumBill[];
  /** รหัสลูกค้า (ใช้ตั้งชื่อไฟล์ ASCII) — null = ยังไม่จับคู่ (จะใช้ "NA") */
  customerCode: string | null;
  /** แสดงปุ่มลบไหม (เฉพาะ admin — server action guard admin อยู่แล้ว) */
  canDelete: boolean;
  /** true = sign ไม่ครบ (ลูกค้ามีบิลเกินเพดาน) → แจ้งเตือนผู้ใช้ */
  truncated?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [zipping, setZipping] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerIdx, setViewerIdx] = useState<number | null>(null);

  // อัลบั้ม = รูปบิลทั้งหมด (image-only ตามกติกา; กัน edge case ด้วยการ filter)
  const images = useMemo(() => bills.filter((b) => b.attachmentType === "image"), [bills]);

  // แผนที่ id → ลำดับ (สำหรับตั้งชื่อไฟล์คงที่ ไม่ขึ้นกับว่าเลือกอันไหน)
  const idxById = useMemo(() => {
    const m = new Map<string, number>();
    images.forEach((b, i) => m.set(b.id, i + 1));
    return m;
  }, [images]);

  const selectableCount = images.filter((b) => b.viewUrl).length;
  const allSelected = selectableCount > 0 && selected.size === selectableCount;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(images.filter((b) => b.viewUrl).map((b) => b.id)));
    }
  }

  /** ชื่อไฟล์ ASCII ของบิลใบนี้ (ลำดับคงที่ตาม idxById; ไฟล์ที่ไม่ใช่รูปใช้ลำดับต่อท้าย) */
  function nameOf(b: AlbumBill, fallbackIdx: number): string {
    const idx = idxById.get(b.id) ?? fallbackIdx;
    const ext = fileExt(b.originalName, b.objectPath, b.attachmentType === "image");
    return billDownloadName(customerCode, b.billDate, idx, ext);
  }

  /** รวมบิลที่เลือกเป็น zip แล้วดาวน์โหลด (fetch blob ทีละไฟล์ + progress) */
  async function downloadZip(list: AlbumBill[]) {
    if (zipping) return; // กันกดซ้ำ
    const withUrl = list.filter((b) => b.viewUrl);
    if (withUrl.length === 0) return;
    if (
      withUrl.length > ZIP_WARN_THRESHOLD &&
      !window.confirm(
        `มี ${withUrl.length} ไฟล์ อาจใช้เวลาสักครู่และใช้หน่วยความจำเบราว์เซอร์พอสมควร ต้องการดำเนินการต่อหรือไม่?`
      )
    ) {
      return;
    }

    setZipping(true);
    setError(null);
    setProgress({ done: 0, total: withUrl.length });
    try {
      const zip = new JSZip();
      let done = 0;
      let failed = 0;
      for (let i = 0; i < withUrl.length; i++) {
        const b = withUrl[i];
        try {
          const res = await fetch(b.viewUrl as string);
          if (!res.ok) throw new Error("fetch failed");
          const blob = await res.blob();
          zip.file(nameOf(b, i + 1), blob);
        } catch {
          failed++; // ข้ามไฟล์ที่โหลดไม่ได้ ไม่ให้ทั้งชุดล้ม
        }
        done++;
        setProgress({ done, total: withUrl.length });
      }
      const out = await zip.generateAsync({ type: "blob" });
      triggerBlobDownload(out, zipName(customerCode));
      if (failed > 0) setError(`ดาวน์โหลดสำเร็จ ${done - failed}/${withUrl.length} ไฟล์ (บางไฟล์โหลดไม่ได้)`);
    } catch {
      setError("สร้างไฟล์ zip ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    } finally {
      setZipping(false);
      setProgress(null);
    }
  }

  const selectedBills = images.filter((b) => selected.has(b.id));

  return (
    <div className="cust-body">
      {truncated ? (
        <p className="album-note">
          ลูกค้ารายนี้มีบิลจำนวนมาก — แสดง/ดาวน์โหลดได้บางส่วน ลองใช้ตัวกรองเดือน/ประเภทเพื่อดูให้ครบ
        </p>
      ) : null}

      {/* ---- แถบเครื่องมืออัลบั้ม: เลือกทั้งหมด + ดาวน์โหลดทั้งลูกค้า (zip) ---- */}
      <div className="album-toolbar">
        <span className="album-count">{images.length.toLocaleString("th-TH")} รูป</span>
        {selectableCount > 0 ? (
          <button type="button" className="btn btn-ghost album-selall" onClick={selectAll} disabled={zipping}>
            {allSelected ? "ล้างที่เลือก" : "เลือกทั้งหมด"}
          </button>
        ) : null}
        <span className="album-spacer" />
        <button
          type="button"
          className="btn album-dl-all"
          onClick={() => downloadZip(bills)}
          disabled={zipping || bills.every((b) => !b.viewUrl)}
        >
          ⬇ ดาวน์โหลดทั้งหมด (zip)
        </button>
      </div>

      {/* สถานะกำลังเตรียม zip / ข้อความ error */}
      {progress ? (
        <p className="album-progress" role="status">
          กำลังเตรียมไฟล์… {progress.done}/{progress.total}
        </p>
      ) : null}
      {error ? <p className="album-error" role="alert">{error}</p> : null}

      {images.length === 0 ? (
        <p className="empty">ไม่มีรูปบิลในลูกค้ารายนี้</p>
      ) : (
        <div className="bills-grid">
          {/* ---- รูปบิล (image) — checkbox เลือก + คลิกดูใหญ่ + ดาวน์โหลด ---- */}
          {images.map((b, i) => {
            const isSel = selected.has(b.id);
            return (
              <div key={b.id} className={`bill-card${isSel ? " bill-selected" : ""}`}>
                {b.docKind ? (
                  <span className={`bill-kind ${KIND_LABEL[b.docKind].cls}`}>
                    {KIND_LABEL[b.docKind].label}
                  </span>
                ) : null}

                {/* checkbox เลือกหลายรูป (เฉพาะรูปที่เปิดได้) */}
                {b.viewUrl ? (
                  <label className="bill-check" title="เลือกรูปนี้">
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggle(b.id)}
                      aria-label="เลือกบิลนี้เพื่อดาวน์โหลด"
                    />
                  </label>
                ) : null}

                {canDelete ? <DeleteBillButton attachmentId={b.id} /> : null}

                {b.viewUrl ? (
                  <button
                    type="button"
                    className="bill-thumb bill-thumb-btn"
                    onClick={() => setViewerIdx(i)}
                    aria-label="เปิดดูรูปบิลขนาดใหญ่"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={b.viewUrl} alt="รูปบิล" loading="lazy" />
                  </button>
                ) : (
                  <div className="bill-thumb bill-thumb-empty" aria-hidden="true">เปิดไม่ได้</div>
                )}

                <div className="bill-meta">
                  <div className="bill-date">{formatDateShort(b.billDate)}</div>
                  {b.viewUrl ? (
                    <a
                      href={withDownloadParam(b.viewUrl, nameOf(b, i + 1))}
                      className="btn bill-open"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      ⬇ ดาวน์โหลด
                    </a>
                  ) : (
                    <span className="btn bill-open bill-open-disabled" aria-disabled="true">ไฟล์ไม่พร้อม</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ---- แถบ "เลือกไว้ N รูป → ดาวน์โหลดที่เลือก" (โผล่เมื่อมีการเลือก) ---- */}
      {selected.size > 0 ? (
        <div className="album-selbar">
          <span className="album-seltxt">✓ เลือกไว้ {selected.size.toLocaleString("th-TH")} รูป</span>
          <button type="button" className="btn btn-ghost" onClick={() => setSelected(new Set())} disabled={zipping}>
            ล้าง
          </button>
          <button
            type="button"
            className="btn album-dl-sel"
            onClick={() => downloadZip(selectedBills)}
            disabled={zipping}
          >
            ⬇ ดาวน์โหลดที่เลือก ({selected.size})
          </button>
        </div>
      ) : null}

      {/* ---- Viewer รูปใหญ่ + ก่อนหน้า/ถัดไป + ดาวน์โหลด ---- */}
      {viewerIdx !== null && images[viewerIdx] ? (
        <ImageViewer
          bills={images}
          index={viewerIdx}
          customerCode={customerCode}
          idxById={idxById}
          onClose={() => setViewerIdx(null)}
          onNav={(next) => setViewerIdx(next)}
        />
      ) : null}
    </div>
  );
}

/** modal ดูรูปใหญ่ — overlay เต็มจอ, มีปุ่มก่อนหน้า/ถัดไป/ดาวน์โหลด/ปิด */
function ImageViewer({
  bills,
  index,
  customerCode,
  idxById,
  onClose,
  onNav,
}: {
  bills: AlbumBill[];
  index: number;
  customerCode: string | null;
  idxById: Map<string, number>;
  onClose: () => void;
  onNav: (next: number) => void;
}) {
  const b = bills[index];
  const hasPrev = index > 0;
  const hasNext = index < bills.length - 1;
  const kind = b.docKind ? KIND_LABEL[b.docKind].label : "ไม่ระบุประเภท";
  const ext = fileExt(b.originalName, b.objectPath, true);
  const filename = billDownloadName(customerCode, b.billDate, idxById.get(b.id) ?? index + 1, ext);

  return (
    <div className="album-viewer-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="album-viewer" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="album-viewer-close" onClick={onClose} aria-label="ปิด">✕</button>
        <div className="album-viewer-img">
          {b.viewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={b.viewUrl} alt="รูปบิล" />
          ) : (
            <span className="album-viewer-empty">เปิดรูปไม่ได้</span>
          )}
        </div>
        <div className="album-viewer-side">
          <div className="album-viewer-meta">
            <b>{formatDateShort(b.billDate)}</b>
            <span>{kind}</span>
          </div>
          <div className="album-viewer-nav">
            <button type="button" className="btn btn-ghost" onClick={() => onNav(index - 1)} disabled={!hasPrev}>
              ← ก่อนหน้า
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => onNav(index + 1)} disabled={!hasNext}>
              ถัดไป →
            </button>
          </div>
          {b.viewUrl ? (
            <a
              href={withDownloadParam(b.viewUrl, filename)}
              className="btn album-viewer-dl"
              target="_blank"
              rel="noopener noreferrer"
            >
              ⬇ ดาวน์โหลดรูปนี้
            </a>
          ) : (
            <span className="btn bill-open-disabled" aria-disabled="true">ไฟล์ไม่พร้อม</span>
          )}
        </div>
      </div>
    </div>
  );
}
