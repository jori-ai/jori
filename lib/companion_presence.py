"""Who was with the user, read from Find My against the user's own GPS trail.

A day's summary kept asking whether a companion was with the user first thing
before coffee and on an evening walk, when the answer was "together all day":
the only Find My check had been the stop finder's one look whenever a visit row
happened to be enriched, skipped at home, never on a walk, and blind to anyone
who had already left. So most stops had no companion source and the reviewer,
told that a companion is usually there, kept flagging the companion's absence.

`bin/companion-presence` samples every shared person's Find My device every
10 minutes (`findme presence-sample`) and keeps the raw readings for 3 days. Each
run then reconciles: every reading is compared with where the USER's trail puts
the user at the reading's own timestamp, once that trail has arrived (deferred
upload has run 187-205 min late, so a reading with no evidence on both sides of
it yet stays undecided and is looked at again next run). This module is that
comparison and the rule that turns it into `location_history.companions` on the
user's visit rows, which resolve-day already merges onto the day's stops.

Geometry only (Rule #0b): two GPS trails and their distance. No words are read.

Rules, in order of how much they matter:
- A person is added to a row only when the readings say together for at least
  half the row, and NO reading inside it (5 min from either edge) says apart. A
  long row at the flat with a solo walk out of it is left alone rather than
  tagged, since resolve-day can carve the walk out of that row and would carry
  the name onto it.
- It never removes a name it did not add. A name the user's words or photos put on a
  row stays.
- An open row (no departure yet) needs 30 observed minutes at 80% cover, and the
  name stays provisional: if a reading inside the row later says apart (the person left,
  the user stayed), it is taken back off (`review_provisional`).
- A visit row places the user only when none of the user's own fixes nearby disagrees.
"""

import bisect
import math
from datetime import datetime, timezone

MIN = 60_000

SAMPLE_REACH_MS = 8 * MIN          # one reading stands for +-8 min (sampled every 10)
FIX_ACC_MAX_M = 150                # the user's transit fixes worse than this carry no position
PERSON_ACC_MAX_M = 300             # a Find My reading worse than this decides nothing
NEAR_FIX_MS = 5 * MIN              # interpolate between the user's fixes this close on each side
ONE_SIDED_MS = 3 * MIN             # or use one fix this close, widened by walking pace
STILL_GAP_MS = 8 * 60 * MIN        # two fixes this far apart in time ...
STILL_SPREAD_M = 100               # ... but this close in space: the user stayed (silence is stillness)
WALK_MPS = 1.4
MAX_MPS = 40.0
VISIT_UNC_MIN_M, VISIT_UNC_MAX_M = 20, 150
VISIT_CHECK_MS = 10 * MIN          # a fix this close to the reading ...
VISIT_CONTRADICT_M = 200           # ... and this far from the visit row: the row doesn't place the user

TOGETHER_MIN_M = 100               # together within max(100 m, combined uncertainty) ...
TOGETHER_MAX_M = 200               # ... capped at 200 m (the next café is not "together")
TOGETHER_COMBINED_MAX_M = 300      # never together when the two positions are this vague
APART_MIN_M = 400                  # apart beyond max(400 m, 2x combined uncertainty)

ROW_EDGE_MS = 5 * MIN              # arrival/departure skew between two phones
ROW_MIN_COVER = 0.5
OPEN_ROW_MIN_MS = 30 * MIN
OPEN_ROW_MIN_COVER = 0.8
SETTLE_AFTER_MS = 6 * 60 * MIN     # a provisional name on a closed row stays reviewable this long
LONG_ROW_MS = 30 * MIN             # a row longer than this needs two readings, not one

STRETCH_GAP_MS = 30 * MIN          # a missed tick or two does not split a stretch
STRETCH_PAD_MS = 5 * MIN


