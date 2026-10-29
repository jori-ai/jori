"""place_naming — the rungs of the naming ladder that need no paid API.

One unified mechanism for auto-naming stops from frequently visited places.

WHY THIS EXISTS. Two tools were naming stops from different evidence.
`stop-identify` had the good ladder -- recurring, favorite, singular -- and it
is still the place that decides the SHAPE of a prompt. But it runs on a day
that has already been assembled. `findme enrich`, which decides what enters the
ask queue at all, knew nothing about it: it built candidates from Google Places
alone and DROPPED any stop that came back empty.

So the strongest signal in the system was not consulted at the point where
stops die. A cafe the user had confirmed twenty times still needed a paid
geocoder result just to be allowed into the queue, and while the Places budget
was blocked every such stop was dropped -- 288 "no askable stop" lines while
the answer sat in the user's own confirmation history.

These two rungs are therefore extracted here, and BOTH tools use this module, so
there is one implementation of "have we been here before" rather than two that
drift:

  recurring — the user CONFIRMED this same spot before, within RECUR_RADIUS_M
              in the last RECUR_LOOKBACK_DAYS. The user's own past answer is
              the strongest signal there is; re-asking it is noise.
  favorite  — a place the user saved (a Google Maps export, and any other
              saved-places list the installation keeps), within ASK_RADIUS_M.
              Saving it was an act of intent.

Both are FREE: one Supabase range query and local JSON files. Neither touches
Google Places, which is the point -- a blocked budget must never again be able
to make Jori forget where the user goes every week.

NAMED_LOCATIONS is here for the same reason recurring/favorite were
consolidated: it already existed, correctly, in `location-segment`'s
resolve_place ladder (rung 1, ahead of everything else) -- but `stop-identify`
was a from-scratch reimplementation of "how do we name a stop" that never
ported it. The result: a 15-20 minute stop at the user's own home got no rung-0
check at all, fell through recurring/favorite/lodging (none of which fire on a
first-ever visit) to Google-Places density, and asked the user to pick between
a doctor's office and a media company for a stop where the user never left the
apartment. A home or known-property address is not a rung that should ever
need evidence to fire -- it is definitional -- so it is the strongest signal in
this module, stronger than `recurring`.

WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not decide whether to ask.
`stop-identify` owns that, and its doctrine stands: high confidence does not
mean silent, and a name applied because the user never answered is written
`default-applied`, never `user-confirmed`. This module only reports what the
history says; the caller decides what to do about it. It reads ONLY
`user-confirmed` rows, so a `default-applied` guess (an unanswered card's
default, `findme guess`) never names a later visit.

Everything personal is the installation's own data, read at runtime:
data/named-locations.json, data/google-saved-places.json and the files in
agent/local/config/place-naming.json `extra_saved_places` (data/ file names).
All absent in a fresh install: those rungs stay quiet.
"""

import hashlib
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import places_local  # noqa: E402

REPO = places_local.install_root()
ENV_FILE = os.path.join(REPO, ".env")


def _env_file_value(name):
    try:
        with open(ENV_FILE) as fh:
            for line in fh:
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def supabase_url():
    """SUPABASE_URL (environment or .env), else https://<supabase_project>.supabase.co
    from agent/local/instance.json (JORI_SUPABASE_PROJECT overrides); "" when none."""
    url = os.environ.get("SUPABASE_URL") or _env_file_value("SUPABASE_URL")
    if url:
        return url.rstrip("/")
    project = os.environ.get("JORI_SUPABASE_PROJECT")
    if not project:
        try:
            with open(os.path.join(places_local.local_dir(), "instance.json")) as fh:
                project = (json.load(fh) or {}).get("supabase_project")
        except (OSError, ValueError):
            project = None
    return f"https://{project}.supabase.co" if project else ""


