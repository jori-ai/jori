# Chief of Staff (the projects plugin)

The **Chief of Staff** keeps track of all the user's projects and holds everyone
accountable: the user (their tasks, dated, on their own list, followed up when
they slip) and Jori (the work it can do itself, brought back for review).


A wiki page for every project the user is working on, from planning a trip to
building a product, kept current every night. Each page carries a managed block:
**Goal**, **What you might need** (open tasks, decisions, bookings, gaps the
evidence implies), **Tasks** (from the task ledger), **Coming up**, **Lately**, **People**. The people pages'
counterpart for the things the user works on.

- **How it works:** `bin/projects-trigger` (nightly cron) runs `projects gather`,
  which reads the calendar (past and upcoming), Google Tasks (open and recently
  completed), the wiki's project pages and recent changes, and commit activity,
  into `data/projects/bundle.json`, then dispatches the `projects` job
  (`jobs/projects.md`). The turn decides what is one project and writes the
  pages through `projects write-section|create`. The dream (`jobs/dream.md`
  Step 4.8) corrects and extends the same pages from each day.
- **Tasks:** every project has a task ledger (`lib/project-tasks.js`,
  `data/projects/tasks.json`). The user's tasks go on their Google Tasks list
  with a date and the project named in the title. Every change made through
  `projects task add|update|done|drop|reopen` reaches their list right away
  (the user: "managing tasks is like managing email — it should be done right
  away"; `--no-sync` for batch callers); `bin/projects-task-sync` runs every 10
  minutes as the backstop and picks up their own edits (theirs win). Each of
  their own changes is a message to the chief of staff: ticking a task off or
  deleting it asks "finished, or not needed any more?", a new date asks "what
  changed?" (a choice card in the coordinator's conversation), and the chat
  agent acts on the answer (`agent/chat-agent/CLAUDE.md` § Project Tasks); a slipped one gets one follow-up a week
  through the hum, and a Sunday email reviews the week. Tasks Jori may do on
  its own are done early each morning by `project-work` (launchd,
  `jobs/project-work.md`, `bin/project-work-trigger`) within a weekly share of
  the allowance, and every result comes back for review (a draft PR, a Face-ID
  card, an unshared Google Doc).
- **Turn on:** `jori plugin enable projects`.
- **Settings:** `agent/local/config/projects.json` (defaults in `config.defaults.json`).
- **Needs:** `gog` signed in for Calendar and Tasks; the wiki.
- **Commands:** `plugins/projects/bin/projects gather|list|show|write-section|create|reviewed|task …`.
- **Tells the user:** one email when a project page is added, adopted or
  changes status (and on the first run); a Sunday review; a review email when
  Jori finished project work; follow-ups on slipped tasks through the hum.
- **Tests:** `node --test plugins/projects/tests/`.
