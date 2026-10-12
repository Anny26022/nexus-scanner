import importlib.util
import sys
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SPEC = importlib.util.spec_from_file_location("build_rs_ratings", ROOT / "build_rs_ratings.py")
rs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rs)


class FrontWeightedRsTests(unittest.TestCase):
    def test_uses_benchmark_relative_horizon_formulae(self):
        dates = pd.date_range("2025-01-01", periods=260, freq="B")
        benchmark = pd.DataFrame({"Date": dates, "Close": [100.0] * len(dates)})
        stock = benchmark.copy()
        stock.loc[stock.index[-1], "Close"] = 120.0
        benchmark.loc[benchmark.index[-1], "Close"] = 110.0

        scores = rs.relative_strength_scores(stock, benchmark, dates[-1].date())

        # Every stock ratio is 1.20 and every benchmark ratio is 1.10.
        self.assertAlmostEqual(scores["one_month"], 1.20 / 1.10)
        self.assertAlmostEqual(scores["three_month"], 1.20 / 1.10)
        self.assertAlmostEqual(scores["six_month"], 1.20 / 1.10)
        self.assertAlmostEqual(scores["twelve_month"], 1.20 / 1.10)
        self.assertEqual(set(scores), set(rs.FRONT_WEIGHTED_HORIZONS))

    def test_rejects_stale_or_insufficiently_aligned_history(self):
        dates = pd.date_range("2025-01-01", periods=260, freq="B")
        benchmark = pd.DataFrame({"Date": dates, "Close": [100.0] * len(dates)})
        stale = benchmark.iloc[:-1].copy()
        self.assertIsNone(rs.relative_strength_scores(stale, benchmark, dates[-1].date()))
        self.assertIsNone(rs.relative_strength_scores(benchmark.iloc[:259], benchmark, dates[-1].date()))
        self.assertIsNone(rs.relative_strength_scores(benchmark, stale, dates[-1].date()))

    def test_rejects_invalid_price_endpoints(self):
        dates = pd.bdate_range(end='2026-10-09', periods=260)
        benchmark = pd.DataFrame({'Date':dates, 'Close':100.})
        for value in (0, -1, float('nan'), float('inf')):
            with self.subTest(value=value):
                stock = benchmark.copy()
                stock.loc[stock.index[-22], 'Close'] = value
                self.assertIsNone(rs.relative_strength_scores(stock, benchmark, dates[-1].date()))

    def test_ranks_before_weighting_instead_of_weighting_return_magnitudes(self):
        ratios = {'A':[2., .9, .9, .9], 'B':[1.1]*4}
        scores = {key:{symbol:values[i] for symbol, values in ratios.items()}
                  for i, key in enumerate(rs.FRONT_WEIGHTED_HORIZONS)}
        ranked = rs.rank_first_ratings(scores)
        self.assertEqual(ranked['one_month'], {'A':50, 'B':1})
        self.assertEqual(ranked['front_weighted'], {'A':1, 'B':50})
        old = {symbol:sum(weight * value for weight, value in zip(rs.FRONT_WEIGHTED_WEIGHTS.values(), values))
               for symbol, values in ratios.items()}
        self.assertGreater(old['A'], old['B'])

    def test_uses_one_complete_finite_universe_for_every_period(self):
        scores = {key:{'A':1., 'B':2., 'MISSING':3., 'INVALID':float('nan')}
                  for key in rs.FRONT_WEIGHTED_HORIZONS}
        del scores['one_month']['MISSING']
        ranked = rs.rank_first_ratings(scores)
        for values in ranked.values():
            self.assertEqual(values, {'A':1, 'B':50})
        self.assertTrue(all(not values for values in rs.rank_first_ratings({}).values()))

    def test_equal_period_scores_keep_equal_final_ratings(self):
        scores = {key:{'A':1., 'B':1., 'C':2.} for key in rs.FRONT_WEIGHTED_HORIZONS}
        ranked = rs.rank_first_ratings(scores)
        self.assertEqual(ranked['front_weighted']['A'], ranked['front_weighted']['B'])

    def test_equal_weighted_composites_keep_equal_final_ratings(self):
        scores = {'one_month':{'A':1., 'B':2.}, 'three_month':{'A':2., 'B':1.},
                  'six_month':{'A':2., 'B':1.}, 'twelve_month':{'A':1., 'B':1.}}
        self.assertEqual(rs.rank_first_ratings(scores)['front_weighted'], {'A':1, 'B':1})

    def test_matches_independent_weighted_rank_calculation(self):
        # Synthetic published period ranks can be used directly: check the
        # 40/20/20/20 aggregation and final strict-lower rank independently.
        scores = {key:{str(i):float((i * multiplier) % 101 + 1) for i in range(101)}
                  for key, multiplier in zip(rs.FRONT_WEIGHTED_HORIZONS, (1, 3, 7, 11))}
        ranked = rs.rank_first_ratings(scores)
        weighted = {symbol:sum(rs.FRONT_WEIGHTED_WEIGHTS[key] * ranked[key][symbol]
                               for key in rs.FRONT_WEIGHTED_HORIZONS) for symbol in ranked['one_month']}
        expected = rs.percentile_ratings({symbol:round(value, 8) for symbol, value in weighted.items()})
        self.assertEqual(ranked['front_weighted'], expected)

    def test_publication_versions_methodology_without_changing_rating_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'indices_ohlcv_data').mkdir()
            (root / 'ohlcv_data').mkdir()
            frame = pd.DataFrame({'Date':pd.bdate_range(end='2026-10-09', periods=260), 'Close':100.})
            frame.to_csv(root / 'indices_ohlcv_data/NIFTY_500.csv', index=False)
            frame.to_csv(root / 'ohlcv_data/TEST.csv', index=False)
            with patch.object(rs, 'BASE_DIR', root), patch.object(rs, 'liquid_universe', return_value=({'TEST'}, 'fixture')), \
                    patch.object(rs, 'save_json') as save:
                self.assertTrue(rs.main())
            payload = save.call_args.args[1]
            self.assertEqual(payload['methodology']['version'], 'nexus_rank_first_v3')
            self.assertEqual(payload['as_of_date'], '2026-10-09')
            self.assertEqual(payload['methodology']['weights'], rs.FRONT_WEIGHTED_WEIGHTS)
            self.assertEqual(set(payload['ratings']['TEST']), {*rs.FRONT_WEIGHTED_HORIZONS, 'front_weighted'})

    def test_maps_strictly_lower_scores_to_bounded_integer_ratings(self):
        ratings = rs.percentile_ratings({"A": 1.0, "B": 1.0, "C": 2.0, "D": 3.0})
        self.assertEqual(ratings["A"], 1)
        self.assertEqual(ratings["B"], 1)
        # The supplied strict-lower / total-universe equation intentionally
        # reaches 99 only in a sufficiently broad cross-section.
        self.assertEqual(ratings["D"], 74)
        self.assertTrue(all(1 <= rating <= 99 for rating in ratings.values()))


if __name__ == "__main__":
    unittest.main()
