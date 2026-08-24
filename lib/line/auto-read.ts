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
import { saveRawCsvToOneDrive } from "@/lib/accounting/onedrive-result";
import { extractPlatformReportFromFile, extractPlatformReportFromText, extractPlatformReportFromTextChunks } from "@/lib/accounting/platform-report-extract";
import { detectStatementBank, extractStatementFromFile, extractStatementFromText, extractStatementFromTextChunks, normalizeBankName } from "@/lib/accounting/statement-extract";
import { autoImportReconciledStatement } from "@/lib/accounting/bank-reconciliation";
import { lockedNoteFileName, buildLockedNoteContent } from "@/lib/accounting/locked-note";
import { sanitizeDocName } from "@/lib/accounting/doc-naming";
import { extractAndClassify, type FinanceClassification } from "@/lib/accounting/classify-finance-doc";
import { deleteOneDriveItemById, downloadOneDriveFile, isOneDriveEnabled, listOneDriveChildren, renameOneDriveFile, uploadOneDriveFile } from "@/lib/storage/onedrive";
import { albumXlsxName, mergeIntoBank, mergeProfile, UNKNOWN_BANK, type AlbumProfile } from "@/lib/accounting/statement-album";
import { buildStatementAlbumWorkbook, readAlbumFromWorkbook } from "@/lib/accounting/statement-album-excel";
import { extractIdCardData } from "@/lib/accounting/id-card-extract";
import { mergePlatformFile, toPlatformRecord } from "@/lib/accounting/platform-album";
import { buildPlatformAlbumWorkbook, readPlatformAlbumFromWorkbook } from "@/lib/accounting/platform-album-excel";
import { summarizePlatformReport } from "@/lib/accounting/platform-report-analyze";
import { detectPlatformFromName } from "@/lib/accounting/platform/parse";
import type { StatementTxn } from "@/lib/accounting/statement-analyze";
import { resolveSaleFolder, oaOneDriveRoot, lineChatUrl, type MirrorGroupContext } from "@/lib/line/onedrive-mirror";
import { buildProspectIncomeWorkbook, aggregateBankMonthly } from "@/lib/accounting/prospect-income-analysis";
import { upsertProspectBankSummary, loadProspectBankSummaries } from "@/lib/accounting/prospect-income-store";

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

/** ป้ายธนาคาร: "ชื่อแบงก์ #เลข4ตัวท้าย" (ถ้าอ่านเลขบัญชีได้) */
function bankLabelOf(bank: string | null, accountName: string | null): string {
  const b = (bank || "ธนาคาร").trim();
  const digits = (accountName || "").replace(/\D/g, "");
  const tail = digits.length >= 4 ? digits.slice(-4) : "";
  return tail ? `${b} #${tail}` : b;
}

type DetForIncome = {
  transactions: { date: string | null; direction: "in" | "out" | null; amount: number | null }[];
  bank: string | null;
  accountName: string | null;
};

/**
 * ★ วิเคราะห์รายรับว่าที่ลูกค้า (sales pitch): สะสมยอดเงินเข้าต่อธนาคาร/ปี (DB) →
 *   รีเจนไฟล์ Excel รวมทุกธนาคาร (+ เตือน 1.8 ล้าน) เข้าโฟลเดอร์ลูกค้าใน OneDrive
 *   ★ เฉพาะสเตทเมนต์ที่ deterministic reconcile ผ่าน (แม่น) · best-effort
 *   ★ ปิดได้ด้วย ACCT_PROSPECT_ANALYSIS=off
 */
async function regenProspectIncome(
  db: SupabaseClient,
  chatGroupId: string,
  det: DetForIncome,
  folder: string,
  folderParts: string[],
  root?: string
): Promise<void> {
  if (process.env.ACCT_PROSPECT_ANALYSIS === "off") return;
  const { data: g } = await db.from("chat_groups").select("tenant_id").eq("id", chatGroupId).maybeSingle();
  const tenantId = (g as { tenant_id?: string | null } | null)?.tenant_id;
  if (!tenantId) return;

  const years = new Set<number>();
  for (const t of det.transactions) {
    const m = /^(\d{4})-/.exec(t.date || "");
    if (m) years.add(parseInt(m[1], 10));
  }
  if (years.size === 0) return;

  const bankLabel = bankLabelOf(det.bank, det.accountName);
  const customerName = (det.accountName || folder || "ว่าที่ลูกค้า").trim();
  const nowIso = new Date().toISOString();

  for (const year of years) {
    const monthly = aggregateBankMonthly(det.transactions, year);
    if (monthly.length === 0) continue;
    await upsertProspectBankSummary(db, { tenantId, chatGroupId, bankLabel, year, monthly, nowIso });
    const banks = await loadProspectBankSummaries(db, tenantId, chatGroupId, year);
    const wb = await buildProspectIncomeWorkbook({ customerName, year, profile: {}, banks });
    await uploadOneDriveFile({
      folderParts,
      fileName: `${sanitizeDocName(customerName)} - วิเคราะห์รายรับ ${year + 543}.xlsx`,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: wb,
      root,
    });
  }
}

