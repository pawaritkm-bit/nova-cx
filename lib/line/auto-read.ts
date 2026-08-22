/**
 * auto-read.ts — orchestrator อ่านไฟล์ sale/care OA อัตโนมัติ แล้ว save ผลกลับ OneDrive
 *   ★ ทำงานเฉพาะเมื่อ env ACCT_AUTO_READ === 'on' (default ปิด — deploy แบบ dormant จนกว่าจะเทสต์ของจริง)
 *   ★ best-effort ทั้งหมด: ไม่ throw · ล้มเหลว → เงียบ (ไฟล์ยังอยู่ OneDrive/Supabase ให้นักบัญชีอ่านมือได้)
 *
 * flow:
 *   [extractAndClassify → type + text/det/platform] → วางไฟล์ในโฟลเดอร์ย่อยตามชนิด (attachments ทำแล้ว)
 *   → summarize: สเตทเมนต์/แพลตฟอร์ม deterministic ก่อน · ไม่ได้ค่อย AI → save CSV → ติด ✅
 *   ★ classification ส่งมาจาก attachments worker (จัดประเภทครั้งเดียว) — ถ้าไม่ส่งมาจะจัดเอง
 * ★ PDPA: ไม่ log รหัส/เนื้อไฟล์/ยอด
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { saveRawCsvToOneDrive, saveResultCsvToOneDrive } from "@/lib/accounting/onedrive-result";
import { extractPlatformReportFromFile, extractPlatformReportFromText, extractPlatformReportFromTextChunks } from "@/lib/accounting/platform-report-extract";
import { extractStatementFromFile, extractStatementFromText, extractStatementFromTextChunks } from "@/lib/accounting/statement-extract";
import { buildStatementSummaryCsv } from "@/lib/accounting/statement-summary-csv";
import { autoImportReconciledStatement } from "@/lib/accounting/bank-reconciliation";
import { buildPlatformSummaryCsv } from "@/lib/accounting/platform/parse";
import { lockedNoteFileName, buildLockedNoteContent } from "@/lib/accounting/locked-note";
import { sanitizeDocName, shopNameFromFilename } from "@/lib/accounting/doc-naming";
import { extractAndClassify, type FinanceClassification } from "@/lib/accounting/classify-finance-doc";
import { gatherRecentChatText, interpretDocPurpose } from "@/lib/accounting/doc-purpose";
import { isOneDriveEnabled, renameOneDriveFile } from "@/lib/storage/onedrive";
import { resolveSaleFolder, oaOneDriveRoot, type MirrorGroupContext } from "@/lib/line/onedrive-mirror";

/** เครื่องหมาย "อ่านแล้ว" นำหน้าชื่อไฟล์ต้นฉบับใน OneDrive (ให้นักบัญชีเห็นทันทีว่าระบบอ่านแล้ว) */
const READ_MARK = "✅ ";

/** ติด ✅ ที่ไฟล์ต้นฉบับใน OneDrive = "อ่านแล้ว" (best-effort · กันติดซ้ำ) */
async function markSourceRead(folderParts: string[], fileName: string, root?: string): Promise<void> {
  if (!fileName || fileName.startsWith(READ_MARK)) return;
  try {
    await renameOneDriveFile({ folderParts, fileName, newName: READ_MARK + fileName, root });
  } catch {
    /* best-effort — ผลอ่านถูก save แล้ว การติดธงพลาดไม่ใช่เรื่องคอขาดบาดตาย */
  }
}

/** map StatementTxn → headers/rows สำหรับ CSV (ผลอ่านด้วย AI) */
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
 * อ่านไฟล์ sale/care OA อัตโนมัติ + save ผลกลับ OneDrive — เรียกจาก attachments worker (best-effort)
 *   ★ ไฟล์ต้นฉบับถูกวางในโฟลเดอร์ย่อย [ลูกค้า, ชนิด] โดย attachments worker แล้ว — ที่นี่ summarize ในโฟลเดอร์เดียวกัน
 */
