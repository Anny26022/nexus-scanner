import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "src", ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import requests  # noqa: E402

from edl_pipeline.markets import MARKETS, market  # noqa: E402
import tempfile  # noqa: E402

from edl_pipeline.markets.us import build, calendar, dhan, fields, history, statements, tradingview  # noqa: E402
from edl_pipeline.markets.us.universe import history_exchanges, security_type  # noqa: E402


def utc(*parts):
    return datetime(*parts, tzinfo=timezone.utc)


class CalendarTests(unittest.TestCase):
    def test_holidays_match_nyse_published_calendars(self):
        expected = {
            2024: ['01-01', '01-15', '02-19', '03-29', '05-27', '06-19', '07-04', '09-02', '11-28', '12-25'],
            # 2025 includes the unscheduled closure for President Carter's national day of mourning.
            2025: ['01-01', '01-09', '01-20', '02-17', '04-18', '05-26', '06-19', '07-04', '09-01', '11-27', '12-25'],
            # Independence Day falls on a Saturday: observed Friday July 3.
            2026: ['01-01', '01-19', '02-16', '04-03', '05-25', '06-19', '07-03', '09-07', '11-26', '12-25'],
            # Juneteenth and Christmas on Saturdays move to Friday; July 4 on a Sunday moves to Monday.
            2027: ['01-01', '01-18', '02-15', '03-26', '05-31', '06-18', '07-05', '09-06', '11-25', '12-24'],
        }
        for year, days in expected.items():
            self.assertEqual([day.isoformat()[5:] for day in calendar.nyse_holidays(year)], days, year)

    def test_new_years_day_on_a_saturday_is_not_observed_the_year_before(self):
        self.assertTrue(calendar.is_nyse_session_day(date(2027, 12, 31)))  # 2028-01-01 is a Saturday
        self.assertNotIn(date(2027, 12, 31), calendar.nyse_holidays(2027))

    def test_early_closes_fall_on_weekdays_before_a_trading_holiday(self):
        self.assertEqual(list(calendar.nyse_early_closes(2025)), [date(2025, 7, 3), date(2025, 11, 28), date(2025, 12, 24)])
        # July 3, 2026 is itself the observed holiday, so only Thanksgiving Friday and Christmas Eve close early.
        self.assertEqual(list(calendar.nyse_early_closes(2026)), [date(2026, 11, 27), date(2026, 12, 24)])
        self.assertEqual(calendar.nyse_close(date(2026, 11, 27)).hour, 13)
        self.assertEqual(calendar.nyse_close(date(2026, 11, 25)).hour, 16)

    def test_last_closed_session_follows_new_york_across_daylight_saving(self):
        # 6:00 AM IST on a Tuesday is Monday evening in New York, in winter (EST) and in summer (EDT).
        self.assertEqual(calendar.last_closed_session(utc(2026, 11, 10, 0, 30)), date(2026, 11, 9))
        self.assertEqual(calendar.last_closed_session(utc(2026, 7, 7, 0, 30)), date(2026, 7, 6))
        # During Monday's session, the latest closed one is Friday's.
        self.assertEqual(calendar.last_closed_session(utc(2026, 11, 9, 15, 0)), date(2026, 11, 6))
        # A Monday holiday (Martin Luther King Jr. Day 2026) falls back to the Friday before.
        self.assertEqual(calendar.last_closed_session(utc(2026, 1, 20, 0, 30)), date(2026, 1, 16))
        # The day after Thanksgiving closes at 1 PM: by 2 PM Eastern it is closed.
        self.assertEqual(calendar.last_closed_session(utc(2026, 11, 27, 19, 0)), date(2026, 11, 27))

    def test_sessions_after_a_listing_count_nyse_sessions(self):
        self.assertEqual(calendar.sessions_after(date(2026, 11, 6), date(2026, 11, 9)), 1)
        self.assertEqual(calendar.sessions_after(date(2026, 11, 20), date(2026, 11, 30)), 5)  # Thanksgiving
        self.assertEqual(calendar.sessions_after(date(2026, 11, 9), date(2026, 11, 9)), 0)
        self.assertEqual(calendar.sessions_after(date(2025, 1, 1), date(2025, 12, 31)), 250)  # 261 weekdays, 11 closures

    def test_cash_session_hours(self):
        self.assertTrue(calendar.is_us_cash_session(utc(2026, 11, 9, 15, 0)))   # 10:00 AM EST
        self.assertFalse(calendar.is_us_cash_session(utc(2026, 11, 9, 14, 0)))  # 9:00 AM EST, before the open
        self.assertFalse(calendar.is_us_cash_session(utc(2026, 11, 27, 18, 30)))  # 1:30 PM on an early close

    def test_markets_are_described_once(self):
        self.assertEqual(set(MARKETS), {'in', 'us'})
        self.assertTrue(market('us').has('listed_options'))
        self.assertFalse(market('us').has('delivery'))
        with self.assertRaises(ValueError):
            market('uk')