SUPABASE_URL = supabase_url()
SAVED_PLACES = places_local.data_path("google-saved-places.json")
# Further saved-places lists (data/ file names, same item shape), merged after
# the export: config place-naming.json `extra_saved_places`.
EXTRA_SAVED_PLACES = [places_local.data_path(f) for f in
                      places_local.local_config("place-naming", {"extra_saved_places": []}).get("extra_saved_places") or []]

# Kept identical to stop-identify's values on purpose: two tools disagreeing
# about what "the same spot" means is exactly the drift this module prevents.
ASK_RADIUS_M = 30.0
RECUR_RADIUS_M = 25.0
RECUR_LOOKBACK_DAYS = 180
MIN_RECUR_VOTES = 2  # one answer about one visit is not "recurring"

CONFIDENCE = {"named_location": 0.95, "recurring": 0.95, "repeat_stay": 0.9, "favorite": 0.85}

# The user's own residences and family addresses. One list, in
# data/named-locations.json. `location-segment` and `stop-identify` import it
# from this module, `findme` and `resolve-day` (lib/named-locations.js) read the
# same file, so there is exactly one list. 150m is wide on purpose: a
# multi-room house or a building with a wraparound GPS anchor can drift a stop's
# centroid well off the front door.
#
# A family home the user's records (the wiki) hold an address for goes in the
# file, with that address and coordinates from a stop the user confirmed there;
# never a geocoded guess. Otherwise a long stop at a family home comes back as
# a bare street address although the address was known all along.
NAMED_LOCATION_MATCH_M = 150.0
NAMED_LOCATIONS_FILE = places_local.data_path("named-locations.json")


def load_named_locations(path=None):
    """The entries of named-locations.json. A missing file (a fresh install) is
    no homes; an unreadable one is reported and read as empty -- naming then
    falls through to the other rungs rather than failing outright."""
    try:
        with open(path or NAMED_LOCATIONS_FILE) as fh:
            d = json.load(fh)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        print(f"place_naming: named-locations.json unreadable: {e}", file=sys.stderr)
        return []
    items = d.get("entries") if isinstance(d, dict) else d
    return [e for e in (items or [])
            if isinstance(e, dict) and e.get("name")
            and isinstance(e.get("lat"), (int, float)) and isinstance(e.get("lon"), (int, float))]


NAMED_LOCATIONS = load_named_locations()


def match_named_location(lat, lon):
    """Closest named location within NAMED_LOCATION_MATCH_M, or None."""
    best = None
    for loc in NAMED_LOCATIONS:
        d = meters(lat, lon, loc["lat"], loc["lon"])
        if d <= NAMED_LOCATION_MATCH_M and (best is None or d < best[1]):
            best = (loc, d)
    return best


# By ADDRESS. A street name and its transliteration or translation name one
# street, and nearby house numbers on the same street count as the same home;
# a model makes the name match (Rule #0b), never a regex. A home is
# also recognised by its street address: a stop up to ADDRESS_NEAR_M from its
# recorded spot, or anywhere in the timezone of an address-only home (an entry
# with `address` + `tz` and no coordinates yet). Whether the addresses name the
# same house is a model's call, made in ONE place, `bin/address-match`
# (lib/address-match.mjs), which remembers each answer. Same 500 m as
# named-locations.js ADDRESS_NEAR_M.
ADDRESS_NEAR_M = 500.0
ADDRESS_MATCH_BIN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "address-match")


def load_address_homes(path=None):
    """Entries that carry an address: with coordinates, or address-only with a
    `tz`. Mirrors named-locations.js loadAddressHomes."""
    try:
        with open(path or NAMED_LOCATIONS_FILE) as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return []
    items = d.get("entries") if isinstance(d, dict) else d
    out = []
    for e in items or []:
        if not (isinstance(e, dict) and e.get("name") and isinstance(e.get("address"), str)
                and e["address"].strip()):
            continue
        has_xy = isinstance(e.get("lat"), (int, float)) and isinstance(e.get("lon"), (int, float))
        if has_xy or (isinstance(e.get("tz"), str) and e["tz"]):
            out.append(e)
    return out


