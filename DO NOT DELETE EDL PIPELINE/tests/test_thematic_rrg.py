import os
import json
import gzip
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from build_thematic_rrg import institutional_rrg_symbols, load_theme_classification, rolling_rs_ratings, build_thematic_rrg_payload
from build_rs_ratings import rank_session, save_universe_history

class TestThematicRrg(unittest.TestCase):
    def test_payload_uses_full_rs_universe_and_omits_unknown_trail_points(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "ohlcv_data").mkdir(); (root / "indices_ohlcv_data").mkdir()
            (root / "theme_tracker_source.json").write_text(json.dumps({"blocks": [], "macros": []}))
            dates = pd.bdate_range("2025-01-01", periods=300).strftime("%Y-%m-%d").tolist()
            histories = {}
            for symbol, growth in (("A", .001), ("B", .002), ("C", .003), ("OUTSIDE_THEME", .004)):
                closes = np.exp(np.arange(300) * growth) * 100
                histories[symbol] = (dates, closes)
                pd.DataFrame({"Date": dates, "Open": closes, "High": closes * 1.01,
                              "Low": closes * .99, "Close": closes, "Volume": np.full(300, 1e6)}).to_csv(root / f"ohlcv_data/{symbol}.csv", index=False)
            pd.DataFrame({"Date": dates, "Close": np.full(300, 100)}).to_csv(root / "indices_ohlcv_data/NIFTY_500.csv", index=False)
            (root / "all_stocks_fundamental_analysis.json").write_text(json.dumps([
                {"symbol": s, "market_cap_crore": 2000, "turnover30_crore": 20} for s in histories]))
            taxonomy = {s: {"block": "Block", "theme": "Niche", "macro": "Macro"} for s in ("A", "B", "C")}
            eligible = {dates[-1]: set(histories), dates[-22]: {"A", "B", "C"}}
            save_universe_history(root, eligible)
            with patch("build_thematic_rrg.load_theme_classification", return_value=taxonomy):
                payload = build_thematic_rrg_payload(root, root)
            block = payload["blocks"][0]
            now = rank_session(histories, dates[-1], eligible[dates[-1]])
            prior = rank_session(histories, dates[-22], eligible[dates[-22]])
            expected_y = np.median([now[s]["composite_rs"] - prior[s]["composite_rs"] for s in taxonomy])
            self.assertEqual(block["y"], expected_y)
            self.assertEqual([point["week"] for point in block["trail"]], [0])
            for constituent in block["constituents"]:
                self.assertEqual(constituent["rsRating"], now[constituent["symbol"]]["composite_rs"])
            # Without a prior dated universe no block may claim zero momentum.
            save_universe_history(root, {dates[-1]: set(histories)})
            with patch("build_thematic_rrg.load_theme_classification", return_value=taxonomy):
                self.assertEqual(build_thematic_rrg_payload(root, root)["blocks"], [])

    def test_trail_ranks_match_the_daily_engine_with_dated_membership(self):
        dates = pd.bdate_range("2025-01-01", periods=300).strftime("%Y-%m-%d").tolist()
        histories = {symbol: (dates, np.exp(np.arange(300) * growth) * 100)
                     for symbol, growth in (("A", .001), ("B", .002), ("OUTSIDE_THEME", .003))}
        eligible = {dates[-1]: {"A", "B"}, dates[-22]: set(histories)}
        actual = rolling_rs_ratings(histories, dates, {0, 21, 26}, eligible)
        for offset in (0, 21):
            session = dates[-1-offset]
            expected = rank_session(histories, session, eligible[session])
            self.assertEqual(actual[offset], {s: row["composite_rs"] for s, row in expected.items()})
        self.assertEqual(actual[0]["B"] - actual[21]["B"], 49)
        self.assertEqual(actual[26], {})  # No dated membership means unknown, never another formula.

    def test_trail_ranks_align_by_date_when_a_stock_misses_a_session(self):
        dates = pd.bdate_range("2025-01-01", periods=300).strftime("%Y-%m-%d").tolist()
        closes = np.arange(100., 400.)
        missing = 295
        histories = {"A": (dates, closes), "B": (dates[:missing] + dates[missing+1:], np.delete(closes, missing))}
        actual = rolling_rs_ratings(histories, dates, {0, 4}, {dates[-1]: {"A", "B"}, dates[missing]: {"A", "B"}})
        self.assertNotIn("B", actual[4])
        self.assertEqual(actual[0], {s: r["composite_rs"] for s, r in rank_session(histories, dates[-1], {"A", "B"}).items()})

    @classmethod
    def setUpClass(cls):
        cls.repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        cls.json_path = os.path.join(cls.repo_root, "frontend", "public", "data", "thematic_rrg.json")
        cls.gz_path = os.path.join(cls.repo_root, "frontend", "public", "data", "thematic_rrg.json.gz")
        
        if not os.path.exists(cls.json_path):
            if os.path.exists(cls.gz_path):
                with gzip.open(cls.gz_path, "rt", encoding="utf-8") as f:
                    cls.data = json.load(f)
            else:
                raise FileNotFoundError(f"Missing {cls.json_path} and {cls.gz_path}")
        else:
            with open(cls.json_path, "r", encoding="utf-8") as f:
                cls.data = json.load(f)

    def test_schema_top_level(self):
        d = self.data
        self.assertEqual(d.get("schemaVersion"), 1)
        self.assertIn("asOfDate", d)
        self.assertEqual(d.get("benchmark"), "NIFTY 500")
        self.assertIsInstance(d.get("benchmark3mReturn"), (int, float))
        self.assertEqual(d.get("trailWeeks"), 12)
        self.assertGreaterEqual(d.get("totalBlocks"), 20)
        self.assertGreaterEqual(d.get("totalNiches"), 100)
        self.assertGreaterEqual(d.get("totalEquities"), 2000)
        self.assertIsInstance(d.get("blocks"), list)
        self.assertIsInstance(d.get("niches"), list)

    def test_quadrant_assignment(self):
        for block in self.data["blocks"]:
            x = block["x"]
            y = block["y"]
            q = block["quadrant"]
            if x >= 0 and y >= 0:
                self.assertEqual(q, "Leading", f"Block {block['name']} with x={x}, y={y} should be Leading")
            elif x >= 0 and y < 0:
                self.assertEqual(q, "Weakening", f"Block {block['name']} with x={x}, y={y} should be Weakening")
            elif x < 0 and y < 0:
                self.assertEqual(q, "Lagging", f"Block {block['name']} with x={x}, y={y} should be Lagging")
            else:
                self.assertEqual(q, "Improving", f"Block {block['name']} with x={x}, y={y} should be Improving")

    def test_trail_points(self):
        for block in self.data["blocks"]:
            trail = block["trail"]
            self.assertEqual(len(trail), 13, f"Block {block['name']} should have 13 trail points (0 to 12)")
            weeks = [pt["week"] for pt in trail]
            self.assertEqual(weeks, list(range(12, -1, -1)), "Weeks should be sequentially 12 down to 0 (oldest to current)")
            # Current point (week 0) should match block (x, y, quadrant)
            w0 = trail[-1]
            self.assertEqual(w0["week"], 0)
            self.assertAlmostEqual(w0["x"], block["x"], places=2)
            self.assertAlmostEqual(w0["y"], block["y"], places=2)
            self.assertEqual(w0["quadrant"], block["quadrant"])

    def test_block_constituents_and_metrics(self):
        for block in self.data["blocks"]:
            metrics = block["metrics"]
            self.assertIn("excessReturn3m", metrics)
            self.assertIn("rsMomentum21d", metrics)
            self.assertIn("medianRs", metrics)
            self.assertIn("beatingBenchmarkPct", metrics)
            self.assertIn("improvingRsPct", metrics)
            self.assertIn("setupCoveragePct", metrics)
            self.assertIn("constituentCount", metrics)
            self.assertEqual(metrics["constituentCount"], len(block["constituents"]))

            for stock in block["constituents"]:
                self.assertIn("symbol", stock)
                self.assertIn("close", stock)
                self.assertIn("changePct", stock)
                self.assertIn("marketCapCr", stock)
                self.assertIn("setups", stock)
                setups = stock["setups"]
                for k in ["stage2", "vcp", "darvas", "bullFlag", "cupHandle", "pocketPivot", "coiled", "tightWeeks"]:
                    self.assertIn(k, setups)
                    self.assertIsInstance(setups[k], bool)

    def test_niche_parent_block_linkage(self):
        block_names = {b["name"] for b in self.data["blocks"]}
        for niche in self.data["niches"]:
            self.assertIsNotNone(niche["parentBlock"])
            self.assertIn(niche["parentBlock"], block_names, f"Niche {niche['name']} points to unknown block {niche['parentBlock']}")
            self.assertEqual(len(niche["trail"]), 13)

    def test_tactical_ipo_rrg(self):
        self.assertIn("ipoTactical", self.data)
        ipos = self.data["ipoTactical"]
        self.assertGreater(len(ipos), 0)

        for item in ipos:
            self.assertIn("excessReturn10d", item)
            self.assertIn("turnoverIntensity", item)
            self.assertIn("quadrant", item)
            self.assertIn("listingDate", item)
            self.assertIn("listingAgeDays", item)
            self.assertIn("sessions", item)
            self.assertGreaterEqual(item["sessions"], 5)
            self.assertLess(item["sessions"], 65, f"Stock {item['symbol']} with {item['sessions']} sessions should have graduated to main RRG")
            self.assertLessEqual(item["listingAgeDays"], 300)
            self.assertGreaterEqual(len(item["trail"]), 1)
            x = item["x"]
            y = item["y"]
            q = item["quadrant"]
            if x >= 0 and y >= 0:
                self.assertEqual(q, "Leading")
            elif x >= 0 and y < 0:
                self.assertEqual(q, "Weakening")
            elif x < 0 and y < 0:
                self.assertEqual(q, "Lagging")
            else:
                self.assertEqual(q, "Improving")

    def test_institutional_main_rrg_eligibility(self):
        closes = np.full(65, 25.0)
        histories = {
            "PASS": (["2026-01-01"] * 65, closes),
            "CAP_EDGE": (["2026-01-01"] * 65, closes),
            "PRICE_EDGE": (["2026-01-01"] * 65, np.full(65, 10.0)),
            "SECOND_PASS": (["2026-01-01"] * 65, closes),
            "TURNOVER_EDGE": (["2026-01-01"] * 65, closes),
            "SHORT": (["2026-01-01"] * 64, np.full(64, 25.0)),
        }
        stock_map = {
            "PASS": {"market_cap_crore": 1_000, "metrics": {"turnover30": 6.5}},
            "CAP_EDGE": {"market_cap_crore": 999, "metrics": {"turnover30": 10.0}},
            "PRICE_EDGE": {"market_cap_crore": 1_000, "metrics": {"turnover30": 10.0}},
            "SECOND_PASS": {"market_cap_crore": 1_000, "turnover30_crore": 8.0},
            "TURNOVER_EDGE": {"market_cap_crore": 1_000, "metrics": {"turnover30": 5.0}},
            "SHORT": {"market_cap_crore": 1_000, "metrics": {"turnover30": 10.0}},
        }
        self.assertEqual(institutional_rrg_symbols(histories, stock_map), {"PASS", "SECOND_PASS"})

    def test_editable_taxonomy_overrides_frozen_snapshot_and_keeps_extra_memberships(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            frontend_dir = Path(temp_dir)
            (frontend_dir / "public/data/revisions/r2").mkdir(parents=True)
            with gzip.open(frontend_dir / "public/data/revisions/r2/theme-classification.json.gz", "wt", encoding="utf-8") as f:
                json.dump({"records": {"ABC": {"thematic": {"theme": "Frozen theme"}}}}, f)
            (frontend_dir / "theme_tracker_source.json").write_text(json.dumps({
                "macros": [{"title": "Macro", "blocks": ["Block"]}],
                "blocks": [{"title": "Block", "themes": [{
                    "name": "Editable niche", "symbols": ["ABC", "EXTRA"],
                }]}],
                "fields": ["symbol", "theme", "provenance"],
                "rows": [["ABC", "Primary theme", "manual"]],
            }), encoding="utf-8")

            records = load_theme_classification(frontend_dir)

            self.assertEqual(records["ABC"]["theme"], "Primary theme")
            self.assertIn("Editable niche", records["ABC"]["memberships"])
            self.assertEqual(records["EXTRA"]["theme"], "Editable niche")

if __name__ == "__main__":
    unittest.main()
