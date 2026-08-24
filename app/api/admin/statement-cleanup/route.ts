/**
 * /api/admin/statement-cleanup — งานครั้งเดียว: รวม/ทำความสะอาดไฟล์สรุปสเตทเมนต์
 *
 * โหมด (query ?mode=):
 *   - dryrun (default) : เดินโฟลเดอร์ OneDrive รายงานตัวเลข — ★ ไม่เขียน/ไม่ลบอะไร
 *   - execute          : parse CSV สรุปเก่า + absorb กองเก่า (_album JSON) → รีเจน Excel รวม (ฝังข้อมูลในชีตซ่อน)
 *                        → ลบไฟล์ CSV เก่าที่ parse สำเร็จ + ลบโฟลเดอร์ _album (ไม่ใช้ sidecar อีก)
 *
 * ความปลอดภัย: auth CRON_SECRET (fail-closed) · ลบเฉพาะ CSV สรุปเก่า (parse ได้) + โฟลเดอร์ _album เท่านั้น
 *   ไฟล์ต้นฉบับ/วิเคราะห์รายรับ/ยอดขาย/ไฟล์รวมใหม่ ไม่แตะ · ?limit= จำกัดลูกค้า/รอบ · ?root=sale|care|both
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
  type AlbumStore,
} from "@/lib/accounting/statement-album";
import { buildStatementAlbumWorkbook, readAlbumFromWorkbook } from "@/lib/accounting/statement-album-excel";
import { classifyOldSummaryFile, parseOldSummary } from "@/lib/accounting/statement-cleanup";
import { normalizeBankName } from "@/lib/accounting/statement-extract";
import { UNKNOWN_BANK } from "@/lib/accounting/statement-album";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STMT_SUBFOLDER = "สเตทเมนต์";
const ALBUM_SUBFOLDER = "_album";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type PerCustomer = {
  customer: string;
  root: string;
  oldCsv: { det: number; image: number; albumV1: number };
  hasAlbumFolder: boolean;
  rebuilt?: boolean;
  txnsMerged?: number;
  csvDeleted?: number;
  albumFolderDeleted?: boolean;
  kept?: number;
  banksInspect?: Record<string, number>;
};

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "disabled", reason: "CRON_SECRET not configured" }, { status: 503 });
  if (!isValidCronAuth(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isOneDriveEnabled()) return NextResponse.json({ error: "onedrive_disabled" }, { status: 503 });

  const url = new URL(request.url);
  const modeParam = url.searchParams.get("mode");
  const mode =
    modeParam === "execute" ? "execute" : modeParam === "inspect" ? "inspect" : modeParam === "rebuild" ? "rebuild" : modeParam === "purge-empty" ? "purge-empty" : "dryrun";
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 500);
  const rootParam = url.searchParams.get("root") || "both";
  const roots: string[] = [];
  if (rootParam === "sale" || rootParam === "both") roots.push(oaOneDriveRoot("sale"));
  if (rootParam === "care" || rootParam === "both") roots.push(oaOneDriveRoot("care"));

  const perCustomer: PerCustomer[] = [];
  let customersScanned = 0;
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
      let entries: { id: string; name: string; isFolder: boolean }[] = [];
      try {
        entries = await listOneDriveChildren([cust.name, STMT_SUBFOLDER], root);
      } catch {
        continue; // ไม่มีโฟลเดอร์สเตทเมนต์
      }
      const files = entries.filter((f) => !f.isFolder);

      // ===== inspect: อ่านไฟล์รวม (ชีตซ่อน _data) รายงานจำนวน txns ต่อแบงก์ — read-only =====
      if (mode === "inspect") {
        const hasXlsx = files.some((f) => f.name === albumXlsxName(cust.name));
        if (!hasXlsx) continue;
        const store = await readAlbumFromWorkbook(await downloadOneDriveFile([cust.name, STMT_SUBFOLDER], albumXlsxName(cust.name), root).catch(() => null));
        const banks = Object.fromEntries(Object.entries(store.banks).map(([b, t]) => [b, t.length]));
        const total = Object.values(store.banks).reduce((a, t) => a + t.length, 0);
        perCustomer.push({ customer: cust.name, root, oldCsv: { det: 0, image: 0, albumV1: 0 }, hasAlbumFolder: false, txnsMerged: total, banksInspect: banks });
        continue;
      }

      // ===== purge-empty: ลบไฟล์สรุปที่ว่างเปล่า (0 รายการใน _data) — เช่น กลุ่มทดสอบ · ไม่แตะต้นฉบับ =====
      if (mode === "purge-empty") {
        const fileName = albumXlsxName(cust.name);
        const file = files.find((f) => f.name === fileName);
        if (!file) continue;
        const store = await readAlbumFromWorkbook(await downloadOneDriveFile([cust.name, STMT_SUBFOLDER], fileName, root).catch(() => null));
        const total = Object.values(store.banks).reduce((a, t) => a + t.length, 0);
        if (total > 0) continue; // มีข้อมูล → ไม่ลบ
        let deleted = false;
        try { deleted = await deleteOneDriveItemById(file.id); } catch { /* keep */ }
        perCustomer.push({ customer: cust.name, root, oldCsv: { det: 0, image: 0, albumV1: 0 }, hasAlbumFolder: false, rebuilt: false, txnsMerged: 0, csvDeleted: deleted ? 1 : 0 });
        continue;
      }

      // ===== rebuild: regen ไฟล์รวมเดิมเป็นฟอร์แมตใหม่ (อ่าน _data → build ใหม่ → เขียนทับ) — ไม่ลบอะไร =====
      if (mode === "rebuild") {
        const fileName = albumXlsxName(cust.name);
        if (!files.some((f) => f.name === fileName)) continue;
        const store = await readAlbumFromWorkbook(await downloadOneDriveFile([cust.name, STMT_SUBFOLDER], fileName, root).catch(() => null));
        const total = Object.values(store.banks).reduce((a, t) => a + t.length, 0);
        if (total === 0) { perCustomer.push({ customer: cust.name, root, oldCsv: { det: 0, image: 0, albumV1: 0 }, hasAlbumFolder: false, rebuilt: false, txnsMerged: 0 }); continue; }
        try {
          const wb = await buildStatementAlbumWorkbook({ customerName: cust.name, banks: store.banks });
          await uploadOneDriveFile({ folderParts: [cust.name, STMT_SUBFOLDER], fileName, mime: XLSX_MIME, data: wb, root });
          perCustomer.push({ customer: cust.name, root, oldCsv: { det: 0, image: 0, albumV1: 0 }, hasAlbumFolder: false, rebuilt: true, txnsMerged: total });
        } catch {
          perCustomer.push({ customer: cust.name, root, oldCsv: { det: 0, image: 0, albumV1: 0 }, hasAlbumFolder: false, rebuilt: false, txnsMerged: total });
        }
        continue;
      }

      const albumFolder = entries.find((f) => f.isFolder && f.name === ALBUM_SUBFOLDER) ?? null;
      const oldCsvFiles = files
        .map((f) => ({ f, kind: classifyOldSummaryFile(f.name) }))
        .filter((x): x is { f: typeof files[number]; kind: NonNullable<ReturnType<typeof classifyOldSummaryFile>> } => x.kind !== null);

      if (oldCsvFiles.length === 0 && !albumFolder) continue; // ไม่มีอะไรต้องทำ

      const rec: PerCustomer = {
        customer: cust.name,
        root,
        oldCsv: { det: 0, image: 0, albumV1: 0 },
        hasAlbumFolder: !!albumFolder,
      };
      for (const o of oldCsvFiles) rec.oldCsv[o.kind]++;

      if (mode === "dryrun") { perCustomer.push(rec); continue; }

      // ===== execute =====
      const folderParts = [cust.name, STMT_SUBFOLDER];
      const fileName = albumXlsxName(cust.name);
      // 1) เริ่มจากกองในไฟล์ Excel เดิม (ชีตซ่อน _data)
      let store: AlbumStore = await readAlbumFromWorkbook(await downloadOneDriveFile(folderParts, fileName, root).catch(() => null));
      let merged = 0;
      // 2) absorb กองเก่าจาก sidecar JSON (_album/statement-banks.json) ถ้ามี
      if (albumFolder) {
        try {
          const legacy = await downloadOneDriveFile([...folderParts, ALBUM_SUBFOLDER], albumStoreName, root);
          if (legacy) {
            const lj = parseAlbumStore(legacy);
            for (const [bank, txns] of Object.entries(lj.banks)) {
              const r = mergeIntoBank(store, bank, txns);
              store = r.store;
              merged += r.added;
            }
          }
        } catch { /* อ่าน legacy พลาด → ข้าม */ }
      }
      // 3) parse CSV สรุปเก่า (ถ้ายังเหลือ)
      const parsedOk: { id: string }[] = [];
      for (const o of oldCsvFiles) {
        try {
          const buf = await downloadOneDriveFile(folderParts, o.f.name, root);
          if (!buf) continue;
          const { bank, txns } = parseOldSummary(o.kind, buf.toString("utf8"));
          if (txns.length === 0) continue;
          const r = mergeIntoBank(store, normalizeBankName(bank) ?? UNKNOWN_BANK, txns);
          store = r.store;
          merged += r.added;
          parsedOk.push({ id: o.f.id });
        } catch { /* ไฟล์นี้พลาด → เก็บไว้ */ }
      }

      const hasData = Object.keys(store.banks).length > 0;
      if (!hasData) { perCustomer.push(rec); continue; }

      // 4) เขียนไฟล์ Excel รวม (ฝัง _data) — ต้องสำเร็จก่อนถึงจะลบของเก่า
      try {
        const wb = await buildStatementAlbumWorkbook({ customerName: cust.name, banks: store.banks });
        await uploadOneDriveFile({ folderParts, fileName, mime: XLSX_MIME, data: wb, root });
      } catch {
        rec.rebuilt = false;
        rec.kept = oldCsvFiles.length;
        perCustomer.push(rec);
        continue;
      }

      // 5) ลบ CSV เก่าที่รวมแล้ว + ลบโฟลเดอร์ _album (ไม่ใช้ sidecar อีก)
      let csvDeleted = 0;
      for (const p of parsedOk) { try { if (await deleteOneDriveItemById(p.id)) csvDeleted++; } catch { /* keep */ } }
      let albumDeleted = false;
      if (albumFolder) { try { albumDeleted = await deleteOneDriveItemById(albumFolder.id); } catch { /* keep */ } }

      rec.rebuilt = true;
      rec.txnsMerged = merged;
      rec.csvDeleted = csvDeleted;
      rec.albumFolderDeleted = albumDeleted;
      rec.kept = oldCsvFiles.length - parsedOk.length;
      perCustomer.push(rec);
    }
    if (truncated) break;
  }

  const totals = perCustomer.reduce(
    (a, c) => ({
      detCsv: a.detCsv + c.oldCsv.det,
      imageCsv: a.imageCsv + c.oldCsv.image,
      albumV1Csv: a.albumV1Csv + c.oldCsv.albumV1,
      albumFolders: a.albumFolders + (c.hasAlbumFolder ? 1 : 0),
      rebuilt: a.rebuilt + (c.rebuilt ? 1 : 0),
      csvDeleted: a.csvDeleted + (c.csvDeleted ?? 0),
      albumFoldersDeleted: a.albumFoldersDeleted + (c.albumFolderDeleted ? 1 : 0),
      txnsMerged: a.txnsMerged + (c.txnsMerged ?? 0),
    }),
    { detCsv: 0, imageCsv: 0, albumV1Csv: 0, albumFolders: 0, rebuilt: 0, csvDeleted: 0, albumFoldersDeleted: 0, txnsMerged: 0 },
  );

  return NextResponse.json({ ok: true, mode, roots, customersScanned, truncated, totals, perCustomer });
}

export const GET = handle;
export const POST = handle;
