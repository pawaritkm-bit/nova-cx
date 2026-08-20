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
import type { SupabaseClient } from "@supabase/supabase-js";
import { saveRawCsvToOneDrive, saveResultCsvToOneDrive } from "@/lib/accounting/onedrive-result";
import { unlockPdfToText } from "@/lib/accounting/pdf-unlock";
import { parseStatementDeterministic } from "@/lib/accounting/statement-deterministic";
import { buildStatementSummaryCsv } from "@/lib/accounting/statement-summary-csv";
import { extractStatementFromText } from "@/lib/accounting/statement-extract";
import { gatherChatPasswords } from "@/lib/accounting/classify-finance-doc";
import { NOTE_MARKER, parseLockedNote, buildWrongPasswordNote, lockedNoteFileName } from "@/lib/accounting/locked-note";
import { sanitizeDocName } from "@/lib/accounting/doc-naming";
import { CARE_ONEDRIVE_ROOT } from "@/lib/line/onedrive-mirror";

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

/**
 * หา chat_group_id จากชื่อโฟลเดอร์ลูกค้า (ท้ายชื่อมี "(xxxx)" = 4 ตัวท้ายของ group_ref/id)
 *   → ไว้ดึงรหัสจากแชทกลุ่มนั้น (ลูกค้ามักพิมพ์รหัสในแชท) · คลุมเครือ (เจอ >1) → null (กันข้ามกลุ่ม/PDPA)
 */
async function resolveGroupIdFromFolder(db: SupabaseClient, folderName: string): Promise<string | null> {
  const m = (folderName || "").match(/\(([^)]{2,12})\)\s*$/);
  const tail = m?.[1]?.trim();
  if (!tail) return null;
  try {
    const { data } = await db.from("chat_groups").select("id").ilike("group_ref", `%${tail}`).limit(2);
    const rows = (data as { id: string }[] | null) ?? [];
    return rows.length === 1 ? rows[0].id : null;
  } catch {
    return null;
  }
}

/**
 * อ่านไฟล์ติดรหัสซ้ำ — เรียกจาก cron
 *   @param db (optional) service client — มี = ลอง "รหัสจากแชทกลุ่ม" ด้วย (นอกจากรหัสในโน้ต)
 */
