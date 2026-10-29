// Regression guard for bin/photos-sync-gaps.
//
// Defends against the failure this binary exists to stop: a photos sync that
// fails for one day (two 600s osxphotos timeouts on 2026-08-08) is never
// retried by anything, so the day is lost permanently — 2026-08-07 sat at zero
// rows between two healthy days for days until the user noticed the
// system-channel alert and asked for a manual re-run by hand.
//
// And against the way this binary made that worse on 2026-08-14: the give-up
// budget counted errors as well as clean-but-empty scans, so four dates
// (08-07/09/11/12) that kept erroring were retired after two tries and never
// attempted again. An error is not evidence that a day has no photos.
//
// The osxphotos half is not exercised here (a real scan takes minutes); the
// binary's --counts-json / --photos-bin hooks stand in for Supabase and for
// `photos sync` so the gap-selection and ledger logic are testable offline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = process.env.PHOTOS_SYNC_GAPS_BIN || join(HERE, "..", "bin", "photos-sync-gaps");

const dayOffset = (n) => {
  const d = new Date(Date.now() - n * 86400000 - 4 * 3600000);
  return d.toISOString().slice(0, 10);
};

function scratch() {
  return mkdtempSync(join(tmpdir(), "photos-gaps-"));
}

// A stand-in for `photos sync --date D` that always reports `count` items.
function stubPhotos(dir, count, { exitCode = 0 } = {}) {
  const p = join(dir, "photos-stub");
  writeFileSync(p, `#!/bin/sh\necho '{"date":"'"$3"'","count":${count}}'\nexit ${exitCode}\n`);
  chmodSync(p, 0o755);
  return p;
}

// A stand-in that reproduces what `photos sync` ACTUALLY prints on the
// success-with-photos path: `cmd_sync` ends in `json.dumps({...}, indent=2)`, so
// stdout is PRETTY-PRINTED multi-line JSON whose last line is just "}", with the
// progress lines on stderr. It calls the same json.dumps rather than pasting a
// literal, so the fixture cannot drift from the producer.
function stubPhotosPretty(dir, count) {
  const p = join(dir, "photos-stub-pretty");
  writeFileSync(p, [
    "#!/bin/sh",
    'echo "[sync] $3 - querying Apple Photos..." >&2',
    `echo "[sync] ${count} media items" >&2`,
    "exec python3 -c 'import json,sys; n=int(sys.argv[2]); "
      + 'print(json.dumps({"date": sys.argv[1], "count": n, "stats": '
      + '{"exact_time": n, "time+gps": 0, "gps_only": 0, "unmatched": 0}}, indent=2))\' '
      + `"$3" "${count}"`,
    "",
  ].join("\n"));
  chmodSync(p, 0o755);
  return p;
}

