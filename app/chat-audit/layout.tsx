import TopProgressBar from "./_TopProgressBar";
import "./chat-audit.css";

/**
 * Layout ครอบทุกหน้า chat-audit
 *   - ไม่มี loading.tsx แล้ว → Next.js App Router จะคงหน้าเดิมไว้ระหว่าง navigate
 *     จนหน้าใหม่ (server component) พร้อม แล้วค่อยสลับ (ไม่มีจอเทาแว้บ)
 *   - แทนที่ skeleton ด้วยแถบโหลดบางๆ ด้านบน (subtle feedback)
 */
export default function ChatAuditLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopProgressBar />
      {children}
    </>
  );
}
