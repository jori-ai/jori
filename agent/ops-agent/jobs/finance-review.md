# Finance Review — Weekly Money Review (all accounts)

> **This instance's additions** to this playbook are in `agent/local/jobs/finance-review.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (an ephemeral or by-hand run), `Read` that file before you start (absent = no additions).

Produces the user's **weekly financial review** across every connected account
(bank accounts and sub-accounts, credit cards, brokerage) — what is connected
is in the installation's account map and the instance's additions. It
highlights **anything of note**: where the cash actually is, liquidity risks,
missed/late rent, per-property and short-vs-long-term performance (when a
property ledger is connected), security deposits that are not where they
should be, fees & interest, card utilization, unusual charges, subscriptions
to act on, and an awareness-only net-worth/tax glance.

**Read-only and
money-movement-incapable** (bound by `agent/CLAUDE.md § Financial
Operations`). **Bank data is jori-model-only (health-data tier)** — reason
over it ONLY with your own model; never send transaction rows/balances/account
numbers to any third-party/external LLM or any outbound channel except the user's
own email + phone.

**The email is rendered by code, not written by you.** When a model wrote it,
almost every error was a guess stated as a fact — card payments as "late
income", a manual payment as "autopay", a future lease as "missing deposits", a
quiet week as "normal mid-month". So every table and flag is rendered from the
packet by `finance-review-compose`. Your work is everything before that: find
out, record, name things in the user's terms, check, ask, and only then send.

**Design principle:** a *weekly* review is for **liquidity, accuracy, and
anomalies — NOT portfolio or tax ACTIONS.** Net worth, allocation, and tax
appear as **awareness-only**; never prompt a rebalance, a trade, or a tax move
here (those have their own flows). Lead with what's actionable this week.

**The same flow as the daily summary (the user, 2026-11-08):** *"the finance
review should use the same flow as the daily summary. we want to run a checker
before actually sending anything - asking questions and answering them before
the send is important. everything in the review itself should be in terms i can
understand, not bank descriptions... also, many of the answers are already in
either claudette memory or the ledgers, so reviewing it intelligently before
sending is important."* So: a fresh session per run, the records and memory
consulted before anything is asked, an independent check before anything is
sent, and questions asked before the email, which waits for the answers.

## Pipeline — launch via job-run (the dispatching turn does only this)

**However this dispatch reaches you — `FINANCE REVIEW` from the Sunday cron, from
the answer sweep (`bin/finance-review-gate sweep`), or a manual re-dispatch —
the action is identical, unconditional, and the ONLY thing you do in this turn:**

```bash
~/Dev/jori/bin/job-run --name finance-review -- ~/Dev/jori/bin/finance-review-run
```

Then end your turn with a one-line ack ("finance review launched, id <id>").
Never decide it already ran: a re-dispatch exists because something changed
(the user answered, or asked for it again). `finance-review-run` forks a fresh
single-shot session that runs everything below; it holds a lock, so a second
launch while one is running exits at once. If the user asks whether it ran,
read `~/Dev/jori/bin/job-status <id>`.

## Step 0 — Build the packet

```bash
cd ~/Dev/jori
node bin/finance-deposits-reconcile > /dev/null   # fresh deposit reconciliation (deterministic)
( set -a; . ./.env; set +a; node bin/finance-invoices-reconcile > /dev/null )   # invoice reconciliation, when configured
node bin/finance-review-data > /tmp/finance-review-packet.json
WEEK=$(jq -r .meta.week_end /tmp/finance-review-packet.json)
```

If it exits non-zero or the file is empty, stop silently. If
`meta.ledger_available` is false the property and deposit sections are absent;
the email says so itself.

## Step 1 — Record the user's answers first

```bash
node bin/finance-review-ask --packet /tmp/finance-review-packet.json --earlier
```

It prints every question this review asked that the user has answered, with
their reply. Record each per § Recording facts (quote the reply and its date),
then close it with `finance-review-ask --answered <fin-id> --via "<what was
recorded>"`. Then rebuild (Step 0). On a run the answer sweep started, this is
the point of the run.

## Step 2 — Investigate and repair everything before reporting

The user (2026-11-08): *"before asking any questions in the finance report, we
should attempt to answer them autonomously ... and attempt to repair or
instruct the admin what to do. this doesn't just apply to questions but every
alert and discrepancy found."* Every attention item, every `questions[]` entry,
and **every name the email will show that is still a bank description** (a row
of "This week's money" breakdowns, a largest charge, a Next-14-days line) is
worked before anything is sent.

