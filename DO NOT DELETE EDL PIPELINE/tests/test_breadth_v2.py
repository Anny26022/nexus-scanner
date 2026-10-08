import contextlib
import io
import math
import json
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edl_pipeline.breadth.aggregates import BreadthAccumulator
from edl_pipeline.breadth.gates import gate_metrics
from edl_pipeline.breadth.pipeline import _metadata_by_symbol
from edl_pipeline.breadth.config import BreadthMethodology, load_methodology
from edl_pipeline.breadth.indicators import prepare_history
from edl_pipeline.breadth.indices import (
    generate_all_index_history,
    safe_index_symbol,
)
from edl_pipeline.breadth.mbi import enrich_records
from edl_pipeline.breadth.pipeline import generate_market_breadth, load_index_closes
from edl_pipeline.breadth.universe import build_universe_snapshot
import process_mbi_market_breadth
from process_mbi_market_breadth import history_coverage


def make_ohlcv(closes, start="2024-01-01"):
    dates = pd.bdate_range(start, periods=len(closes))
    return pd.DataFrame({
        "Date": dates.strftime("%Y-%m-%d"),
        "Open": closes,
        "High": [value + 1 for value in closes],
        "Low": [value - 1 for value in closes],
        "Close": closes,
        "Volume": [1000 + index for index in range(len(closes))],
    })


def blank_aggregate(date):
    row = {
        "date": date,
        "eligible_with_candle": 10,
        "valid_return": 10,
        "advances": 6,
        "declines": 4,
        "unchanged": 0,
        "up_4": 4,
        "down_4": 2,
        "up_4_5": 3,
        "down_4_5": 1,
        "valid_monthly_extrema": 10,
        "new_monthly_high": 3,
        "new_monthly_low": 1,
        "valid_quarterly_extrema": 10,
        "new_quarterly_high": 2,
        "new_quarterly_low": 1,
        "valid_yearly_extrema": 10,
        "new_52w_high": 3,
        "new_52w_low": 1,
        "valid_volume_20": 10,
        "volume_above_20": 6,
        "volume_below_or_equal_20": 4,
        "valid_return_21": 10,
        "up_25_month": 1,
        "down_25_month": 0,
        "up_50_month": 0,
        "down_50_month": 0,
        "valid_return_34": 10,
        "up_13_34d": 2,
        "down_13_34d": 1,
        "valid_return_63": 10,
        "up_25_quarter": 2,
        "down_25_quarter": 1,
    }
    for ma_type in ("sma", "ema"):
        for period in (10, 20, 50, 200):
            row[f"valid_{ma_type}_{period}"] = 10
            row[f"above_{ma_type}_{period}"] = 6
            row[f"below_{ma_type}_{period}"] = 4
            row[f"equal_{ma_type}_{period}"] = 0
    return row


