/**
 * ตรรกะ guard เส้นทาง (แยกจาก middleware เพื่อ unit test ได้)
 *
 * - เส้นทางที่ "ต้องมี session" คือหน้า dashboard เท่านั้น (หน้า UI พนักงาน)
 * - เส้นทางสาธารณะ/ระบบ (LIFF ลูกค้า, survey, integration ภายนอก, cron, static)
 *   ต้องไม่ถูก redirect ไป /login เด็ดขาด
 * - API /api/dashboard บังคับ session เองด้วยการตอบ 401 (ไม่ต้อง redirect ที่ middleware)
 */

/** prefix ของเส้นทางสาธารณะ/ระบบ ที่ห้าม redirect ไป login */
const PUBLIC_PREFIXES = [
  "/login",
  "/api/liff",
  "/liff",
  "/api/survey",
  "/api/integrations",
  "/api/cron",
  "/api/health",
  "/api/line",
];

/** เส้นทาง static ของ Next.js / ไฟล์ asset — ปล่อยผ่านเสมอ */
export function isStaticPath(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff2?)$/.test(pathname)
  );
}

/** เส้นทางสาธารณะที่ไม่บังคับ session */
export function isPublicPath(pathname: string): boolean {
  if (isStaticPath(pathname)) return true;
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

/** เส้นทางที่ต้องมี session พนักงาน (หน้า dashboard) */
export function isProtectedPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

/**
 * คืน true เมื่อ request นี้ควรถูก redirect ไป /login
 * (เป็น protected path + ไม่มี session + ไม่ใช่ public path)
 */
export function shouldRedirectToLogin(
  pathname: string,
  hasSession: boolean
): boolean {
  if (isPublicPath(pathname)) return false;
  if (!isProtectedPath(pathname)) return false;
  return !hasSession;
}
