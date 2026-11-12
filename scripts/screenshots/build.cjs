#!/usr/bin/env node
// scripts/screenshots/build.cjs — the simulated screenshots on getjori.ai and in
// the README (site/img/*.png).
//
// Everything shown is made up: a sample person (Sam), their partner (Jordan) and
// their dog (Biscuit). No real memory, message or account is read.
//
// The wiki shots come from the wiki's own renderer (lib/wiki-render.js +
// lib/wiki-portal.js), fed sample pages, so they show the real layout and CSS.
// The app shots are HTML mockups drawn with the companion app's palette
// (apps/companion/Jori/DesignSystem.swift: cobalt = you, slate = Jori,
// gold = "Jori is waiting on you").
//
// Usage: node scripts/screenshots/build.cjs [--out site/img]   rebuild the PNGs
//        node scripts/screenshots/build.cjs --check             exit 1 if stale
// Needs Google Chrome (headless) to rebuild; --check needs only node. Under a
// sandbox that blocks Chrome, run it unsandboxed.
//
// Staleness: every mockup page is generated here, deterministically (the clock
// is frozen at FIXED_NOW), so a hash of the generated HTML says whether the
// images still match the code. The hash is kept in site/img/.stamp; the
// pre-push hook (githooks/pre-push) runs --check and rebuilds when it differs,
// e.g. after a change to lib/wiki-render.js, lib/wiki-portal.js, the app's
// palette in DesignSystem.swift, or this file.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const render = require(path.join(ROOT, "lib/wiki-render.js"));
const portal = require(path.join(ROOT, "lib/wiki-portal.js"));

const outArg = process.argv.indexOf("--out");
const OUT = path.resolve(ROOT, outArg > 0 ? process.argv[outArg + 1] : "site/img");
const CHECK = process.argv.includes("--check");
const STAMP = path.join(ROOT, "site/img/.stamp");
const WORK = CHECK ? null : fs.mkdtempSync(path.join(os.tmpdir(), "jori-shots-"));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

portal.setAssistant("Jori", "it/its");

// ── Sample memory ───────────────────────────────────────────────────────────

// A frozen clock, so the pages (relative times, the days strip) are the same on
// every run and the stamp only changes when the code does.
const FIXED_NOW = Date.parse("2026-11-05T14:00:00Z");
Date.now = () => FIXED_NOW;
const now = FIXED_NOW;
const ago = (mins) => new Date(now - mins * 60000).toISOString();
const P = (id, type, title, description, mins, extra = {}) => ({ id, type, title, description, status: "active", updated_at: ago(mins), ...extra });

const pages = [
  P("user_sam", "user", "Sam Ellis", "Product designer in Brooklyn. Early riser, walks Biscuit twice a day.", 300, { pinned: true }),
  P("user_jordan", "user", "Jordan Park", "Sam's partner. Teaches high-school chemistry. Birthday March 21.", 50, { pinned: true }),
  P("user_biscuit", "user", "Biscuit", "Four-year-old beagle mix. Fine alone 9 to 3.", 2000),
  P("user_maya", "user", "Maya Ellis", "Sam's sister in Chicago. Two kids, Leo and Ada.", 9000),
  P("user_dr_okafor", "user", "Dr. Okafor", "Dentist on Court Street. Cleanings every six months.", 6000),
  P("user_food_taste", "user", "Food we love", "Small kitchens, seafood, no tasting menus. Jordan won't eat oysters.", 400, { pinned: true }),
  P("feedback_morning_brief", "feedback", "Morning brief, short", "One line per item, weather first, nothing before 7 AM.", 12000, { pinned: true }),
  P("feedback_purchases", "feedback", "Purchases need Face ID", "Anything that spends money waits for an approval on the phone.", 15000, { pinned: true }),
  P("feedback_no_reservations", "feedback", "Walk-in places first", "Skip restaurants that need a booking weeks out.", 20000),
  P("feedback_quiet_hours", "feedback", "Quiet hours", "Nothing non-urgent between 10 PM and 7 AM.", 22000),
  P("project_lisbon_trip", "project", "Lisbon in March", "Mar 13 to 22, with Jordan. Fares watched, two neighborhoods shortlisted.", 35, { pinned: true }),
  P("project_kitchen_reno", "project", "Kitchen refresh", "Three contractor quotes in, waiting on the countertop sample.", 3000),
  P("project_half_marathon", "project", "Spring half marathon", "Training plan, 12 weeks, long runs on Sundays.", 5000),
  P("project_jordan_gift", "project", "Jordan's birthday gift", "Ideas so far, budget around $200.", 20),
  P("project_taxes_2026", "project", "2026 taxes", "Documents collected so far, the accountant's checklist.", 8000),
  P("reference_home_wifi", "reference", "Home network", "Router, mesh nodes and what's plugged in where.", 18000),
  P("reference_building", "reference", "Our building", "Super's number, laundry hours, package room.", 25000),
  P("reference_cards", "reference", "Cards & accounts", "Which card earns what, and which one pays the bills.", 7000),
  P("reference_doctors", "reference", "Doctors", "Who we see, for what, and when the next visit is due.", 9500),
  P("reference_ceramics_studio", "reference", "Clay Corner studio", "Gowanus. Two-person wheel classes on Saturdays.", 25),
  P("reference_tap_fares", "reference", "Lisbon fares", "JFK to LIS, price history since October.", 40),
  P("reference_shows", "reference", "Shows we're watching", "And the ones worth starting next.", 3500),
];
// Day pages: most days for the last six months.
const dayTitles = ["Rain walk, ramen, early night", "Dentist, then the long run", "Maya called about Thanksgiving", "Kitchen quotes came in", "Lisbon fares dipped", "Saturday at the farmers market", "Movie night at home", "Long run in Prospect Park"];
const today = new Date(now);
for (let back = 1; back < 175; back++) {
  if ((back * 7) % 11 === 3) continue; // a few gaps, like real life
  const d = new Date(today.getTime() - back * 86400000);
  const id = `day_${d.toISOString().slice(0, 10)}`;
  pages.push(P(id, "day", dayTitles[back % dayTitles.length], back === 1 ? "Dentist at 9:30, rain from 4, Jordan's gift shortlist started." : back === 2 ? "Long run, 11 miles. Kitchen contractor #3 came by." : "Walked Biscuit, worked from home, cooked in.", back * 1440));
}

const portalConfig = {
  topics: [
    { slug: "people", name: "People", blurb: "Family, friends and the people who help us.", ids: ["user_sam", "user_jordan", "user_biscuit", "user_maya", "user_dr_okafor"], featured: ["user_jordan", "user_sam", "user_maya", "user_biscuit"] },
    { slug: "plans", name: "Plans & projects", blurb: "What's in motion right now.", prefixes: ["project_"], featured: ["project_lisbon_trip", "project_jordan_gift", "project_kitchen_reno", "project_half_marathon"] },
    { slug: "rules", name: "How we like things", blurb: "Preferences Jori follows without being told twice.", ids: ["feedback_morning_brief", "feedback_purchases", "feedback_no_reservations", "feedback_quiet_hours", "user_food_taste"], featured: ["user_food_taste", "feedback_purchases", "feedback_morning_brief", "feedback_quiet_hours"] },
    { slug: "reference", name: "Reference", blurb: "The facts worth keeping in one place.", prefixes: ["reference_"], featured: ["reference_home_wifi", "reference_building", "reference_cards", "reference_doctors"] },
  ],
};

function wikiDoc(title, body, { dark = false, active = "home", q = "", who = "sam@example.com" } = {}) {
  let html = render.shell(title, body, { label: who, scoped: false }, { active, q, control: true });
  html = html.replace('<link rel="stylesheet" href="/style.css">', `<style>${render.CSS}</style>`);
  if (dark) html = html.replace('<html lang="en">', '<html lang="en" data-theme="dark">');
  return html;
}

// 1 · Wiki home
const resolved = portal.resolvePortal({ pages, config: portalConfig, fullView: true });
const wikiHome = wikiDoc("Home", portal.homeBody({ pages, portal: resolved, fullView: true }));

// 2 · Wiki answer
const sources = [
  { n: 1, id: "project_jordan_gift", title: "Jordan's birthday gift" },
  { n: 2, id: "reference_ceramics_studio", title: "Clay Corner studio" },
  { n: 3, id: "user_jordan", title: "Jordan Park" },
];
const query = "What should I get Jordan for their birthday?";
let answerBody = portal.searchBody({
  query,
  results: [
    { id: "project_jordan_gift", type: "project", title: "Jordan's birthday gift", how: "best match", snippetHtml: "Ideas so far: a <mark>ceramics class for two</mark>, the Blue Note vinyl box set, a weekend upstate. Budget around $200." },
    { id: "reference_ceramics_studio", type: "reference", title: "Clay Corner studio", how: "linked", snippetHtml: "Gowanus. <mark>Two-person wheel classes</mark> on Saturdays, $180 for a 4-week course. Jordan stopped in front of it twice in October." },
    { id: "user_jordan", type: "user", title: "Jordan Park", how: "about", snippetHtml: "Sam's partner. Teaches chemistry. <mark>Birthday March 21.</mark> Loves making things by hand; already has most of the records they want." },
    { id: "day_2026-10-18", type: "day", title: "Saturday at the farmers market", how: "mentions", snippetHtml: "Walked past Clay Corner on the way back; Jordan said <mark>“we should do that sometime.”</mark>" },
  ],
  connected: [
    { id: "project_lisbon_trip", title: "Lisbon in March", via: "the same week", description: "You fly out Mar 13, so the class would start after you're back." },
  ],
});
const answer = portal.answerHtml({
  answer: "The ceramics class for two at Clay Corner [1][2]. Jordan stopped in front of the studio twice this fall and said you should try it together [2], and they already have most of the records they want, which rules out the box set [3]. The 4-week course is $180, inside your budget, and the next one starts March 28, a week after you're back from Lisbon.",
  sources,
});
answerBody = answerBody.replace(/<section class="answer pending"[\s\S]*?<\/section>/, `<section class="answer" aria-live="polite"><p class="who-says">Jori</p><div class="body">${answer}</div></section>`); // lang-regex-ok: swaps the pending answer panel (HTML structure) for the filled one
const wikiAnswer = wikiDoc("Ask", answerBody, { active: null, q: query });

