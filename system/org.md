# The team — roles that own Jori's jobs

Jori runs a lot of independent jobs: an inbox triage, a finance review, a weekend-events scan, a nightly memory pass, a build pipeline. The **team** gives them an org chart. Each job belongs to a **role** with a title, a first name and one responsibility (a CFO, a Software Engineer, a Marketer, a Historian…). Every role reports to the user, **the CEO**, and one role, the **Chief of Staff**, coordinates the rest: it keeps track of every project and holds everyone accountable (the projects plugin, `plugins/projects`).

## Each role is a plugin

A role is a kernel plugin, `plugins/role-<id>/` (`jori plugin enable role-cfo`): its `plugin.json` carries a `role` block (`id`, `title`, `responsibility`, the kernel `jobs` it owns, `intents`, `chief_of_staff`) and its **specialization**, `specialization.md`: how that role thinks, what it checks, its standards. At dispatch the specialization is appended to the playbook of every job the role owns (the supervisor's webhook path in `agent/supervisor/http-server.mjs`, and `jori_job_prompt` in `agent/scripts/lib/local-rules.sh` for the forks), headed `## Your role on the team: <name>, <title>`, so the CFO's jobs run as a CFO. The kernel ships: Chief of Staff (requires the projects plugin), Executive Assistant, Software Engineer, IT & Security, CFO, Marketer, Property Manager, Travel Manager, Social Director, Relationships, Health Coach, Historian, Research Analyst, Sales Ops, Customer Success. All off by default.

## Where it lives

- **The roster:** the enabled role plugins, named and extended by `agent/local/config/org.json` (the installation's own: each `roles` entry by `id` gives the role its `name` and adds the installation's own `jobs` and `intents`; a role whose plugin is installed but off is off; an entry with no plugin at all is an installation-only role). No enabled role = no team, nothing signed.
  ```json
  { "ceo": "<the user's first name>",
    "roles": [
      { "id": "cfo", "title": "CFO", "name": "<first name>",
        "responsibility": "Cash, spending, investments, net worth.",
        "jobs": ["finance-review", "portfolio-*"],
        "intents": ["bank-alert"] },
      { "id": "chief-of-staff", "title": "Chief of Staff", "name": "<the assistant's name>", "chief_of_staff": true,
        "jobs": ["projects", "hum", "hum-*", "morning-digest"] } ] }
  ```
  `jobs` are job names (the task registry, playbooks, plugin schedules and launchd labels); a trailing `*` is a prefix. A launcher's wrapper prefix (`trigger-`, `venue-watch-`, `ai.claude.`) is ignored. **The most specific match wins**: an exact name beats any prefix, a longer prefix a shorter one. `intents` are the `jori-send-curl --intent` values that belong to the role when they are not a job's own name.
- **Code:** `lib/org.cjs` (`org`, `rolePlugins`, `roleFor`, `roleBrief`, `senderName`, `signSubject`, `signPing`, `chart`); `lib/plugins.cjs` validates a `role` block. **CLI:** `bin/org` — `org list` (the chart), `org who <job|intent>`, `org audit` (jobs no role owns; exit 1 when any), `org sign-subject|sign-ping <job> <text>`.

## Voice and personality

An installation can give each role a personality and a writing voice of its own (humor, seriousness, a way of speaking that fits its age and profession): `agent/local/team-voices/<role id>.md`. `lib/org.cjs` (`voiceOf`) appends it to the role's brief, so every job the role owns and its own sessions in the app write in it. The coordinator's chat agent carries its voice in the installation's chat local rules. The voice changes how a role sounds, never what is true or how much is said: the house rules (warm, short, no reply menus, no jargon) still hold, and humor drops away for bad news, money worries, health and security incidents. Kernel roles ship with no voice.

## In the app: conversations with the team

Migration `system/migrations/0180_team_conversations.sql` gives the app a team and conversations: `jori_team` (each role's id, name, title, responsibility; **the user can rename any role, name and title, in the app**, which sets `renamed_by_user`), `jori_conversations` (`role:<id>` with one role, `group:<uuid>` with several), `jori_channel_roles` (the legacy channel each role answers for: chat → chief-of-staff, system → it-security, improvements → software-engineer, questions → chief-of-staff) and two columns on `jori_messages`: `conversation_id` and `sender`. A trigger files a row that only names a channel (or a `sender`) into the right role's conversation and keeps `channel` meaningful for the older app; a role's conversation exists from its first message. **`org sync`** (every 10 minutes, the chief-of-staff plugin's `team-sync`) upserts the team into `jori_team` and keeps the user's renames, caching them in `data/team-renames.json`, which `org()` reads, so a rename reaches signatures and briefs too. **`jori-send-curl`** writes the speaking role's id as `sender` (from `--role`, else the job or intent's role; never the coordinator's), so a role's messages land in its own conversation.

## How the roles show

Each role **signs** what its jobs send to the user:

| What | How it is signed | Where |
|---|---|---|
| An email to the user | it comes **from** the role: From `Name (Title) <agent address>`, the subject untouched (replies too) | `email-send` (from `--sign <job>` or the job in `JORI_SIGN_AS` / `JORI_JOB`), `digest-deliver` (its `--intent`, through `JORI_SIGN_AS`) |
| An email to anyone else | From stays the assistant (others always hear from the user's assistant); subject `Name (Title): <subject>`, never on a reply | `email-send` |
| A chat or questions ping | `Name: <text>` | `jori-send-curl` (its `--intent`, else the job in the env), after every gate (precheck, claim-freshness, dedup) and before media |
| A push | title `Name (Title)` | `jori-notify` (when no `--title` was given) |

`cron-run` sets `JORI_JOB` to its label and `lib/run-ephemeral-opus.sh` to the fork's job, so a job's sends know who they are from. **Not signed:** the chief of staff's own pings and pushes (it is the assistant's voice: hum, chat replies), the system and improvements channels, the subject of a reply (`Re:` subjects, `--in-reply-to`), an email given an explicit `--from-name`, and anything sent with `JORI_NO_SIGN=1` (the push-failed fallback email, whose exact subject a P1 exception matches). `digest-deliver`'s Gmail lookup accepts the signed form of a subject (`<role>): <subject>`), so labelling still finds a digest that `email-send` signed.

## Rules

- **Every job has a role.** A new job, plugin schedule or launchd agent is added to a role in `org.json` in the same change (`org audit` lists the ones that are not). Where it fits two roles, it goes to the one whose responsibility is the job's purpose.
- **The roles are specializations, not new agents.** A role does not get its own model session or memory: its jobs run on the same agents, with the role's specialization appended to their playbooks, and the chat agent still answers as the assistant. "Who handles X?" is answered with `org who` / `org list`.
- **The Chief of Staff coordinates.** The projects job assigns Jori's own project tasks to the role whose domain they are, and its Sunday review reports by role (`plugins/projects/jobs/projects.md` Step 8).
