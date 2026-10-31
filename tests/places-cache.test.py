#!/usr/bin/env python3
"""places-cache.test.py — the `places` CLI's cache, lean mask and budget gate.

The requirement: keep Places calls to a minimum. Billed Places calls came
through `places`, which had no cache. These tests pin the rules
that make the cache safe to trust:

  * the same search from the same ~110 m cell is one Google call, not two;
  * a cache hit is served even when the budget is spent, and a miss is not;
  * "open now" is re-derived from the stored weekly hours on a hit, so a weekday
    answer is not served as open on a day the place is shut;
  * `--lean` really is a cheaper tier, and its entries are only reused at the
    same time of the same weekday (they carry no hours to re-derive from).

Run: python3 tests/places-cache.test.py
"""
import io
import json
import os
import shutil
import socket
import sys
import tempfile
import time
import unittest
import unittest.mock
from contextlib import redirect_stdout
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "lib"))

import places_cache  # noqa: E402
import places_log  # noqa: E402

mod = type(sys)("places_cache_mod")
mod.__file__ = os.path.join(REPO, "bin", "places")
exec(compile(open(os.path.join(REPO, "bin", "places")).read(), "places", "exec"),
     mod.__dict__)


def place(pid, lat, lng, weekday_hours=True, photos=0, reviews=0):
    p = {
        "id": pid,
        "displayName": {"text": pid},
        "formattedAddress": f"{pid} St",
        "location": {"latitude": lat, "longitude": lng},
        "rating": 4.6,
        "userRatingCount": 200,
        "utcOffsetMinutes": 0,
        "currentOpeningHours": {"openNow": True},
    }
    if weekday_hours:
        # Google numbering: Sunday=0, so 1..5 is Monday to Friday, 09:00-17:00.
        p["regularOpeningHours"] = {"periods": [
            {"open": {"day": d, "hour": 9, "minute": 0}, "close": {"day": d, "hour": 17, "minute": 0}}
            for d in range(1, 6)]}
    if photos:
        p["photos"] = [{"name": f"places/{pid}/photos/{i}", "widthPx": 800} for i in range(photos)]
    if reviews:
        p["reviews"] = [{"text": {"text": f"review {i}"}} for i in range(reviews)]
    return p


TUESDAY_NOON = datetime(2026, 10, 13, 12, 0, tzinfo=timezone.utc)
SATURDAY_NOON = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)


class FakeResp:
    status = 200

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return json.dumps(self.body).encode()


class CacheCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="places-cache-test-")
        self._old_dir = places_cache.CACHE_DIR
        places_cache.CACHE_DIR = self.tmp
        self.calls = []          # (mask, body) of every live request
        self.logged = []         # (method, kwargs) of every log line
        self.pool = [place(f"p{i}", 12.35 + i * 0.0003, -65.43) for i in range(6)]
        self._old = (mod.urllib.request.urlopen, mod._places_log, getattr(mod, "assert_places_allowed", None),
                     mod._now_utc, mod.API_KEY)

        def fake_urlopen(req, timeout=0):
            hdrs = {k.lower(): v for k, v in req.header_items()}
            self.calls.append((hdrs.get("x-goog-fieldmask"), json.loads(req.data.decode())))
            return FakeResp({"places": self.pool})

        mod.urllib.request.urlopen = fake_urlopen
        mod._places_log = lambda tool, method, **kw: self.logged.append((method, kw))
        # Live requests go through places_client's real gates, pointed at a
        # sandbox: this host allowed, generous ceiling, hand runs opted in.
        self._env = {k: os.environ.get(k) for k in ("PLACES_POLICY_FILE", "PLACES_LEDGER_FILE",
                     "PLACES_BUDGET_STATE_FILE", "PLACES_LOG_FILE", "PLACES_TIER_COUNTS_FILE", "PLACES_LANE")}
        policy = {"allowed_hosts": [socket.gethostname().split(".")[0]], "monthly_ceiling_usd": 100,
                  "assumed_free_per_month": {},
                  "daily_live_caps": {"enterprise": {"untagged": 100}, "enterprise_atmosphere": {"untagged": 100}}}
        with open(os.path.join(self.tmp, "policy.json"), "w") as f:
            json.dump(policy, f)
        os.environ.update({"PLACES_POLICY_FILE": os.path.join(self.tmp, "policy.json"),
                           "PLACES_LEDGER_FILE": os.path.join(self.tmp, "ledger.json"),
                           "PLACES_BUDGET_STATE_FILE": os.path.join(self.tmp, "state.json"),
                           "PLACES_LOG_FILE": os.path.join(self.tmp, "calls.jsonl"),
                           "PLACES_TIER_COUNTS_FILE": os.path.join(self.tmp, "counts.json")})
        os.environ.pop("PLACES_LANE", None)
        mod._now_utc = lambda: TUESDAY_NOON
        mod.API_KEY = "test-key"

    def tearDown(self):
        (mod.urllib.request.urlopen, mod._places_log, mod.assert_places_allowed,
         mod._now_utc, mod.API_KEY) = self._old
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        places_cache.CACHE_DIR = self._old_dir
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cached_hits(self):
        return [kw for _, kw in self.logged if kw.get("cached")]


