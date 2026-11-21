// email-triage-tools.mjs — the whole tool surface of the strict email-triage
// one-shot (bin/email-triage-run, served by agent/tools-mcp/email-triage.mjs).
//
// Why. Per-message Gmail triage used to be a turn in the ops-light session:
// the email's body — written by anyone — read by a model holding Bash, the web,
// 66 MCP tools and a long session. This surface is the same triage with none of
// that. Every tool wraps the CLI the triage rules already name, so the rules
// read the same; what the model can reach is bounded IN CODE:
//
//   - The email is bound by the runner (TRIAGE_MESSAGE_ID / _FROM / _SUBJECT /
//     _DATE). Gmail mutations, the P1 task, the P1 downgrade and the spam block
//     act on THAT message or sender only; no tool takes a message id.
//   - notify_owner reaches the owner only (jori-send-curl), with an intent from
//     a fixed list and --evidence-as-of the email's own Date.
//   - Calendar writes take no attendees, so nothing goes to a third party.
//   - escalate_to_ops passes the message id and a reason from a fixed list —
//     never model-written text — and ops re-reads the email itself.
//   - No shell, files, web, browser, mailbox search or outbound email.
//
// Anything the rules ask for that has no tool here (an installation's own
// commands, following a link, a reply, a mailbox search) is an escalation.
//
// Dry run (TRIAGE_DRY=1): read tools run; every tool that changes something
// records what it would have done and does nothing. That is the replay mode.
// Design: docs/email-triage-strict.md.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Kernel intents; an installation adds its own (agent/local/config/email-triage.json `extra_notify_intents`).
export const NOTIFY_INTENTS = Object.freeze([
  "p1-email", "p1-email-correction", "shipping", "delivery", "meeting-cancelled", "mention-reply", "triage",
]);
function localTriage() {
  try { return require("./instance.cjs").localConfig("email-triage", { extra_labels: [], extra_notify_intents: [] }); } catch { return {}; }
}
export function notifyIntents() {
  return [...new Set([...NOTIFY_INTENTS, ...(localTriage().extra_notify_intents || [])])];
}
export const ESCALATION_REASONS = Object.freeze([
  "needs-a-command-not-in-this-toolbox", "needs-the-web-or-a-browser", "needs-the-thread-or-mailbox",
  "user-instruction-to-carry-out", "multi-step-follow-up", "unsure-how-to-triage",
]);
const GMAIL_ACTIONS = Object.freeze(["label", "unlabel", "star", "unstar", "mark-read", "mark-unread", "label-archive", "labels"]);
const NEEDS_LABEL = new Set(["label", "unlabel", "label-archive"]);
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/; // lang-regex-ok: rule slug shape, not language
const DAY = /^\d{4}-\d{2}-\d{2}$/; // lang-regex-ok: ISO date shape
const STAMP = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/; // lang-regex-ok: ISO timestamp shape
const EVENT_ID = /^[A-Za-z0-9_-]{4,200}$/; // lang-regex-ok: calendar event id shape

function allowedLabels() {
  const extra = localTriage().extra_labels || [];
  const { LABELS } = require("./triage-labels.cjs");
  return new Set([...LABELS, "p1", "p3", ...extra]);
}

const str = (v, max = 2000) => String(v ?? "").slice(0, max);

// Claude Code moves a large tool result into a file and shows the model only a
// preview; this session has no file tools, so it would never see the rest. Every
// result stays under PAGE chars, and the rules are read page by page.
export const PAGE = 15000;
export function paged(text, page = 1) {
  const t = String(text ?? "");
  const pages = Math.max(1, Math.ceil(t.length / PAGE));
  const p = Math.min(Math.max(1, Number(page) || 1), pages);
  return { page: p, pages, ...(p < pages ? { next: `call again with page ${p + 1}` } : {}), text: t.slice((p - 1) * PAGE, p * PAGE) };
}
function need(cond, msg) { if (!cond) throw new Error(msg); }

/**
 * Build the tools for one bound email.
 *   bound: { messageId, from, subject, dateIso }
 *   run(bin, args) → Promise<stdout>     (a bin under the installation's bin/, or "gog")
 *   record(entry)                         (what changed, or would have, for the runner)
 *   dry: boolean
 */
