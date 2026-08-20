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
  // ★ wishlist ข้อ 6 (สลิปเงินเดือน PDF) — lib/pdf/thai-text.ts หา path ไฟล์ฟอนต์ .woff จาก @fontsource/sarabun
  //   ตอน runtime ผ่าน require.resolve("@fontsource/sarabun/package.json") + path.join (ดูคอมเมนต์เต็มในไฟล์
  //   นั้น) — 2 ปัญหาที่ต้องแก้คู่กัน:
  //   1) ถ้าปล่อยให้ webpack bundle โค้ดนี้ตามปกติ (ไม่ external) — require.resolve() ที่ webpack แปลงให้เป็น
  //      __webpack_require__.resolve() จะไม่คืน path ไฟล์จริงในระบบ (คืน module id ภายในของ webpack แทน) ทำให้
  //      fs.readFileSync ของ pdfkit หาไฟล์ไม่พบตอน runtime (ยืนยันจริงตอน browser QA — build/dev ผ่านเงียบ ๆ
  //      แต่กดส่งจริงพัง "สร้าง/ส่งสลิปไม่สำเร็จ" เพราะ path ผิด) — serverExternalPackages ด้านล่างบอก Next ให้
  //      ปล่อยให้ require()/require.resolve() ของแพ็กเกจนี้เป็น native Node require ตรง ๆ ไม่ผ่าน webpack เลย
  //   2) แม้ external แล้ว ก็ต้องประกาศไฟล์ .woff ไว้ใน outputFileTracingIncludes ด้วย เพื่อให้ Vercel
  //      serverless bundler (@vercel/nft) copy ไฟล์ไปลง deployment จริง (local `next dev`/`next build` ไม่ผ่าน
  //      @vercel/nft จึงไม่เจอไฟล์หายตอน build เอง — ต้อง verify อีกรอบหลัง deploy จริงบน Vercel)
  //   ★ 2026-08-20 — ตัวอ่านสเตทเมนต์/แพลตฟอร์ม (auto-read + retry-locked) พังบน Vercel serverless
  //     (retry-locked 500 ตอน import, auto-read dynamic import throw เงียบ → ไฟล์เข้า OneDrive แต่ไม่ถูกอ่าน)
  //     เพราะ deps หนัก/มี native/asset ถูก webpack bundle แล้ว init ไม่ผ่านใน lambda → ประกาศ external
  //     ให้ Next ปล่อยเป็น native require + @vercel/nft copy node_modules จริงไปด้วย (แบบเดียวกับ sarabun)
  serverExternalPackages: [
    "@fontsource/sarabun",
    "pdf-parse",
    "pdfjs-dist",
    "sharp",
    "exceljs",
    "@anthropic-ai/sdk",
    "pdf-lib",
  ],
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/@fontsource/sarabun/files/sarabun-thai-400-normal.woff",
      "./node_modules/@fontsource/sarabun/files/sarabun-latin-400-normal.woff",
    ],
  },
  // ★ Server Action body cap: ดีฟอลต์ Next = 1MB → อัปไฟล์เอง (PDF/รูป/Excel) ที่เกิน 1MB
  //   จะโดนตัดก่อนถึงโค้ด (client validate ผ่านเพราะเช็คแค่ 15MB). ตั้งให้ครอบเพดานอัป 15MB
  //   + เผื่อ overhead ของ multipart form (ชื่อฟิลด์/boundary) = 20mb
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb",
    },
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