def match_named_location_by_address(lat, lon, labels=None, homes=None, run=None):
    """The home this stop is at by its street address, or None:
    {name, address, distance_m}. Callers reach this after match_named_location
    came up empty. `labels` are geocoder strings already held for the stop
    (a visit row's iOS address) -- never the user's words.

    Only shells out when a home could be in range (a home with coordinates
    within ADDRESS_NEAR_M, or any address-only home -- the CLI checks its
    timezone). FAIL-SOFT: no binary, a timeout, bad output all return None."""
    homes = load_address_homes() if homes is None else homes
    near = any(meters(lat, lon, e["lat"], e["lon"]) <= ADDRESS_NEAR_M
               if isinstance(e.get("lat"), (int, float)) and isinstance(e.get("lon"), (int, float))
               else True
               for e in homes)
    if not near:
        return None
    cmd = [ADDRESS_MATCH_BIN, "--lat", str(lat), "--lon", str(lon)]
    for lab in labels or []:
        if isinstance(lab, str) and lab.strip():
            cmd += ["--label", lab.strip()]
    try:
        if run is not None:
            out = run(cmd)
        else:
            import subprocess
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=200).stdout
        m = (json.loads(out or "{}") or {}).get("match")
    except Exception:
        return None
    if not (isinstance(m, dict) and m.get("name")):
        return None
    return {"name": m["name"], "address": m.get("address"), "distance_m": m.get("distance_m")}


def meters(la1, lo1, la2, lo2):
    return math.hypot((la2 - la1) * 111320.0,
                      (lo2 - lo1) * 111320.0 * math.cos(math.radians((la1 + la2) / 2)))


def load_key():
    return os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or _env_file_value("SUPABASE_SERVICE_ROLE_KEY")


def _get(path, key):
    if not SUPABASE_URL:
        raise RuntimeError("no Supabase project configured (SUPABASE_URL or instance supabase_project)")
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{path}",
                                 headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read())


def _read_places(path):
    try:
        with open(path) as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return []
    items = d if isinstance(d, list) else (d.get("places") or d.get("items"))
    if items is None and isinstance(d, dict):
        for v in d.values():
            if isinstance(v, list):
                items = v
                break
    return [p for p in (items or []) if p.get("lat") is not None]


def load_saved():
    """The user's saved places: the Google Maps export plus each extra list
    (EXTRA_SAVED_PLACES, e.g. live marks from a places app). Missing file is not
    an error -- it only means this rung cannot fire, and the others still can.

    A live list is the marks as they stand today (synced daily); the Google
    export only moves when the user re-exports. A restaurant marked after the
    last export was invisible to the `favorite` rung (a lunch 22 m from one
    shipped as a bare street address). The same venue in both lists stays ONE
    place -- two entries inside the radius would read as a tie."""
    out = _read_places(SAVED_PLACES)
    ids = {p.get("place_id") for p in out if p.get("place_id")}
    for p in [q for f in EXTRA_SAVED_PLACES for q in _read_places(f)]:
        if p.get("place_id") and p["place_id"] in ids:
            continue
        name = str(p.get("name", "")).lower()
        if any(str(q.get("name", "")).lower() == name
               and meters(q["lat"], q["lng"], p["lat"], p["lng"]) <= ASK_RADIUS_M
               for q in out if q.get("lng") is not None):
            continue
        out.append(p)
    return out


