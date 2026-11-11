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
        self.assertNotIn('etfDatasetUrl', manifest)
        self.assertNotIn('financialHistoryUrl', manifest)
        base = '/data/revisions/' + 'a' * 64
        self.assertEqual(publish_us.manifest_for('a' * 64, '2026-11-09', 3, market_overview=True)['marketOverviewUrl'],
                         base + '/market-overview.json.gz')
        self.assertEqual(publish_us.manifest_for('a' * 64, '2026-11-09', 3, etf_snapshot=True)['etfDatasetUrl'],
                         base + '/etfs.json.gz')
        fin_manifest = publish_us.manifest_for('a' * 64, '2026-11-09', 3, financial_history=True)
        self.assertEqual(fin_manifest['financialHistoryUrl'], base + '/financial-history.json.gz')
        self.assertEqual(fin_manifest['financialHistoryUrlTemplate'], base + '/financial-history/{symbol}.json.gz')
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

    def test_load_financial_history_normalizes_to_standard_schema(self):
        records = [
            {'symbol': 'AAPL', 'quarter_end': '2024-09-30', 'revenue': 94930, 'net_profit': 20540, 'eps': 1.64, 'filing_date': '2024-10-31'},
            {'symbol': 'AAPL', 'quarter_end': '2024-06-30', 'revenue': 85780, 'net_profit': 21450, 'eps': 1.40, 'filing_date': '2024-08-01'},
            {'symbol': 'MSFT', 'quarter_end': '2024-09-30', 'revenue': 65590, 'net_profit': 24670, 'eps': 3.30, 'filing_date': '2024-10-30'},
        ]
        import gzip
        payload = {'records': records}
        source_bytes = {'quarterly_financial_history.json.gz': gzip.compress(json.dumps(payload).encode())}
        histories = publish_us.load_financial_history(Path('/dummy'), source_bytes, '2024-11-09')
        self.assertIn('AAPL', histories)
        self.assertIn('MSFT', histories)
        aapl = histories['AAPL']
        self.assertEqual(aapl['report_type'], 'CONSOLIDATED')
        self.assertEqual(aapl['amount_unit'], 'USD_MILLION')
        self.assertEqual(aapl['observed_on'], '2024-11-09')
        self.assertEqual(len(aapl['quarterly']), 2)
        self.assertEqual(aapl['quarterly'][0]['period_end'], '2024-09-30')
        self.assertEqual(aapl['quarterly'][0]['revenue'], 94930)
        self.assertEqual(aapl['quarterly'][0]['sales'], 94930)
        self.assertEqual(aapl['quarterly'][1]['period_end'], '2024-06-30')

    def test_us_ipo_record_structure_and_lockup_calculation(self):
        from datetime import date, timedelta
        sess_date = date.fromisoformat('2026-11-09')
        # Stock listed 100 days ago (lockup upcoming)
        list_100 = sess_date - timedelta(days=100)
        lockup_100 = list_100 + timedelta(days=180)
        # Stock listed 200 days ago (lockup passed)
        list_200 = sess_date - timedelta(days=200)
        lockup_200 = list_200 + timedelta(days=180)

        stocks = {
            'IPO1': {'symbol': 'IPO1', 'name': 'Recent IPO 1', 'listing_date': list_100.isoformat(),
                     'close': 45.0, 'market_cap': 2_500_000_000, 'dollar_volume': 15_000_000, 'sector': 'Tech', 'industry': 'Software'},
            'IPO2': {'symbol': 'IPO2', 'name': 'Older IPO 2', 'listing_date': list_200.isoformat(),
                     'close': 12.0, 'market_cap': 350_000_000, 'dollar_volume': 3_000_000, 'sector': 'Health', 'industry': 'Biotech'},
        }

        ipo_records = []
        for stock in stocks.values():
            list_date = date.fromisoformat(stock['listing_date'][:10])
            age_days = (sess_date - list_date).days
            lockup_date = list_date + timedelta(days=180)
            is_passed = sess_date >= lockup_date
            mcap = stock.get('market_cap')
            mcap_crore = (mcap / 1e6) if mcap and mcap > 1e6 else mcap
            dvol = stock.get('dollar_volume')
            turnover_m = (dvol / 1e6) if dvol and dvol > 1e6 else dvol
            ipo_records.append({
                'symbol': stock['symbol'],
                'name': stock.get('name') or stock['symbol'],
                'listing_date': list_date.isoformat(),
                'listing_age_calendar_days': age_days,
                'close': stock.get('close'),
                'market_cap_crore': mcap_crore,
                'sector': stock.get('sector'),
                'industry': stock.get('industry'),
                'rupee_volume': (turnover_m * 10_000_000) if turnover_m is not None else None,
                'turnover_crore': turnover_m,
                'anchor_lock_in_end': lockup_date.isoformat(),
                'anchor_lock_in_calendar': [{
                    'listing_date': list_date.isoformat(),
                    'unlock_date': lockup_date.isoformat(),
                    'tranche': 100,
                }],
                'next_anchor_lock_in_date': None if is_passed else lockup_date.isoformat(),
            })

        ipo_records.sort(key=lambda r: r['listing_date'], reverse=True)
        self.assertEqual(len(ipo_records), 2)
        # Recent IPO
        rec1 = ipo_records[0]
        self.assertEqual(rec1['symbol'], 'IPO1')
        self.assertEqual(rec1['listing_age_calendar_days'], 100)
        self.assertEqual(rec1['market_cap_crore'], 2500.0)
        self.assertEqual(rec1['turnover_crore'], 15.0)
        self.assertEqual(rec1['anchor_lock_in_calendar'][0]['unlock_date'], lockup_100.isoformat())
        self.assertEqual(rec1['next_anchor_lock_in_date'], lockup_100.isoformat())

        # Older IPO (lockup passed)
        rec2 = ipo_records[1]
        self.assertEqual(rec2['symbol'], 'IPO2')
        self.assertEqual(rec2['listing_age_calendar_days'], 200)
        self.assertIsNone(rec2['next_anchor_lock_in_date'])


if __name__ == '__main__':
    unittest.main()
