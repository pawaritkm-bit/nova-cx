"use client";

/**
 * NovaMascot — น้อง NOVA (น้องโซโซ่เวอร์ชัน Finovas): คาปิบาร่าใส่แว่น สูทน้ำเงิน ถือเครื่องคิดเลข
 *
 * พอร์ตมาจาก prototype/assets/mascot.js (source of truth ที่ผู้ใช้อนุมัติแล้ว) แบบ 1:1
 *   - พิกัด/สี/รูปทรงทุกจุดตรงกับต้นแบบเป๊ะ (ห้ามออกแบบใหม่ ผู้ใช้ปรับจนพอใจแล้ว)
 *   - variant "loader" = ท่าวิ่ง (loaderScene แบบ C) + แอนิเมชัน nv-* จาก prototype/assets/nova.css
 *   - variant "full"   = ยืนยิ้ม (full) ใช้ในหน้าส่งสำเร็จ
 * แอนิเมชันวิ่ง (bob/legA/legB/arm/dust) นิยามใน liff.css คลาส nv-* เหมือนต้นแบบ
 */

// ---- สีขนน้ำตาลของน้องโซโซ่ (คงเดิม ห้ามเปลี่ยน) ----
const FUR = "#b07f52";
const FUR_D = "#8a5f3c";
const FUR_DD = "#6b4425";
const BELLY = "#d9b489";
const NOSE = "#7a5233";
const EYE = "#20120a";
const GLASS = "#2b3a33";
const CHEEK = "#e79b8f";
// ---- โทน Finovas (เน็คไท/สูท/เครื่องคิดเลข) ----
const NAVY = "#1e3a8a";
const NAVY_D = "#152a63";
const NAVY_2 = "#2563eb";
const SKY = "#38bdf8";

/** หัวน้องโซโซ่ (แบบ B: แว่น + หน้ายิ้ม) — ศูนย์กลาง ~(100,80) ใน viewBox กว้าง 200 */
function Head({ glasses = true, smile = true }: { glasses?: boolean; smile?: boolean }) {
  return (
    <>
      {/* หัวกลม แก้มยุ้ย */}
      <ellipse cx="100" cy="80" rx="60" ry="54" fill={FUR} />
      <circle cx="60" cy="96" r="16" fill={CHEEK} opacity="0.5" />
      <circle cx="140" cy="96" r="16" fill={CHEEK} opacity="0.5" />
      <ellipse cx="100" cy="94" rx="36" ry="27" fill={BELLY} />
      {/* หูกลม */}
      <circle cx="56" cy="42" r="11" fill={FUR_D} />
      <circle cx="144" cy="42" r="11" fill={FUR_D} />
      <circle cx="56" cy="42" r="5.5" fill={FUR_DD} />
      <circle cx="144" cy="42" r="5.5" fill={FUR_DD} />
      {/* แว่นตา (มืออาชีพ soft) */}
      {glasses && (
        <g stroke={GLASS} strokeWidth="4" fill="none">
          <circle cx="78" cy="78" r="17" fill="#ffffff" fillOpacity="0.85" />
          <circle cx="122" cy="78" r="17" fill="#ffffff" fillOpacity="0.85" />
          <line x1="95" y1="78" x2="105" y2="78" />
          <line x1="61" y1="74" x2="48" y2="66" />
          <line x1="139" y1="74" x2="152" y2="66" />
        </g>
      )}
      {/* ตาโตหลังแว่น + ประกาย */}
      <circle cx="78" cy="80" r="6.5" fill={EYE} />
      <circle cx="122" cy="80" r="6.5" fill={EYE} />
      <circle cx="80.5" cy="77" r="2.2" fill="#fff" />
      <circle cx="124.5" cy="77" r="2.2" fill="#fff" />
      {/* จมูก 2 จุด + ยิ้มหวาน (ไม่มีฟัน) */}
      <ellipse cx="100" cy="104" rx="11" ry="7.5" fill={NOSE} />
      <ellipse cx="94.5" cy="103" rx="2.2" ry="3" fill="#3a2415" />
      <ellipse cx="105.5" cy="103" rx="2.2" ry="3" fill="#3a2415" />
      {smile && (
        <path d="M86 115 q14 11 28 0" stroke={FUR_DD} strokeWidth="3" fill="none" strokeLinecap="round" />
      )}
    </>
  );
}

/** เครื่องคิดเลข (นักบัญชี Finovas) — วาดในกล่องท้องถิ่นมุมซ้ายบน (0,0) ~42x54 */
function Calculator() {
  return (
    <g>
      <rect x="0" y="0" width="42" height="54" rx="6" fill={NAVY_2} stroke={NAVY_D} strokeWidth="2.5" />
      <rect x="6" y="6" width="30" height="13" rx="3" fill="#d6f2ff" />
      <text x="34" y="16" textAnchor="end" fontSize="8.5" fontWeight="700" fill="#0c4a6e" fontFamily="monospace">
        1,240
      </text>
      <g fill="#eef2ff">
        <rect x="6" y="24" width="8" height="7" rx="1.6" />
        <rect x="17" y="24" width="8" height="7" rx="1.6" />
        <rect x="28" y="24" width="8" height="7" rx="1.6" />
        <rect x="6" y="34" width="8" height="7" rx="1.6" />
        <rect x="17" y="34" width="8" height="7" rx="1.6" />
        <rect x="28" y="34" width="8" height="7" rx="1.6" />
        <rect x="6" y="44" width="8" height="7" rx="1.6" />
        <rect x="17" y="44" width="8" height="7" rx="1.6" />
      </g>
      <rect x="28" y="44" width="8" height="7" rx="1.6" fill="#f59e0b" />
    </g>
  );
}