/**
 * ★ รวมสเตทเมนต์ทุกไฟล์/รูปของลูกค้า → Excel สรุปไฟล์เดียว แยกชีตตามธนาคาร
 *   สะสมธุรกรรมลง store JSON (โฟลเดอร์ย่อย _album) ต่อธนาคาร → dedup (กันไฟล์/รูปซ้ำ) → รีเจน Excel
 *   ★ best-effort · added=0 (ไม่มีรายการใหม่/ไฟล์ซ้ำ) → ข้ามการรีเจน
 */
/** หาไฟล์สรุปเดิมในโฟลเดอร์ (ชื่ออาจเป็นชื่อกลุ่ม หรือชื่อตามบัตร) → {name,id} · null=ยังไม่มี */
async function findAlbumFile(folderParts: string[], root?: string): Promise<{ name: string; id: string } | null> {
  try {
    const kids = await listOneDriveChildren(folderParts, root);
    const f = kids.find((k) => !k.isFolder && /สรุปสเตทเมนต์\.xlsx$/i.test(k.name));
    return f ? { name: f.name, id: f.id } : null;
  } catch {
    return null;
  }
}

/**
 * ★ รวมสเตทเมนต์ทุกไฟล์/รูป + โปรไฟล์บัตร ปชช. ของลูกค้า → Excel สรุปไฟล์เดียว
 *   อ่านกองเดิมจากชีตซ่อนในไฟล์ → merge txns/profile → รีเจน · ตั้งชื่อไฟล์/หัวไฟล์ตามชื่อในบัตร (ถ้ามี)
 *   ★ best-effort · ไม่มีอะไรใหม่ → ข้าม · ถ้าชื่อไฟล์เปลี่ยน (ได้ชื่อบัตร) → ลบไฟล์ชื่อเก่า
 */
async function regenStatementAlbum(args: {
  folderParts: string[];
  root?: string;
  folder: string;
  bankLabel?: string | null;
  txns?: StatementTxn[];
  profile?: AlbumProfile | null;
  chatUrl?: string | null;
}): Promise<void> {
  const existingFile = await findAlbumFile(args.folderParts, args.root);
  const existing = existingFile ? await downloadOneDriveFile(args.folderParts, existingFile.name, args.root) : null;
  let store = await readAlbumFromWorkbook(existing);
  let changed = false;
  if (args.txns && args.txns.length > 0) {
    const r = mergeIntoBank(store, args.bankLabel ?? UNKNOWN_BANK, args.txns);
    store = r.store;
    if (r.added > 0) changed = true;
  }
  if (args.profile) {
    const r = mergeProfile(store, args.profile);
    store = r.store;
    if (r.added) changed = true;
  }
  if (args.chatUrl) {
    const r = mergeProfile(store, { chatUrl: args.chatUrl });
    store = r.store;
    if (r.added) changed = true;
  }
  if (!changed) return;

  const displayName = (store.profile?.name || args.folder || "ลูกค้า").trim();
  const newName = albumXlsxName(displayName);
  const wb = await buildStatementAlbumWorkbook({ customerName: displayName, banks: store.banks, profile: store.profile });
  await uploadOneDriveFile({
    folderParts: args.folderParts,
    fileName: newName,
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    data: wb,
    root: args.root,
  });
  // ชื่อไฟล์เปลี่ยน (ได้ชื่อจากบัตร) → ลบไฟล์ชื่อเก่า
  if (existingFile && existingFile.name !== newName) {
    try { await deleteOneDriveItemById(existingFile.id); } catch { /* เก็บไว้ก็ไม่เป็นไร */ }
  }
}

