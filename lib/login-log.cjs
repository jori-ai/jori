"use strict";
// login-log.cjs — the one record of every website sign-in Jori tries or finds
// broken, and the plain-words cause of each failure.
//
// WHY ONE LOG. Sign-ins fail in many scripts (site-login, job-specific
// readers, token renewals) and each kept its own words for it, so a site that
// failed every day for a week was visible to nobody. Every failed sign-in is
// recorded here with site, time, error and cause, so it can be root-caused and
// alerted on (bin/login-log watch).
//
// FILE: data/site-login-log.jsonl (the path bin/site-login always wrote, and
// which bin/amazon-order-detail reads for its retry backoff). One JSON object
// per line:
//   { ts, site, port, status, detail, source, cause, needs_user, attempt }
//   status      the outcome word (STATUSES below; unknown words are kept)
//   detail      what was seen (a URL, an error line) — never a credential
//   source      who wrote it (the script or job name)
//   cause       a CAUSES key, derived from status + detail by classify()
//   needs_user  true when only the user can fix it (a password, a code)
//   attempt     false for an OBSERVATION (a job found itself signed out, a
//               session was restored from the vault) rather than a typed
//               sign-in; readers that back off after a refused password must
//               skip those rows
//
// Writers: require this and call record(), or from any language run
//   bin/login-log record <site> <status> [--detail …] [--source …] [--port …]
// Readers: read(), or `bin/login-log report`.

const fs = require("node:fs");
const path = require("node:path");
const { installTools } = require("./root.cjs");

const LOG_FILE = () => process.env.JORI_LOGIN_LOG || installTools("data", "site-login-log.jsonl");

const OK = new Set(["signed_in", "already_signed_in", "session_restored", "token_renewed"]);
// Rows that record what a job saw rather than a sign-in it typed.
const OBSERVATIONS = new Set(["signed_out", "session_restored", "cookie_jar_wiped"]);

// cause → { needs_user, why (plain words), fix (what makes the next try work) }
const CAUSES = {
  ok: { needs_user: false, why: "signed in", fix: "" },
  password_rejected: { needs_user: true, why: "the site refused the saved login", fix: "update the login in 1Password (Logins vault, matched by the site's URL)" },
  no_saved_login: { needs_user: true, why: "no saved login for this site", fix: "save the login in 1Password (Logins vault, with the site's URL)" },
  one_time_code: { needs_user: true, why: "the site asked for a one-time code or an approval", fix: "approve once; the session is then kept by the session vault" },
  credential_store_timeout: { needs_user: false, why: "1Password did not answer in time", fix: "retried automatically; if it repeats, check op on the mini (privacy prompt, network)" },
  credential_store_token_missing: { needs_user: false, why: "the 1Password service-account token is missing", fix: "restore OP_LOGINS_SERVICE_ACCOUNT_TOKEN in .env" },
  robot_check: { needs_user: false, why: "a robot check (captcha) is on the sign-in form", fix: "sign in once by hand in the automation Chrome; the session vault then keeps it" },
  login_page_changed: { needs_user: false, why: "the sign-in form could not be found or submitted", fix: "the site changed its page; site-login needs updating for it" },
  login_not_sticking: { needs_user: false, why: "the login went in but the site still shows signed out", fix: "the site likely wants a code or a different flow; look at it once by hand" },
  session_lost: { needs_user: false, why: "the saved session was gone when a job needed it", fix: "signed back in automatically; see the next row" },
  cookie_jar_wiped: { needs_user: false, why: "the automation Chrome lost every saved session at once (a Chrome update or the keychain key changed)", fix: "restored from the session vault" },
  chrome_down: { needs_user: false, why: "the automation Chrome was not answering", fix: "chrome-cdp-watch restarts it" },
  manual_by_policy: { needs_user: false, why: "financial site, kept manual by policy", fix: "" },
  page_error: { needs_user: false, why: "the page failed while signing in", fix: "retried on the next run" },
  other: { needs_user: false, why: "an unrecognised failure", fix: "look at the detail" },
};

/** Plain-words cause of one outcome. */
function classify(status, detail = "") {
  const d = String(detail || "");
  if (OK.has(status)) return "ok";
  switch (status) {
    case "bad_credentials": return "password_rejected";
    case "needs_2fa": return "one_time_code";
    case "captcha": return "robot_check";
    case "no_login_form": return "login_page_changed";
    case "still_signed_out": return "login_not_sticking";
    case "denylisted": return "manual_by_policy";
    case "signed_out": return "session_lost";
    case "cookie_jar_wiped": return "cookie_jar_wiped";
    case "no_credentials":
      if (/ETIMEDOUT|timed? ?out/i.test(d)) return "credential_store_timeout";
      if (/TOKEN|secrets broker|service.account/i.test(d)) return "credential_store_token_missing";
      return "no_saved_login";
    case "error":
      if (/not answering|would not open a tab|ECONNREFUSED/i.test(d)) return "chrome_down";
      return "page_error";
    default: return "other";
  }
}

const isOk = (row) => OK.has(row.status);

/** Append one outcome. Never throws (a log write must not break a sign-in). */
function record({ site, status, detail = "", source = null, port = null, ...extra }) {
  const cause = classify(status, detail);
  const row = {
    ts: new Date().toISOString(),
    site: String(site || "").toLowerCase(),
    port: port == null ? null : String(port),
    status,
    detail: String(detail || "").slice(0, 500),
    source: source || process.env.JORI_JOB || process.env.CRON_LABEL || path.basename(process.argv[1] || "") || null,
    cause,
    needs_user: CAUSES[cause].needs_user,
    attempt: !OBSERVATIONS.has(status),
    ...extra,
  };
  try {
    fs.mkdirSync(path.dirname(LOG_FILE()), { recursive: true });
    fs.appendFileSync(LOG_FILE(), JSON.stringify(row) + "\n");
  } catch { /* best effort */ }
  return row;
}

/** Every row (old rows without cause get one), optionally since a time. */
function read({ sinceMs = 0 } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(LOG_FILE(), "utf8").split("\n"); } catch { return []; }
  const rows = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r || !r.site || !r.status) continue;
    if (sinceMs && !(Date.parse(r.ts) >= sinceMs)) continue;
    if (!r.cause) r.cause = classify(r.status, r.detail);
    if (r.needs_user == null) r.needs_user = (CAUSES[r.cause] || CAUSES.other).needs_user;
    if (r.attempt == null) r.attempt = !OBSERVATIONS.has(r.status);
    rows.push(r);
  }
  return rows;
}

/** Per site: the latest outcome, the last success, and the failures since it. */
function summarize(rows) {
  const by = new Map();
  for (const r of rows) {
    const s = by.get(r.site) || { site: r.site, attempts: 0, failures: 0, last: null, last_ok: null, failing_since: null, causes: {} };
    s.attempts++;
    if (isOk(r)) { s.last_ok = r; s.failing_since = null; }
    else if (r.status !== "denylisted") {
      s.failures++;
      s.causes[r.cause] = (s.causes[r.cause] || 0) + 1;
      if (!s.failing_since) s.failing_since = r.ts;
    }
    s.last = r;
    by.set(r.site, s);
  }
  return [...by.values()].map((s) => ({ ...s, failing: !!s.failing_since }));
}

module.exports = { CAUSES, OK, OBSERVATIONS, LOG_FILE, classify, record, read, summarize, isOk };
