import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import unittest
from edl_pipeline.scanner.base_execution import trade_facts


class ExecutionTests(unittest.TestCase):
    dates = ['2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']
    opens = [100, 105, 120, 90, 150]

    def episode(self, reason='STOP'):
        return {'breakout': {'date': self.dates[1], 'close': 110},
                'exit': {'date': self.dates[2], 'reason': reason}}

    def test_execution_prices_costs_and_frozen_return(self):
        for reason in ('STOP', 'MA_TRAIL'):
            early = trade_facts(self.dates[:4], self.opens[:4], self.episode(reason))
            late = trade_facts(self.dates, self.opens, self.episode(reason))
            self.assertEqual(early, late)
            self.assertEqual(late['entryPrice'], 120)
            self.assertEqual(late['exitPrice'], 90)
            self.assertEqual(late['exitSignalDate'], self.dates[2])
            self.assertEqual(late['executionDate'], self.dates[3])
            self.assertEqual(late['exitReason'], reason)
            self.assertEqual(late['realizedReturnPct'], -25)
            self.assertAlmostEqual(late['netRealizedReturnPct'], (90 * .998 / (120 * 1.002) - 1) * 100)

    def test_pending_and_untriggered_are_not_fabricated_fills(self):
        empty = trade_facts(self.dates, self.opens, {'breakout': None})
        entry = trade_facts(self.dates[:2], self.opens[:2], self.episode())
        exit = trade_facts(self.dates[:3], self.opens[:3], self.episode())
        open_trade = trade_facts(self.dates, self.opens, {'breakout': self.episode()['breakout']})
        self.assertEqual([x['status'] for x in (empty, entry, exit, open_trade)],
                         ['NOT_TRIGGERED', 'ENTRY_PENDING', 'EXIT_PENDING', 'OPEN'])
        for x in (empty, entry, exit, open_trade):
            self.assertIsNone(x['realizedReturnPct'])
            self.assertIsNone(x['netRealizedReturnPct'])
            self.assertIsNone(x['executionDate'])
        self.assertIsNone(entry['exitSignalDate'])

    def test_rejects_bad_execution_inputs(self):
        with self.assertRaises(ValueError):
            trade_facts(self.dates, self.opens, self.episode(), fee_bps=float('nan'))
        with self.assertRaises(ValueError):
            trade_facts(self.dates, [100, 105, 0, 90, 150], self.episode())
        with self.assertRaises(ValueError):
            trade_facts(self.dates, [100, 105, 120, -1, 150], self.episode())
        with self.assertRaises(ValueError):
            trade_facts(self.dates, self.opens, self.episode('BASE_LIMIT'))