class DhanTests(unittest.TestCase):
    def test_history_bars_are_dated_by_their_us_session(self):
        # Dhan stamps the 2026-10-12 bar at midnight IST, which is the evening before in UTC.
        self.assertEqual(dhan.session_date(1791743400), '2026-10-12')

    def test_history_asks_for_the_listing_exchange_and_skips_incomplete_bars(self):
        sent = []

        def post(url, payload):
            sent.append((url, payload))
            return {'data': {'t': [1791743400, 1791829800], 'o': [1, None], 'h': [2, 2], 'l': [0.5, 1], 'c': [1.5, 1.6], 'v': [10, 11]}}

        bars = dhan.fetch_history('AAPL', 10000025, 'NASDAQ', utc(2026, 1, 1), utc(2026, 11, 1), post=post)
        self.assertEqual(sent[0][0], dhan.HISTORY_URL)
        self.assertEqual((sent[0][1]['EXCH'], sent[0][1]['SEC_ID']), ('NASDAQ', 10000025))
        self.assertEqual(bars, [{'date': '2026-10-12', 'open': 1, 'high': 2, 'low': 0.5, 'close': 1.5, 'volume': 10}])

    def test_universe_follows_pages_and_refuses_an_error(self):
        pages = {1: {'code': 0, 'tot_pg': 2, 'data': [{'Sym': 'A'}]}, 2: {'code': 0, 'tot_pg': 2, 'data': [{'Sym': 'B'}]}}
        requests_sent = []

        def post(url, payload):
            requests_sent.append(payload['data'])
            return pages[payload['data']['pgno']]

        self.assertEqual([row['Sym'] for row in dhan.fetch_universe('etf', post=post)], ['A', 'B'])
        self.assertEqual(requests_sent[0]['params'][1], {'field': 'OgInst', 'op': '', 'val': 'ETF'})
        with self.assertRaises(ValueError):
            dhan.fetch_universe(post=lambda url, payload: {'code': -1, 'remarks': 'no data found'})

    def test_rate_limits_stop_the_run(self):
        response = mock.Mock(status_code=403, url=dhan.HISTORY_URL)
        with self.assertRaises(dhan.Throttled):
            dhan._checked(response)

    def test_stock_pages_reread_the_build_id_once_after_a_deploy(self):
        pages = iter(['"buildId":"old"', '"buildId":"new"'])
        fetched = []

        def fetch_json(url):
            fetched.append(url)
            if '/old/' in url:
                raise requests.HTTPError(response=mock.Mock(status_code=404))
            return {'pageProps': {'fundamentalsData': {}}}

        stock_pages = dhan.StockPages(get=lambda url: next(pages), fetch_json=fetch_json)
        self.assertEqual(stock_pages.fetch('AAPL-apple-inc'), {'fundamentalsData': {}})
        self.assertTrue(fetched[-1].endswith('/new/us-stocks/AAPL-apple-inc-share-price.json'))


