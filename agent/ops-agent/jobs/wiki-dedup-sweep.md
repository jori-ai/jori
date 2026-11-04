WIKI DEDUP SWEEP — monthly full-corpus duplicate/staleness pass over the wiki. Proposes clusters by email; never edits a page.

Runs on the 6th at 02:20 local, as a launchd user agent (not cron, not a webhook dispatch — see below). The full-corpus counterpart to the weekly `memory-consolidation` job.

## Purpose

`memory-consolidation` is **diff-mode**: it audits pages changed in the last 7 days plus their semantic neighbors. That is right for hygiene on a moving corpus, but it structurally cannot see two duplicate pages written weeks apart — neither is "recently changed" in the same week, so the two are never compared. Those long-standing duplicates are the residue nothing sweeps.

This job compares **every active curated page against every other one**. It is cheap because the pages are already embedded (`page_embeddings`, written by the nightly `wiki-embed` cron), so candidate generation is local vector math — no model calls, and no page bodies entering any agent's context window. Only the handful of clusters that survive both candidate gates get a model verdict, each in its own fresh one-shot context.

Output: one HTML email with the duplicate/overlap clusters and a ready-to-run `wiki supersede` command per proposal. **Silent when nothing is actionable.**

## How it runs — a launchd user agent, no agent turn

`ai.claude.wiki-dedup-sweep` (plist in `agent/launchd/`) runs the binary directly on the 6th at 02:20 local:

```
~/Dev/jori/bin/wiki-dedup-sweep run --email
```

**There is no ops-agent dispatch and nothing for an agent to do.** This job was first wired the usual way — cron → trigger → webhook → ops-agent turn → `job-run` — and that was wrong on both counts:

- **It needs the GUI login session, which cron does not have.** Judging forks one `claude -p` per cluster; a `claude -p` outside the Aqua session cannot unlock the keychain holding the Max credentials, prints `Not logged in` and exits 0. This is the same constraint that moved the improvement family onto launchd user agents (see `scripts/lib/run-ephemeral-opus.sh`).
- **The agent turn had nothing to earn.** The playbook's whole instruction was "run this command, then ack." Two live dispatches on 2026-07-29 each spent a Sonnet turn (~$0.65) to type one bash line, and the second turn decided on its own not to run it. A binary that emails its own report does not need an agent in front of it.

To run it by hand: `launchctl kickstart -k gui/$(id -u)/ai.claude.wiki-dedup-sweep`, or just run the command above from a GUI-session terminal on the mini.

## What it actually does

1. **Load** active pages that have a current embedding (`page_embeddings.body_hash = pages.body_hash`, so a page edited since the last nightly embed is skipped rather than compared against a stale vector).
2. **Exclude** episodic `day`/`week`/`month` pages, and generated directory pages (see below).
3. **Candidate pairs** need BOTH: cosine ≥ 0.85 AND rare-token Jaccard ≥ 0.15, where "rare" means a token on ≤5% of pages. Neither gate alone works — see the calibration notes in `lib/wiki-dedup.mjs`.
4. **Cluster** surviving pairs transitively, so three pages restating one fact are judged once as a trio.
5. **Judge** each cluster via `runOneShot` (fresh `claude -p --no-session-persistence`, `--effort low`), concurrency 3, cap 30 clusters/run.
6. **Report** duplicates and overlaps by email, with the `wiki supersede` command spelled out.

### Generated pages are out of scope, on purpose

555 of the 784 otherwise-in-scope pages are travel-pipeline index pages ("This is the … page for [[…]]" — city, country, airline, canonical). They are excluded because (a) they are regenerated, so a `wiki supersede` on one is undone on the travel job's next run, and (b) a country page shares *all* its distinctive vocabulary with its own city pages (the same trip wikilinks), so both gates read them as duplicates when they are a country and a city in it.

That leaves ~284 curated pages, which is the real target.

**Follow-up — DONE 2026-07-29.** Calibration found genuine defects *inside* the generated travel-place family (one city filed under two spellings, a city filed under the wrong country, a postcode used as a city name, region codes as page names). Those were name-normalization bugs in the travel place-directory sync, fixed there, and that sync now runs **weekly** on its own launchd agent. This is the sweep's first real payoff: it is the only pass that compares the whole corpus against itself, so it is the only thing that could have found them.

## State file

`data/wiki-dedup-state.json` (gitignored — it names memory pages).

```json
{
  "last_run": "<ISO>",
  "judged":   { "<pageA>|<pageB>": { "verdict": "...", "hash_a": "...", "hash_b": "...", "judged_at": "<ISO>" } },
  "reported": { "<clusterId>": { "first_reported": "<ISO>", "times": 3 } }
}
```

- A pair judged **distinct** is suppressed on later runs **while both pages are unchanged** (hash match). This is what keeps a monthly full-corpus sweep from re-spending on the same settled neighbors forever. Edit either page and the pair re-opens.
- An **actionable** verdict is NOT suppressed — ignoring a duplicate is not the same as deciding it isn't one, so it resurfaces, and the email says "reported N× before, still open."

## Guardrails

1. **Propose, never act.** The module has no write path to the wiki — it cannot delete, supersede, or edit. It prints commands; a human runs them. A full-corpus auto-prune is far too blunt to be the first act-on-memory capability, and `memory-consolidation` (which does auto-apply) is deliberately scoped to a handful of recently-changed pages.
2. **Never touches health or financial pages**, same as `memory-consolidation` rule 4.
3. **Silent on empty.** No email when nothing is actionable.
4. **Bounded.** ≤30 clusters judged per run; when the cap bites the email says how many were dropped. A silent truncation would read as "the corpus is clean" when it isn't.
5. **Read-only on the DB.** Only `data/wiki-dedup-state.json` is written.

## Failure modes

- **Ollama down / nothing embedded** → `loadPages` returns few or no rows, the sweep finds nothing, exits silent. No email. Self-corrects once the nightly `wiki-embed` catches up.
- **A judge call fails or returns garbage** → that cluster degrades to `distinct` and proposes nothing. The failure mode is deliberately under-reporting, never a bogus merge.
- **`claude -p` unauthenticated** (launched outside the GUI session) → every judge returns `Not logged in`. The run logs `WARN N/N judges failed (… unauthenticated)`, records NOTHING to state, sends no email, and **exits 4**. It does not report a clean corpus — that distinction cost the first live run and is now covered by tests.
- **Never pages the user about its own health.** Per `agent/CLAUDE.md` § System Channel, only `watchdog.sh` authors infrastructure alerts.

## Manual use

```bash
wiki-dedup-sweep calibrate                  # joint (cosine × Jaccard) survivor grid
wiki-dedup-sweep run --dry-run              # candidate clusters, no model calls
wiki-dedup-sweep run --threshold 0.9 --json # tighter, machine-readable
```