/** สูทน้ำเงิน + เชิ้ตขาว V + เน็คไท Finovas (สำหรับท่ายืน full) */
function SuitTie() {
  return (
    <>
      <path d="M100 122 L86 176 L100 166 L114 176 Z" fill="#ffffff" />
      <path d="M100 122 L80 140 L96 172 Z" fill={NAVY} />
      <path d="M100 122 L120 140 L104 172 Z" fill={NAVY} />
      <path d="M100 130 l9 10 -9 10 -9 -10 z" fill={SKY} />
      <path d="M100 150 l7 26 -7 7 -7 -7 z" fill={NAVY_2} />
    </>
  );
}

/** ท่าวิ่ง (loaderScene แบบ C) — bob/legA/legB/arm/dust แอนิเมชันใน liff.css */
function LoaderScene({ width }: { width: number }) {
  return (
    <div className="nova-loader" aria-label="กำลังโหลด น้อง NOVA">
      <svg
        className="nova-svg"
        viewBox="0 0 200 220"
        width={width}
        role="img"
        aria-label="น้อง NOVA กำลังวิ่ง"
      >
        <g className="nv-bob">
          {/* ขาวิ่งสลับซ้าย-ขวา */}
          <ellipse className="nv-leg nv-legB" cx="74" cy="180" rx="13" ry="24" fill={FUR_D} />
          <ellipse className="nv-leg nv-legA" cx="112" cy="180" rx="13" ry="24" fill={FUR} />
          {/* ตัวป่องกลม เอียงไปข้างหน้าเล็กน้อย */}
          <g transform="rotate(-6 100 140)">
            <ellipse cx="100" cy="138" rx="64" ry="58" fill={FUR} />
            <ellipse cx="100" cy="150" rx="44" ry="40" fill={BELLY} />
            {/* สูท V + เชิ้ตขาว + ไทปลิว (ฟ้า Finovas) */}
            <path d="M100 118 L88 168 L100 158 L112 168 Z" fill="#ffffff" />
            <path d="M100 118 L82 132 L96 162 Z" fill={NAVY} />
            <path d="M100 118 L118 132 L104 162 Z" fill={NAVY} />
            <path d="M96 124 l9 9 -6 10 -10 -8 z" fill={SKY} />
            <path d="M99 143 l10 20 -8 5 -6 -8 z" fill={NAVY_2} />
          </g>
          {/* หัวโซโซ่ เอียงไปข้างหน้า */}
          <g transform="rotate(-4 100 74)">
            <Head />
          </g>
          {/* แขนแกว่งถือเครื่องคิดเลข */}
          <g className="nv-arm">
            <ellipse cx="150" cy="120" rx="13" ry="22" fill={FUR} transform="rotate(30 150 120)" />
            <g transform="translate(139,86) rotate(20)">
              <Calculator />
            </g>
          </g>
        </g>
        {/* ฝุ่นวิ่ง */}
        <g fill="#cbb892">
          <circle className="nv-dust" cx="56" cy="200" r="6" />
          <circle className="nv-dust" cx="44" cy="196" r="4.5" style={{ animationDelay: "0.15s" }} />
          <circle className="nv-dust" cx="64" cy="204" r="3.5" style={{ animationDelay: "0.3s" }} />
        </g>
      </svg>
    </div>
  );
}

/** ท่ายืนยิ้ม (full) — ถือเครื่องคิดเลขข้างลำตัว */
function FullPose({ width }: { width: number }) {
  return (
    <svg
      className="nova-svg"
      viewBox="0 0 200 220"
      width={width}
      role="img"
      aria-label="น้อง NOVA ใส่แว่น สูทน้ำเงิน ถือเครื่องคิดเลข ยืนยิ้ม"
    >
      {/* ตัวป่องกลม + ท้อง */}
      <ellipse cx="100" cy="142" rx="66" ry="64" fill={FUR} />
      <ellipse cx="100" cy="154" rx="46" ry="44" fill={BELLY} />
      {/* ขาสั้น */}
      <ellipse cx="76" cy="200" rx="15" ry="11" fill={FUR_D} />
      <ellipse cx="124" cy="200" rx="15" ry="11" fill={FUR_D} />
      {/* สูท + เชิ้ต + เน็คไท */}
      <SuitTie />
      {/* แขนถือเครื่องคิดเลขข้างลำตัว */}
      <ellipse cx="150" cy="150" rx="15" ry="24" fill={FUR} transform="rotate(14 150 150)" />
      <g transform="translate(133,126) rotate(8)">
        <Calculator />
      </g>
      {/* หัวโซโซ่ B */}
      <Head />
    </svg>
  );
}

export default function NovaMascot({
  variant = "loader",
  width = 150,
}: {
  variant?: "loader" | "full";
  width?: number;
}) {
  return variant === "full" ? <FullPose width={width} /> : <LoaderScene width={width} />;
}