class FieldTests(unittest.TestCase):
    ROW = {'Sym': 'AAPL', 'DispSym': 'Apple', 'Seosym': 'AAPL-apple-inc', 'Isin': 'US0378331005', 'Sid': 10000025,
           'Cust_Exch': 'NASDAQ', 'OgInst': 'ES', 'Ltp': 342.5, 'Volume': 1000, 'High1Yr': 350.0, 'Low1Yr': 250.0,
           'Mcap': 4976937.41, 'Pe': 36.7, 'ReturnOnEquity': 169.7, 'PricePerchng1year': 29.3, 'LastTradeTime': '07/11/2026 02:29:55'}

    def test_canonical_names_and_full_dollar_amounts(self):
        record = fields.canonical_row(self.ROW)
        self.assertEqual((record['market'], record['currency'], record['instrument'], record['exchange']), ('us', 'USD', 'stock', 'NASDAQ'))
        self.assertAlmostEqual(record['market_cap'], 4_976_937_410_000)  # Dhan sends millions of dollars
        self.assertEqual(record['dollar_volume'], 342_500)
        self.assertEqual((record['perf_12m'], record['pe_ratio'], record['roe_percent']), (29.3, 36.7, 169.7))
        # The 52-week distances come from the history, as for India, not from the snapshot.
        self.assertNotIn('distance_from_52w_high_percent', record)
        self.assertEqual(record['provider_last_trade_ist'], '2026-11-07T02:29:55+05:30')
        self.assertNotIn('market_cap_crore', record)

    def test_only_fields_the_release_reads_are_requested(self):
        self.assertEqual(set(fields.DIRECT) - set(fields.SNAPSHOT_FIELDS), set())
        for unread in ('High1Wk', 'High3Yr', 'PricePerchng2week', 'NetProfitMargin', 'TotalShares', 'FixedAssets', 'CWIP'):
            self.assertNotIn(unread, fields.SNAPSHOT_FIELDS)

    def test_rows_without_an_id_or_price_are_dropped(self):
        self.assertIsNone(fields.canonical_row({**self.ROW, 'Ltp': 0}))
        self.assertIsNone(fields.canonical_row({**self.ROW, 'Sid': None}))


class UniverseTests(unittest.TestCase):
    def test_share_classes_are_read_from_the_name(self):
        self.assertEqual(security_type('AAPL', 'Apple'), 'common')
        self.assertEqual(security_type('GOOGP', 'Alphabet (Google) - Preferred Stock - Series A'), 'preferred')
        self.assertEqual(security_type('CCXIU', 'Churchill Capital XI - Units'), 'spac_unit')
        self.assertEqual(security_type('KKR', 'KKR - Units'), 'partnership_unit')
        self.assertEqual(security_type('ABCW', 'Acme - Warrants'), 'warrant')
        self.assertEqual(security_type('ABCR', 'Acme - Rights'), 'right')
        self.assertEqual(security_type('ABCN', 'Acme - Notes due 2030'), 'note')

    def test_unlabelled_listings_try_both_main_exchanges(self):
        self.assertEqual(history_exchanges('NASDAQ'), ('NASDAQ',))
        self.assertEqual(history_exchanges('NA'), ('NYSE', 'NASDAQ'))
        self.assertEqual(history_exchanges(None), ('NYSE', 'NASDAQ'))


def bar(day, close, volume=100):
    return {'date': day, 'open': close, 'high': close, 'low': close, 'close': close, 'volume': volume}


