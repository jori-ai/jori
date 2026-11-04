BIRTHDAY BRAINSTORM — surface experience-gift ideas for the people the user celebrates, well ahead of their birthdays.
<!-- geo-gate-ok: the chat sends are reminders that a memo exists or a birthday is near, not event picks; the options themselves go by email and are chosen for where the person will be on the day (step on travel context). -->

> **This instance's additions** to this playbook are in `agent/local/jobs/birthday-brainstorm.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (an ephemeral or by-hand run), `Read` that file before you start (absent = no additions).

Experience gifts (concerts, trips, dinners, tickets, classes) need lead time, and a day-of reminder is too late. This job opens the thinking well before each birthday so there is time to plan and book.

**Do NOT draft birthday messages, cards or texts.** The user writes their own. This job is about gift ideas, not greetings.

## Who and when

`agent/local/birthday-brainstorm/people.json` (private; the trigger reads the same file):

```json
{ "stages": [{"months": 2}, {"months": 1}, {"days": 7}, {"days": 0}],
  "people": [{"name": "<first name>", "month_day": "MM-DD", "wiki_id": "<page id, optional>", "birth_year": 1990}] }
```

`agent/scripts/trigger-birthday-brainstorm.sh` dispatches only on a stage day for someone in that file; no file or no people → it never fires. A month stage keeps the day of month (clamped to the month's last day), so 03-29 has stages 01-29, 02-28, 03-22 and 03-29.

Each stage has a role:

| Stage | Role |
|---|---|
| the earliest month stage (default T-2 months) | **Kickoff** |
| a later month stage (default T-1 month) | **Concrete options** |
| a day stage > 0 (default T-7) | **Reminder** |
| day 0 | **Day-of** |

## Steps

1. **Who is due today, at which stage.** Read `people.json` and work out, for today's local date, which people are on which stage (the same arithmetic as the trigger; use `gdate` for weekday and date math, never your head). Nobody due → exit silently: no message, no notification. Several people (or stages) on one day → handle each in its own message, never merged.

2. **Load context for the person** before writing anything:
   - Their wiki page (`wiki read <wiki_id>`, or `wiki search "<name>"`), and any hub page it links (a family page, a partner's page). Facts may be on either.
   - Their taste and the user's shared taste where relevant: the `together` watchlist (`watchlist list --category together`), the music profile if the installation keeps one.
   - Where they are and where the user will be: `travel where <birthday date>`; upcoming trips that could be combined with a visit or a gift.
   - What the user already said: `context-search "<name> birthday"` and `recall "<name> birthday"`. If the user already chose a gift, shift the memo to confirmation and prep instead of fresh brainstorming.
   - The age they turn: from `birth_year` or their page. A milestone birthday (the instance's additions say which) gets milestone-scale ideas, not a standard-year memo.

3. **Act on the stage:**

### Kickoff
Goal: open the thinking. Short.

- State the date, the age they'll turn (when known), and 3–4 **broad experience categories** worth exploring this year (not bookings yet), each tied to known taste or context. For example: a concert in their taste ("I can scan for tour dates around <month>"), a weekend trip, a dinner experience in their city, a class or workshop on a recent interest.
- End with: "Want me to start researching any of these? Reply with which directions to pursue."
- Do NOT book anything. Do NOT draft a birthday message.

Deliver via `~/Dev/jori/bin/email-send` as Jori → the user, subject `Birthday kickoff — <Name>`, HTML body. ALSO send a short notification: `jori-send-curl "🎁 <Name>'s birthday in ~2mo — kickoff memo sent"`.

### Concrete options
Goal: **3–5 concrete, bookable experience-gift options** with enough lead time to act on.

- **Pull real, current event data** with the `tickets` CLI before writing anything:
  - concerts and shows: `~/Dev/jori/bin/tickets for-artist "<artist name>"` (real dates, venues, price ranges);
  - one event: `~/Dev/jori/bin/tickets event <id>`;
  - a text search: `~/Dev/jori/bin/tickets search "<query>" --city <city>`.
  - Every ticketed option MUST carry a real event URL and price range from this tool, never a guess.
- For each option: what it is, date, location, approximate cost, booking link, and **why it fits** (one sentence citing their taste or context). Mix categories; favor options tied to known travel or interests, in the city the person will be in. Options that include the person's partner are welcome where it fits.
- **At the end of the memo**, one line: *"To start a purchase, reply `buy option N for $MAX`. Jori puts option N in the cart (total at most $MAX) and your phone asks for Face ID before any money moves."*
- Send via `~/Dev/jori/bin/email-send` as an HTML memo, subject `Birthday options — <Name>`.
- Follow-up notification: `jori-send-curl "🎁 <Name>'s birthday in ~1mo — <N> experience options in your inbox"`.

### Reminder
Short notification only, no memo:
`jori-send-curl "🎂 <Name>'s birthday in 1 week (<YYYY-MM-DD>). <Age they're turning>. If no gift yet, last call to book."`

### Day-of
Short notification only:
`jori-send-curl "🎂 Today is <Name>'s birthday — <Age>. <Relevant context: where they are, their time zone, recent notes>."`

## Guardrails

- Never draft the birthday message, text, card or call script. Ideas and context only.
- Research options on the web, but never commit to anything that requires payment; a purchase goes through the user's explicit `buy option N` and the purchase flow's Face ID approval.
- Never contact the person, or anyone about the gift (it may be a surprise).
- Silent on non-stage days: no "nothing today" messages.
- Keep the kickoff short (categories and prompts) and the options memo focused (3–5 options, tight why-lines).
- A one-time extra stage for a milestone (named in the instance's additions) never becomes a recurring stage for anyone else.
