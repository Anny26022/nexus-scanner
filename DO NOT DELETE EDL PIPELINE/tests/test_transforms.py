import contextlib
import enrich_fno_data
import gzip
import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from fetch_bulk_block_deals import date_chunks, dedupe_deals
from fetch_company_filings import dedupe_filings
from fetch_corporate_actions import flatten_actions
from fetch_dhan_data import build_master_map
from fetch_fno_expiry import flatten_expiry_data
from enrich_fno_data import fetch_next_expiry, lookup_expiry, normalized_symbol
from fetch_fno_lot_sizes import clean_lot_size_item
from advanced_metrics_processor import merge_historical_metrics, process_symbol_csv
from standardize_stock_artifact import canonicalize_stock
from nse_delivery import normalize_ohlcv_row, normalize_row
from enrich_delivery_data import apply_delivery_data
from bulk_market_analyzer import analyze_stock, calculate_cagr
from process_market_breadth import generate_analytics
from nse_archive_utils import clean_records
from ohlcv_utils import discard_invalid_ohlcv_rows, discard_weekend_rows, is_nse_cash_session, merge_rows_by_date, nse_calendar_date, read_ohlcv_csv, rows_from_tick_data, write_ohlcv_csv
from pipeline_utils import apply_sma_fields, chunked, load_json, save_json
from run_full_pipeline import env_bool
from edl_pipeline.transforms.events import (
    apply_events_to_master,
    collect_circuit_revision_events,
    collect_deal_events,
    collect_upcoming_nse_action_events,
    collect_surveillance_events,
    collect_upcoming_action_events,
)
from edl_pipeline.transforms.historical_breadth import build_breadth_rows, empty_breadth_arrays
from edl_pipeline.schemas import REQUIRED_FINAL_FIELDS


