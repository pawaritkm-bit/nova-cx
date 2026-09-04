"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * <details> ที่ปิดเองเมื่อคลิกนอกกรอบ — ★ 2026-09-04 ผู้ใช้: "กดตรงนอกกรอบให้เลื่อนขึ้นเลย
 * ไม่ต้องกดปุ่มเมนู" (เมนูเครื่องมือบัญชี/จัดการลูกค้า) — ใช้แทน <details> เดิมได้ตรง ๆ
 */
export default function AutoCloseDetails({
  className,
  name,
  children,
}: {
  className?: string;
  name?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const el = ref.current;
      if (el && el.open && !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return (
    <details className={className} name={name} ref={ref}>
      {children}
    </details>
  );
}
