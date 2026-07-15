/* ============================================================
   NOVA-CX Prototype — Mascot "น้อง NOVA" (คาปิบาร่า / capybara)
   ★ สไตล์ใหม่: สติกเกอร์วาดมือ ลายเส้นขอบหนา เอิร์ธโทน ขนน้ำตาลไล่เฉด
   ออกแบบใหม่เอง (อิงสไตล์ความน่ารักเท่านั้น ห้ามลอกตรงๆ — ข้อกำหนด C-05)
   ลักษณะ: ตัวกลมป้อมนุ่ม เส้นขอบหนาสีเข้ม ขนน้ำตาลอุ่นไล่เฉด (หลัง/หัวเข้ม → ท้อง/หน้าอ่อน)
           หูกลมเล็ก ปากกระบอกใหญ่มน รูจมูก 2 จุด ยิ้มอ่อนโยน (ไม่มีฟัน)
           ใส่แว่นกรอบมน + สูทน้ำเงิน Finovas + เชิ้ตขาว + เน็คไทฟ้า
           ช่วงล่างเป็นตัว/ขาคาปิบาร่าขนน้ำตาลตามธรรมชาติ (ไม่มีกางเกง/เข็มขัด) + ถือเครื่องคิดเลข
   API เดิม (ไม่เปลี่ยน): NOVA.head() / NOVA.full() / NOVA.icon() / NOVA.profile() / NOVA.loaderScene()
   ============================================================ */
