"""NAV history: storage, daily appends, gap refills from Dhan's chart, and the metrics computed from it."""
from datetime import date, timedelta
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import mutual_fund_history as h  # noqa: E402

D = lambda text: date.fromisoformat(text).toordinal()  # noqa: E731


def fund(nav, day, isin='INF000000001', code='7'):
    return {'isin': isin, 'dhanSchemeCode': code, 'nav': nav, 'navDate': day}


def daily(start, end, nav=lambda index: 10.0):
    days = list(range(D(start), D(end) + 1))
    return days, [nav(index) for index in range(len(days))]


class StorageTests(unittest.TestCase):
    def test_encode_and_decode_round_trip(self):
        days, navs = [D('2026-01-01'), D('2026-01-02'), D('2026-01-05')], [10.0, 10.5, 10.25]
        entry = h.encode('7', days, navs)
        self.assertEqual((entry['start'], entry['gaps']), ('2026-01-01', [0, 1, 3]))
        decoded = h.decode(entry)
        self.assertEqual((decoded[0].tolist(), decoded[1].tolist()), (days, navs))

    def test_clean_series_sorts_dedupes_and_drops_bad_points(self):
        days, navs = h.clean_series(['2026-01-02', '2026-01-01', '2026-01-02', 'x', '2026-01-03', '2026-01-04'],
                                    ['11', 10, 12, 1, 0, 'nan'])
        self.assertEqual((days, navs), ([D('2026-01-01'), D('2026-01-02')], [10.0, 12.0]))


class UpdateTests(unittest.TestCase):
    def test_new_fund_is_backfilled_and_todays_nav_wins_its_day(self):
        history, fetch = {}, Mock(return_value=daily('2026-01-01', '2026-01-10'))
        report = h.update_history(history, [fund(10.5, '2026-01-10')], fetch=fetch, workers=1, interval=0)
        self.assertEqual((report['refetched'], report['appended']), (1, 0))
        days, navs = h.decode(history['funds']['INF000000001'])
        self.assertEqual((int(days[-1]), navs[-1], len(days)), (D('2026-01-10'), 10.5, 10))
        fetch.assert_called_once_with('7')

    def test_appends_skips_repeats_and_refills_long_gaps(self):
        history = {'funds': {'INF000000001': h.encode('7', *daily('2026-01-01', '2026-01-09'))}}
        fetch = Mock(return_value=daily('2026-01-01', '2026-01-20'))
        self.assertEqual(h.update_history(history, [fund(10.1, '2026-01-12')], fetch=fetch, workers=1, interval=0)['appended'], 1)
        self.assertEqual(h.update_history(history, [fund(10.1, '2026-01-12')], fetch=fetch, workers=1, interval=0)['appended'], 0)
        report = h.update_history(history, [fund(10.2, '2026-01-20')], fetch=fetch, workers=1, interval=0)  # 8 days later
        self.assertEqual(report['refetched'], 1)
        self.assertEqual(len(h.decode(history['funds']['INF000000001'])[0]), 20)

    def test_rejects_an_impossible_jump_and_counts_chart_failures(self):
        history = {'funds': {'INF000000001': h.encode('7', *daily('2026-01-01', '2026-01-09'))}}
        failing = Mock(side_effect=OSError('down'))
        report = h.update_history(history, [fund(25.0, '2026-01-12'), fund(5.0, '2026-01-12', isin='INF000000002')], fetch=failing, workers=1, interval=0)
        self.assertEqual((report['rejectedMoves'], report['refetchFailed'], report['appended']), (1, 1, 0))
        self.assertEqual(h.last_date(history['funds']['INF000000001']), date(2026, 1, 9))


    def test_a_rate_limit_defers_the_rest_and_the_largest_funds_go_first(self):
        funds = [dict(fund(10.0, '2026-01-10', isin=f'INF00000000{index}', code=str(index)), aumCrore=index) for index in range(5)]
        calls = []

        def fetch(code):
            calls.append(code)
            if len(calls) == 2:
                raise h.Throttled('Dhan answered 403')
            return daily('2026-01-01', '2026-01-10')
        report = h.update_history({}, funds, fetch=fetch, workers=1, interval=0)
        self.assertEqual(calls, ['4', '3'])
        self.assertEqual((report['refetched'], report['refetchDeferred'], report['refetchFailed'], report['throttled']), (1, 4, 0, True))

    def test_a_rebased_chart_keeps_only_the_points_after_the_jump(self):
        days, navs = daily('2026-01-01', '2026-01-10', lambda index: 10.0 if index < 5 else 1000.0)
        report = h.update_history({}, [fund(1000.0, '2026-01-10')], fetch=Mock(return_value=(days, navs)), workers=1, interval=0)
        self.assertEqual(report['rebased'], 1)
        # A chart on another scale than today's NAV restarts at today's NAV.
        history = {}
        h.update_history(history, [fund(1.0, '2026-01-11')], fetch=Mock(return_value=daily('2026-01-01', '2026-01-10')), workers=1, interval=0)
        self.assertEqual(h.decode(history['funds']['INF000000001'])[1].tolist(), [1.0])

    def test_a_stored_history_with_a_rebase_heals_to_the_points_after_it(self):
        days, navs = daily('2026-01-01', '2026-01-10', lambda index: 10.0 if index < 5 else 1000.0)
        history = {'funds': {'INF000000001': h.encode('7', days, navs)}}
        report = h.update_history(history, [fund(1001.0, '2026-01-11')], fetch=Mock(), workers=1, interval=0)
        self.assertEqual((report['rebased'], report['appended']), (1, 1))
        self.assertEqual(h.decode(history['funds']['INF000000001'])[1].tolist(), [1000.0] * 5 + [1001.0])

    def test_a_fund_without_a_chart_is_not_a_failure(self):
        report = h.update_history({}, [fund(10.0, '2026-01-10'), dict(fund(10.0, '2026-01-10', isin='INF000000002'), dhanSchemeCode=None)],
                                  fetch=Mock(return_value=([], [])), workers=1, interval=0)
        self.assertEqual((report['noChart'], report['noSchemeCode'], report['refetchFailed']), (1, 1, 0))

    def test_refills_are_capped_per_run(self):
        funds = [fund(10.0, '2026-01-10', isin=f'INF00000000{index}', code=str(index)) for index in range(5)]
        report = h.update_history({}, funds, fetch=Mock(return_value=daily('2026-01-01', '2026-01-10')), workers=1, interval=0, limit=2)
        self.assertEqual((report['refetched'], report['refetchDeferred']), (2, 3))


