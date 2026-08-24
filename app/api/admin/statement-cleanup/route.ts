/**
 * /api/admin/statement-cleanup — งานครั้งเดียว: รวมไฟล์สรุปสเตทเมนต์เก่า (CSV หลายไฟล์) →
 *   Excel รวมไฟล์เดียวแยกชีตตามธนาคาร แล้วลบไฟล์เก่าทิ้ง
 *
 * โหมด (query ?mode=):
 *   - dryrun (default) : เดินโฟลเดอร์ OneDrive รายงานตัวเลข — ★ ไม่เขียน/ไม่ลบอะไร
 *   - execute          : parse CSV เก่า → รีเจน Excel รวม (merge เข้ากองเดิม) → ลบ "เฉพาะ" ไฟล์สรุปเก่าที่ parse สำเร็จ
 *
 * ความปลอดภัย:
 *   - auth ด้วย CRON_SECRET (fail-closed) เหมือน cron อื่น
 *   - ลบเฉพาะไฟล์ที่ classifyOldSummaryFile ระบุว่าเป็น "สรุปเก่า" และ parse ได้ ≥1 รายการ (ไฟล์ต้นฉบับ/ไฟล์อื่นไม่แตะ)
 *   - ?limit= จำกัดจำนวนลูกค้า/รอบ (กัน timeout) · ?root=sale|care|both
 */
