"""Artifact validation helpers used by the runner and tests."""

from dataclasses import asdict, dataclass
import csv
import gzip
import json
import math
from pathlib import Path

from pipeline_utils import resolve_path
from json_records import object_members


@dataclass(frozen=True)
class ArtifactSpec:
    path: str
    kind: str
    min_count: int = 1
    required_fields: tuple = ()
    nested_min_counts: tuple = ()


@dataclass
class ArtifactCheck:
    path: str
    kind: str
    ok: bool
    message: str = ""
    size_bytes: int = 0
    count: int = 0

    def to_dict(self):
        # Reports are portable release records. Do not expose an absolute
        # runner workspace path, which is environment-specific and can leak a
        # repository directory name into published artifacts.
        data = asdict(self)
        data["path"] = Path(self.path).name
        return data


def _missing(path, kind):
    return ArtifactCheck(str(path), kind, False, "missing")


def _bad(path, kind, message, size=0, count=0):
    return ArtifactCheck(str(path), kind, False, message, size, count)


def _good(path, kind, message="ok", size=0, count=0):
    return ArtifactCheck(str(path), kind, True, message, size, count)


def _check_required_fields(rows, required_fields):
    if not required_fields:
        return ""
    if isinstance(rows, list):
        if not rows:
            return "empty list has no fields"
        for index, sample in enumerate(rows):
            error = _check_required_fields(sample, required_fields)
            if error:
                return f"row {index}: {error}"
        return ""
    elif isinstance(rows, dict):
        sample = rows
    else:
        return "unsupported JSON shape for required field check"
    missing = [field for field in required_fields if field not in sample]
    return f"missing fields: {', '.join(missing)}" if missing else ""


def _check_nested_min_counts(data, nested_min_counts):
    if not nested_min_counts:
        return ""
    if not isinstance(data, dict):
        return "nested count checks require a JSON object"
    for field, minimum in nested_min_counts:
        value = data.get(field)
        if not isinstance(value, (list, dict)):
            return f"field {field} is not a collection"
        count = len(value)
        if count < minimum:
            return f"field {field} count {count} < {minimum}"
    return ""


def strict_json_decoder():
    def reject(value):
        raise ValueError(f"non-finite number: {value}")

    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            reject(value)
        return number

    return json.JSONDecoder(parse_constant=reject, parse_float=finite_float)


def strict_json_load(handle):
    decoder = strict_json_decoder()
    return json.load(handle, parse_constant=decoder.parse_constant, parse_float=decoder.parse_float)


def validate_json(path, min_count=1, required_fields=(), nested_min_counts=()):
    resolved = resolve_path(path)
    if not resolved.exists():
        return _missing(resolved, "json")
    size = resolved.stat().st_size
    if size <= 0:
        return _bad(resolved, "json", "empty file", size)
    try:
        with resolved.open("r", encoding="utf-8") as f:
            prefix = f.read(4096) if resolved.name == 'filing_history.json' else ''
            f.seek(0)
            if resolved.name == 'filing_history.json' and prefix.lstrip().startswith('{'):
                data = {}
                record_count = 0
                for key, value, is_record in object_members(f, strict_json_decoder()):
                    if is_record:
                        record_count += 1
                    else:
                        data[key] = value
                        if key == 'records':
                            record_count = len(value) if isinstance(value, (list, dict)) else 0
                # Only counts are needed here; every record has already passed
                # the same strict JSON decoder as the full-file validator.
                nested_min_counts = tuple((key, minimum) for key, minimum in nested_min_counts)
                for key, minimum in nested_min_counts:
                    if key == 'records' and isinstance(data.get(key), list) and record_count < minimum:
                        return _bad(resolved, 'json', f'field records count {record_count} < {minimum}', size, len(data))
                nested_min_counts = tuple((key, minimum) for key, minimum in nested_min_counts if key != 'records' or not isinstance(data.get(key), list))
            else:
                data = strict_json_load(f)
    except Exception as e:
        return _bad(resolved, "json", f"invalid JSON: {e}", size)

    count = len(data) if isinstance(data, (list, dict)) else 0
    if count < min_count:
        return _bad(resolved, "json", f"count {count} < {min_count}", size, count)
    field_error = _check_required_fields(data, required_fields)
    if field_error:
        return _bad(resolved, "json", field_error, size, count)
    nested_count_error = _check_nested_min_counts(data, nested_min_counts)
    if nested_count_error:
        return _bad(resolved, "json", nested_count_error, size, count)
    return _good(resolved, "json", size=size, count=count)


