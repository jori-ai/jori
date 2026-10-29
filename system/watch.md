# Watches — standing trigger → action instructions

**Status:** live 2026-10-23 (MVP). Engine `lib/watches.mjs`, CLI `bin/watch`, tests `tests/watches.test.mjs`. **Policy (same day):** every request for something to happen later — conditional, trip-relative or a plain time — is a watch, from any agent or channel (`agent/CLAUDE.md` § Reminders & Future Actions); how well it works is tracked (§ Tracking) and reviewed weekly (`jobs/watch-review.md`).

## Why it exists

The user wanted a trigger/action mechanism: something tied to a flight booking or any other event, that watches quietly in the background and, when the event happens, performs an action (an email, a task, anything Jori can do), linked to memory.

Before this, "remind me when X" had nowhere to live. A chat turn could write a wiki page saying "when a Japan trip is booked, remind me", but nothing ever read that page when a Japan trip appeared. One-off cron reminders cover a fixed time, not a condition.

(Not to be confused with the shows **watchlist** (`watchlist`, `watch_titles`) or the venue **`*-watch`** lanes (`lib/venue-events/watch.mjs`).)

## The shape

```
 sources                         engine (`watch tick`)                         actions
┌──────────────────────┐        ┌──────────────────────────────────┐        ┌────────────────────┐
│ hum-sense sensors    │─tap──▶ │ spool → events                   │        │ notify  (chat, via │
│  (every event)       │        │   × event rules (type glob)      │        │   jori-send-curl│
│ mailbox (gog, 2 min) │──────▶ │   → Jev watch-match / Sonnet     │──fire─▶│   precheck on)     │
│  + USPS mail scans   │        │ travel timeline → trips          │        │ task    (Google    │
│  (on-device OCR)     │        │   × anchor rules → fire time     │        │   Tasks)           │
│ `watch emit`         │        │ clock × at rules                 │        │ agent   (ops-light │
└──────────────────────┘        │ unclear → hum-ask question       │        │   jobs/watch-action│
                                │ reply → Jev watch-answer         │        └────────────────────┘
                                └──────────────────────────────────┘                 │
                                     ▲ watch_rules / watch_matches                   ▼
                                     │ (memory-index.db)                 "## Watch log" line on
                                     └──────── the watch's wiki page ◀──── the watch's wiki page
```

## A watch = a memory page + a rule row

