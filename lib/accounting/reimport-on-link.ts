/**
 * reimport-on-link.ts — เมื่อ "ผูกกลุ่ม → ลูกค้า" ทีหลัง → ดึงสเตทเมนต์ย้อนหลังเข้ากระทบยอดอัตโนมัติ
 *
 * บริบท: auto-read (A→B) ทำงานตอนสเตทเมนต์ "เข้าครั้งเดียว" + มาร์กอ่านแล้ว → ถ้าตอนนั้นกลุ่มยังไม่ผูก
 *   ลูกค้า จะข้าม (customer_id null) และไม่ retrigger ตอนผูกทีหลัง → สเตทเมนต์เก่าไม่เข้ากระทบยอด
 *   ฟังก์ชันนี้ = "re-import" สเตทเมนต์ที่เก็บไว้แล้วของกลุ่มนั้น เข้า bank_statement_lines
 *
 * ★ deterministic parse (ฟรี ไม่พึ่ง AI) · reconcile ไม่ผ่าน = ข้าม (กันตัวเลขเพี้ยน)
 * ★ dedup ด้วย file_name ใน autoImportReconciledStatement → รันซ้ำปลอดภัย
 * ★ best-effort + bounded (cap ไฟล์) — ไม่ให้ block การผูกลูกค้านานเกินไป
 * ★ บิล (ไฟล์/รูป) ไม่ต้องทำที่นี่ — ค้างในคิว worker อยู่แล้ว → cron ดึงเองหลังผูก
 * ★ PDPA: ไม่ log เนื้อ/ยอด
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractPdfLayoutText } from "@/lib/accounting/pdf-text";
import { parseStatementDeterministic } from "@/lib/accounting/statement-deterministic";
import { autoImportReconciledStatement } from "@/lib/accounting/bank-reconciliation";

const BILLS_BUCKET = "bills";
/** เพดานไฟล์ที่ลอง re-import ต่อการผูก 1 ครั้ง (กัน block นาน — กลุ่มทั่วไปมีสเตทเมนต์ไม่กี่ใบ) */
const MAX_FILES = 15;

/**
 * ดึงสเตทเมนต์ย้อนหลังของกลุ่มเข้ากระทบยอด หลังผูกลูกค้า — คืนจำนวนที่ import สำเร็จ
 *   best-effort: error ใด ๆ ไม่ throw (ไม่ให้พังการผูก)
 */
export async function reimportGroupStatementsOnLink(
  db: SupabaseClient,
  params: { tenantId: string; customerId: string; chatGroupId: string }
): Promise<{ imported: number; scanned: number }> {
  const { tenantId, customerId, chatGroupId } = params;
  let imported = 0;
  let scanned = 0;
  try {
    // 1) ข้อความของกลุ่ม → attachment (PDF, stored)
    const { data: msgs } = await db
      .from("chat_messages")
      .select("id")
      .eq("chat_group_id", chatGroupId)
      // ★ เรียงใหม่→เก่า: กลุ่ม active > 1000 ข้อความ (PostgREST cap) → ให้ได้ "สเตทเมนต์ล่าสุด" ก่อน (ไม่ใช่เก่าสุด)
      .order("created_at", { ascending: false })
      .limit(3000);
    const msgIds = ((msgs ?? []) as { id: string }[]).map((m) => m.id);
    if (msgIds.length === 0) return { imported: 0, scanned: 0 };

    const pdfs: string[] = [];
    for (let i = 0; i < msgIds.length && pdfs.length < MAX_FILES; i += 200) {
      const { data: atts } = await db
        .from("message_attachments")
        .select("drive_file_id")
        .in("chat_message_id", msgIds.slice(i, i + 200))
        .eq("fetch_status", "stored")
        .not("drive_file_id", "is", null);
      for (const a of ((atts ?? []) as { drive_file_id: string | null }[])) {
        const p = a.drive_file_id;
        // ★ จับทั้ง ".pdf" และ "_pdf" (naming เก่า) — ไม่งั้นสเตทเมนต์ PDF เก่าถูกข้าม
        if (p && /[._]pdf$/.test(p.toLowerCase())) pdfs.push(p);
        if (pdfs.length >= MAX_FILES) break;
      }
    }

    // 2) แต่ละ PDF → parse deterministic → ถ้า reconcile ผ่าน = สเตทเมนต์ → import
    for (const objectPath of pdfs) {
      scanned++;
      try {
        const { data: blob, error } = await db.storage.from(BILLS_BUCKET).download(objectPath);
        if (error || !blob) continue;
        const buf = Buffer.from(await blob.arrayBuffer());
        const text = await extractPdfLayoutText(buf);
        const det = parseStatementDeterministic(text);
        if (!det.fullyReconciled || det.transactions.length === 0) continue; // ไม่ใช่สเตทเมนต์/reconcile ไม่ผ่าน
        const res = await autoImportReconciledStatement(db, {
          tenantId,
          customerId,
          bank: det.bank,
          accountName: det.accountName,
          transactions: det.transactions,
          sourceFileName: objectPath,
        });
        if (res.imported) imported++;
      } catch {
        /* best-effort ต่อไฟล์ */
      }
    }
  } catch {
    console.warn("[reimport-on-link] failed");
  }
  return { imported, scanned };
}
