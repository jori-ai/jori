# Conversations with the team

The app is a messenger with the user's team (system/org.md): every role is a "person" the user can talk to, like a contact in a messaging app. The coordinator (the chief of staff, the assistant itself) is there from the start; a role appears once it has something to say or the user adds it; the user can @mention roles into a conversation, start groups of several, and rename any role.

## Data (migration 0180, Supabase)

| Table / column | What it holds |
|---|---|
| `jori_team` | One row per role: `id` (the role plugin's id), `name`, `title`, `responsibility`, `chief_of_staff`, `enabled`, `sort`, `renamed_by_user`. `org sync` (every 10 min) writes it from the roster; the app writes `name`/`title` when the user renames a role, and sync keeps those. |
| `jori_conversations` | `role:<id>` (one role) or `group:<uuid>` (`members` = role ids, `title`); `last_message_at`, `archived`, `created_by`. |
| `jori_channel_roles` | The role that answers for each legacy channel: chat and questions → the coordinator, system → IT & Security, improvements → Software Engineer. |
| `jori_messages.conversation_id`, `.sender` | Where a message belongs and which role wrote it. |

Triggers: a row that names only a channel (or only a `sender`) is filed in the matching role's conversation, and `channel` stays meaningful for the older app; a role's conversation is created by its first message; `last_message_at` follows every insert.

## Writing to the user

- **Jobs** (`jori-send-curl`): the role that owns the job (or `--role <id>`) goes on the row as `sender`, so it lands in that role's conversation. The coordinator's own messages (hum, digests it owns) stay in its conversation. Emails and pushes are signed by role (system/org.md).
- **Questions** follow the same rule: a question lives in the conversation of the role whose job asked.
- **Replies** in the coordinator's conversation come from the chat agent (phone-channel `reply`), written into the conversation the user wrote in.

## The user writing to a role

phone-channel (`teamRoute`) decides who answers a user message:

- a message that @mentions roles (`metadata.mentions`, "a,b", set by the app from `@name`), in ANY conversation: each mentioned role answers in that same conversation on its own session; the coordinator answers too only when mentioned. The mention brings them into the conversation (they join its `members`); no new group is started (the user's call, 2026-11-10). A role joining someone else's conversation is told so, and reads its last 30 messages before answering;
- otherwise, in `role:<coordinator>` (or no conversation): the chat agent, as today;
- in `role:<id>`: that role's own session;
- in a group with no mention: the coordinator.

A role's message is queued at `data/role-queue/pending/<time>-<message id>.json`; launchd `ai.claude.role-session` (QueueDirectories, from the role-chief-of-staff plugin) runs `plugins/role-chief-of-staff/bin/role-session-trigger`, which for each role runs `agent/ops-agent/jobs/role-session.md` through `lib/run-ephemeral-opus.sh` on Sonnet at medium effort, with a task built by `bin/role-session prepare` (the role's specialization, the conversation's last 30 messages with names, the new message). The role answers with `bin/role-session reply` (sender = the role, a push titled with its name and title).

**Each role has its own session** (the user's choice): the fork resumes the role's last session (`JORI_FORK_RESUME`, recorded in `data/role-sessions.json` through `JORI_FORK_SESSION_OUT`) and starts a fresh one after 30 turns or 12 idle hours, because every resumed turn re-reads the whole session. The conversation's recent messages are in every task, so a fresh session loses nothing the user sees. Role sessions carry every rule in `agent/CLAUDE.md`; a role is a specialization of Jori, not a separate permission.

## The app

`apps/companion`: a conversation list (each row: names with their role titles, the last message, and a single red badge counting unread messages, unanswered questions and Face ID approvals — no icons, nothing when nothing is waiting), a conversation view filtered by `conversation_id` with the sender's name and title on each message in a group, `@name` autocomplete that brings a role into the conversation on screen (and sets `metadata.mentions`), new groups from the new-conversation sheet, and renaming a role's name and title. The channel menu is gone: channels are roles' conversations.
