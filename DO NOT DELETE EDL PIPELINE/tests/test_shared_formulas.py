"""The shared indicator and 52-week helpers, and the modules that now call them."""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from advanced_metrics_processor import process_symbol_csv
from edl_pipeline.breadth import indicators as breadth_indicators
from edl_pipeline.breadth.config import load_methodology
from edl_pipeline.scanner import patterns, trend
from edl_pipeline.scanner.indicators import atr, ema, indicator_series, prior_extremes, rsi, sma
from edl_pipeline.transforms.historical_breadth import prepare_stock_history


def history(count, seed=7):
    """A noisy daily history."""
    rng = np.random.default_rng(seed)
    close = 100 + np.cumsum(rng.normal(0, 1.5, count))
    return pd.DataFrame({
        "Date": pd.bdate_range("2024-01-01", periods=count).strftime("%Y-%m-%d"),
        "Open": close + rng.normal(0, 0.5, count),
        "High": close + rng.uniform(0.5, 2.0, count),
        "Low": close - rng.uniform(0.5, 2.0, count),
        "Close": close,
        "Volume": rng.integers(1_000, 5_000, count).astype(float),
    })


class PriorExtremesTests(unittest.TestCase):
    def frame(self, highs, lows):
        return pd.DataFrame({"High": highs, "Low": lows})

    def test_excludes_the_bar_itself(self):
        prior_high, prior_low, new_high, new_low = prior_extremes(self.frame([5, 6, 7, 8], [5, 4, 3, 2]), 2)
        self.assertTrue(np.isnan(prior_high.iloc[1]))
        self.assertEqual(prior_high.iloc[2], 6)  # bars 0 and 1, not bar 2
        self.assertEqual(prior_low.iloc[3], 3)
        self.assertEqual(new_high.tolist(), [False, False, True, True])
        self.assertEqual(new_low.tolist(), [False, False, True, True])

    def test_a_tie_with_the_prior_extreme_is_not_new(self):
        _, _, new_high, new_low = prior_extremes(self.frame([5, 7, 7], [5, 3, 3]), 2)
        self.assertFalse(new_high.iloc[2])
        self.assertFalse(new_low.iloc[2])

    def test_rejects_a_non_positive_window(self):
        with self.assertRaises(ValueError):
            prior_extremes(self.frame([1], [1]), 0)


class FiftyTwoWeekAgreementTests(unittest.TestCase):
    """Legacy breadth, v2 breadth and the stock artifact agree on 'new 52-week high/low'."""

    def test_all_three_outputs_use_the_prior_252_sessions(self):
        frame = history(300)
        prior_high = frame["High"].iloc[-253:-1].max()
        prior_low = frame["Low"].iloc[-253:-1].min()
        # Today ties the prior high (not new) and breaks below the prior low (new).
        frame.loc[frame.index[-1], ["High", "Low", "Close"]] = [prior_high, prior_low - 1, prior_low - 0.5]
        methodology = load_methodology(ROOT / "breadth_methodology.json")

        v2 = breadth_indicators.prepare_history(frame, methodology).iloc[-1]
        self.assertFalse(v2["New_Yearly_High"])
        self.assertTrue(v2["New_Yearly_Low"])

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ABC.csv"
            frame.to_csv(path, index=False)
            legacy = prepare_stock_history(path, frame["Date"].tolist()).iloc[-1]
            _, metrics = process_symbol_csv(path)
        self.assertFalse(legacy["New_52W_High"])
        self.assertTrue(legacy["New_52W_Low"])

        # Measured against the prior low, a close below it is a negative distance.
        expected = round((prior_low - 0.5 - prior_low) / prior_low * 100, 2)
        self.assertEqual(metrics["% from 52W Low"], expected)
        self.assertEqual(metrics["distance_from_52w_low_percent"], expected)
        self.assertLess(expected, 0)
        self.assertFalse(metrics["breakout_above_52w_high"])

    def test_the_52_week_low_needs_a_full_prior_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            for count, available in ((252, False), (253, True)):
                path = Path(tmp) / f"S{count}.csv"
                history(count).to_csv(path, index=False)
                _, metrics = process_symbol_csv(path)
                self.assertEqual(metrics["% from 52W Low"] is not None, available, count)
                self.assertEqual(metrics["breakout_above_52w_high"] is not None, available, count)


class SharedIndicatorTests(unittest.TestCase):
    """The former copies are the canonical scanner indicators, value for value."""

    def setUp(self):
        self.frame = history(260)

    def assert_same(self, left, right):
        pd.testing.assert_series_equal(left, right, check_names=False, rtol=0, atol=0)

    def test_moving_averages_keep_their_warm_up(self):
        close = self.frame["Close"]
        self.assert_same(sma(close, 20), close.rolling(20, min_periods=20).mean())
        self.assert_same(ema(close, 20), close.ewm(span=20, adjust=False, min_periods=20).mean())
        self.assertTrue(ema(close, 20).iloc[:19].isna().all())
        self.assert_same(indicator_series(self.frame, "EMA", 20), ema(close, 20))

    def test_breadth_rsi_is_the_scanner_rsi(self):
        self.assert_same(breadth_indicators._rsi(self.frame["Close"], 14), indicator_series(self.frame, "RSI", 14))

    def test_rsi_edge_cases(self):
        rising = pd.Series(np.arange(1.0, 31.0))
        flat = pd.Series(np.full(30, 5.0))
        self.assertEqual(rsi(rising, 14).iloc[-1], 100.0)
        self.assertEqual(rsi(flat, 14).iloc[-1], 50.0)
        self.assertTrue(rsi(rising, 14).iloc[:14].isna().all())

    def test_pattern_atr_is_the_scanner_atr(self):
        self.assert_same(patterns._atr(self.frame, 14), atr(self.frame, 14))
        self.assert_same(atr(self.frame, 14), indicator_series(self.frame, "ATR", 14))

    def test_trend_adx_is_the_scanner_adx(self):
        self.assert_same(trend._adx(self.frame, 14), indicator_series(self.frame, "ADX", 14))

    def test_adx_on_a_flat_history_is_unavailable_not_infinite(self):
        flat = pd.DataFrame({"High": [10.0] * 40, "Low": [10.0] * 40, "Close": [10.0] * 40})
        self.assertFalse(np.isinf(trend._adx(flat, 14)).any())
        self.assertTrue(trend._adx(flat, 14).isna().all())

    def test_wrappers_keep_their_period_errors(self):
        with self.assertRaisesRegex(ValueError, "ATR period"):
            patterns._atr(self.frame, 0)
        with self.assertRaisesRegex(ValueError, "ADX period"):
            trend._adx(self.frame, 0)


if __name__ == "__main__":
    unittest.main()
