/**
 * pdf-split.ts — ตัด PDF ใหญ่เกินเพดาน AI เป็นชิ้นย่อย แล้วอ่านทีละชิ้น (server-only)
 *
 * ทำไม: OpenAI/Claude รับ PDF ได้ ~32MB/ครั้ง — ไฟล์ใหญ่กว่านั้น (สเตทเมนต์/รายงานแพลตฟอร์ม/
 *   สแกนหลายหน้า) เดิม "เรียกครั้งเดียว" แล้ว fail · ตอนนี้ตัดเป็นชิ้น ≤24MB อ่านทีละชิ้นแล้วรวมผล
 *   (port แนวทางที่พิสูจน์แล้วจาก NOVA Sales — split-pdf.ts)
 *
 * ★ รูปเดี่ยว (JPEG/PNG) ความละเอียดสูงมาก ยังไม่ครอบคลุมที่นี่ (ตัด PDF เท่านั้น)
 *   — เฟส 2b: downscale ด้วย sharp (มีใน tree แล้ว) ก่อนส่ง vision
 */
import { PDFDocument } from "pdf-lib";

/** เพดานจริงของ provider (~32MB) — ตั้ง target ต่ำกว่าเผื่อ margin */
export const SPLIT_TARGET_BYTES_PER_CHUNK = 24 * 1024 * 1024; // 24 MB

/** ยิง AI พร้อมกันสูงสุดกี่ชิ้น (คุม rate limit + wall-clock รวมให้อยู่ใน maxDuration) */
const MAX_CONCURRENT_CHUNKS = 3;

/**
 * ตัด PDF (bytes) เป็นหลายชิ้น ชิ้นละไม่เกิน target (best-effort, greedy ต่อหน้า)
 * เก็บทุกหน้าไว้ (ไม่ตัดทิ้ง) — หน้าเดียวที่เกินเพดานยอมปล่อยเกิน · คืนชิ้นเดียวถ้าทั้งไฟล์อยู่ในเพดาน
 */
export async function splitPdfIntoChunks(
  bytes: Uint8Array,
  targetBytesPerChunk: number,
): Promise<Uint8Array[]> {
  const src = await PDFDocument.load(bytes);
  const totalPages = src.getPageCount();
  if (totalPages === 0) return [bytes];

  const chunks: Uint8Array[] = [];
  let currentDoc = await PDFDocument.create();
  let currentPageCount = 0;

  for (let i = 0; i < totalPages; i += 1) {
    const [copiedPage] = await currentDoc.copyPages(src, [i]);
    currentDoc.addPage(copiedPage);
    currentPageCount += 1;

    const candidateBytes = await currentDoc.save();
    if (candidateBytes.length <= targetBytesPerChunk) continue;

    if (currentPageCount === 1) {
      // หน้าเดียวก็เกินเพดาน (สแกนละเอียดมาก) — เก็บทั้งหน้า ไม่ตัดทิ้ง
      chunks.push(candidateBytes);
      currentDoc = await PDFDocument.create();
      currentPageCount = 0;
      continue;
    }

    // หน้าล่าสุดทำให้เกิน — ปิดชิ้นนี้ (ไม่รวมหน้าล่าสุด) แล้วเริ่มชิ้นใหม่ด้วยหน้านั้น
    currentDoc.removePage(currentPageCount - 1);
    chunks.push(await currentDoc.save());
    currentDoc = await PDFDocument.create();
    const [retryPage] = await currentDoc.copyPages(src, [i]);
    currentDoc.addPage(retryPage);
    currentPageCount = 1;
  }

  if (currentPageCount > 0) chunks.push(await currentDoc.save());
  return chunks;
}

/** worker pool ง่าย ๆ — คืนผลลัพธ์เรียงตามลำดับ input เดิม */
async function runWithConcurrencyLimit<I, O>(
  items: I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * ★ Generic: ถ้าเป็น PDF ใหญ่เกินเพดาน → ตัดเป็นชิ้น → เรียก extractChunk ต่อชิ้น (bounded) → รวมผล
 *   ไม่ใช่ PDF / ไม่เกินเพดาน / ตัดได้ชิ้นเดียว → เรียก extractChunk ครั้งเดียว (path เดิม ไม่เปลี่ยนพฤติกรรม)
 *   ใช้ได้กับ statement / platform-report / bill (คืน array ทั้งหมด)
 */
export async function extractPdfMaybeSplit<T>(
  fileData: Buffer,
  mime: string,
  extractChunk: (chunkData: Buffer, mime: string) => Promise<T[]>,
): Promise<T[]> {
  const isPdf = (mime || "").toLowerCase().includes("pdf");
  if (!isPdf || fileData.length <= SPLIT_TARGET_BYTES_PER_CHUNK) {
    return extractChunk(fileData, mime);
  }
  const chunks = await splitPdfIntoChunks(fileData, SPLIT_TARGET_BYTES_PER_CHUNK);
  if (chunks.length <= 1) {
    // ตัดไม่ได้ (หน้าเดียวใหญ่เกิน) — ลองครั้งเดียวตาม path เดิม
    return extractChunk(fileData, mime);
  }
  const perChunk = await runWithConcurrencyLimit(chunks, MAX_CONCURRENT_CHUNKS, (c) =>
    extractChunk(Buffer.from(c), mime),
  );
  return perChunk.flat();
}
