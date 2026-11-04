// meeting-notes-update.mjs — fold one call of a recurring meeting into its notes file.
//
// The requirement: after each call, its transcript or summary updates the
// call summaries and the action items for the next call. The rules are the
// chat agent's (agent/chat-agent/procedures/meeting-notes.md): what was
// discussed goes under "## Discussed" / "### <date>", items the call covered
// leave "To Discuss" (kept, checked, under that date), follow-ups and topics
// for next time join "To Discuss" as `- [ ]`, and "Running Context" only
// grows: every fact dated, nothing removed.
//
// A MODEL reads the call and answers with a structured edit (EDIT_SCHEMA);
// CODE applies it to the markdown by its headings, so the model never rewrites
// the file and cannot drop history. Its answer is checked first: an item it
// says the call closed must be a To Discuss line copied exactly, and every
// list entry must be a non-empty string of bounded length.
//
// The pre- and post-call messages are short bullet points. So the same answer
// also carries "recap" (the phone message's few short bullets) and "labels" (a
// few words per open To Discuss item, kept in the meeting's labels file for
// the next call's reminder). The notes keep their full wording.

import { createRequire } from "node:module";
const { instance } = createRequire(import.meta.url)("./instance.cjs");

export const EDIT_SCHEMA = `{
  "discussed": ["<one line per topic: what was said or decided>"],
  "closed_items": ["<a To Discuss item the call covered, copied EXACTLY as listed, without the '- [ ] ' prefix>"],
  "follow_ups": ["<new To Discuss item: a pending outcome to check next time, or a topic set for next time>"],
  "recap": ["<2 to 5 bullets for a phone message, at most 8 words each: the call's key points and decisions>"],
  "labels": {"<every To Discuss item listed below and every follow_up, copied EXACTLY>": "<the same item in at most 6 words>"},
  "priority": ["<every To Discuss item still open after the call and every follow_up, copied EXACTLY, most important or urgent first>"],
  "context": [{"section": "<an existing Running Context section name, or a new one>", "name": "<an existing bold name copied exactly, or a new person / deal / topic>", "text": "<the new fact>"}]
}`;

const H2 = "## ", H3 = "### ";
const LIMIT = 600, SHORT = 80;

/** The file split into its "## " parts, each with its "### " subsections' line ranges. Pure. */
export function outline(text) {
  const lines = String(text || "").split("\n");
  const parts = [];
  lines.forEach((l, i) => { if (l.startsWith(H2)) parts.push({ title: l.slice(3).trim(), start: i }); });
  parts.forEach((p, k) => { p.end = k + 1 < parts.length ? parts[k + 1].start : lines.length; });
  return { lines, parts };
}

const part = (o, title) => o.parts.find((p) => p.title === title) || null;
const CTX = "Running Context (Full History)", TODO = "To Discuss (Upcoming)", DONE = "Discussed";

/** The open items under To Discuss, without their "- [ ] " prefix. Pure. */
export function openItems(text) {
  const o = outline(text), p = part(o, TODO);
  if (!p) return [];
  return o.lines.slice(p.start + 1, p.end).filter((l) => l.startsWith("- [ ] ")).map((l) => l.slice(6));
}

/** Running Context sections and the bold names that open their paragraphs. Pure. */
export function contextIndex(text) {
  const o = outline(text), p = part(o, CTX);
  const out = {};
  if (!p) return out;
  let sec = null;
  for (const l of o.lines.slice(p.start + 1, p.end)) {
    if (l.startsWith(H3)) { sec = l.slice(4).trim(); out[sec] = []; continue; }
    if (sec && l.startsWith("**")) {
      const close = l.indexOf("**", 2);
      if (close > 2) out[sec].push(l.slice(2, close));
    }
  }
  return out;
}

const okStr = (s) => typeof s === "string" && s.trim().length > 0 && s.length <= LIMIT && !s.includes("\n");