class HistoryTests(unittest.TestCase):
    # Friday 2026-11-06 is the previous session of Monday 2026-11-09.
    RECORD = {'symbol': 'ACME', 'security_id': 1, 'exchange': 'NYSE', 'open': 10.5, 'high': 11.0, 'low': 10.0,
              'close': 10.8, 'volume': 500, 'previous_close': 10.0}

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__('shutil').rmtree(self.root))

    def stored(self):
        return history.read_bars(self.root / 'ACME.csv')

    def test_a_joined_series_gets_the_snapshot_bar(self):
        history.write_bars(self.root / 'ACME.csv', [bar('2026-11-05', 9.5), bar('2026-11-06', 10.0)])
        fetch = mock.Mock()
        self.assertEqual(history.update(self.RECORD, self.root, '2026-11-09', fetch=fetch), 'appended')
        fetch.assert_not_called()
        self.assertEqual(self.stored()[-1], {'date': '2026-11-09', 'open': 10.5, 'high': 11.0, 'low': 10.0, 'close': 10.8, 'volume': 500.0})
        self.assertEqual(history.update(self.RECORD, self.root, '2026-11-09', fetch=fetch), 'current')

    def test_a_readjusted_series_is_fetched_again(self):
        # A 2:1 split: the stored close is twice the snapshot's previous close.
        history.write_bars(self.root / 'ACME.csv', [bar('2026-11-06', 20.0)])
        fetch = mock.Mock(return_value=[bar('2026-11-05', 9.5), bar('2026-11-06', 10.0)])
        self.assertEqual(history.update(self.RECORD, self.root, '2026-11-09', fetch=fetch), 'refetched')
        self.assertEqual([b['close'] for b in self.stored()], [9.5, 10.0, 10.8])

    def test_a_gap_is_fetched_again_and_a_stock_without_history_is_missing(self):
        history.write_bars(self.root / 'ACME.csv', [bar('2026-11-04', 10.0)])
        fetch = mock.Mock(return_value=[bar('2026-11-06', 10.0), bar('2026-11-09', 10.8)])
        self.assertEqual(history.update(self.RECORD, self.root, '2026-11-09', fetch=fetch), 'refetched')
        self.assertEqual(self.stored()[-1]['date'], '2026-11-09')
        self.assertEqual(history.update({**self.RECORD, 'symbol': 'NONE'}, self.root, '2026-11-09', fetch=lambda *a: []), 'missing')

    def test_bars_are_cleaned_and_stored_files_rewritten(self):
        # An open below the low (CSCO, 2026-09-09) widens the range; a bar priced 0 before a listing is dropped.
        self.assertEqual(history.clean({'date': '2026-09-09', 'open': 108.786, 'high': 110.43, 'low': 108.98, 'close': 109.437, 'volume': 1}),
                         {'date': '2026-09-09', 'open': 108.786, 'high': 110.43, 'low': 108.786, 'close': 109.437, 'volume': 1})
        self.assertIsNone(history.clean({'date': '2026-07-07', 'open': 0, 'high': 0, 'low': 0, 'close': 0, 'volume': 0}))
        history.write_bars(self.root / 'ACME.csv', [{**bar('2026-11-06', 10.0), 'low': 10.5}, bar('2026-11-09', 10.8)])
        self.assertEqual(history.update(self.RECORD, self.root, '2026-11-09', fetch=mock.Mock()), 'current')
        self.assertEqual(self.stored()[0]['low'], 10.0)

    def test_bars_on_closed_days_are_dropped(self):
        bars = history.session_bars([bar('2026-10-25', 1), bar('2026-10-23', 1), bar('2026-10-23', 2), bar('2026-11-26', 1)])
        self.assertEqual(bars, [bar('2026-10-23', 2)])  # a Sunday and Thanksgiving go; the later duplicate wins


class BuildTests(unittest.TestCase):
    def test_in_session_and_stale_snapshots_are_refused(self):
        live = [{**FieldTests.ROW, 'LastTradeTime': '09/11/2026 20:30:00'}]
        with self.assertRaises(build.SnapshotNotReady):
            build.snapshot_session(live, utc(2026, 11, 9, 15, 0))  # 10:00 AM in New York
        stale = [{**FieldTests.ROW, 'LastTradeTime': '07/11/2026 02:29:55'}]  # Friday's close
        with self.assertRaises(build.SnapshotNotReady):
            build.snapshot_session(stale, utc(2026, 11, 10, 0, 30))  # Monday has closed
        closed = [{**FieldTests.ROW, 'LastTradeTime': '10/11/2026 02:29:59'}]
        self.assertEqual(build.snapshot_session(closed, utc(2026, 11, 10, 0, 30)), '2026-11-09')

    def test_engine_amounts_are_millions_of_dollars(self):
        record = {'market_cap': 4_976_937_410_000, 'dollar_volume': 342_500}
        amounts = build.engine_amounts(record, {'turnover20': 1.5, 'turnover50': 2.5, 'turnover100': None})
        self.assertAlmostEqual(amounts['market_cap_crore'], 4_976_937.41)
        self.assertEqual((amounts['daily_rupee_turnover_20_cr'], amounts['daily_rupee_turnover_50_cr']), (1.5, 2.5))
        self.assertIsNone(amounts['daily_rupee_turnover_100_cr'])

    def test_records_carry_history_metrics_and_india_return_names_only(self):
        record = {**fields.canonical_row({**FieldTests.ROW, 'PricePerchng5year': 120.0}), 'slug': 'AAPL-apple-inc'}
        stock = build.stock_record(record, {'as_of_date': '2026-11-09', 'distance_from_52w_high_percent': -3.0,
                                            'distance_from_52w_low_percent': None, 'turnover50': 2.0}, '2026-11-09')
        self.assertEqual(stock['distance_from_52w_high_percent'], -3.0)
        self.assertIsNone(stock['distance_from_52w_low_percent'])  # a short history has none, as for India
        self.assertEqual((stock['return_1y'], stock['return_5y'], stock['as_of_date']), (29.3, 120.0, '2026-11-09'))
        self.assertIsNone(stock['percent_from_ath'])
        for build_only in ('turnover50', 'slug', 'provider_last_trade_ist'):
            self.assertNotIn(build_only, stock)