def prior_confirmed_visits(lat, lon, key, exclude_id=None, radius_m=RECUR_RADIUS_M):
    """The visits the user has already confirmed within radius_m, most recent first:
    [{name, arrived_at, minutes, distance_m}]. `minutes` is the longest of the
    visit's rows (duplicates disagree when the sweeper synthesized a departure),
    None when no row of it has one."""
    since = (datetime.now(timezone.utc)
             - timedelta(days=RECUR_LOOKBACK_DAYS)).isoformat()
    dlat = radius_m / 111320.0
    dlon = radius_m / (111320.0 * max(math.cos(math.radians(lat)), 1e-6))
    rows = _get(
        "location_history?segment_type=eq.visit&place_type=eq.user-confirmed"
        f"&arrived_at=gte.{urllib.parse.quote(since)}"
        f"&latitude=gte.{lat - dlat}&latitude=lte.{lat + dlat}"
        f"&longitude=gte.{lon - dlon}&longitude=lte.{lon + dlon}"
        "&select=id,place_name,latitude,longitude,arrived_at,departed_at"
        "&order=arrived_at.desc&limit=200", key) or []
    out, by_visit = [], {}
    for r in rows:
        if r["id"] == exclude_id or not r.get("place_name"):
            continue
        dist = meters(lat, lon, r["latitude"], r["longitude"])
        if dist > radius_m:
            continue
        # One VISIT, one vote. The iOS client uploads ~1 in 4 stays as two or
        # three duplicate rows (flushUnsynced re-entrancy), so counting rows let
        # a single answer outvote itself into "recurring" (MIN_RECUR_VOTES).
        visit = (r.get("arrived_at") or "")[:16]
        mins = _minutes(r.get("arrived_at"), r.get("departed_at"))
        if visit in by_visit:
            v = by_visit[visit]
            if mins is not None and (v["minutes"] is None or mins > v["minutes"]):
                v["minutes"] = mins
            continue
        by_visit[visit] = {"name": r["place_name"].strip(), "arrived_at": r.get("arrived_at"),
                           "minutes": mins, "distance_m": dist}
        out.append(by_visit[visit])
    return out


def prior_confirmations(lat, lon, key, exclude_id=None):
    """Names the user has already confirmed at this spot, most recent first."""
    return [v["name"] for v in prior_confirmed_visits(lat, lon, key, exclude_id=exclude_id)]


