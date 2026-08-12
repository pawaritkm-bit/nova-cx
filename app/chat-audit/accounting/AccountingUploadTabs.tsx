"use client";

import { useState } from "react";
import StatementAnalyzer from "./StatementAnalyzer";
import PlatformReportAnalyzer from "./PlatformReportAnalyzer";
import type { ChartAccount } from "@/lib/accounting/chart-of-accounts";

/**
 * แท็บสวิตช์ระหว่าง "สเตทเมนต์ธนาคาร" กับ "รายงานแพลตฟอร์ม" (ข้อ C) — ใช้ลูกค้าที่เลือกไว้ร่วมกัน
 *   (ทั้งสองฟีเจอร์อ่านไฟล์แล้วแสดงผล on-the-fly เท่านั้น ไม่มี state ที่ต้องแชร์ข้ามแท็บ)
 *   ★ chart (ผังบัญชี) โหลดจาก page.tsx (server) — ใช้เฉพาะแท็บรายงานแพลตฟอร์ม (ตั้งค่า mapping บัญชี
 *   → auto-สร้างสมุดรายวันดราฟต์)
 */
export default function AccountingUploadTabs({
  customerId,
  customerLabel,
  chart,
}: {
  customerId: string;
  customerLabel: string;
  chart: ChartAccount[];
}) {
  const [tab, setTab] = useState<"statement" | "platform">("statement");

  return (
    <div>
      <div className="acc-subtabs">
        <button type="button" className={`acc-subtab${tab === "statement" ? " active" : ""}`} onClick={() => setTab("statement")}>
          สเตทเมนต์ธนาคาร
        </button>
        <button type="button" className={`acc-subtab${tab === "platform" ? " active" : ""}`} onClick={() => setTab("platform")}>
          รายงานแพลตฟอร์ม
        </button>
      </div>

      {/* ทั้งสองแท็บอยู่ใน DOM ตลอด (ซ่อนด้วย display:none) — สลับแท็บไปดูอีกฝั่งแล้วสลับกลับ
          ข้อมูลที่อ่าน/แก้ไว้จะไม่หาย (ยังไม่รีเฟรชหน้า) */}
      <div style={{ display: tab === "statement" ? undefined : "none" }}>
        <StatementAnalyzer customerId={customerId} customerLabel={customerLabel} />
      </div>
      <div style={{ display: tab === "platform" ? undefined : "none" }}>
        <PlatformReportAnalyzer customerId={customerId} customerLabel={customerLabel} chart={chart} />
      </div>
    </div>
  );
}