class Keys(unittest.TestCase):
    def k(self, query="coffee bakery", lat=12.3501, lng=-65.4321, radius=200, open_now=True,
          mask="m", when=""):
        return places_cache.search_key(query, lat, lng, radius, open_now, mask, when)

    def test_case_and_spacing_do_not_matter(self):
        self.assertEqual(self.k("Coffee  Bakery "), self.k("coffee bakery"))

    def test_same_cell_same_key(self):
        # 0.0004 degrees is ~40 m: well inside one ~110 m cell.
        self.assertEqual(self.k(lat=12.3501, lng=-65.4321), self.k(lat=12.3503, lng=-65.4319))

    def test_next_cell_is_a_different_key(self):
        self.assertNotEqual(self.k(lat=12.3501), self.k(lat=12.3521))

    def test_every_other_input_changes_the_key(self):
        base = self.k()
        self.assertNotEqual(base, self.k(query="museum"))
        self.assertNotEqual(base, self.k(radius=500))
        self.assertNotEqual(base, self.k(open_now=False))
        self.assertNotEqual(base, self.k(mask="other"))
        self.assertNotEqual(base, self.k(when="d1h4"))


class Storage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="places-cache-test-")
        self._old_dir = places_cache.CACHE_DIR
        places_cache.CACHE_DIR = self.tmp
        # put() prunes on ~2% of writes. These tests store entries with a fake `now`
        # far in the past and then read or count them, so a surprise prune removed the
        # entry under test (1.3% of runs failed). Pruning is called explicitly below.
        patcher = unittest.mock.patch.object(places_cache.random, "random", return_value=1.0)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        places_cache.CACHE_DIR = self._old_dir
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_roundtrip_and_expiry(self):
        places_cache.put("k", {"a": 1}, now=1000.0)
        self.assertEqual(places_cache.get("k", 60, now=1030.0)["payload"], {"a": 1})
        self.assertIsNone(places_cache.get("k", 60, now=1061.0))

    def test_missing_and_corrupt_are_misses_not_errors(self):
        self.assertIsNone(places_cache.get("absent", 60))
        with open(os.path.join(self.tmp, "bad.json"), "w") as fh:
            fh.write("{not json")
        self.assertIsNone(places_cache.get("bad", 60))

    def test_prune_removes_only_expired_entries(self):
        now = time.time()
        places_cache.put("expired", {"x": 1}, ttl_sec=60, now=now - 3 * 24 * 3600)
        places_cache.put("live", {"x": 2}, ttl_sec=places_cache.SEARCH_TTL_SEC)
        places_cache.put("long", {"x": 3}, ttl_sec=places_cache.RESOLVE_TTL_SEC, now=now - 10 * 24 * 3600)
        stray = os.path.join(self.tmp, "abandoned.tmp")
        with open(stray, "w") as fh:
            fh.write("{")
        os.utime(stray, (now - 3600, now - 3600))
        self.assertEqual(places_cache.prune(), 2)            # the expired entry and the stray temp file
        self.assertIsNone(places_cache.get("expired", 10 ** 9))
        self.assertIsNotNone(places_cache.get("live", 10 ** 9))
        self.assertIsNotNone(places_cache.get("long", 10 ** 9))   # a 30-day entry survives day 10