def _minutes(arrived, departed):
    try:
        a = datetime.fromisoformat(str(arrived).replace("Z", "+00:00"))
        d = datetime.fromisoformat(str(departed).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return (d - a).total_seconds() / 60.0


# A REPEAT STAY needs only one answer: repeat dwells (2+ visits) at one
# centroid are a recurring place that is asked about once and then remembered.
# Two STAYS at one spot are two visits even when the user was only asked about
# the first, so the answer given then names the second.
#
# This does not undo MIN_RECUR_VOTES. The replay it guards against put "Just
# browsing the market" on a 13-minute walk past the same corner: a passage, not
# a stay. Here both visits have to be stays of RECUR_DWELL_MIN or
# more (the floor stop-identify and `findme enrich` already use for a real
# stop), the earlier one must be a different visit from this one (a twin row of
# THIS stay is the same answer, not a second visit), and the name must read as
# a place: an answer longer than REPEAT_NAME_MAX_CHARS is a typed sentence,
# right for its own row and wrong as the label for every later visit (the same
# property-of-the-field test as location-confirm's PROMOTE_MAX_NAME_CHARS).
#
# And nothing else the user named may sit within REPEAT_CLEAR_M. One answer is
# only one answer: on a dense block it is a coin flip between neighbours.
# Measured on the build: an 87-minute stay sat 14 m from one named cafe and 40 m
# from a named bakery, and the stay's rest anchor sat within 25 m of the other
# one. Two answers that close together get the question, not a guess.
RECUR_DWELL_MIN = 15.0
REPEAT_NAME_MAX_CHARS = 60
REPEAT_CLEAR_M = 50.0


def repeat_stay_name(lat, lon, key, stop_min, stop_arrived=None, exclude_id=None):
    """The name given to the ONE earlier stay confirmed at this spot, when this
    stop is a stay too. Returns {name, arrived_at, minutes, distance_m} or None.
    Callers reach this only after the two-answer `recurring` test came up short."""
    if stop_min is None or stop_min < RECUR_DWELL_MIN:
        return None
    visits = prior_confirmed_visits(lat, lon, key, exclude_id=exclude_id, radius_m=REPEAT_CLEAR_M)
    this_visit = (stop_arrived or "")[:16]
    earlier = [v for v in visits if not this_visit or (v.get("arrived_at") or "")[:16] != this_visit]
    near = [v for v in earlier if v["distance_m"] <= RECUR_RADIUS_M]
    if len(near) != 1:
        return None
    v = near[0]
    if any(o["name"] != v["name"] for o in earlier):
        return None
    if v["minutes"] is None or v["minutes"] < RECUR_DWELL_MIN:
        return None
    if not 2 <= len(v["name"]) <= REPEAT_NAME_MAX_CHARS:
        return None
    return v


def name_from_history(lat, lon, key=None, exclude_id=None, saved=None,
                      stop_min=None, stop_arrived=None):
    """What the user's own history says this place is. Returns a dict or None.

    {name, rung, confidence, detail, visits} where `rung` is "recurring" or
    "favorite". Returns None when history is silent -- the caller then falls
    through to whatever geocoder it uses.

    `stop_min` / `stop_arrived` describe the stop being named. With them, one
    earlier answer names it when both visits were stays (repeat_stay_name);
    without them only the two-answer test applies, as before.

    `recurring` requires the past confirmations to AGREE. Two different names
    inside RECUR_RADIUS_M means the radius has swallowed two places (the
    container-bigger-than-the-place failure), and the honest answer is that
    history cannot settle it -- so this returns None and the stop gets asked
    about rather than named from a coin flip.

    FAIL-SOFT throughout: no key, no network, unreadable file -- all return
    None. This rung going quiet must never be able to break naming outright.
    """
    key = key or load_key()
    if not key:
        return None

    try:
        names = prior_confirmations(lat, lon, key, exclude_id=exclude_id)
    except Exception:
        names = []
    if names:
        # MAJORITY, not unanimity. Requiring every past confirmation to match
        # sounded safe and was wrong on the first real stop tested: a grocery
        # store carried ['Grocer', 'Grocer', 'Mailbox + another grocery +
        # Grocer (soda run) -- multi-stop errand']. Three distinct strings, one
        # obvious answer. An errand narrative is sometimes typed instead of a
        # place name, so exact agreement is the wrong test; weight of evidence
        # is the right one.
        counts = {}
        for n in names:
            counts[n] = counts.get(n, 0) + 1
        ranked = sorted(counts.items(), key=lambda kv: (-kv[1], names.index(kv[0])))
        top, top_n = ranked[0]
        runner_n = ranked[1][1] if len(ranked) > 1 else 0
        # A strict majority, or a clear 2x lead over the next name. Anything
        # closer than that is a genuine tie and gets asked rather than guessed.
        #
        # And at least TWO confirmations. "Recurring" means the user has called
        # this spot the same thing more than once; one answer is one answer about
        # one visit. A single reply -- "Just browsing the market", about a
        # stall-browse at a flea market -- was 15m from an evening dog walk past
        # the same corner and named it, at 0.95.
        if top_n >= MIN_RECUR_VOTES and (top_n * 2 > len(names) or top_n >= 2 * max(runner_n, 1)):
            return {"name": top, "rung": "recurring",
                    "confidence": CONFIDENCE["recurring"],
                    "visits": top_n,
                    "detail": f"you confirmed this spot as {top!r} {top_n} of "
                              f"{len(names)} times in the last {RECUR_LOOKBACK_DAYS} days"}
        if len(names) == 1:
            try:
                v = repeat_stay_name(lat, lon, key, stop_min, stop_arrived=stop_arrived,
                                     exclude_id=exclude_id)
            except Exception:
                v = None
            if v and v["name"] == names[0]:
                return {"name": v["name"], "rung": "recurring",
                        "confidence": CONFIDENCE["repeat_stay"],
                        "visits": 2,
                        "detail": f"you named this spot {v['name']!r} when you stayed "
                                  f"{v['minutes']:.0f} min on {(v.get('arrived_at') or '')[:10]}; "
                                  f"this is a second stay"}
        return None  # history genuinely split -- ask, do not guess

    try:
        saved = load_saved() if saved is None else saved
    except Exception:
        saved = []
    # key= on the distance ONLY: two saved places at an identical distance made
    # sorted() fall through to comparing the dicts themselves, which raises
    # TypeError. Ties are not hypothetical here -- Google returns one building
    # centroid per address, so a single address with two saved entries ties
    # exactly.
    near = sorted(((meters(lat, lon, p["lat"], p["lng"]), p) for p in saved
                   if p.get("lat") is not None and p.get("lng") is not None),
                  key=lambda t: t[0])
    near = [(d, p) for d, p in near if d <= ASK_RADIUS_M]
    if len(near) == 1:
        d, p = near[0]
        return {"name": p.get("name") or p.get("title") or "", "rung": "favorite",
                "confidence": CONFIDENCE["favorite"], "visits": 0,
                "detail": f"the only place you saved within {ASK_RADIUS_M:.0f}m ({d:.0f}m)"}
    return None


# A stay shorter than this is not a night anywhere.
LODGING_MIN_SPAN_H = 12


def scheduled_lodging(day):
    """The BOOKED accommodation for this date, by its official name.

    The travel planner holds the accommodation for every date, so the
    assistant knows exactly which rental the user is staying in, by its
    official name. The lodging rung had been ignoring it: it inferred a name
    from stays of 6h or more, which produced the placeholder "the apartment"
    whenever nothing had been confirmed on a long stay, and at best recovered a
    nickname once typed. The booking carries the listing's own title with exact
    windows, and a booking outranks an inference about where somebody slept.

    Reads the `travel_segments` table directly. It used to parse `wiki render
    travel_schedule` for a "lodging" column that the table's rewrite dropped,
    so this rung returned None for every date and the rented flat was asked
    about on every return home. A
    lodging is a segment that is neither a flight leg nor flight-derived
    (`source='flights'` rows are cities and transit); when several cover the
    date the shortest — the most specific — wins. Two structural exclusions:
    a multi-metro placeholder (`metro` like "city_a|city_b", the Schrodinger
    stay) is not a place, and a segment shorter than a night (a 7-hour day
    trip) is not where the user slept — either would otherwise name the bed
    the user went home to. Callers only use it for a spot the user has
    actually slept at, so a lodging label can't name a café across town.
    """
    stay = scheduled_lodging_stay(day)
    return stay["name"] if stay else None


def scheduled_lodging_stay(day):
    """scheduled_lodging with the booking's own window: {name, arrive_at,
    depart_at} (aware datetimes; depart_at None when open-ended), or None.
    The window is what lets a caller ask "has the user slept here on another
    night of THIS booking" (stop-identify's overnight rung)."""
    key = load_key()
    if not key:
        return None
    try:
        rows = _get("travel_segments?source=neq.flights&metro=neq.transit"
                    "&select=place_label,metro,arrive_at,depart_at&limit=500", key) or []
    except Exception:
        return None
    best = None
    for r in rows:
        try:
            a = datetime.fromisoformat(r["arrive_at"].replace("Z", "+00:00"))
            d = (datetime.fromisoformat(r["depart_at"].replace("Z", "+00:00"))
                 if r.get("depart_at") else None)
        except (KeyError, TypeError, ValueError):
            continue
        if not (a.date() <= day and (d is None or day <= d.date())) or not r.get("place_label"):
            continue
        span = (d - a).total_seconds() if d else float("inf")
        if "|" in (r.get("metro") or "") or span < LODGING_MIN_SPAN_H * 3600:
            continue
        if best is None or span < best[0]:
            best = (span, {"name": r["place_label"].strip(), "arrive_at": a, "depart_at": d})
    return best[1] if best else None


def match_booking_by_address(lat, lon, booking, labels=None, run=None):
    """The booking's name when this stop is at it by street address, or None.

    For the FIRST night of a booking, when there is no other night to measure
    from. travel_segments carries a label and no coordinates, so only the
    address can place it: "Example St 4, Old Town" against the iOS geocoder's
    "4A Example Street". Whether those name one house is a model's call
    (Rule #0b), made by the same `address-match` that reads the user's homes,
    here with the booking as its only candidate (`--booking`). A label that is
    not an address (a listing title) reads as none, which is the safe answer. FAIL-SOFT: no binary, a timeout, bad output all return None."""
    name = booking.strip() if isinstance(booking, str) else ""
    if not name:
        return None
    cmd = [ADDRESS_MATCH_BIN, "--lat", str(lat), "--lon", str(lon), "--booking", name]
    for lab in labels or []:
        if isinstance(lab, str) and lab.strip():
            cmd += ["--label", lab.strip()]
    try:
        if run is not None:
            out = run(cmd)
        else:
            import subprocess
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=200).stdout
        m = (json.loads(out or "{}") or {}).get("match")
    except Exception:
        return None
    return name if isinstance(m, dict) and m.get("name") == name else None


