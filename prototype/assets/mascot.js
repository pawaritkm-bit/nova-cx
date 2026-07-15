/* ============================================================
   NOVA-CX Prototype — Mascot "น้อง NOVA" = น้องโซโซ่เวอร์ชัน Finovas
   ★ ยึดดีไซน์ "น้องโซโซ่" (SO Growth / เครือ SO-Finovas) เพื่อความเป็นแบรนด์เดียวกัน
     - โครงหัว/หน้า/หู/ตา/แก้ม/จมูก/ยิ้ม/แว่น = น้องโซโซ่แบบ B (ตัวป่องกลม แก้มยุ้ย ตาโตหลังแว่น ยิ้มหวาน)
     - loaderScene = น้องโซโซ่แบบ C (ท่าวิ่ง + animation bob/legA/legB/arm/dust)
     - คงสีขนน้ำตาลของโซโซ่เดิม (ห้ามเปลี่ยน)
     - ปรับเป็นโทน Finovas: เน็คไทฟ้า/น้ำเงิน + เติมสูทน้ำเงินบางๆ (ปกสูท+เชิ้ตขาว V)
       + เปลี่ยน "แฟ้มกลยุทธ์เขียว" → "เครื่องคิดเลข" (นักบัญชี Finovas)
   API เดิม (ไม่เปลี่ยน): NOVA.head() / NOVA.full() / NOVA.icon() / NOVA.profile() / NOVA.loaderScene()
   ============================================================ */
