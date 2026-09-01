"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBillUploadUrlAction, finalizeBillUploadAction, listCustomerOptionsAction } from "./actions";
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
  accountant = null,
}: {
  /** ตัวเลือกลูกค้า (โหมด toolbar — ไม่ผูกลูกค้า) */
  customers?: { id: string; label: string }[];
  /** ผูกลูกค้า (โหมดในการ์ดลูกค้า) — ล็อก ไม่ให้เลือก */
  lockedCustomerId?: string | null;
  lockedCustomerLabel?: string;
  defaultEntryType?: EntryType;
  label?: string;
  /** ★ accountant param ปัจจุบัน (admin/lead) — server ส่งมาเพื่อคงบริบทตอนเด้งเข้าหน้าแก้ */
  accountant?: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  // "" ยังไม่ทำ · uploading กำลังอัปไฟล์ · reading AI กำลังอ่านบิล (โชว์บนปุ่ม)
  const [phase, setPhase] = useState<"" | "uploading" | "reading">("");
  const [fileName, setFileName] = useState<string>("");
  // ความคืบหน้าอัปหลายไฟล์ เช่น "2/5" (ว่าง = ไฟล์เดียว/ยังไม่เริ่ม)
  const [prog, setProg] = useState<string>("");
  const [customerId, setCustomerId] = useState<string>(lockedCustomerId ?? "");
  const [entryType, setEntryType] = useState<EntryType>(defaultEntryType);
  const fileRef = useRef<HTMLInputElement>(null);
  // ★ perf: โหลดรายชื่อลูกค้าตอนเปิดกล่อง (ไม่ดึงทุกคลิกที่หน้า) — ใช้ prop ก่อน แล้ว fallback fetch
  const [fetchedCustomers, setFetchedCustomers] = useState<{ id: string; label: string }[] | null>(null);
  const [loadingCust, setLoadingCust] = useState(false);
  const custOptions = customers ?? fetchedCustomers ?? [];

  const locked = lockedCustomerId != null;

  function reset() {
    setErr(null);
    setPhase("");
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
    const files = Array.from(fileRef.current?.files ?? []);
    if (files.length === 0) {
      setErr("กรุณาเลือกไฟล์ก่อน");
      return;
    }
    // validate เบื้องต้นทุกไฟล์ก่อนเริ่มอัป (server validate ซ้ำอีกชั้นเสมอ)
    for (const file of files) {
      const v = validateUpload({ mime: file.type, name: file.name, size: file.size });
      if (!v.ok) {
        setErr(`${file.name}: ${v.error}`);
        return;
      }
    }
    setErr(null);

    // อัปตรงเข้า Supabase Storage ทีละไฟล์ (ไม่ผ่าน body ของ server action → ไม่ชนเพดาน Vercel 4.5MB)
    //   ต่อไฟล์: 1) ขอ signed upload URL → 2) browser อัปไฟล์ตรง → 3) finalize สร้าง entry
    //   → 4) AI อ่านบิลลงบัญชีให้ (best-effort) · ครบทุกไฟล์แล้ว → 5) เข้าหน้าตรวจ/แก้
    startTransition(async () => {
      const cid = customerId || null;
      setPhase("uploading");

      let firstId: string | null = null;
      const failed: string[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (files.length > 1) setProg(`${i + 1}/${files.length}`);

        // 1) ขอ signed upload URL
        const prep = await createBillUploadUrlAction({
          customerId: cid,
          entryType,
          fileName: file.name,
          mime: file.type,
          size: file.size,
        });
        if (!prep.ok) {
          failed.push(`${file.name} (${prep.message})`);
          continue;
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
            failed.push(`${file.name} (อัปโหลดไม่สำเร็จ)`);
            continue;
          }
        } catch {
          failed.push(`${file.name} (อัปโหลดไม่สำเร็จ)`);
          continue;
        }

        // 3) finalize → สร้าง entry (draft)
        const res = await finalizeBillUploadAction({
          customerId: cid,
          entryType,
          path: prep.path,
          name: file.name,
          mime: file.type,
        });
        if (!res.ok) {
          failed.push(`${file.name} (${res.message})`);
          continue;
        }

        // 4) ★ AI อ่านบิล "เบื้องหลัง" (async · ไม่รอ!) — keepalive ให้ request วิ่งต่อแม้เปลี่ยนหน้า
        //    → เข้าหน้าทันที ไม่ต้องนั่งรอ ~90 วิ · extraction เสร็จเบื้องหลัง แล้วข้อมูลเด้งเข้ามาเอง
        if (res.id) {
          if (!firstId) firstId = res.id;
          try {
            void fetch("/api/accounting/extract-upload", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ entryId: res.id }),
              keepalive: true,
            }).catch(() => {});
          } catch {
            // เงียบ — ยังเข้าหน้าได้ (คีย์เอง/สกัดใหม่ภายหลังได้)
          }
        }
      }

      setProg("");

      // ทุกไฟล์ล้มเหลว → อยู่ในกล่องเดิม โชว์เหตุผล (ไม่พาไปไหน)
      if (!firstId) {
        setErr(`อัปโหลดไม่สำเร็จ: ${failed.join(" · ")}`);
        setPhase("");
        return;
      }
      // สำเร็จบางส่วน → แจ้งไฟล์ที่พลาดผ่าน alert สั้น ๆ ก่อนพาไปหน้าตรวจ (ที่เหลือขึ้นแล้ว)
      if (failed.length > 0) {
        window.alert(`อัปสำเร็จ ${files.length - failed.length}/${files.length} ไฟล์ · ที่ไม่สำเร็จ: ${failed.join(" · ")}`);
      }

      // 5) เข้า "หน้ารายการบิลของลูกค้า" ทันที (ไม่รอ AI)
      //    ★ คง accountant + ?uploaded=<id แรก> → โชว์แถบ "AI กำลังอ่าน…" + รีเฟรชเองเมื่อเสร็จ
      const openKey = customerId || "unassigned";
      const sp = new URLSearchParams();
      const acct = accountant || searchParams.get("accountant");
      if (acct) sp.set("accountant", acct);
      sp.set("open", openKey);
      sp.set("type", entryType);
      sp.set("uploaded", firstId);
      setOpen(false);
      reset();
      router.push(`/chat-audit/accounting?${sp.toString()}`);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => {
          setOpen(true);
          // โหลดรายชื่อลูกค้าครั้งแรกที่เปิด (เฉพาะโหมด toolbar ที่ไม่ผูกลูกค้า + ยังไม่มี prop)
          if (!locked && !customers && fetchedCustomers === null && !loadingCust) {
            setLoadingCust(true);
            listCustomerOptionsAction()
              .then((r) => setFetchedCustomers(r))
              .finally(() => setLoadingCust(false));
          }
        }}
      >
        + {label}
      </button>

      {open ? (
        <div className="acc-modal-backdrop" role="dialog" aria-modal="true" aria-label="อัปโหลดไฟล์เข้าบัญชี">
          <button type="button" className="acc-modal-scrim" aria-label="ปิด" onClick={close} />
          <div className="acc-modal acc-modal-sm">
            <div className="acc-modal-head">
              <div>
                <div className="acc-modal-title">อัปโหลดไฟล์เข้าบัญชี</div>
                <div className="acc-modal-sub">แนบเอกสารที่ไม่ได้มาทางไลน์ (รูป / PDF / Excel / CSV ≤ 50MB ต่อไฟล์ · เลือกได้หลายไฟล์พร้อมกัน)</div>
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
                    <option value="">
                      {loadingCust ? "— กำลังโหลดรายชื่อลูกค้า… —" : "— ไม่ระบุลูกค้า (ยังไม่จับคู่) —"}
                    </option>
                    {custOptions.map((c) => (
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
                  multiple
                  onChange={(e) => {
                    const fs = Array.from(e.target.files ?? []);
                    setErr(null);
                    const tooBig = fs.find((f) => f.size > MAX_UPLOAD_BYTES);
                    if (tooBig) {
                      setErr(`${tooBig.name}: ไฟล์ใหญ่เกิน 50MB`);
                      setFileName("");
                    } else if (fs.length > 1) {
                      setFileName(`${fs.length} ไฟล์: ${fs.map((f) => f.name).join(", ")}`);
                    } else {
                      setFileName(fs[0]?.name ?? "");
                    }
                  }}
                />
                {fileName ? <span className="acc-upload-fname" title={fileName}>{fileName}</span> : null}
              </label>

              {err ? <div className="action-msg err">{err}</div> : null}

              <div className="acc-modal-actions">
                <button type="button" className="btn" onClick={submit} disabled={pending}>
                  {pending ? `กำลังอัปโหลด${prog ? ` ${prog}` : ""}…` : "อัปโหลด"}
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
