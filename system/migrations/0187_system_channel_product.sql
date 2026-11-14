-- 0187_system_channel_product — all the tech in one role (system/org.md).
-- The IT & Security role was folded into Product (role id software-engineer)
-- on 2026-11-12, so the legacy System channel answers to Product, and the old
-- IT & Security conversation's messages read as Product's.
update public.jori_channel_roles set role_id = 'software-engineer'
 where channel = 'system' and role_id = 'it-security';
