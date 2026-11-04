#!/usr/bin/env node
// TestFlight crashes — poll App Store Connect for new beta crash submissions on
// the Jori iOS app and surface any unseen ones. Dedups via hum-cache by
// submission id. Fail-closed: any error → null.
//
// Off until configured: the app is agent/local/config/testflight-crashes.json
// { app_id } (the App Store Connect app id), the API key is the one bin/asc-api
// uses (agent/local/config/asc-api.json { key_id, issuer_id, key_path }).

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { readStdinJson, emit, emitNull, emitNoop, stampRun, readCache, writeCache, localConfig } from "./_common.mjs";

const { situation: sit, context } = await readStdinJson(); void sit; void context;

const TOPIC = "testflight_crashes";
const { installTools } = createRequire(import.meta.url)("../../../lib/root.cjs");
const APP_ID = String(localConfig("testflight-crashes", { app_id: "" }).app_id || "");
const ASC = localConfig("asc-api", { key_id: "", issuer_id: "", key_path: "credentials/asc-key.p8" });
const KEY_PATH = process.env.ASC_KEY_PATH || installTools(ASC.key_path);
const KEY_ID = process.env.ASC_KEY_ID || ASC.key_id;
const ISSUER_ID = process.env.ASC_ISSUER_ID || ASC.issuer_id;
const BASE = "https://api.appstoreconnect.apple.com/v1";

if (!APP_ID || !KEY_ID || !ISSUER_ID) {
  stampRun(TOPIC, false);
  emitNoop("not configured (testflight-crashes app_id / asc-api key)");
  process.exit(0);
}

function jwt() {
  const key = fs.readFileSync(KEY_PATH, "utf8");
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: "ES256", kid: KEY_ID, typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ iss: ISSUER_ID, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" })).toString("base64url");
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${sig.toString("base64url")}`;
}

async function asc(p) {
  const res = await fetch(BASE + p, { headers: { Authorization: `Bearer ${jwt()}` } });
  if (!res.ok) throw new Error(`asc ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

let submissions;
try {
  const data = await asc(`/apps/${APP_ID}/betaFeedbackCrashSubmissions?limit=20&sort=-createdDate`);
  submissions = data.data || [];
} catch (e) {
  stampRun(TOPIC, false);
  emitNull(`asc fetch failed: ${e.message}`);
  process.exit(0);
}

const cache = readCache(TOPIC) || { seen_ids: [] };
const seen = new Set(cache.seen_ids || []);
const fresh = submissions.filter(s => !seen.has(s.id));

// Always refresh seen ids (cap 500) so cache stays current even when nothing new.
const newSeen = [...submissions.map(s => s.id), ...(cache.seen_ids || [])].slice(0, 500);
writeCache(TOPIC, { seen_ids: Array.from(new Set(newSeen)) });

if (!fresh.length) {
  stampRun(TOPIC, false);
  emitNoop("no new crash submissions");
  process.exit(0);
}

// Try to pull the first line of the crash log for the newest unseen submission.
const newest = fresh[0];
let excerpt = "";
try {
  const log = await asc(`/betaFeedbackCrashSubmissions/${newest.id}/crashLog`);
  const text = log?.data?.attributes?.logText || "";
  const excType = text.match(/Exception Type:\s+([^\n]+)/)?.[1]?.trim();
  const termReason = text.match(/Termination Reason:\s+([^\n]+)/)?.[1]?.trim();
  const topFrame = text.match(/\n\d+\s+Jori\s+\S+\s+([^\n]+)/)?.[1]?.trim();
  excerpt = [excType, termReason, topFrame].filter(Boolean).join(" · ");
} catch (e) {
  excerpt = `(log fetch failed: ${e.message})`;
}

const a = newest.attributes || {};
const count = fresh.length;
const header = count === 1
  ? `New TestFlight crash (${a.deviceModel} iOS ${a.osVersion})`
  : `${count} new TestFlight crashes, most recent: ${a.deviceModel} iOS ${a.osVersion}`;

stampRun(TOPIC, true);
emit({
  topic: TOPIC,
  signal: `${header}${excerpt ? " — " + excerpt : ""}. Crash ID ${newest.id.slice(0, 8)}… at ${a.createdDate}.`,
  urgency: 0.7,
  freshness_min: 0,
  dedup_key: `testflight_crashes:${newest.id}`,
  supporting_data: {
    new_count: count,
    newest: {
      id: newest.id,
      createdDate: a.createdDate,
      device: a.deviceModel,
      os: a.osVersion,
      comment: (a.comment || "").trim(),
      bundleId: a.buildBundleId,
      diskBytesAvailable: a.diskBytesAvailable,
      batteryPercentage: a.batteryPercentage,
    },
    excerpt,
  },
});