def parse_ms(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# ── the user's trail ────────────────────────────────────────────────────────────────

def fixes_from_rows(rows):
    """His transit fixes with a usable position, oldest first."""
    out = []
    for r in rows or []:
        if r.get("segment_type") != "transit":
            continue
        t = parse_ms(r.get("arrived_at"))
        acc = r.get("accuracy_m")
        acc = 50.0 if acc is None else float(acc)
        if t is None or r.get("latitude") is None or acc > FIX_ACC_MAX_M:
            continue
        out.append({"t": t, "lat": float(r["latitude"]), "lon": float(r["longitude"]), "acc": acc})
    out.sort(key=lambda f: f["t"])
    return out


def visit_spans(rows):
    """Closed visit rows as positions over time. A `non-stop` row describes a walk;
    its point is the walk's middle, not where the user was, so it never places the user."""
    out = []
    for r in rows or []:
        if r.get("segment_type") != "visit" or r.get("place_type") == "non-stop":
            continue
        t0, t1 = parse_ms(r.get("arrived_at")), parse_ms(r.get("departed_at"))
        if t0 is None or t1 is None or t1 <= t0 or r.get("latitude") is None:
            continue
        acc = r.get("accuracy_m")
        acc = 50.0 if acc is None else float(acc)
        out.append({"t0": t0, "t1": t1, "lat": float(r["latitude"]), "lon": float(r["longitude"]),
                    "unc": min(VISIT_UNC_MAX_M, max(VISIT_UNC_MIN_M, acc))})
    return out


def _pace(fixes, i):
    """His speed around fix i, from its nearest neighbour within 10 min."""
    best = None
    for j in (i - 1, i + 1):
        if 0 <= j < len(fixes):
            dt = abs(fixes[j]["t"] - fixes[i]["t"]) / 1000
            if 0 < dt <= 600:
                v = haversine_m(fixes[i]["lat"], fixes[i]["lon"], fixes[j]["lat"], fixes[j]["lon"]) / dt
                best = v if best is None else max(best, v)
    return min(MAX_MPS, max(WALK_MPS, best or WALK_MPS))


def user_at(t, fixes, spans, _times=None):
    """Where the user's own trail puts the user at t: {lat, lon, unc_m, basis}, or None when
    the trail has no evidence on both sides of t yet."""
    times = _times if _times is not None else [f["t"] for f in fixes]
    k = bisect.bisect_left(times, t)
    a = fixes[k - 1] if k > 0 else None
    b = fixes[k] if k < len(fixes) else None
    if a and b and t - a["t"] <= NEAR_FIX_MS and b["t"] - t <= NEAR_FIX_MS:
        span = b["t"] - a["t"]
        w = 0.0 if span <= 0 else (t - a["t"]) / span
        d = haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
        return {"lat": a["lat"] + w * (b["lat"] - a["lat"]), "lon": a["lon"] + w * (b["lon"] - a["lon"]),
                "unc_m": max(a["acc"], b["acc"]) + 0.25 * d, "basis": "fixes"}
    near = [(abs(t - f["t"]), i) for f, i in ((a, k - 1), (b, k)) if f]
    if near:
        dt, i = min(near)
        if dt <= ONE_SIDED_MS:
            f = fixes[i]
            return {"lat": f["lat"], "lon": f["lon"], "unc_m": f["acc"] + _pace(fixes, i) * dt / 1000,
                    "basis": "fix"}
    # A visit row places the user only when none of the user's own fixes within
    # 10 minutes says the user was elsewhere: a solo walk inside a long row at the flat must not
    # read as "at the flat" between sparse walk fixes.
    nearby = [f for f in (a, b) if f and abs(f["t"] - t) <= VISIT_CHECK_MS]
    covering = [s for s in spans if s["t0"] <= t <= s["t1"]
                and not any(haversine_m(s["lat"], s["lon"], f["lat"], f["lon"]) > VISIT_CONTRADICT_M + f["acc"]
                            for f in nearby)]
    if covering:
        s = min(covering, key=lambda s: s["t1"] - s["t0"])
        return {"lat": s["lat"], "lon": s["lon"], "unc_m": s["unc"], "basis": "visit"}
    if a and b and b["t"] - a["t"] <= STILL_GAP_MS:
        d = haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
        if d <= STILL_SPREAD_M:
            return {"lat": (a["lat"] + b["lat"]) / 2, "lon": (a["lon"] + b["lon"]) / 2,
                    "unc_m": max(a["acc"], b["acc"]) + d / 2 + 20, "basis": "still"}
    return None


# ── one reading ──────────────────────────────────────────────────────────────

def verdict(distance_m, combined_m):
    """'together' | 'apart' | None (too close to call)."""
    if combined_m <= TOGETHER_COMBINED_MAX_M and \
            distance_m <= min(TOGETHER_MAX_M, max(TOGETHER_MIN_M, combined_m)):
        return "together"
    if distance_m > max(APART_MIN_M, 2 * combined_m):
        return "apart"
    return None


def classify(samples, fixes, spans):
    """Each Find My reading judged against the user's trail at the reading's own time.
    Readings the user's trail cannot place yet come back with verdict None and
    `placed: False`, so the next run looks again."""
    times = [f["t"] for f in fixes]
    out, seen = [], set()
    for s in samples or []:
        t = parse_ms(s.get("at"))
        acc = s.get("acc_m")
        if t is None or s.get("lat") is None or not s.get("person"):
            continue
        key = (s["person"], t)
        if key in seen:
            continue
        seen.add(key)
        row = {"person": s["person"], "t": t, "verdict": None, "placed": False}
        if acc is None or float(acc) > PERSON_ACC_MAX_M:
            out.append(row)
            continue
        pos = user_at(t, fixes, spans, times)
        if pos:
            d = haversine_m(pos["lat"], pos["lon"], float(s["lat"]), float(s["lon"]))
            combined = pos["unc_m"] + float(acc)
            row.update(placed=True, verdict=verdict(d, combined), d_m=round(d),
                       unc_m=round(combined), basis=pos["basis"])
        out.append(row)
    out.sort(key=lambda r: (r["person"], r["t"]))
    return out


# ── stretches and rows ───────────────────────────────────────────────────────

def stretches(readings, kind="together"):
    """{person: [{start, end, n}]} — runs of one verdict, padded half a tick.
    A reading of the other verdict ends a run; an undecided one does not."""
    out = {}
    by = {}
    for r in readings:
        by.setdefault(r["person"], []).append(r)
    for person, rows in by.items():
        runs, cur = [], None
        for r in sorted(rows, key=lambda r: r["t"]):
            if r.get("verdict") is None:
                continue
            if r["verdict"] != kind:
                cur = None
                continue
            if cur and r["t"] - cur["last"] <= STRETCH_GAP_MS:
                cur["last"] = r["t"]
                cur["n"] += 1
            else:
                cur = {"first": r["t"], "last": r["t"], "n": 1}
                runs.append(cur)
        if runs:
            out[person] = [{"start": c["first"] - STRETCH_PAD_MS, "end": c["last"] + STRETCH_PAD_MS,
                            "n": c["n"]} for c in runs]
    return out


def cover(t0, t1, times, reach=SAMPLE_REACH_MS):
    """Share of [t0, t1] within `reach` of one of `times`."""
    if t1 <= t0:
        return 1.0 if any(abs(x - t0) <= reach for x in times) else 0.0
    iv = sorted((max(t0, x - reach), min(t1, x + reach)) for x in times)
    total, end = 0, t0
    for a, b in iv:
        if b <= end:
            continue
        a = max(a, end)
        total += b - a
        end = b
    return total / (t1 - t0)


def judge_window(person_readings, t0, t1, open_row=False):
    """Was this person with the user across [t0, t1]? {with, cover, together, apart}."""
    together = [r["t"] for r in person_readings
                if r.get("verdict") == "together" and t0 - ROW_EDGE_MS <= r["t"] <= t1 + ROW_EDGE_MS]
    apart = [r["t"] for r in person_readings
             if r.get("verdict") == "apart" and t0 + ROW_EDGE_MS < r["t"] < t1 - ROW_EDGE_MS]
    c = cover(t0, t1, together)
    need = 2 if t1 - t0 > LONG_ROW_MS else 1
    ok = not apart and len(together) >= need and c >= (OPEN_ROW_MIN_COVER if open_row else ROW_MIN_COVER)
    if open_row and t1 - t0 < OPEN_ROW_MIN_MS:
        ok = False
    return {"with": ok, "cover": round(c, 2), "together": len(together), "apart": len(apart)}


def canonical(name, aliases):
    return aliases.get(name, name)


def row_additions(rows, readings, now_ms, aliases=None, known=None, window_start_ms=None, blocked=None):
    """The (row, person) pairs to add: [{id, person, companions, cover, open}].
    `companions` is the row's list with the additions (for display; the writer
    re-reads the row before it adds). A row that began before the readings'
    window is not judged: the apart readings from its start are no longer in
    hand. `blocked` holds (row id, person) pairs the user took off by hand."""
    aliases = aliases or {}
    blocked = blocked or set()
    by = {}
    for r in readings:
        by.setdefault(r["person"], []).append(r)
    out = []
    for row in rows or []:
        if row.get("segment_type") != "visit" or not row.get("id"):
            continue
        t0, t1 = parse_ms(row.get("arrived_at")), parse_ms(row.get("departed_at"))
        if t0 is None:
            continue
        if window_start_ms is not None and t0 < window_start_ms + ROW_EDGE_MS:
            continue
        existing = [c for c in (row.get("companions") or []) if isinstance(c, str)]
        have = {canonical(c, aliases) for c in existing}
        for person, prs in by.items():
            if person in have or (known is not None and person not in known) or (row["id"], person) in blocked:
                continue
            open_row = t1 is None
            end = t1
            if open_row:
                placed = [r["t"] for r in prs if r.get("placed") and r["t"] >= t0]
                if not placed:
                    continue
                end = min(now_ms, max(placed))
            if end < t0:
                continue
            j = judge_window(prs, t0, end, open_row=open_row)
            if j["with"]:
                existing = existing + [person]
                have.add(person)
                out.append({"id": row["id"], "person": person, "companions": list(existing),
                            "cover": j["cover"], "open": open_row,
                            "arrived_at": row.get("arrived_at"), "departed_at": row.get("departed_at")})
    return out


def review_provisional(rows, readings, provisional, now_ms):
    """Names added while a row was still open are provisional: the person may leave
    while the user stays. Each run re-reads them. Returns (withdraw, keep):
    `withdraw` [(row id, person)] where an apart reading now falls inside the row,
    `keep` {row id: [person]} still provisional. A name settles once the row has
    closed and every reading inside it is placed, or 6 h after it closed; a row
    no longer fetched (out of the window) has settled too."""
    by_row = {r["id"]: r for r in rows or [] if r.get("id")}
    by = {}
    for r in readings:
        by.setdefault(r["person"], []).append(r)
    withdraw, keep = [], {}
    for rid, persons in (provisional or {}).items():
        row = by_row.get(rid)
        if not row:
            continue
        t0, t1 = parse_ms(row.get("arrived_at")), parse_ms(row.get("departed_at"))
        if t0 is None:
            continue
        end = t1 if t1 is not None else now_ms
        for p in persons:
            inside = [r for r in by.get(p, []) if t0 + ROW_EDGE_MS < r["t"] < end - ROW_EDGE_MS]
            if any(r.get("verdict") == "apart" for r in inside):
                withdraw.append((rid, p))
            elif t1 is None or (now_ms - t1 < SETTLE_AFTER_MS and not all(r.get("placed") for r in inside)):
                keep.setdefault(rid, []).append(p)
    return withdraw, keep
