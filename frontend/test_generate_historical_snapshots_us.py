import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest
from datetime import date

import numpy as np
import pandas as pd

# Frontend CI discovers tests from frontend/, where the sibling tools/ folder is not importable.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import generate_historical_snapshots_us as gen  # noqa: E402
from edl_pipeline.scanner.indicators import indicator_series  # noqa: E402


def frame_of(closes, highs=None, lows=None, opens=None, volumes=None):
    n = len(closes)
    return pd.DataFrame({
        "Open": closes - 0.5 if opens is None else opens,
        "High": closes + 1.0 if highs is None else highs,
        "Low": closes - 1.0 if lows is None else lows,
        "Close": closes,
        "Volume": np.full(n, 1_000_000.0) if volumes is None else volumes,
    })


class GenerateHistoricalSnapshotsUsTests(unittest.TestCase):
    def test_calculate_technicals_us_computes_core_metrics(self):
        # 260 synthetic sessions with rising price and volume
        closes = np.linspace(50.0, 160.0, 260)
        frame = frame_of(closes)
        tech = gen.calculate_technicals_us(frame.Open.values, closes, frame.High.values, frame.Low.values, frame.Volume.values)

        self.assertEqual(tech['close'], 160.0)
        self.assertEqual(tech['high'], 161.0)
        self.assertEqual(tech['low'], 159.0)
        self.assertAlmostEqual(tech['sma10'], float(np.mean(closes[-10:])), places=1)
        self.assertAlmostEqual(tech['sma20'], float(np.mean(closes[-20:])), places=1)
        self.assertAlmostEqual(tech['sma50'], float(np.mean(closes[-50:])), places=1)
        self.assertAlmostEqual(tech['sma200'], float(np.mean(closes[-200:])), places=1)
        self.assertTrue(tech['close_above_sma20'])
        self.assertTrue(tech['close_above_sma50'])
        self.assertTrue(tech['sma50_above_sma200'])
        self.assertEqual(tech['rvol'], 1.0)
        self.assertGreater(tech['rsi14'], 70.0)  # Consistently rising price has high RSI
        self.assertAlmostEqual(tech['dist52wHighPct'], -0.62, places=2)

    def test_rsi_and_atr_match_the_live_wilder_series(self):
        rng = np.random.default_rng(7)
        closes = np.clip(np.cumsum(rng.normal(0, 2, 400)) + 100.0, 5.0, None)
        frame = frame_of(closes, highs=closes + rng.uniform(0.5, 3, 400), lows=closes - rng.uniform(0.5, 3, 400))
        tech = gen.calculate_technicals_us(frame.Open.values, closes, frame.High.values, frame.Low.values, frame.Volume.values)
        self.assertAlmostEqual(tech['rsi14'], round(float(indicator_series(frame, 'RSI', 14).iloc[-1]), 2))
        # The live ATR (advanced_metrics_processor): Wilder smoothing over the whole history, not the last 56 bars.
        true_range = pd.concat([frame.High - frame.Low, (frame.High - frame.Close.shift(1)).abs(),
                                (frame.Low - frame.Close.shift(1)).abs()], axis=1).max(axis=1)
        live_atr = true_range.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean().iloc[-1]
        self.assertAlmostEqual(tech['atr14'], round(float(live_atr), 2))

    def test_short_history_leaves_windowed_values_unavailable(self):
        closes = np.linspace(10.0, 12.0, 30)
        frame = frame_of(closes)
        tech = gen.calculate_technicals_us(frame.Open.values, closes, frame.High.values, frame.Low.values, frame.Volume.values)
        self.assertIsNotNone(tech['sma20'])
        for key in ('sma50', 'sma200', 'ema50', 'ema200', 'dist52wHighPct', 'dist52wLowPct', 'return63',
                    'daily_turnover_50_m', 'return5yPct', 'close_above_sma50', 'sma50_above_sma200'):
            self.assertIsNone(tech[key], key)
        presets = gen.preset_matches(tech, None)
        self.assertFalse(presets['trend_template'])
        self.assertFalse(presets['lib-52w-high-breakout'])
        self.assertFalse(presets['vcp_contraction'])

    def test_session_frame_keeps_only_nyse_sessions(self):
        raw = pd.DataFrame({
            'Date': ['2024-01-02', '2024-01-01', '2024-01-06', '2024-01-03', '2024-01-03'],
            'Open': [1, 1, 1, 1, 2], 'High': [1, 1, 1, 1, 2], 'Low': [1, 1, 1, 1, 2],
            'Close': [1, 1, 1, 1, 2], 'Volume': [1, 1, 1, 1, 2],
        })
        frame = gen.session_frame(raw)
        self.assertEqual([d.isoformat() for d in frame['Date'].dt.date], ['2024-01-02', '2024-01-03'])
        self.assertEqual(frame['Close'].iloc[-1], 2)

    def test_rs_ratings_rank_returns_relative_to_spy(self):
        dates = pd.bdate_range('2023-01-02', periods=300)
        spy = pd.DataFrame({'Date': dates, 'Close': np.linspace(100.0, 130.0, 300)})
        histories = {
            'FAST': pd.DataFrame({'Date': dates, 'Close': np.linspace(100.0, 200.0, 300)}),
            'SLOW': pd.DataFrame({'Date': dates, 'Close': np.linspace(100.0, 110.0, 300)}),
            'SHORT': pd.DataFrame({'Date': dates[-100:], 'Close': np.linspace(100.0, 300.0, 100)}),
        }
        aligned = {symbol: gen.align_with_spy(history, spy) for symbol, history in histories.items()}
        ratings = gen.rs_ratings_vs_spy(aligned, dates[-1].date())
        self.assertEqual(ratings, {'FAST': 99, 'SLOW': 1})
        # No SPY bar on the session: no ratings rather than ratings against a stale benchmark.
        stale = {symbol: gen.align_with_spy(history, spy.iloc[:-1]) for symbol, history in histories.items()}
        self.assertEqual(gen.rs_ratings_vs_spy(stale, dates[-1].date()), {})

    def test_precomputed_join_matches_live_relative_strength_on_every_session(self):
        from build_rs_ratings import relative_strength_scores
        dates = pd.bdate_range('2023-01-02', periods=320)
        rng = np.random.default_rng(7)
        spy = pd.DataFrame({'Date': dates, 'Close': 100 * np.cumprod(1 + rng.normal(0, 0.01, 320))})
        # A stock with a missing day, so the join and the session positions differ.
        stock = pd.DataFrame({'Date': dates, 'Close': 50 * np.cumprod(1 + rng.normal(0, 0.02, 320))}).drop(index=290)
        aligned = gen.align_with_spy(stock, spy)
        for day in dates[250:]:
            session = day.date()
            expected = relative_strength_scores(stock[stock['Date'] <= day], spy[spy['Date'] <= day], session)
            if session not in set(stock['Date'].dt.date):
                expected = None
            actual = gen.relative_scores_at(aligned, session)
            if expected is None:
                self.assertIsNone(actual, session)
            else:
                self.assertEqual(set(actual), set(expected))
                for key in expected:
                    self.assertAlmostEqual(actual[key], expected[key], places=12)

    def test_earnings_age_counts_nyse_sessions(self):
        # Friday 2024-11-22 filing: Monday is 1 session later; Thanksgiving 2024-11-28 is not a session.
        self.assertEqual(gen.earnings_age(['2024-11-22'], date(2024, 11, 25)), ('2024-11-22', 1))
        self.assertEqual(gen.earnings_age(['2024-11-22'], date(2024, 11, 29)), ('2024-11-22', 4))
        self.assertEqual(gen.earnings_age(['2024-11-22'], date(2024, 11, 22)), ('2024-11-22', 0))
        self.assertEqual(gen.earnings_age(['2024-12-05'], date(2024, 11, 29)), (None, None))

    def test_registered_session_dates(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest_path = Path(tmpdir) / 'us' / 'sessions.json'
            manifest_path.parent.mkdir(parents=True)
            self.assertEqual(gen.registered_session_dates(manifest_path), set())

            manifest_path.write_text(json.dumps({
                'version': 1,
                'market': 'us',
                'sessions': [
                    {'date': '2024-01-02', 'revision': 'rev1'},
                    {'date': '2024-01-03', 'revision': 'rev2'},
                ]
            }))
            dates = gen.registered_session_dates(manifest_path)
            self.assertEqual(dates, {'2024-01-02', '2024-01-03'})

    def test_malformed_manifest_raises_instead_of_reading_as_empty(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest_path = Path(tmpdir) / 'sessions.json'
            manifest_path.write_text('{"sessions": [')
            with self.assertRaises(ValueError):
                gen.registered_session_dates(manifest_path)
            manifest_path.write_text('{"version": 1}')
            with self.assertRaises(ValueError):
                gen.registered_session_dates(manifest_path)

    def test_write_atomically_replaces_whole_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / '2024-01-02.json.gz'
            gen.write_atomically(target, gzip.compress(b'{"a":1}'))
            self.assertEqual(json.loads(gzip.decompress(target.read_bytes())), {'a': 1})
            self.assertEqual([p.name for p in Path(tmpdir).iterdir()], [target.name])

    def test_metadata_from_dhan_list_then_finviz(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / 'us_ownership_universe.json').write_text(json.dumps({
                'AAPL': {'finviz_sector': 'Technology', 'finviz_industry': 'Consumer Electronics'},
                'XYZ': {'finviz_sector': 'Financial', 'finviz_industry': 'Banks - Regional'},
            }))
            rows = [{'Sym': 'AAPL', 'DispSym': 'Apple Inc', 'Sector': 'Information Technology', 'SubSector': 'Hardware'}]
            meta = gen.load_stock_metadata(root, fetch_universe=lambda kind: rows)
            self.assertEqual(meta['AAPL'], {'name': 'Apple Inc', 'sector': 'Information Technology', 'industry': 'Hardware'})
            self.assertEqual(meta['XYZ'], {'name': None, 'sector': 'Financial', 'industry': 'Banks - Regional'})

    def test_only_reported_earnings_dates_are_used(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / 'quarterly_financial_history.json.gz').write_bytes(gzip.compress(json.dumps({'records': [
                {'symbol': 'AAPL', 'filing_date': '2024-02-14', 'filing_date_basis': 'estimated', 'sales': 1},
                {'symbol': 'AAPL', 'filing_date': '2024-05-02', 'filing_date_basis': 'reported', 'sales': 2},
            ]}).encode()))
            self.assertEqual(gen.load_reported_earnings(root), {'AAPL': ['2024-05-02']})

    def test_row_leaves_non_point_in_time_fields_unavailable(self):
        closes = np.linspace(50.0, 160.0, 260)
        frame = frame_of(closes)
        tech = gen.calculate_technicals_us(frame.Open.values, closes, frame.High.values, frame.Low.values, frame.Volume.values)
        row = gen.build_stock_row('AAPL', tech, {'name': 'Apple Inc'}, '2024-01-02', '2026-11-13', None, None)
        for key in ('quarterlySales', 'quarterlyEps', 'marketCapCrore', 'shortFloatPct', 'institutionalOwnPct'):
            self.assertIsNone(row[key], key)
        self.assertEqual(row['asOfDate'], '2024-01-02')
        self.assertEqual(row['metadataAsOfDate'], '2026-11-13')


if __name__ == '__main__':
    unittest.main()