1. **Find out — memory and the records first.** Most answers are already
   known. Look in this order: the wiki / memory (`bin/wiki search "<name or
   number>"`: people pages say whose account ••2255 is, who Aki is, which
   contractor works at which property), the rental books (`lib/rental-ledger.js`:
   `billing-deposits` + `whereabouts`, `billing-payouts`, leases,
   `financial-transactions` categories and links), earlier answers
   (`finance-facts list txn`, `finance-names list`), the recurring tracker, the
   bank rows themselves (the full `name` of a row says more than the packet:
   a wire's `ORIG:` sender, a Zelle memo), Gmail (`gog gmail search`: a bank or
   transfer confirmation names the account at the other end), Stripe through the
   read-only key. Groups can run in parallel as subagents (deposits,
   transactions and names, cards/recurring): this same model, so bank data
   stays jori-model-only. Never send rows to any other model or service.
2. **Repair what is safe and certain**, from a record that says it:
   - a payee or payer in bank words → `bin/finance-names payee "<text in the
     bank line>" "<plain name>" --why "<the record>"` (a one-off:
     `finance-facts txn <id> --kind … --note "<plain name>"`, ≤ 60 characters);
   - an account Plaid does not see → `bin/finance-names account <last4> "<whose>" --why …`;
   - a transfer that went to an account of the user's own (it was counted as a
     payment) → `bin/finance-names own "<text>" --why …`;
   - what a transaction was → `finance-facts txn …`; re-run a stale sync or
     reconcile.
   Two plausible readings is not a fact: leave it for the user (Step 4).
   **Never** move money, pay, refund, change a lease, write to the hub, or
   email anyone but the user.
3. **Otherwise, the one concrete action** for the attention item: the amount,
   from which account to which, the page in the hub. Not "look into it".

Rebuild (Step 0) so repaired items drop out, and write
`/tmp/finance-review-resolve.json` against the REBUILT packet's ids:

```json
{"attention": {"a3": {"checked": "bank rows on ••2222 and ••1111 since the deposit arrived; the hub's trail for it", "fixed": "", "action": "Move $1,600.00 from 40 Birch ••2222 to Security Deposits ••1111."}},
 "questions": {"txn:abc…": {"tried": "hub payouts, Stripe, Gmail, the wiki: none name it", "todo": "Reply with what it was."}}}
```

`checked` names sources, not conclusions; `fixed` names what was recorded;
`action` is the instruction. When the investigation settled an item and
nothing is left for the user, write `"resolved": true` with `fixed` and **no
action** (never "nothing to do"): it leaves the email (kept on the run as
`resolved_attention`). A flag marked `optional` (a subscription renewal:
"cancel if you don't want it") keeps the packet's action; do not write one.

## Step 3 — Compose, then check before anything is sent (max 3 rounds)

```bash
node bin/finance-review-compose --packet /tmp/finance-review-packet.json \
  --resolve /tmp/finance-review-resolve.json --out /tmp/finance-review.html > /tmp/finance-review-compose.json
# Bash tool timeout 600000: the independent read runs on Opus.
node bin/finance-review-check --packet /tmp/finance-review-packet.json --html /tmp/finance-review.html \
  --out /tmp/finance-review-check.json
```

`confirmed` is true when no high or medium finding remains and the
independent read ran. Code checks: bank wording shown as a name, breakdowns
that do not add up, a deposit whose whereabouts are unknown, an "act on" item
with no action, the same action twice, an email Gmail would clip. The
independent read (Opus, on the Max session, no tools) reads the email as the
user will and names what is unclear, inconsistent, repeated, noise, or
answerable from the records.

For each finding: fix it the Step 2 way (a name, a fact, an action), rebuild
(Step 0), compose and check again — up to 3 rounds. What only the user can
settle becomes a question (Step 4). A code defect (`does-not-add-up`,
`too-long`) cannot be fixed here: put it in your final output so it reaches
`--channel improvements`, and send. The independent read `unavailable` twice:
send on the code checks, and say so in your final output.

## Step 4 — Ask before sending; the email waits for the answers

```bash
node bin/finance-review-ask --packet /tmp/finance-review-packet.json --notes /tmp/finance-review-resolve.json
node bin/finance-review-gate hold --week "$WEEK"      # only when the ask above sent a question
node bin/finance-review-gate check --week "$WEEK"     # exit 0 = send now (Step 5), exit 3 = hold
```

Ask only what Steps 1–3 could not settle, one concrete question each, offering
the likeliest answer. The questions go to the Questions tab (no push, intent
`plaid-finance-review:question`); one still open and asked in the last 6 days
is not asked again; one the user already answered is never asked again.

- **Exit 3 (hold):** stop without sending. Final output: "held for the user's
  answers until <hold_until>". `finance-review-gate sweep` (every 30 min)
  starts a fresh run as soon as every question is answered, or when the window
  closes (3 hours; asked before 8am, not before 11am).
