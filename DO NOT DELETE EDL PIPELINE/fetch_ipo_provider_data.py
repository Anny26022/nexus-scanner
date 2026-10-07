"""Ingest permitted IPO provider data without retaining browser credentials.

Each run creates a new provider session, fetches catalogue and analytics feeds,
then refreshes a bounded rotating set of detailed issue records. The bounded
detail lane respects the provider rate limit while the history cache converges
to complete detail coverage over subsequent daily runs.
"""

from __future__ import annotations

from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import time

from pipeline_utils import BASE_DIR, load_json, save_json


ORIGIN = "https://ipodecode.mrchartist.com"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
)
CATALOGUE_ENDPOINTS = {
    "open": "/api/ipos/open", "upcoming": "/api/ipos/upcoming", "closed": "/api/ipos/closed",
    "listed_60d": "/api/ipos/listed?days=60", "allotment_live": "/api/allotment/live",
    "listing_live": "/api/listing/live", "freshness": "/api/freshness", "notifications": "/api/notifications",
}
ANALYTICS_ENDPOINTS = {
    "year_summary": "/api/analytics/year-summary", "gmp_scorecard": "/api/analytics/gmp-scorecard",
    "subscription_bins": "/api/analytics/subscription-bins", "allotment_odds": "/api/analytics/allotment-odds",
    "broker_record": "/api/analytics/broker-record", "lockin_upcoming": "/api/analytics/lockin/upcoming?days=90",
    "lockin_recent": "/api/analytics/lockin/recent?days=30", "lockin_methodology": "/api/analytics/lockin/methodology",
    "sector_valuation": "/api/analytics/peer-valuation/sectors?level=industry",
    "above_issue_summary": "/api/analytics/above-issue/summary", "above_issue_extremes": "/api/analytics/above-issue/extremes?n=8",
}
DETAIL_ENDPOINTS = {
    "issue": "/api/ipos/{id}", "gmp_history": "/api/ipos/{id}/gmp",
    "prospectus": "/api/ipos/{id}/prospectus", "allotment": "/api/ipos/{id}/allotment",
    "allotment_check": "/api/ipos/{id}/allotment-check", "documents": "/api/ipos/{id}/documents",
    "related": "/api/ipos/{id}/related", "timeline": "/api/ipos/{id}/timeline",
    "peer_valuation": "/api/analytics/peer-valuation/issue/{id}",
}
DETAIL_LIMIT = 18
DETAIL_DELAY_SECONDS = 0.28
LISTED_ARCHIVE_NAME = "ipo_provider_listed_archive.json.gz"
DETAILS_ARCHIVE_NAME = "ipo_provider_details_archive.json.gz"


def _read_nonce(cookie_jar: Path) -> str:
    for line in cookie_jar.read_text(encoding="utf-8").splitlines():
        columns = line.split("\t")
        if len(columns) == 7 and columns[5] == "ipd_nonce":
            return columns[6]
    raise RuntimeError("IPO provider bootstrap did not issue its session nonce.")


class IpoProviderClient:
    """A short-lived curl-backed provider client using one fresh nonce."""

    def __init__(self, timeout: int = 30):
        self.timeout = timeout
        self.temporary = TemporaryDirectory(prefix="ipo-provider-")
        self.directory = Path(self.temporary.name)
        self.cookie_jar = self.directory / "cookies.txt"
        self.nonce = ""

    def __enter__(self):
        common = ["curl", "--fail", "--silent", "--show-error", "--compressed", "--max-time", str(self.timeout),
                  "--user-agent", USER_AGENT]
        subprocess.run([*common, "--header", "Accept: text/html", "--cookie-jar", str(self.cookie_jar), f"{ORIGIN}/"],
                       check=True, stdout=subprocess.DEVNULL)
        self.nonce = _read_nonce(self.cookie_jar)
        return self

    def __exit__(self, *_):
        self.temporary.cleanup()

    def get_json(self, endpoint: str):
        target = self.directory / f"{hashlib.sha256(endpoint.encode()).hexdigest()}.json"
        common = ["curl", "--fail", "--silent", "--show-error", "--compressed", "--max-time", str(self.timeout),
                  "--user-agent", USER_AGENT]
        subprocess.run([*common, "--header", "Accept: application/json, text/plain, */*",
                        "--header", f"Referer: {ORIGIN}/", "--header", f"X-IPO-Session: {self.nonce}",
                        "--cookie", str(self.cookie_jar), "--output", str(target), f"{ORIGIN}{endpoint}"], check=True)
        return json.loads(target.read_text(encoding="utf-8"))


