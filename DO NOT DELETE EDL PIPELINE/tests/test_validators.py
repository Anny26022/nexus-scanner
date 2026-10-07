import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edl_pipeline.validators import ArtifactSpec, validate_gzip_csv, validate_json, validate_many
from pipeline_utils import compress_file, load_json, save_json


class ValidatorTests(unittest.TestCase):
    def test_validate_json_checks_count_and_required_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rows.json"
            path.write_text(json.dumps([{"Symbol": "ABC", "Name": "ABC Ltd"}]))

            ok = validate_json(path, min_count=1, required_fields=("Symbol", "Name"))
            missing = validate_json(path, min_count=1, required_fields=("Symbol", "Sector"))

        self.assertTrue(ok.ok)
        self.assertEqual(ok.count, 1)
        self.assertFalse(missing.ok)
        self.assertIn("Sector", missing.message)

    def test_validate_gzip_csv_counts_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "breadth.csv.gz"
            with gzip.open(path, "wt") as f:
                f.write("Date,Stocks\n2026-01-01,10\n")

            check = validate_gzip_csv(path, min_count=2)

        self.assertTrue(check.ok)
        self.assertEqual(check.count, 2)

    def test_validate_json_rejects_empty_nested_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "breadth.json"
            gzip_path = Path(tmp) / "breadth.json.gz"
            payload = {
                "methodology": {},
                "quality": {},
                "records": [],
            }
            path.write_text(json.dumps(payload), encoding="utf-8")
            with gzip.open(gzip_path, "wt", encoding="utf-8") as f:
                json.dump(payload, f)

            checks = validate_many(
                [
                    ArtifactSpec(
                        str(path),
                        "json",
                        required_fields=("methodology", "quality", "records"),
                        nested_min_counts=(("records", 1),),
                    ),
                    ArtifactSpec(
                        str(gzip_path),
                        "gzip_json",
                        required_fields=("methodology", "quality", "records"),
                        nested_min_counts=(("records", 1),),
                    ),
                ]
            )

        self.assertTrue(all(not check.ok for check in checks))
        self.assertTrue(
            all("field records count 0 < 1" in check.message for check in checks)
        )

    def test_validate_many_reports_unknown_kind(self):
        checks = validate_many([ArtifactSpec("x", "unknown")])

        self.assertFalse(checks[0].ok)
        self.assertIn("unknown kind", checks[0].message)

    def test_json_and_gzip_writes_are_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            json_path = Path(tmp) / "sample.json"
            gzip_path = Path(tmp) / "sample.json.gz"
            save_json(json_path, {"a": 1})
            self.assertEqual(json_path.read_text(), '{"a":1}')
            save_json(json_path, {"a": 1}, indent=4)
            self.assertIn('\n', json_path.read_text())
            raw_size, gz_size = compress_file(json_path, gzip_path)

            self.assertEqual(load_json(json_path), {"a": 1})
            with gzip.open(gzip_path, "rt", encoding="utf-8") as f:
                self.assertEqual(json.load(f), {"a": 1})

        self.assertGreater(raw_size, 0)
        self.assertGreater(gz_size, 0)


if __name__ == "__main__":
    unittest.main()