class TradingViewTests(unittest.TestCase):
    STAMP = 1794234600  # 2026-11-09 09:30 in New York

    def row(self, ticker, isin, primary=True, exchange='NYSE', **values):
        defaults = {'isin': isin, 'time': self.STAMP, 'close': 100.0, 'update_mode': 'delayed', 'currency': 'USD',
                    'fundamental_currency_code': 'USD', 'exchange': exchange, 'is_primary': primary, 'type': 'stock'}
        return {'s': ticker, 'd': [{**defaults, **values}.get(column) for column in tradingview.COLUMNS]}

    def response(self, *rows):
        return {'totalCount': len(rows), 'data': list(rows)}

    def test_rows_match_by_isin_with_amounts_in_millions_of_dollars(self):
        found = tradingview.snapshots(self.response(
            self.row('NYSE:BRK.B', 'US0846707026', primary=False, **{'AvgValue.Traded_10d': 2_500_000_000, 'Perf.1M': 4.2}),
            self.row('OTC:XYZ', 'US0000000001', exchange='OTC')), '2026-11-10T00:30:00+00:00')
        self.assertEqual(set(found), {'US0846707026'})
        snapshot = found['US0846707026']['tradingview_snapshot']
        self.assertEqual((snapshot['source'], snapshot['as_of_date'], snapshot['listing_symbol']), (tradingview.API_URL, '2026-11-09', 'NYSE:BRK.B'))
        self.assertEqual(snapshot['market']['turnover10_crore'], 2500.0)
        self.assertEqual(snapshot['market']['performance_1m_pct'], 4.2)
        with self.assertRaises(ValueError):
            tradingview.snapshots({'totalCount': 2, 'data': []}, '')

    def test_amounts_in_another_currency_are_left_out(self):
        found = tradingview.snapshots(self.response(self.row('NASDAQ:ASML', 'USN070592100', fundamental_currency_code='EUR',
                                                             **{'total_debt_fy': 9e9, 'price_earnings_ttm': 30.0})), '')
        financials = found['USN070592100']['tradingview_snapshot']['financials']
        self.assertIsNone(financials['total_debt_fy_crore'])
        self.assertIsNone(financials['pe_ttm'])

    def test_canonical_fields_use_the_session_and_never_a_high_below_the_history(self):
        found = tradingview.snapshots(self.response(self.row('NYSE:KO', 'US1912161007', **{
            'High.All': 90.0, 'earnings_release_date': 1793098500,
            'float_shares_percent_current': 99.3, 'dividends_yield_current': 2.2, 'ex_dividend_date_recent': 1789430400})), '')
        values = tradingview.canonical(found['US1912161007'], {'close': 95.0, 'high_52w': 97.0}, '2026-11-09')
        self.assertEqual(values['all_time_high'], 97.0)
        self.assertAlmostEqual(values['percent_from_ath'], (95 / 97 - 1) * 100)
        self.assertEqual(values['latest_earnings_date'], '2026-10-27')
        self.assertNotIn('next_earnings_date', values)
        self.assertEqual((values['free_float_percent'], values['dividend_yield_percent']), (99.3, 2.2))
        # A stale TradingView row (another session) gives no all-time high.
        self.assertIsNone(tradingview.canonical(found['US1912161007'], {'close': 95.0}, '2026-11-10')['percent_from_ath'])

    def test_statements_debt_and_eps_history_in_millions_of_dollars(self):
        found = tradingview.snapshots(self.response(self.row('NASDAQ:AAPL', 'US0378331005', **{
            'total_debt_fq': 85_764e6, 'total_equity_fq': 112_093e6, 'total_assets_fq': 404_548e6, 'total_current_assets_fq': 173_857e6,
            'total_liabilities_fq': 292_455e6, 'total_current_liabilities_fq': 169_915e6, 'cash_f_operating_activities_fy': 145e9,
            'cash_f_investing_activities_fy': -17e9, 'cash_f_financing_activities_fy': -127e9,
            'earnings_per_share_diluted_ttm': 8.8, 'earnings_per_share_diluted_yoy_growth_ttm': 10.0})), '')
        values = tradingview.canonical(found['US0378331005'], {'close': 350.0}, '2026-11-09')
        self.assertAlmostEqual(values['debt_to_equity'], 85_764 / 112_093)
        self.assertEqual((values['borrowings_crore'], values['total_assets_in_lakhs']), (85_764, 404_548))
        self.assertEqual((values['non_current_assets_in_lakhs'], values['non_current_liabilities_in_lakhs']), (230_691, 122_540))
        self.assertEqual(values['net_cash_flow_in_lakhs'], 1_000)
        self.assertAlmostEqual(values['eps_2_years_back'], 8.0)

    def test_listing_date_and_index_memberships(self):
        found = tradingview.snapshots(self.response(self.row('NASDAQ:ARM', 'US0420682058', **{
            'ipo_offer_date': 1694649600, 'first_bar_time': 1694698200,
            'indexes': [{'name': 'NASDAQ 100', 'proname': 'NASDAQ:NDX'}, {'name': 'NASDAQ Composite', 'proname': 'NASDAQ:IXIC'},
                        {'name': 'Russell 1000', 'proname': 'TVC:RUI'}]})), '')
        values = tradingview.canonical(found['US0420682058'], {'close': 150.0}, '2026-11-09')
        self.assertEqual(values['listing_date'], '2023-09-14')
        self.assertEqual(values['index_memberships'], ['NASDAQ 100', 'RUSSELL 1000'])
        # Without an IPO date, the first traded day.
        found = tradingview.snapshots(self.response(self.row('NYSE:OLD', 'US0000000002', first_bar_time=946909800)), '')
        self.assertEqual(tradingview.canonical(found['US0000000002'], {'close': 1.0}, '2026-11-09')['listing_date'], '2000-01-03')

    def test_a_failed_request_publishes_without_these_values(self):
        records = [{'isin': 'US1912161007'}]
        def fail():
            raise OSError('timed out')
        report = tradingview.enrich(records, '2026-11-09', fetch_response=fail)
        self.assertEqual((report['matched'], records), (0, [{'isin': 'US1912161007'}]))


