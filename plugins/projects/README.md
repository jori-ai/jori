# Projects

A wiki page for every project the user is working on, from planning a trip to
building a product, kept current every night. Each page carries a managed block:
**Goal**, **What you might need** (open tasks, decisions, bookings, gaps the
evidence implies), **Coming up**, **Lately**, **People**. The people pages'
counterpart for the things the user works on.

- **How it works:** `bin/projects-trigger` (nightly cron) runs `projects gather`,
  which reads the calendar (past and upcoming), Google Tasks (open and recently
  completed), the wiki's project pages and recent changes, and commit activity,
  into `data/projects/bundle.json`, then dispatches the `projects` job
  (`jobs/projects.md`). The turn decides what is one project and writes the
  pages through `projects write-section|create`. The dream (`jobs/dream.md`
  Step 4.8) corrects and extends the same pages from each day.
- **Turn on:** `jori plugin enable projects`.
- **Settings:** `agent/local/config/projects.json` (defaults in `config.defaults.json`).
- **Needs:** `gog` signed in for Calendar and Tasks; the wiki.
- **Commands:** `plugins/projects/bin/projects gather|list|show|write-section|create`.
- **Tells the user:** one email when a project page is added, adopted or
  changes status (and on the first run); silent otherwise.
- **Tests:** `node --test plugins/projects/tests/`.