/** ★ รวมรายงานแพลตฟอร์มทุกไฟล์ของลูกค้า → Excel สรุปไฟล์เดียว (ต่อแพลตฟอร์ม + รายเดือน · dedup ไฟล์ซ้ำ) */
async function regenPlatformAlbum(args: {
  folderParts: string[];
  root?: string;
  folder: string;
  record: ReturnType<typeof toPlatformRecord>;
}): Promise<void> {
  const re = /สรุปยอดขายแพลตฟอร์ม\.xlsx$/i;
  let existing: { name: string; id: string } | null = null;
  try {
    const kids = await listOneDriveChildren(args.folderParts, args.root);
    const f = kids.find((k) => !k.isFolder && re.test(k.name));
    if (f) existing = { name: f.name, id: f.id };
  } catch { /* ยังไม่มีไฟล์ */ }
  const store = await readPlatformAlbumFromWorkbook(existing ? await downloadOneDriveFile(args.folderParts, existing.name, args.root) : null);
  const { store: next, added } = mergePlatformFile(store, args.record);
  if (!added) return; // ไฟล์ซ้ำ → ไม่รีเจน
  const fileName = `${sanitizeDocName(args.folder || "ลูกค้า")} - สรุปยอดขายแพลตฟอร์ม.xlsx`;
  const wb = await buildPlatformAlbumWorkbook({ customerName: args.folder, store: next });
  await uploadOneDriveFile({ folderParts: args.folderParts, fileName, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: wb, root: args.root });
  if (existing && existing.name !== fileName) { try { await deleteOneDriveItemById(existing.id); } catch { /* keep */ } }
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
        imageAiClassify: false, // ประหยัดงบ: ไม่ AI จัดประเภทรูป (สเตทเมนต์รูปไม่ auto-summary แล้ว)
      }));

    const folder = await resolveSaleFolder(group, root);
    // ★ ลิงก์เปิดแชทลูกค้าใน LINE OA Manager — เฉพาะ sale (NOVA-Bills) ที่ลูกค้ามาจาก LINE OA
    const chatUrl = oaType === "sale" ? lineChatUrl(group.group_ref) : null;
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

    // 1) สเตทเมนต์ deterministic (reconcile ผ่าน) → สรุปฟรี/เร็ว ไม่ต้องพึ่ง AI
    if (cls.det?.fullyReconciled) {
      // ★ รวมทุกไฟล์/รูปของลูกค้า → Excel สรุปไฟล์เดียว แยกชีตตามธนาคาร (PDF รู้ชื่อธนาคารจาก det)
      try {
        await regenStatementAlbum({
          folderParts,
          root,
          folder,
          bankLabel: bankLabelOf(cls.det.bank, cls.det.accountName),
          txns: cls.det.transactions,
          chatUrl,
        });
      } catch {
        console.warn("[auto-read] statement album (det) failed");
      }
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
              accountName: cls.det.accountName,
              transactions: cls.det.transactions,
              sourceFileName: params.originalName || params.fileName,
            });
          }
        } catch {
          console.warn("[auto-read] auto-reconcile feed failed");
        }
      }
      // ★ วิเคราะห์รายรับว่าที่ลูกค้า (sales pitch) — สะสมยอด + รีเจน Excel รวมทุกธนาคาร (sale + care)
      try {
        await regenProspectIncome(params.db, params.chatGroupId, cls.det, folder, folderParts, root);
      } catch {
        console.warn("[auto-read] prospect income analysis failed");
      }
      await markSourceRead(folderParts, params.fileName, root);
      return;
    }

    // 2) รายงานแพลตฟอร์ม deterministic (Excel/CSV) → 4 ตัวเลข + รายเดือน ตรง NOVA Sales
    //    ★ รวมทุกไฟล์ของลูกค้า → Excel สรุปเดียว (ต่อแพลตฟอร์ม+รายเดือน) แทน CSV ต่อไฟล์
    if (cls.platform && (cls.platform.figures.grossSales > 0 || cls.platform.figures.platformFee > 0)) {
      try {
        await regenPlatformAlbum({ folderParts, root, folder, record: toPlatformRecord(cls.platform.platform, cls.platform.figures) });
      } catch {
        console.warn("[auto-read] platform album (det) failed");
      }
      await markSourceRead(folderParts, params.fileName, root);
      return;
    }

    // 3) ไม่ใช่สเตทเมนต์/แพลตฟอร์มที่โค้ดอ่านได้ → อ่านด้วย AI ตามชนิดที่จัดไว้
    if (cls.type === "other") {
      // ★ อาจเป็น "บัตรประชาชน" (ว่าที่ลูกค้าส่งมาทางไลน์) → อ่าน KYC เติมชีตประวัติ + ตั้งชื่อไฟล์/หัวตามชื่อในบัตร
      //   ★★ เฉพาะ sale OA (prospect ส่งบัตร) เท่านั้น — care=บิล ไม่ต้องอ่านบัตร (กัน Gemini ยิงทุกรูปบิล = เปลือง)
      //   เฉพาะรูป · best-effort · ไม่ใช่บัตร → null · ไม่เก็บรูปบัตร (PDPA)
      if (oaType === "sale" && (params.mime || "").toLowerCase().startsWith("image/")) {
        try {
          // ★ ประหยัด token: ถ้ามีชื่อจากบัตรของลูกค้ารายนี้แล้ว → ไม่ต้อง OCR ซ้ำ (อ่านบัตรครั้งเดียวพอ)
          const existing = await findAlbumFile(folderParts, root);
          const known = existing ? (await readAlbumFromWorkbook(await downloadOneDriveFile(folderParts, existing.name, root))).profile?.name : null;
          if (!known) {
            const idc = await extractIdCardData(params.data, params.mime);
            if (idc) {
              await regenStatementAlbum({ folderParts, root, folder, profile: idc, chatUrl });
              await markSourceRead(folderParts, params.fileName, root);
            }
          }
        } catch {
          console.warn("[auto-read] id-card read failed");
        }
      }
      return; // บิลอื่นๆ — เก็บไฟล์อย่างเดียว ไม่สรุป
    }

    if (cls.type === "statement") {
      // ★ ประหยัดงบ: สรุปเฉพาะสเตทเมนต์ "ดิจิทัล" (text/chunks = deterministic ฟรี)
      //   สเตทเมนต์ "รูป" ไม่ auto-summary แล้ว (AI vision แพง) → ข้าม ปล่อยเป็นไฟล์ต้นทางเฉยๆ
      if (!cls.chunks && !cls.text) return;
      const txns = cls.chunks
        ? (await extractStatementFromTextChunks(cls.chunks)).txns
        : await extractStatementFromText(cls.text!);
      if (txns.length === 0) return;
      // ★ รวมทุกไฟล์/รูปของลูกค้า → Excel สรุปไฟล์เดียว แยกชีตตามธนาคาร · dedup (กันรูปซ้ำ)
      //   ★ ใช้ชื่อธนาคารจาก parser ก่อน (ฟรี — NOVA Sale/deterministic มักอ่านให้อยู่แล้ว)
      //     เรียก AI เดาแบงก์ "เฉพาะเมื่อ parser ไม่ให้ชื่อธนาคาร" เท่านั้น (ประหยัด token) · ไม่ได้ → "ไม่ระบุธนาคาร"
      try {
        let bank = normalizeBankName(cls.det?.bank ?? null);
        // ★ เดาชื่อธนาคารด้วย AI เฉพาะ sale (care ไม่เดาแบงก์ ตามที่ผู้ใช้ต้องการ · ประหยัด token)
        if (!bank && oaType === "sale") bank = await detectStatementBank(params.data, params.mime);
        await regenStatementAlbum({ folderParts, root, folder, bankLabel: bank ?? UNKNOWN_BANK, txns, chatUrl });
      } catch {
        console.warn("[auto-read] statement album (image) failed");
      }
      await markSourceRead(folderParts, params.fileName, root);
      return;
    }

    // platform report (Shopee/Lazada/TikTok — AI อ่าน line-level) → map เป็น 4 ตัวเลข → รวมเข้าไฟล์สรุปเดียว
    const lines = cls.chunks
      ? (await extractPlatformReportFromTextChunks(cls.chunks)).lines
      : cls.text
        ? await extractPlatformReportFromText(cls.text)
        : await extractPlatformReportFromFile(params.data, params.mime);
    if (lines.length === 0) return;
    try {
      const sum = summarizePlatformReport(lines);
      const dget = (c: string) => sum.deductions.find((d) => d.category === c)?.total ?? 0;
      const figures = {
        grossSales: sum.grossSales + sum.otherCredit,
        platformFee: dget("commission_fee") + dget("payment_fee") + dget("ads_fee"),
        shippingFee: dget("shipping_fee"),
        discount: dget("penalty") + dget("refund") + dget("other"),
      };
      const platform = detectPlatformFromName(params.originalName || params.fileName) || "unknown";
      await regenPlatformAlbum({ folderParts, root, folder, record: toPlatformRecord(platform, figures) });
    } catch {
      console.warn("[auto-read] platform album (ai) failed");
    }
    await markSourceRead(folderParts, params.fileName, root);
  } catch {
    console.warn("[auto-read] failed");
  }
}
