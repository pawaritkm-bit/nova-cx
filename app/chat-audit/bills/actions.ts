"use server";

/**
 * Server action ของหน้า "บิลลูกค้า" (/chat-audit/bills) — ลบบิลถาวร (admin เท่านั้น)
 *
 * flow ความปลอดภัย (ยึดมาตรฐาน write path — ห้ามเชื่อ scope จาก client):
 *   1) resolve viewer จาก session จริง (cookie) → requireAdminContext บังคับ role∈{admin,executive}
 *      + ได้ tenantId จาก session (ไม่เชื่อค่าจาก client)
 *   2) validate attachment_id (uuid) จาก formData
 *   3) โหลดแถว message_attachments แบบ scope ด้วย tenant จาก session → เอา object path (drive_file_id)
 *   4) ลบไฟล์จริงจาก bucket `bills` (private) แล้ว mark DB (ไม่ hard-delete แถว — เก็บ metadata ไว้ audit)
 *   5) revalidatePath('/chat-audit/bills')
 *
 * ★ PDPA (ลบข้อมูลถาวร): admin เท่านั้น · ลบไฟล์จริง + mark DB ว่าลบด้วยมือ (fetch_error='manual_delete')
 *   ★ ห้าม log ชื่อไฟล์/ลูกค้า/URL (ไม่มี console.* ที่นี่)
 *   ★ ไม่แตะ pipeline เก็บบิล/คัดกรอง — แค่ viewer ลบรายการที่ไม่ต้องการ
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAdminContext, AdminAuthError } from "@/lib/admin/guard";

/** bucket รูปบิล (private) — ตรงกับ lib/storage/bill-storage.ts + page.tsx */
const BILLS_BUCKET = "bills";

export type DeleteBillResult = { ok: boolean; message: string };

/** แปลง error ภายในเป็นข้อความสุภาพ (ไม่หลุด internal ต่อผู้ใช้) */
function friendlyError(e: unknown): string {
  if (e instanceof AdminAuthError) return e.message;
  if (e instanceof Error && e.message && /[ก-๙]/.test(e.message)) return e.message;
  return "ลบบิลไม่สำเร็จ กรุณาลองใหม่ หรือติดต่อผู้ดูแลระบบ";
}

/** ตรวจรูปแบบ uuid v4-ish (กัน attachment_id ปลอมจาก client) */
function isUuid(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

/**
 * ลบบิล 1 ใบถาวร (เรียกจากปุ่มในการ์ด — <form action={deleteBillAction}>)
 *   - guard admin + tenant จาก session (ไม่เชื่อ client)
 *   - ลบไฟล์จริงจาก bucket แล้ว mark DB — คืนสถานะ ไม่ throw ให้หน้าเด้ง
 */
export async function deleteBillAction(
  formData: FormData
): Promise<DeleteBillResult> {
  const attachmentId = formData.get("attachment_id");
  if (!isUuid(attachmentId)) {
    return { ok: false, message: "ไม่พบบิลที่เลือก" };
  }

  try {
    // 1) guard admin/executive + tenant จาก session (cookie) — fail-closed
    const authed = await createClient();
    const ctx = await requireAdminContext(authed);
    const service = createServiceRoleClient();

    // 2) โหลดแถว scope ด้วย tenant จาก session → เอา object path
    const { data: row, error: readErr } = await service
      .from("message_attachments")
      .select("id, drive_file_id")
      .eq("id", attachmentId)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();

    if (readErr) throw new Error(readErr.message);
    if (!row) return { ok: false, message: "ไม่พบบิลที่เลือก (อาจถูกลบไปแล้ว)" };

    const objectPath = (row as { drive_file_id: string | null }).drive_file_id;

    // 3) ลบไฟล์จริงจาก bucket (ถ้ามี ref) — best-effort:
    //    ถ้าไฟล์หายไปแล้ว/ลบไม่ได้ ยัง mark DB ต่อ เพื่อกันหน้าอื่นไป sign URL ต่อ
    if (objectPath) {
      await service.storage.from(BILLS_BUCKET).remove([objectPath]);
    }

    // 4) mark DB (ไม่ hard-delete แถว — เก็บ metadata ไว้ audit ว่าใครลบเมื่อไหร่)
    //    ล้าง drive_url/drive_file_id เพราะไฟล์ถูกลบแล้ว → หน้า viewer จะไม่ไป sign ต่อ
    const { error: updErr } = await service
      .from("message_attachments")
      .update({
        fetch_status: "skipped",
        fetch_error: "manual_delete",
        doc_checked: true,
        drive_url: null,
        drive_file_id: null,
      })
      .eq("id", attachmentId)
      .eq("tenant_id", ctx.tenantId);

    if (updErr) throw new Error(updErr.message);

    // 5) audit (append-only) — บันทึกว่าใครลบเมื่อไหร่ (ไม่เก็บชื่อไฟล์/ลูกค้า/URL)
    //    best-effort: ถ้า audit ล้มไม่ควรทำให้ผลการลบ (ไฟล์+mark สำเร็จแล้ว) กลายเป็น fail
    try {
      await service.from("audit_logs").insert({
        tenant_id: ctx.tenantId,
        actor_user_id: ctx.userId,
        action: "bill_deleted",
        resource: "message_attachment",
        resource_id: attachmentId,
        meta: { deleted_at: new Date().toISOString() },
      });
    } catch {
      /* ไม่ให้ audit ที่ล้มมาบดบังผลการลบจริง */
    }

    revalidatePath("/chat-audit/bills");
    return { ok: true, message: "ลบบิลแล้ว" };
  } catch (e) {
    return { ok: false, message: friendlyError(e) };
  }
}
