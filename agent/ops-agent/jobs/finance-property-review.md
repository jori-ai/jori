# Finance Property Review — Monthly Per-Property Deep Dive

Produces the user's **monthly real-estate review**: what each property actually
earned last month, in which Schedule E categories, against the month before and
the same month a year earlier — plus reconciliation health, rent-roll
collection, reserves, deposits and yield.

**This is the monthly half of a deliberate split.** The weekly finance review
is about **liquidity, accuracy and anomalies** — what needs attention in the
next seven days — and it keeps real estate to a single table on purpose,
because a paragraph per property every week says almost the same thing every
week. The questions that genuinely change month to month live here. That split
is the weekly review's own cadence table:
weekly = liquidity/accuracy/anomalies, monthly = per-property P&L, Schedule-E
categorisation, reserves, reconciliation.

**Never duplicate the weekly job.** No card utilization, no subscriptions, no
14-day obligations, no anomaly sweep, no fraud scan. If you find yourself
writing about a credit card, you are writing the wrong email.

**Read-only and money-movement-incapable** (bound by `agent/CLAUDE.md §
Financial Operations`). **Bank + ledger rows are jori-model-only
(health-data tier)** — reason over them ONLY with your own model; never send
transaction rows, balances or account numbers to any third-party/external LLM,
or to any outbound channel except the user's own email + phone.

## Step 1 — Build the packet (deterministic; don't do the math yourself)

```bash
bin/finance-property-review-data --json
```

Reports the **last closed calendar month** by default (`--month YYYY-MM` to
override). A P&L for a month still in progress is a number that will be wrong
by the time anyone acts on it.

**It runs on the 16th, not the 2nd**: the monthly review runs after every
rent for the month should have settled (by the 15th). Two weeks of extra
settling gives the rent processor time to finish paying out and the classifier time to clear
the month's rows, so the reconciliation and rent figures are read once rather
than read early and revised.

Every dollar figure is pre-computed and pre-formatted (`*_fmt`). **Quote those
strings verbatim — do NOT recompute or restate numbers yourself.** LLM
arithmetic on money is error-prone, and this packet has more numbers in it than
any other job's.

If the CLI exits non-zero, the rental ledger is unreachable (or this
installation has no rental books). **Stop and
send nothing** — this job *is* the ledger's report, and there is no degraded
version of it worth sending. That is the opposite of the weekly job, whose bank
half stands on its own.

## Step 2 — Compose the review (HTML email)

Longer than the weekly by design — this is the one that gets read slowly, once
a month. Still lead with the finding, still tables over paragraphs.

1. **⚠️ Worth your attention** — `attention[]`, already ranked. If empty, say
   "A clean month — nothing needs a decision." This is what the user reads first.
2. **The month at a glance** — `portfolio` (income / expenses / net / margin),
   with `groups.short_term` and `groups.long_term` beside it. One or two
   sentences on what moved and why, from the per-property rows.
3. **Each property** — one block per property, in `properties[]` order (worst
   net first, so the one needing attention leads). Per block:
   - the headline row: `income_fmt`, `expenses_fmt`, `net_fmt`, `margin_fmt`
   - the comparison: `prior_net_fmt`, `mom_change_fmt`, and `yoy_net_fmt` /
     `yoy_change_fmt` when the property was held a year ago
   - the trailing twelve: `t12_income_fmt`, `t12_net_fmt` — **this is the
     number to trust for whether a property is working**, because a single
     month carries whatever repair happened to land in it
   - the category table from `lines[]`: category, Schedule E line, this month,
     last month, change. Show the movers, not all thirty rows.
   - **Rent: two different findings, and they must not be conflated.**
     `rent_trailing.broke` means collection has fallen against the property's
     **own** recent history — that is what a tenant going quiet looks like, and
     it is the one that deserves attention. `rent_trailing.books_mismatch`
     means the leases contract for more than the property has *ever* been
     collecting while collection is steady — that is a lease record to
     reconcile, not rent behind, and it belongs in a sentence, not an alarm.
     Report `rent_roll_fmt` / `rent_collected_fmt` / `rent_gap_fmt` as context;
     never call a gap against the roll "missing rent" on its own.
   - `reserve_fmt`, `vacant_units`, `leases_expiring_90d` when non-empty
   - `value_fmt`, `yield_on_value_fmt`, `cash_on_cash_fmt` — **annualised from
     the trailing twelve months, not this month × 12**; say so if you quote them
   - **Owner-use properties (rentals the household also lives in; `owner_use`
     is set) — see § Owner-use properties below.** Their headline row is already adjusted; read that
     section before you write either block.
