-- 0190_gate_reviews_app_off — the speak gate's reviews leave the app
-- (system/speak-gate.md § Nightly audit). The user, 2026-11-13: "the judger
-- messages are still in the app chat. we should remove them (also the past
-- ones)." The app build without the lines (281) only helps once installed, so
-- the app's own role loses access to the table: every build, past and future
-- reviews alike, sees no rows and draws no line. RLS stays on with no policy
-- for `authenticated`; the mini's service role (gate, audit, daily summary,
-- role hand-back) bypasses RLS and is unaffected. Nothing is deleted: the rows
-- are the nightly audit's input and carry held digests and found answers.
drop policy if exists jori_gate_reviews_select on public.jori_gate_reviews;
drop policy if exists jori_gate_reviews_update on public.jori_gate_reviews;
do $$
begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jori_gate_reviews') then
    alter publication supabase_realtime drop table public.jori_gate_reviews;
  end if;
end $$;
