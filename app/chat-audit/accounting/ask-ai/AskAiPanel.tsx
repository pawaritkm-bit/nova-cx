"use client";

import { useRef, useState } from "react";
import { askBusinessQuestionAction } from "./actions";

/**
 * AskAiPanel — กล่องแชตถาม-ตอบ AI เรื่องข้อมูลธุรกิจของลูกค้า 1 ราย (wishlist backlog ข้อ 3)
 *   ★ ประวัติแชตเก็บแค่ฝั่ง client (state) — ไม่มี DB table เก็บประวัติใน v1 (รีเฟรชหน้า = ประวัติหาย)
 *   ★ ทุกคำถามส่งผ่าน server action (guard สโคปลูกค้า + AI เห็นแค่ข้อความคำถาม — ดู lib/ai/business-qa.ts)
 */

type ChatMessage = { key: string; role: "user" | "assistant"; text: string; isError?: boolean };

let keySeq = 0;
function newKey(): string {
  keySeq += 1;
  return `m${keySeq}`;
}

const SUGGESTED_QUESTIONS = [
  "ยอดขายเดือนนี้เท่าไหร่",
  "ยอดซื้อเดือนที่แล้วเท่าไหร่",
  "ลูกหนี้ค้างชำระมีใครบ้าง",
  "เจ้าหนี้ค้างจ่ายเท่าไหร่",
  "มีบิลรอระบุประเภทกี่รายการ",
];

export default function AskAiPanel({ customerId }: { customerId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  }

  async function send(text: string) {
    const q = text.trim();
    if (!q || pending) return;
    setMessages((prev) => [...prev, { key: newKey(), role: "user", text: q }]);
    setQuestion("");
    setPending(true);
    scrollToBottom();
    try {
      const res = await askBusinessQuestionAction(customerId, q);
      setMessages((prev) => [
        ...prev,
        { key: newKey(), role: "assistant", text: res.ok ? res.answer : res.message, isError: !res.ok },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { key: newKey(), role: "assistant", text: "ตอบคำถามไม่สำเร็จ กรุณาลองใหม่", isError: true },
      ]);
    } finally {
      setPending(false);
      scrollToBottom();
    }
  }

  return (
    <div className="askai-wrap">
      <div className="askai-messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="askai-empty">
            <p>ลองถามคำถามเกี่ยวกับข้อมูลธุรกิจของลูกค้ารายนี้ได้เลยครับ เช่น</p>
            <div className="askai-suggestions">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button key={q} type="button" className="askai-suggestion" onClick={() => send(q)} disabled={pending}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.key} className={`askai-bubble askai-${m.role}${m.isError ? " askai-error" : ""}`}>
              {m.text.split("\n").map((line, i) => (
                <span key={i}>
                  {line}
                  <br />
                </span>
              ))}
            </div>
          ))
        )}
        {pending ? <div className="askai-bubble askai-assistant askai-pending">กำลังคิด…</div> : null}
      </div>

      <form
        className="askai-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          send(question);
        }}
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="พิมพ์คำถาม เช่น ยอดขายเดือนนี้เท่าไหร่"
          maxLength={500}
          disabled={pending}
          aria-label="คำถาม"
        />
        <button type="submit" className="btn green" disabled={pending || !question.trim()}>
          ส่ง
        </button>
      </form>
    </div>
  );
}
