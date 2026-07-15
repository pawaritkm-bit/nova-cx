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
    <!-- หัวกลมโต (chibi round) -->
    <ellipse cx="120" cy="102" rx="70" ry="64" fill="${FUR}"/>
    <!-- เงานุ่มใต้หัว (soft shadow) -->
    <ellipse cx="120" cy="150" rx="52" ry="20" fill="${FUR_D}" opacity=".18"/>
    <!-- แก้มชมพูจาง -->
    <ellipse cx="74"  cy="120" rx="13" ry="9" fill="#eb9e88" opacity=".6"/>
    <ellipse cx="166" cy="120" rx="13" ry="9" fill="#eb9e88" opacity=".6"/>
    <!-- ปากกระบอกใหญ่มน สีอ่อน -->
    <ellipse cx="120" cy="130" rx="46" ry="37" fill="${FUR_L}"/>
    <!-- ตากลมโต + ประกาย -->
    <circle cx="99"  cy="96" r="16" fill="#ffffff"/>
    <circle cx="141" cy="96" r="16" fill="#ffffff"/>
    <circle cx="100" cy="98" r="10" fill="${EYE}"/>
    <circle cx="140" cy="98" r="10" fill="${EYE}"/>
    <circle cx="104" cy="93" r="3.6" fill="#ffffff"/>
    <circle cx="144" cy="93" r="3.6" fill="#ffffff"/>
    <circle cx="96"  cy="101" r="1.8" fill="#ffffff" opacity=".8"/>
    <circle cx="136" cy="101" r="1.8" fill="#ffffff" opacity=".8"/>
    <!-- คิ้วขนสั้น เอียงเป็นมิตร -->
    <path d="M84 72 Q99 66 114 73" fill="none" stroke="${FUR_D}" stroke-width="4" stroke-linecap="round"/>
    <path d="M156 72 Q141 66 126 73" fill="none" stroke="${FUR_D}" stroke-width="4" stroke-linecap="round"/>
    <!-- จมูกใหญ่มนแบบคาปิบาร่า -->
    <rect x="97" y="114" width="46" height="27" rx="13" fill="${NOSE}"/>
    <ellipse cx="109" cy="124" rx="4" ry="5.5" fill="${EYE}"/>
    <ellipse cx="131" cy="124" rx="4" ry="5.5" fill="${EYE}"/>
    ${smile ? `
    <!-- ยิ้มอ่อนโยน + ฟันหน้าคู่ -->
    <path d="M105 146 Q120 158 135 146" fill="none" stroke="${NOSE}" stroke-width="3" stroke-linecap="round"/>
    <rect x="115" y="148" width="10" height="9" rx="2.5" fill="#ffffff" stroke="${FUR_D}" stroke-width="1"/>
    <line x1="120" y1="148" x2="120" y2="157" stroke="${FUR_D}" stroke-width="1"/>` : ``}
    ${glasses ? `
    <!-- แว่นกรอบมนน่ารัก -->
    <circle cx="99"  cy="96" r="21" fill="none" stroke="${NAVY}" stroke-width="4.5"/>
    <circle cx="141" cy="96" r="21" fill="none" stroke="${NAVY}" stroke-width="4.5"/>
    <path d="M120 93 q0 -3 -0.5 0" fill="none"/>
    <line x1="121" y1="92" x2="119" y2="92" stroke="${NAVY}" stroke-width="4.5"/>
    <line x1="78" y1="90" x2="66" y2="85" stroke="${NAVY}" stroke-width="3.5" stroke-linecap="round"/>
    <line x1="162" y1="90" x2="174" y2="85" stroke="${NAVY}" stroke-width="3.5" stroke-linecap="round"/>` : ``}
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
    <!-- เงาใต้ตัว -->
    <ellipse cx="120" cy="312" rx="70" ry="12" fill="${NAVY_D}" opacity=".12"/>
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
    <!-- แขนขวา (ยกถือเครื่องคิดเลข) -->
    <path d="M164 208 Q192 214 194 250 Q188 262 176 256 Q180 226 156 224 Z" fill="${NAVY}"/>
    <!-- เท้าเล็กมน -->
    <ellipse cx="99"  cy="306" rx="16" ry="10" fill="${FUR_D}"/>
    <ellipse cx="141" cy="306" rx="16" ry="10" fill="${FUR_D}"/>
    `;
  }

  const NOVA = {
    head,

    // Full character — chibi ตัวเต็ม ถือเครื่องคิดเลข (welcome/confirmation)
    full(w) {
      w = w || 240;
      return `<svg class="nova-svg" viewBox="0 0 240 330" width="${w}" role="img"
        aria-label="น้อง NOVA คาปิบาร่าใส่สูทน้ำเงิน ใส่แว่น ถือเครื่องคิดเลข">
        ${body()}
        <!-- เครื่องคิดเลขในมือขวา -->
        <g transform="translate(182,236) scale(.82)">${calculator()}</g>
        <ellipse cx="182" cy="252" rx="13" ry="11" fill="${FUR}"/>
        <!-- หัวโต วางทับบนตัว -->
        <g transform="translate(0,-6)">${head()}</g>
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
            <!-- ตัวป้อมย่อ -->
            <ellipse cx="120" cy="174" rx="54" ry="46" fill="${NAVY}"/>
            <path d="M120 138 L106 214 L120 204 L134 214 Z" fill="#fff"/>
            <path d="M120 146 L113 172 L120 162 L127 172 Z" fill="${SKY}"/>
            <!-- ขาวิ่ง -->
            <ellipse cx="104" cy="216" rx="11" ry="8" fill="${FUR_D}" transform="rotate(-22 104 216)"/>
            <ellipse cx="138" cy="216" rx="11" ry="8" fill="${FUR_D}" transform="rotate(22 138 216)"/>
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