4. **Short-term vs long-term** — two or three sentences comparing the groups.
   They are different businesses wearing the same asset: one carries cleaning,
   platform fees and lumpy nightly revenue, the other a rent roll and turnover.
   This is the section that earns its place by being impossible to see weekly.
5. **Schedule E, year to date** — the `schedule_e` table (category, line, this
   month, YTD). This is what the return is shaping up to look like. Awareness
   only: **never suggest a tax action, a deduction strategy, or a reclassification
   for tax purposes.** It is the books as they stand: say once that it is
   **before** the owner-stay adjustment (`schedule_e_note`), because the month
   figures above it are not.
6. **Reconciliation health** — two numbers, and the second is the one that
   bites. `portfolio.ytd_unclassified_count` / per-property
   `unclassified_count` are rows that HAVE a property but no category; they
   count in no total, so that property's net is **provisional**, and you should
   say the word.

   **`unattributed_income` is the complement, and it is not covered by that
   count.** A row belonging to no property is dropped before the unclassified
   counter runs, so it is not "unclassified" — it is absent, and the count
   reads zero while real money sits outside every statement. This section
   lists booking-platform money that reached a bank account and no property.
   Report `this_month` in full (date, amount, account) and `earlier` as one
   line. If it is non-empty, a property's reported income is understated by
   that amount and you must say so next to the property it most likely belongs
   to — without asserting which one, unless the description names it.
7. **Security deposits** — from `deposits` (the hub's per-tenant record, read by
   `finance-deposits-reconcile`): `liability_fmt` owed vs `balance_fmt` in the
   deposit account, whether it `reconciled`, and every `missing` line verbatim.
   Nothing about deposits beyond those lines.
8. **Sold this year** — `portfolio.sold_this_year`, if non-empty, so the YTD
   total reconciles against the books.

Rule #0 voice — a thoughtful person who read the books, not a spreadsheet bot.
Local time (the instance time zone) for all dates. Collapse any quiet section to one line rather than padding it.

### Owner-use properties

Some rentals are also the household's own homes; their income and expenses are
judged without the time the household is in them. The packet does this in code
(`lib/owner-stays.js` and its config); you narrate it, you do not redo it.

**What the packet did.** A night counts as the family's when the user's phone was
inside the property in the small hours (`owner_use.basis` says when; the phone's location record, **not**
`travel_segments`, which holds no past nights). The property is then read on the
nights it was available to rent: income stays as booked; cleaning, turnover and
platform fees (costs a guest causes) stay whole; every other expense is scaled by
the share of the month it was rentable. **A property let by full months only**
(`owner_use.full_months_only`) is different: if the household is there for part
of a month, that month is not eligible for rent anyway, so any owner night makes
the whole month not rentable and its non-guest expenses are set aside in full,
never scaled by a leftover night (`month.not_rentable_month`). Other owner-use
properties scale by nights. For these properties the packet's
`income_fmt` / `expenses_fmt` / `net_fmt`, `lines[]`, `prior_net_fmt` and the
portfolio and short-term roll-ups are **adjusted**; the as-booked figures sit in
`owner_use.month.as_booked`, `owner_use.prior_month`, and the roll-ups'
`as_booked_*_fmt`. Properties without `owner_use` are not adjusted.

**How to write it.**
- Say the method **once**, near the top of the month-at-a-glance, in two sentences
  from `owner_use.basis` (which also says other household members' travel is not tracked).
- In each owner-use block, lead with whose home it was: `owner_nights` of `days`
  (use `owner_use.month`), then the adjusted row with the as-booked net beside it,
  so the adjustment is visible and not buried. Say what was set aside
  (`expenses_set_aside_fmt`).
- **`month.not_rentable_month: true`** (a full-months-only property, any owner night): say the
  family lived there and the month is not let, in those words, never "29 of 30
  nights, 1 available". `rentable_nights` is 0. Name what stayed (guest costs,
  `expenses_fmt`) and what was set aside (`expenses_set_aside_fmt`).
- **Income in a not-rentable month** (`income_in_not_rentable_month_fmt`,
  `prior_month.income_in_not_rentable_month_fmt`, `window.income_in_not_rentable_months_fmt`):
  income stays as booked, but setting that month's expenses aside makes it read better
  than as booked. Say so in a sentence and quote the as-booked net beside it; never
  hide it. It means a guest paid in a month the family also slept there.
- **`window.by_month`** is a small table (month, owner nights, not rentable or let,
  adjusted net, as-booked net): use it for a full-months-only property. `income_per_rentable_night_fmt`
  there is income from the months that were let over those months' nights only.
- **`judge: false`** (fewer than `judge_min_nights` rentable nights): the month
  says almost nothing about the property. Say that plainly, **do not call it
  negative or a loss**, and give the longer read below instead.
