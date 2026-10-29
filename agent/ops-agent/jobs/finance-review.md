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
quiet week as "normal mid-month". So the tables and every flag are rendered
from the packet by
`finance-review-compose`, and your only text is a short summary that a
verifier checks word by word against the packet's facts. If it fails, the
email goes out without it. Questions the records cannot answer are listed at
the bottom of the email for the user — never answer one yourself.

**Design principle:** a
*weekly* review is for **liquidity, accuracy, and anomalies — NOT portfolio or
tax ACTIONS.** Net worth, allocation, and tax appear as **awareness-only**;
never prompt a rebalance, a trade, or a tax move here (those have their own
flows). Lead with what's actionable this week.

## Step 1 — Build the packet

```bash
cd ~/Dev/jori
node bin/finance-deposits-reconcile > /dev/null   # fresh deposit reconciliation (deterministic)
( set -a; . ./.env; set +a; node bin/finance-invoices-reconcile > /dev/null )   # invoice reconciliation, when configured (deterministic)
node bin/finance-review-data > /tmp/finance-review-packet.json
```

If it exits non-zero or the file is empty, stop silently. If
`meta.ledger_available` is false the property and deposit sections are absent;
the email says so itself — send it anyway.

## Step 2 — Write the summary (optional, verified)

Read `facts[]` in the packet (`id` + `text`; the `a…` ids are the attention
flags in priority order). Write **at most 3 sentences** about what matters most
this week, as JSON:

```json
{"sentences": [
  {"text": "<sentence>", "facts": ["a1"]},
  {"text": "<sentence>", "facts": ["a2", "deposits"]}
]}
```

Rules the verifier enforces — a sentence that breaks any of them drops the
WHOLE summary:

- Every sentence cites the fact id(s) it restates.
- Every number in it appears in a cited fact, written the same way.
- Every word in it appears in a cited fact, apart from connectives (and, also,
  this week, worth a look…). So: no "autopay" unless the fact says autopay, no
  "normal", "usually", "likely", "because", "should", no explanation of why.
  **Restate; do not interpret.**

Write it to `/tmp/finance-review-summary.json`. If nothing is worth
summarising, skip this step.

## Step 3 — Compose (render + verify + record)

```bash
node bin/finance-review-compose --packet /tmp/finance-review-packet.json \
  --summary /tmp/finance-review-summary.json --out /tmp/finance-review.html \
  > /tmp/finance-review-compose.json
cat /tmp/finance-review-compose.json
```

It prints `run_id`, `subject`, `pointer`, `summary_used` and `problems`. If
`summary_used` is false, do NOT retry with a reworded summary — send what was
rendered. (Problems are stored on the run for review.)

## Step 4 — Deliver (long-form delivery rule)

Per `agent/ops-agent/CLAUDE.md § Long-form delivery rule`:

**One command**: it sends the HTML
email, finds it in Gmail by exact subject (bounded wait), labels `personal` +
**star** + mark read (never `p1`, no re-notify), verifies it is still in the
INBOX, then sends the phone pointer and the APNs push. Do not hand-run
`email-send`, `gmail-action`, `jori-send-curl` or `jori-notify` here.

```bash
C=/tmp/finance-review-compose.json
~/Dev/jori/bin/digest-deliver \
  --subject "$(jq -r .subject "$C")" \
  --body-file /tmp/finance-review.html \
  --intent plaid-finance-review \
  --pointer "$(jq -r .pointer "$C")" \
  --push '<subject-line summary>'
RC=$?
[ $RC -ne 1 ] && node bin/finance-review-compose --mark-sent "$(jq -r .run_id "$C")"
```

- **Body:** the file exactly as rendered; never edit it.
- **Pointer: the `pointer` string from compose, verbatim** (it is built from the
  top flag, so it cannot say what the email does not). Read it straight out of
  the JSON as above — never retype it into a double-quoted argument. **A dollar
  amount in a double-quoted bash literal is a shell variable:** `"... $5,260 ..."`
  expands `$5` to nothing and sends *"...,260"*. A
  `$(jq …)` substitution's output is not re-expanded. Same for the push: single
  quotes, or a `$(cat <<'X' … X)` heredoc if it carries a figure.
- **The intent is what keeps bank rows out of `outbound-precheck`'s reasoning
  and its log file** (`agent/CLAUDE.md` § Financial Operations, rule 5) —
  the exemption is keyed on it, and `plaid-*` is on the allowlist.
- Exit 1 = the email did not send and nothing else ran: stop (see below), do not
  mark sent. Exit 2 = sent but unlabeled (pointer + push still went) — note it.

Do not email anyone but the user. Do not create tasks. The review is informational
+ awareness; any action stays the user's. If the send fails (exit 1), stop — never fall
back to an external channel for financial data.

## Recording facts (the user, or you when the user answers a question in chat)

Open questions come back as answers. Record each with `bin/finance-facts`
(usage in its header): `txn` (what a transaction was), `income add` (a stream
to expect), `payment add` (a confirmed scheduled payment — the only thing a
shortfall alarm fires on). Every write needs a note/evidence: quote what the user
said and the date. Deposits mostly are not recorded here: which tenants an
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
