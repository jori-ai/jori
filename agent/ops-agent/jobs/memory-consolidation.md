MEMORY CONSOLIDATION — Weekly content-level audit of the wiki (`pages` table). Auto-applies merges, supersedes, retires, and expands, then emails the user a report.

Runs Sundays at 10:00 home time. The hygiene counterpart to the wiki's automatic *writers* (daily-summary → `day_*`, hum-consolidate → hum-reply facts, chat-consolidate → conversation facts, the dream → whole-day learnings, revisions tagged `dream:<date>`, the weekly deep dream → 90-day likes/dislikes/drifts and the `user_long_view` portrait, tagged `dream-deep:<end>`): those ADD content broadly; this weekly pass PRUNES it — merging duplicates, superseding stale facts, retiring expired ones — so broad auto-apply doesn't let the corpus accumulate cruft as it scales.

## IMPORTANT — this job operates on the WIKI DB, not the .md files (repointed 2026-07-19)

Historically this job edited the `.md` files in the auto-memory dir (`node lib/instance.cjs --memory-dir`). **That was a no-op under DB-as-truth:** since 2026-05-02 the authoritative store is the `pages` table in `memory-index.db`, and `memory-snapshot` runs `wiki render-all` every 30 min, regenerating every `.md` from the DB — so any direct `.md` edit was clobbered within 30 min and never reached the store the agent actually reads. No cron runs `wiki backfill` (`.md` → DB), so the `.md` dir is a one-way rendered mirror. **All reads and writes in this job now go through the `wiki` CLI** (which mutates the DB, tracks a revision, and refreshes FTS). Never `rm`/`Write` a memory `.md` file — it does nothing durable.

## Critical rules