def joined(*values):
    return '|'.join('' if value is None else str(value) for value in values)


class StatementTests(unittest.TestCase):
    # Ten quarters of a company with a September fiscal year, newest first, in millions of dollars.
    PERIODS = joined(202609, 202606, 202603, 202512, 202509, 202506, 202503, 202412, 202409, 202406)
    PAGE = {
        'incomeStat_sq': {'YEAR': PERIODS, 'REVENUE': joined(*[110] * 4, *[100] * 6), 'SALES': joined(*[110] * 4, *[100] * 6),
                          'EXPENSES': joined(*[80] * 10), 'OTHER_INCOME': joined(*[5] * 10), 'OPERATING_PROFIT': joined(*[30] * 10),
                          'INTEREST': joined(*[2] * 10), 'PROFIT_BEFORE_TAX': joined(*[28] * 10),
                          'TAX_PAYMENT_ABSOLUTE': joined(*[6] * 10), 'NET_PROFIT': joined(*[22] * 4, *[20] * 6),
                          'EPS': joined(*[1.1] * 4, *[1.0] * 6)},
        'bs_s': {'YEAR': joined(202609, 202606), 'TOTAL_ASSETS': joined(500, 480), 'CURRENT_ASSETS': joined(200, 190),
                 'CURRENT_LIABILITIES': joined(100, 95), 'NON_CURRENT_LIABILITIES': joined(150, 150), 'TOTAL_EQUITY': joined(250, 235)},
        'cF_sy': {'YEAR': joined(202609), 'OPERATING_ACTIVITIES': joined(120), 'INVESTING_ACTIVITIES': joined(-40),
                  'FINANCING_ACTIVITIES': joined(-60), 'NET_CASH_FLOW': joined(20)},
        'rNp_s': {'YEAR': joined(*(year * 100 + 9 for year in range(2026, 2020, -1))), 'REVENUE': joined(440, 400, 380, 350, 320, 300)},
        'CV': {'PEG': '1.5'},
    }

    def fields(self, page):
        return {key: value for block in statements.statement_blocks(page).values() for key, value in block['fields'].items()}

    def test_statements_read_the_latest_quarter_trailing_year_and_balance_sheet(self):
        values = self.fields(self.PAGE)
        self.assertEqual((values['total_revenue_in_lakhs'], values['total_income_in_lakhs']), (110, 115))
        self.assertEqual((values['ttm_revenue_crore'], values['ttm_net_profit_crore']), (440, 88))
        self.assertAlmostEqual(values['ttm_revenue_growth_percent'], 10.0)
        self.assertAlmostEqual(values['eps_last_year'], 4.4)
        self.assertEqual(values['eps_2_years_back'], 4.0)
        self.assertEqual(values['interest_coverage'], (112 + 8) / 8)
        self.assertEqual((values['total_liabilities_in_lakhs'], values['non_current_assets_in_lakhs'], values['current_ratio']), (250, 300, 2.0))
        self.assertAlmostEqual(values['sales_growth_5_years_percent'], ((440 / 300) ** 0.2 - 1) * 100)
        self.assertEqual(values['peg_ratio'], 1.5)

    def test_a_missing_quarter_gives_no_trailing_figures_and_zeros_mean_not_reported(self):
        gap = {**self.PAGE['incomeStat_sq'], 'YEAR': joined(202609, 202606, 202512, 202509, 202506, 202503, 202412, 202409, 202406, 202403)}
        bank = {**self.PAGE, 'incomeStat_sq': gap,
                'bs_s': {'YEAR': joined(202609), 'TOTAL_ASSETS': joined(5000), 'CURRENT_ASSETS': joined(0),
                         'CURRENT_LIABILITIES': joined(0), 'NON_CURRENT_LIABILITIES': joined(0), 'TOTAL_EQUITY': joined(400)}}
        values = self.fields(bank)
        self.assertIsNone(values['ttm_revenue_crore'])
        self.assertIsNone(values['interest_coverage'])
        self.assertIsNone(values['current_ratio'])
        self.assertIsNone(values['total_liabilities_in_lakhs'])

    def test_each_part_of_a_page_is_used_only_when_current_and_in_dollars(self):
        blocks = statements.statement_blocks(self.PAGE)
        self.assertEqual(statements.trusted_blocks(blocks, {'total_revenue_in_lakhs': 105}),
                         {'income', 'balance', 'cash_flow', 'annual', 'ratios'})
        # Stale (Costco's 2009 balance sheet) or another currency (TSMC in Taiwan dollars): nothing is used.
        self.assertEqual(statements.trusted_blocks(blocks, {'total_revenue_in_lakhs': 3500}), set())
        # ADRs carry US ISINs, so without TradingView's figure there is nothing to check against.
        self.assertEqual(statements.trusted_blocks(blocks, {'isin': 'US8740391003'}), set())
        # A balance sheet a quarter behind the income statement (Apple's, on Dhan) is left to TradingView.
        behind = statements.statement_blocks({**self.PAGE, 'bs_s': {**self.PAGE['bs_s'], 'YEAR': joined(202606, 202603)}})
        self.assertNotIn('balance', statements.trusted_blocks(behind, {'total_revenue_in_lakhs': 110}))

    def test_dhan_comes_first_and_tradingview_fills_the_rest(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__('shutil').rmtree(root))
        gap = {**self.PAGE['incomeStat_sq'], 'YEAR': joined(202609, 202606, 202512, 202509, 202506, 202503, 202412, 202409, 202406, 202403)}
        statements.write_page(root, 'ACME', {'fetched_at': '2026-11-09T00:30:00+00:00', 'slug': 'ACME-acme', **self.PAGE})
        statements.write_page(root, 'GAP', {'fetched_at': '2026-11-09T00:30:00+00:00', 'slug': 'GAP-gap', **self.PAGE, 'incomeStat_sq': gap})
        acme = {'symbol': 'ACME', 'total_revenue_in_lakhs': 108, 'ttm_revenue_crore': 450, 'dividend_yield_percent': 1.2}
        gapped = {'symbol': 'GAP', 'total_revenue_in_lakhs': 108, 'ttm_revenue_crore': 450}
        report = statements.enrich([acme, gapped], root)
        self.assertEqual((acme['ttm_revenue_crore'], acme['profit_before_tax_in_lakhs'], acme['dividend_yield_percent']), (440, 28, 1.2))
        self.assertEqual((gapped['ttm_revenue_crore'], gapped['profit_before_tax_in_lakhs']), (450, 28))  # a missing quarter
        self.assertEqual((report['with_statements'], report['balance']), (2, 2))
        self.assertEqual(acme['financial_metadata']['amount_unit'], 'USD_MILLION')

    def test_quarterly_history_in_indias_rows_with_filing_dates(self):
        rows = statements.quarterly_history(self.PAGE, {'symbol': 'ACME', 'isin': 'US1', 'latest_earnings_date': '2026-10-30'})
        self.assertEqual(len(rows), 10)
        latest, earliest = rows[-1], rows[0]
        self.assertEqual((latest['quarter_end'], latest['filing_date'], latest['filing_date_basis']), ('2026-09-30', '2026-10-30', 'reported'))
        self.assertEqual((earliest['quarter_end'], earliest['filing_date'], earliest['filing_date_basis']), ('2024-06-30', '2024-08-14', 'estimated'))
        self.assertEqual((latest['report_type'], latest['revenue'], latest['net_profit'], latest['eps']), ('CONSOLIDATED', 110, 22, 1.1))
        # A stale earnings date (before the quarter ended) is not this quarter's filing.
        stale = statements.quarterly_history(self.PAGE, {'symbol': 'ACME', 'latest_earnings_date': '2026-07-30'})
        self.assertEqual(stale[-1]['filing_date_basis'], 'estimated')

    def test_trusted_pages_feed_the_quarterly_history(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__('shutil').rmtree(root))
        statements.write_page(root, 'ACME', {'fetched_at': '2026-11-09T00:30:00+00:00', 'slug': 'ACME-acme', **self.PAGE})
        statements.write_page(root, 'TSM', {'fetched_at': '2026-11-09T00:30:00+00:00', 'slug': 'TSM-tsm', **self.PAGE})
        history = []
        statements.enrich([{'symbol': 'ACME', 'total_revenue_in_lakhs': 108}, {'symbol': 'TSM', 'total_revenue_in_lakhs': 3500}], root, history)
        self.assertEqual({row['symbol'] for row in history}, {'ACME'})

    def test_pages_are_fetched_again_weekly_and_after_earnings(self):
        now = utc(2026, 11, 10, 0, 30)
        page = {'fetched_at': '2026-11-05T00:30:00+00:00'}
        self.assertTrue(statements.stale(None, {}, now))
        self.assertFalse(statements.stale(page, {'latest_earnings_date': '2026-10-29'}, now))
        self.assertTrue(statements.stale(page, {'latest_earnings_date': '2026-11-06'}, now))
        self.assertTrue(statements.stale({'fetched_at': '2026-11-02T00:30:00+00:00'}, {}, now))

    def test_fetching_stops_at_the_first_rate_limit_and_keeps_what_it_has(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__('shutil').rmtree(root))
        calls = []

        class Pages:
            def fetch(self, slug):
                calls.append(slug)
                if slug == 'B-b':
                    raise dhan.Throttled('403')
                return {'fundamentalsData': {'incomeStat_sq': {'YEAR': '202609', 'REVENUE': '1'}}}

        records = [{'symbol': symbol, 'slug': f'{symbol}-{symbol.lower()}'} for symbol in ('A', 'B', 'C')]
        counts = statements.refresh_pages(records, root, utc(2026, 11, 10), pages=Pages(), interval=0, workers=1)
        self.assertEqual((counts['fetched'], counts['throttled']), (1, True))
        self.assertIsNotNone(statements.read_page(root, 'A'))
        self.assertIsNone(statements.read_page(root, 'C'))


if __name__ == '__main__':
    unittest.main()