class BreadthV2Tests(unittest.TestCase):
    def test_bounded_contributions_match_full_history_tail_without_changing_counts(self):
        method = BreadthMethodology()
        full = BreadthAccumulator(replace(method, output_sessions=10000), include_contributions=True)
        bounded = BreadthAccumulator(replace(method, output_sessions=10), include_contributions=True)
        for symbol, start, count in [('A', '2023-01-01', 320), ('B', '2024-01-01', 100), ('C', '2022-01-01', 40), ('D', '2023-12-01', 130)]:
            history = prepare_history(make_ohlcv([100 + (i % 13) for i in range(count)], start), method)
            full.update(history, symbol)
            bounded.update(history, symbol)
        self.assertEqual(bounded.records(), full.records())
        self.assertEqual(bounded.contribution_records(), full.contribution_records()[-10:])
        self.assertEqual(len(bounded._contributions), 10)

    def test_symbol_less_updates_do_not_admit_or_evict_contributions(self):
        method = replace(BreadthMethodology(), output_sessions=2)
        accumulator = BreadthAccumulator(method, include_contributions=True)
        accumulator.update(prepare_history(make_ohlcv([100, 101], '2023-01-01'), method), 'A')
        before = accumulator.contribution_records()
        accumulator.update(prepare_history(make_ohlcv([100, 101, 102], '2024-01-01'), method))
        self.assertEqual(accumulator.contribution_records(), before)
        self.assertEqual(len(accumulator.records()), 5)

    def test_breadth_writers_use_lossless_compact_json(self):
        from edl_pipeline.breadth.indices import _save_json as indices_writer
        from edl_pipeline.breadth.pipeline import _save_json as breadth_writer
        payload = {'name': '₹ index', 'records': [0, None, False, {'value': 1.25}]}
        with tempfile.TemporaryDirectory() as folder:
            for writer in (indices_writer, breadth_writer):
                with self.subTest(writer=writer.__module__):
                    path = Path(folder)/'output.json'
                    writer(path, payload)
                    raw = path.read_text()
                    self.assertNotIn('\n', raw)
                    self.assertEqual(json.loads(raw), payload)

    def setUp(self):
        self.methodology = BreadthMethodology()

    def test_methodology_file_uses_correct_strict_market_cap_threshold(self):
        methodology = load_methodology(ROOT / "breadth_methodology.json")

        self.assertEqual(methodology.minimum_market_cap_crore, 100.0)
        self.assertEqual(methodology.market_cap_comparison, "strictly_greater")
        self.assertEqual(methodology.xp_input_mode, "raw_counts")
        self.assertEqual(methodology.xp_output_multiplier, 0.03136)

    def test_universe_requires_price_at_least_one_and_market_cap_above_100(self):
        rows = [
            {"Sym": "PASS", "Isin": "I1", "Sid": 1, "Ltp": 1, "Mcap": 100.01},
            {"Sym": "EQUAL", "Isin": "I2", "Sid": 2, "Ltp": 1, "Mcap": 100},
            {"Sym": "LOWPRICE", "Isin": "I3", "Sid": 3, "Ltp": 0.99, "Mcap": 5000},
            {"Sym": "NOCAP", "Isin": "I4", "Sid": 4, "Ltp": 10, "Mcap": None},
            {"Sym": "INFINITE", "Isin": "I5", "Sid": 5, "Ltp": math.inf, "Mcap": 5000},
        ]

        snapshot = build_universe_snapshot(rows, self.methodology, "2026-01-01T00:00:00+00:00")

        self.assertEqual([row["symbol"] for row in snapshot["eligible"]], ["PASS"])
        reasons = {row["symbol"]: row["exclusion_reasons"] for row in snapshot["excluded"]}
        self.assertIn("market_cap_not_strictly_greater", reasons["EQUAL"])
        self.assertIn("price_below_minimum", reasons["LOWPRICE"])
        self.assertIn("missing_market_cap", reasons["NOCAP"])
        self.assertIn("missing_price", reasons["INFINITE"])

    def test_indicators_use_prior_window_for_strict_new_high(self):
        closes = [100 + index * 0.1 for index in range(254)]
        prepared = prepare_history(make_ohlcv(closes), self.methodology)

        self.assertTrue(pd.isna(prepared.loc[251, "Yearly_Reference_High"]))
        self.assertFalse(prepared.loc[251, "New_Yearly_High"])
        self.assertTrue(prepared.loc[252, "New_Yearly_High"])
        self.assertAlmostEqual(
            prepared.loc[253, "SMA_200"],
            sum(closes[-200:]) / 200,
        )

    def test_indicators_drop_non_finite_closes(self):
        prepared = prepare_history(
            make_ohlcv([100.0, math.inf, 102.0]),
            self.methodology,
        )

        self.assertEqual(prepared["Close"].tolist(), [100.0, 102.0])
        self.assertTrue(all(math.isfinite(value) for value in prepared["Close"]))

    def test_negative_four_boundary_is_strict(self):
        closes = [100.0, 104.0, 99.84, 95.74656]
        prepared = prepare_history(make_ohlcv(closes), self.methodology)
        accumulator = BreadthAccumulator(self.methodology)
        accumulator.update(prepared)
        records = accumulator.records()

        self.assertEqual(records[1]["up_4"], 1)
        self.assertEqual(records[2]["down_4"], 0)
        self.assertEqual(records[3]["down_4"], 1)

    def test_metric_denominators_do_not_include_insufficient_history(self):
        long_history = prepare_history(make_ohlcv([100 + index for index in range(220)]), self.methodology)
        short_history = prepare_history(make_ohlcv([100 + index for index in range(30)], start="2024-09-23"), self.methodology)
        accumulator = BreadthAccumulator(self.methodology)
        accumulator.update(long_history)
        accumulator.update(short_history)
        latest = accumulator.records()[-1]

        self.assertEqual(latest["eligible_with_candle"], 2)
        self.assertEqual(latest["valid_sma_20"], 2)
        self.assertEqual(latest["valid_sma_200"], 1)

        enriched = enrich_records([latest], self.methodology)[0]
        expected_pct = 100 * latest["above_sma_200"] / latest["valid_sma_200"]
        self.assertAlmostEqual(enriched["above_200_pct"], expected_pct)

    def test_mbi_ratios_changes_scoring_and_xp_are_deterministic(self):
        first = blank_aggregate("2026-01-01")
        second = blank_aggregate("2026-01-02")
        second["up_4"] = 6
        second["down_4"] = 1
        second["up_4_5"] = 6
        second["down_4_5"] = 1
        second["above_sma_20"] = 8
        second["below_sma_20"] = 2
        second["above_sma_50"] = 9
        second["below_sma_50"] = 1

        output = enrich_records(
            [first, second],
            self.methodology,
            {"2026-01-01": 100, "2026-01-02": 102},
        )

        self.assertEqual(output[0]["ratio_4"], 200)
        self.assertEqual(output[1]["ratio_4"], 600)
        self.assertEqual(output[1]["change_4"], 200)
        self.assertEqual(output[1]["ratio_4_5"], 600)
        self.assertEqual(output[1]["change_4_5"], 100)
        self.assertAlmostEqual(output[1]["index_change_pct"], 2)
        self.assertEqual(output[1]["mbi_state"], "green")
        self.assertTrue(math.isfinite(output[0]["xp"]))
        self.assertTrue(math.isfinite(output[1]["xp"]))
        self.assertEqual(output[0]["xp"], output[0]["xp_raw"])
        self.assertAlmostEqual(output[0]["up_4_5_pct"], 30.0)
        self.assertAlmostEqual(output[0]["down_4_5_pct"], 10.0)
        self.assertEqual(output[0]["xp_advancer_count"], 3)
        self.assertEqual(output[0]["xp_decliner_count"], 1)
        self.assertEqual(output[0]["xp_smoothed_advances"], 3)
        self.assertIsNone(output[0]["em"])
        self.assertAlmostEqual(output[0]["new_52w_high_pct"], 30.0)
        self.assertAlmostEqual(output[0]["new_52w_low_pct"], 10.0)
        self.assertAlmostEqual(output[0]["xp"], 10.7142261241, places=6)

    def test_xp_uses_raw_counts_not_universe_percentages(self):
        small_universe = blank_aggregate("2026-01-01")
        large_universe = blank_aggregate("2026-01-01")
        large_universe["eligible_with_candle"] = 100

        small = enrich_records([small_universe], self.methodology)[0]
        large = enrich_records([large_universe], self.methodology)[0]

        self.assertEqual(small["up_4_5_pct"], large["up_4_5_pct"])
        self.assertEqual(small["xp_advancer_count"], large["xp_advancer_count"])
        self.assertEqual(
            small["xp_smoothed_advances"],
            large["xp_smoothed_advances"],
        )

    def test_xp_output_calibration_does_not_feed_back_into_recurrence(self):
        rows = [
            blank_aggregate("2026-01-01"),
            blank_aggregate("2026-01-02"),
        ]
        baseline = enrich_records(rows, self.methodology)
        calibrated = enrich_records(
            rows,
            replace(self.methodology, xp_output_multiplier=0.03136),
        )

        for raw_row, calibrated_row in zip(baseline, calibrated):
            self.assertAlmostEqual(calibrated_row["xp_raw"], raw_row["xp_raw"])
            self.assertAlmostEqual(
                calibrated_row["xp"],
                raw_row["xp_raw"] * 0.03136,
            )

    def test_zero_denominator_ratios_are_null_while_xp_remains_finite(self):
        row = blank_aggregate("2026-01-01")
        row["down_4"] = 0
        row["above_sma_20"] = row["eligible_with_candle"]
        row["above_sma_50"] = row["eligible_with_candle"]

        output = enrich_records([row], self.methodology)[0]

        self.assertIsNone(output["ratio_4"])
        self.assertIsNone(output["ratio_20"])
        self.assertIsNone(output["ratio_50"])
        self.assertTrue(math.isfinite(output["xp"]))

    def test_xp_treats_insufficient_ma_history_as_not_above(self):
        first = blank_aggregate("2026-01-01")
        first["up_4_5"] = 10
        first["valid_sma_10"] = 0
        first["valid_sma_20"] = 0
        first["above_sma_10"] = 0
        first["above_sma_20"] = 0
        second = blank_aggregate("2026-01-02")
        second["up_4_5"] = 0

        output = enrich_records([first, second], self.methodology)

        self.assertTrue(math.isfinite(output[0]["xp"]))
        self.assertIsNone(output[0]["above_10_pct"])
        self.assertIsNone(output[0]["above_20_pct"])
        self.assertEqual(output[0]["xp_smoothed_advances"], 10)
        self.assertAlmostEqual(output[1]["xp_smoothed_advances"], 8.38)
        self.assertTrue(math.isfinite(output[1]["xp"]))

    def test_end_to_end_generator_writes_auditable_artifacts(self):
        universe = [
            {"Sym": "AAA", "DispSym": "AAA Ltd", "Isin": "I1", "Sid": 1, "Ltp": 130, "Mcap": 1500, "Sector": "Technology", "index_memberships": ["NIFTY 50", "NIFTY 500"]},
            {"Sym": "BBB", "DispSym": "BBB Ltd", "Isin": "I2", "Sid": 2, "Ltp": 80, "Mcap": 2000, "Sector": "Financials", "index_memberships": ["NIFTY MIDSMALLCAP 400"]},
            {"Sym": "SMALL", "DispSym": "Small Ltd", "Isin": "I3", "Sid": 3, "Ltp": 50, "Mcap": 100},
        ]
        dates = pd.bdate_range("2024-01-01", periods=270)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ohlcv = root / "ohlcv"
            ohlcv.mkdir()
            make_ohlcv([100 + index * 0.2 for index in range(270)]).to_csv(ohlcv / "AAA.csv", index=False)
            make_ohlcv([200 - index * 0.1 for index in range(270)]).to_csv(ohlcv / "BBB.csv", index=False)
            pd.DataFrame({
                "Date": dates.strftime("%Y-%m-%d"),
                "Close": [1000 + index for index in range(270)],
            }).to_csv(root / "NIFTY.csv", index=False)

            output_path = root / "breadth.json"
            snapshot_path = root / "snapshot.json"
            sector_path = root / "sector.json"
            contributions_path = root / "contributions.json"
            artifact, snapshot = generate_market_breadth(
                universe,
                ohlcv,
                root / "NIFTY.csv",
                self.methodology,
                output_path,
                snapshot_path,
                generated_at="2026-01-01T00:00:00+00:00",
                sector_output_path=sector_path,
                contribution_output_path=contributions_path,
            )

            self.assertEqual(snapshot["eligible_count"], 2)
            self.assertEqual(artifact["quality"]["processed_symbols"], 2)
            self.assertEqual(artifact["quality"]["record_count"], 250)
            self.assertEqual(artifact["records"][-1]["valid_sma_200"], 2)
            self.assertIn("xp", artifact["records"][-1])
            self.assertIn("nifty50", artifact["universes"])
            self.assertTrue(artifact["universes"]["nifty50"]["available"])
            self.assertTrue(artifact["universes"]["nifty500"]["available"])
            self.assertTrue(artifact["universes"]["niftymidsmall400"]["available"])
            self.assertTrue(sector_path.exists())
            sectors = json.loads(sector_path.read_text(encoding="utf-8"))["sectors"]
            self.assertEqual({item["sector"] for item in sectors}, {"Financials", "Technology"})
            self.assertTrue(contributions_path.exists())
            audit = json.loads(contributions_path.read_text(encoding="utf-8"))
            self.assertIn("AAA", audit["universes"]["all_active"]["records"][-1]["metrics"]["eligible_with_candle"])
            self.assertIn("breakout_20d", artifact["records"][-1])
            self.assertIn("advance_volume", artifact["records"][-1])
            expected_table_fields = {
                "date",
                "ratio_4_5",
                "xp",
                "em",
                "change_4_5",
                "ratio_20",
                "change_20",
                "ratio_50",
                "change_50",
                "new_52w_high_pct",
                "new_52w_low_pct",
                "up_4_5_pct",
                "down_4_5_pct",
                "above_10_pct",
                "above_20_pct",
                "above_50_pct",
                "above_200_pct",
                "index_change_pct",
            }
            schema_fields = {column["field"] for column in artifact["table_schema"]}
            self.assertEqual(schema_fields, expected_table_fields)
            self.assertTrue(
                expected_table_fields.issubset(artifact["records"][-1])
            )
            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8"))["methodology"]["version"], "mbi-xp-v2.2")
            self.assertEqual(json.loads(snapshot_path.read_text(encoding="utf-8"))["eligible_count"], 2)

            # String paths must produce the same portable metadata and data.
            string_artifact, string_snapshot = generate_market_breadth(
                universe,
                ohlcv,
                str(root / "NIFTY.csv"),
                self.methodology,
                output_path,
                snapshot_path,
                generated_at="2026-01-01T00:00:00+00:00",
            )
            self.assertEqual(artifact["source"]["index_history"], "NIFTY.csv")
            self.assertEqual(string_artifact, artifact)
            self.assertEqual(string_snapshot, snapshot)

    def test_market_breadth_requires_valid_index_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError):
                load_index_closes(Path(tmp) / "NIFTY.csv")

    def test_history_coverage_rejects_catastrophic_partial_data(self):
        self.assertEqual(history_coverage(1, 100), 0.01)
        self.assertEqual(history_coverage(90, 100), 0.90)
        self.assertEqual(history_coverage(0, 0), 0.0)

    def test_process_stage_fails_below_minimum_history_coverage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ohlcv = root / "ohlcv"
            indices = root / "indices"
            ohlcv.mkdir()
            indices.mkdir()
            required_files = {
                "UNIVERSE_FILE": root / "universe.json",
                "INDEX_FILE": indices / "NIFTY.csv",
                "INDEX_LIST_FILE": root / "indices.json",
                "METHODOLOGY_FILE": root / "methodology.json",
            }
            for path in required_files.values():
                path.write_text("[]", encoding="utf-8")

            patches = [
                mock.patch.object(process_mbi_market_breadth, name, value)
                for name, value in {
                    **required_files,
                    "OHLCV_DIR": ohlcv,
                    "INDICES_DIR": indices,
                    "OUTPUT_FILE": root / "breadth.json",
                    "SNAPSHOT_FILE": root / "snapshot.json",
                    "ALL_INDICES_OUTPUT_FILE": root / "all_indices.json",
                }.items()
            ]
            with contextlib.ExitStack() as stack:
                for patch in patches:
                    stack.enter_context(patch)
                stack.enter_context(
                    mock.patch.object(
                        process_mbi_market_breadth,
                        "load_methodology",
                        return_value=self.methodology,
                    )
                )
                stack.enter_context(
                    mock.patch.object(
                        process_mbi_market_breadth,
                        "load_json",
                        return_value=[],
                    )
                )
                stack.enter_context(
                    mock.patch.object(
                        process_mbi_market_breadth,
                        "generate_market_breadth",
                        return_value=(
                            {
                                "generated_at": "2026-01-01T00:00:00+00:00",
                                "quality": {
                                    "processed_symbols": 1,
                                    "missing_history_count": 99,
                                    "record_count": 1,
                                },
                            },
                            {"eligible_count": 100},
                        ),
                    )
                )
                stack.enter_context(
                    mock.patch.object(
                        process_mbi_market_breadth,
                        "generate_all_index_history",
                        return_value={
                            "quality": {
                                "available_indices": 100,
                                "processed_indices": 100,
                            }
                        },
                    )
                )
                with contextlib.redirect_stdout(io.StringIO()):
                    result = process_mbi_market_breadth.main()

        self.assertEqual(result, 1)

    def test_all_index_history_publishes_every_available_index(self):
        indices = [
            {
                "IndexName": "Nifty 50",
                "Symbol": "NIFTY",
                "IndexID": 13,
                "Exchange": "IDX",
                "Segment": "I",
                "Instrument": "IDX",
                "Ltp": 102,
                "PChng": 0.99,
            },
            {
                "IndexName": "Nifty Midcap",
                "Symbol": "NIFTY MIDCAP",
                "IndexID": 14,
                "Exchange": "IDX",
                "Segment": "I",
                "Instrument": "IDX",
                "Ltp": 202,
                "PChng": 0.5,
            },
            {
                "IndexName": "Missing Index",
                "Symbol": "MISSING",
                "IndexID": 15,
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            index_dir = root / "indices"
            index_dir.mkdir()
            make_ohlcv([100, 101, 102]).to_csv(
                index_dir / "NIFTY.csv",
                index=False,
            )
            make_ohlcv([200, 201, 202]).to_csv(
                index_dir / "NIFTY_MIDCAP.csv",
                index=False,
            )
            output_path = root / "all_indices.json"

            artifact = generate_all_index_history(
                indices,
                index_dir,
                output_path,
                output_sessions=2,
                generated_at="2026-01-01T00:00:00+00:00",
            )

            self.assertEqual(artifact["quality"]["available_indices"], 3)
            self.assertEqual(artifact["quality"]["processed_indices"], 2)
            self.assertEqual(
                artifact["quality"]["missing_history_symbols"],
                ["MISSING"],
            )
            by_symbol = {row["symbol"]: row for row in artifact["indices"]}
            self.assertEqual(set(by_symbol), {"NIFTY", "NIFTY MIDCAP"})
            self.assertEqual(len(by_symbol["NIFTY"]["records"]), 2)
            self.assertAlmostEqual(
                by_symbol["NIFTY"]["records"][-1]["change_pct"],
                100 * (102 / 101 - 1),
                places=6,
            )
            saved = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["quality"]["processed_indices"], 2)

    def test_duplicate_index_symbols_use_index_id_for_distinct_histories(self):
        indices = [
            {"IndexName": "First CAPINS", "Symbol": "CAPINS", "IndexID": 99},
            {"IndexName": "Second CAPINS", "Symbol": "CAPINS", "IndexID": 846},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            index_dir = root / "indices"
            index_dir.mkdir()
            make_ohlcv([100, 101]).to_csv(
                index_dir / "CAPINS__99.csv",
                index=False,
            )
            make_ohlcv([200, 202]).to_csv(
                index_dir / "CAPINS__846.csv",
                index=False,
            )

            artifact = generate_all_index_history(
                indices,
                index_dir,
                root / "all_indices.json",
                output_sessions=2,
            )

            self.assertEqual(artifact["quality"]["processed_indices"], 2)
            closes = {
                row["index_id"]: row["records"][-1]["close"]
                for row in artifact["indices"]
            }
            self.assertEqual(closes, {99: 101, 846: 202})

    def test_breakout_uses_close_and_requires_complete_current_candle(self):
        frame = make_ohlcv([100 + index for index in range(25)])
        frame.loc[24, ["Close", "High", "Low"]] = [120, 140, 119]
        prepared = prepare_history(frame, self.methodology)
        self.assertFalse(prepared.loc[24, "Breakout_20d"])
        incomplete = make_ohlcv([100 + index for index in range(25)])
        incomplete.loc[24, "High"] = math.nan
        prepared = prepare_history(incomplete, self.methodology)
        self.assertTrue(pd.isna(prepared.loc[24, "Prior_20_High"]))

    def test_volume_contributions_and_gate_namespace_are_auditable(self):
        accumulator = BreadthAccumulator(self.methodology, include_contributions=True)
        accumulator.update(prepare_history(make_ohlcv([100, 101]), self.methodology), "TEST")
        first, second = accumulator.records()
        self.assertEqual(first["total_volume"], 1000)
        self.assertIn("TEST", accumulator.contribution_records()[0]["metrics"]["total_volume"])
        self.assertIn("TEST", accumulator.contribution_records()[1]["metrics"]["advance_volume"])
        metrics = gate_metrics({"date": "2026-01-01", "mbi_state": "green", "mbi_cells": {}, "xp": 3.0})
        self.assertEqual(metrics["xp"], 3.0)
        self.assertNotIn("date", metrics)
        self.assertNotIn("mbi_state", metrics)

    def test_metadata_duplicate_selection_matches_highest_market_cap(self):
        metadata = _metadata_by_symbol([
            {"Sym": "TEST", "Mcap": 100, "Sector": "Old", "Index": "NIFTY 50"},
            {"Sym": "TEST", "Mcap": 200, "Sector": "New", "Index": "NIFTY 500"},
        ])
        self.assertEqual(metadata["TEST"]["sector"], "New")
        self.assertEqual(metadata["TEST"]["memberships"], {"NIFTY500"})

    def test_normalized_index_collisions_are_disambiguated_safely(self):
        value = safe_index_symbol("A-B", "../13", disambiguate=True)

        self.assertTrue(value.startswith("A_B__"))
        self.assertTrue(value.endswith("13"))
        self.assertNotIn("/", value)
        self.assertNotIn("\\", value)


if __name__ == "__main__":
    unittest.main()