(function (global) {
  // ---- สีขนน้ำตาลของน้องโซโซ่ (คงเดิม ห้ามเปลี่ยน) ----
  const FUR = "#b07f52", FUR_D = "#8a5f3c", FUR_DD = "#6b4425", BELLY = "#d9b489", NOSE = "#7a5233";
  const EYE = "#20120a", GLASS = "#2b3a33", CHEEK = "#e79b8f";
  // ---- โทน Finovas (แทนเขียว SO Growth) ----
  const NAVY = "#1e3a8a", NAVY_D = "#152a63", NAVY_2 = "#2563eb", SKY = "#38bdf8";

  /* ---------- หัวน้องโซโซ่ (แบบ B: แว่น + หน้า) ----------
     canonical: หัวศูนย์กลาง ~ (100,80) ในพิกัด viewBox 200 กว้าง
     opts: glasses (default true), smile (default true) */
  function head(opts) {
    opts = opts || {};
    const glasses = opts.glasses !== false;
    const smile = opts.smile !== false;
    return `
    <!-- หัวกลม แก้มยุ้ย -->
    <ellipse cx="100" cy="80" rx="60" ry="54" fill="${FUR}"/>
    <circle cx="60" cy="96" r="16" fill="${CHEEK}" opacity=".5"/>
    <circle cx="140" cy="96" r="16" fill="${CHEEK}" opacity=".5"/>
    <ellipse cx="100" cy="94" rx="36" ry="27" fill="${BELLY}"/>
    <!-- หูกลม -->
    <circle cx="56" cy="42" r="11" fill="${FUR_D}"/><circle cx="144" cy="42" r="11" fill="${FUR_D}"/>
    <circle cx="56" cy="42" r="5.5" fill="${FUR_DD}"/><circle cx="144" cy="42" r="5.5" fill="${FUR_DD}"/>
    ${glasses ? `
    <!-- แว่นตา (มืออาชีพ soft) -->
    <g stroke="${GLASS}" stroke-width="4" fill="none">
      <circle cx="78" cy="78" r="17" fill="#ffffff" fill-opacity=".85"/>
      <circle cx="122" cy="78" r="17" fill="#ffffff" fill-opacity=".85"/>
      <line x1="95" y1="78" x2="105" y2="78"/>
      <line x1="61" y1="74" x2="48" y2="66"/><line x1="139" y1="74" x2="152" y2="66"/>
    </g>` : ``}
    <!-- ตาโตหลังแว่น + ประกาย -->
    <circle cx="78" cy="80" r="6.5" fill="${EYE}"/><circle cx="122" cy="80" r="6.5" fill="${EYE}"/>
    <circle cx="80.5" cy="77" r="2.2" fill="#fff"/><circle cx="124.5" cy="77" r="2.2" fill="#fff"/>
    <!-- จมูก 2 จุด + ยิ้มหวาน (ไม่มีฟัน) -->
    <ellipse cx="100" cy="104" rx="11" ry="7.5" fill="${NOSE}"/>
    <ellipse cx="94.5" cy="103" rx="2.2" ry="3" fill="#3a2415"/><ellipse cx="105.5" cy="103" rx="2.2" ry="3" fill="#3a2415"/>
    ${smile ? `<path d="M86 115 q14 11 28 0" stroke="${FUR_DD}" stroke-width="3" fill="none" stroke-linecap="round"/>` : ``}
    `;
  }

  // เครื่องคิดเลข (แทนแฟ้มกลยุทธ์) — วาดในกล่องท้องถิ่น มุมซ้ายบน (0,0) ขนาด ~42x54
  function calculator(classAttr) {
    return `
    <g class="${classAttr || ''}">
      <rect x="0" y="0" width="42" height="54" rx="6" fill="${NAVY_2}" stroke="${NAVY_D}" stroke-width="2.5"/>
      <rect x="6" y="6" width="30" height="13" rx="3" fill="#d6f2ff"/>
      <text x="34" y="16" text-anchor="end" font-size="8.5" font-weight="700" fill="#0c4a6e" font-family="monospace">1,240</text>
      <g fill="#eef2ff">
        <rect x="6" y="24" width="8" height="7" rx="1.6"/><rect x="17" y="24" width="8" height="7" rx="1.6"/><rect x="28" y="24" width="8" height="7" rx="1.6"/>
        <rect x="6" y="34" width="8" height="7" rx="1.6"/><rect x="17" y="34" width="8" height="7" rx="1.6"/><rect x="28" y="34" width="8" height="7" rx="1.6"/>
        <rect x="6" y="44" width="8" height="7" rx="1.6"/><rect x="17" y="44" width="8" height="7" rx="1.6"/>
      </g>
      <rect x="28" y="44" width="8" height="7" rx="1.6" fill="#f59e0b"/>
    </g>`;
  }

  // สูทน้ำเงินบางๆ (ปกสูท + เชิ้ตขาว V) + เน็คไท Finovas — คลุมช่วงบนบนตัวโซโซ่
  function suitTie() {
    return `
    <!-- เชิ้ตขาว V -->
    <path d="M100 122 L86 176 L100 166 L114 176 Z" fill="#ffffff"/>
    <!-- ปกสูทน้ำเงิน 2 ข้าง -->
    <path d="M100 122 L80 140 L96 172 Z" fill="${NAVY}"/>
    <path d="M100 122 L120 140 L104 172 Z" fill="${NAVY}"/>
    <!-- เน็คไท (ฟ้า/น้ำเงิน Finovas) -->
    <path d="M100 130 l9 10 -9 10 -9 -10 z" fill="${SKY}"/>
    <path d="M100 150 l7 26 -7 7 -7 -7 z" fill="${NAVY_2}"/>`;
  }

  const NOVA = {
    head,

    // Full character — น้องโซโซ่ B ยืน + สูทน้ำเงินบาง + เน็คไทฟ้า + ถือเครื่องคิดเลข
    full(w) {
      w = w || 240;
      return `<svg class="nova-svg" viewBox="0 0 200 220" width="${w}" role="img"
        aria-label="น้อง NOVA (โซโซ่เวอร์ชัน Finovas) ใส่แว่น สูทน้ำเงิน ถือเครื่องคิดเลข ยืนยิ้ม">
        <!-- ตัวป่องกลม + ท้อง -->
        <ellipse cx="100" cy="142" rx="66" ry="64" fill="${FUR}"/>
        <ellipse cx="100" cy="154" rx="46" ry="44" fill="${BELLY}"/>
        <!-- ขาสั้น -->
        <ellipse cx="76" cy="200" rx="15" ry="11" fill="${FUR_D}"/>
        <ellipse cx="124" cy="200" rx="15" ry="11" fill="${FUR_D}"/>
        <!-- สูท + เชิ้ต + เน็คไท -->
        ${suitTie()}
        <!-- แขนถือเครื่องคิดเลขข้างลำตัว -->
        <ellipse cx="150" cy="150" rx="15" ry="24" fill="${FUR}" transform="rotate(14 150 150)"/>
        <g transform="translate(133,126) rotate(8)">${calculator()}</g>
        <!-- หัวโซโซ่ B -->
        ${head()}
      </svg>`;
    },

    // Icon — หัวโซโซ่ (แว่น) (Rich Menu / ปุ่ม / favicon)
    icon(w) {
      w = w || 64;
      return `<svg class="nova-svg" viewBox="36 22 128 124" width="${w}" role="img" aria-label="ไอคอนน้อง NOVA">
        ${head()}
      </svg>`;
    },

    // Profile — avatar วงกลม (การ์ด/แชต)
    profile(w) {
      w = w || 56;
      return `<svg class="nova-svg" viewBox="0 0 160 160" width="${w}" height="${w}" role="img" aria-label="โปรไฟล์น้อง NOVA">
        <circle cx="80" cy="80" r="77" fill="#dbeafe" stroke="${NAVY}" stroke-width="4"/>
        <g transform="translate(-13,7) scale(0.92)">${head()}</g>
      </svg>`;
    },

    // Loading — น้องโซโซ่ C ท่าวิ่ง + สูท/ไทฟ้า + ถือเครื่องคิดเลข (animation ใน nova.css: nv-*)
    loaderScene() {
      return `
      <div class="nova-loader" aria-label="กำลังโหลด น้อง NOVA">
        <svg class="nova-svg" viewBox="0 0 200 220" width="150" role="img" aria-label="น้อง NOVA กำลังวิ่ง">
          <g class="nv-bob">
            <!-- ขาวิ่งสลับซ้าย-ขวา -->
            <ellipse class="nv-leg nv-legB" cx="74" cy="180" rx="13" ry="24" fill="${FUR_D}"/>
            <ellipse class="nv-leg nv-legA" cx="112" cy="180" rx="13" ry="24" fill="${FUR}"/>
            <!-- ตัวป่องกลม เอียงไปข้างหน้าเล็กน้อย -->
            <g transform="rotate(-6 100 140)">
              <ellipse cx="100" cy="138" rx="64" ry="58" fill="${FUR}"/>
              <ellipse cx="100" cy="150" rx="44" ry="40" fill="${BELLY}"/>
              <!-- สูท V + เชิ้ตขาว + ไทปลิว (ฟ้า Finovas) -->
              <path d="M100 118 L88 168 L100 158 L112 168 Z" fill="#ffffff"/>
              <path d="M100 118 L82 132 L96 162 Z" fill="${NAVY}"/>
              <path d="M100 118 L118 132 L104 162 Z" fill="${NAVY}"/>
              <path d="M96 124 l9 9 -6 10 -10 -8 z" fill="${SKY}"/>
              <path d="M99 143 l10 20 -8 5 -6 -8 z" fill="${NAVY_2}"/>
            </g>
            <!-- หัวโซโซ่ เอียงไปข้างหน้า -->
            <g transform="rotate(-4 100 74)">${head()}</g>
            <!-- แขนแกว่งถือเครื่องคิดเลข -->
            <g class="nv-arm">
              <ellipse cx="150" cy="120" rx="13" ry="22" fill="${FUR}" transform="rotate(30 150 120)"/>
              <g transform="translate(139,86) rotate(20)">${calculator()}</g>
            </g>
          </g>
          <!-- ฝุ่นวิ่ง -->
          <g fill="#cbb892">
            <circle class="nv-dust" cx="56" cy="200" r="6"/>
            <circle class="nv-dust" cx="44" cy="196" r="4.5" style="animation-delay:.15s"/>
            <circle class="nv-dust" cx="64" cy="204" r="3.5" style="animation-delay:.3s"/>
          </g>
        </svg>
      </div>`;
    }
  };

  global.NOVA = NOVA;
})(window);