1. **Auto-apply every proposal** via the `wiki` CLI. Merges fold the orphan's unique content into the canonical page then `wiki delete` the orphan; supersedes use `wiki supersede`; retires `wiki delete`; expands `wiki save` the appended body. Every write is a tracked revision (revertable via `wiki history`). The email is a report, not an approval request.
2. **Conservative bar — the proposal still has to clear "would you actually accept this?"** Don't auto-apply borderline judgment calls; leave them out of the run entirely rather than apply-then-ask. If unsure, skip.
3. **Preserve provenance.** Never delete the only record of a fact. A merge keeps the canonical page (higher-signal type, or pinned, or more backlinks) and folds the orphan's unique lines into it BEFORE deleting the orphan. Never drop information in a merge — only duplication.
4. **Never touch health/financial pages or the episodic day/week/month pages.** `type=day|week|month` are an immutable episodic record (regenerated from `daily_summaries`) — do not merge/retire them. Anything sourced from health/bank data stays untouched (those live in their own jori-model-only stores; the wiki shouldn't hold specifics anyway).
5. **Never restructure a page wholesale or rewrite unrelated content.** Fold/append/supersede specific facts; leave the rest byte-for-byte.
6. **Silent-on-empty week.** If no active page changed in the last 7 days AND nothing clusters, send a one-line "nothing to consolidate this week" email and exit.
7. **One HTML email + one phone pointer + one push** (universal long-form delivery rule). No per-proposal messages.
8. **The user can dispute** — see the revert flow below (native `wiki history`, not email reconstruction).

## Step 1 — Harvest (diff-mode: recently-changed pages + their neighbors)

Auditing all 800+ pages every week is wasteful — consolidation only applies to pages that moved. Scope to the changed set + semantic neighbors:

1. `wiki recent --days 7 --json` — active pages updated in the last 7 days (the writers' output + any manual edits). This is the candidate set.
2. `wiki stats` — corpus size + per-type/per-status counts (growth + dangling-link signal).
3. For each recently-changed page, find its **duplication neighbors**: `recall "<page title + key nouns>" --no-chat -k 6` (or `wiki search "<...>" --mode hybrid`). Hybrid recall surfaces existing pages that state the same fact even when the wording differs — these are the merge/supersede candidates. Pull full bodies only for a changed page + a neighbor when a proposal actually needs them (`wiki read <id>` / `wiki render <id>`).
4. Previous run state: `~/Dev/jori/data/memory-consolidation-prev.json` (last-run timestamp + `pending_reconsider` list).

## Step 2 — Categorize and cluster

Group candidates by type and subject:
- **user** (preferences/profile) — contradictions or redundant phrasings of the same preference (two `user_*_taste` lines saying the same thing).
- **feedback** (rules/corrections) — multiple entries covering one behavior; earlier rules superseded by newer ones.
- **project** (in-flight work) — an entry whose event/deadline has passed → retire or convert to `reference`/`historical`.
- **reference** (pointers/facts) — the referenced resource no longer exists, or a newer page restates it better.

Clustering heuristic: two pages likely mergeable when a hybrid-recall neighbor scores high AND they share the same central named entity (person, project, place, file path). Two pages likely supersede-related when a newer one contradicts or strictly extends an older one.

## Step 3 — Proposal classes

Group in the email in this order:

- **Merge (strongest signal):** two+ pages describe the same fact/rule. Choose the canonical (higher-signal type / pinned / more backlinks — check `wiki backlinks <id>`), fold the orphan's unique content into it, retire the orphan.
- **Supersede:** a newer page contradicts or strictly extends an older one. Flip the old to `superseded` and link them.
- **Retire:** a page's subject has expired (project past its deadline, a reference to a gone resource, a rule the user reversed in conversation since). Delete with a one-sentence rationale.
- **Expand:** a thin page (<5 lines) on a topic with repeated related asks this week. Add specific content — cite the asks; never invent.

## Step 4 — Apply changes (via the `wiki` CLI — DB writes, tracked revisions)

For each proposal that cleared the bar, apply it now (before composing the email). **Capture each page's pre-change body first** (`wiki render <id>`) so the email can quote it for revert.

- **Merge:**
  ```bash
  wiki render <canonical> > "$TMPDIR/page.md"     # current bytes
  # …fold the orphan's UNIQUE lines into $TMPDIR/page.md (add a [[wikilink]] if the orphan named an entity)…
  wiki save <canonical> --body @"$TMPDIR/page.md"
  wiki delete <orphan>                             # soft-delete; final revision is archived
  ```
- **Supersede:** `wiki supersede <old_id> <new_id>` (atomic — flips old→`superseded`, adds the edge, new page's frontmatter gains `supersedes:`). If it's a partial supersede (a fact within a page), edit the old page's body instead.
- **Retire:** `wiki delete <id>` (soft-delete; revision survives for revert).
- **Expand:** `wiki render <id> > "$TMPDIR/page.md"`; append the new content; `wiki save <id> --body @"$TMPDIR/page.md"`.

Do NOT touch `MEMORY.md` — that index belongs to the legacy file-based auto-memory, which is disabled (`autoMemoryEnabled:false`); the wiki has no equivalent index to hand-maintain (pins are `wiki-audit`'s job).

## Step 5 — Compose and send the email

```
Memory Consolidation — Sun <DATE>

Applied to the wiki:
- <N> merges   - <M> supersedes   - <K> retires   - <J> expands

<per-proposal: page id(s) touched, one-line why, and the pre-change body verbatim>

Reply "revert <ID>" to undo one change, or "revert all" for the whole run.
```

Deliver per the universal long-form rule (`ops-agent/CLAUDE.md`) with ONE command (2026-10-05: delivery via digest-deliver). `bin/digest-deliver` sends the HTML email to the owner (instance `owner_email`), finds it in Gmail by exact subject (bounded wait), labels `personal` + star + mark read — **no `p1`**, per the 2026-08-17 correction: a Jori-initiated digest is not P1 — verifies it is still in the INBOX, then sends the short phone pointer (`--no-push`) and the APNs push. Do not hand-run `email-send`, `gmail-action`, `jori-send-curl` or `jori-notify`.

```bash
~/Dev/jori/bin/digest-deliver \
  --subject "Memory Consolidation — Sun <DATE>" \
  --body-file /tmp/memory-consolidation.html \
  --intent memory-consolidation \
  --pointer "<one short line: what changed>" \
  --push "Memory Consolidation — Sun <DATE> is in your inbox"
```

On a silent-empty week, a single one-line "nothing to consolidate" email is enough: omit `--pointer` and `--push`. Exit 1 = the email did not send and nothing else ran — report it. Exit 2 = sent but unlabeled — note it.

## Step 6 — Persist run state

After send, write `~/Dev/jori/data/memory-consolidation-prev.json`:
```json
{ "ran_at": "<ISO>", "proposals_applied": N, "pages_touched": ["id", ...], "pending_reconsider": ["id", ...] }
```

## Revert flow (dispatched)

If the user replies `revert <ID>` / `revert all`, `email-inbound.md` dispatches this playbook's revert path. Prefer the **native wiki history**:
- A superseded/expanded/merged-into page: `wiki history <id>` → `wiki save <id> --body <(wiki show-rev <id> <prev_rev>)`.
- A deleted (retired/merged-away) page: its final revision survives the soft-delete — recreate it with `wiki save <id> --body <(wiki show-rev <id> <last_rev>)`; undo the supersede edge if one was added.
- Fallback: the verbatim pre-change body in the email. Reply with a short confirmation.

## State file

`data/memory-consolidation-prev.json` — last-run timestamp, applied count, pages touched, `pending_reconsider`. Single writer (this job).

## Guardrails

- Wiki `pages` writes only (via `wiki` CLI). Never money/calendar/tasks/outbound (beyond the one report email/pointer/push). Never edit memory `.md` files (clobbered no-op).
- Never merge/retire `day|week|month` episodic pages, health/financial-derived pages, or `pin_locked` identity-core pages (superseding the load-bearing identity core needs a human — flag it, don't auto-apply).
- **Never merge or retire an `entity: person` page for being thin, and never fold one back into a hub** (every person the user knows has their own page; content builds over time). Two person pages are mergeable only when they are the same human, and a shared name alone doesn't show that. Don't "expand" a person page's `## Email` block; `email-people write-section` owns it. See `system/wiki-architecture.md` § People pages.
- Never drop information in a merge; only duplication. Never invent content in an expand.
- Idempotent: a re-run over the same week must not re-propose an already-applied change (check `pending_reconsider` + that the duplicate is already gone).

## Budget

6 min wall-clock, ~25 tool calls. One email, one pointer, one push. No per-proposal messages.
