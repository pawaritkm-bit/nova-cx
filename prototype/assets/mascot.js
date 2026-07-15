/* ============================================================
   NOVA-CX Prototype — Mascot "น้อง NOVA" (คาปิบาร่า / capybara)
   ออกแบบใหม่ทั้งหมดเอง (ห้ามลอกตัวละคร/รูปแบรนด์อื่น — ข้อกำหนด C-05)
   บุคลิก: คาปิบาร่าน่ารัก หัวโต จมูกใหญ่ หูกลมเล็ก ตากลมโตมีประกาย ยิ้มเป็นมิตร
           ใส่สูทน้ำเงินแบรนด์ Finovas + เชิ้ตขาว + ผูกไทฟ้า ถือเครื่องคิดเลข
   API เดิม (ไม่เปลี่ยน): NOVA.head() / NOVA.full() / NOVA.icon() / NOVA.profile() / NOVA.loaderScene()
   ============================================================ */
(function (global) {
  // สีขนคาปิบาร่า
  const FUR = "#a97b52";        // น้ำตาลอมส้ม
  const FUR_DARK = "#8a5f3c";   // น้ำตาลเข้ม (เงา/หู)
  const FUR_LIGHT = "#c79a6e";  // น้ำตาลอ่อน (ปากกระบอก)
  const NOSE = "#5b3a26";       // จมูก/รูจมูกเข้ม

  // --- ชิ้นส่วนหัวคาปิบาร่า (ใช้ซ้ำทุก variant) ศูนย์กลางหัวราว (120,100) ---
  // หัวโตทรงสี่เหลี่ยมมนแบบคาปิบาร่า + ปากกระบอกใหญ่ + จมูกใหญ่ + หูกลมเล็ก + ตากลมโต
  function head(opts) {
    opts = opts || {};
    const smile = opts.smile !== false;
    return `
    <!-- หูกลมเล็กสองข้าง (คาปิบาร่าหูเล็ก) -->
    <ellipse cx="74"  cy="58" rx="15" ry="14" fill="${FUR_DARK}"/>
    <ellipse cx="166" cy="58" rx="15" ry="14" fill="${FUR_DARK}"/>
    <ellipse cx="74"  cy="60" rx="8"  ry="7"  fill="${NOSE}" opacity=".55"/>
    <ellipse cx="166" cy="60" rx="8"  ry="7"  fill="${NOSE}" opacity=".55"/>
    <!-- หัวโตทรงสี่เหลี่ยมมน (เอกลักษณ์คาปิบาร่า) -->
    <path d="M62 78 Q62 52 92 50 L148 50 Q178 52 178 78 L178 118
             Q178 150 148 156 L92 156 Q62 150 62 118 Z"
          fill="${FUR}" stroke="${FUR_DARK}" stroke-width="1.5"/>
    <!-- แก้มชมพูจางๆ (เป็นมิตร) -->
    <ellipse cx="80"  cy="120" rx="12" ry="8" fill="#e79a86" opacity=".55"/>
    <ellipse cx="160" cy="120" rx="12" ry="8" fill="#e79a86" opacity=".55"/>
    <!-- ปากกระบอกใหญ่ (muzzle) สีอ่อน -->
    <ellipse cx="120" cy="128" rx="42" ry="34" fill="${FUR_LIGHT}"/>
    <!-- ตากลมโต + ประกาย -->
    <circle cx="100" cy="94" r="15" fill="#ffffff" stroke="${FUR_DARK}" stroke-width="1"/>
    <circle cx="140" cy="94" r="15" fill="#ffffff" stroke="${FUR_DARK}" stroke-width="1"/>
    <circle cx="101" cy="96" r="9"  fill="#2b1a10"/>
    <circle cx="139" cy="96" r="9"  fill="#2b1a10"/>
    <circle cx="104" cy="92" r="3"  fill="#ffffff"/>
    <circle cx="142" cy="92" r="3"  fill="#ffffff"/>
    <!-- คิ้วขนสั้น เอียงเป็นมิตร (ไม่ดุ) -->
    <path d="M86 74 Q100 68 114 74" fill="none" stroke="${FUR_DARK}" stroke-width="4" stroke-linecap="round"/>
    <path d="M154 74 Q140 68 126 74" fill="none" stroke="${FUR_DARK}" stroke-width="4" stroke-linecap="round"/>
    <!-- จมูกใหญ่แบบคาปิบาร่า (สี่เหลี่ยมมน ครอบปากบน) -->
    <rect x="98" y="112" width="44" height="26" rx="12" fill="${NOSE}"/>
    <ellipse cx="110" cy="122" rx="4" ry="5" fill="#2b1a10"/>
    <ellipse cx="130" cy="122" rx="4" ry="5" fill="#2b1a10"/>
    <!-- รอยยิ้ม + ฟันหน้าคู่ (เอกลักษณ์คาปิบาร่า) -->
    ${smile ? `
    <path d="M104 144 Q120 156 136 144" fill="none" stroke="${NOSE}" stroke-width="3" stroke-linecap="round"/>
    <rect x="115" y="146" width="10" height="9" rx="2" fill="#ffffff" stroke="${FUR_DARK}" stroke-width="1"/>
    <line x1="120" y1="146" x2="120" y2="155" stroke="${FUR_DARK}" stroke-width="1"/>
    ` : ``}
    `;
  }

  // เครื่องคิดเลข (calculator) — ส่งค่า classAttr เพื่อใส่ animation ตอน loading
  function calculator(classAttr) {
    return `
    <g class="${classAttr || ''}">
      <rect x="-26" y="-34" width="52" height="68" rx="8" fill="#1e40af" stroke="#172554" stroke-width="2"/>
      <rect x="-19" y="-27" width="38" height="16" rx="3" fill="#bae6fd"/>
      <text x="14" y="-14" text-anchor="end" font-size="9" font-weight="700" fill="#0c4a6e" font-family="monospace">1,240</text>
      <!-- ปุ่ม -->
      <g fill="#e0e7ff">
        <rect x="-19" y="-6"  width="10" height="8" rx="2"/><rect x="-5" y="-6"  width="10" height="8" rx="2"/><rect x="9" y="-6"  width="10" height="8" rx="2"/>
        <rect x="-19" y="6"   width="10" height="8" rx="2"/><rect x="-5" y="6"   width="10" height="8" rx="2"/><rect x="9" y="6"   width="10" height="8" rx="2"/>
        <rect x="-19" y="18"  width="10" height="8" rx="2"/><rect x="-5" y="18"  width="10" height="8" rx="2"/>
      </g>
      <rect x="9" y="18" width="10" height="8" rx="2" fill="#f59e0b"/>
    </g>`;
  }

  // สูทน้ำเงินเข้ม + แขน (มือคาปิบาร่า) + เชิ้ตขาว + เนกไทฟ้า (สำหรับ full character)
  function body() {
    return `
    <!-- แขนซ้าย -->
    <path d="M74 182 Q42 202 48 250 Q54 262 68 256 Q62 220 86 208 Z" fill="#1e3a8a"/>
    <ellipse cx="60" cy="252" rx="13" ry="11" fill="${FUR}"/>
    <!-- ลำตัวสูท -->
    <path d="M70 180 Q120 170 170 180 L178 302 Q120 314 62 302 Z" fill="#1e3a8a"/>
    <!-- ปกสูท + เชิ้ตขาว V -->
    <path d="M120 180 L96 302 L120 290 L144 302 Z" fill="#ffffff"/>
    <path d="M96 184 L120 180 L112 238 Z" fill="#172554"/>
    <path d="M144 184 L120 180 L128 238 Z" fill="#172554"/>
    <!-- เนกไทฟ้าแบรนด์ -->
    <path d="M120 188 L112 202 L120 252 L128 202 Z" fill="#38bdf8"/>
    <!-- แขนขวา (ถือเครื่องคิดเลข) -->
    <path d="M166 182 Q198 198 196 242 Q192 254 178 250 Q182 216 156 208 Z" fill="#1e3a8a"/>
    <!-- เท้าคาปิบาร่า -->
    <ellipse cx="98"  cy="308" rx="16" ry="10" fill="${FUR_DARK}"/>
    <ellipse cx="142" cy="308" rx="16" ry="10" fill="${FUR_DARK}"/>
    `;
  }

  const NOVA = {
    // หัวเดี่ยว (ใช้ทำ icon)
    head,

    // Full character — ตัวเต็ม ถือเครื่องคิดเลข (welcome/confirmation)
    full(w) {
      w = w || 240;
      return `<svg class="nova-svg" viewBox="0 0 240 340" width="${w}" role="img"
        aria-label="น้อง NOVA คาปิบาร่าใส่สูทน้ำเงิน ผูกไท ถือเครื่องคิดเลข">
        ${body()}
        <!-- เครื่องคิดเลขในมือขวา -->
        <g transform="translate(182,234) scale(.9)">${calculator()}</g>
        <!-- มือขวาถือ -->
        <ellipse cx="182" cy="250" rx="13" ry="11" fill="${FUR}"/>
        ${head()}
      </svg>`;
    },

    // Icon — หัวแบบเรียบ (Rich Menu / ปุ่ม / favicon)
    icon(w) {
      w = w || 64;
      return `<svg class="nova-svg" viewBox="40 40 160 130" width="${w}" role="img" aria-label="ไอคอนน้อง NOVA คาปิบาร่า">
        ${head()}
      </svg>`;
    },

    // Profile — avatar วงกลม (การ์ด/แชต)
    profile(w) {
      w = w || 56;
      return `<svg class="nova-svg" viewBox="0 0 160 160" width="${w}" height="${w}" role="img" aria-label="โปรไฟล์น้อง NOVA คาปิบาร่า">
        <circle cx="80" cy="80" r="78" fill="#dbeafe" stroke="#1e3a8a" stroke-width="3"/>
        <g transform="translate(-40,-22) scale(1.0)">${head()}</g>
      </svg>`;
    },

    // ฉากสำหรับ Loading — คาปิบาร่าวิ่ง + เครื่องคิดเลขขยับ + เอกสารปลิว
    loaderScene() {
      return `
      <div class="nova-loader" aria-label="กำลังโหลด น้อง NOVA">
        <div class="nova-doc d1"></div>
        <div class="nova-doc d2"></div>
        <div class="nova-doc d3"></div>
        <div class="nova-run">
          <svg class="nova-svg" viewBox="0 0 240 240" width="150" role="img" aria-label="น้อง NOVA คาปิบาร่ากำลังวิ่ง">
            <!-- ลำตัวย่อ -->
            <ellipse cx="120" cy="172" rx="52" ry="44" fill="#1e3a8a"/>
            <path d="M120 132 L106 212 L120 202 L134 212 Z" fill="#fff"/>
            <path d="M120 140 L112 170 L120 160 L128 170 Z" fill="#38bdf8"/>
            <!-- ขาวิ่ง -->
            <ellipse cx="104" cy="214" rx="11" ry="8" fill="${FUR_DARK}" transform="rotate(-20 104 214)"/>
            <ellipse cx="138" cy="214" rx="11" ry="8" fill="${FUR_DARK}" transform="rotate(20 138 214)"/>
            <!-- แขนถือเครื่องคิดเลข -->
            <g transform="translate(170,168) scale(.7)">${calculator('nova-calc-shake')}</g>
            <ellipse cx="168" cy="182" rx="11" ry="9" fill="${FUR}"/>
            ${head()}
          </svg>
        </div>
      </div>`;
    }
  };

  global.NOVA = NOVA;
})(window);
