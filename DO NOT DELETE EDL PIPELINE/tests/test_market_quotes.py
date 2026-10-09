import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import pipeline_utils
from pipeline_utils import load_json, save_json
import validate_market_quotes as quotes


def quote(symbol='BI', **values):
    return {'Sym': symbol, 'Isin': f'ISIN-{symbol}', 'Sid': symbol,
            'Open': 10, 'High': 12, 'Low': 9, 'Ltp': 11, 'Volume': 100,
            'provider_timestamp': 'source time', **values}


class MarketQuoteTests(unittest.TestCase):
    def run_validation(self, original, retry=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            save_json(root / 'dhan_data_response.json', original)
            save_json(root / 'master_isin_map.json', [{'Symbol': row['Sym']} for row in original if row['Sym'] != 'SME'])
            save_json(root / 'mainboard_scanx_data.json', [row for row in original if row['Sym'] != 'SME'])
            (root / 'all_stocks_fundamental_analysis.json.gz').write_bytes(b'previous publication')
            (root / 'ohlcv_data').mkdir()
            history = root / 'ohlcv_data/BI.csv'
            history.write_text('Date,Open,High,Low,Close,Volume\n2026-10-07,10,12,9,11,100\n')
            historical = history.read_bytes()
            with mock.patch.object(pipeline_utils, 'BASE_PATH', root), \
                    mock.patch.object(quotes, 'fetch_market_snapshot', **(
                        {'side_effect': retry} if isinstance(retry, Exception) else {'return_value': retry})) as fetch, \
                    contextlib.redirect_stdout(io.StringIO()):
                code = quotes.main()
            self.assertEqual((root / 'all_stocks_fundamental_analysis.json.gz').read_bytes(), b'previous publication')
            self.assertEqual(history.read_bytes(), historical)
            saved = load_json(root / 'dhan_data_response.json')
            self.assertEqual(load_json(root / 'mainboard_scanx_data.json'), [row for row in saved if row['Sym'] != 'SME'])
            return code, saved, load_json(root / 'price_validation_report.json'), fetch.call_count

    def test_valid_quotes_and_excluded_sme_do_not_retry(self):
        original = [quote(), quote('SME', Ltp=50)]
        code, rows, report, calls = self.run_validation(original)
        self.assertEqual(code, 0)
        self.assertEqual(rows, original)
        self.assertEqual(calls, 0)
        self.assertEqual(report['errors'], [])

    def test_one_retry_recovers_three_invalid_quotes_without_changing_other_stocks(self):
        original = [quote('BI', Ltp=20), quote('EIFFL', Open=20), quote('NRL', Low=15), quote('VALID')]
        retry = [quote('BI'), quote('EIFFL'), quote('NRL'), quote('VALID', Ltp=12)]
        code, rows, report, calls = self.run_validation(original, retry)
        self.assertEqual(code, 0)
        self.assertEqual(calls, 1)
        self.assertEqual(rows, retry[:3] + original[3:])
        self.assertEqual(report['rejected'][0]['ohlcv']['close'], 20)
        self.assertEqual(report['rejected'][0]['raw_quote']['provider_timestamp'], 'source time')
        self.assertTrue(report['snapshot_received_at'])
        self.assertTrue(report['retry_received_at'])
        self.assertEqual(report['errors'], [])

    def test_retry_failures_missing_fields_and_identity_changes_fail_closed(self):
        original = [quote(Ltp=20)]
        for retry in ([quote(Ltp=20)], [], [quote(Isin='DIFFERENT')],
                      [quote(Sid='DIFFERENT')], [quote(High=None)], [quote(Volume=None)],
                      [{key: value for key, value in quote().items() if key != 'Volume'}],
                      RuntimeError('provider unavailable')):
            with self.subTest(retry=retry):
                code, rows, report, calls = self.run_validation(original, retry)
                self.assertEqual(code, 1)
                self.assertEqual(calls, 1)
                self.assertEqual(rows, original)
                self.assertEqual(report['errors'][0]['symbol'], 'BI')
                self.assertEqual(report['errors'][0]['error'], 'inconsistent OHLC')
                self.assertEqual(report['rejected'][0]['ohlcv'],
                                 {'open': 10, 'high': 12, 'low': 9, 'close': 20, 'volume': 100})

    def test_missing_initial_ohlcv_fields_are_retried_or_rejected(self):
        for field in ('Open', 'High', 'Low', 'Ltp', 'Volume'):
            for missing in ('absent', None, 'invalid'):
                with self.subTest(field=field, missing=missing):
                    row = quote(**{field: missing})
                    if missing == 'absent':
                        row.pop(field)
                    original = [row]
                    for retry, expected_code in (([quote()], 0), (original, 1)):
                        code, rows, report, calls = self.run_validation(original, retry)
                        self.assertEqual(code, expected_code)
                        self.assertEqual(calls, 1)
                        self.assertEqual(rows, retry if code == 0 else original)
                        self.assertIn('missing OHLCV fields', report['rejected'][0]['error'])

    def test_partial_retry_keeps_original_inputs_and_records_remaining_errors(self):
        original = [quote('BI', Ltp=20), quote('EIFFL', Open=20), quote('VALID')]
        for unresolved in (quote('EIFFL', Open=20), quote('EIFFL', Sid='DIFFERENT')):
            with self.subTest(unresolved=unresolved):
                retry = [quote('BI'), unresolved]
                code, rows, report, calls = self.run_validation(original, retry)
                self.assertEqual(code, 1)
                self.assertEqual(calls, 1)
                self.assertEqual(rows, original)
                self.assertEqual([row['symbol'] for row in report['errors']], ['EIFFL'])
                self.assertEqual(report['retry_quotes'], retry)
                self.assertEqual([row['symbol'] for row in report['rejected']], ['BI', 'EIFFL'])

    def test_zero_volume_without_session_ohlc_preserves_ltp_and_unavailable_fields(self):
        # Reduced raw quotes from run 37777648427; retry returned the same values.
        original = [quote(symbol, Ltp=ltp, Volume=0) for symbol, ltp in
                    (('MUKESHB', 123), ('LADDERUP', 51.9), ('SAMBANDAM', 105.25),
                     ('KAMANWALA', 17), ('KALYANI', 144.99))]
        for row in original:
            for field in ('Open', 'High', 'Low'):
                row.pop(field)
        code, rows, report, calls = self.run_validation(original)
        self.assertEqual(code, 0)
        self.assertEqual(calls, 0)
        self.assertEqual(rows, original)
        self.assertEqual(report['errors'], [])
        self.assertEqual([entry['raw_quote'] for entry in report['unavailable_candles']], original)
        from edl_pipeline.transforms.fundamentals import analyze_stock
        from edl_pipeline.quality import ohlc_error
        for row in rows:
            stock = analyze_stock({'Symbol': row['Sym']}, row, {}, {})
            self.assertEqual(stock['Stock Price(₹)'], row['Ltp'])
            self.assertIsNone(stock['close'])
            self.assertIsNone(stock['rupee_volume'])
            self.assertEqual(stock['volume'], 0)
            self.assertTrue(all(stock[key] is None for key in ('open', 'high', 'low')))
            self.assertIsNone(ohlc_error(stock))

    def test_unavailable_candle_never_promotes_old_or_undated_ltp_to_session_close(self):
        from edl_pipeline.transforms.fundamentals import analyze_stock
        for timestamp in ('2025-01-01T10:00:00Z', None):
            with self.subTest(provider_timestamp=timestamp):
                row = quote(Open=None, High=None, Low=None, Volume=0, provider_timestamp=timestamp)
                code, rows, report, calls = self.run_validation([row])
                self.assertEqual(code, 0)
                self.assertEqual(calls, 0)
                self.assertFalse(report['unavailable_candles'][0]['ltp_session_verified'])
                self.assertEqual(report['unavailable_candles'][0]['raw_quote']['provider_timestamp'], timestamp)
                stock = analyze_stock({'Symbol': row['Sym']}, rows[0], {}, {})
                self.assertEqual(stock['Stock Price(₹)'], row['Ltp'])
                self.assertIsNone(stock['close'])
                self.assertIsNone(stock['rupee_volume'])
        for volume in (0, 100):
            stock = analyze_stock({'Symbol': 'BI'}, quote(Volume=volume), {}, {})
            self.assertEqual(stock['close'], 11)
            self.assertEqual(stock['rupee_volume'], 11 * volume)

    def test_unavailable_session_candle_never_promotes_nonpositive_ltp_to_session_close(self):
        from edl_pipeline.transforms.fundamentals import analyze_stock
        for ltp in (0, -1):
            with self.subTest(ltp=ltp):
                row = quote(Ltp=ltp, Open=None, High=None, Low=None, Volume=0)
                stock = analyze_stock({'Symbol': 'BI'}, row, {}, {})
                self.assertIsNone(stock['close'])
                self.assertIsNone(stock['rupee_volume'])

    def test_wholly_missing_session_fields_preserve_price_without_inventing_a_candle(self):
        from edl_pipeline.transforms.fundamentals import analyze_stock
        from edl_pipeline.quality import ohlc_error
        # Reduced quotes from failed run 37931823057, unchanged by its retry.
        for null_fields in (False, True):
            with self.subTest(null_fields=null_fields):
                original = [quote('SAB', Isin='INE137M01017', Sid=764860, Ltp=171),
                            quote('MPDL', Isin='INE493H01014', Sid=765138, Ltp=25.87)]
                for row in original:
                    for field in ('Open', 'High', 'Low', 'Volume'):
                        if null_fields:
                            row[field] = None
                        else:
                            row.pop(field)
                code, rows, report, calls = self.run_validation(original, original)
                self.assertEqual(code, 0)
                self.assertEqual(calls, 0)
                self.assertEqual(rows, original)
                self.assertEqual(report['errors'], [])
                self.assertEqual([entry['raw_quote'] for entry in report['unavailable_candles']], original)
                for entry, row in zip(report['unavailable_candles'], rows):
                    self.assertEqual(entry['reason'], 'missing volume with no session OHLC')
                    self.assertFalse(entry['ltp_session_verified'])
                    stock = analyze_stock({'Symbol': row['Sym']}, row, {}, {})
                    self.assertEqual(stock['Stock Price(₹)'], row['Ltp'])
                    for field in ('open', 'high', 'low', 'close', 'volume', 'rupee_volume'):
                        self.assertIsNone(stock[field])
                    self.assertIsNone(ohlc_error(stock))

    def test_unavailable_candle_exception_does_not_accept_malformed_or_traded_quotes(self):
        for values in ({'Volume': 1}, {'Volume': 'invalid'}, {'Volume': ''},
                       {'Volume': 'NaN'}, {'Volume': 'inf'}, {'Volume': -1}, {'Ltp': 0},
                       {'Ltp': None}, {'Open': 10}, {'High': 'invalid'}, {'Low': 0}):
            with self.subTest(values=values):
                row = quote(Open=None, High=None, Low=None, Volume=0)
                row.update(values)
                self.assertTrue(quotes.quote_errors([row], {'BI'}))
                code, rows, report, calls = self.run_validation([row], [row])
                self.assertEqual(code, 1)
                self.assertEqual(calls, 1)
                self.assertEqual(rows, [row])
                self.assertEqual(report['unavailable_candles'], [])

    def test_nonpositive_prices_and_invalid_volume_use_publication_policy(self):
        for values in ({'High': 0}, {'Volume': -1}):
            with self.subTest(values=values):
                self.assertTrue(quotes.quote_errors([quote(**values)], {'BI'}))