export function makeTools({ bound, run, record = () => {}, dry = false }) {
  need(bound && bound.messageId, "no bound message");
  const id = bound.messageId;
  const intents = notifyIntents();
  const fromAddr = (() => {
    const s = String(bound.from || ""); const lt = s.lastIndexOf("<"), gt = s.lastIndexOf(">");
    return (lt !== -1 && gt > lt ? s.slice(lt + 1, gt) : s).trim().toLowerCase();
  })();

  // What this run has changed, in code's words (never the model's text), for
  // an escalation to hand on.
  const done = [];
  // A tool that changes something: run (unless dry), THEN recorded with its
  // outcome, so a failed call is never counted as done.
  async function act(tool, bin, args, summary, doneAs = tool) {
    if (dry) { record({ tool, summary, dry: true }); done.push(doneAs); return { ok: true, dry_run: true, would_run: summary }; }
    try {
      const out = await run(bin, args);
      record({ tool, summary });
      done.push(doneAs);
      return { ok: true, output: str(out, 1500) };
    } catch (e) {
      record({ tool, summary, failed: true, error: str(e?.stderr || e?.message, 300) });
      throw e;
    }
  }

  const tools = [
    {
      name: "triage_rules",
      description: "Read the Email Triage Rules: the decision core, the index of category rules, or one or more category sections by slug (`triage-rules core | index | section <slug>…`). Long text comes in pages: read EVERY page of the core (page 1, 2, … until `pages`) before deciding anything.",
      schema: { type: "object", properties: { part: { type: "string", enum: ["core", "index", "section"] }, slugs: { type: "array", items: { type: "string" } }, page: { type: "integer" } }, required: ["part"] },
      run: async ({ part, slugs = [], page = 1 }) => {
        need(["core", "index", "section"].includes(part), "part must be core, index or section");
        const s = (slugs || []).map(String);
        if (part === "section") need(s.length && s.length <= 6 && s.every((x) => SLUG.test(x)), "give 1-6 slugs from the index");
        return paged(await run("triage-rules", part === "section" ? ["section", ...s] : [part]), page);
      },
    },
    {
      name: "gmail_message",
      description: "Change THIS email's Gmail state (it is `gmail-action <action> <this messageId> [label]`): label, unlabel, star, unstar, mark-read, mark-unread, label-archive; or `labels` to list its current labels. Labels: the triage labels, p1, p3.",
      schema: { type: "object", properties: { action: { type: "string", enum: GMAIL_ACTIONS }, label: { type: "string" } }, required: ["action"] },
      run: async ({ action, label }) => {
        need(GMAIL_ACTIONS.includes(action), `action must be one of ${GMAIL_ACTIONS.join(", ")}`);
        if (action === "labels") return { labels: await run("gmail-action", ["labels", id]) };
        const args = [action, id];
        if (NEEDS_LABEL.has(action)) {
          const l = str(label, 60).toLowerCase();
          need(allowedLabels().has(l), `label must be one of ${[...allowedLabels()].join(", ")}`);
          args.push(l);
        }
        return act("gmail_message", "gmail-action", args, `gmail-action ${args.join(" ")}`, `gmail ${action}${args[2] ? ` ${args[2]}` : ""}`);
      },
    },
    {
      name: "email_memory",
      description: "The triage email memory (`email-mem`): search it, test what it says about THIS sender and subject, add a note, or supersede an old note.",
      schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["search", "test", "add", "supersede"] },
          query: { type: "string" }, text: { type: "string" }, tags: { type: "string" }, expires: { type: "string" },
          id: { type: "integer" }, by: { type: "integer" },
        },
        required: ["action"],
      },
      run: async ({ action, query, text, tags, expires, id: memId, by }) => {
        if (action === "search") { need(str(query).trim(), "query required"); return { results: await run("email-mem", ["search", str(query, 200)]) }; }
        if (action === "test") return { results: await run("email-mem", ["test", "--from", fromAddr, "--subject", str(bound.subject, 300)]) };
        if (action === "add") {
          need(str(text).trim(), "text required");
          const args = ["add", str(text, 600)];
          if (tags) args.push("--tags", str(tags, 200));
          if (expires) { need(DAY.test(expires), "expires is YYYY-MM-DD"); args.push("--expires", expires); }
          return act("email_memory", "email-mem", args, `email-mem add (${str(text, 80)})`);
        }
        if (action === "supersede") {
          need(Number.isInteger(memId) && Number.isInteger(by), "id and by are note ids");
          return act("email_memory", "email-mem", ["supersede", String(memId), "--by", String(by)], `email-mem supersede ${memId} --by ${by}`);
        }
        throw new Error("action must be search, test, add or supersede");
      },
    },
    {
      name: "p1_task",
      description: "Create the P1 task for THIS email (`p1-task add <this messageId> --title … --due YYYY-MM-DD [--notes …]`).",
      schema: { type: "object", properties: { title: { type: "string" }, due: { type: "string" }, notes: { type: "string" } }, required: ["title", "due"] },
      run: async ({ title, due, notes }) => {
        need(str(title).trim(), "title required"); need(DAY.test(String(due || "")), "due is YYYY-MM-DD");
        const args = ["add", id, "--title", str(title, 200), "--due", due];
        if (notes) args.push("--notes", str(notes, 1500));
        return act("p1_task", "p1-task", args, `p1-task add "${str(title, 80)}" due ${due}`);
      },
    },
    {
      name: "p1_downgrade",
      description: "THIS email is not a real P1 (a misfire at intake): unlabel p1, unstar, label p3 (`p1-downgrade <this messageId> --source triage --reason …`).",
      schema: { type: "object", properties: { reason: { type: "string" }, keep_task: { type: "boolean" } }, required: ["reason"] },
      run: async ({ reason, keep_task }) => {
        const args = [id, "--source", "triage", "--reason", str(reason, 300)];
        if (keep_task) args.push("--keep-task");
        return act("p1_downgrade", "p1-downgrade", args, `p1-downgrade (${str(reason, 80)})`);
      },
    },
    {
      name: "notify_owner",
      description: `Send the owner one message on the phone (\`jori-send-curl\`), about THIS email only. intent is one of: ${intents.join(", ")}. The email's own Date is passed as --evidence-as-of, and a p1-email carries --p1-message for this email.`,
      schema: { type: "object", properties: { text: { type: "string" }, intent: { type: "string", enum: intents } }, required: ["text", "intent"] },
      run: async ({ text, intent }) => {
        need(intents.includes(intent), `intent must be one of ${intents.join(", ")}`);
        need(str(text).trim(), "text required");
        const args = ["--intent", intent];
        if (bound.dateIso && STAMP.test(bound.dateIso)) args.push("--evidence-as-of", bound.dateIso);
        if (intent === "p1-email" || intent === "p1-email-correction") args.push("--p1-message", id);
        args.push(str(text, 1200));
        return act("notify_owner", "jori-send-curl", args, `notify (${intent}): ${str(text, 100)}`);
      },
    },
    {
      name: "calendar_events",
      description: "Read the owner's Google Calendar between two times (RFC3339 or YYYY-MM-DD), optionally filtered by words (`gog calendar events primary`).",
      schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, query: { type: "string" } }, required: ["from", "to"] },
      run: async ({ from, to, query }) => {
        need(STAMP.test(String(from || "")) && STAMP.test(String(to || "")), "from and to are YYYY-MM-DD or RFC3339");
        const args = ["calendar", "events", "primary", "--from", from, "--to", to, "--json"];
        if (query) args.push("--query", str(query, 120));
        return { events: str(await run("gog", args), PAGE) };
      },
    },
    {
      name: "calendar_write",
      description: "Create or update an event on the owner's own calendar (`jori-calendar create|update … --calendar primary`). Never invites anyone. booking_ref ties a reservation event to THIS confirmation email.",
      schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update"] }, event_id: { type: "string" },
          summary: { type: "string" }, from: { type: "string" }, to: { type: "string" },
          description: { type: "string" }, location: { type: "string" },
          transparency: { type: "string", enum: ["opaque", "transparent"] }, event_color: { type: "string" },
          booking_ref: { type: "string" },
        },
        required: ["action"],
      },
      run: async (a) => {
        need(["create", "update"].includes(a.action), "action is create or update");
        const args = [a.action];
        if (a.action === "update") { need(EVENT_ID.test(String(a.event_id || "")), "event_id required for update"); args.push(a.event_id); }
        args.push("--calendar", "primary");
        if (a.action === "create") need(str(a.summary).trim() && a.from && a.to, "summary, from and to required");
        for (const k of ["from", "to"]) if (a[k] != null) { need(STAMP.test(String(a[k])), `${k} is YYYY-MM-DD or RFC3339`); args.push(`--${k}`, a[k]); }
        if (a.summary != null) args.push("--summary", str(a.summary, 200));
        if (a.description != null) args.push("--description", str(a.description, 3000));
        if (a.location != null) args.push("--location", str(a.location, 300));
        if (a.transparency) args.push("--transparency", a.transparency);
        if (a.event_color != null) { need(/^\d{1,2}$/.test(String(a.event_color)), "event_color is a colour number"); args.push("--event-color", String(a.event_color)); } // lang-regex-ok: digits
        if (a.booking_ref) args.push("--from-confirmation", id, "--booking-ref", str(a.booking_ref, 80));
        return act("calendar_write", "jori-calendar", args, `jori-calendar ${a.action} ${str(a.summary || a.event_id, 80)}`);
      },
    },
    {
      name: "tasks_list",
      description: "List the owner's open Google Tasks (default list), to check for a task that already exists.",
      schema: { type: "object", properties: {} },
      run: async () => ({ tasks: str(await run("gog", ["tasks", "list", "@default", "--plain", "--no-input"]), PAGE) }),
    },
    {
      name: "travel",
      description: "Where the owner is or will be (`travel where [<when>]`), or whether they are in a metro at a time (`travel in-city <metro> [<when>]`).",
      schema: { type: "object", properties: { action: { type: "string", enum: ["where", "in-city"] }, metro: { type: "string" }, when: { type: "string" } }, required: ["action"] },
      run: async ({ action, metro, when }) => {
        const args = [action];
        if (action === "in-city") { need(str(metro).trim(), "metro required"); args.push(str(metro, 60)); }
        else need(action === "where", "action is where or in-city");
        if (when) args.push(str(when, 40));
        return { result: await run("travel", args) };
      },
    },
    {
      name: "spam_block",
      description: "Block THIS email's sender address from now on (`spam-filter block --sender <this sender>`).",
      schema: { type: "object", properties: { reason: { type: "string" }, scam: { type: "boolean" } }, required: ["reason"] },
      run: async ({ reason, scam }) => {
        need(fromAddr.includes("@"), "this email has no sender address");
        const args = ["block", "--sender", fromAddr, "--reason", str(reason, 200), "--message", id];
        if (scam) args.push("--scam");
        return act("spam_block", "spam-filter", args, `spam-filter block ${fromAddr}`);
      },
    },
    {
      name: "recall",
      description: "Look up what is known about a person, place or topic (chat, the owner's past answers, the wiki).",
      schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      run: async ({ query }) => ({ results: str(await run("recall", [str(query, 200)]), PAGE) }),
    },
    {
      name: "wiki_read",
      description: "Read one wiki page by id.",
      schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: async ({ id: page }) => { need(SLUG.test(String(page || "").replace(/\.md$/, "").replace(/_/g, "-")), "a wiki page id"); return { page: str(await run("wiki", ["read", String(page)]), PAGE) }; }, // lang-regex-ok: page id shape
    },
    {
      name: "escalate_to_ops",
      description: `Hand THIS email to the full ops agent when the rules ask for something no tool here does: an installation command, following a link, a reply, the thread or a mailbox search, a user instruction to carry out. Give the reason from the list (${ESCALATION_REASONS.join(", ")}) and, when one applies, the rule's slug. Ops re-reads the email itself. Do the triage you can do here first (labels, star, read state).`,
      schema: { type: "object", properties: { reason: { type: "string", enum: ESCALATION_REASONS }, rule_slug: { type: "string" } }, required: ["reason"] },
      run: async ({ reason, rule_slug }) => {
        need(ESCALATION_REASONS.includes(reason), `reason must be one of ${ESCALATION_REASONS.join(", ")}`);
        const slug = rule_slug && SLUG.test(String(rule_slug)) ? String(rule_slug) : null;
        const already = done.length ? ` It already did: ${[...new Set(done)].join(", ")} — do not repeat those.` : "";
        const task = `TRIAGE ESCALATION gmail:${id} — the strict triage one-shot hands this email to you (reason: ${reason}${slug ? `; rule: ${slug}` : ""}).${already} Re-read the email (MessageId ${id}) and finish its triage per the Email Triage Rules.`;
        if (dry) { record({ tool: "escalate_to_ops", reason, rule_slug: slug, dry: true }); return { ok: true, dry_run: true }; }
        // To ops-light (the tier that triages today), never the Chrome-carrying ops tier.
        let port = null;
        try { port = require("./ports.cjs").port("ops_light_webhook"); } catch {}
        const args = ["dispatch", ...(port ? ["--port", String(port)] : []), "--source", `gmail-escalation:${id}`, "--task", task];
        try { await run("jori", args); }
        catch (e) { record({ tool: "escalate_to_ops", reason, rule_slug: slug, failed: true, error: str(e?.stderr || e?.message, 300) }); throw e; }
        record({ tool: "escalate_to_ops", reason, rule_slug: slug });
        return { ok: true, note: "Handed to ops. Finish with your one-line summary." };
      },
    },
  ];
  return tools;
}

export const TOOL_NAMES = Object.freeze(makeTools({ bound: { messageId: "x" }, run: async () => "" }).map((t) => t.name));
