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
        stock.update(volatility_week_percent=2.1, volatility_month_percent=2.8, float_shares=15_100_000_000,
                     shares_outstanding=15_200_000_000, eps_forecast_next_quarter=1.6)
        row = publish_us.enrich_row({'symbol': 'AAPL', 'metrics': {}}, stock, '2026-11-09')
        self.assertEqual(row['rupeeVolumeCrore'], 50.0)
        self.assertEqual(row['shortFloatPct'], 1.45)
        self.assertEqual(row['shortRatio'], 1.82)
        self.assertEqual(row['insiderOwnPct'], 0.08)
        self.assertEqual(row['institutionalOwnPct'], 61.2)
        # US ownership is never relabelled as India's promoter or FII holding.
        self.assertNotIn('promoterHoldingPct', row)
        self.assertNotIn('fiiHoldingPct', row)
        self.assertEqual((row['volatilityWeekPct'], row['volatilityMonthPct']), (2.1, 2.8))
        self.assertEqual((row['floatShares'], row['sharesOutstanding']), (15_100_000_000, 15_200_000_000))
        self.assertEqual(row['epsForecastNextQuarter'], 1.6)
        self.assertEqual(row['targetPrice'], 250.0)
        self.assertEqual(row['analystRating'], 'Buy')
        self.assertEqual(len(row['newsFeed']), 1)
        self.assertEqual(len(row['insiderActivity']), 1)

    def test_an_older_session_never_replaces_the_live_us_release(self):
        publish_us.refuse_older_session(None, '2026-11-09')
        publish_us.refuse_older_session({'sessionDate': '2026-11-09'}, '2026-11-09')  # a same-session retry
        publish_us.refuse_older_session({'sessionDate': '2026-11-06'}, '2026-11-09')
        with self.assertRaisesRegex(RuntimeError, 'Refusing'):
            publish_us.refuse_older_session({'sessionDate': '2026-11-10'}, '2026-11-09')

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
        # Standard ascending order (oldest first, latest last)
        self.assertEqual(aapl['quarterly'][0]['period_end'], '2024-06-30')
        self.assertEqual(aapl['quarterly'][1]['period_end'], '2024-09-30')
        self.assertEqual(aapl['quarterly'][1]['revenue'], 94930)
        self.assertEqual(aapl['quarterly'][1]['sales'], 94930)

    def test_us_ipo_record_structure_and_lockup_calculation(self):
        from datetime import date, timedelta
        sess_date = date.fromisoformat('2026-11-09')
        # Stock listed 100 days ago (lockup upcoming)
        list_100 = sess_date - timedelta(days=100)
        lockup_100 = list_100 + timedelta(days=180)
        # Stock listed 200 days ago (lockup passed)
        list_200 = sess_date - timedelta(days=200)

        stocks = {
            'IPO1': {'symbol': 'IPO1', 'name': 'Recent IPO 1', 'listing_date': list_100.isoformat(),
                     'close': 45.0, 'market_cap': 2_500_000_000, 'dollar_volume': 15_000_000, 'sector': 'Tech', 'industry': 'Software'},
            'IPO2': {'symbol': 'IPO2', 'name': 'Older IPO 2', 'listing_date': list_200.isoformat(),
                     'close': 12.0, 'market_cap': 350_000_000, 'dollar_volume': 3_000_000, 'sector': 'Health', 'industry': 'Biotech'},
        }

        # Exercise the production builder directly
        ipo_payload = publish_us.build_us_ipos(stocks.values(), sess_date.isoformat())
        self.assertEqual(ipo_payload['schema_version'], 1)
        ipo_records = ipo_payload['records']
        self.assertEqual(len(ipo_records), 2)
        # Recent IPO
        rec1 = ipo_records[0]
        self.assertEqual(rec1['symbol'], 'IPO1')
        self.assertEqual(rec1['listing_age_calendar_days'], 100)
        self.assertEqual(rec1['market_cap_crore'], 2500.0)
        self.assertEqual(rec1['turnover_crore'], 15.0)
        # The keys and units the IPO adapter reads: turnoverCrore = rupee_volume / 1e7, in $M here.
        self.assertEqual(rec1['rupee_volume'] / 10_000_000, 15.0)
        self.assertEqual(rec1['anchor_lock_in_calendar'], [{'listing_date': list_100.isoformat(),
                                                            'unlock_date': lockup_100.isoformat(), 'tranche': 100}])
        self.assertEqual(rec1['next_anchor_lock_in_date'], lockup_100.isoformat())

        # Older IPO (lockup passed)
        rec2 = ipo_records[1]
        self.assertEqual(rec2['symbol'], 'IPO2')
        self.assertEqual(rec2['listing_age_calendar_days'], 200)
        self.assertIsNone(rec2['next_anchor_lock_in_date'])
        # Full dollars are always restated in $M, however small the company.
        tiny = publish_us.build_us_ipos([{'symbol': 'TINY', 'listing_date': list_100.isoformat(), 'market_cap': 800_000,
                                          'dollar_volume': 250_000}], sess_date.isoformat())['records'][0]
        self.assertEqual((tiny['market_cap_crore'], tiny['turnover_crore']), (0.8, 0.25))


if __name__ == '__main__':
    unittest.main()
