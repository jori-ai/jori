// watchdog-probe.test.mjs — pins the Cloudflare-Tunnel reachability probe gate
// in agent/scripts/watchdog.sh. Per feedback_alerts_self_heal_first.md,
// monitors must exhaust a concrete liveness probe before paging the user. The
// Gmail-push ingress moved from a Hookdeck CLI relay to a Cloudflare Tunnel
// (gmail-push.<domain> → localhost:9090) on 2026-05-30; this test guards the
// replacement probe (cloudflared_tunnel_probe) the same way the old one guarded
// hookdeck_local_probe.
//
// These assertions intentionally key off string-level structure (function
// defined, called as an alert gate, curls the public tunnel hostname) so drift
// is caught without standing up a mock bash harness.
//
// Run: node --test tests/watchdog-probe.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// WATCHDOG_SH runs the suite against a proposed copy, e.g.
//   WATCHDOG_SH=/tmp/sic-x/watchdog.sh node --test tests/watchdog-probe.test.mjs
const WATCHDOG_PATH =
  process.env.WATCHDOG_SH ||
  path.join(REPO_ROOT, "agent/scripts/watchdog.sh");

const SRC = fs.readFileSync(WATCHDOG_PATH, "utf8");

test("cloudflared_tunnel_probe function is defined", () => {
  const defRe = /^\s*(?:function\s+)?cloudflared_tunnel_probe\s*\(\s*\)\s*\{/m;
  assert.match(
    SRC,
    defRe,
    "expected a top-level `cloudflared_tunnel_probe()` function definition in watchdog.sh",
  );
});

test("cloudflared_tunnel_probe is called as an alert gate", () => {
  // The probe must be invoked somewhere OTHER than its own definition, and the
  // `notify "...Cloudflare Tunnel..."` page must be guarded so it only fires
  // when the probe (and self-heal) have failed.
  const callerMatches = SRC.match(/cloudflared_tunnel_probe/g) || [];
  assert.ok(
    callerMatches.length >= 2,
    `expected at least 2 references to cloudflared_tunnel_probe (1 def + 1+ caller), got ${callerMatches.length}`,
  );

  // The disconnect page must live INSIDE that failure branch. Asserted by
  // slicing the block to its own column-0 `else` rather than by a fixed
  // character window: the 2026-09-25 fix nested a host-network control gate in
  // between, and a distance-based regex would have failed on a change that made
  // the gate STRONGER. Containment is the property that matters — mere index
  // ordering would still pass if a refactor hoisted the page out of the branch.
  const probeIdx = SRC.indexOf("if ! cloudflared_tunnel_probe");
  assert.ok(probeIdx !== -1, "could not locate the `if ! cloudflared_tunnel_probe` branch");
  const elseIdx = SRC.indexOf("\nelse\n", probeIdx);
  assert.ok(elseIdx !== -1, "could not locate the tunnel branch's own column-0 `else`");
  const branch = SRC.slice(probeIdx, elseIdx);
  assert.ok(
    branch.includes('notify "🔴 Cloudflare Tunnel'),
    "the Cloudflare Tunnel page must live inside the `if ! cloudflared_tunnel_probe` failure branch",
  );
});

test("probe curls the public tunnel hostname over https", () => {
  const fnBodyRe = /cloudflared_tunnel_probe\s*\(\s*\)\s*\{([\s\S]*?)^\}/m;
  const match = SRC.match(fnBodyRe);
  assert.ok(match, "could not locate cloudflared_tunnel_probe function body");
  const body = match[1];

  assert.match(body, /curl\b/, "probe function body must call curl");
  assert.match(
    body,
    /https:\/\/\$\{CLOUDFLARED_HOST\}\//,
    "probe must target https://${CLOUDFLARED_HOST}/ (the public tunnel endpoint)",
  );
  assert.match(
    body,
    /X-Jori-Probe:\s*watchdog/,
    "probe must set `X-Jori-Probe: watchdog` header for log correlation",
  );
});

test("CLOUDFLARED_HOST resolves to the gmail-push tunnel hostname", () => {
  // gmail-push.<instance domain> (JORI_PUSH_HOST overrides); the effective
  // values are checked in watchdog-instance(.local).test.mjs.
  assert.match(
    SRC,
    /CLOUDFLARED_HOST="\$\{JORI_PUSH_HOST:-\$\{JORI_DOMAIN:\+gmail-push\.\$JORI_DOMAIN\}\}"/,
    "expected CLOUDFLARED_HOST to be gmail-push.<instance domain>",
  );
});

test("no lingering Hookdeck references remain in watchdog.sh", () => {
  assert.doesNotMatch(
    SRC,
    /hookdeck|hkdk\.events/i,
    "watchdog.sh should no longer reference Hookdeck after the Cloudflare Tunnel migration",
  );
});

// --- GitHub CLI auth probe (sandbox/network-aware gate, added 2026-06-03) ---
// A bare `gh api user` failure is ambiguous: it fires identically when the token
// is revoked AND when GitHub is merely unreachable (sandbox-masked network,
// partition, GitHub down). The `github_api_reachable` probe gates the auth
// verdict so a connectivity blip can't masquerade as "gh CLI auth is broken".

test("github_api_reachable function is defined", () => {
  const defRe = /^\s*(?:function\s+)?github_api_reachable\s*\(\s*\)\s*\{/m;
  assert.match(
    SRC,
    defRe,
    "expected a top-level `github_api_reachable()` function definition in watchdog.sh",
  );
});

test("github_api_reachable probes the unauthenticated api.github.com root", () => {
  const fnBodyRe = /github_api_reachable\s*\(\s*\)\s*\{([\s\S]*?)^\}/m;
  const match = SRC.match(fnBodyRe);
  assert.ok(match, "could not locate github_api_reachable function body");
  const body = match[1];

  assert.match(body, /curl\b/, "probe function body must call curl");
  assert.match(
    body,
    /https:\/\/api\.github\.com\//,
    "probe must target https://api.github.com/ (the unauthenticated root, answers without a token)",
  );
  assert.match(
    body,
    /X-Jori-Probe:\s*watchdog/,
    "probe must set `X-Jori-Probe: watchdog` header for log correlation",
  );
});

test("gh-auth alert is gated behind the reachability probe", () => {
  // The `notify "...gh CLI auth is broken..."` page must only be reachable when
  // GitHub answered the probe — i.e. it lives in the `else` branch of
  // `if ! github_api_reachable; then ... else ... notify`. The unreachable
  // branch must NOT page (it logs a connectivity skip instead).
  const callerMatches = SRC.match(/github_api_reachable/g) || [];
  assert.ok(
    callerMatches.length >= 2,
    `expected at least 2 references to github_api_reachable (1 def + 1+ caller), got ${callerMatches.length}`,
  );

  // The unreachable branch records gh-auth(unreachable) and must not notify.
  const gateRe =
    /if\s+!\s+github_api_reachable\s*;\s*then[\s\S]{0,600}?gh-auth\(unreachable\)/;
  assert.match(
    SRC,
    gateRe,
    "expected `if ! github_api_reachable; then ... gh-auth(unreachable)` connectivity-skip branch",
  );

  // The auth page must come AFTER the reachability gate, not before it — i.e.
  // the probe is defined/called upstream of the gh-auth notify.
  // The page's wording changed on 2026-08-18 (it no longer flatly asserts the
  // token "is broken", because all three firings that motivated the guard were
  // false), so key off the notify call itself rather than the old sentence.
  const probeIdx = SRC.indexOf("if ! github_api_reachable");
  const notifyIdx = SRC.lastIndexOf('notify "⚠️ gh CLI auth');
  assert.ok(
    probeIdx !== -1 && notifyIdx !== -1 && probeIdx < notifyIdx,
    "the gh-auth page must be gated by (come after) the github_api_reachable check",
  );
});

// --- Nightly-review cron-miss detector (si-20260728-01, added 2026-07-28) ---
// Sibling of the daily-summary / episode-archive cron-miss detectors: the
// nightly-review (weekly Self Improvement Review) job silently no-op'd on
// 2026-07-14 and 2026-07-21 with nothing watching for it. This block checks
// the actual artifact (`last_run` in nightly-review-state.json) and follows
// the same heal-then-alert shape as its siblings, but with a DAY-granularity
// staleness threshold (weekly cadence) instead of an hour-of-day gate, and a
// longer heal grace window (nightly-review is an unbounded long-running
// analysis turn, not a quick backfill).

test("nightly-review detector reads last_run from nightly-review-state.json", () => {
  assert.match(
    SRC,
    /NR_STATE_FILE="\$HOME\/Dev\/jori\/data\/nightly-review-state\.json"/,
    "expected NR_STATE_FILE to point at data/nightly-review-state.json",
  );
  assert.match(
    SRC,
    /jq -r '\.last_run \/\/ empty' "\$NR_STATE_FILE"/,
    "expected the detector to read the `last_run` field via jq",
  );
});

test("nightly-review staleness is measured in days, gated at >= 8", () => {
  assert.match(
    SRC,
    /NR_AGE_DAYS=\$\(\( \(NR_TODAY_EPOCH - NR_LAST_EPOCH\) \/ 86400 \)\)/,
    "expected NR_AGE_DAYS to be computed as a whole-day difference",
  );
  assert.match(
    SRC,
    /if \[ "\$NR_AGE_DAYS" -ge 8 \]; then/,
    "expected the missing-run branch to gate on NR_AGE_DAYS >= 8 (weekly cadence + ~1 day grace)",
  );
});

test("nightly-review-missing incident uses the standard incident_seen/incident_clear/incident_should_alert trio", () => {
  assert.match(
    SRC,
    /incident_seen "nightly-review-missing"/,
    "expected incident_seen to be called for the nightly-review-missing key",
  );
  assert.match(
    SRC,
    /incident_clear "nightly-review-missing"/,
    "expected incident_clear to be called once the run is fresh again",
  );
  assert.match(
    SRC,
    /incident_should_alert "nightly-review-missing" 86400 2 86400/,
    "expected incident_should_alert to be called with the same (cooldown, max_alerts, window) shape as the daily-summary/episode-archive siblings",
  );
});

test("nightly-review self-heal kickstarts the launchd agent, at most once per 24h", () => {
  const healBlockRe =
    /NR_HEAL_MARKER[\s\S]{0,2000}?SHOULD_HEAL=1[\s\S]{0,600}?\[ "\$HEAL_AGE" -lt 86400 \] && SHOULD_HEAL=0/;
  assert.match(
    SRC,
    healBlockRe,
    "expected a 24h self-heal cooldown gate keyed on NR_HEAL_MARKER",
  );
  // 2026-07-28: the heal used to POST {"job":"nightly-review"} to the :9092
  // webhook. That is now wrong twice over — the review runs as an ephemeral
  // Opus 5 job (the supervisor behind :9092 is Sonnet, so a webhook heal would
  // silently heal onto the wrong model AND skip the improvement-plan chain), and
  // watchdog.sh runs from cron, where a `claude -p` cannot reach the keychain
  // holding the Max credentials. launchctl hands it to launchd, which runs
  // in-session. Both properties are asserted here because losing either one
  // brings back a failure that was silent the first time.
  assert.match(
    SRC,
    /launchctl kickstart -k "gui\/\$\(id -u\)\/ai\.claude\.improvement-review"/,
    "expected the heal to kickstart the launchd agent in the GUI domain — the only path from cron to an in-session, Max-authenticated run",
  );
  assert.doesNotMatch(
    SRC,
    /-d "\{\\"job\\":\\"nightly-review\\"/,
    "the :9092 webhook heal must be gone — it would run the weekly review on Sonnet and skip the improvement-plan chain",
  );
});

test("nightly-review page is gated behind a 3h heal grace, not an immediate page", () => {
  assert.match(
    SRC,
    /if \[ "\$HEAL_AGE" -ge 10800 \] && incident_should_alert "nightly-review-missing"/,
    "expected the notify() page to require >= 3h (10800s) since the self-heal dispatch before firing — longer than the 20-min grace used by daily-summary/episode-archive because nightly-review is a long unbounded analysis turn",
  );
  assert.match(
    SRC,
    /notify "🔴 Nightly-review \(weekly Self Improvement Review\) hasn't updated last_run/,
    "expected a 🔴 page describing the stale nightly-review last_run",
  );
});

test("_incident_label covers nightly-review-missing", () => {
  assert.match(
    SRC,
    /nightly-review-missing\)\s*echo "weekly self-improvement review"/,
    "expected a human-readable label for nightly-review-missing so recovery pings read naturally",
  );
});

// --- daily-summary orphan-row detector (si-20260728-02, added 2026-07-28) ---
// The episode-archive-missing block above only proves the wiki page is
// missing — it can't say whether that's because daily-summary never produced
// a row (nothing to archive) or because a row WAS published and
// episode-archive itself is failing to render it. 2026-07-27 shipped as the
// first case wearing the second case's symptom (a settle/prose/publish race
// left the row unwritten), which is exactly why the two need to stay
// distinguishable. This block queries the row directly and tags the alert
// with which case actually happened.

test("orphan-row detector queries the daily_summaries row directly for date + narrative", () => {
  assert.match(
    SRC,
    /DS_ROW_FOR_EA=\$\(curl[\s\S]{0,300}?daily_summaries\?date=eq\.\$\{EA_TARGET\}&select=date,narrative&limit=1/,
    "expected a direct REST query for the daily_summaries row (date + narrative) keyed on EA_TARGET",
  );
});

test("orphan-row detector distinguishes a PUBLISHED row (non-null narrative) from no row at all", () => {
  assert.match(
    SRC,
    /grep -q '"narrative":"'/,
    'expected the check to match a non-null narrative string (`"narrative":"..."`), not just row presence — a row with narrative:null or no row at all must NOT count as orphaned',
  );
});

test("orphan-row incident uses its own key, distinct from episode-archive-missing", () => {
  assert.match(
    SRC,
    /incident_should_alert "daily-summary-orphan-row" 86400 2 86400/,
    "expected incident_should_alert for daily-summary-orphan-row with the same (cooldown, max_alerts, window) shape as its siblings",
  );
  assert.match(
    SRC,
    /incident_clear "daily-summary-orphan-row"/,
    "expected incident_clear for daily-summary-orphan-row somewhere (both when the page finally exists AND when the row check comes back negative)",
  );
});

test("orphan-row alert text explicitly rules out a missing build", () => {
  assert.match(
    SRC,
    /notify "🔴 daily_summaries has a published row for \$EA_TARGET but day_\$\{EA_TARGET\} is still missing from the wiki — this is NOT a missing build/,
    "expected the orphan-row page to explicitly say this is NOT a missing-build case, so it reads differently from the daily-summary-missing / generic episode-archive-missing pages",
  );
});

test("orphan-row detector clears its incident when the wiki page exists (page-exists branch)", () => {
  // incident_clear calls in the "page exists" branch: episode-archive-missing,
  // episode-archive-escalation, AND daily-summary-orphan-row must all be
  // cleared together — a stale orphan-row incident must not survive the page
  // actually landing.
  const pageExistsBranchRe =
    /if "\$HOME\/Dev\/jori\/bin\/wiki" read "day_\$\{EA_TARGET\}" > \/dev\/null 2>&1; then\s*\n\s*incident_clear "episode-archive-missing"\s*\n\s*incident_clear "episode-archive-escalation"\s*\n\s*incident_clear "daily-summary-orphan-row"/;
  assert.match(
    SRC,
    pageExistsBranchRe,
    "expected daily-summary-orphan-row to be cleared alongside episode-archive-missing/-escalation in the page-exists branch",
  );
});

test("orphan-row check does not add a second self-heal (reuses the single wiki-day-write backfill)", () => {
  // The orphan-row block is diagnostic (query + distinct alert) layered on top
  // of the existing self-heal, never a second one. Since 2026-08-01 (46229261)
  // that self-heal runs wiki-day-write directly instead of dispatching an
  // "EPISODE ARCHIVE" agent task, so: exactly one direct run, zero dispatches.
  // (The writer is the installation's, run only when present: EA_DAY_WRITER.)
  assert.match(SRC, /EA_DAY_WRITER="\$HOME\/Dev\/jori\/bin\/wiki-day-write"/);
  const heals = SRC.match(/EA_HEAL_OUT=\$\(timeout 60 node "\$EA_DAY_WRITER"/g) || [];
  assert.equal(heals.length, 1, `expected exactly 1 wiki-day-write self-heal in watchdog.sh, found ${heals.length}`);
  const dispatches = SRC.match(/\\"task\\":\\"EPISODE ARCHIVE/g) || [];
  assert.equal(dispatches.length, 0, "the episode-archive self-heal must not dispatch an agent turn");
});

test("_incident_label covers daily-summary-orphan-row", () => {
  assert.match(
    SRC,
    /daily-summary-orphan-row\) echo "daily-summary row published without a wiki page"/,
    "expected a human-readable label for daily-summary-orphan-row so recovery pings read naturally",
  );
});

test("watchdog.sh is valid bash", () => {
  assert.doesNotThrow(() => {
    execSync(`bash -n ${JSON.stringify(WATCHDOG_PATH)}`, {
      stdio: ["ignore", "ignore", "pipe"],
    });
  }, "watchdog.sh must pass `bash -n` syntax check");
});

// --- Gmail unread sweep: phantom RECLASSIFY rounds -------------------------
// sic-20260813-triage-sweep-phantom-rounds. On 2026-08-13 15:12 the ops
// webhook (:9092) was http-down. The sweep's `curl -sf ... > /dev/null 2>&1`
// discarded the exit status, logged "Dispatched RECLASSIFY" for two POSTs that
// timed out, and 2 min later paged "🔴 ... after 2 RECLASSIFY rounds. Manual
// triage needed" — blaming the triage agent for a dispatch-path outage and
// asking for a manual fix that was never needed (the queue self-drained at
// 15:20). These pin the two halves of the fix: notice the failure, and never
// cite an undelivered round as evidence about the agent.

test("RECLASSIFY dispatch checks whether the POST actually landed", () => {
  assert.match(
    SRC,
    /if curl -sf --max-time 5 -X POST "http:\/\/localhost:9092"/,
    "the stuck-email RECLASSIFY dispatch must branch on curl's exit status, not discard it",
  );
  assert.match(
    SRC,
    /RECLASSIFY dispatch FAILED for \$MSGID/,
    "a failed RECLASSIFY dispatch must log distinctly from a delivered one",
  );
});

test("stuck-inbox alerts cite delivered rounds, never ticks-seen", () => {
  const notifies = (SRC.match(/notify "🔴[^"]*RECLASSIFY round[^"]*"/g) || []);
  assert.ok(
    notifies.length >= 2,
    `expected the stuck-inbox alert branches to survive, found ${notifies.length}`,
  );
  for (const n of notifies) {
    assert.ok(
      !n.includes("$ATTEMPT"),
      `stuck-inbox alert must not cite $ATTEMPT (ticks seen) as RECLASSIFY rounds: ${n}`,
    );
    assert.ok(
      n.includes("$LANDED_ROUNDS"),
      `stuck-inbox alert must cite $LANDED_ROUNDS (rounds actually delivered): ${n}`,
    );
  }
});

test("a stuck inbox with undelivered dispatches gets its own alert branch", () => {
  assert.match(
    SRC,
    /elif \[ "\$DISPATCH_FAIL" -gt 0 \] \|\| \[ "\$LANDED_ROUNDS" -lt 2 \]; then/,
    "an undelivered self-heal must page about the dispatch path, not 'Manual triage needed'",
  );
});

test("landed-rounds counter is reset when the incident clears", () => {
  assert.match(
    SRC,
    /rm -f "\$INCIDENT_DIR\/gmail-unread-stuck\.landed_rounds"/,
    "incident_clear does not know about the landed_rounds file; the sweep must reset it itself",
  );
});

// ── gog auth probe (sic-20260814-gog-auth-single-tick-page) ──────────────────
// 2026-08-14 21:32Z the gog block paged "🔴 gog (Google) auth is DOWN … the
// login keychain locked" off ONE failing sample. The real error, in watchdog's
// own log line, was `oauth2: "internal_failure"` — a transient Google token
// endpoint blip — and the next 2-min tick was already green. A 🔴 dispatches a
// same-day Opus escalation run, so a one-tick blip is expensive as well as
// wrong. These tests pin the three properties that make that impossible:
// persistence before paging, the observed error in the page, and recovery
// parity through incident_clear.

test("gog-auth pages only after GOG_MIN_TICKS consecutive failing ticks", () => {
  assert.match(
    SRC,
    /GOG_MIN_TICKS=\d+/,
    "expected a GOG_MIN_TICKS persistence threshold for the gog auth probe",
  );
  assert.match(
    SRC,
    /\[ "\$GOG_ATTEMPT" -ge "\$GOG_MIN_TICKS" \] && incident_should_alert "gog-auth"/,
    'the gog page must be gated on BOTH the consecutive-tick count and incident_should_alert — a single failing probe must never reach notify',
  );
  const minTicks = Number((SRC.match(/GOG_MIN_TICKS=(\d+)/) || [])[1]);
  assert.ok(
    minTicks >= 2,
    `GOG_MIN_TICKS must be >= 2 so one transient oauth2 blip cannot page (got ${minTicks})`,
  );
});

test("gog-auth uses the standard incident_seen/incident_clear trio", () => {
  assert.match(
    SRC,
    /GOG_ATTEMPT=\$\(incident_seen "gog-auth"\)/,
    "the gog probe must count consecutive failures through incident_seen, not a hand-rolled cooldown file",
  );
  assert.match(
    SRC,
    /incident_clear "gog-auth"/,
    'a healthy gog probe must incident_clear so a self-healed outage sends "✅ Recovered" — the failure page had no recovery parity before 2026-08-14',
  );
  assert.doesNotMatch(
    SRC,
    /GOG_ALERT_COOLDOWN/,
    "the hand-rolled .gog-auth-last-alert cooldown is replaced by incident_should_alert; it bypassed both persistence and recovery parity",
  );
});

test("gog-auth page reports the error observed, not a hardcoded cause", () => {
  // The old page asserted "the login keychain locked" on every firing,
  // regardless of what the probe returned.
  const notifyLine =
    (SRC.match(/notify "🔴 gog \(Google\) auth is DOWN[^\n]*/) || [])[0] || "";
  assert.ok(notifyLine, "expected the gog-auth notify line to still exist");
  assert.ok(
    notifyLine.includes("$GOG_HINT") && notifyLine.includes("$GOG_OUT"),
    "the gog page must interpolate the derived hint AND the observed error text",
  );
  assert.ok(
    !/Most common cause on the Mini: the login keychain locked/.test(SRC),
    "the unconditional keychain-locked assertion must not come back — it was wrong on the firing that motivated this guard",
  );
  // The hint is derived from the probe output, with a branch for the case that
  // is neither a keychain lock nor a revoked token.
  assert.match(
    SRC,
    /GOG_HINT="This is not a locked keychain or a revoked token/,
    "expected an explicit branch for an upstream/token-endpoint failure",
  );
});

test("_incident_label covers gog-auth", () => {
  assert.match(
    SRC,
    /gog-auth\)\s+echo "gog \(Google Tasks\/Calendar\/Drive\) auth"/,
    'without a label the recovery ping would read "✅ Recovered: gog-auth is back to normal"',
  );
});

// ── gh-auth probe: persistence + recovery parity (2026-08-18)
// Cluster sic-20260730-gh-cli-auth-broken. This probe was the SECOND block in
// this file to page off a single failing sample via a hand-rolled 24h cooldown
// file, skipping the house incident trio (the gog probe was the first, fixed
// 2026-08-14). It cried wolf on 2026-07-16, 07-19 and 08-17: neither
// ~/.config/gh/hosts.yml nor secrets/gh-token had been rewritten since
// April, so no re-login ever happened, yet both tokens still authenticate — a
// revoked OAuth token cannot un-revoke itself.

test("gh-auth probe persists across ticks before paging", () => {
  assert.match(
    SRC,
    /GH_MIN_TICKS=\d+/,
    "expected a GH_MIN_TICKS threshold so a single transient `gh api user` failure cannot page",
  );
  assert.match(
    SRC,
    /GH_ATTEMPT=\$\(incident_seen "gh-auth"\)/,
    "the gh probe must count consecutive failures through incident_seen, not a hand-rolled cooldown file",
  );
  assert.match(
    SRC,
    /\[ "\$GH_ATTEMPT" -ge "\$GH_MIN_TICKS" \] && incident_should_alert "gh-auth"/,
    "the gh-auth page must be gated on BOTH the persistence count and the shared cooldown",
  );
  assert.doesNotMatch(
    SRC,
    /GH_ALERT_COOLDOWN/,
    "the hand-rolled .gh-auth-last-alert cooldown is replaced by incident_should_alert; it bypassed both persistence and recovery parity",
  );
});

test("gh-auth recovery clears through the shared machinery", () => {
  assert.match(
    SRC,
    /incident_clear "gh-auth"/,
    'a healthy gh probe must incident_clear so a self-healed outage sends "✅ Recovered" — three false pages self-resolved silently before 2026-08-18',
  );
  assert.match(
    SRC,
    /gh-auth\)\s+echo "gh \(GitHub CLI\) auth"/,
    'without a label the recovery ping would read "✅ Recovered: gh-auth is back to normal"',
  );
});

test("gh-auth page reports the error observed, not an asserted revocation", () => {
  const notifyLine =
    (SRC.match(/notify "⚠️ gh CLI auth[^\n]*/) || [])[0] || "";
  assert.ok(notifyLine, "expected the gh-auth notify line to still exist");
  assert.ok(
    notifyLine.includes("$GH_HINT") && notifyLine.includes("$GH_OUT"),
    "the gh page must interpolate the derived hint AND the observed error text",
  );
  assert.ok(
    !/notify "⚠️ gh CLI auth is broken\. Run:/.test(SRC),
    "the flat 'auth is broken' assertion must not come back — it was wrong on all three firings that motivated this guard",
  );
  assert.match(
    SRC,
    /GH_HINT="This is not a rejected token or a rate limit/,
    "expected an explicit branch for an upstream/API failure that is neither a bad token nor a rate limit",
  );
});

test("gh-auth unreachable branch neither counts nor clears", () => {
  // An unreachable network is not evidence the token is bad (must not advance
  // GH_MIN_TICKS) and not evidence it is good (must not clear a live incident).
  const unreachableBranch =
    (SRC.match(
      /if ! github_api_reachable; then[\s\S]*?else\s*\n\s*# GitHub answered/,
    ) || [])[0] || "";
  assert.ok(
    unreachableBranch,
    "expected the `if ! github_api_reachable` branch to still exist in the gh block",
  );
  assert.ok(
    !/incident_seen "gh-auth"|incident_clear "gh-auth"/.test(unreachableBranch),
    "the unreachable branch must not touch the gh-auth incident counter in either direction",
  );
});

// --- Host-network control probe (sic-20260925-host-offline-fanout) ---
// 2026-09-25 17:08-17:15 ET, one host-network partition produced four separate
// 🔴 capability-down pages inside seven minutes (tunnel, Supabase, gog token,
// heartbeat), because curl returns 000 identically for "the vendor is down" and
// "this host has no network". The tunnel page told the user to launchctl-kickstart
// a healthy daemon; nothing was wrong and it cleared on its own by 17:16 with no
// operator action. These assertions pin the control gate that stops the tunnel
// half of that fan-out, mirroring the github_api_reachable gate above.

test("host_network_reachable function is defined", () => {
  assert.match(
    SRC,
    /^\s*(?:function\s+)?host_network_reachable\s*\(\s*\)\s*\{/m,
    "expected a top-level `host_network_reachable()` function definition in watchdog.sh",
  );
});

test("host_network_reachable uses two independent, non-Cloudflare controls", () => {
  const match = SRC.match(/host_network_reachable\s*\(\s*\)\s*\{([\s\S]*?)^\}/m);
  assert.ok(match, "could not locate host_network_reachable function body");
  const body = match[1];

  const urls = body.match(/https:\/\/[^"\s]+/g) || [];
  assert.ok(
    urls.length >= 2,
    `control probe needs >= 2 independent vendors so one vendor's outage cannot mute ours, got ${urls.length}`,
  );

  // The tunnel being controlled for resolves through Cloudflare. A
  // Cloudflare-fronted control would fail alongside it and mask the one
  // incident the page is exactly right about.
  assert.doesNotMatch(
    body,
    /one\.one\.one\.one|1\.1\.1\.1|cloudflare\.com/i,
    "control vendors must not be Cloudflare-fronted (they would fail with the tunnel they control for)",
  );
});

test("tunnel page and self-heal are both gated behind host_network_reachable", () => {
  const refs = SRC.match(/host_network_reachable/g) || [];
  assert.ok(
    refs.length >= 2,
    `expected at least 2 references to host_network_reachable (1 def + 1+ caller), got ${refs.length}`,
  );

  // The host-offline branch records the condition and must NOT page.
  assert.match(
    SRC,
    /if\s+!\s+host_network_reachable\s*;\s*then[\s\S]{0,1200}?cloudflared-tunnel\(host-offline\)/,
    "expected an `if ! host_network_reachable; then ... cloudflared-tunnel(host-offline)` skip branch",
  );

  // Both the page and the self-heal must sit in the network-REACHABLE arm, i.e.
  // after the gate's `  else` and before the branch's column-0 `else`. The
  // kickstart is as harmful as the page during a partition: it tears down a
  // healthy established tunnel that must then re-register once the network is
  // back. Containment, not ordering — see the note on the probe test above.
  const gateIdx = SRC.indexOf("if ! host_network_reachable");
  assert.ok(gateIdx !== -1, "could not locate the `if ! host_network_reachable` gate");
  const reachableArmIdx = SRC.indexOf("\n  else\n", gateIdx);
  const branchEndIdx = SRC.indexOf("\nelse\n", gateIdx);
  assert.ok(
    reachableArmIdx !== -1 && branchEndIdx !== -1 && reachableArmIdx < branchEndIdx,
    "expected the host-network gate to have a reachable `  else` arm inside the tunnel branch",
  );
  const reachableArm = SRC.slice(reachableArmIdx, branchEndIdx);
  assert.ok(
    reachableArm.includes('notify "🔴 Cloudflare Tunnel'),
    "the Cloudflare Tunnel page must live in the network-reachable arm of the host-network gate",
  );
  assert.ok(
    reachableArm.includes("Kickstarting $CLOUDFLARED_LABEL"),
    "the cloudflared kickstart must live in the network-reachable arm of the host-network gate",
  );
});

// ── Supabase reachability: cross-tick debounce + recovery parity ─────────────
// (a Supabase compute blip). 2026-10-02 04:56:40 ET this arm paged
// 🔴 "Supabase DB unreachable — the Jori app + phone channel are down …
// likely compute saturation", and at 05:00:07 ET sent "✅ Recovered … stable for
// 3 checks". On a 2-minute cadence that is at most TWO green ticks, and the 🔴
// had already dispatched a same-day heavy system-issue-review escalation run.
//
// Two linked symptoms, one omission: this was the only flapping network probe in
// watchdog.sh whose failure path never called incident_seen. So (a) its only
// debounce was an in-tick `sleep 3`, which samples ~3s of a 120s cadence and
// pages on any blip over ~11s, where every sibling (process-manager-down,
// cloudflared-tunnel, chat-delivery-stuck, gog-auth) requires two consecutive
// failing ticks; and (b) incident_seen is the ONLY writer that removes
// ${key}.green_streak, so a failure never reset the green counter and
// incident_clear's `streak -ge 3` gate could be satisfied by ticks from BEFORE
// the outage — the ✅ asserted a stability nothing had verified.
//
// Same shape as the gog-auth fix of 2026-08-14 above.

function supabaseArms() {
  const holdMarker = 'ISSUES="$ISSUES supabase(host-offline)"';
  const holdIdx = SRC.indexOf(holdMarker);
  assert.ok(holdIdx !== -1, "could not locate the supabase(host-offline) hold branch");

  const holdStart = SRC.lastIndexOf("elif ! host_network_reachable", holdIdx);
  assert.ok(
    holdStart !== -1,
    "the supabase hold branch must still be the `elif ! host_network_reachable` control-probe arm",
  );
  // The hold arm ends at the chain's own `    else`; the failure arm runs from
  // there to the `    fi` closing the if/elif/else chain. Sliced by containment
  // rather than a character window, like the tunnel tests above, so a change
  // that makes the gate stronger cannot fail these.
  const failStart = SRC.indexOf("\n    else\n", holdIdx);
  const failEnd = SRC.indexOf("\n    fi\n", holdIdx);
  assert.ok(
    failStart !== -1 && failEnd !== -1 && failStart < failEnd,
    "expected the supabase chain to keep its `    else` failure arm and its closing `    fi`",
  );
  return {
    hold: SRC.slice(holdStart, failStart),
    fail: SRC.slice(failStart, failEnd),
  };
}

test("supabase-unreachable failure path counts ticks through incident_seen", () => {
  const { fail } = supabaseArms();
  assert.match(
    fail,
    /ATTEMPT=\$\(incident_seen "supabase-unreachable"\)/,
    "the supabase failure arm must call incident_seen — it is the only writer that resets ${key}.green_streak, so without it the ✅ Recovered ping can be satisfied by green ticks that preceded the outage",
  );
  assert.match(
    SRC,
    /incident_clear "supabase-unreachable"/,
    "recovery parity: a healthy probe must still incident_clear",
  );
});

test("supabase-unreachable pages only after 2 consecutive failing ticks", () => {
  const { fail } = supabaseArms();
  assert.match(
    fail,
    /\[ "\$ATTEMPT" -ge 2 \] && incident_should_alert "supabase-unreachable"/,
    'the supabase page must be gated on BOTH the consecutive-tick count and incident_should_alert — an in-tick `sleep 3` re-probe is not a cross-tick debounce, and a single failing tick must never reach notify (the 2026-10-02 04:56 ET page did)',
  );
  // The notify must live inside that gate, not beside it.
  const notifyIdx = fail.indexOf('notify "🔴 Supabase DB unreachable');
  const gateIdx = fail.indexOf('[ "$ATTEMPT" -ge 2 ]');
  assert.ok(
    notifyIdx !== -1 && gateIdx !== -1 && gateIdx < notifyIdx,
    "the 🔴 Supabase page must sit inside the -ge 2 persistence gate",
  );
});

test("supabase page reports how many ticks it observed", () => {
  const notifyLine =
    (SRC.match(/notify "🔴 Supabase DB unreachable[^\n]*/) || [])[0] || "";
  assert.ok(notifyLine, "expected the Supabase page to still exist");
  assert.ok(
    notifyLine.includes("$ATTEMPT"),
    "house style (see the gog arm's 'Failing $GOG_ATTEMPT checks running'): the page must state the consecutive-tick count rather than imply continuous downtime",
  );
});

test("supabase host-offline hold branch neither counts nor clears", () => {
  const { hold } = supabaseArms();
  assert.ok(
    !/incident_seen "supabase-unreachable"/.test(hold),
    "a host-network partition is not evidence Supabase is down — the hold branch must not advance the 2-tick counter (2026-09-25 17:12 and 23:48 ET both paged through partitions where Supabase was fine)",
  );
  assert.ok(
    !/incident_clear "supabase-unreachable"/.test(hold),
    "nor is it evidence Supabase is up — the hold branch must not clear an incident already in progress",
  );
  assert.match(
    hold,
    /DO NOT "tidy" this branch/,
    "the deliberate omission must stay documented in place, or the next reader will 'fix' it into symmetry with the failure arm",
  );
});

test("the retired single-blip debounce claim is gone from the supabase comment", () => {
  assert.doesNotMatch(
    SRC,
    /a single transient blip doesn't page/,
    "the block comment used to claim the in-tick double-check meant a single transient blip could not page; 2026-10-02 disproved it, and leaving the claim sends the next reader down the wrong path",
  );
  assert.match(
    SRC,
    /The in-tick double-check is NOT by itself enough to keep a brief blip from/,
    "the block must say what it defends against (the incident itself is in the changelog)",
  );
});

// --- Two-layer tunnel verdict (cluster sic-20261015-tunnel-probe-hairpin-false-page, 2026-10-16) ---
// 2026-10-15 16:08, 16:10 and 17:00 ET: the public-URL curl from this host
// stalled (000) three times while cloudflared held 4 live connections and a
// Gmail push was accepted through the tunnel in the same seconds. The old
// probe called that "down", kickstarted a healthy tunnel twice and paged a red
// "Gmail pushes are not arriving". The other direction: a tunnel with no
// connector gets Cloudflare's error-1033 page, an HTTP status, which the old
// "any code = up" rule read as healthy. These run the two real functions in
// bash with curl, launchctl and lsof replaced by shell functions.

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function fnSrc(name) {
  const start = SRC.indexOf(`\n${name}() {`);
  assert.notEqual(start, -1, `${name} must be defined in watchdog.sh`);
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} must be a closed function body`);
  return SRC.slice(start + 1, end + 3);
}

const LAUNCHCTL_RUNNING =
  "gui/501/com.cloudflare.cloudflared = {\n\tactive count = 1\n\tstate = running\n\truns = 3\n\tpid = 4242\n\tendpoints = {\n\t\t\"x\" = {\n\t\t\tstate = active\n\t\t}\n\t}\n}\n";
const LAUNCHCTL_STOPPED =
  "gui/501/com.cloudflare.cloudflared = {\n\tactive count = 0\n\tstate = not running\n\tlast exit code = 1\n}\n";
const LSOF_OUT = "p4242\nf12\nn127.0.0.1:20243\n"; // deliberately not 20241
const READY_4 = '{"status":200,"readyConnections":4,"connectorId":"x"}';
const READY_0 = '{"status":503,"readyConnections":0,"connectorId":"x"}';
const STALL = "000 dns=0.002s connect=0.000s tls=0.000s total=8.004s";

function verdict({ publicOut, publicRc = 0, launchctl = LAUNCHCTL_RUNNING, launchctlRc = 0, ready = READY_4 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wd-tunnel-"));
  const asked = path.join(dir, "asked");
  const script = `
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
CLOUDFLARED_HOST=gmail-push.example.com
CLOUDFLARED_LABEL=com.cloudflare.cloudflared
CLOUDFLARED_LSOF=fake_lsof
curl() {
  case "$*" in
    *"https://gmail-push.example.com/"*) printf '%s' ${shq(publicOut)}; return ${publicRc} ;;
    *"http://127.0.0.1:20243/ready"*) printf '%s' ${shq(ready)} ;;
    *) return 7 ;;
  esac
}
launchctl() {
  : > ${shq(asked)}
  [ "$1" = print ] && [ "$2" = "gui/$UID/com.cloudflare.cloudflared" ] || return 113
  printf '%s' ${shq(launchctl)}
  return ${launchctlRc}
}
fake_lsof() {
  case "$*" in *"-p 4242"*) printf '%s' ${shq(LSOF_OUT)} ;; esac
}
${fnSrc("cloudflared_tunnel_probe")}
${fnSrc("cloudflared_local_ready")}
cloudflared_tunnel_probe; rc=$?
printf 'rc=%s\\nhairpin=%s\\nev=%s\\n' "$rc" "$TUNNEL_HAIRPIN_ONLY" "$TUNNEL_PROBE_EVIDENCE"
`;
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  const get = (k) => (out.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1];
  const res = { rc: Number(get("rc")), hairpin: get("hairpin"), ev: get("ev"), asked: fs.existsSync(asked) };
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

test("tunnel: a 2xx from the public URL is up and never asks cloudflared", () => {
  const v = verdict({ publicOut: "200 dns=0.001s connect=0.008s tls=0.018s total=0.045s" });
  assert.equal(v.rc, 0);
  assert.equal(v.hairpin, "0");
  assert.equal(v.ev, "");
  assert.equal(v.asked, false, "the healthy path must stay a single curl");
});

test("tunnel: a stall from this host with cloudflared connected is up, not paged (2026-10-15)", () => {
  const v = verdict({ publicOut: STALL, publicRc: 28 });
  assert.equal(v.rc, 0, "a local stall must not count toward the page or the kickstart");
  assert.equal(v.hairpin, "1");
  assert.match(v.ev, /HTTP 000/);
  assert.match(v.ev, /curl exit 28/, "the curl exit code is kept for attribution");
  assert.match(v.ev, /total=8\.004s/, "curl's timings are kept for attribution");
  assert.match(v.ev, /cloudflared: ready:4/, "the metrics port must come from lsof by pid (20243), not be assumed");
});

test("tunnel: no live connection is down whatever status the edge's error page carries", () => {
  for (const code of ["530", "503", "502", "000"]) {
    const v = verdict({ publicOut: `${code} dns=0.001s`, ready: READY_0 });
    assert.equal(v.rc, 1, `HTTP ${code} with readyConnections 0 must be down`);
    assert.match(v.ev, /cloudflared: notready:0/);
  }
});

test("tunnel: a 530 is down even when cloudflared reports connections", () => {
  const v = verdict({ publicOut: "530 dns=0.001s" });
  assert.equal(v.rc, 1);
  assert.equal(v.hairpin, "0");
});

test("tunnel: a 502 with cloudflared connected is the origin, not the tunnel", () => {
  const v = verdict({ publicOut: "502 dns=0.001s" });
  assert.equal(v.rc, 0);
  assert.equal(v.hairpin, "0");
  assert.match(v.ev, /HTTP 502/);
});

test("tunnel: launchd reporting the agent not running is down", () => {
  const v = verdict({ publicOut: STALL, publicRc: 28, launchctl: LAUNCHCTL_STOPPED });
  assert.equal(v.rc, 1);
  assert.match(v.ev, /cloudflared: notrunning/);
});

test("tunnel: when cloudflared cannot be asked, the old rule applies plus 530", () => {
  assert.equal(verdict({ publicOut: STALL, publicRc: 28, launchctlRc: 113 }).rc, 1);
  assert.equal(verdict({ publicOut: "530 dns=0.001s", launchctlRc: 113 }).rc, 1);
  const v = verdict({ publicOut: "502 dns=0.001s", launchctlRc: 113 });
  assert.equal(v.rc, 0, "an HTTP answer stays up when cloudflared cannot be asked, as before");
  assert.match(v.ev, /cloudflared: unknown:launchctl/);
  const shape = verdict({ publicOut: STALL, publicRc: 28, launchctl: "gui/501/x = {\n\tstate = running\n}\n" });
  assert.match(shape.ev, /unknown:launchctl-state=running/, "running with no pid is unknown, not 'not running'");
  assert.equal(shape.rc, 1);
  const unreadable = verdict({ publicOut: STALL, publicRc: 28, ready: "not json" });
  assert.match(unreadable.ev, /unknown:ready-unreadable/);
  assert.equal(unreadable.rc, 1);
});

test("tunnel: the up branch logs a hairpin-only failure without counting, kickstarting or paging", () => {
  assert.match(SRC, /^CLOUDFLARED_LSOF="\/usr\/sbin\/lsof"$/m, "lsof is not on the watchdog PATH; it must be absolute");
  const probeIdx = SRC.indexOf("if ! cloudflared_tunnel_probe");
  const elseIdx = SRC.indexOf("\nelse\n", probeIdx);
  const fiIdx = SRC.indexOf("\nfi\n", elseIdx);
  const upBranch = SRC.slice(elseIdx, fiIdx);
  assert.match(upBranch, /TUNNEL_HAIRPIN_ONLY/);
  assert.match(upBranch, /incident_clear "cloudflared-tunnel"/);
  assert.doesNotMatch(upBranch, /incident_seen|kickstart -k|notify /);
  const downBranch = SRC.slice(probeIdx, elseIdx);
  assert.match(downBranch, /notify "🔴 Cloudflare Tunnel \(\$CLOUDFLARED_HOST\) is down and didn't recover after launchctl kickstart[^"]*\$TUNNEL_PROBE_EVIDENCE/,
    "the page keeps its stable prefix and carries the evidence");
});

// --- Gmail unread sweep under the ops usage-limit hold (sic-20261028-sweep-pages-during-usage-hold) ---
// While the ops dispatcher is held for the Claude usage limit, the ops webhook
// still accepts a RECLASSIFY POST (it is queued), so the sweep counted every
// tick as a delivered round and, two ticks on, paged "🔴 Email triage sweep: N
// stuck message(s) still in inbox after M delivered RECLASSIFY rounds. Manual
// triage needed." — blaming the triage agent while nothing on ops could run,
// and re-posting the same tasks into the frozen queue every tick. The sweep
// now reads /health rateLimitHoldUntil from $HEALTH (as the chat arm does for
// chat) and, while it is set, holds: no dispatch, no count, no clear, no page.

function sweepBlock() {
  const start = SRC.indexOf("# --- Gmail unread sweep");
  assert.notEqual(start, -1, "could not locate the Gmail unread sweep block");
  const end = SRC.indexOf("\n# --- ", start + 1);
  assert.notEqual(end, -1, "the Gmail unread sweep block must be followed by another `# --- ` section");
  return SRC.slice(start, end + 1);
}

const HOLD_IF = 'if [ "$STUCK_COUNT" -gt 0 ] && [ -n "$OPS_HOLD_UNTIL" ]; then';
const STUCK_ELIF = 'elif [ "$STUCK_COUNT" -gt 0 ]; then';

test("sweep: reads the ops usage-limit hold from $HEALTH", () => {
  const block = sweepBlock();
  assert.match(
    block,
    /OPS_HOLD_UNTIL=\$\(echo "\$HEALTH" \| jq -r '\.rateLimitHoldUntil \/\/ empty' 2>\/dev\/null\)/,
    "the sweep must read rateLimitHoldUntil from the ops /health JSON, and read empty when $HEALTH is empty or unparseable",
  );
  const readIdx = block.indexOf("OPS_HOLD_UNTIL=$(");
  const holdIdx = block.indexOf(HOLD_IF);
  assert.ok(readIdx !== -1 && holdIdx !== -1 && readIdx < holdIdx, "the hold must be read before the branch that consults it");
});

test("sweep: the usage-hold arm comes first and neither counts, clears, dispatches nor pages", () => {
  const block = sweepBlock();
  const holdIdx = block.indexOf(HOLD_IF);
  const elifIdx = block.indexOf(STUCK_ELIF);
  const seenIdx = block.indexOf('incident_seen "gmail-unread-stuck"');
  assert.ok(holdIdx !== -1, `expected the held arm: ${HOLD_IF}`);
  assert.ok(elifIdx !== -1, `the counted arm must follow as: ${STUCK_ELIF}`);
  assert.ok(seenIdx !== -1, "the counted arm must still call incident_seen");
  assert.ok(holdIdx < elifIdx && elifIdx < seenIdx, "the held arm must precede the counted arm and its incident_seen");
  const held = block.slice(holdIdx, elifIdx);
  assert.doesNotMatch(held, /incident_seen "gmail-unread-stuck"/, "a held queue must not advance the 2-tick page counter");
  assert.doesNotMatch(held, /incident_clear "gmail-unread-stuck"/, "a held queue must not clear an incident in progress");
  assert.doesNotMatch(held, /:9092|\bcurl\b/, "no RECLASSIFY dispatch into a held queue");
  assert.doesNotMatch(held, /\bnotify\s/, "the held arm must never page");
  assert.doesNotMatch(held, /landed_rounds|STUCK_ROUNDS_FILE/, "the held arm must not touch the landed-rounds counter");
  assert.match(held, /gmail-unread-stuck\(\$\{STUCK_COUNT\},usage-hold\)/, "the held condition is still recorded in ISSUES");
  assert.match(held, /DO NOT "tidy" this branch/, "the deliberate omission must stay documented in place");
});

// Behavioural: run the real sweep block in bash with gmail-action, curl and the
// incident helpers replaced by stubs that record their calls.
function runSweep({ health, landed = "2", attempt = 3, ids = ["m1", "m2", "m3"] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wd-sweep-"));
  const bin = path.join(dir, "Dev/jori/bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(dir, "Dev/jori/data"), { recursive: true });
  const incidents = path.join(dir, "incidents");
  fs.mkdirSync(incidents);
  const json = JSON.stringify(ids.map((id) => ({ id })));
  fs.writeFileSync(path.join(bin, "gmail-action"), `#!/bin/sh\nprintf '%s' ${shq(json)}\n`, { mode: 0o755 });
  const rounds = path.join(incidents, "gmail-unread-stuck.landed_rounds");
  if (landed !== null) fs.writeFileSync(rounds, `${landed}\n`);
  const calls = path.join(dir, "calls");
  const logFile = path.join(dir, "log");
  const script = `
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
HOME=${shq(dir)}
JORI_INSTALL_TOOLS=${shq(path.join(dir, "Dev/jori"))}
LOG=${shq(logFile)}
INCIDENT_DIR=${shq(incidents)}
PUSH_GAP_MS=1800000
CLOUDFLARED_HOST=gmail-push.example.com
CURL_AUTH=()
ISSUES=""
HEALTH=${shq(health)}
log() { echo "$1" >> "$LOG"; }
${fnSrc("log_throttled")}
incident_seen() { echo "seen $1" >> ${shq(calls)}; echo ${attempt}; }
incident_clear() { echo "clear $1" >> ${shq(calls)}; }
incident_should_alert() { echo "should $1" >> ${shq(calls)}; return 0; }
notify() { echo "notify $1" >> ${shq(calls)}; }
curl() { echo "curl $*" >> ${shq(calls)}; return 0; }
${sweepBlock()}
printf 'issues=%s\\n' "$ISSUES"
`;
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  const res = {
    issues: (out.match(/^issues=(.*)$/m) || [])[1] || "",
    calls: read(calls),
    log: read(logFile),
    landed: fs.existsSync(rounds) ? read(rounds).trim() : null,
    holdMarker: fs.existsSync(path.join(dir, "Dev/jori/data/.watchdog-stuck-sweep-hold-log")),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

const HELD = '{"rateLimitHoldUntil":"2099-01-01T00:00:00.000Z","lastPushAgeMs":1000}';
const NOT_HELD = '{"rateLimitHoldUntil":null,"lastPushAgeMs":1000}';

test("sweep: while ops is held, stuck mail is logged and nothing is dispatched, counted or paged", () => {
  const r = runSweep({ health: HELD });
  assert.equal(r.calls, "", `no incident helper, curl or notify may run while held, got:\n${r.calls}`);
  assert.equal(r.landed, "2", "the landed-rounds counter must hold, not advance");
  assert.match(r.issues, /gmail-unread-stuck\(3,usage-hold\)/);
  assert.match(r.log, /holding for the Claude usage limit until 2099-01-01T00:00:00\.000Z/);
  assert.ok(r.holdMarker, "the held log line is throttled through a marker in the installation's data dir");
  assert.doesNotMatch(r.log, /Dispatched RECLASSIFY/);
});

test("sweep: without a hold the same tick dispatches, counts and pages as before", () => {
  // Contrast case: proves the harness exercises the real block, so the held
  // test above cannot pass vacuously.
  const r = runSweep({ health: NOT_HELD });
  assert.match(r.calls, /^seen gmail-unread-stuck$/m);
  assert.equal((r.calls.match(/^curl .*localhost:9092/gm) || []).length, 3, "one RECLASSIFY POST per stuck message"); // lang-regex-ok: the stubs' own call log, not a person's words
  assert.equal(r.landed, "3", "a delivered round advances the counter");
  assert.match(r.calls, /^notify 🔴 Email triage sweep: 3 stuck message\(s\) still in inbox after 3 delivered RECLASSIFY rounds\. Manual triage needed\.$/m); // lang-regex-ok: the watchdog's own fixed page text in the stubs' call log
  assert.match(r.issues, /gmail-unread-stuck\(3\)/);
});

test("sweep: an unreachable supervisor (empty or unparseable $HEALTH) keeps today's behaviour", () => {
  for (const health of ["", "not json"]) {
    const r = runSweep({ health });
    assert.match(r.calls, /^seen gmail-unread-stuck$/m, `health=${JSON.stringify(health)} must still count the tick`);
    assert.match(r.calls, /localhost:9092/, `health=${JSON.stringify(health)} must still dispatch`);
    assert.doesNotMatch(r.issues, /usage-hold/);
  }
});

test("sweep: an empty inbox still clears the incident while ops is held", () => {
  const r = runSweep({ health: HELD, ids: [] });
  assert.match(r.calls, /^clear gmail-unread-stuck$/m);
  assert.equal(r.landed, null, "the landed-rounds file is reset with the incident");
  assert.doesNotMatch(r.issues, /gmail-unread-stuck/);
});