- **Exit 0:** Step 5. A question still open when the window closed stays in the
  Questions tab; the email counts it.

## Step 5 — Deliver (long-form delivery rule)

Per `agent/ops-agent/CLAUDE.md § Long-form delivery rule` — **one command**: it
sends the HTML email, labels it `personal` + **star** + read, verifies it is in
the INBOX, then sends the phone pointer and the push.

```bash
C=/tmp/finance-review-compose.json
~/Dev/jori/bin/digest-deliver \
  --subject "$(jq -r .subject "$C")" \
  --body-file /tmp/finance-review.html \
  --intent plaid-finance-review \
  --pointer "$(jq -r .pointer "$C")" \
  --push 'Weekly finance review is ready'
RC=$?
[ $RC -ne 1 ] && node bin/finance-review-compose --mark-sent "$(jq -r .run_id "$C")" && node bin/finance-review-gate sent --week "$WEEK"
```

- **Body:** the file exactly as rendered; never edit it.
- **Pointer: the `pointer` string from compose, verbatim**, read straight out
  of the JSON as above. **A dollar amount in a double-quoted bash literal is a
  shell variable** (`"$5,260"` sends ",260"); single quotes or `$(jq …)`.
- **The intent keeps bank rows out of `outbound-precheck`'s reasoning and log**
  (`agent/CLAUDE.md` § Financial Operations, rule 5).
- Exit 1 = the email did not send: stop, do not mark sent. Exit 2 = sent but
  unlabeled — note it.

**Copies.** When the installation lists people the owner asked to share the
review with (`share_with` in `agent/local/config/finance-review.json`; the
owner's explicit authorization, the only exception to "the owner's own email
and phone"), send them the same email as the agent, after the owner's copy went
out (RC is not 1) — the email only, never the pointer, push or questions:

```bash
SHARE=$(jq -r '.share_with // [] | join(",")' agent/local/config/finance-review.json 2>/dev/null)
[ $RC -ne 1 ] && [ -n "$SHARE" ] && ~/Dev/jori/bin/email-send --to "$SHARE" \
  --subject "$(jq -r .subject "$C")" --body-file /tmp/finance-review.html --html
```

Do not email anyone but the user. Do not create tasks. If the send fails,
never fall back to an external channel for financial data.

## Recording facts (the user, or you when the user answers a question in chat or the Questions tab)

**Names.** When the answer is a name — whose account ••1815 is, what a payee
is — record it with `bin/finance-names` (account / payee / own; usage in its
header), not as a one-off note, so every later review shows it.

A Questions-tab row from this review ends with `(finance review · fin-…)`.
When the user replies to one: `finance-review-ask --list` names the packet
question (`txn:…`, `account:…`, `payment:…`) and `finance-facts questions`
gives the command that records it. Record it as below, then close it with
`finance-review-ask --answered <fin-id> --via "<what was recorded>"`. A
question answered in the hub (an account, a deposit row) is closed the same
way once the user says it is done; the next review retires it anyway when its
records stop asking. Record **before** closing, never instead: a closed
question the packet still raises is not asked again, so the review has to
re-read the answer from the reply (Step 1b).

Open questions come back as answers. Record each with `bin/finance-facts`
(usage in its header): `txn` (what a transaction was), `income add` (a stream
to expect), `payment add` (a confirmed scheduled payment — the only thing a
shortfall alarm fires on), `payment manual` (a payee the user pays by hand: the
answer when "is this a scheduled card payment?" is no), `account <mask>` (an
account that belongs to no property or pot on purpose: the answer when "which
property or pot?" is none; one that belongs somewhere is added in the hub's
account registry). Every write needs a note/evidence: quote what the user
said and the date. **Never register an income stream for rent or a deposit the
rental hub collects:** the review reads those payouts from the books, so a stream
would only say it twice, `income add` refuses one, and rent a tenant has not paid
shows on the hub's rent invoices. Deposits mostly are not recorded here: which tenants an
unlinked bank row was, where a deposit started, and whether one may sit outside
the deposit account are answered in the hub (Financials -> Security deposits;
the tenant's card). Point the user there; then re-run `finance-deposits-reconcile`.
The one exception is a transfer the review asked about because it fits two sets
of tenants, or one the user says the hub has linked to the wrong tenants: record
the answer with `finance-facts deposit-answer <row id> --whose "<tenant>, <tenant>"
[--unknown "<tenant>"] --said "<their words>"` (the question carries the row id;
the answer goes to the gitignored `data/finance-deposit-answers.jsonl`),
then re-run `finance-deposits-reconcile`. Whoever else the hub credits that row
to becomes unknown on its own; `--unknown` adds anyone further whose deposit's
whereabouts the user says are not known. Unknown deposits are never flagged or located.
