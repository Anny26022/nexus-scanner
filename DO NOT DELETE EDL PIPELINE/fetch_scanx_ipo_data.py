"""Fetch and durably archive the public ScanX IPO catalogue.

ScanX is an enrichment source. NSE remains authoritative for security identity
and listing dates when the catalogue is joined to the mainboard universe.
"""

from __future__ import annotations

from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pipeline_utils import BASE_DIR, load_json, save_json


ORIGIN = "https://openweb-api.dhan.co"
LISTED_PAGE_SIZE = 50
RECENT_LISTED_PAGES = 2
MAX_LISTED_PAGES = 100
DETAIL_LIMIT = 40
REQUEST_DELAY_SECONDS = 0.15
LISTED_ARCHIVE_NAME = "scanx_ipo_listed_archive.json.gz"
DETAILS_ARCHIVE_NAME = "scanx_ipo_details_archive.json.gz"

OPEN_BODY = {"source": "O"}
UPCOMING_BODY = {
    "token_id": "123123123", "source": "O", "entity_id": "SJ33777", "iv": "",
    "data": {"type": "ALL"},
}


class ScanxIpoClient:
    """Small JSON client for the public, cookie-free IPO endpoints."""

    def __init__(self, timeout: int = 30):
        self.timeout = timeout

    def post_json(self, endpoint: str, body: dict):
        request = Request(
            f"{ORIGIN}/{endpoint}",
            data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
            headers={"Content-Type": "application/json", "excludeCache": "true"},
            method="POST",
        )
        with urlopen(request, timeout=self.timeout) as response:
            payload = json.load(response)
        if not isinstance(payload, dict) or payload.get("status") != "success":
            raise ValueError(f"ScanX {endpoint} returned an unsuccessful payload")
        return payload


def _records(payload) -> list[dict]:
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return [row for row in payload["data"] if isinstance(row, dict)]
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    return []


def _listed_key(row: dict) -> str:
    isin = str(row.get("ipo_isin") or "").strip().upper()
    if isin:
        return f"ISIN:{isin}"
    symbol = str(row.get("ipo_symbol_name") or "").strip().upper()
    listed = str(row.get("ipo_listed_date") or "").strip()[:10]
    return f"SYMBOL_DATE:{symbol}:{listed}" if symbol and listed else ""


def _listed_cache_path(root: Path) -> Path:
    return root / "scanx_ipo_history_data" / "listed.json.gz"


def _details_cache_path(root: Path) -> Path:
    return root / "scanx_ipo_history_data" / "details.json.gz"


def _read_gzip_payload(path: Path, key: str):
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload.get(key) if isinstance(payload, dict) else None
    except (OSError, ValueError):
        return None


def _load_listed_archive(root: Path) -> list[dict]:
    by_key = {}
    for path in (root / LISTED_ARCHIVE_NAME, _listed_cache_path(root)):
        for row in _read_gzip_payload(path, "ipos") or []:
            key = _listed_key(row)
            if key:
                by_key[key] = row
    return list(by_key.values())


def _load_details_archive(root: Path) -> dict:
    details = {}
    for path in (root / DETAILS_ARCHIVE_NAME, _details_cache_path(root)):
        value = _read_gzip_payload(path, "details")
        if isinstance(value, dict):
            details.update(value)
    return details


def _write_gzip_payload(paths, payload) -> None:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=9, mtime=0)
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(compressed)


def _write_listed_archive(root: Path, rows: list[dict]) -> None:
    _write_gzip_payload(
        (_listed_cache_path(root), root / LISTED_ARCHIVE_NAME),
        {"schema_version": 1, "ipos": rows},
    )


def _write_details_archive(root: Path, details: dict, updated_at: str) -> None:
    _write_gzip_payload(
        (_details_cache_path(root), root / DETAILS_ARCHIVE_NAME),
        {"schema_version": 1, "updated_at": updated_at, "details": details},
    )


def _merge_listed_archive(root: Path, recent: list[dict]) -> list[dict]:
    by_key = {_listed_key(row): row for row in _load_listed_archive(root) if _listed_key(row)}
    by_key.update({_listed_key(row): row for row in recent if _listed_key(row)})
    rows = sorted(
        by_key.values(),
        key=lambda row: (str(row.get("ipo_listed_date") or ""), str(row.get("ipo_symbol_name") or "")),
        reverse=True,
    )
    _write_listed_archive(root, rows)
    return rows


def _listed_body(page: int) -> dict:
    return {"source": "O", "data": {"page_value": page, "limit": LISTED_PAGE_SIZE}}


def _fetch_listed(client: ScanxIpoClient, full_history: bool) -> tuple[list[dict], list[str]]:
    rows, errors = [], []
    pages = MAX_LISTED_PAGES if full_history else RECENT_LISTED_PAGES
    for page in range(pages):
        try:
            batch = _records(client.post_json("listedIpos", _listed_body(page)))
        except (HTTPError, URLError, TimeoutError, ValueError, OSError) as error:
            errors.append(f"listed page {page}: {error}")
            break
        rows.extend(batch)
        if len(batch) < LISTED_PAGE_SIZE:
            break
        time.sleep(REQUEST_DELAY_SECONDS)
    return rows, errors


