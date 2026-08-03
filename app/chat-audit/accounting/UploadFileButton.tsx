"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createBillUploadUrlAction, finalizeBillUploadAction } from "./actions";
import { createClient as createBrowserSupabase } from "@/lib/supabase/client";
import { UPLOAD_ACCEPT, MAX_UPLOAD_BYTES, validateUpload } from "@/lib/accounting/upload";
import type { EntryType } from "@/lib/accounting/queries";

/** bucket รูปบิล (ต้องตรงกับ BILLS_BUCKET ใน actions.ts / storage) */
const BILLS_BUCKET = "bills";

/**
 * ปุ่ม "อัปโหลดไฟล์เอง" (client) — นักบัญชีแนบเอกสาร (Excel/PDF/รูป/CSV) ที่ไม่ได้มาทางไลน์
 *
 * ★ เปิดฟอร์ม (modal): เลือกลูกค้า (ถ้าไม่ได้อยู่ในบริบทลูกค้า) + ไฟล์ + ประเภท (ซื้อ/ขาย/รอระบุ)
 * ★ upload ผ่าน server action (guard admin + service-role) — client แค่ validate เบื้องต้น
 * ★ สำเร็จ → พาไปหน้าแก้ (?edit=<id>) เพื่อคีย์ตัวเลขต่อทันที
 */
export default function UploadFileButton({
  customers,
  lockedCustomerId,
  lockedCustomerLabel,
  defaultEntryType = "purchase",
  label = "อัปโหลดไฟล์เอง",
}: {
  /** ตัวเลือกลูกค้า (โหมด toolbar — ไม่ผูกลูกค้า) */
  customers?: { id: string; label: string }[];
  /** ผูกลูกค้า (โหมดในการ์ดลูกค้า) — ล็อก ไม่ให้เลือก */
  lockedCustomerId?: string | null;
  lockedCustomerLabel?: string;
  defaultEntryType?: EntryType;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [customerId, setCustomerId] = useState<string>(lockedCustomerId ?? "");
  const [entryType, setEntryType] = useState<EntryType>(defaultEntryType);
  const fileRef = useRef<HTMLInputElement>(null);

  const locked = lockedCustomerId != null;

  function reset() {
    setErr(null);
    setFileName("");
    setEntryType(defaultEntryType);
    if (!locked) setCustomerId("");
    if (fileRef.current) fileRef.current.value = "";
  }

  function close() {
    setOpen(false);
    reset();
  }

  function submit() {
    const file = fileRef.current?.files?.[0] ?? null;
    if (!file) {
      setErr("กรุณาเลือกไฟล์ก่อน");
      return;
    }
    // validate เบื้องต้นฝั่ง client (server validate ซ้ำอีกชั้นเสมอ)
    const v = validateUpload({ mime: file.type, name: file.name, size: file.size });
    if (!v.ok) {
      setErr(v.error);
      return;
    }
    setErr(null);

    // อัปตรงเข้า Supabase Storage (ไม่ผ่าน body ของ server action → ไม่ชนเพดาน Vercel 4.5MB)
    //   1) ขอ signed upload URL (server คุม path) → 2) browser อัปไฟล์ตรง → 3) finalize สร้าง entry
    startTransition(async () => {
      const cid = customerId || null;

      // 1) ขอ signed upload URL
      const prep = await createBillUploadUrlAction({
        customerId: cid,
        entryType,
        fileName: file.name,
        mime: file.type,
        size: file.size,
      });
      if (!prep.ok) {
        setErr(prep.message);
        return;
      }

      // 2) อัปไฟล์ตรงเข้า Storage ด้วย token (ไฟล์ใหญ่ก็ผ่าน — ไม่วิ่งผ่าน serverless)
      try {
        const supabase = createBrowserSupabase();
        const { error: upErr } = await supabase.storage
          .from(BILLS_BUCKET)
          .uploadToSignedUrl(prep.path, prep.token, file, {
            contentType: file.type || undefined,
          });
        if (upErr) {
          setErr(`อัปโหลดไฟล์ไม่สำเร็จ: ${upErr.message || "กรุณาลองใหม่"}`);
          return;
        }
      } catch {
        setErr("อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      // 3) finalize → สร้าง entry (manual/draft) แล้วพาไปหน้าตรวจ/แก้
      const res = await finalizeBillUploadAction({
        customerId: cid,
        entryType,
        path: prep.path,
        name: file.name,
        mime: file.type,
      });
      if (res.ok) {
        const openKey = customerId || "unassigned";
        const sp = new URLSearchParams();
        sp.set("open", openKey);
        sp.set("type", entryType);
        if (res.id) sp.set("edit", res.id);
        setOpen(false);
        reset();
        router.push(`/chat-audit/accounting?${sp.toString()}`);
        router.refresh();
      } else {
        setErr(res.message);
      }
    });
  }

  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        + {label}
      </button>

      {open ? (
        <div className="acc-modal-backdrop" role="dialog" aria-modal="true" aria-label="อัปโหลดไฟล์เข้าบัญชี">
          <button type="button" className="acc-modal-scrim" aria-label="ปิด" onClick={close} />
          <div className="acc-modal acc-modal-sm">
            <div className="acc-modal-head">
              <div>
                <div className="acc-modal-title">อัปโหลดไฟล์เข้าบัญชี</div>
                <div className="acc-modal-sub">แนบเอกสารที่ไม่ได้มาทางไลน์ (รูป / PDF / Excel / CSV ≤ 15MB)</div>
              </div>
              <button type="button" className="acc-modal-close" onClick={close} aria-label="ปิด">✕</button>
            </div>

            <div className="acc-upload-form">
              {/* ลูกค้า */}
              {locked ? (
                <div className="acc-field acc-field-wide">
                  <span>ลูกค้า</span>
                  <div className="acc-upload-locked">{lockedCustomerLabel || "ลูกค้าที่เลือก"}</div>
                </div>
              ) : (
                <label className="acc-field acc-field-wide">
                  <span>ลูกค้า</span>
                  <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                    <option value="">— ไม่ระบุลูกค้า (ยังไม่จับคู่) —</option>
                    {(customers ?? []).map((c) => (
                      <option key={c.id} value={c.id}>{c.label}</option>
                    ))}
                  </select>
                </label>
              )}

              {/* ประเภท */}
              <label className="acc-field">
                <span>ประเภท</span>
                <select value={entryType} onChange={(e) => setEntryType(e.target.value as EntryType)}>
                  <option value="purchase">บิลซื้อ</option>
                  <option value="sale">บิลขาย</option>
                  <option value="unspecified">รอระบุ</option>
                </select>
              </label>

              {/* ไฟล์ */}
              <label className="acc-field acc-field-wide">
                <span>ไฟล์</span>
                <input
                  ref={fileRef}
                  type="file"
                  accept={UPLOAD_ACCEPT}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    setErr(null);
                    if (f && f.size > MAX_UPLOAD_BYTES) {
                      setErr("ไฟล์ใหญ่เกิน 15MB");
                      setFileName("");
                    } else {
                      setFileName(f?.name ?? "");
                    }
                  }}
                />
                {fileName ? <span className="acc-upload-fname" title={fileName}>{fileName}</span> : null}
              </label>

              {err ? <div className="action-msg err">{err}</div> : null}

              <div className="acc-modal-actions">
                <button type="button" className="btn" onClick={submit} disabled={pending}>
                  {pending ? "กำลังอัปโหลด…" : "อัปโหลด"}
                </button>
                <span className="acc-toolbar-spacer" />
                <button type="button" className="btn btn-ghost" onClick={close} disabled={pending}>ยกเลิก</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
