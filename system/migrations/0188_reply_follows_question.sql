-- An answer lives in its question's conversation.
--
-- 0180's backfill re-homed past questions to the role their metadata names
-- (people cards → the relationships role, finance questions → the CFO) but the
-- user's answers to them went by channel to the coordinator. The app judges a
-- question open from the replies in the conversation it shows, so 29 answered
-- cards (a "No, let it go" on Nov 2 among them) came back as "Waiting for your
-- answer" in their new conversation, with the answer stranded in another one.
--
-- 1. The routing trigger now puts any message that replies to another into
--    that message's conversation, whatever the writer passed.
-- 2. The replies already stranded move next to their questions.

create or replace function public.jori_messages_route() returns trigger
language plpgsql as $$
declare
  r text;
  parent_conv text;
begin
  if new.reply_to is not null then
    select conversation_id into parent_conv from public.jori_messages where id = new.reply_to;
    if parent_conv is not null then
      new.conversation_id := parent_conv;
    end if;
  end if;
  if new.conversation_id is null then
    r := coalesce(new.sender,
                  (select role_id from public.jori_channel_roles where channel = coalesce(new.channel, 'chat')),
                  'chief-of-staff');
    new.conversation_id := 'role:' || r;
  end if;
  if new.role = 'assistant' and new.sender is null and new.conversation_id like 'role:%' then
    new.sender := substr(new.conversation_id, 6);
  end if;
  -- A message written into a role's conversation by a newer writer still
  -- shows in the matching tab of the older app.
  if new.conversation_id like 'role:%' and (new.channel is null or new.channel = 'chat') then
    select c.channel into new.channel from public.jori_channel_roles c
     where c.role_id = substr(new.conversation_id, 6) and c.channel in ('system', 'improvements') limit 1;
    new.channel := coalesce(new.channel, 'chat');
  end if;
  return new;
end $$;

-- Repeated until nothing moves: Jori's reply to a moved answer follows it too.
do $$
declare n int;
begin
  loop
    update public.jori_messages r set conversation_id = q.conversation_id
      from public.jori_messages q
     where r.reply_to = q.id
       and q.conversation_id is not null
       and r.conversation_id is distinct from q.conversation_id;
    get diagnostics n = row_count;
    exit when n = 0;
  end loop;
end $$;
