WEEKEND EVENTS — Find the best local events this weekend, send as EMAIL, post a short pointer + push.

Before starting, run `~/Dev/jori/bin/doctor-preflight-check weekend-events` — logs any failures to `data/logs/weekend-events-doctor.log` and always continues. **Do NOT include `doctor` output in the email** — the email is user-facing content, and never call `jori-send-curl` from this step (see `agent/CLAUDE.md` § System Channel — only `watchdog.sh` pages on infra health; a job-scoped turn's sandboxed Bash tool masks localhost connections, so a healthy machine can look broken from inside this job). The email stays focused on weekend picks only.

> **This instance's additions** to this playbook are in `agent/local/jobs/weekend-events.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (an ephemeral or by-hand run), `Read` that file before you start (absent = no additions).

Delivery follows the universal long-form rule (ops-agent CLAUDE.md → Scheduled Jobs → Long-form delivery rule): one HTML email + one short phone pointer + one push. No per-category phone messages.

## Steps
1. **Determine which city the user will be in THIS WEEKEND from the travel timeline — not GPS.** Run `~/Dev/jori/bin/travel where <Saturday YYYY-MM-DD>` (and Fri/Sun if the weekend spans a hop). Use that metro as the search city. Only fall back to `findme locate "$(node ~/Dev/jori/lib/instance.cjs owner_id)" --json` if `travel where` returns unknown, and to the user's home city after that. This matters because the user may be traveling this weekend — recommending the home city's events while they're away is exactly the bug the travel timeline exists to prevent. If the weekend is split across two cities (a hop mid-weekend), scope each day to that day's city.
   - **Geo-gate every event before including it** (mandatory per `ops-agent/CLAUDE.md` § Travel Timeline & Event Geo-Gating): for each candidate event, it must be in the city the user will be in on that event's date — `travel in-city "<event city>" <event YYYY-MM-DD>` (exit 0 = keep). Drop any that fail, UNLESS `~/Dev/jori/bin/headliner check "<artist>"` exits 0 (tier-1 headliner worth traveling for). If nothing survives for the weekend, send nothing.
2. **Use agents in parallel** to research each category. Launch one agent per category:
   - Live music & concerts
   - Comedy shows — in the languages the user follows stand-up in (the instance's additions say which; drop a show in another language wherever the user is traveling, even if well-reviewed), and never a comedian the user has already seen or booked this calendar year unless it is a new show: `comedian seen "<name>" --year <show year>` (ops `CLAUDE.md` § Event Pre-Send Checks #3)
   - Theater
   - Food festivals, pop-ups, markets & street fairs
   - Art, sports, outdoor & other notable events
   - Any extra category the instance's additions list for a city (e.g. outdoor movie series, a curated local listings site treated as a primary source)
3. Each agent should:
   - Search comprehensively for events this Friday–Sunday in the city
   - **Verify every event against a primary/official source** (venue website, official event page, or ticketing platform) before including it. Do NOT rely on aggregator articles, "third Friday of the month" pattern extrapolations, or calendar entries without source links. Confirm the specific date, start time, and location from the source itself.
   - **Verify ticket availability** — check the event/venue page to confirm it's not sold out
   - Pick the **2–5 best** events only — quality over quantity
   - For each event: name, venue, day, time, one-line description, ticket status (available/free/sold out), **source URL used for verification**, and a link to buy tickets or learn more
   - **If a date/time cannot be verified from a primary source, omit the event entirely.** Never include an event with a guess or extrapolated date.

   **Verification log:** After researching, write a one-line entry per event to `/tmp/weekend-verification-<YYYYMMDD>.md`:
   ```
   | Event | Date | Time | Source URL | Verified? |
   | <Night market> | Apr 17 | 6pm | <venue site> (last listed: Oct 2024) | NO — omitted |
   | <Comedian> | Apr 17 | 7pm | <venue site>/events/<comedian> | YES |
   ```
   This log is for internal reference — do not include it in the email.
4. Compile results from all agents and mark the **top pick** per category with `[TOP]`.

## Step A — Build the email

**First, set the filename stamp ONCE and reuse it verbatim in Step B.** Do NOT recompute the date separately when you build vs. when you send — a build/send filename mismatch (one stamped with Saturday's date, the other with the run date) sends a body file that doesn't exist, and the finished email is orphaned.

```bash
HOME_TZ=$(node ~/Dev/jori/lib/instance.cjs tz)
STAMP=$(TZ="$HOME_TZ" date +%Y%m%d)   # the RUN date; use this exact $STAMP in Step B too
BODY="/tmp/weekend-$STAMP.html"
```

Write the HTML to `$BODY` (i.e. `/tmp/weekend-$STAMP.html` — always the run date, never the Saturday/Sunday date). One section per category (skip a category only if the agent found nothing — still include the heading with "No picks this week"). A city-only extra category is omitted entirely when the user is not in that city. No emojis anywhere.

**Every event link must be rendered as an `og-card`** (see ops-agent CLAUDE.md → "Use `og-card` for every URL in outbound email"). For each event, output the one-line label first, then the rendered card HTML for that URL on the next line. Example section (what lands in the HTML file):

```
<h2 style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:16px;margin:20px 0 6px 0">MUSIC</h2>
<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#1a1a1a;margin:6px 0">[TOP] <Artist> — <Venue>, <Day> <Time> — <price/free></div>
<!-- paste stdout of:  ~/Dev/jori/bin/og-card "<ticket or event link>"  -->
<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#1a1a1a;margin:6px 0"><Event> — <Venue>, <Day> <Time></div>
<!-- paste stdout of:  ~/Dev/jori/bin/og-card "<link>"  -->
```

Batch approach (faster when you have many URLs at once):

```bash
printf '%s\n' "${ALL_URLS[@]}" > /tmp/weekend-urls.txt
~/Dev/jori/bin/og-card --batch < /tmp/weekend-urls.txt > /tmp/weekend-cards.html
# cards come back in input order, separated by "<!-- og-card-sep -->" — split and interleave with labels
```

Repeat for: MUSIC, COMEDY, THEATER, FOOD & DRINK, OTHER, and any city-only extra category.

Keep it tight — 2–5 events per section, one line of description, one card.

## Step B — Deliver: email + Gmail labels + phone pointer + push (one command)

Reuse the **same** `$STAMP`/`$BODY` set in Step A — do not recompute the date here.

`bin/digest-deliver` sends the email, finds it in Gmail by exact subject (bounded wait), labels `personal` + star + mark read, verifies it is still in the INBOX, then sends the phone pointer and the push. Do not hand-run `email-send`, `gmail-action`, `jori-send-curl` or `jori-notify` for delivery. Never `p1`, no P1 triage-style notification — the pointer is the only ping. No content dump on phone — the full picks live in email; the pointer hook is a one-line tease (a few concrete names counted by category), not a recap.

<!-- geo-gate-ok: every event is gated per-candidate at Step 1 (`travel in-city` + headliner bypass) before it's ever included; these are pointer/failure notices about the digest, not raw event details, so nothing reaching them needs re-checking. -->

```bash
CITY="<resolved city>"
FRI_DATE="$(TZ="$HOME_TZ" date -v-fri '+%b %-d')"   # this weekend's Friday
SUN_DATE="$(TZ="$HOME_TZ" date -v+sun '+%b %-d')"   # this weekend's Sunday
SUBJECT="Weekend in $CITY - $FRI_DATE to $SUN_DATE"
BODY="/tmp/weekend-$STAMP.html"   # SAME $STAMP as Step A — must be the file you just wrote

# Guard: never hand a missing/empty body to the sender (a silent drop).
if [ ! -s "$BODY" ]; then
  ~/Dev/jori/bin/jori-send-curl --suppress-hook "weekend-events: no email body at $BODY — picks NOT sent (build step produced nothing)"
  exit 1
fi

deliver() {
  ~/Dev/jori/bin/digest-deliver \
    --subject "$SUBJECT" --body-file "$BODY" --intent weekend-events \
    --pointer "Weekend picks emailed - check inbox. <short hook, e.g., '3 comedy, 2 theater, an outdoor movie'>." \
    --push "Weekend in $CITY: $FRI_DATE to $SUN_DATE picks ready"
}
# Exit 1 = the email did not send and nothing else ran: retry once, then alert loudly.
deliver; RC=$?
if [ $RC -eq 1 ]; then
  sleep 5; deliver; RC=$?
  [ $RC -eq 1 ] && ~/Dev/jori/bin/jori-send-curl --suppress-hook "weekend-events: email-send failed twice — weekend picks built but UNDELIVERED ($BODY)"
fi
```

Exit 2 = sent but Gmail had not indexed it in time, so it is unlabeled (pointer + push still went) — note it in your output; no further action.

