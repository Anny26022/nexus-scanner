import json
from pathlib import Path
import unittest

import publish_us
from publish_snapshot import tradingview_row
import site_data


class PublishUsTests(unittest.TestCase):
    def test_the_release_has_its_own_pointer_and_declares_its_units(self):
        self.assertEqual(publish_us.POINTER, 'us/current.json')
        self.assertIn(publish_us.POINTER, site_data.POINTERS)
        manifest = publish_us.manifest_for('a' * 64, '2026-11-09', 3)
        self.assertEqual((manifest['market'], manifest['currency'], manifest['amountUnit']), ('us', 'USD', 1_000_000))
        self.assertNotIn('marketOverviewUrl', manifest)
        self.assertTrue(publish_us.manifest_for('a' * 64, '2026-11-09', 3, market_overview=True)['marketOverviewUrl'].endswith('/market-overview.json.gz'))
        for key in ('datasetUrl', 'datasetPackedGzipUrl', 'iposUrl'):
            self.assertTrue(manifest[key].startswith('/data/revisions/' + 'a' * 64 + '/'), key)

    def test_us_floors_cover_every_preset_eligibility_rule(self):
        rules = json.loads((Path(__file__).parent / 'src/data/presetEligibility.json').read_text())
        self.assertEqual(set(publish_us.US_ELIGIBILITY), {rule['id'] for rule in rules})

    def test_us_rows_carry_the_us_scan_and_only_its_dollar_values(self):
        snapshot = {'source': publish_us.TRADINGVIEW_US, 'as_of_date': '2026-11-09', 'currency': 'USD', 'financial_currency': 'USD',
                    'market': {'performance_1m_pct': 4.2}, 'financials': {}, 'technicals': {}}
        stock = {'tradingview_snapshot': snapshot}
        us = (publish_us.TRADINGVIEW_US, 'USD')
        self.assertEqual(tradingview_row(stock, '2026-11-09', us)['values']['market.performance_1m_pct'], 4.2)
        # India's release never takes the US scan, and the US release refuses other currencies.
        self.assertIsNone(tradingview_row(stock, '2026-11-09'))
        rupees = {'tradingview_snapshot': {**snapshot, 'currency': 'INR'}}
        self.assertIsNone(tradingview_row(rupees, '2026-11-09', us)['values']['market.performance_1m_pct'])

    def test_listing_age_counts_nyse_sessions_when_the_history_is_shorter(self):
        row = {'metrics': {'LISTING_AGE_DAYS': None}, 'historyAligned': True}
        publish_us.listing_age(row, {'listing_date': '1980-12-12'}, '2026-11-09')
        self.assertGreater(row['metrics']['LISTING_AGE_DAYS'], 11_000)
        # The engine's own count (a listing inside the stored history) stands.
        recent = {'metrics': {'LISTING_AGE_DAYS': 791}, 'historyAligned': True}
        publish_us.listing_age(recent, {'listing_date': '2023-09-14'}, '2026-11-09')
        self.assertEqual(recent['metrics']['LISTING_AGE_DAYS'], 791)
        unknown = {'metrics': {'LISTING_AGE_DAYS': None}, 'historyAligned': True}
        publish_us.listing_age(unknown, {}, '2026-11-09')
        self.assertIsNone(unknown['metrics']['LISTING_AGE_DAYS'])

    def test_us_rotation_uses_its_benchmarks_universes_and_floors(self):
        import rotation_history as rh
        from test_rotation_history import sessions
        days = sessions(340)
        flat = [(day, 100.) for day in days]
        rows = [{'symbol': f'S{i}', 'sector': 'Technology', 'industry': 'Software', 'marketCapCrore': 500,
                 'metrics': {'turnover30': 5}, 'indexMemberships': ['S&P 500', 'RUSSELL 1000']} for i in range(4)]
        rows.append({'symbol': 'TINY', 'sector': 'Technology', 'industry': 'Software', 'marketCapCrore': 50,
                     'metrics': {'turnover30': 0.5}, 'indexMemberships': []})
        index, shards, _ = rh.build(days[-1], rows, {row['symbol']: flat for row in rows},
                                    {'SPX': flat, 'NDX': flat}, {}, market=publish_us.US_ROTATION)
        self.assertEqual(set(index['benchmarks']), {'SPX', 'NDX', 'EW'})
        self.assertEqual(index['universes']['SPX'], 'S&P 500')
        self.assertEqual({group['l'] for group in index['groups']}, {'sector', 'industry'})
        # A $50M company trading $0.5M a day is below the US floors for a group composite.
        self.assertEqual(next(group for group in index['groups'] if group['id'] == 'sector:Technology')['m'], ['S0', 'S1', 'S2', 'S3'])
        self.assertEqual(next(stock for stock in index['stocks'] if stock['s'] == 'S0')['h'], 'core')


if __name__ == '__main__':
    unittest.main()