class MetricTests(unittest.TestCase):
    def test_trailing_returns_use_the_same_calendar_day_and_clamp_month_ends(self):
        self.assertEqual(h.months_before(date(2026, 3, 31), 1), date(2026, 2, 28))
        self.assertEqual(h.months_before(date(2024, 2, 29), 12), date(2023, 2, 28))
        # 10% a year for three years, compounding daily.
        days = list(range(D('2023-01-01'), D('2026-01-01') + 1))
        growth = 1.1 ** (1 / 365.25)
        navs = [10 * growth ** index for index in range(len(days))]
        entry = h.encode('7', days, navs)
        metrics = h.fund_metrics(entry)
        self.assertAlmostEqual(metrics['returns']['3y'], 10.0, delta=0.05)
        self.assertAlmostEqual(metrics['returns']['1y'], 10.0, delta=0.05)
        self.assertIsNone(metrics['returns']['5y'])
        self.assertEqual((metrics['maxDrawdown'], metrics['currentDrawdown']), (0.0, 0.0))
        self.assertEqual(metrics['rolling1y5y']['positivePct'], 100.0)
        self.assertAlmostEqual(metrics['rolling3y']['avg'], 10.0, delta=0.05)

    def test_drawdown_volatility_and_ratios_on_a_falling_then_recovering_fund(self):
        days = list(range(D('2022-01-01'), D('2026-01-01') + 1))
        navs = [10 + 2 * math.sin(index / 60) + index * 0.005 for index in range(len(days))]
        metrics = h.fund_metrics(h.encode('7', days, navs))
        peaks = [max(navs[:index + 1]) for index in range(len(navs))]
        self.assertAlmostEqual(metrics['maxDrawdown'], round(min(n / p - 1 for n, p in zip(navs, peaks)) * 100, 4), places=3)
        self.assertGreater(metrics['volatility1y'], 0)
        self.assertIsNotNone(metrics['sharpe3y'])
        self.assertIsNotNone(metrics['sortino3y'])
        self.assertIsNone(metrics['volatility5y'])

    def test_a_short_history_has_no_long_metrics(self):
        metrics = h.fund_metrics(h.encode('7', *daily('2026-06-01', '2026-11-06', lambda index: 10 + index / 100)))
        self.assertIsNone(metrics['cagrSinceLaunch'])
        self.assertIsNone(metrics['returns']['1y'])
        self.assertIsNotNone(metrics['returns']['3m'])
        self.assertIsNone(metrics['rolling3y'])


if __name__ == '__main__':
    unittest.main()
