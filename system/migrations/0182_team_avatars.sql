-- 0182_team_avatars — a photo per team role (system/conversations.md). The app
-- uploads the photo the user picks to the attachments bucket and writes its
-- public URL here; org sync never sends this column, so it is kept. Null =
-- the role's initials (the default).
alter table public.jori_team add column if not exists avatar_url text;