def _slug(row: dict) -> str:
    return str(row.get("custom_symbol") or row.get("seo_symbol") or "").strip().lower()


def _age_hours(item: dict, now: datetime) -> float:
    try:
        fetched = datetime.fromisoformat(str(item.get("fetched_at")).replace("Z", "+00:00"))
        return max(0, (now - fetched).total_seconds() / 3600)
    except (AttributeError, TypeError, ValueError):
        return float("inf")


def _detail_candidates(feeds: dict, listed: list[dict], details: dict, now: datetime) -> list[tuple[str, bool]]:
    active = {_slug(row) for name in ("open", "upcoming") for row in _records(feeds.get(name)) if _slug(row)}
    candidates = set(active)
    candidates.update(_slug(row) for row in listed if _slug(row))
    return sorted(
        ((slug, slug in active) for slug in candidates),
        key=lambda item: (0 if item[1] else 1, -_age_hours(details.get(item[0], {}), now), item[0]),
    )


def _detail_body(slug: str) -> dict:
    return {
        "entity_id": "", "source": "O", "token_id": "", "iv": "",
        "data": {"cred": "thor", "seoSymbol": slug}, "aes_key": "", "ip": "",
    }


def fetch_all(root: Path, detail_limit: int = DETAIL_LIMIT) -> dict:
    now = datetime.now(timezone.utc)
    feeds, errors = {}, []
    listed_before = _load_listed_archive(root)
    details = _load_details_archive(root)
    for item in details.values():
        if isinstance(item, dict) and item.get("data") == {}:
            item["data"] = None
            item["available"] = False
    client = ScanxIpoClient()

    for name, endpoint, body in (
        ("open", "ipolisting", OPEN_BODY),
        ("upcoming", "ActiveUpcomingIpo", UPCOMING_BODY),
    ):
        try:
            feeds[name] = client.post_json(endpoint, body)
        except (HTTPError, URLError, TimeoutError, ValueError, OSError) as error:
            errors.append(f"{name}: {error}")

    fetched_listed, listed_errors = _fetch_listed(client, full_history=not listed_before)
    errors.extend(listed_errors)
    listed = _merge_listed_archive(root, fetched_listed)

    attempted = 0
    for slug, active in _detail_candidates(feeds, listed, details, now):
        if attempted >= detail_limit:
            break
        max_age = 6 if active else 24 * 30
        if _age_hours(details.get(slug, {}), now) < max_age:
            continue
        attempted += 1
        try:
            response = client.post_json("history", _detail_body(slug))
            rows = _records(response)
            data = rows[0] if rows and rows[0] else None
            details[slug] = {
                "fetched_at": now.isoformat(), "available": data is not None,
                "data": data, "errors": [],
            }
        except (HTTPError, URLError, TimeoutError, ValueError, OSError) as error:
            current = details.get(slug, {})
            details[slug] = {**current, "errors": [str(error)]}
            errors.append(f"detail {slug}: {error}")
        time.sleep(REQUEST_DELAY_SECONDS)

    _write_details_archive(root, details, now.isoformat())
    return {
        "schema_version": 1,
        "source": "ScanX public IPO API",
        "available": bool(feeds or listed),
        "fetched_at": now.isoformat(),
        "feeds": feeds,
        "records": listed,
        "details": details,
        "coverage": {
            "listed_records": len(listed),
            "detail_records": sum(bool(item.get("data")) for item in details.values()),
            "detail_lookups": len(details),
            "full_history_bootstrap": not listed_before,
        },
        "errors": errors,
    }


def main() -> int:
    root = Path(BASE_DIR)
    try:
        payload = fetch_all(root)
    except Exception as error:  # Preserve publication from durable archives on an unexpected client failure.
        listed = _load_listed_archive(root)
        details = _load_details_archive(root)
        now = datetime.now(timezone.utc).isoformat()
        _write_listed_archive(root, listed)
        _write_details_archive(root, details, now)
        payload = {
            "schema_version": 1, "source": "ScanX public IPO API", "available": bool(listed or details),
            "fetched_at": now, "feeds": {}, "records": listed, "details": details,
            "coverage": {
                "listed_records": len(listed),
                "detail_records": sum(bool(item.get("data")) for item in details.values()),
                "detail_lookups": len(details),
                "full_history_bootstrap": False,
            },
            "errors": [str(error)],
        }
        print(f"WARNING: ScanX IPO enrichment unavailable: {error}")
    save_json(root / "scanx_ipo_data.json", payload, ensure_ascii=False)
    print(f"Retained {len(payload['records'])} ScanX listings and {len(payload['details'])} detail records.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