# English names for map labels. With Google capped, OSM names the stops in the
# local language (of 7 guesses corrected in one week: 4 Hebrew, 1 German, 1 the
# road number "3976"). An English tag needs no
# judgment (the OSM display name, Nominatim accept-language=en); for the
# rest a model reads the label (Rule #0b): Sonnet, then Opus on a schema failure.
# NO LOCAL TIER, measured: gemma3:1b said "Tottenham Stadium" for
# אצטדיון טדי (Teddy Stadium) and that "3976" is a name (as address-match.mjs
# found). Each label is asked once, and only by a run with JORI_PLACE_NAMES_MODEL=1
# (the background live-day refresh), EN_CALL_S a call, EN_CALLS_PER_RUN a run
# (resolve-day's ADDRESS_ASKS_PER_RUN); location-confirm, resolve-point and the
# MCP tools read remembered answers only. FAIL-SOFT: no login, a timeout or a bad
# reply leaves the label as it was. Only automatic guesses come through here.
EN_CALL_S = 8
EN_CALLS_PER_RUN = 6
PLACE_NAME_EN_CACHE = places_local.data_path(".cache", "place-name-english.json")
MODELS_ENV = os.path.join(REPO, "agent", "config", "models.env")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or os.path.expanduser("~/.local/bin/claude")
EN_PROMPT = """You turn map labels into the English an English-speaking traveller would write in a diary. Each label is a place, street or area name printed by a map database, in any language or script; "kind" says which. For each label give:
- "en": the name English speakers use for it. A place known by an English name gets it (הכותל המערבי -> Western Wall, העיר העתיקה -> Old City). Otherwise transliterate it into Latin letters, keeping its own name and translating only generic words such as cafe, market, park, stadium (קפה נמרוד -> Cafe Nimrod). A street or area keeps its own name, transliterated, never swapped for another word (שומרון -> Shomron, not Samaria). A label in Latin letters comes back exactly as given, unless it is a descriptive name in a language other than English (Archäologischer Park -> Archaeological Park). Never substitute a different place.
- "is_name": false when the label is not a name at all, only a bare road number, code or postcode; otherwise true.
Reply with JSON only: {"items": [{"id": "<id>", "en": "<english>", "is_name": true}]}, one item per input id."""
EN_PROMPT_V = hashlib.sha256(EN_PROMPT.encode("utf-8")).hexdigest()[:12]
_en_run = {"calls": 0, "down": None}  # this process's model calls; why it stopped asking


