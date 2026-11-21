-- 0183_conversation_pins — pin a conversation to the top of the list, the way
-- iMessage does (system/conversations.md). Null = not pinned; pinned rows sort
-- first, in the order they were pinned. Server-side so a pin made on the Mac
-- shows on the iPhone too. Only the app writes it; the touch trigger and org
-- sync never send this column, so a pin survives new messages and upserts.
alter table public.jori_conversations add column if not exists pinned_at timestamptz;
