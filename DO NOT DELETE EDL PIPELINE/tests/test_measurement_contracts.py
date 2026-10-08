import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import unittest
import numpy as np
import pandas as pd
from edl_pipeline.scanner.bases import BaseConfig, detect_bases, measure_base
from edl_pipeline.scanner.base_publication import trend_context
from edl_pipeline.scanner.indicators import true_range, wilder_average


def candles(closes):
    closes = np.asarray(closes, dtype=float)
    return pd.DataFrame({'Date': pd.bdate_range('2025-01-01', periods=len(closes)),
                         'Open': closes, 'High': closes + 1, 'Low': closes - 1,
                         'Close': closes, 'Volume': 1000.})


class MeasurementContractsTests(unittest.TestCase):
    def test_wilder_and_simple_atr_and_adr_denominators_are_distinct(self):
        frame = candles([200] * 270)
        frame.loc[250, 'High'] = 140
        frame.loc[250, 'Low'] = 80
        facts = trend_context(frame, 269)
        tr = true_range(frame)
        self.assertAlmostEqual(facts['atrWilder14Pct'], wilder_average(tr, 14).iloc[-1] / 200 * 100)
        self.assertAlmostEqual(facts['atrSimple14Pct'], tr.tail(14).mean() / 200 * 100)
        self.assertNotEqual(facts['atrWilder14Pct'], facts['atrSimple14Pct'])
        self.assertAlmostEqual(facts['adrClose14Pct'], 1)
        self.assertAlmostEqual(facts['adrLow14Pct'], 2 / 199 * 100)
        measured = measure_base(frame, 240, 269, wilder_average(tr, 14) / frame.Close * 100)
        part = measured['parts']['full']
        self.assertEqual(part['atrPct'], part['atrWilderPct'])
        self.assertNotEqual(part['atrWilderPct'], part['atrSimplePct'])

    def test_closing_and_intraday_52week_context_are_not_interchangeable(self):
        frame = candles([100] * 252)
        frame.loc[100, 'High'] = 150
        frame.loc[100, 'Low'] = 50
        facts = trend_context(frame, 251)
        self.assertEqual((facts['closing52wHigh'], facts['closing52wLow']), (100, 100))
        self.assertEqual((facts['intraday52wHigh'], facts['intraday52wLow']), (150, 50))
        self.assertAlmostEqual(facts['distanceIntraday52wHigh'], 100 / 3)
        self.assertEqual(facts['aboveIntraday52wLow'], 100)
        self.assertIsNone(trend_context(frame.iloc[:-1], 250)['intraday52wHigh'])

    def test_close_classified_volume_uses_complete_prebreakout_window(self):
        frame = candles([120] * 232 + [100] * 20 + [130])
        frame.loc[:231, 'Volume'] = 2000
        atr = wilder_average(true_range(frame), 14) / frame.Close * 100
        measured = measure_base(frame, 232, 251, atr)
        expected = 100 * (232 * 2000) / (232 * 2000 + 20 * 1000)
        self.assertAlmostEqual(measured['overheadCloseVolume252Pct'], expected)
        self.assertIsNone(measure_base(frame, 232, 250, atr)['overheadCloseVolume252Pct'])
        frame['Volume'] = 0
        self.assertIsNone(measure_base(frame, 232, 251, atr)['overheadCloseVolume252Pct'])

    def test_failure_exit_signal_and_execution_have_separate_lifecycles(self):
        frame = candles([100] + [94] * 19 + [102, 99, 90, 92])
        config = BaseConfig(trail_period=200)
        failed = next(e for e in detect_bases(frame.iloc[:22], 'A', config) if e['breakout'])
        self.assertTrue(failed['breakoutFailed'])
        self.assertFalse(failed['exitSignaled'])
        self.assertFalse(failed['tradeClosed'])
        pending = next(e for e in detect_bases(frame.iloc[:23], 'A', config) if e['id'] == failed['id'])
        self.assertTrue(pending['exitSignaled'])
        self.assertFalse(pending['tradeClosed'])
        self.assertEqual(pending['trade']['status'], 'EXIT_PENDING')
        closed = next(e for e in detect_bases(frame, 'A', config) if e['id'] == failed['id'])
        self.assertTrue(closed['tradeClosed'])
        self.assertEqual(closed['trade']['exitPrice'], 92)
        self.assertEqual(closed['base'], failed['base'])
        self.assertEqual(closed['base']['overheadPct'], closed['base']['overheadPriceDistancePct'])
