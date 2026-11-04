#!/usr/bin/env node
// location-confirm-phrase — turn a structured location-ask payload into a
// short, natural-language message for the phone channel using local Gemma.
//
// Reads the ask JSON on stdin, prints the message to stdout. Falls back to a
// minimal templated string on Ollama failure (sub-second timeout). Designed
// for cron use — no Anthropic SDK, no API key, zero billed tokens.
//
//   echo '<ask json>' | location-confirm-phrase.mjs
//
// Input shape (from `bin/location-current-stop` + ask_id stamping):
//   {
//     ask_id, duration_min, centroid:{lat,lon},
//     primary:{name, primary_type, distance_m, ...},
//     alternatives:[{name, primary_type, ...}, ...],
//     photo_count, ...
//   }
//
// Output shape: a single string ≤ ~280 chars that:
//   - Reads conversationally ("Looks like you're at … or maybe …")
//   - Lists the candidates inline (so reply-by-name works)
//   - Includes the ask_id at the end in parens (so the chat-agent can resolve replies)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localLlmChat } from "../lib/local-llm.mjs";
import { askTiming } from "../lib/location-ask-queue.mjs";
import { installTools } from "../lib/root.cjs";
import { instance } from "../lib/instance.cjs";

const OWNER = instance().owner_name;

// A dwell drained from the quiet-window backlog can be an hour or more old by
// the time it is phrased; the model is told "you've been at the same spot",
// so without this it reads as though the user were still sitting there. Code
// decides it is late (askTiming, the shared bound) and prepends the time;
// the model's sentence is left untouched.
function userTz() {
  try {
    return JSON.parse(fs.readFileSync(installTools("data", "user-timezone.json"), "utf8")).timezone || instance().tz;
  } catch { return instance().tz; }
}

function lateLead(ask) {
  const tz = userTz();
  const t = askTiming({ stop_started_at: ask.first_sample_ts, stop_ended_at: ask.last_sample_ts || ask.first_sample_ts }, { tz });
  return t.verdict === "late" ? t.lead : "";
}

async function main() {
  const stdin = await readAll(process.stdin);
  let ask;
  try {
    ask = JSON.parse(stdin);
  } catch (e) {
    process.stderr.write(`bad JSON on stdin: ${e.message}\n`);
    process.exit(2);
  }

  const candidates = [ask.primary, ...(ask.alternatives || [])].filter(Boolean);
  if (candidates.length === 0) {
    process.stdout.write(
      lateLead(ask) +
      `You've been at one spot for ${Math.round(ask.duration_min)} min ` +
      `and I can't tell where — what's the place? (${ask.ask_id})`
    );
    return;
  }

  // Lead with ONE guess and what the user is probably doing there, as a yes/no
  // ("Are you at Boutique Coffee right for your morning coffee?"). Guessing
  // from GPS is the point; the user's yes or correction is what makes it true. A street address from the reverse geocoder is not a guess
  // at a venue, so it is never offered as one.
  const venues = candidates.filter(c => c.source !== "reverse_geocode" && c.source !== "coordinate");
  const where = candidates.find(c => c.source === "reverse_geocode");
  const lead = venues[0];
  const alts = venues.slice(1, 3);
  const localTime = new Date().toLocaleTimeString("en-US", { timeZone: userTz(), hour: "numeric", minute: "2-digit" });

  if (!lead) {
    const near = where ? ` near ${where.name}` : "";
    process.stdout.write(lateLead(ask) +
      `You've been${near} for about ${Math.round(ask.duration_min)} min — where are you, and what are you up to? (${ask.ask_id})\n`);
    return;
  }

  const ty = c => (c.primary_type ? ` (${c.primary_type.replace(/_/g, " ")})` : "");
  const system =
    `You write one short question for ${OWNER}'s phone (below: "the user"). Lead with the single best guess as a yes/no ` +
    "question that names the place AND what the user is most likely doing there, inferred from the kind of " +
    "place and the local time — e.g. \"Are you at Boutique Coffee for your morning coffee?\". " +
    "If there are other options, add them briefly after (\"…or Café Noir?\"). Casual, one or two sentences. " +
    "Don't mention coordinates or minutes. " +
    "Plain text, no markdown, no emoji, ≤240 chars.";
  const user =
    `Local time: ${localTime}. The user has been here about ${Math.round(ask.duration_min)} minutes.\n` +
    `Best guess: ${lead.name}${ty(lead)}\n` +
    (alts.length ? `Other options: ${alts.map(c => c.name + ty(c)).join("; ")}\n` : "") +
    "";

  let out = "";
  try {
    out = await localLlmChat({
      system,
      user,
      maxTokens: 200,
      timeoutMs: 8000,
      think: false, // keep the budget for content, not reasoning preamble
    });
  } catch (e) {
    process.stderr.write(`gemma error: ${e.message}\n`);
  }

  // The ask_id is appended in code — a 1B model dropping it used to discard
  // the whole sentence for the template. Fall back only when it names no guess.
  out = (out || "").trim().split("\n")[0].trim();
  if (!out || out.length > 300 || !out.includes(lead.name)) {
    const or = alts.length ? ` Or ${alts.map(c => c.name).join(" / ")}?` : "";
    out = `Are you at ${lead.name}?${or}`;
  }
  out = `${out} (${ask.ask_id})`;
  process.stdout.write(lateLead(ask) + out + "\n");
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", c => (buf += c));
    stream.on("end", () => resolve(buf));
    stream.on("error", reject);
  });
}

main().catch(e => {
  process.stderr.write(`${e.stack || e.message}\n`);
  process.exit(1);
});
