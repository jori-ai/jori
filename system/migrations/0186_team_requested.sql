-- 0186_team_requested — the user adds a role to the team from the app
-- (system/org.md § Growing the team).
--
-- jori_team lists every installed role: the ones on the team (enabled) and the
-- ones the user can add (enabled = false). When the user picks a role that is
-- not on the team yet (a new conversation, or adding it to one), the app sets
-- `requested_at`; `org sync` and the phone channel turn that role's plugin on
-- and clear it. A personal assistant becomes a chief of staff the moment a
-- second role joins (lib/org.cjs soloTitle).
alter table public.jori_team add column if not exists requested_at timestamptz;