export async function retryLockedStatements(db?: SupabaseClient): Promise<RetryLockedResult> {
  if (!isOneDriveEnabled()) return { disabled: true, scanned: 0, read: 0, wrongPassword: 0, waiting: 0 };

  // ★ ไล่โฟลเดอร์ (ไม่ใช้ search — index ช้า) ทั้ง 2 ราก: NOVA-Bills (sale) + NOVA-Care (care)
  //   → [ลูกค้า/กลุ่ม] หาไฟล์โน้ตในโฟลเดอร์ตรง ๆ (และเผื่อโฟลเดอร์เดือนเก่า — ไล่ลงอีก 1 ชั้น)
  const ROOTS: (string | undefined)[] = [undefined, CARE_ONEDRIVE_ROOT]; // undefined = NOVA-Bills (default)
  const notes: { id: string; folderParts: string[]; root?: string; sourceFileName: string | null; passwords: string[] }[] = [];
  const collect = async (root: string | undefined, fp: string[], children: { id: string; name: string; isFolder: boolean }[]) => {
    for (const f of children) {
      if (f.isFolder || !f.name.includes(NOTE_MARKER)) continue;
      const content = await getOneDriveTextById(f.id);
      if (!content) continue;
      const { sourceFileName, passwords } = parseLockedNote(content);
      notes.push({ id: f.id, folderParts: fp, root, sourceFileName, passwords });
    }
  };
  outer: for (const root of ROOTS) {
    const customers = (await listOneDriveChildren([], root)).filter((c) => c.isFolder).slice(0, MAX_CUSTOMER_FOLDERS);
    for (const cust of customers) {
      const custChildren = await listOneDriveChildren([cust.name], root);
      await collect(root, [cust.name], custChildren); // โน้ตในโฟลเดอร์ตรง ๆ (โครงใหม่)
      if (notes.length >= MAX_NOTES_PER_RUN) break outer;
      for (const sub of custChildren.filter((c) => c.isFolder)) {
        await collect(root, [cust.name, sub.name], await listOneDriveChildren([cust.name, sub.name], root)); // โฟลเดอร์เดือนเก่า
        if (notes.length >= MAX_NOTES_PER_RUN) break outer;
      }
    }
  }
  notes.splice(MAX_NOTES_PER_RUN); // คุมเพดาน

  let read = 0, wrongPassword = 0, waiting = 0;

  for (const note of notes) {
    try {
      const { sourceFileName, passwords, folderParts, root } = note;
      if (!sourceFileName) continue;

      // ★ รวมรหัสจากแชทกลุ่ม (ลูกค้ามักพิมพ์รหัสในแชท) + รหัสในโน้ต (นักบัญชีพิมพ์)
      let chatPasswords: string[] = [];
      if (db) {
        const gid = await resolveGroupIdFromFolder(db, folderParts[0] ?? "");
        if (gid) chatPasswords = await gatherChatPasswords(db, gid);
      }
      const allPasswords = [...passwords, ...chatPasswords];
      if (allPasswords.length === 0) { waiting++; continue; } // ยังไม่มีรหัสทั้งในแชทและโน้ต

      const buf = await downloadOneDriveFile(folderParts, sourceFileName, root);
      if (!buf) continue;

      const unlocked = await unlockPdfToText(buf, allPasswords);
      if (!unlocked) {
        // ปลดไม่ได้: นักบัญชีพิมพ์รหัส (มีในโน้ต) แต่ผิด → เขียนทับโน้ตให้ลองใหม่
        //   ถ้ามีแต่รหัสจากแชท (โน้ตยังว่าง) → ยังถือว่า "รอนักบัญชี" (ไม่ spam โน้ตรหัสผิด)
        if (passwords.length > 0) {
          wrongPassword++;
          await saveRawCsvToOneDrive({ folderParts, fileName: lockedNoteFileName(sourceFileName.replace(/\.[^.]+$/, "")), csv: buildWrongPasswordNote(sourceFileName), root });
        } else {
          waiting++;
        }
        continue;
      }

      // อ่าน: deterministic ก่อน · ไม่ reconcile → AI
      const base = sourceFileName.replace(/\.[^.]+$/, "");
      const det = parseStatementDeterministic(unlocked.text);
      if (det.fullyReconciled) {
        const csv = buildStatementSummaryCsv(det.transactions, det.bank);
        const docBase = det.accountName ? sanitizeDocName(det.accountName) : base;
        await saveRawCsvToOneDrive({ folderParts, fileName: `${docBase} - สรุป.csv`, csv, root });
      } else {
        const txns = await extractStatementFromText(unlocked.text);
        if (txns.length === 0) continue; // อ่านไม่ได้จริง → คงโน้ตไว้ให้นักบัญชีจัดการเอง
        await saveResultCsvToOneDrive({
          folderParts,
          fileName: `${base}-ผลอ่าน-statement.csv`,
          headers: STATEMENT_HEADERS,
          rows: txns as unknown as Record<string, unknown>[],
          root,
        });
      }

      // ติด ✅ ที่ต้นฉบับ + ลบโน้ต
      if (!sourceFileName.startsWith(READ_MARK)) {
        await renameOneDriveFile({ folderParts, fileName: sourceFileName, newName: READ_MARK + sourceFileName, root });
      }
      await deleteOneDriveItemById(note.id);
      read++;
    } catch {
      // best-effort — ข้ามไฟล์นี้
    }
  }

  return { scanned: notes.length, read, wrongPassword, waiting };
}
