/**
 * auto-read.ts — orchestrator อ่านไฟล์ sale OA อัตโนมัติ แล้ว save ผลกลับ OneDrive
 *   ★ ทำงานเฉพาะเมื่อ env ACCT_AUTO_READ === 'on' (default ปิด — deploy แบบ dormant จนกว่าจะเทสต์ของจริง)
 *   ★ best-effort ทั้งหมด: ไม่ throw · ล้มเหลว → เงียบ (ไฟล์ยังอยู่ OneDrive/Supabase ให้นักบัญชีอ่านมือได้)
 *
 * flow (เฉพาะ path LINE — กระดาษที่เซลสแกนไม่ผ่านทางนี้):
 *   [ติดรหัส? → ดึงรหัสจากแชท → ลองปลด] → [gpt-5-mini จัดประเภท] → [อ่าน: digital→gpt-5-mini / scan→Sonnet5] → [save CSV → OneDrive]
 * ★ PDPA: ไม่ log รหัส/เนื้อไฟล์/ยอด
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyDocSource } from "@/lib/accounting/doc-source";
import { saveResultCsvToOneDrive } from "@/lib/accounting/onedrive-result";
import { isPdfEncrypted, readPdfPlainText, unlockPdfToText } from "@/lib/accounting/pdf-unlock";
import { extractPlatformReportFromFile, extractPlatformReportFromText } from "@/lib/accounting/platform-report-extract";
import { extractStatementFromFile, extractStatementFromText } from "@/lib/accounting/statement-extract";
import { classifyDocTypeFromImage, classifyDocTypeFromText } from "@/lib/ai/classify-doc";
import { decryptField } from "@/lib/crypto/field";
import { isOneDriveEnabled } from "@/lib/storage/onedrive";
import { resolveOneDriveFolder, type MirrorGroupContext } from "@/lib/line/onedrive-mirror";

const MAX_PASSWORD_CANDIDATES = 40;

/** ดึงข้อความล่าสุดในแชทกลุ่มนี้ (decrypt) → รวมเป็นรายการรหัสผู้สมัคร (ทั้งข้อความเต็ม + token) */
async function gatherChatPasswords(db: SupabaseClient, chatGroupId: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const v = s.trim();
    if (v && v.length <= 64 && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  try {
    const { data } = await db
      .from("chat_messages")
      .select("content_enc")
      .eq("chat_group_id", chatGroupId)
      .eq("message_type", "text")
      .order("sent_at", { ascending: false })
      .limit(15);
    for (const row of (data as { content_enc: string | null }[] | null) ?? []) {
      if (!row.content_enc || out.length >= MAX_PASSWORD_CANDIDATES) continue;
      let text = "";
      try {
        text = decryptField(row.content_enc);
      } catch {
        continue;
      }
      add(text); // ข้อความเต็ม (เผื่อรหัสคือทั้งข้อความ)
      for (const tok of text.split(/\s+/)) add(tok); // แต่ละ token (เผื่อ "รหัส 12345")
    }
  } catch {
    /* best-effort */
  }
  return out.slice(0, MAX_PASSWORD_CANDIDATES);
}

/** map StatementTxn/PlatformReportLine → rows/headers สำหรับ CSV */
function statementCsv(txns: Record<string, unknown>[]) {
  return {
    headers: [
      { key: "date", label: "วันที่" },
      { key: "description", label: "รายละเอียด" },
      { key: "counterparty_name", label: "คู่ค้า" },
      { key: "direction", label: "ทิศทาง(in/out)" },
      { key: "amount", label: "จำนวนเงิน" },
    ],
    rows: txns,
  };
}
function platformCsv(lines: Record<string, unknown>[]) {
  return {
    headers: [
      { key: "date", label: "วันที่" },
      { key: "order_no", label: "เลขคำสั่งซื้อ" },
      { key: "description", label: "รายละเอียด" },
      { key: "category", label: "หมวด" },
      { key: "direction", label: "ทิศทาง" },
      { key: "amount", label: "จำนวนเงิน" },
    ],
    rows: lines,
  };
}

/**
 * อ่านไฟล์ sale OA อัตโนมัติ + save ผลกลับ OneDrive — เรียกจาก attachments worker (best-effort)
 */
export async function autoReadSaleAttachment(params: {
  db: SupabaseClient;
  chatGroupId: string;
  group: MirrorGroupContext;
  month: string;
  fileName: string;
  mime: string;
  data: Buffer;
}): Promise<void> {
  try {
    if (process.env.ACCT_AUTO_READ !== "on") return; // gate: ปิดไว้จนกว่าจะเทสต์ของจริง
    const { group } = params;
    if (!group) return;
    if ((group.chat_channels?.oa_type || "") !== "sale") return;
    if (!isOneDriveEnabled()) return; // ต้องมี OneDrive ไว้เก็บผล

    const isPdf = (params.mime || "").toLowerCase().includes("pdf");

    // 1) ปลดรหัสถ้าติด (ดึงรหัสจากแชท) → ได้ text
    let unlockedText: string | null = null;
    if (isPdf && (await isPdfEncrypted(params.data))) {
      const pws = await gatherChatPasswords(params.db, params.chatGroupId);
      const unlocked = await unlockPdfToText(params.data, pws);
      if (!unlocked) return; // ปลดไม่ได้ → ข้าม (นักบัญชีอ่านมือ)
      unlockedText = unlocked.text;
    }

    // 2) จัดประเภทด้วย gpt-5-mini (statement/platform/other)
    const source = await classifyDocSource(params.mime, params.data);
    let docType: "statement" | "platform" | "other";
    if (unlockedText) {
      docType = await classifyDocTypeFromText(unlockedText);
    } else if (source === "digital_pdf") {
      const t = await readPdfPlainText(params.data);
      docType = t ? await classifyDocTypeFromText(t) : "other";
    } else if (source === "scan_or_image") {
      docType = await classifyDocTypeFromImage(params.data, params.mime);
    } else {
      return; // excel/csv ผ่าน path อื่น
    }
    if (docType === "other") return;

    // 3) อ่าน — ถ้าปลดรหัสได้ text แล้วใช้ text extractor · ไม่งั้นใช้ file extractor (self-route digital/scan)
    let result: { headers: { key: string; label: string }[]; rows: Record<string, unknown>[] };
    if (docType === "statement") {
      const txns = unlockedText
        ? await extractStatementFromText(unlockedText)
        : await extractStatementFromFile(params.data, params.mime);
      result = statementCsv(txns as unknown as Record<string, unknown>[]);
    } else {
      const lines = unlockedText
        ? await extractPlatformReportFromText(unlockedText)
        : await extractPlatformReportFromFile(params.data, params.mime);
      result = platformCsv(lines as unknown as Record<string, unknown>[]);
    }
    if (result.rows.length === 0) return;

    // 4) save ผลกลับ OneDrive โฟลเดอร์เดียวกับไฟล์ต้นฉบับ
    const folder = resolveOneDriveFolder(group);
    const base = params.fileName.replace(/\.[^.]+$/, "");
    await saveResultCsvToOneDrive({
      folderParts: [folder, params.month],
      fileName: `${base}-ผลอ่าน-${docType}.csv`,
      headers: result.headers,
      rows: result.rows,
    });
  } catch {
    console.warn("[auto-read] failed");
  }
}
