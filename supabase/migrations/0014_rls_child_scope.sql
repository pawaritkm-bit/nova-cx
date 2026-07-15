-- =====================================================================
-- 0014 — QC#1 HIGH#2: RESTRICTIVE scope ให้ครบทุกตารางที่ผูกลูกค้า (C-10)
--   narrow ด้วย AND ทั้ง read+write (for all)
--   กลุ่ม A: ผูกตรงด้วย customer_id
--   กลุ่ม B: ผูกผ่าน response_id -> survey_responses.customer_id
--   กลุ่ม C: sales_leads (ยังไม่มี customer_id) -> จำกัดตาม role ฝ่ายขาย
-- =====================================================================

-- ---------- กลุ่ม A: customer_id NOT NULL ----------
create policy scope_customer_contacts on public.customer_contacts
  as restrictive for all to authenticated
  using (public.can_access_customer(customer_id))
  with check (public.can_access_customer(customer_id));

create policy scope_customer_services on public.customer_services
  as restrictive for all to authenticated
  using (public.can_access_customer(customer_id))
  with check (public.can_access_customer(customer_id));

create policy scope_survey_invitations on public.survey_invitations
  as restrictive for all to authenticated
  using (public.can_access_customer(customer_id))
  with check (public.can_access_customer(customer_id));

create policy scope_consent_records on public.consent_records
  as restrictive for all to authenticated
  using (public.can_access_customer(customer_id))
  with check (public.can_access_customer(customer_id));

create policy scope_do_not_contact on public.do_not_contact_records
  as restrictive for all to authenticated
  using (public.can_access_customer(customer_id))
  with check (public.can_access_customer(customer_id));

-- ---------- กลุ่ม A': customer_id NULLABLE (null => เฉพาะ privileged) ----------
create policy scope_line_users on public.line_users
  as restrictive for all to authenticated
  using (
    public.is_privileged()
    or (customer_id is not null and public.can_access_customer(customer_id))
  )
  with check (
    public.is_privileged()
    or (customer_id is not null and public.can_access_customer(customer_id))
  );

-- sales_opportunities: ตามลูกค้า หรือ เซลล์เจ้าของดีล หรือ privileged
create policy scope_sales_opportunities on public.sales_opportunities
  as restrictive for all to authenticated
  using (
    public.is_privileged()
    or sales_employee_id = public.current_employee_id()
    or (customer_id is not null and public.can_access_customer(customer_id))
  )
  with check (
    public.is_privileged()
    or sales_employee_id = public.current_employee_id()
    or (customer_id is not null and public.can_access_customer(customer_id))
  );

-- ---------- กลุ่ม C: sales_leads (ยังไม่ผูก customer) ----------
-- lead เป็นข้อมูลก่อนเป็นลูกค้า ยังไม่มี assignment ต่อราย → จำกัดตาม role ฝ่ายขาย/privileged
create policy scope_sales_leads on public.sales_leads
  as restrictive for all to authenticated
  using (public.is_privileged() or public.current_role_code() in ('sales','sales_lead'))
  with check (public.is_privileged() or public.current_role_code() in ('sales','sales_lead'));

-- ---------- กลุ่ม B: ผูกผ่าน response_id ----------
create policy scope_survey_answers on public.survey_answers
  as restrictive for all to authenticated
  using (exists (
    select 1 from public.survey_responses sr
    where sr.id = survey_answers.response_id
      and public.can_access_customer(sr.customer_id)
  ))
  with check (exists (
    select 1 from public.survey_responses sr
    where sr.id = survey_answers.response_id
      and public.can_access_customer(sr.customer_id)
  ));

create policy scope_satisfaction_scores on public.satisfaction_scores
  as restrictive for all to authenticated
  using (exists (
    select 1 from public.survey_responses sr
    where sr.id = satisfaction_scores.response_id
      and public.can_access_customer(sr.customer_id)
  ))
  with check (exists (
    select 1 from public.survey_responses sr
    where sr.id = satisfaction_scores.response_id
      and public.can_access_customer(sr.customer_id)
  ));

create policy scope_nps_scores on public.nps_scores
  as restrictive for all to authenticated
  using (exists (
    select 1 from public.survey_responses sr
    where sr.id = nps_scores.response_id
      and public.can_access_customer(sr.customer_id)
  ))
  with check (exists (
    select 1 from public.survey_responses sr
    where sr.id = nps_scores.response_id
      and public.can_access_customer(sr.customer_id)
  ));

create policy scope_ai_feedback_analysis on public.ai_feedback_analysis
  as restrictive for all to authenticated
  using (exists (
    select 1 from public.survey_responses sr
    where sr.id = ai_feedback_analysis.response_id
      and public.can_access_customer(sr.customer_id)
  ))
  with check (exists (
    select 1 from public.survey_responses sr
    where sr.id = ai_feedback_analysis.response_id
      and public.can_access_customer(sr.customer_id)
  ));
