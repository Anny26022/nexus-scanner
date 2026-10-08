"""
═══════════════════════════════════════════════════
  EDL Pipeline — Shared Utilities
  Centralizes common constants and helpers used
  across all fetch_*.py scripts.
═══════════════════════════════════════════════════
"""

import gzip
import hashlib
import threading
import json
import math
import os
import random
import shutil
import time
from pathlib import Path
from tempfile import NamedTemporaryFile

import requests

_http_local = threading.local()


def http_session():
    """Reuse connections within each fetch thread without sharing mutable sessions."""
    if not hasattr(_http_local, "session"):
        _http_local.session = requests.Session()
    return _http_local.session


def file_fingerprint(path):
    path = Path(path)
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _default_base_path():
    module_dir = Path(__file__).resolve().parent
    cwd = Path.cwd()
    if (cwd / "run_full_pipeline.py").exists() and (cwd / "pipeline_utils.py").exists():
        return cwd
    return module_dir


# ── Base Directory (all scripts live here) ──
BASE_PATH = Path(os.getenv("EDL_BASE_DIR", _default_base_path())).resolve()
BASE_DIR = str(BASE_PATH)
SCANX_FETCH_URL = "https://ow-scanx-analytics.dhan.co/customscan/fetchdt"

# ── User Agents (rotated to avoid detection) ──
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
]


def get_headers(include_origin=False):
    """Return standard API headers with a random User-Agent."""
    h = {
        "Content-Type": "application/json",
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "application/json, text/plain, */*",
    }
    if include_origin:
        h["Origin"] = "https://scanx.dhan.co"
        h["Referer"] = "https://scanx.dhan.co/"
    return h


def resolve_path(path):
    """Resolve a pipeline-relative path to an absolute Path."""
    path = Path(path)
    return path if path.is_absolute() else BASE_PATH / path


def ensure_dir(path):
    """Create a directory if it does not already exist."""
    resolve_path(path).mkdir(parents=True, exist_ok=True)


def load_json(path, default=None):
    """Load JSON from a pipeline-relative path."""
    resolved = resolve_path(path)
    try:
        with resolved.open("r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        if default is not None:
            return default
        raise


def apply_sma_fields(row):
    """Derive canonical SMA flags and distances from published values."""
    values = {}
    for field in ("close", "sma10", "sma20", "sma50", "sma200"):
        try:
            value = float(row.get(field))
            values[field] = value if math.isfinite(value) else None
        except (TypeError, ValueError):
            values[field] = None

    close = values["close"]
    for period in (10, 20, 50, 200):
        sma = values[f"sma{period}"]
        row[f"close_above_sma{period}"] = close > sma if None not in (close, sma) else None
        if period != 10:
            row[f"distance_from_sma{period}_percent"] = (
                round((close - sma) / sma * 100, 2) if close is not None and sma not in (None, 0) else None
            )

    for left, right in ((10, 20), (20, 50), (50, 200)):
        a, b = values[f"sma{left}"], values[f"sma{right}"]
        row[f"sma{left}_above_sma{right}"] = a > b if None not in (a, b) else None
    return row


def atomic_replace_bytes(path, data):
    """Atomically write bytes to a pipeline-relative path."""
    resolved = resolve_path(path)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("wb", delete=False, dir=resolved.parent, prefix=f".{resolved.name}.", suffix=".tmp") as tmp:
        tmp.write(data)
        tmp_path = Path(tmp.name)
    try:
        tmp_path.replace(resolved)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def atomic_replace_text(path, text):
    """Atomically write text to a pipeline-relative path."""
    atomic_replace_bytes(path, text.encode("utf-8"))


def finite_json(data):
    """Preserve missing numeric data as null, including nested provider values."""
    if isinstance(data, float) and not math.isfinite(data):
        return None
    if isinstance(data, dict):
        return {key: finite_json(value) for key, value in data.items()}
    if isinstance(data, (list, tuple)):
        return [finite_json(value) for value in data]
    return data


def save_json(path, data, indent=None, ensure_ascii=True):
    """Write JSON atomically to a pipeline-relative path and create parent dirs."""
    text = json.dumps(finite_json(data), indent=indent, separators=(',', ':') if indent is None else None, ensure_ascii=ensure_ascii, allow_nan=False)
    atomic_replace_text(path, text)


def compress_file(src, dst, compresslevel=9):
    """Atomically gzip one file and return raw/gz byte sizes."""
    src_path = resolve_path(src)
    dst_path = resolve_path(dst)
    if not src_path.exists():
        return 0, 0

    raw_size = src_path.stat().st_size
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("wb", delete=False, dir=dst_path.parent, prefix=f".{dst_path.name}.", suffix=".tmp") as tmp:
        tmp_path = Path(tmp.name)
    try:
        with src_path.open("rb") as f_in, gzip.open(tmp_path, "wb", compresslevel=compresslevel) as f_out:
            shutil.copyfileobj(f_in, f_out, length=1024 * 1024)
        tmp_path.replace(dst_path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise
    return raw_size, dst_path.stat().st_size


def chunked(items, size):
    """Yield fixed-size chunks from a list-like object."""
    for i in range(0, len(items), size):
        yield i, items[i:i + size]


def post_json(url, payload, include_origin=False, timeout=30, retries=2, backoff=0.5):
    """POST JSON with bounded retries and return the decoded response."""
    last_error = None
    for attempt in range(retries + 1):
        try:
            response = requests.post(
                url,
                json=payload,
                headers=get_headers(include_origin=include_origin),
                timeout=timeout,
            )
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            last_error = e
            if attempt >= retries:
                raise
            time.sleep(backoff * (2 ** attempt))
    raise last_error


def fetch_scanx_data(payload, timeout=30):
    """Fetch a list from the shared ScanX customscan endpoint."""
    data = post_json(SCANX_FETCH_URL, payload, include_origin=True, timeout=timeout)
    rows = data.get("data", [])
    return rows if isinstance(rows, list) else []