// Exit 0 but output that is genuinely not JSON at all.
function stubPhotosGarbage(dir) {
  const p = join(dir, "photos-stub-garbage");
  writeFileSync(p, "#!/bin/sh\necho 'Segmentation fault'\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

function run(args, { counts, ledgerPath, photosBin, rendered }) {
  const dir = dirname(ledgerPath);
  const countsPath = join(dir, "counts.json");
  writeFileSync(countsPath, JSON.stringify(counts));
  const argv = ["--counts-json", countsPath, "--ledger", ledgerPath, ...args];
  if (photosBin) argv.push("--photos-bin", photosBin);
  if (rendered) {
    const rp = join(dir, "rendered.json");
    writeFileSync(rp, JSON.stringify(rendered));
    argv.push("--rendered-json", rp);
  }
  return JSON.parse(execFileSync(BIN, argv, { encoding: "utf8" }));
}

test("a day with zero rows in the window is a catch-up candidate", () => {
  const dir = scratch();
  const missing = dayOffset(4);
  const counts = { [dayOffset(1)]: 12, [dayOffset(2)]: 8, [dayOffset(3)]: 20, [missing]: 0 };
  const out = run(["--dry-run", "--days", "8"], { counts, ledgerPath: join(dir, "l.json") });
  assert.ok(out.candidates.includes(missing), "missing day should be picked up");
});

test("a day that already has rows is never re-synced", () => {
  const dir = scratch();
  const healthy = dayOffset(2);
  const out = run(["--dry-run", "--days", "4"], {
    counts: { [healthy]: 34 }, ledgerPath: join(dir, "l.json"),
  });
  assert.ok(!out.candidates.includes(healthy));
});

test("--max bounds how many days one invocation will re-sync", () => {
  const dir = scratch();
  const out = run(["--dry-run", "--days", "8", "--max", "2"], {
    counts: {}, ledgerPath: join(dir, "l.json"),
  });
  assert.equal(out.candidates.length, 8, "all eight empty days are candidates");
  assert.equal(out.would_resync.length, 2, "but only --max of them run");
  assert.deepEqual(out.would_resync, out.candidates.slice(0, 2), "oldest first");
});

test("a genuinely photo-free day settles after --tries and stops costing scans", () => {
  const dir = scratch();
  const ledgerPath = join(dir, "l.json");
  const photosBin = stubPhotos(dir, 0); // sync succeeds, finds nothing
  const counts = {};

  for (let i = 0; i < 2; i++) {
    const out = run(["--days", "1", "--max", "1", "--tries", "2"], { counts, ledgerPath, photosBin });
    assert.equal(out.resynced.length, 1, `attempt ${i + 1} should still run`);
  }
  const settled = run(["--dry-run", "--days", "1", "--tries", "2"], { counts, ledgerPath });
  assert.equal(settled.candidates.length, 0, "third night must not re-scan a settled empty day");
});

test("a recovered day is cleared from the ledger, so a later failure starts fresh", () => {
  const dir = scratch();
  const ledgerPath = join(dir, "l.json");
  const photosBin = stubPhotos(dir, 13); // the transient condition has passed
  const out = run(["--days", "1", "--max", "1"], { counts: {}, ledgerPath, photosBin });

  assert.equal(out.recovered, 1);
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.deepEqual(Object.keys(ledger.dates), [], "recovered date leaves no exhausted try count behind");
});

test("a failing `photos sync` is recorded, not swallowed, and still exits 0", () => {
  const dir = scratch();
  const ledgerPath = join(dir, "l.json");
  const photosBin = stubPhotos(dir, 0, { exitCode: 1 });
  const out = run(["--days", "1", "--max", "1"], { counts: {}, ledgerPath, photosBin });

  assert.equal(out.ok, true, "the catch-up must never fail the job around it");
  assert.equal(out.resynced[0].ok, false);
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const entry = Object.values(ledger.dates)[0];
  assert.equal(entry.result, "failed");
  assert.equal(entry.fail_tries, 1);
  assert.equal(entry.tries ?? 0, 0, "an error must not spend the give-up budget");
});

test("a date that keeps ERRORING is never retired, however many nights it fails", () => {
  const dir = scratch();
  const ledgerPath = join(dir, "l.json");
  const photosBin = stubPhotos(dir, 0, { exitCode: 1 });

  // Four nights of the sandbox -2741 in a row. Under the old rule the date was
  // blacklisted after two and the day was lost for good.
  for (let n = 0; n < 4; n++) {
    run(["--days", "1", "--max", "1", "--tries", "2"], { counts: {}, ledgerPath, photosBin });
  }
  const still = run(["--dry-run", "--days", "1", "--tries", "2"], { counts: {}, ledgerPath });
  assert.equal(still.candidates.length, 1, "a failing date stays a candidate for the next sweep");

  // And once the underlying condition clears, the date recovers normally.
  const out = run(["--days", "1", "--max", "1", "--tries", "2"],
    { counts: {}, ledgerPath, photosBin: stubPhotos(dir, 7) });
  assert.equal(out.recovered, 1);
});

// ── the parse: the producer pretty-prints, so LAST-LINE parsing inverted every
// successful recovery into a failure (found 2026-09-30) ─────────────────────────
//
// `_resync` read `r.stdout.strip().splitlines()[-1]`. `photos sync`'s
// success-with-photos path is `json.dumps({...}, indent=2)`, so the last line of
// stdout is "}" and `json.loads` raised — every genuine recovery was banked as
// `result: "failed"` with `detail: "unparseable output from photos sync"`,
// `fail_tries` climbed, and the `result: "recovered"` branch was unreachable dead
// code from the day the sweep shipped (2026-08-11). Only the zero-photos path
// prints single-line JSON, which is exactly why empty days parsed fine and
// recovered days never did.
//
// Live proof: the 2026-09-30 07:02:35Z and 07:03:26Z sweeps inserted 4 and 125
// photo rows (photos.synced_at confirms) and the ledger recorded both as
// failures ~200ms later. Defends the alert "photos sync failed for <date>" and
// the ledger detail "unparseable output from photos sync".
// Cluster: sic-20260930-gap-sweep-inverts-success.

test("the pretty-printed JSON `photos sync` really emits is read as a SUCCESS", () => {
  const dir = scratch();
  const ledgerPath = join(dir, "l.json");
  const out = run(["--days", "1", "--max", "1"], {
    counts: {}, ledgerPath, photosBin: stubPhotosPretty(dir, 125),
  });

  assert.equal(out.resynced.length, 1, "the date should have been attempted");
  assert.equal(out.resynced[0].ok, true,
    "multi-line output is the producer's normal success shape, not a failure");
  assert.equal(out.resynced[0].count, 125, "the recovered row count must survive the parse");
  assert.equal(out.resynced[0].detail, "");
  assert.equal(out.recovered, 1, 'the result:"recovered" branch must be reachable');

  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.deepEqual(Object.keys(ledger.dates), [],
    "a recovered date must leave no failure or fail_tries behind");
});

test("the single-line zero-photo payload still reads as a clean EMPTY scan", () => {
  // The other half of cmd_sync prints `json.dumps({"date":..,"count":0})` on one
  // line. That path always parsed; it must keep parsing, and must stay `empty`
  // (which spends the --tries budget) rather than becoming `failed`.
  const dir = scratch();
  const ledgerPath = join(dir, "l.json");
  const out = run(["--days", "1", "--max", "1"], {
    counts: {}, ledgerPath, photosBin: stubPhotos(dir, 0),
  });

  assert.equal(out.resynced[0].ok, true);
  assert.equal(out.resynced[0].count, 0);
  const entry = Object.values(JSON.parse(readFileSync(ledgerPath, "utf8")).dates)[0];
  assert.equal(entry.result, "empty", "a genuinely photo-free day is not a failure");
  assert.equal(entry.tries, 1);
  assert.equal(entry.fail_tries ?? 0, 0);
});

test("output that is genuinely not JSON keeps the exact `unparseable` detail", () => {
  // The detail string is matched by log/ledger readers, so widening the parse
  // must not rename or drop the real unparseable case.
  const dir = scratch();
  const ledgerPath = join(dir, "l.json");
  const out = run(["--days", "1", "--max", "1"], {
    counts: {}, ledgerPath, photosBin: stubPhotosGarbage(dir),
  });

  assert.equal(out.resynced[0].ok, false);
  assert.equal(out.resynced[0].detail, "unparseable output from photos sync");
  const entry = Object.values(JSON.parse(readFileSync(ledgerPath, "utf8")).dates)[0];
  assert.equal(entry.result, "failed");
  assert.equal(entry.fail_tries, 1);
  assert.equal(entry.tries ?? 0, 0, "an unparseable run is an error, not an empty day");
});

test("the binary is present and executable where the playbook calls it", () => {
  assert.ok(existsSync(BIN), `${BIN} missing`);
});

// ── the second question: rows landed, did the day record pick them up? ──────
//
// 2026-08-07/09/11/12/13 held 96 photo rows between them while every one of
// those day records reported zero photos. The sync half was working by then —
// the rows are right there — so nothing in the system read those dates as
// anything but healthy.

test("photos in the DB that the day record never rendered are reported", () => {
  const dir = scratch();
  const broken = dayOffset(3);
  const out = run(["--dry-run", "--days", "8"], {
    counts: { [broken]: 29 },
    rendered: { [broken]: { stops: 6, photos_count: 0, synced_after_render: true } },
    ledgerPath: join(dir, "l.json"),
  });
  assert.deepEqual(out.stale_render, [{ date: broken, photo_rows: 29, stops: 6 }]);
  assert.ok(!out.candidates.includes(broken), "it has rows — re-syncing it would be a no-op");
});

test("a day that rendered its photos is not reported", () => {
  const dir = scratch();
  const healthy = dayOffset(2);
  const out = run(["--dry-run", "--days", "4"], {
    counts: { [healthy]: 34 },
    rendered: { [healthy]: { stops: 11, photos_count: 23 } },
    ledgerPath: join(dir, "l.json"),
  });
  assert.deepEqual(out.stale_render, []);
});

test("photos_count < rows is normal and must NOT be reported", () => {
  // photos_count counts photos matched to a stop, not photo rows: transit shots
  // and unresolved locations never enter it. 2026-08-10 legitimately carries 13
  // rows and 9 rendered. Flagging that shape would have queued 48 healthy days.
  const dir = scratch();
  const d = dayOffset(2);
  const out = run(["--dry-run", "--days", "4"], {
    counts: { [d]: 13 },
    rendered: { [d]: { stops: 7, photos_count: 9 } },
    ledgerPath: join(dir, "l.json"),
  });
  assert.deepEqual(out.stale_render, []);
});

test("a day that was never rendered at all is left to the blank-day watchdog", () => {
  const dir = scratch();
  const d = dayOffset(2);
  const out = run(["--dry-run", "--days", "4"], {
    counts: { [d]: 21 },
    rendered: { [d]: { stops: 0, photos_count: 0 } },
    ledgerPath: join(dir, "l.json"),
  });
  assert.deepEqual(out.stale_render, [], "no stops means nothing was rendered — a different failure");
});

test("a date with no day record at all is not reported", () => {
  const dir = scratch();
  const d = dayOffset(2);
  const out = run(["--dry-run", "--days", "4"], {
    counts: { [d]: 21 }, rendered: {}, ledgerPath: join(dir, "l.json"),
  });
  assert.deepEqual(out.stale_render, []);
});

test("the finding is recorded in the ledger, and clears once the day is re-rendered", () => {
  const dir = scratch();
  const ledgerPath = join(dir, "l.json");
  const d = dayOffset(3);

  run(["--dry-run", "--days", "8"], {
    counts: { [d]: 29 }, rendered: { [d]: { stops: 6, photos_count: 0, synced_after_render: true } }, ledgerPath,
  });
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).stale_render.length, 1);

  run(["--dry-run", "--days", "8"], {
    counts: { [d]: 29 }, rendered: { [d]: { stops: 6, photos_count: 29 } }, ledgerPath,
  });
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).stale_render, undefined,
    "a repaired day leaves nothing behind in the ledger");
});