class TransformTests(unittest.TestCase):
    def test_nse_full_bhavcopy_normalizes_closed_session_ohlcv(self):
        self.assertEqual(normalize_ohlcv_row({
            "SYMBOL": "RELIANCE", " SERIES": " EQ", " DATE1": " 25-Sep-2026",
            " OPEN_PRICE": " 1210.5", " HIGH_PRICE": " 1227.4", " LOW_PRICE": " 1210.5",
            " CLOSE_PRICE": " 1226", " TTL_TRD_QNTY": " 13138735",
        }), {
            "symbol": "RELIANCE", "series": "EQ", "date": "2026-09-25", "open": 1210.5,
            "high": 1227.4, "low": 1210.5, "close": 1226.0, "volume": 13138735.0,
        })

    def test_nse_delivery_adapter_normalizes_full_bhavcopy_row(self):
        row = normalize_row({
            "SYMBOL": "RELIANCE", " SERIES": "EQ", " DATE1": "25-Sep-2026",
            " TTL_TRD_QNTY": 13138735, " DELIV_QTY": 8311348, " DELIV_PER": 63.26,
        })
        self.assertEqual(row, {
            "symbol": "RELIANCE", "series": "EQ", "date": "2026-09-25",
            "traded_quantity": 13138735, "deliverable_quantity": 8311348,
            "delivery_percent": 63.26,
            "source": "NSE daily full bhavcopy and security deliverable data",
        })

    def test_delivery_enrichment_uses_only_the_latest_record_per_symbol(self):
        stocks = [{"Symbol": "RELIANCE"}, {"Symbol": "NO_RECORD"}]
        applied = apply_delivery_data(stocks, [
            {"symbol": "RELIANCE", "date": "2026-09-24", "delivery_percent": 61.28,
             "deliverable_quantity": 8, "traded_quantity": 10, "series": "EQ"},
            {"symbol": "RELIANCE", "date": "2026-09-25", "delivery_percent": 63.26,
             "deliverable_quantity": 9, "traded_quantity": 11, "series": "EQ"},
        ])
        self.assertEqual(applied, 1)
        self.assertEqual(stocks[0]["Delivery %"], 63.26)
        self.assertEqual(stocks[0]["Delivery As Of Date"], "2026-09-25")
        self.assertNotIn("Delivery %", stocks[1])

    def test_standardization_keeps_delivery_fields_and_nulls(self):
        result = canonicalize_stock({"Symbol": "RELIANCE", "Delivery %": 63.26,
                                     "Deliverable Quantity": 8, "Delivery Traded Quantity": 10,
                                     "Delivery As Of Date": "2026-09-25", "Delivery Series": "EQ"})
        self.assertEqual(result["delivery_percent"], 63.26)
        self.assertEqual(result["delivery_as_of_date"], "2026-09-25")
        self.assertEqual(result["delivery_series"], "EQ")

    def test_standardization_preserves_a_canonical_surveillance_snapshot(self):
        stock = {
            "schema_version": "3.0", "symbol": "RELIANCE", "name": "Reliance Industries",
            "as_of_date": "2026-09-30", "surveillance_available": True,
            "surveillance_as_of_date": "2026-09-30", "surveillance_fetched_at": "2026-10-01T00:00:00+00:00",
            "is_asm": True, "asm_stage": "LTASM - I", "is_gsm": False, "gsm_stage": None,
        }
        self.assertEqual(canonicalize_stock(stock), stock)

    def test_build_master_map_filters_missing_ids_and_sorts_symbols(self):
        stocks = [
            {"Sym": "BETA", "Isin": "INB", "DispSym": "Beta Ltd", "Sid": 2, "Ltp": 20, "FnoFlag": 1},
            {"Sym": "ALPHA", "Isin": "INA", "DispSym": "Alpha Ltd", "Sid": 1, "Ltp": 10},
            {"Sym": "NOISIN", "DispSym": "No ISIN"},
            {"Sym": "NOSID", "Isin": "INC", "Ltp": 10},
            {"Sym": "NOPRICE", "Isin": "IND", "Sid": 3, "Ltp": 0},
        ]

        self.assertEqual(
            build_master_map(stocks),
            [
                {
                    "Symbol": "ALPHA", "ISIN": "INA", "Name": "Alpha Ltd", "Exchange": "NSE",
                    "Instrument": "EQUITY", "Segment": "E", "Sid": 1, "FnoFlag": 0,
                },
                {
                    "Symbol": "BETA", "ISIN": "INB", "Name": "Beta Ltd", "Exchange": "NSE",
                    "Instrument": "EQUITY", "Segment": "E", "Sid": 2, "FnoFlag": 1,
                },
            ],
        )

    def test_calculate_cagr_avoids_complex_values_for_negative_inputs(self):
        self.assertIsNone(calculate_cagr(-10, 100, 5))
        self.assertIsNone(calculate_cagr(100, -10, 5))
        self.assertAlmostEqual(calculate_cagr(200, 100, 5), 14.8698, places=3)

    def test_analyze_stock_preserves_core_formula_outputs(self):
        item = {
            "Symbol": "ABC",
            "Name": "ABC Ltd",
            "ISIN": "INE000000001",
            "Sid": 123,
            "incomeStat_cq": {
                "YEAR": "Q1|Q0",
                "NET_PROFIT": "10|5|4|3|2",
                "EPS": "2|1|0.5|0.25|1",
                "SALES": "100|80|70|60|50",
                "PROFIT_BEFORE_TAX": "40|20|15|10|8",
                "TAX": "25", "TAX_PAYMENT_ABSOLUTE": "10",
                "OPM": "20|15|10|5|10",
            },
            "incomeStat_cy": {"EPS": "8|6", "SALES": "200|180|160|140|120|100"},
            "TTM_cy": {"OPM": "18", "EPS": "7"},
            "CV": {"INDUSTRY_NAME": "Software", "SECTOR": "IT", "MARKET_CAP": "1000", "STOCK_PE": "20"},
            "roce_roe": {"ROE": "15", "ROCE": "18"},
            "sHp": {"FII": "10|8", "DII": "5|4", "PROMOTER": "40"},
            "bs_c": {"NON_CURRENT_LIABILITIES": "50", "TOTAL_EQUITY": "100"},
        }
        tech = {
            "Ltp": "100",
            "Open": "98",
            "High": "102",
            "Low": "97",
            "Volume": "250000",
            "Mcap": "1100",
            "TotalShares": "100000000",
            "ShareCapital": "100",
            "Exch": "NSE",
            "Inst": "EQUITY",
            "Seg": "E",
            "Sector": "Technology",
            "DaySMA10CurrentCandle": "90",
            "DaySMA20CurrentCandle": "91",
            "DaySMA50CurrentCandle": "92",
            "DaySMA200CurrentCandle": "93",
            "High1Yr": "120",
            "DayRSI14CurrentCandle": "62.5",
            "PPerchange": "1",
            "PricePerchng1week": "2",
            "PricePerchng1mon": "3",
            "PricePerchng3mon": "4",
            "PricePerchng6mon": "4.5",
            "PricePerchng1year": "5",
            "idxlist": [{"Indexid": 13, "Name": "Nifty 50"}, {"Indexid": 999, "Name": "Custom Index"}],
        }
        advanced = {
            "SMA": [{"Indicator": "20-SMA", "Value": "80"}],
            "EMA": [{"Indicator": "200-EMA", "Value": "125"}],
            "TechnicalIndicators": [{"Indicator": "RSI", "Action": "Neutral"}, {"Indicator": "MACD", "Action": "Bullish"}],
            "Pivots": [{"Classic": {"PP": "123.45"}}],
        }

        result = analyze_stock(item, tech, advanced, {"ABC": "2020-01-01"})

        self.assertEqual(result["QoQ % Net Profit Latest"], 100.0)
        self.assertEqual(result["YoY % Net Profit Latest"], 400.0)
        self.assertEqual(result["QoQ % PBT Latest"], 100.0)
        self.assertAlmostEqual(result["Sales Growth 5 Years(%)"], 14.87, places=2)
        self.assertIsNone(result["D/E"])
        self.assertEqual(result["Profit Before Tax(in Lakhs)"], 4000)
        self.assertEqual(result["Total Tax Expenses(in Lakhs)"], 1000)
        self.assertEqual(result["PEG"], 0.2)
        self.assertEqual(result["Forward P/E"], 17.5)
        self.assertEqual(result["Free Float(%)"], 60.0)
        self.assertEqual(result["Float Shares(Cr.)"], 6.0)
        self.assertEqual(result["listing_board"], "UNKNOWN")
        self.assertIsNone(result["is_sme"])

        mainboard = analyze_stock(item, tech, advanced, {"ABC": "2020-01-01"}, {})
        self.assertEqual(mainboard["listing_board"], "MAINBOARD")
        self.assertFalse(mainboard["is_sme"])

        sme = analyze_stock(item, tech, advanced, {"ABC": "2020-01-01"}, {"ABC": {"Series": "SM"}})
        self.assertEqual(sme["listing_board"], "SME")
        self.assertTrue(sme["is_sme"])
        self.assertEqual(sme["listing_series"], "SM")
        self.assertEqual(result["% from 52W High"], -16.67)
        self.assertEqual(result["Index"], "Custom Index, Nifty 50")
        self.assertEqual(result["Index Memberships"], ["Custom Index", "Nifty 50"])
        self.assertEqual(result["Index Membership As Of"], "current_snapshot")
        self.assertEqual(result["SMA Status"], "SMA 20: Above (25.0%)")
        self.assertEqual(result["EMA Status"], "EMA 200: Below (-20.0%)")
        self.assertEqual(result["Technical Sentiment"], "RSI: Neutral | MACD: Bullish")
        self.assertEqual(result["scanner_schema_version"], "2.0")
        self.assertEqual(result["exchange"], "NSE")
        self.assertEqual(result["shares_outstanding"], 100000000)
        self.assertEqual(result["share_capital"], 100.0)
        self.assertEqual(result["market_cap_crore"], 1100.0)
        self.assertEqual(result["sma10"], 90.0)
        self.assertEqual(result["perf_6m"], 4.5)
        self.assertEqual(result["ISIN"], "INE000000001")
        self.assertEqual(result["Security ID"], 123)

    def test_analyze_stock_does_not_use_standalone_statement(self):
        item = {
            "Symbol": "ABC", "incomeStat_cq": {"YEAR": "201609", "NET_PROFIT": "", "SALES": "", "EPS": ""},
            "incomeStat_sq": {
                "YEAR": "202606|202506", "NET_PROFIT": "12|10|8|7|6", "SALES": "120|100|80|70|60", "EPS": "2|1.8|1.6|1.4|1",
            },
        }
        result = analyze_stock(item, {}, {}, {})
        self.assertEqual(result["Earnings Report Type"], "UNAVAILABLE")
        self.assertEqual(result["Earnings Data Source"], "UNAVAILABLE")
        self.assertEqual(result["Latest Quarter"], "N/A")

    def test_fno_expiry_lookup_prefers_security_id_then_normalized_symbol(self):
        self.assertEqual(normalized_symbol('M&M-EQ'), 'MM')
        self.assertEqual(lookup_expiry({'MM':'2026-10-01'}, {'123':'2026-09-29'}, 'M&M-EQ', 123), '2026-09-29')
        self.assertEqual(lookup_expiry({'MM':'2026-10-01'}, {}, 'M&M-EQ', None), '2026-10-01')

    def test_fno_expiry_builds_security_id_and_symbol_lookup(self):
        response = {'pageProps': {'expiryData': {'data': [{'exps': [{'explst': [
            {'symbolName': 'M&M-EQ', 'underlyingSecID': 123, 'expdate': '2099-01-02'},
            {'symbolName': 'M&M-EQ', 'underlyingSecID': 123, 'expdate': '2099-01-01'},
        ]}]}]}}}
        with mock.patch('enrich_fno_data.get_next_data', return_value=response):
            symbols, security_ids = fetch_next_expiry('build')
        self.assertEqual(symbols['MM'], '2099-01-01')
        self.assertEqual(security_ids['123'], '2099-01-01')

    def test_fno_expiry_security_ids_match_master_symbols_not_contract_names(self):
        """Dhan expiry symbols include the contract month; Sid is the stable key."""
        response = {'pageProps': {'expiryData': {'data': [{'exps': [{'explst': [
            {'symbolName': 'ABB SEP FUT', 'underlyingSecID': 13, 'expdate': '2099-09-29'},
        ]}]}]}}}
        with mock.patch('enrich_fno_data.get_next_data', return_value=response):
            _, security_ids = fetch_next_expiry('build')
        # The master universe calls it ABB; only its Dhan security ID connects
        # it to the expiry contract labelled "ABB SEP FUT".
        self.assertEqual(lookup_expiry({}, security_ids, 'ABB', 13), '2099-09-29')

    def test_fno_enrichment_resolves_sid_from_master_before_standardization(self):
        """Base analysis has no Sid, while expiry contracts only share Sid."""
        response = {'pageProps': {'expiryData': {'data': [{'exps': [{'explst': [
            {'symbolName': 'ABB SEP FUT', 'underlyingSecID': 13, 'expdate': '2099-09-29'},
        ]}]}]}}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            master = root / 'analysis.json'
            isin_map = root / 'master.json'
            save_json(master, [{'Symbol': 'ABB'}])
            save_json(isin_map, [{'Symbol': 'ABB', 'Sid': 13, 'FnoFlag': 1}])
            with mock.patch.object(enrich_fno_data, 'MASTER_JSON', str(master)), \
                 mock.patch.object(enrich_fno_data, 'MASTER_ISIN', str(isin_map)), \
                 mock.patch.object(enrich_fno_data, 'get_build_id', return_value='build'), \
                 mock.patch.object(enrich_fno_data, 'get_next_data', return_value=response):
                self.assertTrue(enrich_fno_data.main())
            self.assertEqual(load_json(master)[0]['Next Expiry'], '2099-09-29')

    def test_historical_metrics_do_not_replace_live_scanner_values(self):
        stock = {"rupee_volume": 1000.0, "sma10": 101.0, "sma20": 102.0, "sma50": 103.0, "sma200": 104.0}
        merge_historical_metrics(stock, {
            "rupee_volume": 10.0,
            "sma10": 11.0,
            "sma20": 12.0,
            "sma50": 13.0,
            "sma200": 14.0,
            "avg_rupee_volume_20": 500.0,
        })

        self.assertEqual(stock["rupee_volume"], 1000.0)
        self.assertEqual([stock[f"sma{period}"] for period in (10, 20, 50, 200)], [101.0, 102.0, 103.0, 104.0])
        self.assertEqual(stock["avg_rupee_volume_20"], 500.0)

    def test_sma_signals_follow_published_live_values(self):
        stock = {
            "close": 100.0,
            "sma10": 110.0,
            "sma20": 90.0,
            "sma50": 80.0,
            "sma200": 100.0,
            "close_above_sma20": False,
            "distance_from_sma20_percent": -11.11,
        }

        apply_sma_fields(stock)

        self.assertTrue(stock["close_above_sma20"])
        self.assertTrue(stock["close_above_sma50"])
        self.assertFalse(stock["close_above_sma200"])
        self.assertAlmostEqual(stock["distance_from_sma20_percent"], 11.11, places=2)
        self.assertTrue(stock["sma20_above_sma50"])

    def test_ohlcv_scanner_metrics_include_normalized_values_and_signals(self):
        pandas = __import__("pandas")
        rows = []
        start = pandas.Timestamp("2025-01-01")
        for index in range(253):
            close = 100 + index
            rows.append({
                "Date": (start + pandas.Timedelta(days=index)).strftime("%Y-%m-%d"),
                "Open": close - 1,
                "High": close + 1,
                "Low": close - 2,
                "Close": close,
                "Volume": 1_000 + index,
            })
        rows[-1].update({"Open": 350, "High": 362, "Low": 349, "Close": 360, "Volume": 5_000})

        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "ABC.csv"
            pandas.DataFrame(rows).to_csv(csv_path, index=False)
            symbol, metrics = process_symbol_csv(csv_path)

        self.assertEqual(symbol, "ABC")
        self.assertAlmostEqual(metrics["sma200"], 252.54, places=2)
        self.assertIsNotNone(metrics["atr14"])
        frame = pandas.DataFrame(rows)
        close_adr = ((frame.High - frame.Low) / frame.Close * 100).tail(20).mean()
        low_adr = ((frame.High - frame.Low) / frame.Low * 100).tail(20).mean()
        self.assertAlmostEqual(metrics["adr_percent_20"], round(close_adr, 2))
        self.assertAlmostEqual(metrics["adr_percent_low_20"], round(low_adr, 2))
        self.assertEqual(metrics["adr_denominator"], "CLOSE")
        self.assertEqual(metrics["legacy_adr_denominator"], "LOW")
        self.assertGreater(metrics["avg_volume_20"], 0)
        self.assertTrue(metrics["close_above_sma20"])
        self.assertTrue(metrics["breakout_above_20d_high"])
        self.assertTrue(metrics["breakout_above_52w_high"])
        self.assertGreater(metrics["distance_from_sma20_percent"], 0)
        self.assertIn("sma50_crossed_above_sma200_today", metrics)

    def test_ohlcv_metrics_ignore_copied_non_trading_snapshot(self):
        pandas = __import__("pandas")
        rows = []
        start = pandas.Timestamp("2025-01-01")
        for index in range(253):
            close = 100 + index
            rows.append({
                "Date": (start + pandas.Timedelta(days=index)).strftime("%Y-%m-%d"),
                "Open": close - 1,
                "High": close + 1,
                "Low": close - 2,
                "Close": close,
                "Volume": 1_000 + index,
            })
        rows[-1].update({"Open": 350, "High": 362, "Low": 349, "Close": 360, "Volume": 5_000})
        copied = dict(rows[-1])
        copied["Date"] = "2025-09-13"  # Saturday
        rows.append(copied)

        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "ABC.csv"
            pandas.DataFrame(rows).to_csv(csv_path, index=False)
            _, metrics = process_symbol_csv(csv_path)

        self.assertEqual(metrics["as_of_date"], rows[-2]["Date"])
        self.assertTrue(metrics["breakout_above_20d_high"])

    def test_dedupe_filings_prefers_record_with_file_url(self):
        filings = [
            {"news_id": "1", "news_date": "2026-01-01", "caption": "Result"},
            {"news_id": "1", "news_date": "2026-01-01", "caption": "Result", "file_url": "https://example.com/a.pdf"},
            {"news_date": "2026-01-02", "caption": "Board Meeting"},
        ]

        result = dedupe_filings(filings)

        self.assertEqual(len(result), 2)
        self.assertEqual(result[1]["file_url"], "https://example.com/a.pdf")

    def test_dedupe_deals_uses_existing_composite_key(self):
        deal = {"sym": "ABC", "date": "2026-01-01", "qty": 100, "avgprice": 12.3, "bs": "B", "cname": "Buyer"}
        duplicate = dict(deal)
        later = {"sym": "XYZ", "date": "2026-01-02", "qty": 50, "avgprice": 9, "bs": "S", "cname": "Seller"}

        self.assertEqual([d["sym"] for d in dedupe_deals([deal, duplicate, later])], ["XYZ", "ABC"])

    def test_flatten_actions_filters_to_date_window(self):
        raw = [{
            "Sym": "ABC",
            "DispSym": "ABC Ltd",
            "CorpAct": [
                {"ExDate": "2026-01-02", "ActType": "DIVIDEND", "RecDate": "2026-01-03", "Note": "Rs 1"},
                {"ExDate": "2026-02-01", "ActType": "SPLIT"},
            ],
        }]

        self.assertEqual(
            flatten_actions(raw, "2026-01-01", "2026-01-31"),
            [{
                "Symbol": "ABC",
                "Name": "ABC Ltd",
                "Type": "DIVIDEND",
                "ExDate": "2026-01-02",
                "RecordDate": "2026-01-03",
                "Details": "Rs 1",
            }],
        )

    def test_fno_lot_and_expiry_flatteners_preserve_output_schema(self):
        lot_item = {"sym": "ABC", "disp": "ABC Ltd", "fo_dt": [{"sym": "ABC-JUL", "ls": 75}]}
        expiry_raw = [{
            "exch": "NSE",
            "seg": "D",
            "exps": [{"inst": "FUT", "explst": [{"symbolName": "ABC", "expdate": "2026-07-30", "underlyingSecID": 123}]}],
        }]

        self.assertEqual(clean_lot_size_item(lot_item), {"Symbol": "ABC", "Name": "ABC Ltd", "Lot_JUL": 75})
        self.assertEqual(
            flatten_expiry_data(expiry_raw),
            [{
                "Exchange": "NSE",
                "Segment": "D",
                "InstrumentType": "FUT",
                "SymbolName": "ABC",
                "ExpiryDate": "2026-07-30",
                "UnderlyingSecID": 123,
            }],
        )

    def test_ohlcv_rows_merge_and_csv_round_trip(self):
        rows = rows_from_tick_data({
            "Time": ["2026-01-01", "2026-01-02"],
            "o": [1, 2],
            "h": [2, 3],
            "l": [0.5, 1.5],
            "c": [1.5, 2.5],
            "v": [100, 200],
        })

        self.assertEqual(rows[0]["Close"], 1.5)
        self.assertEqual(merge_rows_by_date([rows[1], rows[0], {**rows[1], "Close": 9}])[1]["Close"], 9)

        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "ABC.csv"
            write_ohlcv_csv(csv_path, rows)
            self.assertEqual(read_ohlcv_csv(csv_path)[0]["Date"], "2026-01-01")

    def test_live_snapshot_is_only_used_during_nse_cash_hours(self):
        kolkata = ZoneInfo("Asia/Kolkata")
        self.assertTrue(is_nse_cash_session(datetime(2026, 9, 25, 10, 0, tzinfo=kolkata)))
        self.assertFalse(is_nse_cash_session(datetime(2026, 9, 25, 16, 0, tzinfo=kolkata)))
        self.assertFalse(is_nse_cash_session(datetime(2026, 9, 26, 10, 0, tzinfo=kolkata)))
        self.assertEqual(nse_calendar_date(datetime(2026, 9, 25, 20, 0, tzinfo=timezone.utc)), "2026-09-26")

    def test_ohlcv_repair_removes_only_weekend_rows(self):
        rows = [
            {"Date": "2026-09-25", "Close": 100},
            {"Date": "2026-09-26", "Close": 100},
            {"Date": "2026-09-27", "Close": 100},
        ]
        self.assertEqual([row["Date"] for row in discard_weekend_rows(rows)], ["2026-09-25"])

    def test_ohlcv_repair_discards_malformed_provider_bars(self):
        rows = [
            {"Date": "2026-09-25", "Open": 100, "High": 105, "Low": 99, "Close": 103, "Volume": 10},
            {"Date": "2026-09-26", "Open": 100, "High": 95, "Low": 99, "Close": 98, "Volume": 10},
            {"Date": "2026-09-27", "Open": "NaN", "High": 105, "Low": 99, "Close": 103, "Volume": 10},
        ]
        self.assertEqual([row["Date"] for row in discard_invalid_ohlcv_rows(rows)], ["2026-09-25"])

    def test_shared_json_and_chunk_helpers(self):
        self.assertEqual(list(chunked([1, 2, 3], 2)), [(0, [1, 2]), (2, [3])])

        with tempfile.TemporaryDirectory() as tmp:
            json_path = Path(tmp) / "sample.json"
            save_json(json_path, {"a": 1})
            self.assertEqual(load_json(json_path), {"a": 1})

    def test_clean_records_strips_csv_keys_and_values(self):
        pandas = __import__("pandas")
        df = pandas.DataFrame([{" Symbol ": " ABC ", "Band": " 20 "}])
        self.assertEqual(clean_records(df), [{"Symbol": "ABC", "Band": "20"}])

    def test_env_bool_preserves_defaults_and_parses_common_values(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertTrue(env_bool("MISSING", True))
            self.assertFalse(env_bool("MISSING", False))

        truthy = ["1", "true", "YES", "on"]
        falsy = ["0", "false", "NO", "off"]
        for value in truthy:
            with mock.patch.dict("os.environ", {"FLAG": value}, clear=True):
                self.assertTrue(env_bool("FLAG", False))
        for value in falsy:
            with mock.patch.dict("os.environ", {"FLAG": value}, clear=True):
                self.assertFalse(env_bool("FLAG", True))

        with mock.patch.dict("os.environ", {"FLAG": "not-a-bool"}, clear=True):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertTrue(env_bool("FLAG", True))

    def test_event_transform_helpers_preserve_marker_contract(self):
        today = __import__("datetime").datetime(2026, 1, 10)

        merged = {}
        for event_map in [
            collect_surveillance_events([{"Symbol": "ABC", "Stage": "LTASM - I"}]),
            collect_upcoming_action_events(
                [{"Symbol": "ABC", "Type": "DIVIDEND", "ExDate": "2026-01-20"}],
                today=today,
            ),
            collect_upcoming_nse_action_events({"actions": [{
                "symbol": "ABC", "categories": ["bonus"], "exDate": "2026-01-21",
            }]}, today=today),
            collect_circuit_revision_events([{"Symbol": "ABC", "From": "10", "To": "20"}]),
            collect_deal_events([{"sym": "ABC", "deal": "BULK", "date": "2026-01-08 00:00:00"}], today=today),
        ]:
            for symbol, events in event_map.items():
                merged.setdefault(symbol, []).extend(events)

        master = [{"Symbol": "ABC"}, {"Symbol": "XYZ"}]
        result = apply_events_to_master(master, merged, {"ABC": [{"Headline": "Result"}]}, {"ABC": [{"Title": "News"}]})

        self.assertIn("★: LTASM", result[0]["Event Markers"])
        self.assertIn("💸: Dividend (20-Jan)", result[0]["Event Markers"])
        self.assertIn("🎁: Bonus (21-Jan)", result[0]["Event Markers"])
        self.assertEqual(result[0]["Recent Announcements"], [{"Headline": "Result"}])
        self.assertEqual(result[0]["News Feed"], [{"Title": "News"}])
        self.assertEqual(result[1]["Event Markers"], "N/A")

    def test_current_gzip_artifact_is_readable(self):
        artifact = ROOT / "all_stocks_fundamental_analysis.json.gz"
        self.assertTrue(artifact.exists())

        with gzip.open(artifact, "rt") as f:
            rows = json.load(f)

        self.assertGreater(len(rows), 0)
        self.assertIn("symbol", rows[0])
        self.assertEqual(rows[0]["schema_version"], "3.0")

    def test_canonicalizer_publishes_scanner_schema_without_rs_fields(self):
        result = canonicalize_stock({
            "Symbol": "ABC",
            "Name": "ABC Ltd",
            "Sector": "Technology",
            "Basic Industry": "Software",
            "Market Cap(Cr.)": 1000,
            "Stock Price(₹)": 100,
            "RS Rating": 99,
            "Event Markers": "★: LTASM | 📦: Block Deal",
            "Recent Announcements": [{"Date": "2026-01-01", "Headline": "Result"}],
            "News Feed": [{"Title": "News", "Sentiment": "positive"}],
        })

        self.assertEqual(result["schema_version"], "3.0")
        self.assertEqual(result["symbol"], "ABC")
        self.assertEqual(result["market_cap_crore"], 1000)
        self.assertEqual(result["close"], 100)
        self.assertEqual(result["event_markers"], ["★: LTASM", "📦: Block Deal"])
        self.assertTrue(result["default_screener_eligible"])
        self.assertEqual(result["recent_announcements"][0]["headline"], "Result")
        self.assertNotIn("rs_rating", result)
        for field in REQUIRED_FINAL_FIELDS:
            self.assertIn(field, result)

        sme_result = canonicalize_stock({"Symbol": "SME", "Name": "SME Ltd", "is_sme": True})
        self.assertFalse(sme_result["default_screener_eligible"])

    def test_canonicalizer_keeps_sma_flags_consistent_with_published_values(self):
        result = canonicalize_stock({"Symbol": "ABC", "close": 100, "sma20": 90, "sma50": 110})

        self.assertTrue(result["close_above_sma20"])
        self.assertFalse(result["close_above_sma50"])
        self.assertAlmostEqual(result["distance_from_sma20_percent"], 11.11, places=2)
        self.assertFalse(result["sma20_above_sma50"])

    def test_sector_analytics_use_ma_breadth_without_rs_fields(self):
        analytics = generate_analytics([
            {
                "Symbol": "ABC", "Sector": "Technology", "Basic Industry": "Software",
                "close": 120, "sma20": 100, "sma50": 110, "sma200": 130,
                "% from 52W High": -2,
            },
            {
                "Symbol": "XYZ", "Sector": "Technology", "Basic Industry": "Hardware",
                "close": 90, "sma20": 100, "sma50": 100, "sma200": 100,
                "% from 52W High": -10,
            },
        ])

        self.assertEqual(analytics["sectors"][0]["above_sma20_percent"], 50.0)
        self.assertEqual(analytics["sectors"][0]["near_52w_high_2_percent"], 50.0)
        self.assertFalse(any("rs" in key.lower() for key in analytics["sectors"][0]))

    def test_sector_analytics_support_legacy_intermediate_columns(self):
        analytics = generate_analytics([{
            "Symbol": "ABC", "Sector": "Technology", "Basic Industry": "Software",
            "Stock Price(₹)": 120,
            "SMA Status": "SMA 20: Above (1%) | SMA 50: Below (-1%) | SMA 200: Above (2%)",
            "% from 52W High": -1,
        }])

        sector = analytics["sectors"][0]
        self.assertEqual(sector["above_sma20_percent"], 100.0)
        self.assertEqual(sector["above_sma50_percent"], 0.0)

    def test_historical_breadth_rows_preserve_legacy_labels(self):
        timeline = ["2026-01-01", "2026-01-02"]
        arrays = empty_breadth_arrays(len(timeline))
        arrays["advances"][0] = 2
        arrays["declines"][0] = 1
        rows = build_breadth_rows(timeline, arrays, {"Nifty 50": [100, 101]}, processed_count=2)

        self.assertEqual(rows[0], "Type of Info,2026-01-01,2026-01-02")
        self.assertIn("5 Day Ratio,2.0,2.0", rows)
        self.assertIn("Nifty 500 % of W&M RSI > 60,,", rows)
        self.assertEqual(rows[-1], "Nifty 50,100,101")


if __name__ == "__main__":
    unittest.main()