def _claude_toolless(model, prompt, timeout_s):
    """lib/jev-claude.mjs runToollessDetailed: no tools, Max login only. Raises on no answer."""
    import subprocess, tempfile
    env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    r = subprocess.run([CLAUDE_BIN, "-p", "--model", model, "--effort", "low", "--tools", "",
                        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources",
                        "project", "--no-session-persistence", "--output-format", "text"],
                       input=prompt, capture_output=True, text=True, timeout=timeout_s,
                       cwd=tempfile.gettempdir(), env=env)
    out = (r.stdout or "").strip() or (r.stderr or "").strip()
    # The CLI's fixed status line, not model language (jev-claude NOT_LOGGED_IN_PREFIX).
    if not (r.stdout or "").strip() or out.startswith("Not logged in"):
        raise RuntimeError(out[:120] or f"no output (exit {r.returncode})")
    return out


def _parse_english(reply, ids):  # {id: {en, is_name}} when the reply answers every id, else None
    i, j, got = reply.find("{"), reply.rfind("}"), {}
    try:
        items = json.loads(reply[i:j + 1]).get("items") if 0 <= i < j else None
    except (ValueError, AttributeError):
        items = None
    for it in items if isinstance(items, list) else []:
        en = it.get("en") if isinstance(it, dict) else None
        if (isinstance(en, str) and en.strip() and len(en) <= 120 and it.get("id") in ids
                and isinstance(it.get("is_name"), bool)):
            got[it["id"]] = {"en": en.strip(), "is_name": it["is_name"]}
    return got if len(got) == len(ids) else None