test("the render check never turns a stale-render day into a re-sync", () => {
  // The expensive mistake would be answering "the day page has no photos" with
  // an osxphotos scan of a date whose rows are already in.
  const dir = scratch();
  const d = dayOffset(2);
  const photosBin = stubPhotos(dir, 0);
  const out = run(["--days", "4", "--max", "2"], {
    counts: { [d]: 29 }, rendered: { [d]: { stops: 6, photos_count: 0, synced_after_render: true } },
    ledgerPath: join(dir, "l.json"), photosBin,
  });
  assert.ok(!out.resynced.some((r) => r.date === d));
  assert.equal(out.stale_render.length, 1);
});

test("offline runs skip the render check rather than reaching the network", () => {
  const dir = scratch();
  const out = run(["--dry-run", "--days", "4"], {
    counts: { [dayOffset(2)]: 5 }, ledgerPath: join(dir, "l.json"),
  });
  assert.deepEqual(out.stale_render, [], "no --rendered-json means no render opinion");
});

test("a day whose stops carry no `photos` key at all is NOT flagged", () => {
  // The regression that matters most. An earlier version derived the count by
  // summing resolved_day_json.stops[].photos. Real records do not all carry
  // that key: 2026-08-04 has 11 stops shaped {end, guessed_name, id, place,
  // start} and its own photos_count is 11. Summing reads that as zero and
  // flags a healthy day — and the flag reads "re-render this", which would
  // put a claude -p pass over a record holding hand-made corrections.
  const dir = scratch();
  const d = dayOffset(2);
  const out = run(["--dry-run", "--days", "4"], {
    counts: { [d]: 12 },
    rendered: { [d]: { stops: 11, photos_count: 11 } },
    ledgerPath: join(dir, "l.json"),
  });
  assert.deepEqual(out.stale_render, [], "photos_count is the signal, not the JSON shape");
});

