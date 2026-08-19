/**
 * retry-locked-read.ts — อ่านสเตทเมนต์ที่ "ติดรหัส" ซ้ำ หลังนักบัญชีพิมพ์รหัสในไฟล์โน้ต (OneDrive)
 *
 * flow (cron `retry-locked`, ทุก ~10 นาที):
 *   ค้นไฟล์โน้ต (ชื่อมี NOTE_MARKER) → แกะรหัส + ชื่อไฟล์ต้นฉบับ → โหลดต้นฉบับจาก OneDrive
 *   → ลองปลดด้วยรหัส → อ่าน (deterministic ก่อน, ไม่ได้ค่อย AI) → save สรุป → ติด ✅ → ลบโน้ต
 *   ★ ต้นฉบับอยู่ใน OneDrive แล้ว (อ่านซ้ำได้ ไม่ต้องพึ่ง LINE ที่หมดอายุ)
 *   ★ best-effort: ล้มเหลวรายไฟล์ไม่กระทบไฟล์อื่น · PDPA: ไม่ log รหัส/เนื้อไฟล์
 */
import {
  isOneDriveEnabled,
  listOneDriveChildren,
  downloadOneDriveFile,
  getOneDriveTextById,
  deleteOneDriveItemById,
  renameOneDriveFile,
} from "@/lib/storage/onedrive";
import { saveRawCsvToOneDrive, saveResultCsvToOneDrive } from "@/lib/accounting/onedrive-result";
import { unlockPdfToText } from "@/lib/accounting/pdf-unlock";
import { parseStatementDeterministic } from "@/lib/accounting/statement-deterministic";
import { buildStatementSummaryCsv } from "@/lib/accounting/statement-summary-csv";
import { extractStatementFromText } from "@/lib/accounting/statement-extract";
import { NOTE_MARKER, parseLockedNote, buildWrongPasswordNote, lockedNoteFileName } from "@/lib/accounting/locked-note";
import { sanitizeDocName } from "@/lib/accounting/doc-naming";

const READ_MARK = "✅ ";
const MAX_NOTES_PER_RUN = 20;
const MAX_CUSTOMER_FOLDERS = 400;

const STATEMENT_HEADERS = [
  { key: "date", label: "วันที่" },
  { key: "description", label: "รายละเอียด" },
  { key: "counterparty_name", label: "คู่ค้า" },
  { key: "direction", label: "ทิศทาง(in/out)" },
  { key: "amount", label: "จำนวนเงิน" },
];

export type RetryLockedResult = {
  disabled?: boolean;
  scanned: number;
  read: number;
  wrongPassword: number;
  waiting: number; // ยังไม่พิมพ์รหัส
};

/** อ่านไฟล์ติดรหัสซ้ำจากโน้ตที่นักบัญชีพิมพ์รหัส — เรียกจาก cron */
export async function retryLockedStatements(): Promise<RetryLockedResult> {
  if (!isOneDriveEnabled()) return { disabled: true, scanned: 0, read: 0, wrongPassword: 0, waiting: 0 };

  // ★ ไล่โฟลเดอร์ (ไม่ใช้ search — index ช้า): NOVA-Bills → [ลูกค้า] หาไฟล์โน้ตในโฟลเดอร์ลูกค้าตรง ๆ
  //   (และเผื่อโฟลเดอร์เดือนเก่าที่ยังเหลือ — ไล่ลงอีก 1 ชั้น เพื่อ backward-compat)
  const notes: { id: string; folderParts: string[]; sourceFileName: string | null; passwords: string[] }[] = [];
  const collect = async (fp: string[], children: { id: string; name: string; isFolder: boolean }[]) => {
    for (const f of children) {
      if (f.isFolder || !f.name.includes(NOTE_MARKER)) continue;
      const content = await getOneDriveTextById(f.id);
      if (!content) continue;
      const { sourceFileName, passwords } = parseLockedNote(content);
      notes.push({ id: f.id, folderParts: fp, sourceFileName, passwords });
    }
  };
  const customers = (await listOneDriveChildren([])).filter((c) => c.isFolder).slice(0, MAX_CUSTOMER_FOLDERS);
  outer: for (const cust of customers) {
    const custChildren = await listOneDriveChildren([cust.name]);
    await collect([cust.name], custChildren); // โน้ตในโฟลเดอร์ลูกค้าตรง ๆ (โครงใหม่)
    if (notes.length >= MAX_NOTES_PER_RUN) break;
    for (const sub of custChildren.filter((c) => c.isFolder)) {
      await collect([cust.name, sub.name], await listOneDriveChildren([cust.name, sub.name])); // โฟลเดอร์เดือนเก่า
      if (notes.length >= MAX_NOTES_PER_RUN) break outer;
    }
  }
  notes.splice(MAX_NOTES_PER_RUN); // คุมเพดาน

  let read = 0, wrongPassword = 0, waiting = 0;

  for (const note of notes) {
    try {
      const { sourceFileName, passwords, folderParts } = note;
      if (!sourceFileName) continue;
      if (passwords.length === 0) { waiting++; continue; } // ยังไม่พิมพ์รหัส

      const buf = await downloadOneDriveFile(folderParts, sourceFileName);
      if (!buf) continue;

      const unlocked = await unlockPdfToText(buf, passwords);
      if (!unlocked) {
        // รหัสไม่ถูก → เขียนทับโน้ตให้ลองใหม่ (ชื่อเดิม)
        wrongPassword++;
        await saveRawCsvToOneDrive({ folderParts, fileName: lockedNoteFileName(sourceFileName.replace(/\.[^.]+$/, "")), csv: buildWrongPasswordNote(sourceFileName) });
        continue;
      }

      // อ่าน: deterministic ก่อน · ไม่ reconcile → AI
      const base = sourceFileName.replace(/\.[^.]+$/, "");
      const det = parseStatementDeterministic(unlocked.text);
      if (det.fullyReconciled) {
        const csv = buildStatementSummaryCsv(det.transactions, det.bank);
        const docBase = det.accountName ? sanitizeDocName(det.accountName) : base;
        await saveRawCsvToOneDrive({ folderParts, fileName: `${docBase} - สรุป.csv`, csv });
      } else {
        const txns = await extractStatementFromText(unlocked.text);
        if (txns.length === 0) continue; // อ่านไม่ได้จริง → คงโน้ตไว้ให้นักบัญชีจัดการเอง
        await saveResultCsvToOneDrive({
          folderParts,
          fileName: `${base}-ผลอ่าน-statement.csv`,
          headers: STATEMENT_HEADERS,
          rows: txns as unknown as Record<string, unknown>[],
        });
      }

      // ติด ✅ ที่ต้นฉบับ + ลบโน้ต
      if (!sourceFileName.startsWith(READ_MARK)) {
        await renameOneDriveFile({ folderParts, fileName: sourceFileName, newName: READ_MARK + sourceFileName });
      }
      await deleteOneDriveItemById(note.id);
      read++;
    } catch {
      // best-effort — ข้ามไฟล์นี้
    }
  }

  return { scanned: notes.length, read, wrongPassword, waiting };
}
