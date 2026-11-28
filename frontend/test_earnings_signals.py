import gzip
import json
import unittest
from datetime import date

import pandas as pd

from earnings_signals import earnings_signals, next_results, pulse_dates, quarter_facts, reaction

ENDS = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30']


def quarters(sales, profit, eps, tax=None):
    return [{'period_end': end, 'sales': s, 'net_profit': p, 'eps': e, 'tax_expenses': (tax or {}).get(end, 10.0)}
            for end, s, p, e in zip(ENDS, sales, profit, eps)]


def bars(rows):
    """[(date, open, high, low, close, volume)] as the publisher's frame."""
    frame = pd.DataFrame(rows, columns=['Date', 'Open', 'High', 'Low', 'Close', 'Volume'])
    frame['Date'] = pd.to_datetime(frame['Date'])
    return frame


class QuarterFactsTests(unittest.TestCase):
    def test_growth_is_year_on_year_with_margin_and_year_ago_eps(self):
        facts = quarter_facts({'quarterly': quarters([100, 100, 100, 100, 112, 118, 127], [10, 10, 10, 10, 12, 13.4, 15.8],
                                                     [1, 1, 1, 1, 1.2, 1.34, 1.58])}, date(2026, 11, 27))
        latest = facts['q'][-1]
        self.assertEqual((latest['end'], latest['sales'], latest['eps'], latest['pat'], latest['npm'], latest['eps0']),
                         ('2026-09-30', 27.0, 58.0, 58.0, 12.4, 1.0))
        self.assertEqual([q['sales'] for q in facts['q']], [12.0, 18.0, 27.0])
        self.assertEqual((facts['behind'], facts['taxCredit'], facts['basis']), (0, False, 'CONSOLIDATED'))

    def test_a_share_count_change_takes_eps_growth_from_profit(self):
        # A 1:5 split: EPS falls fivefold while profit rises 50%.
        facts = quarter_facts({'quarterly': quarters([100] * 7, [10, 10, 10, 10, 10, 10, 15], [5, 5, 5, 5, 5, 5, 1.5])},
                              date(2026, 11, 27))
        self.assertEqual((facts['q'][-1]['eps'], facts['q'][-1]['epsBasis'], facts['q'][-1]['eps0']), (50.0, 'PAT', None))

    def test_a_tax_credit_quarter_is_flagged_and_growth_off_a_loss_is_unset(self):
        facts = quarter_facts({'quarterly': quarters([100] * 7, [-5, -5, -5, -5, 8, 9, 12], [-0.5] * 4 + [0.8, 0.9, 1.2],
                                                     tax={'2026-09-30': -3.0})}, date(2026, 11, 27))
        self.assertTrue(facts['taxCredit'])
        self.assertIsNone(facts['q'][-1]['pat'])
        self.assertEqual((facts['q'][-1]['np0'], facts['q'][-1]['np']), (-5, 12))

    def test_standalone_quarters_stand_in_for_missing_consolidated_ones(self):
        facts = quarter_facts({'quarterly': [], 'standalone_quarterly': quarters([100] * 7, [10] * 7, [1] * 7)}, date(2026, 11, 27))
        self.assertEqual(facts['basis'], 'STANDALONE')

    def test_quarters_behind_counts_results_that_should_be_out(self):
        facts = quarter_facts({'quarterly': quarters([100] * 6, [10] * 6, [1] * 6)}, date(2026, 11, 27))
        self.assertEqual(facts['q'][-1]['end'], '2026-06-30')
        self.assertEqual(facts['behind'], 1)
        self.assertIsNone(quarter_facts({'quarterly': quarters([100] * 4, [10] * 4, [1] * 4)}, date(2026, 11, 27)))


class ReactionTests(unittest.TestCase):
    def test_the_results_session_and_the_next_with_gap_move_range_and_fill(self):
        frame = bars([('2026-10-21', 100, 101, 99, 100, 1000)] * 1 + [(f'2026-10-{day}', 100, 101, 99, 100, 1000) for day in range(22, 31)]
                     + [('2026-11-02', 100, 101, 99, 100, 1000)] * 10 + [('2026-11-03', 106, 112, 105, 111, 5000),
                                                                         ('2026-11-04', 111, 113, 109, 112, 2000),
                                                                         ('2026-11-05', 110, 111, 104, 107, 1500)])
        first, second = reaction(frame, '2026-11-03')
        self.assertEqual((first['date'], first['age'], first['gap'], first['move'], first['pos'], first['vsOpen'], first['unfilled']),
                         ('2026-11-03', 2, 6.0, 11.0, 0.857, 4.72, 4.0))
        self.assertEqual(second['date'], '2026-11-04')
        self.assertIsNone(reaction(frame, '2026-12-01'))


class DatesTests(unittest.TestCase):
    def test_calendar_and_earnings_pulse_dates(self):
        calendar = gzip.compress(json.dumps({'events': [{'symbol': 'ABC', 'scheduled_date': '2026-11-30'},
                                                        {'symbol': 'ABC', 'scheduled_date': '2026-11-29'},
                                                        {'symbol': 'OLD', 'scheduled_date': '2026-11-01'}]}).encode())
        self.assertEqual(next_results(calendar, '2026-11-28'), {'ABC': '2026-11-29'})
        dates = pulse_dates({'reported': [{'symbol': 'ABC', 'filing_day': '2026-08-10'}, {'symbol': 'ABC', 'filing_day': '2026-11-10'}],
                             'upcoming': [{'symbol': 'XYZ', 'filing_day': '2026-11-28', 'timing': 'After'}]}, '2026-11-28')
        self.assertEqual(dates, {'ABC': {'declared': '2026-11-10'}, 'XYZ': {'next': '2026-11-28', 'nextTiming': 'After'}})

    def test_the_row_object_takes_the_later_results_date(self):
        frame = bars([(f'2026-11-{day:02d}', 100, 101, 99, 100, 1000) for day in range(2, 28)])
        signals = earnings_signals({'latest_earnings_date': '2026-08-10'}, frame, '2026-11-27', '2026-12-02',
                                   {'declared': '2026-11-20', 'next': '2026-12-02', 'nextTiming': 'Pre'})
        self.assertEqual((signals['declared'], signals['declaredAge'], signals['next'], signals['nextTiming']),
                         ('2026-11-20', 7, '2026-12-02', 'Pre'))
        self.assertIsNone(earnings_signals({}, frame, '2026-11-27'))

    def test_the_row_carries_quarters_and_reactions_as_positional_arrays(self):
        frame = bars([(f'2026-10-{day:02d}', 100, 101, 99, 100, 1000) for day in range(1, 31)] + [('2026-11-02', 106, 112, 105, 111, 5000)])
        history = {'quarterly': quarters([100, 100, 100, 100, 112, 118, 127], [10, 10, 10, 10, 12, 13.4, 15.8], [1, 1, 1, 1, 1.2, 1.34, 1.58])}
        signals = earnings_signals({'financial_statement_history': history, 'latest_earnings_date': '2026-11-02'}, frame, '2026-11-02')
        self.assertEqual(signals['q'][-1], ['2026-09-30', 27.0, 58.0, 58.0, 12.4, 15.8, 10.0, 1.0, 1])
        self.assertEqual(signals['q'][0], ['2026-03-31', 12.0, 20.0, None, 10.7, 12.0, None, None, 1])
        self.assertEqual(signals['reaction'], [[0, 6.0, 11.0, 0.857, 4.72, 5.0]])


if __name__ == '__main__':
    unittest.main()