test("an unknown photos_count is not treated as zero", () => {
  const dir = scratch();
  const d = dayOffset(2);
  const out = run(["--dry-run", "--days", "4"], {
    counts: { [d]: 12 },
    rendered: { [d]: { stops: 9, photos_count: null } },
    ledgerPath: join(dir, "l.json"),
  });
  assert.deepEqual(out.stale_render, [], "null is missing information, not a zero");
});

test("the render check reaches back further than the re-sync window", () => {
  // At the shipped --days 8, 2026-08-07 and 08-09 — 51 of the 96 photos that
  // motivated this — had already aged out and could never be reported. The
  // render check is two REST reads; the re-sync half is minutes of osxphotos,
  // so only the cheap half looks back.
  const dir = scratch();
  const old = dayOffset(20);
  const out = run(["--dry-run", "--days", "8"], {
    counts: { [old]: 30 },
    rendered: { [old]: { stops: 11, photos_count: 0, synced_after_render: true } },
    ledgerPath: join(dir, "l.json"),
  });
  assert.equal(out.stale_render.length, 1, "20 days back is still reported");
  assert.equal(out.stale_render[0].date, old);
  assert.ok(!out.candidates.includes(old), "but it never becomes an osxphotos scan");
  assert.deepEqual(out.window, [dayOffset(8), dayOffset(1)], "the re-sync window is unchanged");
});