// 3 · Wiki page (dark)
const md = `Ten days in Lisbon with Jordan, **March 13 to 22**. Flights watched daily; Jori books when the fare drops under $1,300 for two and asks first.

## Flights
| | Outbound | Return |
|---|---|---|
| Date | Fri Mar 13 | Sun Mar 22 |
| Route | JFK → LIS, TAP 202 | LIS → JFK, TAP 201 |
| Seats | Row 14, two aisles | Row 14, two aisles |
| Best fare seen | $1,284 for two | |

## Where to stay
- **Príncipe Real**: quiet, walkable, close to the gardens. First choice.
- **Alfama**: more charm, more hills. Fine for two nights at the end.

## Eat
Small kitchens, seafood, walk-ins (see [[user_food_taste]] and [[feedback_no_reservations]]). No oyster bars: Jordan won't eat them.

## Before we go
- Biscuit stays with Maya ([[user_maya]]), drop-off Thursday evening.
- Tell the building about the packages ([[reference_building]]).
- Jordan's birthday falls on the 21st, in Lisbon ([[project_jordan_gift]]).`;
const lisbon = pages.find((p) => p.id === "project_lisbon_trip");
const titles = new Map(pages.map((p) => [p.id, p.title]));
const fwd = ["user_food_taste", "feedback_no_reservations", "user_maya", "reference_building", "project_jordan_gift", "reference_tap_fares"].map((dst_id) => ({ dst_id }));
const back = ["user_jordan", "day_" + new Date(now - 86400000).toISOString().slice(0, 10), "reference_tap_fares", "project_jordan_gift"].map((src_id) => ({ src_id }));
const lisbonBody = portal.pageBody({
  page: { ...lisbon, last_verified_at: "today" },
  bodyHtml: render.renderMarkdown(md, { resolveLink: () => true, labelFor: (id) => titles.get(id) }),
  fwd, back, titles, revCount: 14, connected: false,
  topic: resolved.topics.find((t) => t.slug === "plans"),
});
const wikiPage = wikiDoc("Lisbon in March", lisbonBody, { dark: true, active: null });

// ── App mockups ─────────────────────────────────────────────────────────────

// The app's light-mode colours, read from DesignSystem.swift so a palette
// change there reaches the mockups (and the stamp). Falls back to the values
// below if a name is missing.
function appPalette() {
  const want = { cobalt: "#2F5BD3", staff: "#D98E12", staffWash: "#FFF3D9", staffInk: "#8F5600", slate: "#EEF0F4", slateRaised: "#E3E6EC", hairline: "#D7DBE3", confirmed: "#1F8F4E", deny: "#D93A33" };
  let src = "";
  try { src = fs.readFileSync(path.join(ROOT, "apps/companion/Jori/DesignSystem.swift"), "utf8"); } catch {}
  for (const name of Object.keys(want)) {
    const m = src.match(new RegExp(`static let ${name} = dynamic\\(light: 0x([0-9A-Fa-f]{6})`)); // lang-regex-ok: reads a hex literal out of Swift source (structure)
    if (m) want[name] = `#${m[1].toUpperCase()}`;
  }
  return Object.entries(want).map(([k, v]) => `--${k === "confirmed" ? "ok" : k}:${v};`).join(" ");
}

const APP_CSS = `
:root { ${appPalette()} --canvas:#FFFFFF; --grouped:#F2F2F7; --card:#FFFFFF; --ink:#111318; --ink2:#6B7280; }
* { box-sizing:border-box; margin:0; }
html, body { background:transparent; }
body { font:17px/1.35 -apple-system, system-ui, "SF Pro Text", sans-serif; color:var(--ink); -webkit-font-smoothing:antialiased; display:flex; gap:56px; padding:90px; }
.phone { width:430px; height:880px; border-radius:68px; background:#0b0c0f; padding:14px; box-shadow:0 40px 80px rgba(16,24,40,.28), 0 0 0 2px #2a2d33 inset; position:relative; flex:none; }
.screen { width:100%; height:100%; border-radius:55px; overflow:hidden; background:var(--canvas); position:relative; display:flex; flex-direction:column; }
.island { position:absolute; top:11px; left:50%; transform:translateX(-50%); width:124px; height:36px; border-radius:20px; background:#000; z-index:20; }
.status { height:54px; display:flex; align-items:center; justify-content:space-between; padding:6px 34px 0 44px; font-weight:600; font-size:17px; flex:none; }
.status .r { display:flex; gap:7px; align-items:center; }
.nav { display:flex; align-items:center; justify-content:space-between; padding:4px 18px 10px; border-bottom:1px solid var(--hairline); flex:none; }
.nav .ttl { display:flex; flex-direction:column; align-items:center; }
.nav .ttl b { font:600 19px/1.1 ui-serif, "New York", Georgia, serif; display:flex; align-items:center; gap:6px; }
.nav .ttl span { font-size:12px; color:var(--ink2); display:flex; align-items:center; gap:5px; }
.nav .ttl span::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--ok); }
.ico { width:36px; height:36px; border-radius:50%; background:var(--slate); display:grid; place-items:center; color:var(--cobalt); }
.av { width:30px; height:30px; border-radius:50%; flex:none; }
.thread { flex:1; padding:10px 14px 0; display:flex; flex-direction:column; gap:3px; overflow:hidden; }
.sep { text-align:center; font-size:12px; color:var(--ink2); margin:8px 0 6px; font-weight:500; }
.row { display:flex; align-items:flex-end; gap:8px; }
.row.me { justify-content:flex-end; }
.b { max-width:320px; padding:9px 14px; border-radius:20px; font-size:16px; line-height:1.38; }
.jori .b { background:var(--slate); }
.jori .b.j1 { border-bottom-left-radius:6px; }
.jori .b.j2 { border-top-left-radius:6px; }
.me .b { background:var(--cobalt); color:#fff; border-bottom-right-radius:6px; }
.gap { height:10px; }
.b ul { padding-left:0; list-style:none; margin-top:6px; display:grid; gap:5px; }
.b li { display:flex; gap:8px; }
.b li i { font-style:normal; width:20px; flex:none; text-align:center; }
.spacer { width:30px; flex:none; }
.card { background:var(--card); border:1px solid var(--hairline); border-radius:16px; padding:12px 12px 8px; margin-top:8px; }
.wait { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--staffInk); background:var(--staffWash); border-radius:999px; padding:4px 10px; margin-bottom:8px; }
.opt { display:flex; gap:10px; align-items:flex-start; padding:9px 4px; border-top:1px solid var(--hairline); }
.opt:first-of-type { border-top:0; }
.opt .n { width:22px; height:22px; border-radius:50%; display:grid; place-items:center; font-size:12px; font-weight:700; color:var(--ink2); background:rgba(0,0,0,.07); flex:none; }
.opt.rec .n { color:var(--staffInk); background:rgba(217,142,18,.22); }
.opt .l { font-size:15px; font-weight:500; }
.opt .l em { font-style:normal; font-size:12px; font-weight:600; color:var(--staffInk); margin-left:6px; }
.opt .d { font-size:12.5px; color:var(--ink2); margin-top:1px; }
.react { font-size:12px; color:var(--ink2); margin:2px 0 0 38px; }
.composer { display:flex; align-items:center; gap:10px; padding:10px 14px 30px; flex:none; }
.composer .plus { width:36px; height:36px; border-radius:50%; background:var(--slate); display:grid; place-items:center; color:var(--ink2); font-size:22px; }
.composer .field { flex:1; height:38px; border-radius:19px; border:1px solid var(--hairline); padding:0 14px; display:flex; align-items:center; color:#9aa1ad; font-size:16px; }
.composer .mic { width:36px; height:36px; border-radius:50%; background:var(--cobalt); display:grid; place-items:center; }
/* Approval sheet */
.dim { position:absolute; inset:0; background:rgba(10,14,22,.38); z-index:5; }
.sheet { position:absolute; left:0; right:0; bottom:0; top:96px; background:var(--grouped); border-radius:34px 34px 0 0; z-index:6; display:flex; flex-direction:column; }
.grab { width:38px; height:5px; border-radius:3px; background:#c7cad1; margin:8px auto 0; }
.head { display:flex; flex-direction:column; align-items:center; gap:6px; padding:18px 20px 6px; }
.cart { width:52px; height:52px; border-radius:50%; background:rgba(217,142,18,.18); display:grid; place-items:center; color:var(--staffInk); }
.head h2 { font-size:20px; font-weight:600; }
.head .m { font-size:15px; color:var(--ink2); }
.head .amt { font:700 44px/1.05 ui-rounded, -apple-system, system-ui; letter-spacing:-.01em; font-variant-numeric:tabular-nums; }
.exp { font-size:12px; font-weight:600; color:var(--staffInk); background:var(--staffWash); padding:4px 10px; border-radius:999px; }
.sections { padding:6px 18px 0; overflow:hidden; flex:1; }
.sec h3 { font-size:12.5px; font-weight:500; color:var(--ink2); text-transform:uppercase; letter-spacing:.02em; margin:14px 14px 6px; }
.grp { background:var(--card); border-radius:12px; }
.grp .li { display:flex; justify-content:space-between; gap:10px; padding:11px 14px; font-size:15.5px; border-top:1px solid var(--hairline); }
.grp .li:first-child { border-top:0; }
.grp .li .q { color:var(--ink2); margin-right:8px; font-variant-numeric:tabular-nums; }
.grp .li b { font-weight:600; }
.grp .li .num { font-variant-numeric:tabular-nums; }
.grp .li.why { display:block; color:var(--ink); line-height:1.4; }
.btns { display:flex; gap:12px; padding:14px 20px 34px; }
.btns div { flex:1; height:52px; border-radius:16px; display:flex; align-items:center; justify-content:center; gap:8px; font-weight:600; font-size:17px; }
.btns .no { background:var(--card); color:var(--deny); border:1px solid var(--hairline); }
.btns .yes { background:var(--cobalt); color:#fff; flex:1.5; }
/* Work scenes */
.plan { margin-top:8px; display:grid; gap:7px; }
.plan div { display:grid; grid-template-columns:44px 1fr; gap:8px; font-size:15px; line-height:1.35; }
.plan div b { font-weight:600; font-variant-numeric:tabular-nums; color:var(--ink2); font-size:13px; padding-top:1px; }
.place { display:flex; gap:10px; align-items:flex-start; background:var(--card); border:1px solid var(--hairline); border-radius:12px; padding:9px 11px; margin-top:7px; }
.place .pic { width:40px; height:40px; border-radius:8px; flex:none; display:grid; place-items:center; font-size:20px; }
.place b { display:block; font-size:14.5px; font-weight:600; }
.place span { display:block; font-size:12.5px; color:var(--ink2); line-height:1.35; }
.home { background:var(--card); border:1px solid var(--hairline); border-radius:12px; margin-top:8px; }
.home div { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-top:1px solid var(--hairline); font-size:15px; }
.home div:first-child { border-top:0; }
.home .ok { color:var(--ok); font-weight:600; font-size:14px; }
.home .warn { color:var(--staffInk); font-weight:600; font-size:14px; }
.linkcard { display:flex; gap:10px; align-items:center; background:var(--card); border:1px solid var(--hairline); border-radius:12px; padding:9px 11px; margin-top:8px; }
.linkcard .ic { width:34px; height:34px; border-radius:8px; background:#E8ECFB; color:#2F45C9; display:grid; place-items:center; font:600 15px ui-serif, Georgia, serif; flex:none; }
.linkcard b { display:block; font-size:14px; font-weight:600; }
.linkcard span { display:block; font-size:12px; color:var(--ink2); }
.draft { background:var(--card); border:1px solid var(--hairline); border-radius:12px; padding:9px 12px; margin-top:8px; font-size:14px; line-height:1.4; }
.draft .h { font-size:12px; color:var(--ink2); padding-bottom:6px; margin-bottom:6px; border-bottom:1px solid var(--hairline); }
.draft .h b { color:var(--ink); font-weight:600; }
/* The app as it is now: a conversation per person (or group), a header naming
   who you are talking to, a team list with photos and one red badge. */
.nav .who { display:flex; align-items:center; gap:9px; }
.nav .who .av, .nav .who img { width:34px; height:34px; border-radius:50%; object-fit:cover; flex:none; }
.nav .who .t b { display:block; font:600 17px/1.15 -apple-system, system-ui, sans-serif; }
.nav .who .t span { display:block; font-size:12px; color:var(--ink2); }
.nav .stack { position:relative; width:38px; height:34px; flex:none; }
.nav .stack img { position:absolute; width:24px; height:24px; border:1.5px solid #fff; }
.nav .stack img:first-child { left:0; top:0; } .nav .stack img:last-child { right:0; bottom:0; }
.lhead { display:flex; justify-content:space-between; align-items:center; padding:6px 20px 4px; }
.lhead b { font:700 30px/1.1 -apple-system, system-ui, sans-serif; }
.clist { flex:1; overflow:hidden; }
.crow { display:flex; gap:12px; padding:11px 20px; border-bottom:1px solid var(--hairline); }
.crow .ph { width:46px; height:46px; border-radius:50%; flex:none; object-fit:cover; }
.crow .grp { position:relative; width:46px; height:46px; flex:none; }
.crow .grp img { position:absolute; width:32px; height:32px; border-radius:50%; border:1.5px solid #fff; object-fit:cover; }
.crow .grp img:first-child { left:0; top:0; } .crow .grp img:last-child { right:0; bottom:0; }
.crow .c { flex:1; min-width:0; }
.crow .top { display:flex; align-items:baseline; gap:6px; }
.crow .top b { font-size:16px; font-weight:600; white-space:nowrap; }
.crow .top i { font-style:normal; color:var(--ink2); font-size:13.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.crow .top time { margin-left:auto; color:var(--ink2); font-size:13px; flex:none; }
.crow .bot { display:flex; gap:8px; align-items:flex-start; margin-top:2px; }
.crow .bot span { flex:1; color:var(--ink2); font-size:14px; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.crow .badge { background:#FF3B30; color:#fff; font:700 11px/16px -apple-system, system-ui; min-width:18px; height:18px; border-radius:9px; text-align:center; padding:1px 5px 0; flex:none; }
.from { font-size:12px; color:var(--ink2); margin:0 0 3px 44px; font-weight:600; }
.row.jori img.av { object-fit:cover; }
.tbar { display:flex; justify-content:space-between; padding:2px 16px 0; }
.pins { display:grid; grid-template-columns:repeat(3, 1fr); gap:18px; padding:10px 20px 14px; border-bottom:1px solid var(--hairline); }
.pin { display:flex; flex-direction:column; align-items:center; gap:6px; }
.pin .pc { position:relative; padding:3px; }
.pin .pc img, .pin .pc svg { display:block; width:54px; height:54px; border-radius:50%; object-fit:cover; }
.pin .pc .badge { position:absolute; top:-2px; right:-2px; background:#FF3B30; color:#fff; font:700 11px/16px -apple-system, system-ui; min-width:18px; height:18px; border-radius:9px; text-align:center; padding:1px 5px 0; }
.pin b { font-size:10px; font-weight:500; line-height:1.15; }
.pin span { font-size:9px; color:var(--ink2); line-height:1.15; margin-top:-5px; }
.row.me .mention { color:#fff; font-weight:700; background:rgba(255,255,255,.22); border-radius:5px; padding:0 4px; }
`;