def english_names(labels):
    """{label: {"en", "is_name"}} for each label (or (label, kind): place|street|area) a model has
    read; a label missing from the result is shown as it was."""
    def load():
        try:
            with open(PLACE_NAME_EN_CACHE) as fh:
                return json.load(fh).get("items") or {}
        except (OSError, ValueError, AttributeError):
            return {}
    want = {}  # label -> kind, the first kind a label is given
    for x, kind in ((x, "place") if isinstance(x, str) or x is None else x for x in labels or []):
        if isinstance(x, str) and x.strip():
            want.setdefault(x.strip(), kind)
    items, key = load(), lambda x: f"{want[x]}:{x}"
    out = {x: {"en": items[key(x)]["en"], "is_name": items[key(x)]["is_name"]} for x in want
           if isinstance(items.get(key(x)), dict) and items[key(x)].get("v") == EN_PROMPT_V}
    ids = {f"l{n}": x for n, x in enumerate(x for x in want if x not in out)}
    if (not ids or _en_run["down"] or os.environ.get("JORI_PLACE_NAMES_MODEL") != "1"
            or os.environ.get("JORI_PHOTO_TEXT_NO_CLAUDE")):
        return out
    prompt = EN_PROMPT + "\n\nInput:\n" + json.dumps(
        {"labels": [{"id": k, "label": v, "kind": want[v]} for k, v in ids.items()]}, ensure_ascii=False)
    try:
        with open(MODELS_ENV) as fh:
            env = dict(ln.strip().partition("=")[::2] for ln in fh if "=" in ln and not ln.startswith("#"))
    except OSError:
        env = {}
    for tier in ("SONNET", "OPUS"):
        if not env.get(f"JORI_MODEL_{tier}") or _en_run["calls"] >= EN_CALLS_PER_RUN:
            continue
        _en_run["calls"] += 1
        try:
            got = _parse_english(_claude_toolless(env[f"JORI_MODEL_{tier}"], prompt, EN_CALL_S), set(ids))
        except Exception as e:  # no login, a timeout, a crash: the next tier fails the same way
            _en_run["down"] = str(e)[:200]
            print(f"place_naming: no English names this run: {e}", file=sys.stderr)
            return out
        if got is None:
            continue  # schema failure: climb
        items, at = load(), datetime.now(timezone.utc).isoformat()
        for k, v in got.items():
            out[ids[k]] = v
            items[key(ids[k])] = {**v, "v": EN_PROMPT_V, "tier": tier.lower(), "at": at}
        try:
            tmp = f"{PLACE_NAME_EN_CACHE}.{os.getpid()}.tmp"
            with open(tmp, "w") as fh:
                json.dump({"items": items}, fh, ensure_ascii=False, indent=1)
            os.replace(tmp, PLACE_NAME_EN_CACHE)
        except OSError:
            pass
        return out
    return out
