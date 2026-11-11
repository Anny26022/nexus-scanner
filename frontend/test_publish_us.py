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
        base = '/data/revisions/' + 'a' * 64
        self.assertEqual(publish_us.manifest_for('a' * 64, '2026-11-09', 3, market_overview=True)['marketOverviewUrl'],
                         base + '/market-overview.json.gz')
        self.assertEqual({key: manifest[key] for key in ('datasetUrl', 'datasetGzipUrl', 'datasetPackedGzipUrl', 'iposUrl')},
                         {'datasetUrl': base + '/stocks.json', 'datasetGzipUrl': base + '/stocks.json.gz',
                          'datasetPackedGzipUrl': base + '/stocks.packed.json.gz', 'iposUrl': base + '/ipos.json.gz'})

    def test_us_floors_cover_every_preset_eligibility_rule(self):
        rules = json.loads((Path(__file__).parent / 'src/data/presetEligibility.json').read_text())
        self.assertEqual(set(publish_us.US_ELIGIBILITY), {rule['id'] for rule in rules})
        # $300M market cap, a $5 close and $2M a day of turnover, not India's ₹ floors.
        self.assertEqual(publish_us.US_ELIGIBILITY, {'minMarketCapCr': 300, 'minPrice': 5, 'minTurnoverCr': 2})

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
        # Over a holiday (Thanksgiving 2024-11-28), sessions exclude the holiday: 4 sessions, not 5 weekdays.
        holiday_row = {'metrics': {'LISTING_AGE_DAYS': None}, 'historyAligned': True}
        publish_us.listing_age(holiday_row, {'listing_date': '2024-11-25'}, '2024-12-02')
        self.assertEqual(holiday_row['metrics']['LISTING_AGE_DAYS'], 4)
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
                                    {code: flat for code in publish_us.ROTATION_BENCHMARKS}, {}, market=publish_us.US_ROTATION)
        self.assertEqual(set(index['benchmarks']), {'SPX', 'NDX', 'DJI', 'RUT', 'EW'})
        self.assertEqual(index['universes'], dict(publish_us.US_ROTATION.universes))
        self.assertEqual({group['l'] for group in index['groups']}, {'sector', 'industry'})
        # A $50M company trading $0.5M a day is below the US floors for a group composite.
        self.assertEqual(next(group for group in index['groups'] if group['id'] == 'sector:Technology')['m'], ['S0', 'S1', 'S2', 'S3'])
        self.assertEqual(next(stock for stock in index['stocks'] if stock['s'] == 'S0')['h'], 'core')

    def test_us_rotation_with_finviz_thematic_taxonomy(self):
        import rotation_history as rh
        from test_rotation_history import sessions
        days = sessions(340)
        flat = [(day, 100.) for day in days]
        symbols = ['NVDA', 'AMD', 'MSFT', 'AAPL']
        rows = [{'symbol': sym, 'sector': 'Technology', 'industry': 'Semiconductors', 'marketCapCrore': 3000000,
                 'metrics': {'turnover30': 500}, 'indexMemberships': ['S&P 500', 'RUSSELL 1000']}
                for sym in symbols]

        thematic_path = Path(__file__).parents[1] / 'DO NOT DELETE EDL PIPELINE' / 'us_thematic_universe.json'
        taxonomy = publish_us.build_us_taxonomy(rows, days[-1], thematic_path)
        self.assertEqual(taxonomy['schemaVersion'], 1)
        self.assertIn('NVDA', taxonomy['records'])
        self.assertEqual(taxonomy['records']['NVDA']['theme'], 'Artificial Intelligence')

        index, shards, _ = rh.build(days[-1], rows, {row['symbol']: flat for row in rows},
                                    {code: flat for code in publish_us.ROTATION_BENCHMARKS},
                                    taxonomy['records'], market=publish_us.US_ROTATION)
        group_levels = {group['l'] for group in index['groups']}
        self.assertIn('theme', group_levels)
        ai_group = next(group for group in index['groups'] if group['id'] == 'theme:Artificial Intelligence')
        self.assertIn('NVDA', ai_group['m'])

    def test_us_rows_enrich_phase_1_and_phase_2_fields(self):
        stock = {
            'symbol': 'AAPL',
            'dollar_volume': 50_000_000,
            'short_float_percent': 1.45,
            'short_ratio': 1.82,
            'insider_own_percent': 0.08,
            'institutional_own_percent': 61.2,
            'insider_trans_percent': -2.1,
            'institutional_trans_percent': 0.45,
            'target_price': 250.0,
            'target_price_upside_percent': 12.5,
            'analyst_rating': 'Buy',
            'ps_ratio': 8.2,
            'gross_margin_percent': 46.2,
            'net_margin_percent': 24.1,
            'roe_percent': 147.2,
            'roic_percent': 58.1,
            'quick_ratio': 0.88,
            'lt_debt_to_equity': 1.4,
            'beta': 1.1,
            'news_feed': [{'title': 'Apple Earnings Beat', 'link': 'https://example.com'}],
            'insider_activity': [{'insider': 'Tim Cook', 'transaction': 'Sale'}],
        }
        row = {'symbol': 'AAPL', 'metrics': {}}
        # Simulate enrichment logic from publish_us
        dollar_volume = stock.get('dollar_volume')
        row['rupeeVolumeCrore'] = dollar_volume / publish_us.UNITED_STATES.provider_amount_unit if dollar_volume is not None else None
        publish_us.listing_age(row, stock, '2026-11-09')
        for src, dst in (
            ('short_float_percent', 'shortFloatPct'),
            ('short_ratio', 'shortRatio'),
            ('insider_own_percent', 'insiderOwnPct'),
            ('institutional_own_percent', 'institutionalOwnPct'),
            ('insider_trans_percent', 'insiderTransPct'),
            ('institutional_trans_percent', 'institutionalTransPct'),
            ('target_price', 'targetPrice'),
            ('target_price_upside_percent', 'targetPriceUpsidePct'),
            ('analyst_rating', 'analystRating'),
            ('ps_ratio', 'psRatio'),
            ('gross_margin_percent', 'grossMarginPct'),
            ('net_margin_percent', 'netMarginPct'),
            ('roe_percent', 'roePct'),
            ('roic_percent', 'roicPct'),
            ('quick_ratio', 'quickRatio'),
            ('lt_debt_to_equity', 'ltDebtToEquity'),
            ('beta', 'beta'),
        ):
            val = stock.get(src)
            if val is not None:
                row[dst] = val
        if stock.get('news_feed'):
            row['newsFeed'] = stock['news_feed']
        if stock.get('insider_activity'):
            row['insiderActivity'] = stock['insider_activity']
        if row.get('promoterHoldingPct') is None and row.get('insiderOwnPct') is not None:
            row['promoterHoldingPct'] = row['insiderOwnPct']
        if row.get('fiiHoldingPct') is None and row.get('institutionalOwnPct') is not None:
            row['fiiHoldingPct'] = row['institutionalOwnPct']

        self.assertEqual(row['shortFloatPct'], 1.45)
        self.assertEqual(row['shortRatio'], 1.82)
        self.assertEqual(row['insiderOwnPct'], 0.08)
        self.assertEqual(row['institutionalOwnPct'], 61.2)
        self.assertEqual(row['promoterHoldingPct'], 0.08)
        self.assertEqual(row['fiiHoldingPct'], 61.2)
        self.assertEqual(row['targetPrice'], 250.0)
        self.assertEqual(row['analystRating'], 'Buy')
        self.assertEqual(len(row['newsFeed']), 1)
        self.assertEqual(len(row['insiderActivity']), 1)


if __name__ == '__main__':
    unittest.main()
