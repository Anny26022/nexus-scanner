import importlib.util
import bisect
import math
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
        self.assertEqual(ranked['one_month'], {'A':99, 'B':1})
        self.assertEqual(ranked['front_weighted'], {'B':99, 'A':1})
        old = {symbol:sum(weight * value for weight, value in zip(rs.FRONT_WEIGHTED_WEIGHTS.values(), values))
               for symbol, values in ratios.items()}
        self.assertGreater(old['A'], old['B'])

    def test_uses_one_complete_finite_universe_for_every_period(self):
        scores = {key:{'A':1., 'B':2., 'MISSING':3., 'INVALID':float('nan')}
                  for key in rs.FRONT_WEIGHTED_HORIZONS}
        del scores['one_month']['MISSING']
        ranked = rs.rank_first_ratings(scores)
        for values in ranked.values():
            self.assertEqual(values, {'A':1, 'B':99})
        self.assertTrue(all(not values for values in rs.rank_first_ratings({}).values()))

    def test_equal_period_scores_share_period_rank_but_have_ordinal_final_ratings(self):
        scores = {key:{'A':1., 'B':1., 'C':2.} for key in rs.FRONT_WEIGHTED_HORIZONS}
        ranked = rs.rank_first_ratings(scores)
        self.assertEqual(ranked['one_month'], {'A':1, 'B':1, 'C':99})
        self.assertEqual(ranked['front_weighted'], {'C':99, 'A':50, 'B':1})

    def test_equal_weighted_composites_use_stable_symbol_order(self):
        scores = {'one_month':{'A':1., 'B':2.}, 'three_month':{'A':2., 'B':1.},
                  'six_month':{'A':2., 'B':1.}, 'twelve_month':{'A':1., 'B':1.}}
        self.assertEqual(rs.rank_first_ratings(scores)['front_weighted'], {'A':99, 'B':1})
        reversed_scores = {key:dict(reversed(list(values.items()))) for key, values in scores.items()}
        self.assertEqual(rs.rank_first_ratings(scores), rs.rank_first_ratings(reversed_scores))

    def test_equal_composites_ignore_float_roundoff(self):
        # Lower counts A=(0,0,0,7), B=(0,0,1,6) both weight to 140.
        # Fractional float aggregation incorrectly puts B slightly above A.
        scores = {key:{'A':1., 'B':1.} for key in rs.FRONT_WEIGHTED_HORIZONS}
        scores['six_month']['B'] = 2.
        scores['twelve_month'].update(A=8., B=7.)
        remaining = [*range(1, 7), *range(9, 103)]
        for i in range(100):
            symbol = f'X{i:03}'
            for key in ('one_month', 'three_month'):
                scores[key][symbol] = float(i + 2)
            scores['six_month'][symbol] = float(i + 3)
            scores['twelve_month'][symbol] = float(remaining[i])
        ratings = rs.rank_first_ratings(scores)['front_weighted']
        self.assertGreater(ratings['A'], ratings['B'])

    def test_matches_independent_weighted_rank_calculation(self):
        weights = {'one_month':.40, 'three_month':.20, 'six_month':.20, 'twelve_month':.20}
        self.assertEqual(rs.FRONT_WEIGHTED_WEIGHTS, weights)
        # Independent transcription of momentumScreen.calc from MarketStrength
        # app.js?v=8f39ec222d: binary-search lower ranks, then ordinal ratings.
        scores = {key:{str(i):float((i * multiplier) % 101 + 1) for i in range(102)}
                  for key, multiplier in zip(rs.FRONT_WEIGHTED_HORIZONS, (1, 3, 7, 11))}
        ranked = rs.rank_first_ratings(scores)
        symbols = sorted(scores['one_month'])
        weighted = dict.fromkeys(symbols, 0.)
        for key, weight in weights.items():
            ordered = sorted(scores[key].values())
            for symbol in symbols:
                rank = 1 + 98 * bisect.bisect_left(ordered, scores[key][symbol]) / (len(symbols) - 1)
                weighted[symbol] += round(weight * 100) * rank
        ordered = sorted(symbols, key=lambda symbol: -weighted[symbol] / 100)
        expected = {symbol:math.floor(99 - 98 * i / (len(symbols) - 1) + .5)
                    for i, symbol in enumerate(ordered)}
        self.assertEqual(ranked['front_weighted'], expected)
        rounded = sorted(symbols, key=lambda symbol: -sum(round(weight * 100) * ranked[key][symbol]
                         for key, weight in rs.FRONT_WEIGHTED_WEIGHTS.items()))
        self.assertNotEqual(ordered, rounded, 'Fixture must catch premature period-rank rounding')

    def test_single_stock_and_half_up_rounding(self):
        single = {key:{'A':1.} for key in rs.FRONT_WEIGHTED_HORIZONS}
        self.assertEqual(rs.rank_first_ratings(single)['front_weighted'], {'A':99})
        scores = {key:{str(i):i + 1. for i in range(5)} for key in rs.FRONT_WEIGHTED_HORIZONS}
        ranked = rs.rank_first_ratings(scores)
        self.assertEqual(ranked['one_month']['3'], 75)  # 74.5, not Python's round-to-even 74
        self.assertEqual(ranked['front_weighted']['1'], 26)

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
            self.assertIn('unrounded', payload['methodology']['score_formula'])
            self.assertEqual(set(payload['ratings']['TEST']), {*rs.FRONT_WEIGHTED_HORIZONS, 'front_weighted'})

    def test_counts_strictly_lower_scores_exactly(self):
        self.assertEqual(rs.strictly_lower_counts({'A':1., 'B':1., 'C':2., 'D':3.}),
                         {'A':0, 'B':0, 'C':2, 'D':3})
        self.assertEqual(rs.strictly_lower_counts({}), {})


if __name__ == "__main__":
    unittest.main()
