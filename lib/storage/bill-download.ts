import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadOneDriveObjectPath } from "@/lib/storage/onedrive";

const BILLS_BUCKET = "bills";

export function isOneDriveBillPath(path: string): boolean {
  return /^NOVA-(?:Bills|Care)\//.test(path || "");
}

/** โหลดไฟล์แนบบิลจาก backend ที่ objectPath ระบุ โดยให้ worker อ่านบิลชุดเดิมได้ทั้ง Supabase/OneDrive */
export async function downloadStoredBillFile(db: SupabaseClient, objectPath: string): Promise<Buffer | null> {
  if (isOneDriveBillPath(objectPath)) return downloadOneDriveObjectPath(objectPath);
  try {
    const { data: blob, error } = await db.storage.from(BILLS_BUCKET).download(objectPath);
    if (error || !blob) return null;
    return Buffer.from(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

