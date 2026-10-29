WIKI LINK WEAVE — weekly: give every person the user knows their own page, wire people to each other, and link the mentions a name list can't catch ("Dana's sons", a bare first name). One short push when something changed.

## Purpose

A weekly task reviews the memory wiki and creates links between different concepts: if a person's sons are mentioned ("Dana's sons"), the mention links to each son's page. Every person the user knows has their own page — content builds over time — and some names need disambiguating (two people who share a first name).

Division of labour:
- **`wiki-link-audit`** (nightly, code) links the exact, unambiguous names in `data/wiki-link-concepts.json` on every page. It is only as good as that list.
- **`people-email`** (nightly, model) creates person pages from email correspondence.
- **This job** (weekly, model) does what neither can. It splits people out of hub pages, grows the name list, resolves relational phrases and ambiguous first names from context, makes relations two-way, and finds pages nothing links to. `bin/wiki-people` does the graph geometry; you do the reading.

## Pipeline

```
trigger-wiki-link-weave.sh (Mondays, after Sunday's memory-consolidation)
  → wiki-people audit --json   > data/wiki-link-weave-audit.json
  → wiki recent --days 7 --json > data/wiki-link-weave-recent.json
  → dispatch to ops-light
this turn:
  Step 1 hub split backlog → Step 2 name list → Step 3 mentions in this week's slice
  → Step 4 two-way relations → Step 5 orphans → Step 5.5 co-used pairs
  → Step 6 questions → Step 7 push + state
```

## Step 1 — Split people out of hubs (≤15 people per run)

Hubs are directory pages for a group: extended family, nieces and nephews, cousins, aunts and uncles, the user's children, and couple or family pages (`user_<first>_<first>_<last>`). The local additions list this wiki's hubs. On the first run, add `entity: people-hub` to each hub's frontmatter (`wiki render` → edit → `wiki save`).

For each person named on a hub who has no page of their own (check `audit.people[]`, then `wiki search`), up to 15 a run, most-linked hubs first:

1. **Create their page.** Use the template and id rule in `jobs/people-email.md` Step 3 (`entity: person`, `user_<first>_<last>`, with a qualifier on a clash plus "Not to be confused with" lines). A child of Dana Levi is `user_noam_levi`. Use the surname the wiki records or clearly implies, and when it doesn't, ask (Step 6) and use the first name plus the parent's surname until the user answers.
2. **Move that person's facts** from the hub to their page: every line about them alone. Keep the original dates and provenance tags. **Never drop a fact**; this is a move. Lines about a shared event ("the family lunch at Dana's") stay on the hub and gain links to each person.
3. **Leave a one-line entry on the hub**: `- [[user_dana_levi|Dana Levi]] — eldest sister (<town>)`.
4. **Relations section** on the new page, typed per `jobs/people-email.md` Step 3 § Relations are typed and always written (`child_of [[user_dana_levi|Dana]]`, not "son of …"), with links both ways where the other person has a page (Step 4 catches any you miss).
5. **Repoint existing links.** For each display text the wiki uses for them on the old hub link (`wiki backlinks <hub>` shows the pages; look for `[[hub|Noam]]`, `[[hub|Noam Levi]]`, …):
   ```bash
   ~/Dev/jori/bin/wiki-people retarget --from <hub_id> --to user_noam_levi --display "Noam" --dry-run
   ~/Dev/jori/bin/wiki-people retarget --from <hub_id> --to user_noam_levi --display "Noam"
   ```
   It rewrites link syntax only, and only exact display matches.
6. **Register names** with `wiki-people concept-add` (the safe-alias rules are in `people-email.md` Step 3).

Some jobs read a hub page whole and follow its person links (the local additions name them). Splitting a hub must leave its person links intact so readers can follow them.

## Step 2 — The name list

For every `audit.not_in_concepts` person page, run `wiki-people concept-add` with their full name and any unique nickname as `--alias`, and any first name that's shared or an ordinary word as `--ambiguous`. Check `audit.collisions` for aliases two concepts claim. The linker already treats those as ambiguous, so it can't guess. Make sure each one is on the right side of each concept.

Spot-check a newly added alias before trusting it to nightly auto-apply:

```bash
~/Dev/jori/bin/wiki-link-audit --json | jq '.suggestions[] | select(.target=="<id>")'
```

That run is read-only. If it would link something wrong, move the alias to `--ambiguous`.

## Step 3 — Mentions the name list can't catch

**This week's slice:** every page in `wiki-link-weave-recent.json`, plus the next eighth of the non-episodic, non-`travel_*` active pages in id order, starting at `state.cursor`. That covers the whole wiki about every two months.

