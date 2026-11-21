-- 0189_gate_reviews_audit — the speak gate's nightly audit (system/speak-gate.md
-- § Nightly audit). An Opus session re-checks each live verdict of the day and
-- writes its own grade beside the user's (grade/note stay the user's):
--   audit_grade  right | partly | wrong
--   audit_note   why, with what it found
--   audit_better what the gate should have done instead (verdict + text), when not right
--   audited_at   when; a row with it set is never audited again
alter table public.jori_gate_reviews add column if not exists audit_grade text check (audit_grade in ('right', 'partly', 'wrong'));
alter table public.jori_gate_reviews add column if not exists audit_note text;
alter table public.jori_gate_reviews add column if not exists audit_better text;
alter table public.jori_gate_reviews add column if not exists audited_at timestamptz;
create index if not exists jori_gate_reviews_unaudited on public.jori_gate_reviews (judged_at) where live and audited_at is null;
