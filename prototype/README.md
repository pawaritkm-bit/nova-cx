# NOVA-CX Prototype — ต้นแบบกดดูได้ (Gate 2)

ต้นแบบ **clickable mockup** สำหรับให้ผู้ใช้เห็นภาพ + ลองสัมผัสก่อนอนุมัติให้เขียนโค้ดจริง
เป็น HTML/CSS/JS ล้วน **self-contained ไม่ต้อง build ไม่ต้องติดตั้งอะไร**

## วิธีเปิดดู

เปิดไฟล์ในเบราว์เซอร์ได้เลย (ดับเบิลคลิก หรือ):
```
open /Users/momie/Downloads/nova-cx/prototype/index.html
```

`index.html` เป็นหน้ารวม มีปุ่มลิงก์ไปทุก flow

## ไฟล์

| ไฟล์ | คืออะไร |
|---|---|
| `index.html` | หน้า landing — โชว์ mascot 4 แบบ + ปุ่มเลือกดูแต่ละ flow |
| `survey.html` | LIFF Survey (กรอบมือถือ) เดินได้ครบ: Loading → PDPA → แบบประเมิน A → ตรวจก่อนส่ง → Confirmation |
| `survey.html?demo=loading` | โหมดดู Loading Animation ค้าง + fallback ปุ่ม "ลองใหม่/แจ้งปัญหา" (จำลอง >5 วิ) |
| `dashboard.html` | Dashboard ผู้บริหาร + ปุ่มสลับมุม "นักบัญชี" |
| `assets/nova.css` | Design System (สีแบรนด์ Finovas น้ำเงินเข้ม, ปุ่มใหญ่, mobile frame, dashboard) |
| `assets/mascot.js` | Mascot น้อง NOVA วาดด้วย inline SVG (`NOVA.full/icon/profile/loaderScene`) |

## Mascot — น้อง NOVA
นกอินทรีใส่แว่นกรอบน้ำเงิน สูทน้ำเงินเข้ม เนกไทฟ้า ถือเครื่องคิดเลข — ตากลมโต ยิ้ม แก้มชมพู
บุคลิกฉลาด เป็นมิตร น่าเชื่อถือ ไม่ดุ (ออกแบบใหม่ทั้งหมด ไม่ลอกแบรนด์อื่น)
4 แบบ: Full Character / Icon / Profile (วงกลม) / Loading Animation

## สิ่งที่กดดูได้จริงในต้นแบบ
- Mascot 4 แบบ + Loading animation (นกวิ่ง + เครื่องคิดเลขขยับ + เอกสารปลิว) + ข้อความสลับ 3 แบบ
- PDPA Consent ครบหัวข้อ + หมายเหตุ "ไม่ใช่ Anonymous 100%"
- แบบประเมิน A: auto-fill read-only → คะแนน 1–5 ปุ่มใหญ่เรียงต่ำ→สูง
- **Conditional**: 1–2 เด้งหาสาเหตุ + checkbox ติดต่อกลับ / 3 ถามจุดปรับปรุง / 4–5 ถามจุดเด่น
- Multi-select ปัญหา + "ยังไม่พบปัญหา" ตัดข้ออื่น
- Progress bar + เวลาโดยประมาณ + ปุ่มย้อนกลับ
- Autosave banner + จำลอง offline banner
- Review ก่อนส่ง (แก้รายข้อ) + Confirmation (โชว์ note ติดต่อกลับถ้าเลือก)
- Dashboard สลับมุม ผู้บริหาร ↔ นักบัญชี (แสดง Sample Size ทุกคะแนน)

## ยังเป็น mock / ไม่ได้ทำจริงในต้นแบบ
- **ไม่ต่อ backend/DB** — ข้อมูลทั้งหมดเป็นตัวอย่าง (hard-coded)
- LINE Login / LIFF SDK จริง (กรอบมือถือเป็นภาพจำลอง)
- AI น้อง NOVA วิเคราะห์จริง (โชว์แต่ผลตัวอย่าง)
- Auth / RBAC / RLS จริง (สลับมุมด้วยปุ่มเฉยๆ)
- กราฟ trend จริง (ใช้แท่ง/ตัวเลข mock)
- แบบประเมิน B/C/D และแบบ A แสดงคะแนน 3 ข้อจาก 10 ข้อจริง (เป็นตัวแทน)

> ต้นแบบนี้เน้น "ประสบการณ์ผู้ใช้และการไหลของงาน" — ไม่ใช่โค้ดที่จะนำไปใช้จริง