/** null when the model's edit is usable against `text`, else why not. Pure. */
export function validateEdit(edit, text) {
  if (!edit || typeof edit !== "object") return "not an object";
  for (const k of ["discussed", "closed_items", "follow_ups", "context"]) {
    if (!Array.isArray(edit[k])) return `${k} is not an array`;
  }
  if (!edit.discussed.length) return "discussed is empty";
  if (!Array.isArray(edit.recap) || !edit.recap.length || edit.recap.length > 6) return "recap is not 1 to 6 bullets";
  if (edit.recap.find((s) => !okStr(s) || s.length > SHORT) !== undefined) return "recap has an empty, multi-line or long bullet";
  for (const k of ["discussed", "closed_items", "follow_ups"]) {
    const bad = edit[k].find((s) => !okStr(s));
    if (bad !== undefined) return `${k} has an empty, multi-line or overlong entry`;
  }
  const open = openItems(text);
  const missing = edit.closed_items.find((s) => !open.includes(s));
  if (missing !== undefined) return `closed item is not a To Discuss line: ${String(missing).slice(0, 80)}`;
  for (const c of edit.context) {
    if (!c || !okStr(c.section) || !okStr(c.name) || !okStr(c.text)) return "a context entry lacks section, name or text";
    if (c.section.includes("#") || c.name.includes("**")) return "a context entry carries markdown";
  }
  return null;
}

/**
 * The usable labels from the model's answer: {item: short}, only for items open
 * before the call or added by it, each short and one line. Anything else is
 * dropped, not an error — a missing label just shows the item as written. Pure.
 */
export function cleanLabels(edit, text) {
  const known = new Set([...openItems(text), ...(edit?.follow_ups || [])]);
  const raw = edit && edit.labels && typeof edit.labels === "object" && !Array.isArray(edit.labels) ? edit.labels : {};
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => known.has(k) && okStr(v) && v.length <= SHORT));
}

/**
 * The model's priority order, kept to items open after the call (or added by it),
 * each once. Bad entries are dropped, not an error: an unranked item just sorts
 * after the ranked ones in the reminder. Pure.
 */
export function cleanPriority(edit, text) {
  const closed = new Set(edit?.closed_items || []);
  const known = new Set([...openItems(text), ...(edit?.follow_ups || [])].filter((k) => !closed.has(k)));
  const raw = Array.isArray(edit?.priority) ? edit.priority : [];
  return [...new Set(raw.filter((k) => typeof k === "string" && known.has(k)))];
}

/**
 * Check a To Discuss item off in place ("- [ ] x" → "- [x] x"), or back on.
 * The user ticks items on the reminder's checklist when they are done or no
 * longer relevant; a ticked line stays in To Discuss as "- [x]", which
 * every reader of the agenda already skips, so an accidental tick is undone by
 * the same edit in reverse. `item` must be the line's text exactly; returns null
 * when no such line is there (already in that state counts as done). Pure.
 */
export function setItemDone(text, item, done) {
  const o = outline(text), p = part(o, TODO);
  if (!p) return null;
  const lines = [...o.lines], want = `${done ? "- [x] " : "- [ ] "}${item}`;
  for (let i = p.start + 1; i < p.end; i++) {
    if (lines[i] === want) return text;
    if (lines[i] === `${done ? "- [ ] " : "- [x] "}${item}` || (!done && lines[i] === `- [X] ${item}`)) {
      lines[i] = want;
      return lines.join("\n");
    }
  }
  return null;
}