def _records(payload) -> list[dict]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("ipos", "items", "records"):
            if isinstance(payload.get(key), list):
                return [row for row in payload[key] if isinstance(row, dict)]
    return []


def _detail_candidates(feeds: dict, feed_names=("open", "upcoming", "closed", "listed_60d")) -> list[str]:
    priority = {}
    for rank, name in enumerate(feed_names):
        for row in _records(feeds.get(name)):
            identifier = str(row.get("id") or "").strip()
            if identifier:
                priority[identifier] = min(rank, priority.get(identifier, rank))
    return [identifier for identifier, _ in sorted(priority.items(), key=lambda item: (item[1], item[0]))]


def _cache_path(root: Path) -> Path:
    return root / "ipo_provider_history_data" / "details.json"


def _listed_cache_path(root: Path) -> Path:
    return root / "ipo_provider_history_data" / "listed.json.gz"


def _load_listed_archive(root: Path) -> list[dict]:
    by_id = {}
    for path in (root / LISTED_ARCHIVE_NAME, _listed_cache_path(root)):
        if path.exists():
            try:
                with gzip.open(path, "rt", encoding="utf-8") as handle:
                    rows = _records(json.load(handle))
                by_id.update({str(row["id"]): row for row in rows if row.get("id")})
            except (OSError, ValueError):
                continue
    return list(by_id.values())


