# Watchlist Recommendations

On-demand procedure for the chat agent, moved verbatim out of `agent/chat-agent/CLAUDE.md` (which keeps the trigger and hard rules inline). When this file and CLAUDE.md seem to disagree, CLAUDE.md's inline rule wins.

## Watchlist Recommendations

**HARD ROUTE — mandatory, no exceptions.** Whenever the user is asking what to watch — "what should we watch?", "next show?", "something for tonight", "movie night", "anything good?", in any wording — run `next-show.mjs` before you compose a reply. You decide that it's that kind of request by reading it (Rule #0b); there is no pattern to match.

Pick the list from what the user said: "we / us / tonight together" → `--category together`; "I / me / solo / alone" → `--category solo`; a movie or documentary → `--category movies`; unclear → no `--category` (the tool shows together and solo).

Command: `bin/next-show.mjs --format phone [--category together|solo|<partner_id>|movies]` (the partner's own list is `partner_id` in `agent/local/config/watchlist.json`). It returns `{message_file, summary, message}` JSON — send it with the phone-channel `reply` tool as `reply({message_file, summary})`: the file goes out exactly as written, and you don't retype ~2k characters (that retyping was ~6s of every watchlist answer). `message` is there so you know what was sent; only if `message_file` is null, relay `message` verbatim instead. Do NOT reformat, trim, substitute, or answer from memory. The tool owns the layout and the ranking (new seasons of shows they've watched first, then new titles scored on their own verdicts).

Mid-thread corrections take effect immediately: "we finished X" → `watchlist mark-watched "X"`; "we already saw X" → `mark-watched`; "not into X" → `watchlist reject "X"`; "X was great / meh" → `watchlist rate "X" <verdict> --note "<their words>"`. Then re-run `next-show` before replying.

**Capture every opinion.** Any time the user says how something was — in any conversation, not just a hum ping — record it with `watchlist rate`. Verdicts are the only signal the recommendations learn from; an opinion that only lives in the chat transcript is lost to them.

**Why this is a hard rule:** 2026-04-18 — five "what to watch?" questions in one day got a reasoned-from-memory answer at least once instead of `next-show` output, requiring a mid-thread correction. The tool is the source of truth.

For adding/removing/marking shows: use the `watchlist` CLI. Full CLI docs: `watchlist --help` (and the installation's `agent/watchlist-rules.md` when it has one) — read them before running a command; they are not in your session by default.

### Title fact-check (any show/movie mentioned outside `next-show` output)

When your draft reply states facts about a show or movie title (country, year, genre, director, cast, plot) and the facts are NOT coming from `next-show.mjs` output or a watchlist row you just read, run `bin/omdb-verify "<Title>"` first. Use the returned fields verbatim; do not reason about titles from memory.

**What counts as "stating facts":** country/origin ("Israeli thriller"), year, genre, director, cast, platform, plot description. Pure IMDb-URL mentions that don't assert facts are fine without verification.

**Platform is not in OMDb.** Do not state which streaming service a title is on unless it comes from `next-show` output, a watchlist row's `platform` field, or `watchlist where`. For "where can I watch X" — or any time you'd name a platform — run `bin/watchlist where "X"` (MCP: `watch_where`): it covers any title (on the list or not), lists stream / free / rent / buy, and when the travel timeline has the user abroad it adds the local country automatically. Quote it; never guess a platform.

**If OMDb returns not-found (exit 2):** say "I can't confirm that title on OMDb" rather than filling in plausible-sounding details. A "I don't know" is always better than a confident hallucination.

**Why this rule exists:** 2026-04-19 — the chat agent stated a title's country, origin and platform from memory and all three were wrong. The `watchlist description` field and `next-show` tool are already grounded; this rule extends that grounding to every ad-hoc title mention.

