"""The app-store optimization collectors (bin/aso-*): off without config, and
the deterministic parts that decide what the weekly ASO digest says.

Off: a fresh install (no agent/local/config/marketing.json) must not error —
each collector prints `skipped` and exits 0 without writing state. On: the
rank finder matches the configured app only, rank diffs record changes and cap
history, the opportunity scan flags a subtitle left in English unless it is a
confirmed localized one, skips the app's own baseline changes when looking for
competitor moves, and flags a market where no Tier 1 keyword ranks; review
themes count a phrase once per review and drop phrases already targeted.
Synthetic app ids, keywords and reviews. No network: nothing here reaches the
search APIs.

Run: python3 tests/aso-collectors.test.py
"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BIN = os.path.join(REPO, "bin")

APP_CFG = {
    "product": "demoapp",
    "ios_app_id": "1000000001",
    "ios_bundle_id": "com.example.demo",
    "android_package": "com.example.demo",
    "locales": {"en-US": ["us", "en", "us"], "it": ["it", "it", "it"]},
    "localized_subtitle_ok": {"it": ["foto e liste con demoapp"]},
    "subtitle_english_markers": ["ABC", "host"],
}


def make_env(cfg):
    home = tempfile.mkdtemp(prefix="aso-home-")
    local = tempfile.mkdtemp(prefix="aso-local-")
    os.makedirs(os.path.join(home, "data"))
    if cfg is not None:
        os.makedirs(os.path.join(local, "config"))
        with open(os.path.join(local, "config", "marketing.json"), "w") as fh:
            json.dump(cfg, fh)
    return home, local


def load(name, home, local):
    """Load a bin as a module with the given install + local dirs."""
    os.environ["JORI_HOME"] = home
    os.environ["JORI_LOCAL_DIR"] = local
    path = os.path.join(BIN, name)
    loader = importlib.machinery.SourceFileLoader(name.replace("-", "_"), path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    mod.__file__ = path
    loader.exec_module(mod)
    return mod


class OffWithoutConfig(unittest.TestCase):
    def test_each_collector_skips_and_writes_nothing(self):
        home, local = make_env(None)
        try:
            for name in ("aso-rank-pulse-collect", "aso-experiments-check", "aso-opportunity-scan",
                         "aso-review-themes", "aso-search-terms-collect"):
                env = dict(os.environ, JORI_HOME=home, JORI_LOCAL_DIR=local)
                r = subprocess.run([sys.executable, os.path.join(BIN, name)], env=env,
                                   capture_output=True, text=True, timeout=30)
                self.assertEqual(r.returncode, 0, f"{name}: {r.stderr}")
                self.assertEqual(json.loads(r.stdout)["skipped"].split(" ")[0], "not", name)
            self.assertEqual(os.listdir(os.path.join(home, "data")), [])
        finally:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(local, ignore_errors=True)


class RankPulse(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home, cls.local = make_env(APP_CFG)
        cls.m = load("aso-rank-pulse-collect", cls.home, cls.local)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.home, ignore_errors=True)
        shutil.rmtree(cls.local, ignore_errors=True)

    def test_finds_only_the_configured_app(self):
        ios = {"results": [{"trackId": 5, "bundleId": "com.other"},
                           {"trackId": 1000000001, "bundleId": "x"}]}
        self.assertEqual(self.m.find_app_ios(ios), 2)
        self.assertIsNone(self.m.find_app_ios({"results": [{"trackId": 7, "bundleId": "com.other"}]}))
        self.assertEqual(self.m.find_app_android([{"appId": "a"}, {"appId": "b"}, {"appId": "com.example.demo"}]), 3)
        self.assertIsNone(self.m.find_app_android([{"appId": "a"}]))

    def test_locales_come_from_config(self):
        self.assertEqual(self.m.LOCALE_MAP["it"], ("it", "it", "it"))
        self.assertNotIn("de-DE", self.m.LOCALE_MAP)

    def test_rank_diff_records_changes_and_caps_history(self):
        st = {"ranks": {}, "rank_changes": []}
        self.m.diff_and_update_rank(st, "ios", "en-US", "photo list", 42)
        self.m.diff_and_update_rank(st, "ios", "en-US", "photo list", 42)
        self.m.diff_and_update_rank(st, "ios", "en-US", "photo list", 38)
        e = st["ranks"]["ios"]["en-US"]["photo list"]
        self.assertEqual(e["current_rank"], 38)
        self.assertEqual(e["first_seen_rank"], 42)
        # first sighting (None -> 42) and the move (42 -> 38); the repeat is no change
        self.assertEqual([(c["old"], c["new"]) for c in st["rank_changes"]], [(None, 42), (42, 38)])
        for _ in range(100):
            self.m.diff_and_update_rank(st, "ios", "en-US", "photo list", 38)
        self.assertEqual(len(e["history"]), 90)

    def test_all_keywords_flattens_tiers(self):
        target = {"keywords": {"en-US": {"tier_1": ["a", "b"], "tier_2": ["c"]}, "it": {"tier_1": ["d"]}}}
        self.assertEqual(sorted(self.m.all_keywords(target)), [("en-US", "a"), ("en-US", "b"), ("en-US", "c"), ("it", "d")])


class OpportunityScan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home, cls.local = make_env(APP_CFG)
        cls.m = load("aso-opportunity-scan", cls.home, cls.local)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.home, ignore_errors=True)
        shutil.rmtree(cls.local, ignore_errors=True)

    def baseline(self, ios):
        return {"current_snapshot": {"ios": ios, "android": {}}}

    def types(self, opps, t):
        return sorted(o["locale"] for o in opps if o["type"] == t)

    def test_subtitle_left_in_english(self):
        opps = self.m.detect_empty_listing_fields(self.baseline({
            "en-US": {"promotional_text": "x", "subtitle": "Lists for ABC hosts"},   # en-US never flags
            "it": {"promotional_text": "x", "subtitle": "Lists for ABC hosts"},      # capital marker, as written
            "fr": {"promotional_text": "x", "subtitle": "Listes pour Host"},         # lowercase marker, any case
            "de": {"promotional_text": "x", "subtitle": "Listen abc"},                # 'ABC' is case-sensitive
        }))
        self.assertEqual(self.types(opps, "subtitle_not_localized"), ["fr", "it"])

    def test_confirmed_localized_subtitle_is_not_flagged(self):
        opps = self.m.detect_empty_listing_fields(self.baseline({
            "it": {"promotional_text": "x", "subtitle": "Foto e liste con demoapp host"},
        }))
        self.assertEqual(self.types(opps, "subtitle_not_localized"), ["it"])
        opps = self.m.detect_empty_listing_fields(self.baseline({
            "it": {"promotional_text": "x", "subtitle": "Foto e liste con demoapp"},
        }))
        self.assertEqual(self.types(opps, "subtitle_not_localized"), [])

    def test_empty_promo_text_is_a_quick_win(self):
        opps = self.m.detect_empty_listing_fields(self.baseline({"en-US": {"promotional_text": " ", "subtitle": ""}}))
        self.assertEqual(self.types(opps, "empty_listing_field"), ["en-US"])

    def test_competitor_changes_skip_the_apps_own(self):
        today = self.m.TODAY
        base = {"weekly_diffs": [{"date": today, "changes": [
            {"owner": "demoapp", "store": "ios", "locale": "en-US", "field": "subtitle", "old": "a", "new": "b"},
            {"owner": "rival", "store": "android", "locale": "en-US", "field": "title", "old": "a", "new": "b"},
        ]}]}
        opps = self.m.detect_competitor_metadata_changes(base)
        self.assertEqual([o["evidence"]["competitor"] for o in opps], ["rival"])

    def test_market_with_no_tier1_rank(self):
        target = {"keywords": {"en-US": {"tier_1": ["a", "b"]}, "it": {"tier_1": ["c"]}}}
        ranks = {"ranks": {"ios": {"en-US": {"a": {"current_rank": 9}}, "it": {"c": {"current_rank": None}}},
                           "android": {}}}
        opps = self.m.detect_market_no_visibility(ranks, target)
        self.assertEqual(sorted((o["store"], o["locale"]) for o in opps),
                         [("android", "en-US"), ("android", "it"), ("ios", "it")])


class ReviewThemes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home, cls.local = make_env(APP_CFG)
        cls.m = load("aso-review-themes", cls.home, cls.local)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.home, ignore_errors=True)
        shutil.rmtree(cls.local, ignore_errors=True)

    def test_phrase_counted_once_per_review_and_targets_dropped(self):
        reviews = [
            {"id": "r1", "rating": 5, "title": "photo proof", "body": "photo proof photo proof, easy setup"},
            {"id": "r2", "rating": 4, "body": "photo proof saves time, easy setup"},
            {"id": "r3", "rating": 2, "body": "easy setup but slow sync"},
        ]
        got = {p["phrase"]: p["count"] for p in self.m.cluster(reviews, {"easy setup"})}
        self.assertEqual(got.get("photo proof"), 2)
        self.assertNotIn("easy setup", got)
        low = {p["phrase"] for p in self.m.cluster(reviews, set(), star_filter=lambda s: s and s <= 3)}
        self.assertEqual(low, set())  # one low-star review: nothing reaches 2


if __name__ == "__main__":
    unittest.main()
