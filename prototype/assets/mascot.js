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
    <!-- ตาหลับยิ้มพริ้ม (โค้งนุ่ม ‿ อารมณ์ผ่อนคลาย มีความสุข) -->
    <path d="M83 104 Q95 92 107 104" fill="none" stroke="${EYE}" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M133 104 Q145 92 157 104" fill="none" stroke="${EYE}" stroke-width="4.5" stroke-linecap="round"/>
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

  /* ---------- หัวคาปิบาร่า มุม 3/4 หันเฉียงไปทางซ้าย ----------
     canonical: ครอบคลุม x40..200 y34..184 ; ปากกระบอกยื่นออกทางซ้าย
     ใช้กับ full()/preview ; ต้องอยู่ในกรอบ SVG ที่มี defs() */
  function headSide(opts) {
    opts = opts || {};
    const glasses = opts.glasses !== false;
    const smile = opts.smile !== false;
    return `
    <!-- หูไกล (ขวา) เล็ก โผล่หลังหัว -->
    <ellipse cx="166" cy="60" rx="15" ry="14" fill="${FUR_MID}" stroke="${OL}" stroke-width="5"/>
    <ellipse cx="166" cy="62" rx="7" ry="6" fill="${NOSE}" opacity=".35"/>
    <!-- หัวกลมกระชับ (มุม 3/4 เอียงซ้าย) — ลดหน้าผากโล่ง หัวไม่ใหญ่โบ๋ -->
    <path d="M136 50 C 96 48, 64 68, 60 108 C 56 148, 82 177, 122 178
             C 160 179, 189 153, 189 112 C 189 76, 176 52, 136 50 Z"
          fill="url(#nfHead)" stroke="${OL}" stroke-width="6" stroke-linejoin="round"/>
    <!-- หูใกล้ (ซ้าย) เด่นกว่า -->
    <ellipse cx="96" cy="52" rx="20" ry="18" fill="${FUR_TOP}" stroke="${OL}" stroke-width="5.5"/>
    <ellipse cx="96" cy="55" rx="9" ry="8" fill="${NOSE}" opacity=".4"/>
    <!-- ปากกระบอกย่อ กลมกลืนต่อเนื่องกับหน้า ยื่นออกซ้ายพองาม (โคนอยู่ใต้ตาพอดี) -->
    <ellipse cx="86" cy="128" rx="38" ry="30" fill="${MUZZLE}"/>
    <!-- แก้มชมพู -->
    <ellipse cx="120" cy="136" rx="13" ry="9" fill="${CHEEK}" opacity=".5"/>
    <ellipse cx="170" cy="118" rx="10" ry="7" fill="${CHEEK}" opacity=".35"/>
    <!-- รูจมูก 2 จุดเล็ก (บนซ้ายของ muzzle) -->
    <ellipse cx="66" cy="120" rx="4" ry="5" fill="${NOSE}"/>
    <ellipse cx="82" cy="116" rx="4" ry="5" fill="${NOSE}"/>
    ${smile ? `
    <!-- ร่องปาก + ยิ้มโค้งอ่อนโยน (ไม่มีฟัน) -->
    <path d="M74 124 L82 130" fill="none" stroke="${OL}" stroke-width="3" stroke-linecap="round"/>
    <path d="M66 136 Q88 150 110 140" fill="none" stroke="${OL}" stroke-width="4" stroke-linecap="round"/>` : ``}
    <!-- ตาหลับยิ้ม (‿) วางเหนือ muzzle นิดเดียว — ใกล้(ซ้าย)เด่น, ไกล(ขวา)สั้นกว่าตามมุม -->
    <path d="M92 100 Q102 91 112 100" fill="none" stroke="${EYE}" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M138 98 Q146 90 154 98" fill="none" stroke="${EYE}" stroke-width="4" stroke-linecap="round"/>
    ${glasses ? `
    <!-- แว่นกลม: เลนส์ใกล้(ซ้าย)เต็มวง + เลนส์ไกล(ขวา)รีเล็กน้อย, ดั้งแว่นวางตรงโคน muzzle -->
    <circle  cx="102" cy="98" r="20" fill="none" stroke="${OL}" stroke-width="5.5"/>
    <ellipse cx="146" cy="97" rx="17" ry="19.5" fill="none" stroke="${OL}" stroke-width="5"/>
    <path d="M122 97 Q126 93 129 98" fill="none" stroke="${OL}" stroke-width="5"/>
    <line x1="163" y1="95" x2="177" y2="91" stroke="${OL}" stroke-width="4.5" stroke-linecap="round"/>` : ``}
    `;
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

    // Full character — คาปิบาร่ายืนเต็มตัว หันข้าง 3/4 ไปทางซ้าย ยื่นเครื่องคิดเลขไปข้างหน้า
    full(w) {
      w = w || 240;
      return `<svg class="nova-svg" viewBox="0 0 240 376" width="${w}" role="img"
        aria-label="น้อง NOVA คาปิบาร่าใส่สูทน้ำเงิน ใส่แว่น หันข้าง 3/4 ยื่นเครื่องคิดเลขไปข้างหน้า">
        ${defs()}
        <!-- เงาใต้เท้า -->
        <ellipse cx="122" cy="362" rx="80" ry="12" fill="${NAVY_D}" opacity=".12"/>
        <!-- เท้าไกล (หลัง-ขวา) วาดก่อนให้อยู่หลัง -->
        <ellipse cx="152" cy="356" rx="23" ry="13" fill="${FUR_MID}" stroke="${OL}" stroke-width="5.5"/>
        <!-- ตัว/ท้องคาปิบาร่า ทรงไข่ เอียง 3/4 (ด้านหน้าไปทางซ้าย) -->
        <path d="M128 164 C 78 162, 52 206, 52 262 C 52 322, 84 356, 124 358
                 C 166 356, 196 320, 196 260 C 196 202, 176 164, 128 164 Z"
              fill="url(#nfBody)" stroke="${OL}" stroke-width="6" stroke-linejoin="round"/>
        <!-- เท้าใกล้ (หน้า-ซ้าย) + นิ้วเท้า -->
        <ellipse cx="102" cy="360" rx="27" ry="14" fill="url(#nfBody)" stroke="${OL}" stroke-width="5.5"/>
        <g stroke="${OL}" stroke-width="2.5" stroke-linecap="round">
          <line x1="90" y1="364" x2="90" y2="371"/><line x1="102" y1="365" x2="102" y2="372"/><line x1="114" y1="364" x2="114" y2="371"/>
        </g>
        <!-- แขนไกล (ขวา) บังอยู่หลังตัวตามมุม 3/4 — โผล่แค่ปลายอุ้งมือเล็กน้อย -->
        <ellipse cx="188" cy="272" rx="13" ry="12" fill="${FUR_MID}" stroke="${OL}" stroke-width="5"/>
        <!-- เสื้อสูทน้ำเงิน (3/4 เยื้องซ้าย) -->
        <path d="M128 164 C 88 162, 66 190, 66 224 C 66 250, 78 268, 94 274
                 L 116 258 L 146 272 C 162 266, 178 250, 178 224
                 C 178 190, 160 164, 128 164 Z"
              fill="${NAVY}" stroke="${OL}" stroke-width="6" stroke-linejoin="round"/>
        <!-- เชิ้ตขาว + ปกสูท + เน็คไท (เยื้องซ้ายตามมุม) -->
        <path d="M116 170 L100 260 L116 248 L134 260 Z" fill="#ffffff" stroke="${OL}" stroke-width="3"/>
        <path d="M116 168 L96 178 L112 212 Z" fill="${NAVY_D}" stroke="${OL}" stroke-width="3" stroke-linejoin="round"/>
        <path d="M116 168 L136 178 L120 212 Z" fill="${NAVY_D}" stroke="${OL}" stroke-width="3" stroke-linejoin="round"/>
        <path d="M109 176 L116 170 L123 176 L118 186 L114 186 Z" fill="${SKY}" stroke="${OL}" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M114 186 L118 186 L123 244 L116 254 L109 244 Z" fill="${SKY}" stroke="${OL}" stroke-width="2.5" stroke-linejoin="round"/>
        <!-- แขนใกล้ (ซ้าย) ยื่นไปข้างหน้าถือเครื่องคิดเลข -->
        <path d="M112 226 C 88 228, 62 242, 48 260 C 42 270, 50 282, 62 278
                 C 78 260, 98 250, 120 252 Z" fill="${NAVY}" stroke="${OL}" stroke-width="6" stroke-linejoin="round"/>
        <g transform="translate(60,270) rotate(-16)">${calculator()}</g>
        <ellipse cx="62" cy="282" rx="15" ry="13" fill="url(#nfBody)" stroke="${OL}" stroke-width="5"/>
        <!-- หัว 3/4 วางบนบ่า -->
        <g transform="translate(0,-6)">${headSide()}</g>
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
