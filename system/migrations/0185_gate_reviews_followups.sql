-- 0185_gate_reviews_followups — what happens to a message the speak gate held
-- (system/speak-gate.md § Live):
--   * digest  → printed in the daily summary email; `digested_on` is the day
--               whose summary carried it (set when that summary is published),
--               so it is printed once and a re-render of that day still has it.
--   * resolve → the answer the gate found goes back to the role that asked;
--               `handed_back_at` is when the role's session was given it.
alter table public.jori_gate_reviews add column if not exists digested_on date;
alter table public.jori_gate_reviews add column if not exists handed_back_at timestamptz;
create index if not exists jori_gate_reviews_held on public.jori_gate_reviews (verdict, judged_at desc) where held;