const ICON_FACE = `<svg width="30" height="30" viewBox="0 0 30 30"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2B54B8"/><stop offset="1" stop-color="#0A1640"/></linearGradient></defs><circle cx="15" cy="15" r="15" fill="url(#g)"/><rect x="8" y="11.5" width="5" height="7" rx="2.5" fill="#2AF2D4"/><rect x="17" y="11.5" width="5" height="7" rx="2.5" fill="#2AF2D4"/></svg>`;
// In the app Jori is a persona with a photo (jori_team.avatar_url); the phone
// screens show it in the header, beside its messages and in the list.
const JORI_PHOTO = `data:image/jpeg;base64,${fs.readFileSync(path.join(__dirname, "team", "jori.jpg")).toString("base64")}`; // kernel-closure-ok: the demo headshot ships in the kernel beside this script
const AV = `<img class="av" src="${JORI_PHOTO}">`;
const STATUS = `<div class="status"><span>9:41</span><span class="r"><svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1" fill="#111"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="#111"/><rect x="10" y="3" width="3" height="9" rx="1" fill="#111"/><rect x="15" y="0" width="3" height="12" rx="1" fill="#111"/></svg><svg width="17" height="12" viewBox="0 0 17 12"><path d="M8.5 2.2c2.4 0 4.6.9 6.2 2.5l1.2-1.2C13.9 1.4 11.3.4 8.5.4S3.1 1.4 1.1 3.5l1.2 1.2C3.9 3.1 6.1 2.2 8.5 2.2Zm0 3.6c1.4 0 2.7.5 3.7 1.5l1.2-1.2C12.1 4.8 10.4 4 8.5 4S4.9 4.8 3.6 6.1l1.2 1.2c1-1 2.3-1.5 3.7-1.5Zm0 3.6c.5 0 1 .2 1.3.6L8.5 11.3 7.2 10c.3-.4.8-.6 1.3-.6Z" fill="#111"/></svg><svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="#111" opacity=".4"/><rect x="2" y="2" width="18" height="9" rx="2" fill="#111"/><rect x="24.5" y="4.5" width="1.5" height="4" rx=".75" fill="#111" opacity=".4"/></svg></span></div>`;
// The header of a conversation: back, who you're talking to (photo, name,
// role), and the people in it.
const BACK = `<div class="ico"><svg width="18" height="18" viewBox="0 0 18 18"><path d="M11.5 3 5.5 9l6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
const PEOPLE = `<div class="ico"><svg width="20" height="18" viewBox="0 0 20 18"><circle cx="7" cy="6" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M1.5 16c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="14" cy="6.5" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M14.5 11.4c2 .3 3.4 1.7 3.9 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>`;
const navFor = (avatarHtml, name, title) => `<div class="nav">${BACK}<div class="who">${avatarHtml}<div class="t"><b>${name}</b><span>${title}</span></div></div>${PEOPLE}</div>`;
// As the app titles the coordinator (lib/org.cjs soloTitle): alone, as in a
// personal install, it is the Personal Assistant; with a team (work) it is the
// Chief of Staff. Personal scenes use NAV; work scenes swap in NAV_COS.
const JORI_HEAD = `<img src="${JORI_PHOTO}">`;
const NAV = navFor(JORI_HEAD, "Jori", "Personal Assistant");
const NAV_COS = navFor(JORI_HEAD, "Jori", "Chief of Staff");
const composer = (to = "Jori") => `<div class="composer"><div class="plus">+</div><div class="field">Message ${to}</div><div class="mic"><svg width="16" height="18" viewBox="0 0 16 18"><rect x="5" y="1" width="6" height="10" rx="3" fill="#fff"/><path d="M2.5 8.5a5.5 5.5 0 0 0 11 0M8 14v3" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg></div></div>`;
const COMPOSER = composer();
const phone = (inner) => `<div class="phone"><div class="island"></div><div class="screen">${STATUS}${inner}</div></div>`;

const chatThread = `${NAV}<div class="thread">
<div class="sep">Today 7:02 AM</div>
<div class="row jori"><div class="spacer"></div><div class="b j1" style="max-width:330px"><b>Good morning, Sam.</b> Thursday at a glance:
<ul>
<li><i>🌧️</i><span>Rain from 4 PM. Walk Biscuit before then.</span></li>
<li><i>✈️</i><span>Lisbon fare dropped $142 overnight.</span></li>
<li><i>🎂</i><span>Jordan's birthday in 3 weeks. No gift yet.</span></li>
</ul></div></div>
<div class="gap"></div>
<div class="row me"><div class="b">Book the Lisbon flights. Same seats as last time.</div></div>
<div class="gap"></div>
<div class="row jori"><div class="spacer"></div><div class="b j1">Found them: TAP 202 on Mar 13, row 14 aisles, $1,284 for two. Approve with Face ID.</div></div>
<div class="row jori">${AV}<div class="b j2" style="max-width:330px">And for Jordan's birthday, I'd go with:
<div class="card"><div class="wait">✦ Waiting for your answer</div>
<div class="opt rec"><span class="n">1</span><div><div class="l">Ceramics class for two<em>Recommended</em></div><div class="d">$180. Jordan stopped there twice.</div></div></div>
<div class="opt"><span class="n">2</span><div><div class="l">Blue Note vinyl box set</div><div class="d">$95. They own most of it.</div></div></div>
</div></div></div>
</div>${COMPOSER}`;

const approval = `${chatThread}<div class="dim"></div><div class="sheet"><div class="grab"></div>
<div class="head"><div class="cart"><svg width="24" height="22" viewBox="0 0 24 22"><path d="M1 1.5h3.2l2.6 12.2h12.4l2.6-9H6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="18.8" r="1.8" fill="currentColor"/><circle cx="17.5" cy="18.8" r="1.8" fill="currentColor"/></svg></div>
<h2>Approve purchase</h2><div class="m">TAP Air Portugal, flytap.com</div><div class="amt">$1,284.00</div><div class="exp">Expires in 14:52</div></div>
<div class="sections">
<div class="sec"><h3>Why these</h3><div class="grp"><div class="li why">Lowest fare since you started watching in October, and the same row-14 aisle seats you picked last time.</div></div></div>
<div class="sec"><h3>What you're buying</h3><div class="grp"><div class="li"><span><span class="q">1×</span>JFK → LIS · Fri Mar 13</span><span class="num">$642.00</span></div><div class="li"><span><span class="q">1×</span>LIS → JFK · Sun Mar 22</span><span class="num">$642.00</span></div><div class="li"><b>Total</b><b class="num">$1,284.00</b></div></div></div>
<div class="sec"><h3>Paid with</h3><div class="grp"><div class="li"><span>💳&nbsp; Travel card ••4021</span></div></div></div>
</div>
<div class="btns"><div class="no">Deny</div><div class="yes"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"><path d="M1.5 6.5v-2a3 3 0 0 1 3-3h2M15.5 1.5h2a3 3 0 0 1 3 3v2M20.5 15.5v2a3 3 0 0 1-3 3h-2M6.5 20.5h-2a3 3 0 0 1-3-3v-2M7.5 8v1.5M14.5 8v1.5M11 8v4.5h-1M8 15.5c1.8 1.4 4.2 1.4 6 0"/></svg>Buy with Face ID</div></div>
</div>`;

const appDoc = (screens) => `<!doctype html><html><head><meta charset="utf-8"><style>${APP_CSS}</style></head><body>${screens.map(phone).join("")}</body></html>`;

// ── Composites (framed for the site and README) ────────────────────────────

const appWin = (img, title) => `<div class="win"><div class="top"><i></i><i></i><i></i><div class="url" style="background:transparent;font-weight:600">${title}</div></div><img src="${img}"></div>`;
const browser = (img, url, dark = false) => `<div class="win${dark ? " dark" : ""}"><div class="top"><i></i><i></i><i></i><div class="url">🔒 ${url}</div></div><img src="${img}"></div>`;
const FRAME_CSS = `
* { box-sizing:border-box; margin:0; }
html, body { background:transparent; }
body { padding:90px; font:13px -apple-system, system-ui, sans-serif; }
.win { width:1280px; border-radius:14px; overflow:hidden; background:#fff; box-shadow:0 30px 70px rgba(16,24,40,.22), 0 0 0 1px rgba(16,24,40,.08); }
.win .top { height:40px; display:flex; align-items:center; gap:8px; padding:0 16px; background:#eceef1; border-bottom:1px solid #dcdfe4; }
.win .top i { width:12px; height:12px; border-radius:50%; background:#ff5f57; }
.win .top i:nth-child(2) { background:#febc2e; } .win .top i:nth-child(3) { background:#28c840; }
.win .url { margin:0 auto; transform:translateX(-30px); background:#fff; color:#5b6470; border-radius:8px; padding:5px 60px; font-size:13px; }
.win.dark { background:#0e1217; } .win.dark .top { background:#1f242b; border-color:#2b3139; } .win.dark .url { background:#2b3139; color:#a0acb9; }
.win img { display:block; width:100%; }
.show { position:relative; width:1520px; height:1000px; }
.show .win { position:absolute; left:0; top:0; }
.show .ph { position:absolute; right:-40px; bottom:-40px; }
.show .ph img { display:block; width:610px; }
`;
const frameDoc = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>${FRAME_CSS}</style></head><body>${body}</body></html>`;

// ── Render ──────────────────────────────────────────────────────────────────

function shoot(html, name, w, h, { transparent = false } = {}) {
  const file = path.join(WORK, `${name}.html`);
  fs.writeFileSync(file, html);
  const png = path.join(WORK, `${name}.png`);
  execFileSync(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    `--user-data-dir=${path.join(WORK, "profile")}`,
    "--force-device-scale-factor=2", `--window-size=${w},${h}`,
    ...(transparent ? ["--default-background-color=00000000"] : []),
    "--virtual-time-budget=3000",
    `--screenshot=${png}`, `file://${file}`,
  ], { stdio: "ignore" });
  return png;
}

// ── Work scenes (getjori.ai/business) ───────────────────────────────────────
//
// A made-up work setup: Dana Reyes, head of partnerships at Fieldstone; the
// client Harbor & Pine Logistics (Priya Natarajan, VP Operations, and Tom
// Becker, COO); Leo Martin, Dana's colleague. "Today" is FIXED_NOW (Wed Nov 5).

const WHO_WORK = "dana@fieldstone.example";
const workTitles = new Map([
  ["person_priya_natarajan", "Priya Natarajan"],
  ["person_tom_becker", "Tom Becker"],
  ["person_leo_martin", "Leo Martin"],
  ["org_harbor_pine", "Harbor & Pine Logistics"],
  ["project_harbor_pine_renewal", "Harbor & Pine renewal"],
  ["meeting_2026-10-28_harbor_pine_qbr", "Harbor & Pine QBR · Oct 28"],
  ["reference_security_questionnaire", "Security questionnaire"],
  ["week_2026-11-02", "Week of Nov 2"],
  ["project_pipeline_review", "Weekly pipeline review"],
]);
const workMd = (md) => render.renderMarkdown(md, { resolveLink: () => true, labelFor: (id) => workTitles.get(id) });
const links = (ids, key) => ids.map((id) => ({ [key]: id }));
const workPage = ({ id, type, description, mins, pinned = false, revs, topic, md, fwd, back, dark = false }) =>
  wikiDoc(workTitles.get(id), portal.pageBody({
    page: { id, type, title: workTitles.get(id), description, status: "active", pinned, updated_at: ago(mins), last_verified_at: "today" },
    bodyHtml: workMd(md), titles: workTitles, revCount: revs, connected: false,
    fwd: links(fwd, "dst_id"), back: links(back, "src_id"), topic,
  }), { dark, active: null, who: WHO_WORK });

const workPerson = workPage({
  id: "person_priya_natarajan", type: "person", pinned: true, mins: 12, revs: 23,
  topic: { slug: "people", name: "People" },
  description: "VP Operations at Harbor & Pine Logistics. Decides the renewal. Short emails, Tuesday calls.",
  md: `Runs operations at [[org_harbor_pine]]: 380 people, six warehouses. Reports to the COO, [[person_tom_becker]]. Met at a logistics summit in Chicago, May 2026.

## What matters to her
- Fewer late-shipment escalations. Her team loses Mondays to them.
- One ask per email. Calls on Tuesday or Thursday, never Monday.
- The rollout plan matters more to her than the price.

## Interactions
| When | Where | What |
|---|---|---|
| Oct 30 | Email | Asked whether the 6-site pricing includes Atlanta. |
| Oct 28 | Zoom | QBR. Two-year renewal if rollout starts by January ([[meeting_2026-10-28_harbor_pine_qbr]]). |
| Oct 21 | Slack | Shared the Q3 late-shipment report. |
| Oct 9 | Call | Introduced Tom. Budget approved in principle. |
| Sep 30 | LinkedIn | Congratulated her on the Atlanta opening. |

## Open follow-ups
- **You owe her** the revised 6-site pricing. Promised for Mon Nov 3: **2 days late**. A draft is ready.
- **She owes you** the [[reference_security_questionnaire]]. Asked Oct 28. Jori nudges her Thursday.
- **Next touch:** the kickoff date, once the contract is signed.`,
  fwd: ["org_harbor_pine", "person_tom_becker", "meeting_2026-10-28_harbor_pine_qbr", "project_harbor_pine_renewal", "reference_security_questionnaire"],
  back: ["project_harbor_pine_renewal", "meeting_2026-10-28_harbor_pine_qbr", "project_pipeline_review", "week_2026-11-02"],
});

const workMeeting = workPage({
  id: "meeting_2026-10-28_harbor_pine_qbr", type: "meeting", mins: 60 * 24 * 8, revs: 3, dark: true,
  topic: { slug: "meetings", name: "Meetings" },
  description: "Zoom, Tue Oct 28, 2:00 to 2:45 PM. Priya Natarajan, Tom Becker, Dana Reyes, Leo Martin. Summarized from the recording.",
  md: `## Summary
Harbor & Pine will renew for two years if the rollout reaches all six warehouses by January. Price is not the blocker; the rollout plan is. Tom wants one named onboarding lead.

## Decisions
- Scope grows from 4 sites to 6, Atlanta included.
- Kickoff the week of Jan 12.
- [[person_leo_martin]] leads onboarding.

## Action items
| Owner | What | Due | Status |
|---|---|---|---|
| Dana | Revised pricing for 6 sites | Nov 3 | 2 days late, draft ready |
| Leo | One-page rollout plan | Nov 7 | On track |
| Priya | Security questionnaire | Nov 6 | Waiting |
| Tom | Budget confirmed in writing | Nov 10 | Waiting |

## Follow-ups Jori is watching
- Nudges Priya Thursday if the questionnaire hasn't arrived.
- Reminds Leo Friday morning about the rollout plan.
- Books the kickoff once the contract is signed.`,
  fwd: ["person_priya_natarajan", "person_tom_becker", "person_leo_martin", "project_harbor_pine_renewal", "reference_security_questionnaire"],
  back: ["person_priya_natarajan", "project_harbor_pine_renewal", "week_2026-11-02"],
});

const workProject = workPage({
  id: "project_harbor_pine_renewal", type: "project", pinned: true, mins: 30, revs: 31,
  topic: { slug: "projects", name: "Projects" },
  description: "Two-year renewal, six sites, $184k a year. Target signature Fri Nov 21.",
  md: `**On track, one item late.** Last movement: the QBR on Oct 28 ([[meeting_2026-10-28_harbor_pine_qbr]]).

## Tasks
- [ ] Send Priya the revised pricing for all six Harbor & Pine sites · Dana · due 2026-11-03 (overdue) · draft ready
- [ ] Check the multi-site discount on the Harbor & Pine pricing · Sasha (Finances) · due 2026-11-05
- [ ] Get the security questionnaire back for the Harbor & Pine renewal · Priya · due 2026-11-06
- [ ] Write the one-page Harbor & Pine rollout plan · Leo · due 2026-11-07
- [ ] Send the Harbor & Pine contract for signature · Dana · due 2026-11-14
- [x] Book the Harbor & Pine QBR · done Oct 21 (Jori)

## Risks
- The pricing is late. Priya answers fastest on Tuesdays.
- Nothing from [[person_tom_becker]] since Oct 9. Copy him on the pricing email.

## Timeline
- **Oct 28** QBR: six sites, kickoff week of Jan 12.
- **Oct 9** Budget approved in principle.
- **Sep 12** First call with [[person_priya_natarajan]].`,
  fwd: ["person_priya_natarajan", "person_tom_becker", "person_leo_martin", "meeting_2026-10-28_harbor_pine_qbr", "reference_security_questionnaire"],
  back: ["person_priya_natarajan", "meeting_2026-10-28_harbor_pine_qbr", "project_pipeline_review", "week_2026-11-02"],
});


// ── The team in the app: a conversation per role, photos, one red badge ────
// The work roster, one role per kernel plugin (plugins/role-*): Jori (Chief of
// Staff), Alex (Product), Sasha (Finances), Kim (Marketing), Eden (Travel),
// Dani (Social), Jules (Health). Made-up headshots in scripts/screenshots/team/.
const PHOTO = Object.fromEntries(["alex", "sasha", "kim", "eden", "dani", "jules"].map((n) =>
  [n, `data:image/jpeg;base64,${fs.readFileSync(path.join(__dirname, "team", `${n}.jpg`)).toString("base64")}`])); // kernel-closure-ok: the demo headshots ship in the kernel beside this script
const crow = (av, name, title, preview, time, badge = 0) => `<div class="crow">${av}<div class="c"><div class="top"><b>${name}</b><i>${title}</i><time>${time}</time></div><div class="bot"><span>${preview}</span>${badge ? `<div class="badge">${badge}</div>` : ""}</div></div></div>`;
const img = (n, cls = "ph") => `<img class="${cls}" src="${PHOTO[n]}">`;
// A screen as it looks in a role's own conversation: its photo and title in the
// header and beside its messages, the composer addressed to it.
const asRole = (screen, key, name, title) => screen
  .split(NAV).join(navFor(`<img src="${PHOTO[key]}">`, name, title))
  .split(AV).join(img(key, "av"))
  .split(COMPOSER).join(composer(name));
// Jori's own conversation at work, where it has a team: the Chief of Staff.
const asCos = (screen) => screen.split(NAV).join(NAV_COS);
// The iPhone list as PinnedConversationsGrid + the list draw it: pinned
// conversations as circles three across (54 pt, the name and the role under
// each in a small font, a red badge when something waits), then the rest.
const pin = (av, name, role, badge = 0) => `<div class="pin"><div class="pc">${av}${badge ? `<div class="badge">${badge}</div>` : ""}</div><b>${name}</b><span>${role}</span></div>`;
const MORE = `<div class="ico"><svg width="18" height="4" viewBox="0 0 18 4"><circle cx="2" cy="2" r="1.8" fill="currentColor"/><circle cx="9" cy="2" r="1.8" fill="currentColor"/><circle cx="16" cy="2" r="1.8" fill="currentColor"/></svg></div>`;
const COMPOSE = `<div class="ico"><svg width="18" height="18" viewBox="0 0 18 18"><path d="M3 15l1-3.5 8.5-8.5 2.5 2.5L6.5 14z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></div>`;
const teamList = `<div class="tbar">${MORE}${COMPOSE}</div><div class="lhead"><b>Jori</b></div>
<div class="pins">
${pin(`<img src="${JORI_PHOTO}">`, "Jori", "Chief of Staff")}
${pin(img("sasha", ""), "Sasha", "Finances", 2)}
${pin(img("alex", ""), "Alex", "Product")}
</div>
<div class="clist">
${crow(img("eden"), "Eden", "Travel", "Chicago on the 18th: the 7 AM flight is held, and the hotel is 4 minutes from Harbor &amp; Pine.", "8:41 AM", 1)}
${crow(`<div class="grp">${img("sasha", "")}${img("kim", "")}</div>`, "Harbor &amp; Pine renewal", "Jori, Sasha, Kim", "Sasha: Quarterly works if they sign by the 21st.", "Yesterday", 1)}
${crow(img("kim"), "Kim", "Marketing", "The Harbor &amp; Pine case study draft is ready for your edits.", "Thu")}
${crow(img("dani"), "Dani", "Social", "Priya's birthday is Monday. A card from you and Leo is drafted.", "Wed")}
${crow(img("jules"), "Jules", "Health", "Thursday is five meetings back to back. I moved your run to 7 AM.", "Mon")}
</div>`;
const groupThread = `${navFor(`<div class="stack">${img("sasha", "")}${img("kim", "")}</div>`, "Harbor &amp; Pine renewal", "Jori, Sasha, Kim")}<div class="thread">
<div class="sep">Today 10:14 AM</div>
<div class="from">Jori · Chief of Staff</div>
<div class="row jori">${AV}<div class="b j1" style="max-width:320px">Tom wants quarterly billing instead of annual before they sign. Everything else in the redlines is fine.</div></div>
<div class="gap"></div>
<div class="row me"><div class="b"><span class="mention">@Sasha</span> can we do quarterly if they sign by the 21st?</div></div>
<div class="gap"></div>
<div class="from">Sasha · Finances</div>
<div class="row jori">${img("sasha", "av")}<div class="b j1" style="max-width:320px"><b>Bottom line: yes.</b> Quarterly costs us about $1,800 in float over the year, from the contract value and our cash balance as of this morning. Worth it to close by the 21st.</div></div>
<div class="gap"></div>
<div class="from">Jori · Chief of Staff</div>
<div class="row jori">${AV}<div class="b j1" style="max-width:320px">Putting it in the reply to Tom now. I'll tell you when he answers.</div></div>
</div>${composer("the group")}`;
const workAfterMeeting = `${NAV}<div class="thread">
<div class="sep">Tue Oct 28, 2:47 PM</div>
<div class="row jori"><div class="spacer"></div><div class="b j1" style="max-width:330px"><b>Harbor &amp; Pine QBR just ended.</b> 45 minutes on Zoom with Priya and Tom.
<ul>
<li><i>✅</i><span>Two-year renewal, six sites.</span></li>
<li><i>📅</i><span>Kickoff the week of Jan 12.</span></li>
<li><i>📝</i><span>4 action items. Yours: revised pricing by Monday.</span></li>
</ul>
<div class="linkcard"><div class="ic">J</div><div><b>Harbor &amp; Pine QBR · Oct 28</b><span>Summary, decisions, action items</span></div></div></div></div>
<div class="gap"></div>
<div class="row me"><div class="b">Remind Leo about the rollout plan Friday.</div></div>
<div class="gap"></div>
<div class="row jori">${AV}<div class="b j1">Done: Friday 9 AM, on Slack. I'll nudge Priya Thursday if the security questionnaire isn't in, and I've added Tom to the people page.</div></div>
</div>${COMPOSER}`;

const workFollowUps = `${NAV}<div class="thread">
<div class="sep">Today 8:30 AM</div>
<div class="row jori"><div class="spacer"></div><div class="b j1" style="max-width:330px"><b>Follow-ups for today</b>
<ul>
<li><i>⚠️</i><span>Pricing to Priya, promised Monday. 2 days late.</span></li>
<li><i>⏳</i><span>Priya's questionnaire, asked a week ago.</span></li>
<li><i>🔇</i><span>No word from Tom Becker in 4 weeks.</span></li>
</ul></div></div>
<div class="row jori">${AV}<div class="b j2" style="max-width:330px">I drafted the pricing email from the QBR notes:
<div class="draft"><div class="h">To <b>Priya Natarajan</b> · Cc <b>Tom Becker</b></div>Priya, here's the pricing for all six sites, Atlanta included. Sorry it's a couple of days late…</div>
<div class="card"><div class="wait">✦ Waiting for your answer</div>
<div class="opt rec"><span class="n">1</span><div><div class="l">Send it now<em>Recommended</em></div><div class="d">Copies Tom, who's gone quiet.</div></div></div>
<div class="opt"><span class="n">2</span><div><div class="l">Snooze to Tuesday</div><div class="d">Priya answers fastest then.</div></div></div>
</div></div></div>
</div>${COMPOSER}`;

const chat = (sep, body) => `${NAV}<div class="thread"><div class="sep">${sep}</div>${body}</div>${COMPOSER}`;
const jori = (html, { first = true, avatar = false, wide = true } = {}) =>
  `<div class="row jori">${avatar ? AV : '<div class="spacer"></div>'}<div class="b ${first ? "j1" : "j2"}"${wide ? ' style="max-width:330px"' : ""}>${html}</div></div>`;
const me = (text) => `<div class="gap"></div><div class="row me"><div class="b">${text}</div></div><div class="gap"></div>`;
const choice = (opts) => `<div class="card"><div class="wait">✦ Waiting for your answer</div>${opts
  .map(([l, d, rec], i) => `<div class="opt${rec ? " rec" : ""}"><span class="n">${i + 1}</span><div><div class="l">${l}${rec ? "<em>Recommended</em>" : ""}</div><div class="d">${d}</div></div></div>`)
  .join("")}</div>`;

// ── Email, scheduling and team chat (work) ─────────────────────────────────

const mail = (from, subj, take, tag) => `<div class="place"><div class="pic" style="background:#E8ECFB;color:#2F45C9;font:600 15px -apple-system,system-ui">${from.split(" ").map((w) => w[0]).join("").slice(0, 2)}</div><div><b>${from} · ${subj}</b><span>${take}</span>${tag ? `<span style="color:var(--cobalt);font-weight:600;margin-top:2px">${tag}</span>` : ""}</div></div>`;
const workEmail = chat("Today 7:45 AM",
  jori(`<b>Your inbox at 7:45.</b> 3 need you; 38 sorted out of the way.
${mail("Priya Natarajan", "Re: pricing", "Asks if Atlanta can start in February instead.", "Reply drafted")}
${mail("Tom Becker", "Contract redlines", "Two changes, both to payment terms: net 45, quarterly billing.", "Summary on the renewal page")}
${mail("Alex Chen", "Intro, Brightline", "Wants 30 minutes next week.", "Times offered")}
<div style="font-size:13px;color:var(--ink2);margin-top:8px">Sorted: 12 receipts, 9 newsletters, 17 updates.</div>`) +
  jori(`My draft to Priya says yes to February, same kickoff team.${choice([["Send the draft", "It's short, one ask, the way she likes.", true], ["Show it to me first", ""]])}`, { first: false, avatar: true }));

const workSchedule = chat("Monday 9:12 AM",
  me("Set up 30 minutes with Alex Chen from Brightline next week.") +
  jori(`Emailed Alex from your account with three times that fit your calendar and your no-meetings-before-10 rule: Tue 11:00, Wed 3:30 or Thu 11:00.`, { avatar: true }) +
  `<div class="sep" style="margin-top:14px">Monday 11:20 AM</div>` +
  jori(`Alex picked <b>Thursday at 11</b>. Booked, with a Zoom link.
<div class="linkcard"><div class="ic" style="flex-direction:column;font:700 15px -apple-system,system-ui;line-height:1"><span style="font-size:9px;color:#D93A33;display:block">NOV</span>13</div><div><b>Dana / Alex Chen (Brightline)</b><span>Thu 11:00 to 11:30 AM · Zoom</span></div></div>
<div style="margin-top:8px">The invite notes have his background and Brightline's last funding round, and I'll send you a one-paragraph brief that morning.</div>`, { avatar: true }));

// The team-chat scene: a generic workspace layout (not any vendor's look).
const SL_CSS = `
* { box-sizing:border-box; margin:0; }
body { font:15px/1.45 -apple-system, system-ui, sans-serif; color:#1d1c1d; background:#fff; -webkit-font-smoothing:antialiased; display:flex; height:100vh; }
.side { width:250px; background:#1f2430; color:#c9cdd6; padding:14px 10px; flex:none; display:flex; flex-direction:column; gap:2px; }
.ws { color:#fff; font-weight:700; font-size:17px; padding:4px 10px 14px; }
.grp { font-size:13px; color:#8b93a3; padding:12px 10px 4px; }
.ch { padding:5px 10px; border-radius:6px; font-size:15px; display:flex; align-items:center; gap:8px; }
.ch.on { background:#2f5bd3; color:#fff; }
.ch .dot { width:9px; height:9px; border-radius:50%; background:#2bac76; }
.main { flex:1; display:flex; flex-direction:column; min-width:0; }
.head { padding:14px 22px; border-bottom:1px solid #e3e5e8; display:flex; align-items:baseline; gap:12px; }
.head b { font-size:18px; }
.head span { color:#6b6f76; font-size:13.5px; }
.msgs { flex:1; padding:10px 22px; display:flex; flex-direction:column; gap:14px; overflow:hidden; }
.m { display:flex; gap:11px; }
.m .a { width:38px; height:38px; border-radius:8px; flex:none; display:grid; place-items:center; color:#fff; font-weight:700; font-size:15px; }
.m .a svg { width:38px; height:38px; border-radius:8px; }
.m .who { font-weight:700; font-size:15px; }
.m .who .app { font-size:10.5px; font-weight:700; color:#6b6f76; background:#eceef1; border-radius:3px; padding:1px 4px; margin-left:6px; vertical-align:2px; }
.m .who time { font-weight:400; color:#6b6f76; font-size:12.5px; margin-left:8px; }
.mention { background:#e8ecfb; color:#2f45c9; border-radius:3px; padding:0 2px; font-weight:500; }
.slots { display:flex; gap:8px; margin-top:8px; }
.slot { border:1px solid #d0d4da; border-radius:8px; padding:7px 12px; font-size:14px; font-weight:600; }
.slot.pick { border-color:#2f5bd3; color:#2f5bd3; background:#f3f6fe; }
.att { margin-top:8px; border-left:4px solid #2f5bd3; padding:4px 12px; font-size:14px; color:#3d3f43; background:#f7f8fa; border-radius:0 6px 6px 0; }
.att b { color:#1d1c1d; }
.rx { display:inline-flex; gap:5px; align-items:center; border:1px solid #d0d4da; border-radius:12px; padding:1px 8px; font-size:12.5px; margin-top:6px; background:#f7f8fa; }
.comp { margin:6px 22px 18px; border:1px solid #c9ccd1; border-radius:10px; padding:12px 14px; color:#8b8f96; }
`;
const av = (initials, color) => `<div class="a" style="background:${color}">${initials}</div>`;
const JAV = `<div class="a">${ICON_FACE.replace('width="30" height="30"', 'width="38" height="38"').replace('<circle cx="15" cy="15" r="15"', '<rect width="30" height="30" rx="6"')}</div>`;
const msg = (a, who, time, body, app = false) => `<div class="m">${a}<div><div class="who">${who}${app ? '<span class="app">APP</span>' : ""}<time>${time}</time></div><div>${body}</div></div></div>`;
const slackDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${SL_CSS}</style></head><body>
<div class="side"><div class="ws">Fieldstone</div>
<div class="grp">Channels</div><div class="ch"># general</div><div class="ch"># partnerships</div><div class="ch on"># harbor-pine</div><div class="ch"># rollout</div>
<div class="grp">Direct messages</div><div class="ch"><span class="dot"></span>Leo Martin</div><div class="ch"><span class="dot"></span>Jori</div><div class="ch"><span class="dot" style="background:#8b93a3"></span>Maria Soto</div></div>
<div class="main"><div class="head"><b># harbor-pine</b><span>The Harbor &amp; Pine renewal · 6 members</span></div><div class="msgs">
${msg(av("LM", "#7a5af8"), "Leo Martin", "10:02 AM", "Rollout plan v2 is up. Priya wants to walk Tom through it before they sign.")}
${msg(av("DR", "#d9773a"), "Dana Reyes", "10:04 AM", `<span class="mention">@Jori</span> can you find an hour next week for Priya, Tom, Leo and me?`)}
${msg(JAV, "Jori", "10:04 AM", `I checked all four calendars. Tom is out Wednesday, and Priya prefers Tuesday or Thursday afternoons. Open for everyone:
<div class="slots"><div class="slot">Tue Nov 11 · 2:00–3:00 PM</div><div class="slot">Thu Nov 13 · 3:30–4:30 PM</div></div>
<div style="margin-top:6px">Say which and I'll send the invite with a Zoom link and the plan attached.</div>`, true)}
${msg(av("LM", "#7a5af8"), "Leo Martin", "10:06 AM", "Tuesday works for me")}
${msg(av("DR", "#d9773a"), "Dana Reyes", "10:06 AM", `<span class="mention">@Jori</span> Tuesday. And remind Leo to send the deck the day before.`)}
${msg(JAV, "Jori", "10:06 AM", `Done.<div class="att"><b>Harbor &amp; Pine rollout review</b><br>Tue Nov 11, 2:00–3:00 PM · Zoom · Priya, Tom, Leo, Dana · rollout plan v2 attached</div>
<div style="margin-top:6px"><span class="mention">@Leo Martin</span> I'll ping you Monday at 10 about the deck.</div><span class="rx">👍 2</span>`, true)}
${msg(av("DR", "#d9773a"), "Dana Reyes", "10:09 AM", `<span class="mention">@Jori</span> what did we promise them at the QBR?`)}
${msg(JAV, "Jori", "10:09 AM", `Three things: pricing for all six sites (sent Nov 5), a one-page rollout plan (Leo, due Nov 7) and kickoff the week of Jan 12. From the <span style="color:#2f45c9">QBR notes, Oct 28</span>.`, true)}
</div><div class="comp">Message #harbor-pine</div></div></body></html>`;

// ── Personal scenes (getjori.ai/personal) ──────────────────────────────────

const moneyPage = wikiDoc("Money · November", portal.pageBody({
  page: { id: "money_2026-11", type: "money", title: "Money · November", description: "Where it went, what's coming up, and what changed. From read-only bank and card sync.", status: "active", pinned: true, updated_at: ago(45), last_verified_at: "today" },
  bodyHtml: render.renderMarkdown(`**Net worth** $412,300, up $3,400 this month. **Spent** $4,120 so far, against a usual $4,400.

## Spending vs usual
| | This month | Usual |
|---|---|---|
| Groceries | $640 | $700 |
| Dining out | $520 | $410 |
| Travel | $1,284 | $300 |
| Subscriptions | $142 | $118 |

## Worth a look
- **New subscription:** StreamBox, $23.99 a month since Nov 2, not opened since. Jori asked whether to cancel.
- **Charged twice:** Corner Hardware, $46.20 on Nov 3. A dispute is drafted.
- **Dining out** is $110 over usual: two birthday dinners.

## Coming up
| Due | Bill | Amount |
|---|---|---|
| Nov 12 | Rent | $3,200 |
| Nov 15 | Travel card, autopay | $1,912 |
| Nov 20 | Electric | about $96 |`, { resolveLink: () => true }),
  titles: new Map([["project_lisbon_trip", "Lisbon in March"], ["reference_cards", "Cards & accounts"], ["feedback_purchases", "Purchases need Face ID"], ["week_2026-11-02", "Week of Nov 2"]]),
  revCount: 41, connected: false,
  fwd: links(["reference_cards", "project_lisbon_trip", "feedback_purchases"], "dst_id"),
  back: links(["week_2026-11-02", "project_lisbon_trip"], "src_id"),
  topic: { slug: "money", name: "Money" },
}), { active: null });

const pMoney = chat("Sunday 9:00 AM",
  jori(`<b>Your week in money</b><ul>
<li><i>💳</i><span>Spent $1,040, about usual.</span></li>
<li><i>✈️</i><span>Lisbon flights booked, $1,284.</span></li>
<li><i>⚠️</i><span>Corner Hardware charged you twice. Dispute drafted.</span></li>
<li><i>📈</i><span>Net worth up 0.8%.</span></li></ul>`) +
  jori(`StreamBox started billing $23.99 a month on Nov 2, and nobody has opened it since.${choice([["Cancel it", "Saves $288 a year.", true], ["Keep it", "I'll ask again in a month."]])}`, { first: false, avatar: true }));

const pTrip = chat("Sat Mar 14, 8:05 AM",
  jori(`<b>Saturday in Lisbon.</b> Sunny, 66°.<div class="plan">
<div><b>9:30</b><span>Príncipe Real garden market, 8 min walk.</span></div>
<div><b>11:00</b><span>Tram 28 up to Graça, before the lines.</span></div>
<div><b>1:00</b><span>Lunch at Taberna do Largo: grilled fish, walk-in, where locals eat.</span></div>
<div><b>5:30</b><span>Miradouro da Graça. Sunset 6:42.</span></div></div>`) +
  me("Swap lunch for somewhere with a view?") +
  jori(`Café do Rio: terrace over the river, walk-ins until 2, the fish is just as good and about $8 more a head. Swapped, and the walk from Graça is 14 minutes downhill.`, { avatar: true }));

const pDinner = chat("Thursday 5:10 PM",
  jori(`<b>Friday, before the 8 PM show.</b> Three places within 6 minutes of the theater:
<div class="place"><div class="pic" style="background:#FDE8D8">🍝</div><div><b>Nonna Bea · Italian · 4 min</b><span>Fresh pasta, fast. You loved their sister place.</span></div></div>
<div class="place"><div class="pic" style="background:#E3ECF8">🍣</div><div><b>Sora · Japanese · 6 min</b><span>Counter seats. Walk in by 6:15.</span></div></div>
<div class="place"><div class="pic" style="background:#E5F2E3">🥗</div><div><b>Fig &amp; Fennel · Mediterranean · 5 min</b><span>Jordan's pick last time. No oysters on the menu.</span></div></div>`) +
  me("Nonna Bea. Get us a table at 6.") +
  jori(`Booked: Nonna Bea, Friday 6:00, table for two. It's on your calendar with a 7:40 leave-by.`, { avatar: true }));

const pTickets = chat("Today 11:02 AM",
  jori(`<b>🎟️ The Lumen Quartet</b> just announced Ridgeway Hall, Sat Feb 7. You've seen them twice. Presale is tomorrow at 10.`) +
  jori(`Also on your watchlist:<ul>
<li><i>🎤</i><span>Mara Kent added a late show Dec 12, a 140-seat room.</span></li>
<li><i>📺</i><span>Season 3 of <i style="width:auto">Night Shift</i> drops Friday.</span></li></ul>
<div style="margin-top:8px">Want me to grab two at presale?</div>${choice([["Orchestra, about $95 each", "Rows K to P: best view for the price.", true], ["Balcony front row, about $70", "Good sound, farther away."]])}`, { first: false, avatar: true }));

const pHome = chat("Today 8:41 AM",
  jori(`Looks like you're both heading out. I set the place to away:<div class="home">
<div><span>🔒 Front door</span><span class="ok">Locked</span></div>
<div><span>❄️ Air conditioning</span><span class="ok">78° away</span></div>
<div><span>💡 Lights</span><span class="ok">All off</span></div>
<div><span>🐶 Biscuit cam</span><span class="ok">On</span></div>
<div><span>💧 Leak sensor, kitchen</span><span class="warn">Offline</span></div></div>`) +
  me("What's up with the leak sensor?") +
  jori(`Its battery died at 2 AM; the last reading was dry. I added AAA batteries to the grocery list and I'll check it reports again once they're in.`, { avatar: true }));

// ── Projects and the team (getjori.ai/personal § Your team) ─────────────────
//
// Personal: Jori works alone, as the personal assistant, and keeps a task list
// per project; Sam's tasks go on Sam's own list with a date, Jori follows up when
// one slips and does the work it can overnight.
// Work: Jori is the chief of staff of a team of roles that sign their work —
// the app's own roster (lib/org.cjs, plugins/role-*), with its own names.

const TEAM = [
  ["Jori", "Chief of Staff", "Projects, inbox and calendar, meetings, follow-ups and research."],
  ["Alex", "Product", "All the tech: builds, fixes, and keeps laptops, accounts and backups safe."],
  ["Sasha", "Finances", "Invoices, cash, spend and month-end."],
  ["Kim", "Marketing", "Search, app stores, reviews and outreach."],
  ["Eden", "Travel", "Flights, hotels and every itinerary."],
  ["Dani", "Social", "Clients and contacts, staying in touch, events and occasions."],
  ["Jules", "Health", "Focus time, sleep and exercise, so the pace holds."],
];

const kitchen = pages.find((p) => p.id === "project_kitchen_reno");
const kitchenMd = `## Goal
A brighter kitchen before Jordan's birthday in March: new countertops, two lower cabinets replaced, under-cabinet lights. Done means the crew is gone and the sink works.

## What you might need
- A contractor, chosen from the three quotes (quotes in, Oct 29)
- A countertop: the quartz sample comes Friday
- A start date before Reyes' December slots go on Nov 14 (gap)

## Tasks
- [ ] Call Reyes Builders about a December start for the kitchen refresh · Sam · due 2026-11-06 · moved from Nov 3
- [ ] Pick the countertop for the kitchen refresh · Sam · due 2026-11-04 (overdue)
- [ ] Review Jori's side-by-side of the kitchen quotes · Sam · due 2026-11-07 · Google Doc
- [ ] Find the building's rules for renovation work hours · Jori · due 2026-11-06
- [x] Measure the counters for the kitchen refresh · done Nov 2 (Sam ticked it off)

## Coming up
- 2026-11-06 · Quartz sample delivery, 10 to 2 (calendar)
- 2026-11-14 · Reyes Builders' last December start date (email)

## Lately
- 2026-11-05 · Jori put the three quotes side by side: Reyes is cheapest once the permit they left out is added; Linden is two weeks faster.
- 2026-11-04 · The call with Reyes slipped; Sam moved it to Friday.
- 2026-11-02 · Counters measured: 11 ft 4 in of run, 2 ft 1 in deep.

## People
[[user_sam]], [[user_jordan]]`;
const kitchenBody = portal.pageBody({
  page: { ...kitchen, description: "Countertops, two cabinets, lights. Three quotes in; start date by Nov 14.", updated_at: ago(40), last_verified_at: "today" },
  bodyHtml: render.renderMarkdown(kitchenMd, { resolveLink: () => true, labelFor: (id) => titles.get(id) }),
  fwd: ["user_sam", "user_jordan", "project_jordan_gift"].map((dst_id) => ({ dst_id })),
  back: ["user_sam", "day_" + new Date(now - 3 * 86400000).toISOString().slice(0, 10)].map((src_id) => ({ src_id })),
  titles, revCount: 22, connected: false,
  topic: resolved.topics.find((t) => t.slug === "plans"),
});
const projectPage = wikiDoc("Kitchen refresh", kitchenBody, { active: null });

const signed = (name, html) => `<b>${name}:</b> ${html}`;
const pSlip = chat("Wednesday 9:10 AM",
  jori(`The call with Reyes Builders about the kitchen start date slipped past Monday. Their December slots go on the 14th, so this one matters this week.${choice([["Call them today", "Their number and your three questions are in the task.", true], ["Move it to Friday", "Still leaves room before the 14th."], ["Have Jori email them", "A short note from your account. You approve it first."]])}`) +
  me("Friday. And can someone compare the three quotes?") +
  jori(`Moved to Friday, on your list. I'll put the three quotes side by side tonight, and you'll have it with your coffee.`, { avatar: true }));

const pWork = chat("Thursday 7:05 AM",
  jori((`The three kitchen quotes, side by side. Reyes is cheapest once you add the permit they left out; Linden is two weeks faster for $1,100 more.
<div class="linkcard"><div class="ic">G</div><div><b>Kitchen quotes, side by side</b><span>Google Doc · ready for your review</span></div></div>
<div style="margin-top:8px">Reviewing it is on your list for Saturday.</div>`)) +
  `<div class="sep" style="margin-top:14px">Sunday 9:00 AM</div>` +
  jori(`<b>Your projects this week</b><ul>
<li><i>✅</i><span>6 tasks done: 4 yours, 2 by Jori.</span></li>
<li><i>⚠️</i><span>Slipping: the countertop pick, 4 days late.</span></li>
<li><i>📅</i><span>Due this week: Lisbon hotel (Tue), Jordan's gift (Fri).</span></li>
<li><i>🏃</i><span>Half marathon: Sunday's long run is on track.</span></li></ul>`, { avatar: true }));

// The chief of staff at work: a slipped task with a way forward, the team's
// overnight work, and the Monday roll-up by role.
const wSlip = chat("Tuesday 8:30 AM",
  jori(`The revised pricing for Harbor &amp; Pine slipped past Monday, and it's the one thing between Priya and the contract.${choice([["Send my draft today", "Six sites, Atlanta included, from the QBR notes.", true], ["Move it to Thursday", "Still a week before the Nov 21 signature."], ["Have Sasha check the numbers first", "Finances has the multi-site discount rules."]])}`) +
  me("Have Sasha check it, then send it today.") +
  jori(`Sasha will check the numbers by noon, and the send is on your list for 2 PM. The renewal stays on track for the 21st.`, { avatar: true }));
const wReview = chat("Monday 7:45 AM",
  jori(`The renewal-quote calculator now prices multiple sites with the volume discount. Root cause of the old gap: the Atlanta tier was dropped on multi-site quotes. Tested against the last four quotes.
<div class="linkcard"><div class="ic">PR</div><div><b>Multi-site pricing in the quote calculator</b><span>Draft pull request · ready for your review</span></div></div>`, { avatar: true }) +
  me("Looks good. Merge it after lunch.") +
  jori(`Merging at 1. I'll watch the first live quotes and tell you if anything looks off.`, { avatar: true }));

// An inbox where every email comes from the role that sent it, as email-send
// does for mail to the user (From "Sasha (Finances)", system/org.md), in a
// generic mail-client layout.
const MAIL_CSS = `
* { box-sizing:border-box; margin:0; }
body { font:15px/1.4 -apple-system, system-ui, sans-serif; color:#1d1c1d; background:#fff; -webkit-font-smoothing:antialiased; display:flex; height:100vh; }
.side { width:220px; background:#f6f7f9; border-right:1px solid #e3e5e8; padding:18px 12px; flex:none; }
.side .new { background:#2f5bd3; color:#fff; font-weight:600; border-radius:12px; padding:10px 14px; margin-bottom:14px; text-align:center; }
.side div.f { padding:6px 10px; border-radius:8px; font-size:14.5px; display:flex; justify-content:space-between; }
.side div.f.on { background:#e1e7f8; font-weight:600; }
.main { flex:1; min-width:0; }
.bar { padding:14px 22px; border-bottom:1px solid #e3e5e8; font-weight:700; font-size:18px; }
.mrow { display:grid; grid-template-columns:250px 1fr 70px; gap:14px; align-items:baseline; padding:12px 22px; border-bottom:1px solid #eef0f3; }
.mrow.unread b, .mrow.unread .who { font-weight:700; }
.mrow .who { font-size:14.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mrow .who small { color:#6b6f76; font-size:13.5px; font-weight:400; }
.mrow .t { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mrow .t b { font-weight:600; }
.mrow .t span { color:#6b6f76; }
.mrow time { color:#6b6f76; font-size:13px; text-align:right; }
`;
const mrow = (role, subj, snip, time, unread = true) => {
  const [, name, title] = role.match(/^(.*?) \((.*)\)$/);
  return `<div class="mrow${unread ? " unread" : ""}"><div class="who">${name} <small>(${title})</small></div><div class="t"><b>${subj}</b> <span>— ${snip}</span></div><time>${time}</time></div>`;
};
const inboxDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${MAIL_CSS}</style></head><body>
<div class="side"><div class="new">Compose</div><div class="f on"><span>Inbox</span><span>9</span></div><div class="f"><span>Starred</span></div><div class="f"><span>Sent</span></div><div class="f"><span>Clients</span></div><div class="f"><span>Finance</span></div></div>
<div class="main"><div class="bar">Inbox</div>
${mrow("Jori (Chief of Staff)", "Your projects this week", "7 done, 1 slipping, the Harbor & Pine contract due Friday", "9:00 AM")}
${mrow("Eden (Travel)", "Chicago, Nov 18", "The 7 AM flight is held and the hotel is 4 minutes from Harbor & Pine", "8:41 AM")}
${mrow("Jori (Chief of Staff)", "Your day", "3 meetings, a 90-minute focus block, Priya's reply drafted", "8:15 AM")}
${mrow("Sasha (Finances)", "Month-end close", "Two client invoices 30+ days late; reminders drafted", "8:02 AM")}
${mrow("Dani (Social)", "Priya's birthday is Monday", "A card from you and Leo is drafted, and a lunch idea for after the signing", "Fri")}
${mrow("Alex (Product)", "Work ready for your review", "The renewal-quote calculator now handles multi-site pricing. Draft PR inside", "Thu", false)}
${mrow("Kim (Marketing)", "Case study draft: Harbor & Pine", "Ready for your edits before it goes to Priya for approval", "Thu", false)}
${mrow("Alex (Product)", "Two laptops need the security update", "Leo's and Maria's; the patch closes a browser exploit", "Wed", false)}
${mrow("Jules (Health)", "Your week", "Thursday is five meetings back to back; your run moved to 7 AM", "Mon", false)}
</div></body></html>`;

// ── Stamp ───────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const stamp = crypto.createHash("sha256")
  .update([wikiHome, wikiAnswer, wikiPage, appDoc([chatThread]), appDoc([approval]), workPerson, workMeeting, workProject, appDoc([workAfterMeeting]), appDoc([workFollowUps]), slackDoc, appDoc([workEmail]), appDoc([workSchedule]), moneyPage, ...[pMoney, pTrip, pDinner, pTickets, pHome].map((x) => appDoc([x])), projectPage, appDoc([pSlip, pWork]), appDoc([wSlip, wReview]), inboxDoc, appDoc([teamList, groupThread]), JSON.stringify(TEAM), FRAME_CSS, fs.readFileSync(__filename, "utf8")].join("\u0000"))
  .digest("hex");
if (CHECK) {
  let have = "";
  try { have = fs.readFileSync(STAMP, "utf8").trim(); } catch {}
  if (have === stamp) process.exit(0);
  console.error("screenshots are stale: run node scripts/screenshots/build.cjs");
  process.exit(1);
}

// Work screens live in the conversation of the role that owns the work.
// The chief of staff owns the inbox, calendar, meetings and follow-ups.
const ALEX = (x) => asRole(x, "alex", "Alex", "Product");

fs.mkdirSync(OUT, { recursive: true });
const raw = {
  home: shoot(wikiHome, "raw-wiki-home", 1280, 900),
  answer: shoot(wikiAnswer, "raw-wiki-answer", 1280, 900),
  page: shoot(wikiPage, "raw-wiki-page", 1280, 900),
  chat: shoot(appDoc([chatThread]), "raw-app-chat", 610, 1060, { transparent: true }),
  approval: shoot(appDoc([approval]), "raw-app-approval", 610, 1060, { transparent: true }),
  workPerson: shoot(workPerson, "raw-work-person", 1280, 900),
  workMeeting: shoot(workMeeting, "raw-work-meeting", 1280, 900),
  workProject: shoot(workProject, "raw-work-project", 1280, 900),
  workMeetingApp: shoot(appDoc([asCos(workAfterMeeting)]), "raw-work-app-meeting", 610, 1060, { transparent: true }),
  workFollowApp: shoot(appDoc([asCos(workFollowUps)]), "raw-work-app-followups", 610, 1060, { transparent: true }),
  money: shoot(moneyPage, "raw-money", 1280, 900),
  slack: shoot(slackDoc, "raw-work-slack", 1280, 860),
  project: shoot(projectPage, "raw-project-tasks", 1280, 900),
  inbox: shoot(inboxDoc, "raw-work-team-inbox", 1280, 600),
};
const URL = "memory.example.com";
const out = {
  "wiki-home.png": shoot(frameDoc(browser(raw.home, URL)), "wiki-home", 1460, 1120, { transparent: true }),
  "wiki-answer.png": shoot(frameDoc(browser(raw.answer, `${URL}/search`)), "wiki-answer", 1460, 1120, { transparent: true }),
  "wiki-page.png": shoot(frameDoc(browser(raw.page, `${URL}/p/project_lisbon_trip`, true)), "wiki-page", 1460, 1120, { transparent: true }),
  "app-chat.png": raw.chat,
  "app-approval.png": raw.approval,
  "app-pair.png": shoot(appDoc([chatThread, approval]), "app-pair", 1096, 1060, { transparent: true }),
  "work-person.png": shoot(frameDoc(browser(raw.workPerson, `${URL}/p/person_priya_natarajan`)), "work-person", 1460, 1120, { transparent: true }),
  "work-meeting.png": shoot(frameDoc(browser(raw.workMeeting, `${URL}/p/meeting_2026-10-28_harbor_pine_qbr`, true)), "work-meeting", 1460, 1120, { transparent: true }),
  "work-project.png": shoot(frameDoc(browser(raw.workProject, `${URL}/p/project_harbor_pine_renewal`)), "work-project", 1460, 1120, { transparent: true }),
  "work-app-meeting.png": raw.workMeetingApp,
  "work-app-followups.png": raw.workFollowApp,
  "work-app-pair.png": shoot(appDoc([asCos(workAfterMeeting), asCos(workFollowUps)]), "work-app-pair", 1096, 1060, { transparent: true }),
  "work-showcase.png": shoot(frameDoc(`<div class="show">${browser(raw.workPerson, URL)}<div class="ph"><img src="${raw.workFollowApp}"></div></div>`), "work-showcase", 1700, 1180, { transparent: true }),
  "work-slack.png": shoot(frameDoc(appWin(raw.slack, "Fieldstone · #harbor-pine")), "work-slack", 1460, 1080, { transparent: true }),
  "work-app-email-schedule.png": shoot(appDoc([asCos(workEmail), asCos(workSchedule)]), "work-app-email-schedule", 1096, 1060, { transparent: true }),
  "personal-money.png": shoot(frameDoc(browser(raw.money, `${URL}/p/money_2026-11`)), "personal-money", 1460, 1120, { transparent: true }),
  "personal-app-money-home.png": shoot(appDoc([pMoney, pHome]), "personal-app-money-home", 1096, 1060, { transparent: true }),
  "personal-app-trip-dinner.png": shoot(appDoc([pTrip, pDinner]), "personal-app-trip-dinner", 1096, 1060, { transparent: true }),
  "personal-app-tickets.png": shoot(appDoc([pTickets]), "personal-app-tickets", 610, 1060, { transparent: true }),
  "personal-project-tasks.png": shoot(frameDoc(browser(raw.project, `${URL}/p/project_kitchen_reno`)), "personal-project-tasks", 1460, 1120, { transparent: true }),
  "personal-app-projects.png": shoot(appDoc([pSlip, pWork]), "personal-app-chief-of-staff", 1096, 1060, { transparent: true }),
  "work-team-inbox.png": shoot(frameDoc(appWin(raw.inbox, "Mail · Inbox")), "work-team-inbox", 1460, 820, { transparent: true }),
  "work-app-chief-of-staff.png": shoot(appDoc([asCos(wSlip), ALEX(wReview)]), "work-app-chief-of-staff", 1096, 1060, { transparent: true }),
  "work-app-team.png": shoot(appDoc([teamList, groupThread]), "work-app-team", 1096, 1060, { transparent: true }),
  "showcase.png": shoot(frameDoc(`<div class="show">${browser(raw.home, URL)}<div class="ph"><img src="${raw.chat}"></div></div>`), "showcase", 1700, 1180, { transparent: true }),
};
for (const [name, src] of Object.entries(out)) fs.copyFileSync(src, path.join(OUT, name));
if (OUT === path.dirname(STAMP)) fs.writeFileSync(STAMP, stamp + "\n");
console.log(`wrote ${Object.keys(out).length} images to ${path.relative(ROOT, OUT)} (work dir ${WORK})`);
