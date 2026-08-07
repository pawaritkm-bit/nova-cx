/**
 * ตัวช่วงฝั่ง client: ยิง POST ค่าที่นักบัญชี "แก้บนจอ" ไป route export
 * แล้วรับไฟล์ .xlsx กลับมาเป็น blob → trigger ดาวน์โหลด
 *
 * ★ ใช้กับรายงานภาษีซื้อ/ขาย + สมุดรายวัน — Excel จึงตรงกับที่เห็น/แก้บนจอ
 * ★ PDPA: ไม่ log ค่า body ใด ๆ (ชื่อ/เลขภาษี/ตัวเลข)
 */

/** ดึงชื่อไฟล์จาก header content-disposition (รองรับ filename*=UTF-8'' เป็นหลัก) */
function filenameFromDisposition(cd: string | null): string | null {
  if (!cd) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star && star[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* ตกไปใช้แบบ ascii */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain && plain[1] ? plain[1].trim() : null;
}

/**
 * POST body (JSON) ไปยัง url แล้วดาวน์โหลดไฟล์ที่ได้กลับมา
 * @returns null ถ้าสำเร็จ · ข้อความ error (ไทย) ถ้าไม่สำเร็จ
 */
export async function downloadExcelFromPost(
  url: string,
  body: unknown,
  fallbackName: string
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return "เชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง";
  }

  if (!res.ok) {
    // อ่านข้อความ error จาก server แบบ best-effort (ไม่ throw)
    let msg = "ออกไฟล์ Excel ไม่สำเร็จ";
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) msg = j.message;
    } catch {
      /* body ไม่ใช่ JSON — ใช้ข้อความ default */
    }
    return msg;
  }

  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get("content-disposition")) || fallbackName;

  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // ปล่อย object URL ทิ้ง (หน่วงเล็กน้อยให้เบราว์เซอร์เริ่มดาวน์โหลดก่อน)
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  return null;
}
