"""Historical publication must update pointers only after verified R2 writes."""
from datetime import date
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import backfill_historical_snapshots as backfill


class FakeR2:
    def __init__(self, corrupt=False, fail_on=None):
        self.objects = {"snapshots/2026-09-30.json.gz": b"original legacy snapshot"}
        self.uploaded = []
        self.corrupt, self.fail_on = corrupt, fail_on

    def put_object(self, **request):
        if len(self.uploaded) + 1 == self.fail_on:
            raise OSError("R2 upload failed")
        self.uploaded.append(request["Key"])
        self.objects[request["Key"]] = request["Body"]

    def get_object(self, **request):
        data = self.objects[request["Key"]]
        if self.corrupt:
            data = bytes([data[0] ^ 1]) + data[1:]  # Same length; HEAD-size verification would miss this.
        return {"Body": io.BytesIO(data)}


class HistoricalBackfillTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = self.root / "sessions.json"
        self.manifest.write_text(json.dumps({"version": 1, "sessions": [
            {"date": "2026-09-30", "revision": "a" * 64, "isHistorical": True},
            {"date": "2026-09-29", "revision": "b" * 64, "isHistorical": True},
        ]}))

    def snapshot(self, session="2026-09-30", **overrides):
        stock = {"symbol": "TEST", "rsRating": 99, "setupGeometry": {}, "trendTemplate": {},
                 "stageStatus": {}, "isLiquidScreen": True, "presetRuleMatches": {}}
        payload = {"asOfDate": session, "totalStocks": 1, "stocks": [stock],
                   "screenMethodologyVersion": backfill.generator.SCREEN_METHODOLOGY_VERSION,
                   "presetRuleMatchesVersion": 1, **overrides}
        revision = hashlib.sha256(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        payload["revision"] = revision
        path = self.root / f"{session}.json.gz"
        path.write_bytes(gzip.compress(json.dumps(payload).encode(), mtime=0))
        return path, revision

    def test_updates_existing_date_only_after_r2_content_verification(self):
        path, revision = self.snapshot()
        store = FakeR2()
        backfill.publish_snapshots([path], store, "bucket", self.manifest)
        self.assertEqual(store.uploaded, [f"snapshots/2026-09-30/{revision}.json.gz"])
        self.assertEqual(store.objects["snapshots/2026-09-30.json.gz"], b"original legacy snapshot")
        sessions = {item["date"]: item for item in json.loads(self.manifest.read_text())["sessions"]}
        self.assertEqual(sessions["2026-09-30"]["revision"], revision)
        self.assertEqual(sessions["2026-09-29"]["revision"], "b" * 64)

    def test_failed_or_corrupted_upload_leaves_all_pointers_unchanged(self):
        first, _ = self.snapshot()
        second, _ = self.snapshot("2026-10-01")
        original = self.manifest.read_bytes()
        for store in (FakeR2(corrupt=True), FakeR2(fail_on=2)):
            with self.subTest(store=store), self.assertRaises((ValueError, OSError)):
                backfill.publish_snapshots([first, second], store, "bucket", self.manifest)
            self.assertEqual(self.manifest.read_bytes(), original)

    def test_invalid_batch_is_rejected_before_first_upload(self):
        first, _ = self.snapshot()
        invalid, _ = self.snapshot("2026-10-01", screenMethodologyVersion="old-method")
        store = FakeR2()
        with self.assertRaises(ValueError):
            backfill.publish_snapshots([first, invalid], store, "bucket", self.manifest)
        self.assertEqual(store.uploaded, [])

    def test_bad_revision_and_missing_setup_fields_are_rejected(self):
        path, _ = self.snapshot()
        payload = json.loads(gzip.decompress(path.read_bytes()))
        payload["stocks"][0]["rsRating"] = 1
        path.write_bytes(gzip.compress(json.dumps(payload).encode()))
        with self.assertRaises(ValueError):
            backfill.snapshot_object(path)
        path, _ = self.snapshot(stocks=[{"symbol": "OLD", "rsRating": 80}])
        with self.assertRaises(ValueError):
            backfill.snapshot_object(path)

    def test_cli_recomputes_selected_dates_then_publishes_only_generated_files(self):
        selected, revision = self.snapshot()
        self.snapshot("2026-10-01")  # Leftover output from another run must not be published.
        store = FakeR2()
        args = ["--start-date", "2026-09-30", "--end-date", "2026-09-30", "--upload-r2",
                "--output-dir", str(self.root), "--sessions-manifest", str(self.manifest)]
        with patch.object(backfill, "r2_client", return_value=store), patch.object(
                backfill.generator, "main", return_value=[(date(2026, 9, 30), revision)]) as generate:
            self.assertEqual(backfill.main(args), 0)
        self.assertIn("--start-date", generate.call_args.args[0])
        self.assertNotIn("--update-sessions-manifest", generate.call_args.args[0])
        self.assertEqual(store.uploaded, [f"snapshots/2026-09-30/{revision}.json.gz"])

    def test_dry_run_and_preview_do_not_publish_pointers(self):
        original = self.manifest.read_bytes()
        args = ["--start-date", "2026-09-30", "--end-date", "2026-09-30", "--sessions-manifest", str(self.manifest)]
        with patch.object(backfill, "r2_client") as client, patch.object(backfill.generator, "main", return_value=[]) as generate:
            self.assertEqual(backfill.main([*args, "--dry-run", "--upload-r2"]), 0)
            generate.assert_not_called()
            self.assertEqual(backfill.main(args), 0)
            client.assert_not_called()
        self.assertEqual(self.manifest.read_bytes(), original)

    def test_missing_registered_date_aborts_before_r2_writes(self):
        _, revision = self.snapshot()
        store = FakeR2()
        original = self.manifest.read_bytes()
        with patch.object(backfill, "r2_client", return_value=store), patch.object(
                backfill.generator, "main", return_value=[(date(2026, 9, 30), revision)]):
            with self.assertRaisesRegex(ValueError, "2026-09-29"):
                backfill.main(["--start-date", "2026-09-29", "--end-date", "2026-09-30", "--upload-r2",
                               "--output-dir", str(self.root), "--sessions-manifest", str(self.manifest)])
        self.assertEqual(store.uploaded, [])
        self.assertEqual(self.manifest.read_bytes(), original)

    def test_empty_run_or_bad_range_cannot_publish(self):
        with self.assertRaises(ValueError):
            backfill.publish_snapshots([], FakeR2(), "bucket", self.manifest)
        with self.assertRaises(SystemExit) as error:
            backfill.main(["--start-date", "2026-10-01", "--end-date", "2026-09-30"])
        self.assertEqual(error.exception.code, 2)