import { NextResponse, type NextRequest } from "next/server";
import { isValidCronAuth } from "@/lib/http";
import {
  isOneDriveEnabled,
  listOneDriveChildren,
  downloadOneDriveFile,
  uploadOneDriveFile,
  deleteOneDriveItemById,
} from "@/lib/storage/onedrive";
import { oaOneDriveRoot } from "@/lib/line/onedrive-mirror";
import {
  albumStoreName,
  albumXlsxName,
  mergeIntoBank,
  parseAlbumStore,
  serializeAlbumStore,
  UNKNOWN_BANK,
  type AlbumStore,
} from "@/lib/accounting/statement-album";
import { buildStatementAlbumWorkbook } from "@/lib/accounting/statement-album-excel";
import { classifyOldSummaryFile, parseOldSummary } from "@/lib/accounting/statement-cleanup";
import { normalizeBankName } from "@/lib/accounting/statement-extract";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STMT_SUBFOLDER = "สเตทเมนต์";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type PerCustomer = {
  customer: string;
  root: string;
  oldFiles: { det: number; image: number; albumV1: number };
  filesWithBank: number;
  // execute เท่านั้น
  rebuilt?: boolean;
  txnsMerged?: number;
  deleted?: number;
  kept?: number;
};

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "disabled", reason: "CRON_SECRET not configured" }, { status: 503 });
  if (!isValidCronAuth(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isOneDriveEnabled()) return NextResponse.json({ error: "onedrive_disabled" }, { status: 503 });

  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") === "execute" ? "execute" : "dryrun";
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 500);
  const rootParam = url.searchParams.get("root") || "both";
  const roots: string[] = [];
  if (rootParam === "sale" || rootParam === "both") roots.push(oaOneDriveRoot("sale"));
  if (rootParam === "care" || rootParam === "both") roots.push(oaOneDriveRoot("care"));

  const perCustomer: PerCustomer[] = [];
  let customersScanned = 0;
  let foldersWithOld = 0;
  let truncated = false;

  for (const root of roots) {
    let customers: { id: string; name: string; isFolder: boolean }[] = [];
    try {
      customers = (await listOneDriveChildren([], root)).filter((c) => c.isFolder);
    } catch {
      continue;
    }
    for (const cust of customers) {
      if (customersScanned >= limit) { truncated = true; break; }
      customersScanned++;
      let files: { id: string; name: string; isFolder: boolean }[] = [];
      try {
        files = (await listOneDriveChildren([cust.name, STMT_SUBFOLDER], root)).filter((f) => !f.isFolder);
      } catch {
        continue; // ไม่มีโฟลเดอร์สเตทเมนต์ / อ่านไม่ได้
      }
      const olds = files
        .map((f) => ({ f, kind: classifyOldSummaryFile(f.name) }))
        .filter((x): x is { f: typeof files[number]; kind: NonNullable<ReturnType<typeof classifyOldSummaryFile>> } => x.kind !== null);
      if (olds.length === 0) continue;
      foldersWithOld++;

      const rec: PerCustomer = {
        customer: cust.name,
        root,
        oldFiles: { det: 0, image: 0, albumV1: 0 },
        filesWithBank: 0,
      };
      for (const o of olds) rec.oldFiles[o.kind]++;

      if (mode === "dryrun") {
        // นับว่าไฟล์ไหน "น่าจะมีแบงก์" (det = มีคอลัมน์ธนาคาร) โดยไม่ต้องดาวน์โหลด
        rec.filesWithBank = rec.oldFiles.det;
        perCustomer.push(rec);
        continue;
      }

      // ===== execute =====
      const folderParts = [cust.name, STMT_SUBFOLDER];
      const albumParts = [...folderParts, "_album"];
      // เริ่มจากกองเดิม (ถ้ามี — กันทับข้อมูลที่เข้ามาหลังฟีเจอร์ album)
      let store: AlbumStore = parseAlbumStore(await downloadOneDriveFile(albumParts, albumStoreName, root).catch(() => null));
      let merged = 0;
      let withBank = 0;
      const parsedOk: { id: string; name: string }[] = [];
      for (const o of olds) {
        try {
          const buf = await downloadOneDriveFile(folderParts, o.f.name, root);
          if (!buf) continue;
          const { bank, txns } = parseOldSummary(o.kind, buf.toString("utf8"));
          if (txns.length === 0) continue; // parse ไม่ได้/ว่าง → เก็บไฟล์ไว้ (ไม่ลบ)
          const label = normalizeBankName(bank) ?? UNKNOWN_BANK;
          if (label !== UNKNOWN_BANK) withBank++;
          const r = mergeIntoBank(store, label, txns);
          store = r.store;
          merged += r.added;
          parsedOk.push({ id: o.f.id, name: o.f.name });
        } catch {
          /* ไฟล์นี้พลาด → เก็บไว้ ไม่ลบ */
        }
      }

      if (parsedOk.length === 0) { perCustomer.push(rec); continue; }

      // เขียนกอง + Excel รวมใหม่
      try {
        await uploadOneDriveFile({ folderParts: albumParts, fileName: albumStoreName, mime: "application/json", data: serializeAlbumStore(store), root });
        const wb = await buildStatementAlbumWorkbook({ customerName: cust.name, banks: store.banks });
        await uploadOneDriveFile({ folderParts, fileName: albumXlsxName(cust.name), mime: XLSX_MIME, data: wb, root });
      } catch {
        // เขียนไฟล์รวมไม่สำเร็จ → อย่าลบไฟล์เก่า (กันข้อมูลหาย)
        rec.filesWithBank = withBank;
        rec.rebuilt = false;
        rec.kept = olds.length;
        perCustomer.push(rec);
        continue;
      }

      // ลบเฉพาะไฟล์เก่าที่ parse สำเร็จ (รวมเข้า Excel แล้ว)
      let deleted = 0;
      for (const p of parsedOk) {
        try { if (await deleteOneDriveItemById(p.id)) deleted++; } catch { /* ลบพลาด = เก็บไว้ ไม่เป็นไร */ }
      }
      rec.filesWithBank = withBank;
      rec.rebuilt = true;
      rec.txnsMerged = merged;
      rec.deleted = deleted;
      rec.kept = olds.length - parsedOk.length;
      perCustomer.push(rec);
    }
    if (truncated) break;
  }

  const totals = perCustomer.reduce(
    (a, c) => ({
      det: a.det + c.oldFiles.det,
      image: a.image + c.oldFiles.image,
      albumV1: a.albumV1 + c.oldFiles.albumV1,
      withBank: a.withBank + c.filesWithBank,
      deleted: a.deleted + (c.deleted ?? 0),
      rebuilt: a.rebuilt + (c.rebuilt ? 1 : 0),
      txnsMerged: a.txnsMerged + (c.txnsMerged ?? 0),
    }),
    { det: 0, image: 0, albumV1: 0, withBank: 0, deleted: 0, rebuilt: 0, txnsMerged: 0 },
  );

  return NextResponse.json({
    ok: true,
    mode,
    roots,
    customersScanned,
    foldersWithOldFiles: foldersWithOld,
    truncated,
    totals,
    perCustomer,
  });
}

export const GET = handle;
export const POST = handle;
