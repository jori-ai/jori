# The team — roles that own Jori's jobs

Jori runs a lot of independent jobs: an inbox triage, a finance review, a weekend-events scan, a nightly memory pass, a build pipeline. The **team** gives them an org chart. Each job belongs to a **role** with a title, a first name and one responsibility (a CFO, a Software Engineer, a Marketer, a Historian…). Every role reports to the user, **the CEO**, and one role, the **Chief of Staff**, coordinates the rest: it keeps track of every project and holds everyone accountable (the projects plugin, `plugins/projects`).

## Where it lives

- **The roster:** `agent/local/config/org.json` (the installation's own; no file = no team, nothing signed).
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
- **Code:** `lib/org.cjs` (`roleFor`, `signSubject`, `signPing`, `chart`). **CLI:** `bin/org` — `org list` (the chart), `org who <job|intent>`, `org audit` (jobs no role owns; exit 1 when any), `org sign-subject|sign-ping <job> <text>`.

## How the roles show

Each role **signs** what its jobs send to the user:

| What | How it is signed | Where |
|---|---|---|
| An email | `Name (Title): <subject>` | `email-send` (from `--sign <job>` or the job in `JORI_SIGN_AS` / `JORI_JOB`), `digest-deliver` (its `--intent`) |
| A chat or questions ping | `Name: <text>` | `jori-send-curl` (its `--intent`, else the job in the env), after every gate (precheck, claim-freshness, dedup) and before media |
| A push | title `Name (Title)` | `jori-notify` (when no `--title` was given) |

`cron-run` sets `JORI_JOB` to its label and `lib/run-ephemeral-opus.sh` to the fork's job, so a job's sends know who they are from. **Not signed:** the chief of staff's own pings and pushes (it is the assistant's voice: hum, chat replies), the system and improvements channels, replies (`Re:` subjects, `--in-reply-to`), and anything sent with `JORI_NO_SIGN=1` (the push-failed fallback email, whose exact subject a P1 exception matches). `digest-deliver`'s Gmail lookup accepts the signed form of a subject (`<role>): <subject>`), so labelling still finds a digest that `email-send` signed.

## Rules

- **Every job has a role.** A new job, plugin schedule or launchd agent is added to a role in `org.json` in the same change (`org audit` lists the ones that are not). Where it fits two roles, it goes to the one whose responsibility is the job's purpose.
- **The roles are a lens, not new agents.** A role does not get its own model session or memory: its jobs run exactly as before, and the chat agent still answers as the assistant. "Who handles X?" is answered with `org who` / `org list`.
- **The Chief of Staff coordinates.** The projects job assigns Jori's own project tasks to the role whose domain they are, and its Sunday review reports by role (`plugins/projects/jobs/projects.md` Step 8).