def _write_listed_archive(root: Path, rows: list[dict]) -> None:
    data = json.dumps({"ipos": rows}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    compressed = gzip.compress(data, compresslevel=9, mtime=0)
    for path in (_listed_cache_path(root), root / LISTED_ARCHIVE_NAME):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(compressed)


def _merge_listed_archive(root: Path, recent: list[dict]) -> list[dict]:
    # The recent feed replaces matching archived issues, including updated
    # subscriptions and listing prices; the published archive survives cache loss.
    by_id = {str(row["id"]): row for row in _load_listed_archive(root) if row.get("id")}
    by_id.update({str(row["id"]): row for row in recent if row.get("id")})
    rows = sorted(by_id.values(), key=lambda row: (str(row.get("listing_date_iso") or ""), str(row.get("id"))), reverse=True)
    _write_listed_archive(root, rows)
    return rows


def _load_cache(root: Path) -> dict:
    details = {}
    archive = root / DETAILS_ARCHIVE_NAME
    if archive.exists():
        try:
            with gzip.open(archive, "rt", encoding="utf-8") as handle:
                payload = json.load(handle)
            if isinstance(payload, dict) and isinstance(payload.get("details"), dict):
                details.update(payload["details"])
        except (OSError, ValueError):
            pass
    payload = load_json(_cache_path(root), default={})
    if isinstance(payload, dict) and isinstance(payload.get("details"), dict):
        details.update(payload["details"])
    return {"details": details}


def _write_details_archive(root: Path, details: dict, updated_at: str) -> None:
    payload = {"schema_version": 1, "updated_at": updated_at, "details": details}
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    (root / DETAILS_ARCHIVE_NAME).write_bytes(gzip.compress(data, compresslevel=9, mtime=0))
    save_json(_cache_path(root), payload, ensure_ascii=False)


def _age_hours(item: dict, now: datetime) -> float:
    try:
        fetched_at = datetime.fromisoformat(str(item.get("fetched_at")).replace("Z", "+00:00"))
        return max(0, (now - fetched_at).total_seconds() / 3600)
    except (TypeError, ValueError):
        return float("inf")


def _refresh_detail(client: IpoProviderClient, identifier: str) -> tuple[dict, list[str]]:
    values, errors = {}, []
    for name, template in DETAIL_ENDPOINTS.items():
        try:
            values[name] = client.get_json(template.format(id=identifier))
        except (subprocess.CalledProcessError, ValueError) as error:
            errors.append(f"{name}: {error}")
        time.sleep(DETAIL_DELAY_SECONDS)
    return values, errors


def fetch_all(root: Path, detail_limit: int = DETAIL_LIMIT) -> dict:
    now = datetime.now(timezone.utc)
    feeds, analytics, errors = {}, {}, []
    cache = _load_cache(root)
    details = cache["details"]
    with IpoProviderClient() as client:
        for name, endpoint in CATALOGUE_ENDPOINTS.items():
            try:
                feeds[name] = client.get_json(endpoint)
            except (subprocess.CalledProcessError, ValueError) as error:
                errors.append(f"{name}: {error}")
        for name, endpoint in ANALYTICS_ENDPOINTS.items():
            try:
                analytics[name] = client.get_json(endpoint)
            except (subprocess.CalledProcessError, ValueError) as error:
                errors.append(f"{name}: {error}")
        active = set(_detail_candidates(feeds, ("open", "upcoming", "closed")))
        candidates = _detail_candidates(feeds)
        # Within each priority group, missing details precede the oldest cache.
        ordered = sorted(candidates, key=lambda identifier: (0 if identifier in active else 1,
                         -_age_hours(details.get(identifier, {}), now), identifier))
        attempted = 0
        for identifier in ordered:
            if attempted >= detail_limit:
                break
            current = details.get(identifier, {})
            max_age = 24 if identifier in active else 24 * 7
            if _age_hours(current, now) < max_age:
                continue
            values, detail_errors = _refresh_detail(client, identifier)
            # Preserve previous successful endpoints on partial or total failure.
            # Only complete refreshes advance the freshness timestamp; failures
            # remain eligible next run without exceeding this run's request budget.
            details[identifier] = {**current, "data": {**current.get("data", {}), **values}, "errors": detail_errors}
            if not detail_errors:
                details[identifier]["fetched_at"] = now.isoformat()
            errors.extend(f"{identifier} {error}" for error in detail_errors)
            attempted += 1
    records = _merge_listed_archive(root, _records(feeds.get("listed_60d")))
    _write_details_archive(root, details, now.isoformat())
    return {"schema_version": 2, "source": "Permitted IPO provider catalogue API", "available": bool(feeds),
            "recent_feed_available": "listed_60d" in feeds,
            "fetched_at": now.isoformat(), "feeds": feeds, "analytics": analytics, "details": details,
            "records": records, "errors": errors}


def main() -> int:
    root = Path(BASE_DIR)
    output = root / "ipo_provider_data.json"
    try:
        payload = fetch_all(root)
        print(f"Retained {len(payload['records'])} listed IPOs; {len(payload['details'])} detailed issues.")
    except (subprocess.CalledProcessError, RuntimeError, ValueError, OSError) as error:
        archive = _load_listed_archive(root)
        if archive:
            _write_listed_archive(root, archive)
        cache = _load_cache(root)
        if cache["details"]:
            _write_details_archive(root, cache["details"], datetime.now(timezone.utc).isoformat())
        payload = {"schema_version": 2, "source": "Permitted IPO provider catalogue API", "available": bool(archive),
                   "recent_feed_available": False,
                   "fetched_at": datetime.now(timezone.utc).isoformat(), "feeds": {}, "analytics": {},
                   "details": cache["details"], "records": archive, "errors": [str(error)]}
        print(f"WARNING: IPO provider enrichment unavailable: {error}")
    save_json(output, payload, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
