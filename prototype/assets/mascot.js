/* ============================================================
   NOVA-CX Prototype — Mascot "น้อง NOVA" (นกอินทรี)
   ออกแบบใหม่ทั้งหมด (ห้ามลอกแบรนด์อื่น) — วาดด้วย inline SVG ล้วน
   บุคลิก: ฉลาด เป็นมิตร น่าเชื่อถือ ตากลมโต ยิ้ม ใส่แว่น สูทน้ำเงินเข้ม ถือเครื่องคิดเลข
   ใช้: NOVA.head() / NOVA.full() / NOVA.icon() / NOVA.profile() / NOVA.loaderScene()
   ============================================================ */
(function (global) {
  // --- ชิ้นส่วนหัวนกอินทรี (ใช้ซ้ำในทุก variant) viewBox อ้างอิงศูนย์กลาง (120,100) ---
  // สีขนหัวขาว (bald eagle) + จะงอยปากเหลืองอำพัน + แว่นกรอบน้ำเงิน + ตากลมโต
  function head(opts) {
    opts = opts || {};
    const smile = opts.smile !== false;
    return `
    <!-- ขนหงอน/มงกุฎ (crown feathers) -->
    <path d="M64 66 Q70 30 96 46 Q108 26 122 44 Q136 26 146 46 Q172 30 176 66 Z"
          fill="#ffffff" stroke="#e2e8f0" stroke-width="1"/>
    <!-- หัวขนขาว -->
    <ellipse cx="120" cy="102" rx="66" ry="60" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1.5"/>
    <!-- แก้มชมพูจางๆ (เป็นมิตร) -->
    <ellipse cx="80" cy="120" rx="12" ry="8" fill="#fecdd3" opacity=".7"/>
    <ellipse cx="160" cy="120" rx="12" ry="8" fill="#fecdd3" opacity=".7"/>
    <!-- ตากลมโต (สีขาว) -->
    <circle cx="98"  cy="96" r="24" fill="#ffffff" stroke="#e2e8f0" stroke-width="1"/>
    <circle cx="142" cy="96" r="24" fill="#ffffff" stroke="#e2e8f0" stroke-width="1"/>
    <!-- ม่านตา + ไฮไลต์ (ตาเป็นประกาย เป็นมิตร) -->
    <circle cx="101" cy="98" r="11" fill="#0f172a"/>
    <circle cx="139" cy="98" r="11" fill="#0f172a"/>
    <circle cx="105" cy="94" r="3.5" fill="#ffffff"/>
    <circle cx="143" cy="94" r="3.5" fill="#ffffff"/>
    <!-- แว่นตา กรอบน้ำเงินแบรนด์ -->
    <circle cx="98"  cy="96" r="27" fill="none" stroke="#1e3a8a" stroke-width="4.5"/>
    <circle cx="142" cy="96" r="27" fill="none" stroke="#1e3a8a" stroke-width="4.5"/>
    <line x1="123" y1="94" x2="117" y2="94" stroke="#1e3a8a" stroke-width="4.5"/>
    <line x1="71" y1="92" x2="58" y2="86" stroke="#1e3a8a" stroke-width="4"/>
    <line x1="169" y1="92" x2="182" y2="86" stroke="#1e3a8a" stroke-width="4"/>
    <!-- คิ้วขนนุ่ม (เอียงเป็นมิตร ไม่ดุ) -->
    <path d="M74 70 Q92 62 118 72" fill="none" stroke="#e2e8f0" stroke-width="5" stroke-linecap="round"/>
    <path d="M166 70 Q148 62 122 72" fill="none" stroke="#e2e8f0" stroke-width="5" stroke-linecap="round"/>
    <!-- จะงอยปากเหลืองอำพัน (โค้งเล็ก ไม่ดุ) -->
    <path d="M108 120 Q120 116 132 120 Q128 140 120 148 Q112 140 108 120 Z"
          fill="#f59e0b" stroke="#d97706" stroke-width="1.5"/>
    <path d="M112 138 Q120 143 128 138 Q120 150 120 150 Q120 150 112 138 Z" fill="#b45309"/>
    ${smile ? `<!-- รอยยิ้มใต้ปาก -->
    <path d="M104 150 Q120 162 136 150" fill="none" stroke="#d97706" stroke-width="2.5" stroke-linecap="round"/>` : ``}
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

  // สูทน้ำเงินเข้ม + ปีก/แขน + เชิ้ตขาว + เนกไทฟ้า (สำหรับ full character)
  function body() {
    return `
    <!-- ปีกซ้าย (แขน) -->
    <path d="M74 180 Q40 200 46 250 Q52 262 66 256 Q60 220 84 208 Z" fill="#1e3a8a"/>
    <!-- ลำตัวสูท -->
    <path d="M70 178 Q120 168 170 178 L178 300 Q120 312 62 300 Z" fill="#1e3a8a"/>
    <!-- ปกสูท + เชิ้ตขาว V -->
    <path d="M120 178 L96 300 L120 288 L144 300 Z" fill="#ffffff"/>
    <path d="M120 178 L100 230 L120 214 Z" fill="#f1f5f9"/>
    <path d="M96 182 L120 178 L112 236 Z" fill="#172554"/>
    <path d="M144 182 L120 178 L128 236 Z" fill="#172554"/>
    <!-- เนกไทฟ้าแบรนด์ -->
    <path d="M120 186 L112 200 L120 250 L128 200 Z" fill="#38bdf8"/>
    <!-- ปีกขวา (แขนถือเครื่องคิดเลข) -->
    <path d="M166 180 Q198 196 196 240 Q192 252 178 248 Q182 214 156 206 Z" fill="#1e3a8a"/>
    <!-- เท้าเหลือง -->
    <path d="M96 300 l-8 16 m8 -16 l0 18 m0 -18 l8 16" stroke="#f59e0b" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M144 300 l-8 16 m8 -16 l0 18 m0 -18 l8 16" stroke="#f59e0b" stroke-width="5" stroke-linecap="round" fill="none"/>
    `;
  }

  const NOVA = {
    // หัวเดี่ยว (ใช้ทำ icon)
    head,

    // Full character — ตัวเต็ม ถือเครื่องคิดเลข (welcome/confirmation)
    full(w) {
      w = w || 240;
      return `<svg class="nova-svg" viewBox="0 0 240 340" width="${w}" role="img"
        aria-label="น้อง NOVA นกอินทรีใส่แว่น ใส่สูทน้ำเงิน ถือเครื่องคิดเลข">
        ${body()}
        <!-- เครื่องคิดเลขในมือขวา -->
        <g transform="translate(182,232) scale(.9)">${calculator()}</g>
        ${head()}
      </svg>`;
    },

    // Icon — หัวครึ่งตัวแบบเรียบ (Rich Menu / ปุ่ม / favicon)
    icon(w) {
      w = w || 64;
      return `<svg class="nova-svg" viewBox="30 40 180 130" width="${w}" role="img" aria-label="ไอคอนน้อง NOVA">
        ${head()}
      </svg>`;
    },

    // Profile — avatar วงกลม (การ์ด/แชต)
    profile(w) {
      w = w || 56;
      return `<svg class="nova-svg" viewBox="0 0 160 160" width="${w}" height="${w}" role="img" aria-label="โปรไฟล์น้อง NOVA">
        <circle cx="80" cy="80" r="78" fill="#dbeafe" stroke="#1e3a8a" stroke-width="3"/>
        <g transform="translate(-40,-24) scale(1.0)">${head()}</g>
      </svg>`;
    },

    // ฉากสำหรับ Loading — นกอินทรีวิ่ง + เครื่องคิดเลขขยับ + เอกสารปลิว
    loaderScene() {
      return `
      <div class="nova-loader" aria-label="กำลังโหลด น้อง NOVA">
        <div class="nova-doc d1"></div>
        <div class="nova-doc d2"></div>
        <div class="nova-doc d3"></div>
        <div class="nova-run">
          <svg class="nova-svg" viewBox="0 0 240 240" width="150" role="img" aria-label="น้อง NOVA กำลังวิ่ง">
            <!-- ลำตัวย่อ -->
            <ellipse cx="120" cy="170" rx="54" ry="46" fill="#1e3a8a"/>
            <path d="M120 130 L104 210 L120 200 L136 210 Z" fill="#fff"/>
            <path d="M120 138 L112 168 L120 158 L128 168 Z" fill="#38bdf8"/>
            <!-- ขาวิ่ง -->
            <path d="M104 208 l-10 14" stroke="#f59e0b" stroke-width="6" stroke-linecap="round"/>
            <path d="M136 208 l12 10" stroke="#f59e0b" stroke-width="6" stroke-linecap="round"/>
            <!-- แขนถือเครื่องคิดเลข -->
            <g transform="translate(168,168) scale(.7)">${calculator('nova-calc-shake')}</g>
            ${head()}
          </svg>
        </div>
      </div>`;
    }
  };

  global.NOVA = NOVA;
})(window);