class SearchCaching(CacheCase):
    def search(self, lat=12.3501, lng=-65.4321, query="coffee bakery", **kw):
        return mod.search_places(lat, lng, query, radius=200, open_now=True, **kw)

    def test_second_identical_search_never_reaches_google(self):
        first = self.search()
        second = self.search()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(first["places"]), len(second["places"]))
        self.assertEqual(len(self.cached_hits()), 1)

    def test_a_point_in_the_same_cell_is_served_from_the_entry(self):
        self.search(lat=12.3501, lng=-65.4321)
        self.search(lat=12.3503, lng=-65.4319)
        self.assertEqual(len(self.calls), 1)

    def test_a_different_cell_or_query_is_a_new_call(self):
        self.search()
        self.search(lat=12.3601)
        self.search(query="museum")
        self.assertEqual(len(self.calls), 3)

    def test_refresh_skips_the_read_but_rewrites_the_entry(self):
        self.search()
        self.search(refresh=True)
        self.assertEqual(len(self.calls), 2)
        self.search()
        self.assertEqual(len(self.calls), 2)

    def test_always_asks_google_for_a_full_page(self):
        self.search()
        self.assertEqual(self.calls[0][1]["maxResultCount"], mod.FETCH_COUNT)

    def test_entry_is_stored_compact(self):
        self.pool = [place("a", 12.35, -65.43, photos=6, reviews=5)]
        data = self.search()
        self.assertEqual(len(data["places"][0]["photos"]), mod.MAX_PHOTOS)
        self.assertEqual(data["places"][0]["photos"][0], {"name": "places/a/photos/0"})
        self.assertEqual(len(data["places"][0]["reviews"]), 1)


class BudgetGate(CacheCase):
    def block(self):
        # places-budget's state says the month is blocked; the client refuses (3).
        with open(os.environ["PLACES_BUDGET_STATE_FILE"], "w") as f:
            json.dump({"month": time.strftime("%Y-%m", time.gmtime()),
                       "scopes": {"jori": {"level": "blocked", "spend_usd": 31.72, "limit_usd": 30}}}, f)

    def test_a_live_call_is_refused_when_the_budget_is_spent(self):
        self.block()
        with self.assertRaises(SystemExit) as cm:
            mod.search_places(12.35, -65.43, "coffee", radius=200, open_now=True)
        self.assertEqual(cm.exception.code, 3)
        self.assertEqual(self.calls, [])

    def test_a_cache_hit_is_still_served_when_the_budget_is_spent(self):
        mod.search_places(12.35, -65.43, "coffee", radius=200, open_now=True)
        self.block()
        data = mod.search_places(12.35, -65.43, "coffee", radius=200, open_now=True)
        self.assertEqual(len(data["places"]), 6)
        self.assertEqual(len(self.calls), 1)


class OpenNowIsRederived(CacheCase):
    def test_a_weekday_answer_is_not_served_as_open_on_saturday(self):
        mod.search_places(12.35, -65.43, "coffee", radius=200, open_now=True)   # Tuesday noon
        mod._now_utc = lambda: SATURDAY_NOON
        mod.search_places(12.35, -65.43, "coffee", radius=200, open_now=True)
        # Every place closes on weekends: too few survive, so it is a miss, and
        # the live call replaces the entry rather than serving closed places.
        self.assertEqual(len(self.calls), 2)

    def test_closed_places_are_dropped_and_unknowns_kept(self):
        self.pool = ([place(f"w{i}", 12.35, -65.43) for i in range(4)]
                     + [place(f"u{i}", 12.35, -65.43, weekday_hours=False) for i in range(3)])
        mod.search_places(12.35, -65.43, "coffee", radius=200, open_now=True)
        mod._now_utc = lambda: SATURDAY_NOON
        data = mod.search_places(12.35, -65.43, "coffee", radius=200, open_now=True)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(sorted(p["id"] for p in data["places"]), ["u0", "u1", "u2"])

    def test_open_flag_is_rewritten_for_the_time_it_is_served(self):
        mod.search_places(12.35, -65.43, "coffee", radius=200, open_now=False)
        mod._now_utc = lambda: SATURDAY_NOON
        data = mod.search_places(12.35, -65.43, "coffee", radius=200, open_now=False)
        self.assertEqual(len(self.calls), 1)                       # include-closed keeps everything
        self.assertTrue(all(p["currentOpeningHours"]["openNow"] is False for p in data["places"]))

    def test_utc_offset_decides_the_venues_local_time(self):
        # At +180 minutes, 07:00 UTC is 10:00 local (open) and 22:30 UTC is 01:30
        # the next morning (closed).
        p = place("x", 12.35, -65.43)
        p["utcOffsetMinutes"] = 180
        morning = datetime(2026, 10, 13, 7, 0, tzinfo=timezone.utc)      # 10:00 local, open
        late = datetime(2026, 10, 13, 22, 30, tzinfo=timezone.utc)       # 01:30 local, closed
        self.assertTrue(mod.local_open_status(p, morning))
        self.assertFalse(mod.local_open_status(p, late))

    def test_no_hours_or_offset_is_unknown_not_closed(self):
        self.assertIsNone(mod.local_open_status(place("x", 1, 1, weekday_hours=False), TUESDAY_NOON))
        p = place("y", 1, 1)
        del p["utcOffsetMinutes"]
        self.assertIsNone(mod.local_open_status(p, TUESDAY_NOON))