export async function autoReadSaleAttachment(params: {
  db: SupabaseClient;
  chatGroupId: string;
  group: MirrorGroupContext;
  month: string;
  fileName: string;
  /** ชื่อไฟล์เดิมจากลูกค้า (มีชื่อร้าน/ไทย) — ใช้ตั้งชื่อเอกสารรายงานแพลตฟอร์ม */
  originalName?: string | null;
  mime: string;
  data: Buffer;
  /** ผลจัดประเภทที่ attachments worker ทำไว้แล้ว (จัดครั้งเดียว) — ไม่ส่งมา = จัดเอง */
  classification?: FinanceClassification;
}): Promise<void> {
  try {
    if (process.env.ACCT_AUTO_READ !== "on") return; // gate: ปิดไว้จนกว่าจะเทสต์ของจริง
    const { group } = params;
    if (!group) return;
    const oaType = group.chat_channels?.oa_type || "";
    if (oaType !== "sale" && oaType !== "care") return; // อ่านให้ทั้ง sale + care
    if (!isOneDriveEnabled()) return; // ต้องมี OneDrive ไว้เก็บผล
    const root = oaOneDriveRoot(oaType); // sale → NOVA-Bills · care → NOVA-Care

    // จัดประเภท (reuse จาก attachments ถ้าส่งมา) → รู้ชนิด + text/det/platform + โฟลเดอร์ย่อย
    const cls =
      params.classification ??
      (await extractAndClassify({
        db: params.db,
        chatGroupId: params.chatGroupId,
        fileName: params.fileName,
        originalName: params.originalName,
        mime: params.mime,
        data: params.data,
      }));

    const folder = await resolveSaleFolder(group, root);
    const base = params.fileName.replace(/\.[^.]+$/, "");
    // เก็บผลในโฟลเดอร์ย่อยตามชนิด (ตรงกับที่ไฟล์ต้นฉบับถูกวางไว้)
    const folderParts = [folder, cls.subFolder];

    // ติดรหัสปลดไม่ได้ → วางโน้ตให้นักบัญชีพิมพ์รหัส → cron retry-locked อ่านให้ภายหลัง
    if (cls.locked) {
      await saveRawCsvToOneDrive({
        folderParts,
        fileName: lockedNoteFileName(base),
        csv: buildLockedNoteContent(params.fileName),
        root,
      });
      return;
    }

    // ★ ให้ AI ตีความ "จุดประสงค์ที่ลูกค้าส่งเอกสาร" จากบริบทแชท → เติมเป็นบรรทัดบนสุดของไฟล์สรุป (best-effort)
    const purposePrefix = async (docType: "statement" | "platform"): Promise<string> => {
      try {
        const chatText = await gatherRecentChatText(params.db, params.chatGroupId);
        const p = await interpretDocPurpose({ chatText, docType, docName: params.originalName || params.fileName });
        return p ? `จุดประสงค์ที่ลูกค้าส่ง: ${p}\r\n\r\n` : "";
      } catch {
        return "";
      }
    };

    // 1) สเตทเมนต์ deterministic (reconcile ผ่าน) → สรุปฟรี/เร็ว ไม่ต้องพึ่ง AI
    if (cls.det?.fullyReconciled) {
      const csv = (await purposePrefix("statement")) + buildStatementSummaryCsv(cls.det.transactions, cls.det.bank, cls.det.printedTotals);
      const docBase = cls.det.accountName ? sanitizeDocName(cls.det.accountName) : base;
      await saveRawCsvToOneDrive({ folderParts, fileName: `${docBase} - สรุป.csv`, csv, root });
      // ★ care OA เท่านั้น (กลุ่มผูกลูกค้าแล้ว): auto-feed เข้าหน้ากระทบยอดธนาคาร (ไม่ต้องอัป CSV ซ้ำ)
      if (oaType === "care") {
        try {
          const { data: g } = await params.db
            .from("chat_groups")
            .select("tenant_id, customer_id")
            .eq("id", params.chatGroupId)
            .maybeSingle();
          const tId = (g as { tenant_id?: string | null } | null)?.tenant_id ?? null;
          const cId = (g as { customer_id?: string | null } | null)?.customer_id ?? null;
          if (tId && cId) {
            await autoImportReconciledStatement(params.db, {
              tenantId: tId,
              customerId: cId,
              bank: cls.det.bank,
              transactions: cls.det.transactions,
              sourceFileName: params.originalName || params.fileName,
            });
          }
        } catch {
          console.warn("[auto-read] auto-reconcile feed failed");
        }
      }
      await markSourceRead(folderParts, params.fileName, root);
      return;
    }

    // 2) รายงานแพลตฟอร์ม deterministic (Excel/CSV) → 4 ตัวเลข + รายเดือน ตรง NOVA Sales
    if (cls.platform && (cls.platform.figures.grossSales > 0 || cls.platform.figures.platformFee > 0)) {
      const shop = shopNameFromFilename(params.originalName);
      const platBase = shop ? sanitizeDocName(shop) : base;
      const csv = (await purposePrefix("platform")) + buildPlatformSummaryCsv(cls.platform);
      await saveRawCsvToOneDrive({ folderParts, fileName: `${platBase} - ยอดขาย.csv`, csv, root });
      await markSourceRead(folderParts, params.fileName, root);
      return;
    }

    // 3) ไม่ใช่สเตทเมนต์/แพลตฟอร์มที่โค้ดอ่านได้ → อ่านด้วย AI ตามชนิดที่จัดไว้
    if (cls.type === "other") return; // บิลอื่นๆ — เก็บไฟล์อย่างเดียว ไม่สรุป

    if (cls.type === "statement") {
      const txns = cls.chunks
        ? (await extractStatementFromTextChunks(cls.chunks)).txns
        : cls.text
          ? await extractStatementFromText(cls.text)
          : await extractStatementFromFile(params.data, params.mime);
      const result = statementCsv(txns as unknown as Record<string, unknown>[]);
      if (result.rows.length === 0) return;
      await saveResultCsvToOneDrive({ folderParts, fileName: `${base}-ผลอ่าน-statement.csv`, headers: result.headers, rows: result.rows, root });
      await markSourceRead(folderParts, params.fileName, root);
      return;
    }

    // platform report (Shopee/Lazada/TikTok — มักเป็น Excel)
    const lines = cls.chunks
      ? (await extractPlatformReportFromTextChunks(cls.chunks)).lines
      : cls.text
        ? await extractPlatformReportFromText(cls.text)
        : await extractPlatformReportFromFile(params.data, params.mime);
    const result = platformCsv(lines as unknown as Record<string, unknown>[]);
    if (result.rows.length === 0) return;
    const shop = shopNameFromFilename(params.originalName);
    const platBase = shop ? sanitizeDocName(shop) : base;
    await saveResultCsvToOneDrive({ folderParts, fileName: `${platBase} - ยอดขาย.csv`, headers: result.headers, rows: result.rows, root });
    await markSourceRead(folderParts, params.fileName, root);
  } catch {
    console.warn("[auto-read] failed");
  }
}
