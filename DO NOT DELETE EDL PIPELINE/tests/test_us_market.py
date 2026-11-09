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
from edl_pipeline.markets.us import calendar, dhan, fields  # noqa: E402



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
        self.assertAlmostEqual(record['percent_from_52w_high'], (342.5 / 350 - 1) * 100)
        self.assertEqual(record['provider_last_trade_ist'], '2026-11-07T02:29:55+05:30')
        self.assertNotIn('market_cap_crore', record)

    def test_rows_without_an_id_or_price_are_dropped(self):
        self.assertIsNone(fields.canonical_row({**self.ROW, 'Ltp': 0}))
        self.assertIsNone(fields.canonical_row({**self.ROW, 'Sid': None}))


if __name__ == '__main__':
    unittest.main()