Read each page and link:
- **Relational phrases**: "Dana's sons", "my sister's boys", "my partner's mother", "the twins", "both kids". Link to the specific person pages: `Dana's sons ([[user_noam_levi|Noam]] and [[user_ari_levi|Ari]])`, or wrap the phrase itself when it names one person (`[[user_ruth_cohen|my partner's mother]]`).
- **Ambiguous first names** (a first name two pages share, or one that is also an ordinary word): link only when the page itself settles who it is (same paragraph names the parent, the place, the event). If you can't tell, leave it and add a question (Step 6).
- One link per person per paragraph is enough. Don't link inside code, existing links, headings or quotes. Never touch `day`/`week`/`month` pages here: the nightly linker covers them through the name list, and their bodies are regenerated.

Save each page with `wiki save <id> --body @file` once, after all its edits.

## Step 4 — Two-way relations

For each entry in `audit.asymmetric` (`need: "B → A"`), add the inverse relation to B's `## Relations` section as a typed line (`jobs/people-email.md` Step 3): `child_of` ↔ `parent_of`, and `sibling_of`, `spouse_of`, `partner_of`, `friend_of`, `works_with`, `relative_of`, `related_to` on both. If A's link to B isn't a relationship (a passing mention), it doesn't need a return link, so skip it.

While you are on a person page for Step 1 or Step 4, convert any free-text Relations lines ("Father of …", "fiancée of …") to tokens, keeping the wording as the plain words after the link, and link a hub (`[[<hub_id>|Ari]]`) to the person's own page when it exists. A person page with **no** Relations section but a stated relation in its text gets one (every person page connects to related people). Evidence only; never infer a relation.

## Step 5 — Pages nothing links to

For each `audit.orphans` page, add a link from its natural parent: a project to its project hub, a person to their hub, a trip to `travel`. If it looks expired or duplicated, don't link it. List it in `state.orphans_flagged`, and Sunday's `memory-consolidation` handles retire/merge.

## Step 5.5 — Pages used together but never linked (≤10 a run)

`data/wiki-link-candidates.json` (rewritten nightly by `wiki-assoc nightly`, `lib/wiki-hebbian.mjs`) lists pairs of pages that the auto-recall judge kept **together** for the same message again and again, with no link between them in either direction: `pairs[]` with both ids and titles, `weight` (0–2, decayed; ≥0.3 to be listed), `times_used_together`, `last_used_together`. Using them together is evidence they belong together; it is **not** a relation.

For each pair, strongest first, read both pages and decide:
- **They are related** (one is about the other, they share a trip, a person, a project) → add one link where it reads naturally, in the page's own voice, or a `related:` frontmatter entry when no sentence fits. Two people → a `## Relations` line on each, only when you can say what the relation is.
- **They are only co-recalled** (two unrelated pages a broad question kept pulling up) → leave them. The pair keeps its Hebbian weight in recall either way, so declining costs nothing.

Never invent a relation to justify a link. Record each pair you acted on, and each you declined, in `state.cooccurrence` (`{a, b, action: "linked"|"related"|"declined"}`), so next week does not redo them.

## Step 6 — Questions (≤3 a run)

Anything you couldn't settle (whose surname, which Guy, whether two pages are the same person) becomes a hum question. Use the format in `jobs/people-email.md` Step 5 with `"source":"wiki-link-weave"`. Before asking, read `data/hum-ideas.jsonl` so you don't repeat a question already waiting there.

## Step 7 — Push and state

If anything changed, send **one chat message** in the short-bullet shape: a one-line header, then up to 6 `- ` bullets of ≤8 words each, topic first. It goes through the normal outbound precheck. Example:

```bash
~/Dev/jori/bin/jori-send-curl --intent wiki-link-weave "Wiki people and links, this week
- People: 12 new pages (Dana's family)
- Links: 41 added, 3 relations made two-way
- Names: 9 added to the auto-link list
- Hum will ask you which Ari emails you"
```

Nothing changed → no push. Don't restate last week's numbers.

Write `data/wiki-link-weave-state.json`:

```json
{ "ran_at": "<ISO>", "cursor": "<last page id in this week's slice>", "pages_created": [], "pages_linked": [], "relations_added": 0, "concepts_added": [], "orphans_flagged": [], "cooccurrence": [], "questions": [] }
```

## Guardrails

- Wiki writes only, plus the concept map (via `wiki-people`), ≤3 hum questions and one chat message. No email.
- Never drop or rewrite a fact. Splitting is a move. Linking changes link syntax, not wording, except where a relational phrase needs the names added in parentheses.
- Never edit `day`/`week`/`month` or `pin_locked` pages. Propose a `pin_locked` change as a hum question.
- Never put health or financial specifics on a person page. When moving a hub fact that has them, leave that line on the hub.
- Never merge or retire a person page for being thin. Thin person pages are intended.
- At most 15 new person pages a run from hubs, so a bad run is easy to revert (`wiki history <id>`).

## Failure modes

- **Audit file missing**: run `wiki-people audit --json` yourself (it's local).
- **A `retarget` dry-run shows pages you didn't expect**: stop that retarget and say why in the push.
- **The run dies midway**: everything saved is a revision. Next week's audit sees the half-done state, and `cursor` is only written at the end, so the slice repeats.