- **`window`** is the longer read (first adjustable month through this one):
  adjusted vs as-booked income, expenses and net, `rentable_nights`, and
  `income_per_rentable_night_fmt`. Use it in place of the trailing-twelve for these
  properties, and say when the location record starts (`year_ago_note` names the date).
- **Trailing twelve is still as booked** for these two and still includes the
  family's own months (`t12_note`); quote it only labelled that way. **Yield and
  cash-on-cash are left out** on purpose (`yield_note`): do not compute one.
- **Year over year** is not compared on the adjusted basis; if you mention a year
  ago use `owner_use.year_ago_as_booked_net_fmt` and call it *as booked*.
- `unknown_nights` are counted as rentable (no fix near 3am); mention them only
  if they are more than a night or two of the window.
- `owner_use.available: false` → the property is shown as booked; say why
  (`reason`) in one line.
- **Never invent a reason a stay happened or what a night cost.** Report what the
  packet says.

**The lines you must not cross:**

- **No tax advice.** Schedule E appears so the user can see the shape of the year. Not
  a strategy, not a reclassification suggestion, not a deduction idea.
- **No portfolio or transaction actions.** Not "consider raising rent", not
  "this property underperforms, consider selling". Report what the books say.
  A recommendation to buy, sell or reprice is the user's call and has its own flows.
- **Security deposits are never cash**, here as everywhere.
- **Never recompute.** If a number you want does not exist as a `*_fmt` string,
  say what you can from the strings that do.

## Step 3 — Deliver (long-form delivery rule)

Per `agent/ops-agent/CLAUDE.md § Long-form delivery rule`:

**One command** (2026-10-05: delivery via digest-deliver): it sends the HTML
email, finds it in Gmail by exact subject (bounded wait), labels it with the
rental portfolio's Gmail label (`agent/local/config/rental-finance.json`
`review_label`, `personal` when unset) + **star** + mark read (never `p1`, no re-notify), verifies it is still in the
INBOX, then sends the phone pointer and the APNs push. Do not hand-run
`email-send`, `gmail-action`, `jori-send-curl` or `jori-notify` here.

The pointer hook is mandatory and must carry a finding — the rent gap, the
negative property, the unclassified count; if the month was genuinely clean,
**omit `--pointer` entirely** (no pointer at all).

```bash
POINTER=$(cat <<'POINTER'
August property review is in your inbox — <property> collected $5,260 against a $10,800 rent roll.
POINTER
)
PUSH=$(cat <<'PUSH'
<subject-line summary>
PUSH
)
bin/digest-deliver \
  --subject "Property review — <Month YYYY>" \
  --body-file /tmp/property-review.html \
  --label <review_label> \
  --intent property-review \
  --pointer "$POINTER" \
  --push "$PUSH"
```

**Why the quoted heredoc:** a dollar amount inside a double-quoted bash literal
is a shell variable. `"... collected $5,260 ..."` expands `$5` to the empty
string and the user receives *"collected ,260"* — which has shipped before. `<<'POINTER'` (quoted delimiter) expands nothing, and `"$POINTER"`
is not re-expanded. Never put a figure in a double-quoted literal.

**Why `--intent property-review`:** bank and ledger content must never enter
`outbound-precheck`'s reasoning or its log file (`agent/CLAUDE.md` §
Financial Operations, rule 5). That exemption is keyed on the intent, and
`property-*` is on the allowlist, so passing it makes the skip implicit. With
no intent the pointer goes through the precheck and the ledger content lands
in `outbound-precheck-log.jsonl`.

Exit 1 = the email did not send and nothing else ran — stop (below). Exit 2 =
sent but unlabeled (pointer + push still went) — note it.

Do not email anyone but the user. Do not create tasks. The review is
informational; every action stays the user's. If the send fails (exit 1), stop — never fall
back to another channel for financial data.

## State

**None.** The job is a pure function of the ledger and the month, so a re-run
produces the same email and there is nothing to corrupt. Re-running for a past
month is `--month YYYY-MM`.

## Guardrails

- Read-only on both stores. No write path exists in `lib/rental-ledger.js`.
- Never duplicates the weekly finance review's sections.
- Never sends bank or ledger content anywhere but the user's own email + phone.
- Never proposes a tax, pricing, purchase or sale action.
- Exits loudly (non-zero, no email) if the ledger is unreachable.

## Failure modes

- **Ledger unreachable** → CLI exits 1, no email. Silence is correct; the whole
  report is the ledger.
- **A month with no transactions** (a property bought mid-month, say) → the
  property's rows are zero and its comparisons read "new this month". Say so;
  do not treat it as a collapse in revenue.
- **Unclassified rows present** → the affected nets are provisional. Say the
  word "provisional" rather than quoting them flat.