class LeanMode(CacheCase):
    def test_lean_asks_google_for_the_cheaper_tier(self):
        self.assertEqual(places_log.tier_for_mask(mod.LEAN_FIELD_MASK), "pro")
        # 2026-10-20: the default mask is plain Enterprise; Atmosphere is --tier rich.
        self.assertEqual(places_log.tier_for_mask(mod.FIELD_MASK), "enterprise")
        self.assertEqual(places_log.tier_for_mask(mod.RICH_FIELD_MASK), "enterprise_atmosphere")
        mod.search_places(12.35, -65.43, "coffee", radius=400, open_now=True, lean=True)
        self.assertEqual(self.calls[0][0], mod.LEAN_FIELD_MASK)

    def test_lean_and_full_entries_do_not_share_a_slot(self):
        mod.search_places(12.35, -65.43, "coffee", radius=400, open_now=True)
        mod.search_places(12.35, -65.43, "coffee", radius=400, open_now=True, lean=True)
        self.assertEqual(len(self.calls), 2)

    def test_lean_entry_is_reused_at_the_same_time_of_the_same_weekday_only(self):
        mod.search_places(12.35, -65.43, "coffee", radius=400, open_now=True, lean=True)
        mod.search_places(12.35, -65.43, "coffee", radius=400, open_now=True, lean=True)
        self.assertEqual(len(self.calls), 1)
        mod._now_utc = lambda: SATURDAY_NOON      # same hour, different weekday
        mod.search_places(12.35, -65.43, "coffee", radius=400, open_now=True, lean=True)
        self.assertEqual(len(self.calls), 2)

    def test_lean_results_render(self):
        self.pool = [{"id": "a", "displayName": {"text": "Cafe A"}, "formattedAddress": "1 St",
                      "location": {"latitude": 12.3502, "longitude": -65.4302},
                      "primaryTypeDisplayName": {"text": "Cafe"}, "googleMapsUri": "https://x"}]
        data = mod.search_places(12.35, -65.43, "coffee", radius=400, open_now=True, lean=True)
        buf = io.StringIO()
        with redirect_stdout(buf):
            mod.process_results(data, 12.35, -65.43, 5, as_json=True)
        out = json.loads(buf.getvalue())
        self.assertEqual(out["results"][0]["name"], "Cafe A")
        self.assertEqual(out["results"][0]["type"], "Cafe")
        self.assertIsNone(out["results"][0]["rating"])
        self.assertGreater(out["results"][0]["distance"], 0)


class LaneTag(unittest.TestCase):
    def test_lane_flag_sets_the_env_var_the_logger_reads(self):
        old = os.environ.pop("PLACES_LANE", None)
        try:
            opts, _ = mod.parse_args(["coffee", "--lane", "hum-nearby", "--lean"])
            self.assertTrue(opts["lean"])
            self.assertEqual(os.environ["PLACES_LANE"], "hum-nearby")
        finally:
            os.environ.pop("PLACES_LANE", None)
            if old is not None:
                os.environ["PLACES_LANE"] = old

    def test_logger_writes_the_lane(self):
        tmp = tempfile.mkdtemp(prefix="places-log-test-")
        old_file = places_log.LOG_FILE
        places_log.LOG_FILE = os.path.join(tmp, "calls.jsonl")
        try:
            places_log.log_call("places", "searchText", mask="places.id", lane="hum-excursion")
            places_log.log_call("places", "searchText", mask="places.id")
            with open(places_log.LOG_FILE) as fh:
                lines = [json.loads(l) for l in fh]
            self.assertEqual(lines[0]["lane"], "hum-excursion")
            self.assertNotIn("lane", lines[1])
        finally:
            places_log.LOG_FILE = old_file
            shutil.rmtree(tmp, ignore_errors=True)


class CheckLookups(CacheCase):
    def test_name_to_place_id_is_cached(self):
        self.pool = [{"id": "ChIJabc", "displayName": {"text": "Le Coucou"}}]
        a = mod.resolve_place_for_check("Le Coucou", (40.72, -74.0))
        b = mod.resolve_place_for_check("le  coucou", (40.72, -74.0))
        self.assertEqual((a, b), ("ChIJabc", "ChIJabc"))
        self.assertEqual(len(self.calls), 1)

    def test_a_place_id_needs_no_lookup_at_all(self):
        self.assertEqual(mod.resolve_place_for_check("ChIJxyz", None), "ChIJxyz")
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
