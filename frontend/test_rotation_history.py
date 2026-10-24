from datetime import date, timedelta
import gzip
import json
import math
from pathlib import Path
import tempfile
import unittest

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
        self.assertEqual(ledger['records']['S0'], [[days[-1], ['Banks', 'Private Banks', None, 'Lending', 'Finance', None]]])
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


if __name__ == '__main__':
    unittest.main()
