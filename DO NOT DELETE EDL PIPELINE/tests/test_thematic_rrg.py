import os
import json
import gzip
import sys
import tempfile
import unittest
from pathlib import Path
from datetime import date, timedelta
from unittest.mock import patch

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from build_thematic_rrg import institutional_rrg_symbols, load_theme_classification, rolling_rs_ratings, build_thematic_rrg_payload, thematic_index_histories, index_rs_ratings, required_rs_dates
from build_rs_ratings import rank_session, save_universe_history

class TestThematicRrg(unittest.TestCase):
    def test_required_rs_dates_include_every_weekly_anchor_and_21_session_predecessor(self):
        dates = pd.bdate_range('2025-01-01', periods=400).strftime('%Y-%m-%d').tolist()
        offsets, requested = required_rs_dates(dates, 12)
        self.assertEqual(offsets, {offset for week in range(13) for offset in (week * 5, week * 5 + 21)})
        self.assertEqual(len(requested), len(offsets))
        with self.assertRaisesRegex(ValueError, 'needs 124 benchmark sessions'):
            required_rs_dates(dates[-123:], 12)

    def test_index_rank_ties_singletons_and_short_benchmark_are_safe(self):
        dates = pd.bdate_range('2025-01-01', periods=160).strftime('%Y-%m-%d').tolist()
        prices = {d: 100 + i for i, d in enumerate(dates)}
        histories = [{'name': name, 'prices': prices} for name in ('Zeta', 'Alpha')]
        bench = np.linspace(100, 150, len(dates))
        ranks = index_rs_ratings(histories, dates, bench, {0, 21})
        self.assertEqual(ranks[0]['Zeta'], ranks[0]['Alpha'])
        self.assertEqual(index_rs_ratings(histories[:1], dates, bench, {0})[0]['Zeta'], 50)
        self.assertEqual(index_rs_ratings(histories, dates[:64], bench[:64], {21}), {})

    def test_official_index_payload_returns_ranks_and_all_replay_anchors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'indices_ohlcv_data').mkdir()
            (root / 'theme_tracker_source.json').write_text(json.dumps({'blocks': [], 'macros': []}))
            dates = pd.bdate_range('2025-01-01', periods=300).strftime('%Y-%m-%d').tolist()
            bench = np.linspace(100, 150, len(dates))
            pd.DataFrame({'Date': dates, 'Close': bench}).to_csv(root / 'indices_ohlcv_data/NIFTY_500.csv', index=False)
            contracts = [('Nifty India Defence', 'DEFENCE', .001), ('Nifty IPO', 'IPO', .002), ('NIFTY MNC', 'MNC', .003)]
            all_prices = {}
            for source, symbol, growth in contracts:
                closes = 100 * np.exp(np.arange(300) * growth)
                if symbol == 'DEFENCE':
                    closes[-21:] *= np.linspace(1, 1.5, 21)
                all_prices[source] = closes
                pd.DataFrame({'Date': dates, 'Close': closes}).to_csv(root / f'indices_ohlcv_data/{symbol}.csv', index=False)
            (root / 'all_indices_list.json').write_text(json.dumps([
                {'IndexName': source, 'Symbol': symbol, 'IndexID': i} for i, (source, symbol, _) in enumerate(contracts)]))
            with patch('build_thematic_rrg.load_theme_classification', return_value={'UNUSED': {}}):
                payload = build_thematic_rrg_payload(root, root)
            self.assertEqual(payload['totalThematicIndices'], 3)
            self.assertEqual(payload['thematicIndexCoverage']['requested'], 29)
            self.assertEqual(len(payload['thematicIndexCoverage']['missing']), 26)
            defence = next(item for item in payload['thematicIndices'] if item['name'] == 'Nifty India Defence')
            closes = all_prices['Nifty India Defence']
            for horizon, field in ((21, 'excessReturn1m'), (63, 'excessReturn3m'), (126, 'excessReturn6m')):
                expected = ((closes[-1] / closes[-1-horizon] - 1) - (bench[-1] / bench[-1-horizon] - 1)) * 100
                self.assertEqual(defence['metrics'][field], round(float(expected), 2))
            self.assertEqual([p['week'] for p in defence['trail']], list(range(12, -1, -1)))
            self.assertGreater(defence['y'], 0)
            for point in defence['trail']:
                offset = point['week'] * 5
                self.assertEqual(point['date'], dates[-1-offset])
                expected_x = ((closes[-1-offset] / closes[-64-offset] - 1) - (bench[-1-offset] / bench[-64-offset] - 1)) * 100
                self.assertEqual(point['x'], round(float(expected_x), 2))
            self.assertEqual(defence['x'], defence['trail'][-1]['x'])
            self.assertEqual(defence['y'], defence['trail'][-1]['y'])
            # A missing observation excludes the official series; no stock basket may replace it.
            frame = pd.read_csv(root / 'indices_ohlcv_data/DEFENCE.csv')
            frame.iloc[:-1].to_csv(root / 'indices_ohlcv_data/DEFENCE.csv', index=False)
            self.assertEqual(len(thematic_index_histories(root, dates)), 2)

    def test_index_loader_handles_short_windows_and_provider_filename_collisions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'indices_ohlcv_data').mkdir()
            dates = pd.bdate_range('2025-01-01', periods=130).strftime('%Y-%m-%d').tolist()
            (root / 'all_indices_list.json').write_text(json.dumps([
                {'IndexName': name, 'Symbol': 'SHARED', 'IndexID': i} for i, name in enumerate(('Nifty IPO', 'Nifty India Defence'))]))
            for i in range(2):
                pd.DataFrame({'Date': dates, 'Close': np.full(len(dates), 100 + i)}).to_csv(
                    root / f'indices_ohlcv_data/SHARED__{i}.csv', index=False)
            self.assertEqual(thematic_index_histories(root, dates[:64]), [])
            self.assertEqual(thematic_index_histories(root, dates), [])  # 12 weeks require 145 sessions.
            loaded = thematic_index_histories(root, dates, trail_weeks=4)
            self.assertEqual(len(loaded), 2)
            self.assertEqual({h['prices'][dates[-1]] for h in loaded}, {100, 101})

    def test_ipo_trail_uses_observed_volumes_dates_and_excludes_future_and_stale_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ohlcv_data").mkdir(); (root / "indices_ohlcv_data").mkdir()
            (root / "theme_tracker_source.json").write_text(json.dumps({"blocks": [], "macros": []}))
            dates = pd.bdate_range("2025-01-01", periods=250).strftime("%Y-%m-%d").tolist()
            benchmark = np.linspace(100, 200, 250)
            pd.DataFrame({"Date": dates, "Close": benchmark}).to_csv(root / "indices_ohlcv_data/NIFTY_500.csv", index=False)
            ipo_dates = dates[-13:-5] + dates[-4:]  # One missing stock session.
            closes = np.linspace(100, 120, len(ipo_dates))
            volumes = np.array([100.] * 7 + [1000.] * 5)
            for symbol in ("IPO", "STALE"):
                ds, cs, vs = (ipo_dates, closes, volumes) if symbol == "IPO" else (ipo_dates[:-1], closes[:-1], volumes[:-1])
                frame = pd.DataFrame({"Date": ds, "Open": cs, "High": cs + 1, "Low": cs - 1, "Close": cs, "Volume": vs})
                if symbol == "IPO":
                    frame.loc[len(frame)] = ["2030-01-01", 999, 1000, 998, 999, 1e9]
                frame.iloc[::-1].to_csv(root / f"ohlcv_data/{symbol}.csv", index=False)
            (root / "all_stocks_fundamental_analysis.json").write_text(json.dumps([
                {"symbol": s, "listingDate": ipo_dates[0], "name": s, "market_cap_crore": 2000} for s in ("IPO", "STALE")]))
            with patch("build_thematic_rrg.load_theme_classification", return_value={s: {} for s in ("IPO", "STALE")}):
                payload = build_thematic_rrg_payload(root, root)
            self.assertEqual([item["symbol"] for item in payload["ipoTactical"]], ["IPO"])
            ipo = payload["ipoTactical"][0]
            self.assertEqual(ipo["marketCapCr"], 2000)
            self.assertEqual(ipo["close"], 120)
            for point in ipo["trail"]:
                end = len(volumes) - point["week"]
                expected_y = (np.mean(volumes[max(0, end - 5):end]) / np.mean(volumes[:end]) - 1) * 100
                self.assertEqual(point["y"], round(float(min(300, max(-100, expected_y))), 1))
                self.assertEqual(point["date"], ipo_dates[end - 1])
            self.assertEqual(ipo["trail"][-1]["y"], ipo["y"])
            self.assertEqual(ipo["trail"][-1]["x"], ipo["x"])

    def test_payload_uses_full_rs_universe_and_omits_unknown_trail_points(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "ohlcv_data").mkdir(); (root / "indices_ohlcv_data").mkdir()
            (root / "theme_tracker_source.json").write_text(json.dumps({"blocks": [], "macros": []}))
            dates = pd.bdate_range("2025-01-01", periods=1000).strftime("%Y-%m-%d").tolist()
            histories = {}
            for symbol, growth in (("A", .001), ("B", .002), ("C", .003), ("OUTSIDE_THEME", .004)):
                closes = np.exp(np.arange(1000) * growth) * 100
                histories[symbol] = (dates, closes)
                pd.DataFrame({"Date": dates, "Open": closes, "High": closes * 1.01,
                              "Low": closes * .99, "Close": closes, "Volume": np.full(1000, 1e6)}).to_csv(root / f"ohlcv_data/{symbol}.csv", index=False)
            benchmark = np.linspace(100, 200, 1000)
            pd.DataFrame({"Date": dates, "Close": benchmark}).to_csv(root / "indices_ohlcv_data/NIFTY_500.csv", index=False)
            (root / "all_stocks_fundamental_analysis.json").write_text(json.dumps([
                {"symbol": s, "market_cap_crore": 2000, "turnover30_crore": 20} for s in histories]))
            # During Phase 4.5 yesterday's gzip can coexist with today's enriched JSON.
            with gzip.open(root / "all_stocks_fundamental_analysis.json.gz", "wt") as handle:
                json.dump([], handle)
            taxonomy = {s: {"block": "Block", "theme": "Niche", "macro": "Macro"} for s in ("A", "B", "C")}
            _, requested_dates = required_rs_dates(dates, 12)
            eligible = {day: set(histories) for day in requested_dates}
            eligible[dates[-22]] = {"A", "B", "C"}
            save_universe_history(root, eligible)
            with patch("build_thematic_rrg.load_theme_classification", return_value=taxonomy):
                payload = build_thematic_rrg_payload(root, root)
            block = payload["blocks"][0]
            now = rank_session(histories, dates[-1], eligible[dates[-1]])
            prior = rank_session(histories, dates[-22], eligible[dates[-22]])
            expected_y = np.median([now[s]["composite_rs"] - prior[s]["composite_rs"] for s in taxonomy])
            self.assertEqual(block["y"], expected_y)
            self.assertAlmostEqual(block["metrics"]["excessReturn6m"], round(float(np.median([
                (histories[s][1][-1] / histories[s][1][-127] - 1) * 100 for s in taxonomy])
                - (benchmark[-1] / benchmark[-127] - 1) * 100), 2))
            self.assertEqual([point["week"] for point in block["trail"]], list(range(12, -1, -1)))
            self.assertTrue(payload["rsCoverage"]["momentumAvailable"])
            self.assertEqual(payload["membershipBasis"], "current_constituents")
            self.assertEqual(payload["membershipAsOf"], dates[-1])
            for constituent in block["constituents"]:
                self.assertEqual(constituent["rsRating"], now[constituent["symbol"]]["composite_rs"])
            # Missing anchors must stop generation rather than publish a partial trail.
            save_universe_history(root, {dates[-1]: set(histories)})
            with patch("build_thematic_rrg.load_theme_classification", return_value=taxonomy):
                with self.assertRaisesRegex(ValueError, "Dated RS universe is missing"):
                    build_thematic_rrg_payload(root, root)

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
            source = json.loads((Path(self.repo_root) / "frontend/theme_tracker_source.json").read_text())
            primary = source["blocks"][0]["themes"][0]["name"]
            source["blocks"][0]["themes"].append({"name": "Editable niche", "symbols": ["ABC", "EXTRA"],
                                                   "allowMultipleMembership": True})
            row = {"symbol": "ABC", "theme": primary, "provenance": "manual"}
            source["rows"].append([row.get(field) for field in source["fields"]])
            (frontend_dir / "theme_tracker_source.json").write_text(json.dumps(source))
            records = load_theme_classification(frontend_dir, [{"symbol": "ABC"}, {"symbol": "EXTRA"}], "2026-10-21")

            self.assertEqual(records["ABC"]["theme"], primary)
            self.assertIn("Editable niche", records["ABC"]["memberships"])
            self.assertEqual(records["EXTRA"]["theme"], "Editable niche")

    def test_thematic_indices_use_only_aligned_official_history(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "indices_ohlcv_data").mkdir()
            (root / "all_indices_list.json").write_text(json.dumps([{
                "IndexName": "Nifty India Defence", "Symbol": "NIFTY IND DEFENCE", "IndexID": 493,
            }]), encoding="utf-8")
            dates = [(date(2026, 1, 1) + timedelta(days=offset)).isoformat() for offset in range(150)]
            (root / "indices_ohlcv_data" / "NIFTY_IND_DEFENCE.csv").write_text(
                "Date,Close\n" + "\n".join(f"{session},{100 + offset}" for offset, session in enumerate(dates)),
                encoding="utf-8",
            )

            histories = thematic_index_histories(root, dates)

            self.assertEqual(len(histories), 1)
            self.assertEqual(histories[0]["name"], "Nifty India Defence")
            self.assertEqual(histories[0]["prices"][dates[-1]], 249.0)

if __name__ == "__main__":
    unittest.main()
