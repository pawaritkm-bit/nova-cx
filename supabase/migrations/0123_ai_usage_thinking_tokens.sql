-- 0123 — Gemini คิดค่า output รวม thinking tokens จึงต้องเก็บแยกเพื่อกระทบยอด
alter table public.ai_usage_logs add column if not exists thinking_tokens integer;
notify pgrst, 'reload schema';
