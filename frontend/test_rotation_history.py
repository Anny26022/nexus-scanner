from datetime import date, timedelta
import gzip
import json
import math
from pathlib import Path
import tempfile
import unittest
from copy import deepcopy
import weakref

import rotation_history as rh


def sessions(count, start=date(2020, 1, 1)):
    days, day = [], start
    while len(days) < count:
        if day.weekday() < 5:
            days.append(day.isoformat())
        day += timedelta(days=1)
    return days


def decode(coded):
    offset, values, level = coded[0], [], 0
    for index, delta in enumerate(coded[1:]):
        level = delta if index == 0 else level + delta
        values.append(math.exp(level / rh.SCALE))
    return offset, values


class RotationHistoryTests(unittest.TestCase):
    def test_symbol_loader_does_not_retain_raw_histories(self):
        class Prices(list):
            pass
        days = sessions(340)
        benchmark = [(day, 100.) for day in days]
        rows = [{'symbol': f'S{i}', 'sector': 'Banks', 'marketCapCrore': 1000,
                 'metrics': {'turnover30': 5}} for i in range(20)]
        references = []

        def load(symbol):
            self.assertLessEqual(sum(ref() is not None for ref in references), 1)
            values = Prices((day, 100.) for day in days)
            references.append(weakref.ref(values))
            return values

        index, _, _ = rh.build(days[-1], rows, load, {'N50': benchmark}, {})
        self.assertEqual(len(index['stocks']), len(rows))
        self.assertFalse(any(ref() is not None for ref in references))

    def test_calendars_close_each_week_and_month_on_its_last_session(self):
        frames = rh.calendars(['2026-09-28', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05'])
        self.assertEqual(frames['W'], ['2026-10-02', '2026-10-05'])
        self.assertEqual(frames['M'], ['2026-09-30', '2026-10-05'])

    def test_encoding_round_trips_and_carries_gaps_forward(self):
        values = rh.aligned([('2026-01-02', 100.0), ('2026-01-06', 110.0)], ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06'])
        self.assertEqual(values, [None, 100.0, 100.0, 110.0])
        offset, decoded = decode(rh.encode(values))
        self.assertEqual(offset, 1)
        for got, want in zip(decoded, [100.0, 100.0, 110.0]):
            self.assertAlmostEqual(got, want, delta=want * 1e-4)
        self.assertIsNone(rh.encode([None, None]))

    def test_composite_waits_for_members_and_averages_returns(self):
        full = [(0, 3)]
        members = [([100.0, 110.0, 110.0], full), ([50.0, 50.0, 55.0], full), ([None, 10.0, 10.0], full)]
        levels = rh.composite(members, 3)
        self.assertEqual(levels[:2], [None, None])  # Two members have a return on day two; three are needed.
        self.assertAlmostEqual(levels[2], 100.0)

    def test_members_count_only_on_days_they_belonged(self):
        days = ['d0', 'd1', 'd2', 'd3']
        rising, flat = [100.0, 110.0, 121.0, 133.1], [100.0, 100.0, 100.0, 100.0]
        # The riser joins on d2, so the d1 return is the average of the three flat members only.
        members = [(flat, [(0, 4)]), (flat, [(0, 4)]), (flat, [(0, 4)]), (rising, [(2, 4)])]
        levels = rh.composite(members, len(days))
        self.assertAlmostEqual(levels[1], 100.0)
        self.assertAlmostEqual(levels[2], 100.0 * (1 + 0.1 / 4))

    def test_coverage_gaps_are_not_flat_returns_or_single_stock_indices(self):
        full = [(0, 6)]
        levels = rh.composite([
            ([100., 100., 110., 121., 133.1, 146.41], full),
            ([100.] * 6, [(0, 2), (4, 6)]), ([100.] * 6, [(0, 2), (4, 6)]),
        ], 6)
        self.assertEqual(levels[:5], [None, 100., None, None, 100.])
        self.assertAlmostEqual(levels[5], 100 * (1 + .1 / 3))
        coded = rh.encode(levels)
        self.assertEqual(coded[2:4], [None, None])
        self.assertEqual(rh.aligned([('a', 100.), ('b', None), ('c', 110.)], ['a', 'b', 'c']), [100., None, 110.])

    def test_liquidity_changes_and_removals_preserve_prior_group_and_benchmark(self):
        days = sessions(360)
        flat = [(day, 100.) for day in days]
        rows = [{'symbol': symbol, 'sector': 'Banks', 'marketCapCrore': 1000,
                 'metrics': {'turnover30': 5}} for symbol in ('A', 'B', 'C', 'D')]
        prices = {row['symbol']: flat for row in rows}
        prices['D'] = [(day, 100 * 1.002 ** i) for i, day in enumerate(days)]
        first, shards, ledger = rh.build(days[-2], rows, prices.get, {'N50': flat}, {})
        for removed in (False, True):
            changed = deepcopy(rows)
            if removed:
                changed.pop()
            else:
                changed[-1]['metrics']['turnover30'] = .5
            second, newer, _ = rh.build(days[-1], changed, prices.get, {'N50': flat}, {}, deepcopy(ledger))
            for old, new in [(shards['groups']['D']['sector:Banks'], newer['groups']['D']['sector:Banks']),
                             (first['benchmarks']['EW']['series']['D'], second['benchmarks']['EW']['series']['D'])]:
                a, b = decode(old)[1], decode(new)[1]
                self.assertAlmostEqual(a[-1], b[-2], places=7)
            self.assertEqual(next(group for group in second['groups'] if group['id'] == 'sector:Banks')['m'], ['A', 'B', 'C'])

    def test_ledger_records_only_changes_and_maps_dates_to_spans(self):
        ledger = rh.record_memberships(None, '2026-10-01', {'A': ['Banks', None, None, 'Lending', None, None]})
        ledger = rh.record_memberships(ledger, '2026-10-02', {'A': ['Banks', None, None, 'Lending', None, None]})
        self.assertEqual(len(ledger['records']['A']), 1)
        ledger = rh.record_memberships(ledger, '2026-10-05', {'A': ['Banks', None, None, 'Fintech', None, None]})
        self.assertEqual([entry[0] for entry in ledger['records']['A']], ['2026-10-01', '2026-10-05'])
        days = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']
        # Before the ledger began, the earliest known label applies.
        self.assertEqual(rh.spans(ledger['records']['A'], days, 3), {'Lending': [(0, 3)], 'Fintech': [(3, 5)]})
        with self.assertRaises(ValueError):
            rh.record_memberships(ledger, '2026-10-01', {'A': ['X', None, None, None, None, None]})

    def test_ledger_without_narratives_keeps_its_history_and_backfills_today(self):
        old = {'version': 1, 'levels': list(rh.LEVELS[:-1]),
               'records': {'A': [['2026-10-01', ['Banks', None, None, None, None, None]]]}}
        ledger = rh.record_memberships(old, '2026-10-02', {'A': ['Banks', None, None, None, None, None, ['Grid']]})
        self.assertEqual(ledger['levels'], list(rh.LEVELS))
        self.assertEqual(ledger['records']['A'], [['2026-10-01', ['Banks', None, None, None, None, None, ['Grid']]]])

    def test_narratives_form_groups_and_load_from_the_shared_file(self):
        self.assertIn('India Data-Centre Buildout', rh.load_narratives()['ANANTRAJ'])
        days = sessions(rh.PERIODS['D'] + 40)
        rise = [(day, 100 * 1.001 ** i) for i, day in enumerate(days)]
        rows = [{'symbol': f'S{i}', 'sector': 'Banks', 'marketCapCrore': 5000, 'metrics': {'turnover30': 20}} for i in range(4)]
        index, _, _ = rh.build(days[-1], rows, {row['symbol']: rise for row in rows}, {'N50': rise}, {},
                               narratives={f'S{i}': ['Grid'] for i in range(4)})
        self.assertEqual(next(group for group in index['groups'] if group['id'] == 'narrative:Grid')['m'], ['S0', 'S1', 'S2', 'S3'])

    def test_build_shards_stocks_and_groups_and_writes_hashed_objects(self):
        days = sessions(rh.PERIODS['D'] + 40)
        rise = [(day, 100 * 1.001 ** i) for i, day in enumerate(days)]
        rows = [{'symbol': f'S{i}', 'name': f'Stock {i}', 'sector': 'Banks', 'industry': 'Private Banks',
                 'marketCapCrore': 5000, 'metrics': {'turnover30': 20},
                 'indexMemberships': ['NIFTY 500', 'Nifty 50'] if i < 2 else []} for i in range(4)]
        closes = {row['symbol']: rise for row in rows}
        taxonomy = {row['symbol']: {'theme': 'Lending', 'subIndustry': None, 'block': 'Finance', 'macro': None} for row in rows}
        index, shards, ledger = rh.build(days[-1], rows, closes, {'N50': rise, 'N500': rise}, taxonomy)
        self.assertEqual([stock['h'] for stock in index['stocks']], ['core', 'core', 'rest', 'rest'])
        self.assertEqual(index['stocks'][0]['u'], ['N50', 'N500'])
        self.assertEqual({group['id'] for group in index['groups']},
                         {'sector:Banks', 'industry:Private Banks', 'theme:Lending', 'block:Finance'})
        self.assertEqual(len(index['frames']['D']), rh.PERIODS['D'])
        self.assertIn('S0', shards['core']['W'])
        self.assertIn('theme:Lending', shards['groups']['M'])
        self.assertEqual(set(index['benchmarks']), {'N50', 'N500', 'EW'})
        self.assertEqual(ledger['records']['S0'], [[days[-1], ['Banks', 'Private Banks', None, ['Lending'], 'Finance', None, None]]])
        index, _, _ = rh.build(days[-1], rows, closes, {'N50': rise, 'N500': rise, 'MS400': []}, taxonomy)
        self.assertNotIn('MS400', index['benchmarks'])
        with tempfile.TemporaryDirectory() as folder:
            digest = rh.write_objects(Path(folder), index, shards)
            payload = json.loads(gzip.decompress((Path(folder) / f'{digest}.json.gz').read_bytes()))
            self.assertEqual(set(payload['shards']), {'core', 'rest', 'groups'})
            for name in payload['shards'].values():
                self.assertTrue((Path(folder) / f'{name}.json.gz').exists())

    def test_illiquid_stocks_and_tiny_groups_are_left_out_of_composites(self):
        days = sessions(rh.PERIODS['D'] + 40)
        series = [(day, 10.0) for day in days]
        rows = [{'symbol': f'S{i}', 'sector': 'Tiny' if i < 2 else 'Thin', 'marketCapCrore': 5000 if i < 2 else 50,
                 'metrics': {'turnover30': 20}} for i in range(5)]
        index, _, _ = rh.build(days[-1], rows, {row['symbol']: series for row in rows}, {'N50': series, 'N500': series}, {})
        self.assertEqual(index['groups'], [])

    def test_stale_prices_are_not_extended_and_stale_benchmarks_are_rejected(self):
        days = sessions(340)
        points = [(day, 100.) for day in days[:-1]]
        self.assertEqual(rh.aligned(points, days)[-2:], [100., None])
        with self.assertRaisesRegex(ValueError, 'Rotation benchmark ends'):
            rh.build(days[-1], [], {}, {'N50': points}, {})
        index, _, _ = rh.build(days[-1], [], {}, {'N50': points}, {}, price_date=days[-2])
        self.assertEqual(index['asOfDate'], days[-1])
        self.assertEqual(index['frames']['D'][-1], days[-2])

    def test_curated_and_primary_themes_count_each_member_once_and_preserve_history(self):
        days = sessions(360)
        rows = [{'symbol': s, 'marketCapCrore': 1000, 'metrics': {'turnover30': 5}} for s in 'ABCD']
        prices = {s: [(day, 100 * (1.01 if s == 'A' else 1) ** i) for i, day in enumerate(days)] for s in 'ABCD'}
        primary = {s: {'theme': 'IPO / Young Bases'} for s in 'ABCD'}
        duplicate = {s: {'theme': 'IPO / Young Bases',
                         'memberships': {'IPO / Young Bases': 'curated-rule'} if s == 'A' else {}} for s in 'ABCD'}
        benchmark = {'N50': [(day, 100.) for day in days]}
        _, plain, _ = rh.build(days[-2], rows, prices, benchmark, primary)
        _, curated, ledger = rh.build(days[-2], rows, prices, benchmark, duplicate)
        key = 'theme:IPO / Young Bases'
        self.assertEqual(plain['groups'], curated['groups'])
        # A ages out; the other stocks retain the cohort as a secondary membership.
        changed = {s: {'theme': 'Other', 'memberships': {} if s == 'A' else {'IPO / Young Bases': 'curated-rule'}} for s in 'ABCD'}
        index, later, ledger = rh.build(days[-1], rows, prices, benchmark, changed, ledger)
        self.assertEqual(next(g for g in index['groups'] if g['id'] == key)['m'], ['B', 'C', 'D'])
        self.assertEqual(decode(curated['groups']['D'][key])[1][-1], decode(later['groups']['D'][key])[1][-2])
        self.assertEqual(len(ledger['records']['A']), 2)
        # Legacy scalar theme records remain readable during migration.
        self.assertEqual(rh.spans([[days[-2], [None, None, None, 'Old', None, None]],
                                   [days[-1], [None, None, None, ['Old', 'New'], None, None]]], days[-2:], 3),
                         {'Old': [(0, 1), (1, 2)], 'New': [(1, 2)]})


if __name__ == '__main__':
    unittest.main()
