"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * แถบโหลดบางๆ ด้านบน (top progress bar) แบบ YouTube/GitHub
 *   - ไม่พึ่ง lib ภายนอก (nprogress ฯลฯ) → CSP-safe, ใช้ CSS keyframe/transition ล้วน
 *   - เริ่มแถบเมื่อผู้ใช้ "เริ่ม" navigate (คลิกลิงก์ภายใน / back-forward)
 *     เพราะ usePathname จะอัปเดตก็ต่อเมื่อหน้าใหม่ commit เสร็จแล้วเท่านั้น
 *   - จบแถบเมื่อ pathname เปลี่ยน (หน้าใหม่พร้อม) + มี safety timeout กันแถบค้าง
 *     (เช่น navigate ที่เปลี่ยนเฉพาะ query ซึ่ง pathname ไม่เปลี่ยน)
 *   - ใช้ usePathname อย่างเดียว ไม่ใช้ useSearchParams → ไม่ต้องมี Suspense, ไม่เกิด CSR bailout ตอน build
 */
export default function TopProgressBar() {
  const pathname = usePathname();
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // เริ่มแถบเมื่อผู้ใช้เริ่มเปลี่ยนหน้า (ดักคลิกลิงก์ระดับ document + back/forward)
  useEffect(() => {
    function isInternalNav(el: HTMLAnchorElement): boolean {
      if (!el.href) return false;
      const url = new URL(el.href, window.location.href);
      if (url.origin !== window.location.origin) return false; // ลิงก์นอกโดเมน
      if (el.target && el.target !== "_self") return false; // เปิดแท็บใหม่
      if (el.hasAttribute("download")) return false; // ดาวน์โหลดไฟล์
      // ปลายทางเดิม (แค่ hash หรือเหมือนเดิม) = ไม่ถือว่าเปลี่ยนหน้า
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return false;
      }
      return true;
    }

    function onClick(e: MouseEvent) {
      if (e.defaultPrevented) return;
      // เฉพาะคลิกซ้ายปกติ (ไม่ใช่เปิดแท็บใหม่ด้วย modifier)
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.("a");
      if (anchor && isInternalNav(anchor as HTMLAnchorElement)) start();
    }

    function onPopState() {
      start();
    }

    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function start() {
    if (doneTimer.current) clearTimeout(doneTimer.current);
    if (safetyTimer.current) clearTimeout(safetyTimer.current);
    setState("loading");
    // กันแถบค้างถ้าหน้าใหม่ไม่ทำให้ pathname เปลี่ยน (เช่นเปลี่ยนแค่ query)
    safetyTimer.current = setTimeout(() => setState("done"), 8000);
  }

  // pathname เปลี่ยน = หน้าใหม่ commit แล้ว → ปิดแถบ (เต็ม→fade)
  useEffect(() => {
    setState((prev) => (prev === "loading" ? "done" : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // หลังแถบเต็ม (done) ให้ fade แล้วรีเซ็ตกลับ idle
  useEffect(() => {
    if (state !== "done") return;
    if (safetyTimer.current) clearTimeout(safetyTimer.current);
    doneTimer.current = setTimeout(() => setState("idle"), 400);
    return () => {
      if (doneTimer.current) clearTimeout(doneTimer.current);
    };
  }, [state]);

  const cls =
    state === "loading" ? "nav-progress loading" : state === "done" ? "nav-progress done" : "nav-progress";

  return <div className={cls} role="presentation" aria-hidden="true" />;
}