| | where | what |
|---|---|---|
| **The instruction** | wiki page, `type: watch`, `watch_id: <id>` in frontmatter | the user's words verbatim, why it matters, `[[links]]` to the people/places/projects it touches, and a `## Watch log` the engine appends to on every firing. This is how recall, the chat agent and the dream jobs know the watch exists and what it already did. |
| **The compiled rule** | `watch_rules` row in `data/memory-index.db` (same DB as the wiki; `page_id` points at the page) | the typed form the engine evaluates every tick without reading prose: trigger kind, event-type globs, the condition string the model reads, anchor offset, action, recurrence, expiry, `context_pages` (memory handed to an `agent` action). |
| **Every decision** | `watch_matches` row, `UNIQUE(rule_id, subject_key)` | one per (watch, candidate): verdict `match` / `no_match` / `unclear` / `asked` / `confirmed` / `rejected` / `ask_skipped` / `missed`, who decided (`jev` / `legacy` = Sonnet / the owner's `owner_id`), `fire_at`, `fired_at`, the question id. A candidate is judged **once**; verdicts are never re-asked. |

## Trigger kinds

| kind | fires when | example |
|---|---|---|
| `event` | an event whose `type` matches one of `listens` (structural glob: `email.*`, `mail.piece`, `travel.metro_change`) arrives AND the model says it satisfies `condition` | "when the Bank of America letter arrives" — listens `email.received`, `mail.piece` |
| `anchor` | a trip on the travel timeline matches `condition`; fire time = the trip's `leave` (takeoff of the inbound flight) or `arrive`, plus `offset_min`, optionally snapped to `local_time` in the user's timezone. No `offset_min` = as soon as the trip is on the timeline | "two days before I leave for Lisbon" — `field: leave, offset_min: -2880, local_time: 09:00` |
| `at` | a fixed time | "on Dec 1 remind me…" |

**Trips** come from `travel list --json` (`buildTrips`): every real stay (not `transit`, not an undecided `a|b` Schrodinger stay) with the flight leading into it. A trip already over is never considered. Anchored rules re-read the timeline every 10 min, so a moved flight moves the fire time; a once-matched trip keeps its verdict.

## Event sources

- **hum-sense** — `bin/hum-sense` taps every event it sees into `data/watch-spool.jsonl` (whatever hum's gate does with it) and kicks a detached `watch tick` at most once a minute, or within 10 s when there are fresh events. The engine's model calls never run inside hum's tick.
- **Mailbox** — polled only while some active rule listens to `email.*` / `mail.piece`: `gog gmail search "in:inbox newer_than:2d"` every 2 min → one `email.received` per new thread message (from + subject). Cold start records a watermark and replays nothing.
- **Physical mail** — a USPS Informed Delivery digest (sender domain `informeddelivery.usps.com`) is unpacked: each `mailer-*.jpg` envelope scan is downloaded to `data/watch-mail/` and OCR'd on-device (`data/.bin/photo-ocr`, Apple Vision) → one `mail.piece` event whose summary carries the envelope text. `content-*.jpg` (ride-along ads) are ignored.
- **A virtual mailbox** (Anytime Mailbox; its label in summaries is `agent/local/config/watches.json` `virtual_mailbox_label`) — read-only from `data/anytime-mail-state.json`, which `bin/anytime-mail-check` writes after it OCRs and judges each new envelope (sender, recipient, important/junk). Each new envelope → one `mail.piece` event. Read every tick while a rule listens to `mail.piece`; the first read replays only envelopes from the last 3 days.
- **`watch emit --type T --summary S`** — anything else (a script, a test).

New sources: spool an event with `spoolEvents()` (`{type, subject_key, summary, data}`), or add a hum-sense sensor — the tap picks it up with no watch change.

## Who decides (Rule #0b)

- **Does this candidate satisfy the condition?** Jev, site `watch-match` (`data/jev-questions/watch-match.json`, choice match / no_match / unclear, threshold 0.85) through `decide()`; below threshold, tool-less Sonnet with the same question. At most 4 Sonnet fallbacks per tick; the rest wait for the next tick.
- **Unclear → a hum question.** `hum-ask --id watch-<match id> --lane watch` (one per tick, only when hum's question slot is free and they're awake). The user's reply lands in `hum-responses.jsonl` through the normal `hum-answer` path; Jev site `watch-answer` reads it: yes → fire, no → rejected for good, unclear → stays asked (the open-questions lane re-asks).
- Code owns only structure: type globs, trip geometry, fire times, the awake window.

## Firing

- Only inside **08:00–21:59 local** (`AWAKE`). A match at 03:00 is held and fires at 08:00; nothing is dropped for timing.
- **notify** → `jori-send-curl --intent watch:<id> --evidence-as-of live` on chat; the precheck stays on. The message is the rule's `notify` text plus one line naming what set it off. A failed send is retried next tick (the match stays unfired).
- **task** → `gog tasks add @default`.
- **agent** → a `task` POST to ops-light (job-routing `watch-action`) that points at `jobs/watch-action.md` and carries the watch, its memory pages, the trigger and the instruction. Use it when the action needs judgment or tools beyond a reminder.
- `recurrence: once` → the rule goes `done` after its first firing; `each` → it stays armed (one firing per distinct candidate) until retired or `expires_at`.
- Every firing appends `- <local time> — fired (<actions>): <what happened>` to the page's `## Watch log`.

## Writing a watch (chat agent, or by hand)

1. Write or reuse the wiki page (the user's words, the why, links).
2. Write a spec and run `watch add --file spec.json [--page-body body.md] --by <chat|ops|email|job> --request "<the user's exact words>"` (`--by`/`--request` are how the weekly review audits coverage):

```json
{
  "id": "passport-check-before-lisbon",
  "title": "Check the passport's expiry two days before leaving for Lisbon",
  "page_id": "watch_passport_check_before_lisbon",
  "trigger": { "kind": "anchor", "condition": "the user leaves for Lisbon (a trip to Lisbon / Porto)",
               "anchor": { "source": "travel", "field": "leave", "offset_min": -2880, "local_time": "09:00" } },
  "action": { "notify": "…", "task": { "title": "…", "notes": "…" } },
  "recurrence": "once",
  "context_pages": ["watch_passport_check_before_lisbon"]
}
```

`condition` is read by a model, so write it the way the user said it, specific enough to reject near-misses. `watch test <id> --type T --summary S` shows the verdict for a hypothetical candidate without storing anything; `watch trips` shows what anchor rules see.

Manage: `watch list [--all]`, `watch show <id>` (every decision + firing), `watch pause|resume|retire <id> [--reason] [--by]`, `watch confirm|reject <id> <subject_key>` (settle a match by hand).

## Tracking — how well it works

How well the engine works is tracked, so it can be improved:

- **`watch_events`** (memory-index.db, append-only) records every step: `created`/`updated` (with `origin`), `decided` (verdict, `jev`/`legacy`, ms), `decide_failed`, `asked`, `ask_skipped`, `answered` (yes/no/unclear, minutes to answer), `fired` (actions, delivery `sent`/`suppressed` + the precheck's reason, chat `message_id`, Google `task_id`, minutes late vs `fire_at`), `fire_failed`, `status:*` (retired/paused/expired, by whom, why), `manual:confirmed|rejected`, `feedback` (the user's words), `missed` (a reminder the user says never came).
- **The user's side** is captured by the chat agent: `watch feedback <id> "<the user's words>"` on any reaction to a reminder, `watch miss "<what>"` when one never came, `watch reject` when it fired on the wrong thing. Emoji reactions and task completion are read live from `jori_messages.reaction` and Google Tasks.
- **`watch stats [--days N] [--json]`**: the scorecard. Engine liveness, coverage (`created_by`, active watches missing a `request` quote), decision mix, questions, firings (delivered vs suppressed, lateness, never delivered), reactions, tasks done, feedback, misses, corrections, per-watch next fire.
- **Liveness:** `watchdog.sh` pages the system channel when `last_tick` is over 30 min old while watches are armed (two runs, once a day).
- **Weekly review** (`jobs/watch-review.md`, ops-light): a **coverage audit** reads every message the user sent that week for reminder-type requests and checks each became a watch (creating any missing one), plus a **quality review** of the scorecard. It ships up to 3 fixes through the self-improve tools, appends a trend line to `data/watch-review/history.jsonl`, and emails a short scorecard only when something happened.

## Operations

- Log: `agent/logs/watch.log` (firings, failures, expiries). State: `data/watch-state.json` (mail watermark, travel cache, retry list). Both gitignored with the spool, lock and `watch-mail/`.
- The tick is single-flight (`data/.watch-tick.lock`, stale after 15 min or a dead pid).
- `watch tick --dry-run` runs a pass without acting (decisions are still recorded).
- Backups: the rows live in `memory-index.db`, covered by the hourly `wiki-db-snapshot`; the pages also sync to Supabase via `wiki-cloud-sync`.

## Not yet (deliberately outside the MVP)

- Calendar-anchored rules ("the morning of the dentist") and a `wiki.write` event source.
- Rules proposed from memory ("you usually need a dog sitter when you both travel — want a watch?").
- A per-rule quiet-hours override for genuinely urgent watches.