/** "Oct 21" for 2026-10-21. Pure. */
export function dayTag(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * The notes with `edit` applied for the call on `date` (YYYY-MM-DD). Validated
 * first by the caller. Never removes a line except a closed To Discuss item,
 * which moves under the date as "- [x] ...". Pure.
 */
export function applyEdit(text, date, edit) {
  const tag = `[${dayTag(date)}]`;
  let lines = String(text).split("\n");
  const at = (title) => outline(lines.join("\n")).parts.find((p) => p.title === title);

  // 1. To Discuss: closed items out, follow-ups in at the end of the list.
  {
    const p = at(TODO);
    if (!p) throw new Error(`no "## ${TODO}" section`);
    const closed = new Set(edit.closed_items.map((s) => `- [ ] ${s}`));
    let body = lines.slice(p.start + 1, p.end).filter((l) => !closed.has(l));
    let last = body.length - 1;
    while (last >= 0 && !body[last].trim()) last--;
    body = [...body.slice(0, last + 1), ...edit.follow_ups.map((s) => `- [ ] ${s}`), ...body.slice(last + 1)];
    if (!body.length || body[body.length - 1].trim()) body.push("");
    lines = [...lines.slice(0, p.start + 1), ...body, ...lines.slice(p.end)];
  }

  // 2. Discussed: this date's section (created at the top when new), bullets appended.
  {
    const p = at(DONE);
    if (!p) throw new Error(`no "## ${DONE}" section`);
    const bullets = [...edit.discussed.map((s) => `- ${s}`), ...edit.closed_items.map((s) => `- [x] ${s}`)];
    const head = lines.findIndex((l, i) => i > p.start && i < p.end && l.trim() === `${H3}${date}`);
    if (head >= 0) {
      let end = head + 1;
      while (end < p.end && !lines[end].startsWith(H3) && !lines[end].startsWith(H2)) end++;
      let last = end - 1;
      while (last > head && !lines[last].trim()) last--;
      lines = [...lines.slice(0, last + 1), ...bullets, ...lines.slice(last + 1)];
    } else {
      let first = p.start + 1;
      while (first < p.end && !lines[first].trim()) first++;
      lines = [...lines.slice(0, p.start + 1), "", `${H3}${date}`, ...bullets, "", ...lines.slice(first)];
    }
  }

  // 3. Running Context: a dated fact appended to the named paragraph, or a new paragraph / section.
  for (const c of edit.context) {
    const p = at(CTX);
    if (!p) throw new Error(`no "## ${CTX}" section`);
    let sec = lines.findIndex((l, i) => i > p.start && i < p.end && l.startsWith(H3) && l.slice(4).trim() === c.section);
    if (sec < 0) {
      let last = p.end - 1;
      while (last > p.start && !lines[last].trim()) last--;
      lines = [...lines.slice(0, last + 1), "", `${H3}${c.section}`, "", `**${c.name}** — ${tag} ${c.text}`, ...lines.slice(last + 1)];
      continue;
    }
    let end = sec + 1;
    while (end < lines.length && !lines[end].startsWith(H3) && !lines[end].startsWith(H2)) end++;
    const para = lines.findIndex((l, i) => i > sec && i < end && l.startsWith(`**${c.name}**`));
    if (para >= 0) { lines[para] = `${lines[para].trimEnd()} ${tag} ${c.text}`; continue; }
    let last = end - 1;
    while (last > sec && !lines[last].trim()) last--;
    lines = [...lines.slice(0, last + 1), "", `**${c.name}** — ${tag} ${c.text}`, ...lines.slice(last + 1)];
  }
  return lines.join("\n");
}

/** The prompt for the model that reads the call. `name` is the counterpart; `owner` the user. */
export function editPrompt({ date, when, source, content, notesText, name = "the other person", owner = instance().owner_name }) {
  const ctx = contextIndex(notesText);
  return `${owner} has a regular video call with ${name}. You are updating ${owner}'s running notes for these calls from Zoom's ${source === "transcript" ? "transcript" : "AI summary"} of the call on ${date} (${when}).

Rules:
- "discussed": one line per topic, saying what was said or decided. Facts from the call only; never invent names, numbers or decisions.
- "closed_items": To Discuss items this call covered. Copy each one EXACTLY as listed below (character for character, without "- [ ] "). Leave out anything the call did not cover.
- "follow_ups": a new To Discuss item for every pending outcome ("${name} will check", "decision pending", "follow up next week") and every topic set for next time, each with brief context. Do not repeat an item that is already open below.
- "recap": the call in 2 to 5 short bullets for a phone message, at most 8 words each, most important first. Lead with the topic ("Pilot: starts in November").
- "labels": every To Discuss item listed below and every follow_up (key copied EXACTLY), each in at most 6 words, topic first, with a deadline if it has one ("Offer: decide by Fri").
- "priority": every To Discuss item still open after this call (not in closed_items) and every follow_up, keys copied EXACTLY, ordered most important or urgent first: hard deadlines and the biggest deals or decisions on top, stale carry-overs at the bottom.
- "context": new facts for the permanent Running Context log. Use an existing section and an existing bold name when the fact is about them (copy the name exactly); otherwise a new name. Leave empty when nothing new.
- No markdown in any string, one line each.

Return ONLY this JSON, no prose:
${EDIT_SCHEMA}

To Discuss (open items):
${openItems(notesText).map((s) => `- [ ] ${s}`).join("\n") || "(none)"}

Running Context sections and names:
${Object.entries(ctx).map(([s, names]) => `${s}: ${names.join("; ")}`).join("\n") || "(none)"}

Zoom ${source}:
${content}`;
}