test("a day that rendered correctly and simply had nothing to place is NOT flagged", () => {
  // photos_count == 0 alone is not the condition. A photo with no coordinates
  // can never match a stop, so a day whose photos were all ungeotagged sits at
  // zero forever and re-rendering it changes nothing. Ten such days sit just
  // outside the 45-day window today by calendar luck alone; they must not
  // become "re-render this" the week they drift back in.
  const dir = scratch();
  const d = dayOffset(2);
  const out = run(["--dry-run", "--days", "4"], {
    counts: { [d]: 3 },
    rendered: { [d]: { stops: 9, photos_count: 0, synced_after_render: false } },
    ledgerPath: join(dir, "l.json"),
  });
  assert.deepEqual(out.stale_render, [], "the photos were already there when it rendered");
});

test("the repair this detector prescribes must be able to clear it", () => {
  // The stale-render check above reads daily_summaries.updated_at as "when this
  // day was last rendered", and tells the reader to fix a flagged day by running
  // `daily-summary-run <date>` — which republishes through daily-summary-build's
  // `publish` upsert. That column is NOT NULL DEFAULT now() with no trigger on
  // the table, so the default fires on INSERT only. If the upsert body omits
  // updated_at, clearing falls to the playbook's agent-executed Step 5.1 SQL,
  // which is skipped often enough to matter — on 2026-08-20 it landed for 3 of 8
  // re-rendered dates, and the 5 it missed stayed frozen with
  // synced_at > rendered_at still true, so they were reported again.
  // That is not hypothetical — on 2026-08-19 and 2026-08-20 the identical 8
  // dates each forked their own `claude -p` session in the same second, feeding
  // the recurring "daily-summary-run did NOT run" system-channel alerts.
  //
  // Asserted at the source rather than against a live DB: the write is one
  // PostgREST call with no seam to stub, and the property that matters is simply
  // that the body names the column. String scanning, not regex — the target is
  // machine-written code, but there is no reason to reach for a pattern here.
  const src = readFileSync(join(HERE, "..", "bin", "daily-summary-build"), "utf8");
  const upsert = src.indexOf("/rest/v1/daily_summaries?on_conflict=date");
  assert.ok(upsert > 0, "publish upsert not found — did daily-summary-build move?");
  const bodyStart = src.lastIndexOf("const body = {", upsert);
  assert.ok(bodyStart > 0, "publish body literal not found ahead of the upsert");
  assert.ok(src.slice(bodyStart, upsert).includes("updated_at"),
    "daily-summary-build's publish upsert must stamp updated_at explicitly; "
    + "DEFAULT now() does not fire on UPDATE, so without it a re-render can "
    + "never clear a stale_render finding and it re-fans-out nightly forever");
});

test("a degraded day-record read must not erase the findings already banked", () => {
  // `rendered` is {} both when the daily_summaries read fails and when we are
  // offline. Clearing the ledger on that deletes every finding on one flaky
  // night — precisely what the ledger exists to survive.
  const dir = scratch();
  const ledgerPath = join(dir, "l.json");
  const d = dayOffset(3);

  run(["--dry-run", "--days", "8"], {
    counts: { [d]: 29 },
    rendered: { [d]: { stops: 6, photos_count: 0, synced_after_render: true } },
    ledgerPath,
  });
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).stale_render.length, 1);

  run(["--dry-run", "--days", "8"], { counts: { [d]: 29 }, ledgerPath });  // no --rendered-json
  assert.equal(JSON.parse(readFileSync(ledgerPath, "utf8")).stale_render.length, 1,
    "a night the check could not run leaves the finding standing");
});
