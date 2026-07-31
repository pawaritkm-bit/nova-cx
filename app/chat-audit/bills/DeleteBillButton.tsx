"use client";

import { useFormStatus } from "react-dom";
import { deleteBillAction } from "./actions";

/**
 * ปุ่ม "ลบ" ในการ์ดบิล (client) — ลบบิลถาวร (admin เท่านั้น, guard ฝั่ง server action)
 *
 * ★ ยืนยันก่อนลบเสมอ (window.confirm) — ลบถาวร กู้ไม่ได้ (ไฟล์หายจาก bucket)
 * ★ ระหว่างลบแสดง pending (useFormStatus) + disable กันกดซ้ำ
 *   สำเร็จ: revalidatePath ใน action ทำให้การ์ดหายจากลิสต์เอง
 *   ล้มเหลว: action คืนสถานะ (ไม่ throw) — การ์ดยังอยู่ ผู้ใช้ลองใหม่ได้
 */
function DeleteSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="bill-delete"
      disabled={pending}
      aria-label="ลบบิลนี้ถาวร"
      title="ลบบิลนี้ถาวร"
    >
      {pending ? "กำลังลบ…" : "ลบ"}
    </button>
  );
}

export default function DeleteBillButton({ attachmentId }: { attachmentId: string }) {
  return (
    <form
      // ห่อ action ให้คืน void (React form action) — ผลลัพธ์/ข้อความจัดการฝั่ง action แล้ว (ไม่ throw)
      action={async (formData) => {
        await deleteBillAction(formData);
      }}
      className="bill-delete-form"
      onSubmit={(e) => {
        // ยืนยันก่อนลบเสมอ — ยกเลิก = ไม่ยิง action
        if (!window.confirm("ลบบิลนี้ถาวร? ไฟล์จะหายจากระบบ")) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="attachment_id" value={attachmentId} />
      <DeleteSubmit />
    </form>
  );
}
