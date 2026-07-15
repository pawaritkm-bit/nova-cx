/* ============================================================
   NOVA-CX Prototype — Mascot "น้อง NOVA" (คาปิบาร่า / capybara)
   ★ แบบสุดท้ายที่เลือกแล้ว — สไตล์ chibi น่ารัก flat vector สะอาด นุ่มนวล
   ออกแบบใหม่เอง (อิงสไตล์ความน่ารักเท่านั้น ห้ามลอกตรงๆ — ข้อกำหนด C-05)
   ลักษณะ: หัวกลมโต ตัวป้อมเตี้ย ตากลมโตมีประกาย ยิ้มอ่อนโยน จมูกใหญ่มน หูกลมเล็ก
           ใส่แว่นกรอบมน + สูทน้ำเงินแบรนด์ Finovas + เชิ้ตขาว + ไทฟ้า + ถือเครื่องคิดเลข
   API เดิม (ไม่เปลี่ยน): NOVA.head() / NOVA.full() / NOVA.icon() / NOVA.profile() / NOVA.loaderScene()
   ============================================================ */
(function (global) {
  // โทนขนคาปิบาร่า (น้ำตาลอมส้ม อบอุ่น)
  const FUR = "#b3835a";
  const FUR_D = "#8f6039";   // เงา/หู
  const FUR_L = "#d3ab80";   // ปากกระบอก
  const NOSE = "#5b3a26";
  const EYE  = "#2b1a10";
  // แบรนด์
  const NAVY = "#1e3a8a", NAVY_2 = "#2563eb", NAVY_D = "#152a63", SKY = "#38bdf8";
  // ชุดสูทครบชุด: กางเกงน้ำเงินเข้มกว่าเสื้อสูทเล็กน้อย + เข็มขัดดำ + หัวเข็มขัดทอง
  const PANTS = "#14265c", BELT = "#0f1a33", GOLD = "#e0b24a", GOLD_D = "#b9863a";

  /* ---------- หัวคาปิบาร่า chibi (ใส่แว่นเป็นค่าเริ่มต้น) ----------
     canonical: หัวกลมโตศูนย์กลาง ~ (120,102)
     opts: glasses (default true), smile (default true) */
  function head(opts) {
    opts = opts || {};
    const glasses = opts.glasses !== false;
    const smile = opts.smile !== false;
    return `
    <!-- หูกลมเล็กสองข้าง -->
    <ellipse cx="76"  cy="56" rx="16" ry="15" fill="${FUR_D}"/>
    <ellipse cx="164" cy="56" rx="16" ry="15" fill="${FUR_D}"/>
    <ellipse cx="76"  cy="59" rx="8"  ry="7"  fill="${NOSE}" opacity=".5"/>
    <ellipse cx="164" cy="59" rx="8"  ry="7"  fill="${NOSE}" opacity=".5"/>
    <!-- หัวกลมโต baby-face (กลมนุ่ม น่ากอด) -->
    <ellipse cx="120" cy="104" rx="72" ry="66" fill="${FUR}"/>
    <!-- เงานุ่มใต้หัว (soft shadow) -->
    <ellipse cx="120" cy="152" rx="52" ry="20" fill="${FUR_D}" opacity=".16"/>
    <!-- แก้มชมพูจางนุ่ม -->
    <ellipse cx="72"  cy="126" rx="14" ry="10" fill="#f2a996" opacity=".55"/>
    <ellipse cx="168" cy="126" rx="14" ry="10" fill="#f2a996" opacity=".55"/>
    <!-- ปากกระบอกมนกลมนุ่ม สีอ่อน -->
    <ellipse cx="120" cy="134" rx="44" ry="35" fill="${FUR_L}"/>
    <!-- ตากลมโตใสซื่อ เป็นมิตร + ไฮไลต์ประกาย -->
    <circle cx="98"  cy="100" r="19" fill="#ffffff"/>
    <circle cx="142" cy="100" r="19" fill="#ffffff"/>
    <circle cx="99"  cy="102" r="13" fill="${EYE}"/>
    <circle cx="141" cy="102" r="13" fill="${EYE}"/>
    <circle cx="104" cy="97"  r="4.8" fill="#ffffff"/>
    <circle cx="146" cy="97"  r="4.8" fill="#ffffff"/>
    <circle cx="94"  cy="106" r="2.4" fill="#ffffff" opacity=".85"/>
    <circle cx="136" cy="106" r="2.4" fill="#ffffff" opacity=".85"/>
    <!-- คิ้วขนสั้น โค้งอ่อน เป็นมิตร (ไม่ดุ) -->
    <path d="M83 78 Q98 72 113 78"  fill="none" stroke="${FUR_D}" stroke-width="3.5" stroke-linecap="round" opacity=".8"/>
    <path d="M157 78 Q142 72 127 78" fill="none" stroke="${FUR_D}" stroke-width="3.5" stroke-linecap="round" opacity=".8"/>
    <!-- จมูกมนกลมนุ่ม (ไม่ยื่นใหญ่เกิน) -->
    <ellipse cx="120" cy="126" rx="17" ry="12" fill="${NOSE}"/>
    <ellipse cx="112" cy="125" rx="3" ry="4" fill="#3a2416"/>
    <ellipse cx="128" cy="125" rx="3" ry="4" fill="#3a2416"/>
    ${smile ? `
    <!-- ยิ้มโค้งเล็กอ่อนโยน (ไม่มีฟัน ไม่อ้าปาก) -->
    <path d="M108 143 Q120 152 132 143" fill="none" stroke="${NOSE}" stroke-width="3" stroke-linecap="round"/>` : ``}
    ${glasses ? `
    <!-- แว่นกรอบมนน้ำเงิน -->
    <circle cx="98"  cy="100" r="24" fill="none" stroke="${NAVY}" stroke-width="4.5"/>
    <circle cx="142" cy="100" r="24" fill="none" stroke="${NAVY}" stroke-width="4.5"/>
    <line x1="122" y1="97" x2="118" y2="97" stroke="${NAVY}" stroke-width="4.5"/>
    <line x1="74"  y1="94" x2="62"  y2="89" stroke="${NAVY}" stroke-width="3.5" stroke-linecap="round"/>
    <line x1="166" y1="94" x2="178" y2="89" stroke="${NAVY}" stroke-width="3.5" stroke-linecap="round"/>` : ``}
    `;
  }

  // เครื่องคิดเลข — วางที่ origin, ใส่ classAttr เพื่อ animation ตอน loading
  function calculator(classAttr) {
    return `
    <g class="${classAttr || ''}">
      <rect x="-25" y="-33" width="50" height="66" rx="9" fill="${NAVY_2}" stroke="${NAVY_D}" stroke-width="2"/>
      <rect x="-18" y="-26" width="36" height="16" rx="3" fill="#d6f2ff"/>
      <text x="14" y="-14" text-anchor="end" font-size="9" font-weight="700" fill="#0c4a6e" font-family="monospace">1,240</text>
      <g fill="#eef2ff">
        <rect x="-18" y="-4" width="10" height="8" rx="2.5"/><rect x="-4" y="-4" width="10" height="8" rx="2.5"/><rect x="10" y="-4" width="10" height="8" rx="2.5"/>
        <rect x="-18" y="8"  width="10" height="8" rx="2.5"/><rect x="-4" y="8"  width="10" height="8" rx="2.5"/><rect x="10" y="8"  width="10" height="8" rx="2.5"/>
        <rect x="-18" y="20" width="10" height="8" rx="2.5"/><rect x="-4" y="20" width="10" height="8" rx="2.5"/>
      </g>
      <rect x="10" y="20" width="10" height="8" rx="2.5" fill="#f59e0b"/>
    </g>`;
  }

  /* ---------- ลำตัว chibi ตัวป้อมเตี้ย + สูทน้ำเงิน + แขนถือเครื่องคิดเลข ---------- */
  function body() {
    return `
    <!-- เงาใต้ตัว (ใต้เท้า) -->
    <ellipse cx="120" cy="336" rx="62" ry="9" fill="${NAVY_D}" opacity=".12"/>
    <!-- ขาสองข้าง: กางเกงสูทขายาวคลุมถึงข้อเท้า (โทนเข้มกว่าเสื้อ) + ปลายเป็นเท้าคาปิบาร่า -->
    <rect x="94"  y="288" width="20" height="40" rx="9" fill="${PANTS}"/>
    <rect x="126" y="288" width="20" height="40" rx="9" fill="${PANTS}"/>
    <!-- รอยพับกางเกงเบาๆ -->
    <line x1="104" y1="300" x2="104" y2="322" stroke="${NAVY_D}" stroke-width="1.5" opacity=".5"/>
    <line x1="136" y1="300" x2="136" y2="322" stroke="${NAVY_D}" stroke-width="1.5" opacity=".5"/>
    <!-- เท้าคาปิบาร่าโผล่ปลายขากางเกง -->
    <ellipse cx="99"  cy="328" rx="18" ry="11" fill="${FUR_D}"/>
    <ellipse cx="141" cy="328" rx="18" ry="11" fill="${FUR_D}"/>
    <!-- แขนซ้าย (สั้น มน) -->
    <path d="M78 214 Q52 224 56 262 Q62 274 74 268 Q70 236 92 226 Z" fill="${NAVY}"/>
    <ellipse cx="66" cy="264" rx="13" ry="11" fill="${FUR}"/>
    <!-- ตัวป้อมทรงมน สูทน้ำเงิน -->
    <path d="M74 210 Q120 194 166 210 Q182 250 174 300 Q120 316 66 300 Q58 250 74 210 Z" fill="${NAVY}"/>
    <!-- ไฮไลต์ลาเพลนุ่มๆ -->
    <path d="M120 206 L98 300 L120 292 Z" fill="${NAVY_2}" opacity=".55"/>
    <!-- เชิ้ตขาว V -->
    <path d="M120 206 L100 300 L120 290 L140 300 Z" fill="#ffffff"/>
    <path d="M100 210 L120 206 L112 256 Z" fill="${NAVY_D}"/>
    <path d="M140 210 L120 206 L128 256 Z" fill="${NAVY_D}"/>
    <!-- เนกไทฟ้าแบรนด์ -->
    <path d="M120 214 L113 227 L120 268 L127 227 Z" fill="${SKY}"/>
    <!-- เข็มขัดคาดเอว (ระหว่างเสื้อสูทกับกางเกง) + หัวเข็มขัดสีทอง -->
    <rect x="72" y="278" width="96" height="15" rx="4" fill="${BELT}"/>
    <rect x="107" y="275" width="26" height="21" rx="4" fill="${GOLD}" stroke="${GOLD_D}" stroke-width="1.8"/>
    <rect x="113" y="281" width="14" height="9" rx="2" fill="none" stroke="${GOLD_D}" stroke-width="1.8"/>
    <!-- แขนขวา (ยกถือเครื่องคิดเลข) -->
    <path d="M164 208 Q192 214 194 250 Q188 262 176 256 Q180 226 156 224 Z" fill="${NAVY}"/>
    `;
  }

  const NOVA = {
    head,

    // Full character — chibi ตัวเต็ม ถือเครื่องคิดเลข (welcome/confirmation)
    full(w) {
      w = w || 240;
      return `<svg class="nova-svg" viewBox="0 0 240 344" width="${w}" role="img"
        aria-label="น้อง NOVA คาปิบาร่าใส่สูทน้ำเงิน ใส่แว่น ถือเครื่องคิดเลข">
        ${body()}
        <!-- เครื่องคิดเลขในมือขวา -->
        <g transform="translate(182,236) scale(.82)">${calculator()}</g>
        <ellipse cx="182" cy="252" rx="13" ry="11" fill="${FUR}"/>
        <!-- คอ/ช่วงต่อ: ให้หัวนั่งบนบ่าเป็นตัวเดียว ไม่มีช่องว่าง -->
        <path d="M96 180 Q120 176 144 180 L139 212 Q120 218 101 212 Z" fill="${FUR}"/>
        <ellipse cx="120" cy="196" rx="30" ry="16" fill="${FUR_D}" opacity=".2"/>
        <!-- หัวโต วางทับบนบ่า (เลื่อนลงมาให้คางจรดคอเสื้อสูท) -->
        <g transform="translate(0,24)">${head()}</g>
      </svg>`;
    },

    // Icon — หัวแบบเรียบ ใส่แว่น (Rich Menu / ปุ่ม / favicon)
    icon(w) {
      w = w || 64;
      return `<svg class="nova-svg" viewBox="42 34 156 152" width="${w}" role="img" aria-label="ไอคอนน้อง NOVA คาปิบาร่า">
        ${head()}
      </svg>`;
    },

    // Profile — avatar วงกลม (การ์ด/แชต)
    profile(w) {
      w = w || 56;
      return `<svg class="nova-svg" viewBox="0 0 160 160" width="${w}" height="${w}" role="img" aria-label="โปรไฟล์น้อง NOVA คาปิบาร่า">
        <circle cx="80" cy="80" r="78" fill="#dbeafe" stroke="${NAVY}" stroke-width="3"/>
        <g transform="translate(-40,-20) scale(1.0)">${head()}</g>
      </svg>`;
    },

    // Loading — คาปิบาร่าวิ่ง + เครื่องคิดเลขสั่น + เอกสารปลิว + เส้นสปีด
    loaderScene() {
      return `
      <div class="nova-loader" aria-label="กำลังโหลด น้อง NOVA">
        <!-- เส้นสปีด (speed lines) -->
        <div class="nova-speed l1"></div>
        <div class="nova-speed l2"></div>
        <div class="nova-speed l3"></div>
        <!-- เอกสารปลิว -->
        <div class="nova-doc d1"></div>
        <div class="nova-doc d2"></div>
        <div class="nova-doc d3"></div>
        <div class="nova-run">
          <svg class="nova-svg" viewBox="0 0 240 240" width="150" role="img" aria-label="น้อง NOVA คาปิบาร่ากำลังวิ่ง">
            <!-- ขาวิ่งสลับซ้าย-ขวา (กางเกงสูทขายาว+เท้า / running cycle) — วาดก่อนตัวเพื่อซ่อนสะโพกหลังลำตัว -->
            <g class="nova-leg nova-leg-l">
              <rect x="97" y="196" width="16" height="32" rx="8" fill="${PANTS}"/>
              <ellipse cx="101" cy="230" rx="14" ry="9" fill="${FUR_D}"/>
            </g>
            <g class="nova-leg nova-leg-r">
              <rect x="127" y="196" width="16" height="32" rx="8" fill="${PANTS}"/>
              <ellipse cx="131" cy="230" rx="14" ry="9" fill="${FUR_D}"/>
            </g>
            <!-- ตัวป้อมย่อ -->
            <ellipse cx="120" cy="174" rx="54" ry="46" fill="${NAVY}"/>
            <path d="M120 138 L106 214 L120 204 L134 214 Z" fill="#fff"/>
            <path d="M120 146 L113 172 L120 162 L127 172 Z" fill="${SKY}"/>
            <!-- เข็มขัด + หัวเข็มขัดทอง (ให้ชุดครบขณะวิ่ง) -->
            <rect x="80" y="196" width="80" height="12" rx="3.5" fill="${BELT}"/>
            <rect x="110" y="194" width="18" height="15" rx="3" fill="${GOLD}" stroke="${GOLD_D}" stroke-width="1.4"/>
            <!-- แขนถือเครื่องคิดเลข (สั่น) -->
            <g transform="translate(172,170) scale(.68)">${calculator('nova-calc-shake')}</g>
            <ellipse cx="170" cy="184" rx="11" ry="9" fill="${FUR}"/>
            <!-- หัวโต -->
            ${head()}
          </svg>
        </div>
      </div>`;
    }
  };

  global.NOVA = NOVA;
})(window);