(function (global) {
  // เส้นขอบหนาสไตล์วาดมือ (น้ำตาลเข้มเอิร์ธโทน)
  const OL = "#3a2f24";
  // ขนน้ำตาลอุ่น (ใช้ gradient ไล่เฉด)
  const FUR_TOP = "#b07a45";   // หลัง/หัวเข้ม
  const FUR_MID = "#c79459";
  const FUR_LOW = "#dcab72";   // ท้อง/หน้าอ่อน
  const MUZZLE  = "#ecd3ad";   // ปากกระบอกสว่าง
  const NOSE    = "#4a3122";
  const EYE     = "#2b1a10";
  const CHEEK   = "#eb9e88";
  // แบรนด์ Finovas
  const NAVY = "#1e3a8a", NAVY_D = "#152a63", NAVY_2 = "#2563eb", SKY = "#38bdf8";

  // gradient defs (id คงที่ — ซ้ำได้เพราะนิยามเหมือนกันทุก SVG)
  function defs() {
    return `<defs>
      <linearGradient id="nfHead" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${FUR_TOP}"/><stop offset="1" stop-color="${FUR_LOW}"/>
      </linearGradient>
      <linearGradient id="nfBody" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${FUR_MID}"/><stop offset="1" stop-color="${FUR_LOW}"/>
      </linearGradient>
    </defs>`;
  }

  /* ---------- หัวคาปิบาร่า (สติกเกอร์ลายเส้นหนา, ใส่แว่นเป็นค่าเริ่มต้น) ----------
     canonical: หัวศูนย์กลาง ~ (120,108), ครอบคลุม x40..200 y34..184
     ต้องใช้ในกรอบ SVG ที่มี defs() (มี gradient nfHead) */
  function head(opts) {
    opts = opts || {};
    const glasses = opts.glasses !== false;
    const smile = opts.smile !== false;
    return `
    <!-- หูกลมเล็กสองข้าง -->
    <ellipse cx="80"  cy="54" rx="19" ry="17" fill="${FUR_TOP}" stroke="${OL}" stroke-width="5"/>
    <ellipse cx="160" cy="54" rx="19" ry="17" fill="${FUR_TOP}" stroke="${OL}" stroke-width="5"/>
    <ellipse cx="80"  cy="57" rx="9" ry="8" fill="${NOSE}" opacity=".4"/>
    <ellipse cx="160" cy="57" rx="9" ry="8" fill="${NOSE}" opacity=".4"/>
    <!-- หัวกลมป้อม ขอบมนออร์แกนิก เส้นหนา -->
    <path d="M120 38 C 70 38, 44 72, 46 112 C 48 155, 82 184, 120 184
             C 158 184, 192 155, 194 112 C 196 72, 170 38, 120 38 Z"
          fill="url(#nfHead)" stroke="${OL}" stroke-width="6" stroke-linejoin="round"/>
    <!-- ปากกระบอกใหญ่มนนุ่ม (สว่างกว่า) -->
    <ellipse cx="120" cy="142" rx="50" ry="39" fill="${MUZZLE}"/>
    <!-- แก้มชมพูจางนุ่ม -->
    <ellipse cx="70"  cy="134" rx="13" ry="9" fill="${CHEEK}" opacity=".5"/>
    <ellipse cx="170" cy="134" rx="13" ry="9" fill="${CHEEK}" opacity=".5"/>
    <!-- รูจมูก 2 จุดเล็ก -->
    <ellipse cx="109" cy="130" rx="4" ry="5" fill="${NOSE}"/>
    <ellipse cx="131" cy="130" rx="4" ry="5" fill="${NOSE}"/>
    ${smile ? `
    <!-- ร่องปาก + ยิ้มโค้งอ่อนโยน (ไม่มีฟัน) -->
    <path d="M120 132 L120 145" fill="none" stroke="${OL}" stroke-width="3" stroke-linecap="round"/>
    <path d="M103 146 Q120 160 137 146" fill="none" stroke="${OL}" stroke-width="4" stroke-linecap="round"/>` : ``}
    <!-- ตากลมโตใสซื่อ + ประกาย -->
    <circle cx="95"  cy="101" r="12.5" fill="${EYE}"/>
    <circle cx="145" cy="101" r="12.5" fill="${EYE}"/>
    <circle cx="99"  cy="96"  r="4" fill="#ffffff"/>
    <circle cx="149" cy="96"  r="4" fill="#ffffff"/>
    <circle cx="91"  cy="105" r="2" fill="#ffffff" opacity=".85"/>
    <circle cx="141" cy="105" r="2" fill="#ffffff" opacity=".85"/>
    ${glasses ? `
    <!-- แว่นกรอบมนกลม ลายเส้นหนา -->
    <circle cx="95"  cy="101" r="21" fill="none" stroke="${OL}" stroke-width="5.5"/>
    <circle cx="145" cy="101" r="21" fill="none" stroke="${OL}" stroke-width="5.5"/>
    <path d="M116 99 Q120 95 124 99" fill="none" stroke="${OL}" stroke-width="5"/>
    <line x1="74"  y1="97" x2="58"  y2="90" stroke="${OL}" stroke-width="4.5" stroke-linecap="round"/>
    <line x1="166" y1="97" x2="182" y2="90" stroke="${OL}" stroke-width="4.5" stroke-linecap="round"/>` : ``}
    `;
  }

  // เครื่องคิดเลข (ลายเส้นหนา) — วางที่ origin, ใส่ classAttr เพื่อ animation ตอน loading
  function calculator(classAttr) {
    return `
    <g class="${classAttr || ''}">
      <rect x="-24" y="-32" width="48" height="64" rx="11" fill="${NAVY_2}" stroke="${OL}" stroke-width="4.5"/>
      <rect x="-16" y="-24" width="32" height="15" rx="4" fill="#d6f2ff" stroke="${OL}" stroke-width="2.5"/>
      <text x="12" y="-13" text-anchor="end" font-size="9" font-weight="700" fill="#0c4a6e" font-family="monospace">1,240</text>
      <g fill="#eef2ff" stroke="${OL}" stroke-width="1.6">
        <rect x="-16" y="-3" width="9" height="8" rx="2"/><rect x="-3.5" y="-3" width="9" height="8" rx="2"/><rect x="9" y="-3" width="9" height="8" rx="2"/>
        <rect x="-16" y="9"  width="9" height="8" rx="2"/><rect x="-3.5" y="9"  width="9" height="8" rx="2"/><rect x="9" y="9"  width="9" height="8" rx="2"/>
        <rect x="-16" y="21" width="9" height="8" rx="2"/><rect x="-3.5" y="21" width="9" height="8" rx="2"/>
      </g>
      <rect x="9" y="21" width="9" height="8" rx="2" fill="#f59e0b" stroke="${OL}" stroke-width="1.6"/>
    </g>`;
  }

  /* ---------- เสื้อสูท + เชิ้ต + ไท (คลุมช่วงบน) ---------- */
  function jacket() {
    return `
    <!-- เสื้อสูทน้ำเงิน คลุมไหล่-อก เว้า V กลาง -->
    <path d="M120 168 C 82 166, 64 190, 64 224 C 64 250, 76 266, 92 272
             L 120 258 L 148 272 C 164 266, 176 250, 176 224
             C 176 190, 158 166, 120 168 Z"
          fill="${NAVY}" stroke="${OL}" stroke-width="6" stroke-linejoin="round"/>
    <!-- เชิ้ตขาว (สามเหลี่ยมกลางอก) -->
    <path d="M120 174 L104 262 L120 250 L136 262 Z" fill="#ffffff" stroke="${OL}" stroke-width="3"/>
    <!-- ปกสูท (lapel) -->
    <path d="M120 172 L100 182 L116 216 Z" fill="${NAVY_D}" stroke="${OL}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M120 172 L140 182 L124 216 Z" fill="${NAVY_D}" stroke="${OL}" stroke-width="3" stroke-linejoin="round"/>
    <!-- เน็คไทฟ้าแบรนด์ -->
    <path d="M113 180 L120 174 L127 180 L122 190 L118 190 Z" fill="${SKY}" stroke="${OL}" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M118 190 L122 190 L127 246 L120 256 L113 246 Z" fill="${SKY}" stroke="${OL}" stroke-width="2.5" stroke-linejoin="round"/>`;
  }

  const NOVA = {
    head,

    // Full character — คาปิบาร่ายืนเต็มตัว ถือเครื่องคิดเลข (welcome/confirmation)
    full(w) {
      w = w || 240;
      return `<svg class="nova-svg" viewBox="0 0 240 372" width="${w}" role="img"
        aria-label="น้อง NOVA คาปิบาร่าใส่สูทน้ำเงิน ใส่แว่น ถือเครื่องคิดเลข ยืนเต็มตัว">
        ${defs()}
        <!-- เงาใต้เท้า -->
        <ellipse cx="120" cy="356" rx="76" ry="12" fill="${NAVY_D}" opacity=".12"/>
        <!-- ตัว/ท้องคาปิบาร่า ทรงไข่กลมป้อม ขนน้ำตาลไล่เฉด -->
        <path d="M120 166 C 72 164, 50 206, 50 262 C 50 320, 80 352, 120 354
                 C 160 352, 190 320, 190 262 C 190 206, 168 164, 120 166 Z"
              fill="url(#nfBody)" stroke="${OL}" stroke-width="6" stroke-linejoin="round"/>
        <!-- แขนซ้าย (แขนเสื้อสูท + อุ้งมือขน) -->
        <path d="M72 214 C 50 224, 44 262, 54 288 C 62 300, 78 296, 80 282
                 C 74 258, 82 232, 96 222 Z" fill="${NAVY}" stroke="${OL}" stroke-width="6" stroke-linejoin="round"/>
        <ellipse cx="64" cy="292" rx="16" ry="14" fill="url(#nfBody)" stroke="${OL}" stroke-width="5"/>
        <!-- เท้าคาปิบาร่าสองข้าง -->
        <ellipse cx="97"  cy="352" rx="25" ry="14" fill="url(#nfBody)" stroke="${OL}" stroke-width="5.5"/>
        <ellipse cx="143" cy="352" rx="25" ry="14" fill="url(#nfBody)" stroke="${OL}" stroke-width="5.5"/>
        <g stroke="${OL}" stroke-width="2.5" stroke-linecap="round">
          <line x1="88"  y1="356" x2="88"  y2="363"/><line x1="97"  y1="357" x2="97"  y2="364"/><line x1="106" y1="356" x2="106" y2="363"/>
          <line x1="134" y1="356" x2="134" y2="363"/><line x1="143" y1="357" x2="143" y2="364"/><line x1="152" y1="356" x2="152" y2="363"/>
        </g>
        <!-- สูท + เชิ้ต + ไท -->
        ${jacket()}
        <!-- แขนขวา (ยกถือเครื่องคิดเลขไว้หน้าท้อง) -->
        <path d="M170 214 C 194 222, 202 256, 192 282 C 184 294, 170 290, 168 278
                 C 176 254, 166 232, 150 224 Z" fill="${NAVY}" stroke="${OL}" stroke-width="6" stroke-linejoin="round"/>
        <g transform="translate(150,286) rotate(-6)">${calculator()}</g>
        <ellipse cx="150" cy="300" rx="16" ry="14" fill="url(#nfBody)" stroke="${OL}" stroke-width="5"/>
        <!-- หัวโต วางบนบ่า -->
        <g transform="translate(0,-4)">${head()}</g>
      </svg>`;
    },

    // Icon — หัวลายเส้นหนา ใส่แว่น (Rich Menu / ปุ่ม / favicon)
    icon(w) {
      w = w || 64;
      return `<svg class="nova-svg" viewBox="34 30 172 168" width="${w}" role="img" aria-label="ไอคอนน้อง NOVA คาปิบาร่า">
        ${defs()}
        ${head()}
      </svg>`;
    },

    // Profile — avatar วงกลม (การ์ด/แชต)
    profile(w) {
      w = w || 56;
      return `<svg class="nova-svg" viewBox="0 0 160 160" width="${w}" height="${w}" role="img" aria-label="โปรไฟล์น้อง NOVA คาปิบาร่า">
        ${defs()}
        <circle cx="80" cy="80" r="77" fill="#dbeafe" stroke="${NAVY}" stroke-width="4"/>
        <g transform="translate(-25,-24) scale(0.88)">${head()}</g>
      </svg>`;
    },

    // Loading — คาปิบาร่าวิ่ง (คงให้ทำงานได้/ไม่พัง; จูนละเอียดหลังอนุมัติหน้าตา)
    loaderScene() {
      return `
      <div class="nova-loader" aria-label="กำลังโหลด น้อง NOVA">
        <div class="nova-speed l1"></div>
        <div class="nova-speed l2"></div>
        <div class="nova-speed l3"></div>
        <div class="nova-doc d1"></div>
        <div class="nova-doc d2"></div>
        <div class="nova-doc d3"></div>
        <div class="nova-run">
          <svg class="nova-svg" viewBox="0 0 240 248" width="150" role="img" aria-label="น้อง NOVA คาปิบาร่ากำลังวิ่ง">
            ${defs()}
            <!-- ขาวิ่งสลับซ้าย-ขวา (แยกชิ้น animate ได้) -->
            <g class="nova-leg nova-leg-l">
              <ellipse cx="103" cy="232" rx="16" ry="11" fill="url(#nfBody)" stroke="${OL}" stroke-width="5"/>
            </g>
            <g class="nova-leg nova-leg-r">
              <ellipse cx="137" cy="232" rx="16" ry="11" fill="url(#nfBody)" stroke="${OL}" stroke-width="5"/>
            </g>
            <!-- ตัวป้อมย่อ ขนน้ำตาลไล่เฉด -->
            <ellipse cx="120" cy="184" rx="56" ry="48" fill="url(#nfBody)" stroke="${OL}" stroke-width="6"/>
            <!-- เสื้อสูท+เชิ้ต+ไทย่อ -->
            <path d="M120 150 C 92 150, 78 172, 82 196 L 120 210 L 158 196 C 162 172, 148 150, 120 150 Z"
                  fill="${NAVY}" stroke="${OL}" stroke-width="5"/>
            <path d="M120 156 L108 206 L120 198 L132 206 Z" fill="#fff" stroke="${OL}" stroke-width="2.5"/>
            <path d="M120 160 L113 172 L120 200 L127 172 Z" fill="${SKY}" stroke="${OL}" stroke-width="2.5"/>
            <!-- แขนถือเครื่องคิดเลข (สั่น) -->
            <g transform="translate(176,182) scale(.66)">${calculator('nova-calc-shake')}</g>
            <ellipse cx="172" cy="196" rx="13" ry="11" fill="url(#nfBody)" stroke="${OL}" stroke-width="4.5"/>
            <!-- หัวโต -->
            <g transform="translate(0,-6)">${head()}</g>
          </svg>
        </div>
      </div>`;
    }
  };

  global.NOVA = NOVA;
})(window);