def validate_gzip_json(path, min_count=1, required_fields=(), nested_min_counts=()):
    resolved = resolve_path(path)
    if not resolved.exists():
        return _missing(resolved, "gzip_json")
    size = resolved.stat().st_size
    if size <= 0:
        return _bad(resolved, "gzip_json", "empty file", size)
    try:
        with gzip.open(resolved, "rt", encoding="utf-8") as f:
            data = strict_json_load(f)
    except Exception as e:
        return _bad(resolved, "gzip_json", f"invalid gzip JSON: {e}", size)

    count = len(data) if isinstance(data, (list, dict)) else 0
    if count < min_count:
        return _bad(resolved, "gzip_json", f"count {count} < {min_count}", size, count)
    field_error = _check_required_fields(data, required_fields)
    if field_error:
        return _bad(resolved, "gzip_json", field_error, size, count)
    nested_count_error = _check_nested_min_counts(data, nested_min_counts)
    if nested_count_error:
        return _bad(resolved, "gzip_json", nested_count_error, size, count)
    return _good(resolved, "gzip_json", size=size, count=count)


def validate_csv(path, min_count=1):
    resolved = resolve_path(path)
    if not resolved.exists():
        return _missing(resolved, "csv")
    size = resolved.stat().st_size
    if size <= 0:
        return _bad(resolved, "csv", "empty file", size)
    try:
        with resolved.open("r", encoding="utf-8") as f:
            rows = list(csv.reader(f))
    except Exception as e:
        return _bad(resolved, "csv", f"invalid CSV: {e}", size)
    count = len(rows)
    if count < min_count:
        return _bad(resolved, "csv", f"rows {count} < {min_count}", size, count)
    return _good(resolved, "csv", size=size, count=count)


def validate_gzip_csv(path, min_count=1):
    resolved = resolve_path(path)
    if not resolved.exists():
        return _missing(resolved, "gzip_csv")
    size = resolved.stat().st_size
    if size <= 0:
        return _bad(resolved, "gzip_csv", "empty file", size)
    try:
        with gzip.open(resolved, "rt", encoding="utf-8") as f:
            rows = list(csv.reader(f))
    except Exception as e:
        return _bad(resolved, "gzip_csv", f"invalid gzip CSV: {e}", size)
    count = len(rows)
    if count < min_count:
        return _bad(resolved, "gzip_csv", f"rows {count} < {min_count}", size, count)
    return _good(resolved, "gzip_csv", size=size, count=count)


def validate_dir(path, min_count=1):
    resolved = resolve_path(path)
    if not resolved.exists():
        return _missing(resolved, "dir")
    if not resolved.is_dir():
        return _bad(resolved, "dir", "not a directory")
    count = sum(1 for item in resolved.iterdir() if item.is_file())
    if count < min_count:
        return _bad(resolved, "dir", f"files {count} < {min_count}", count=count)
    return _good(resolved, "dir", count=count)


def validate_file(path, min_count=1):
    resolved = resolve_path(path)
    if not resolved.exists():
        return _missing(resolved, "file")
    size = resolved.stat().st_size
    if size < min_count:
        return _bad(resolved, "file", f"size {size} < {min_count}", size)
    return _good(resolved, "file", size=size, count=1)


def validate_artifact(spec):
    if spec.kind == "json":
        return validate_json(
            spec.path,
            spec.min_count,
            spec.required_fields,
            spec.nested_min_counts,
        )
    if spec.kind == "gzip_json":
        return validate_gzip_json(
            spec.path,
            spec.min_count,
            spec.required_fields,
            spec.nested_min_counts,
        )
    if spec.kind == "csv":
        return validate_csv(spec.path, spec.min_count)
    if spec.kind == "gzip_csv":
        return validate_gzip_csv(spec.path, spec.min_count)
    if spec.kind == "dir":
        return validate_dir(spec.path, spec.min_count)
    if spec.kind == "file":
        return validate_file(spec.path, spec.min_count)
    return ArtifactCheck(spec.path, spec.kind, False, f"unknown kind: {spec.kind}")


def validate_many(specs):
    return [validate_artifact(spec) for spec in specs]
