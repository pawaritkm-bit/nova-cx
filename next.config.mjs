/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";

// Security headers พื้นฐาน (ใช้ทุก path)
//   - Referrer-Policy: ไม่รั่ว URL เต็มข้าม origin
//   - X-Content-Type-Options: กัน MIME sniffing
//   - HSTS: บังคับ https (prod เท่านั้น — dev เป็น http)
const baseSecurityHeaders = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  ...(isProd
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig = {
  reactStrictMode: true,
  // อย่าให้ Next ไปสแกนโค้ดต้นแบบเดิม (prototype/) หรือ docs
  eslint: {
    dirs: ["app", "lib"],
  },
  async headers() {
    return [
      // ★ X-Frame-Options เฉพาะ path ที่ "ไม่ใช่ /liff"
      //   LIFF ทำงานใน in-app browser/iframe ของ LINE — ถ้าใส่ SAMEORIGIN จะถูกบล็อก
      //   ใช้ negative lookahead กัน /liff และ /liff/... ออกจากกฎ frame-guard
      {
        source: "/((?!liff).*)",
        headers: [
          ...baseSecurityHeaders,
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
      // /liff และลูก: ใส่ security header พื้นฐาน แต่ "ไม่" ใส่ X-Frame-Options
      //   เพื่อให้ LINE ฝัง LIFF ได้ตามปกติ
      {
        source: "/liff/:path*",
        headers: baseSecurityHeaders,
      },
      {
        source: "/liff",
        headers: baseSecurityHeaders,
      },
    ];
  },
};

export default nextConfig;
