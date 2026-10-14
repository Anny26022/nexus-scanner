"""Ingest permitted IPO provider data without retaining browser credentials.

Each run creates a new provider session, fetches catalogue and analytics feeds,
then refreshes up to 18 IPO details within a time budget, prioritizing missing
sections and checkpointing progress for the next daily run.
"""

from __future__ import annotations

from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import subprocess
import time
import requests

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
MISSING_DETAIL_BUDGET_SECONDS = 20 * 60
DETAIL_REFRESH_LIMIT = 18
ACTIVE_DETAIL_REFRESH_LIMIT = 6
ACTIVE_DETAIL_REFRESH_HOURS = 24
DETAIL_DELAY_SECONDS = 0.28
LISTED_ARCHIVE_NAME = "ipo_provider_listed_archive.json.gz"
DETAILS_ARCHIVE_NAME = "ipo_provider_details_archive.json.gz"


class ProviderBackoff(RuntimeError):
    """Stop collection on throttling, access denial or a provider outage."""


def _safe_error(error):
    if isinstance(error, subprocess.CalledProcessError):
        return f"request failed (curl exit {error.returncode})"
    if isinstance(error, ValueError):
        return "invalid provider response"
    return "provider unavailable"


def _clean_detail_errors(details):
    # Older caches may contain subprocess commands, including session headers.
    for item in details.values():
        if "errors" not in item:
            continue
        item["errors"] = [
            (str(error).split(":", 1)[0] if str(error).split(":", 1)[0] in DETAIL_ENDPOINTS else "unknown")
            + ": request failed" for error in item.get("errors", [])
        ]
    return details


class IpoProviderClient:
    """One short-lived connection pool; cookies and nonce never leave memory."""

    def __init__(self, timeout: int = 30):
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({'User-Agent': USER_AGENT})
        self.nonce = ""

    def __enter__(self):
        try:
            self._get('/', {'Accept': 'text/html'}).close()
            self.nonce = next((cookie.value for cookie in self.session.cookies if cookie.name == 'ipd_nonce'), '')
            if not self.nonce:
                raise RuntimeError('IPO provider bootstrap did not issue its session nonce.')
            return self
        except Exception:
            self.session.close()
            raise

    def __exit__(self, *_):
        self.session.close()

    def _get(self, endpoint, headers):
        try:
            response = self.session.get(ORIGIN + endpoint, headers=headers, timeout=self.timeout,
                                        allow_redirects=False)
        except requests.RequestException:
            raise ProviderBackoff('Provider requested backoff') from None
        if response.status_code in {401, 403, 408, 429} or response.status_code >= 500:
            response.close()
            raise ProviderBackoff('Provider requested backoff')
        if response.status_code >= 300:
            response.close()
            raise ValueError('Provider request failed')
        return response

    def get_json(self, endpoint: str):
        response = self._get(endpoint, {'Accept': 'application/json, text/plain, */*',
                                       'Referer': ORIGIN + '/', 'X-IPO-Session': self.nonce})
        try:
            return response.json()
        finally:
            response.close()


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
    return {"details": _clean_detail_errors(details)}


def _write_details_archive(root: Path, details: dict, updated_at: str) -> None:
    payload = {"schema_version": 1, "updated_at": updated_at, "details": _clean_detail_errors(details)}
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    (root / DETAILS_ARCHIVE_NAME).write_bytes(gzip.compress(data, compresslevel=9, mtime=0))
    save_json(_cache_path(root), payload, ensure_ascii=False)


def _age_hours(item: dict, now: datetime) -> float:
    try:
        fetched_at = datetime.fromisoformat(str(item.get("fetched_at")).replace("Z", "+00:00"))
        return max(0, (now - fetched_at).total_seconds() / 3600)
    except (TypeError, ValueError):
        return float("inf")


def _refresh_detail(client: IpoProviderClient, identifier: str, endpoints=None) -> tuple[dict, list[str]]:
    values, errors = {}, []
    for name, template in DETAIL_ENDPOINTS.items():
        if endpoints is not None and name not in endpoints:
            continue
        started = time.perf_counter()
        try:
            values[name] = client.get_json(template.format(id=identifier))
        except ProviderBackoff:
            errors.append(f"{name}: provider requested backoff")
            break
        except (subprocess.CalledProcessError, ValueError) as error:
            errors.append(f"{name}: {_safe_error(error)}")
        remaining = DETAIL_DELAY_SECONDS - (time.perf_counter() - started)
        if remaining > 0:
            time.sleep(remaining)
    return values, errors


def fetch_all(root: Path, detail_limit: int | None = DETAIL_REFRESH_LIMIT, *, missing_budget_seconds: float = MISSING_DETAIL_BUDGET_SECONDS) -> dict:
    now = datetime.now(timezone.utc)
    feeds, analytics, errors = {}, {}, []
    cache = _load_cache(root)
    details = cache["details"]
    with IpoProviderClient() as client:
        paused = False
        for target, endpoints in ((feeds, CATALOGUE_ENDPOINTS), (analytics, ANALYTICS_ENDPOINTS)):
            if paused:
                break
            for name, endpoint in endpoints.items():
                try:
                    target[name] = client.get_json(endpoint)
                except ProviderBackoff:
                    errors.append(f"{name}: provider requested backoff")
                    paused = True
                    break
                except (subprocess.CalledProcessError, ValueError) as error:
                    errors.append(f"{name}: {_safe_error(error)}")
        active = set(_detail_candidates(feeds, ("open", "upcoming", "closed")))
        records = _merge_listed_archive(root, _records(feeds.get("listed_60d")))
        candidates = set(_detail_candidates(feeds)) | {str(row["id"]) for row in records if row.get("id")}
        # New issues precede retries within each group; live IPOs take priority.
        def priority(identifier):
            item = details.get(identifier, {})
            stamp = item.get("last_attempt_at") or item.get("fetched_at")
            return (identifier not in active, -_age_hours({"fetched_at": stamp}, now), identifier)
        def missing_endpoints(identifier):
            item = details.get(identifier, {})
            failed = {error.split(":", 1)[0] for error in item.get("errors", [])}
            return set(DETAIL_ENDPOINTS) - set(item.get("data", {})) | (failed & set(DETAIL_ENDPOINTS))

        # Recently listed issues can still gain documents, GMP and allotment data.
        refreshable = active | set(_detail_candidates(feeds, ("listed_60d",)))
        refresh = set(sorted((identifier for identifier in refreshable
                              if not missing_endpoints(identifier)
                              and _age_hours(details.get(identifier, {}), now) >= ACTIVE_DETAIL_REFRESH_HOURS),
                             key=lambda identifier: (-_age_hours(details.get(identifier, {}), now), identifier))
                      [:ACTIVE_DETAIL_REFRESH_LIMIT])
        ordered = [] if paused else sorted((identifier for identifier in candidates
                                           if missing_endpoints(identifier) or identifier in refresh), key=priority)
        if detail_limit is not None:
            ordered = ordered[:detail_limit]
        deadline = time.monotonic() + missing_budget_seconds
        attempted = 0
        for identifier in ordered:
            if time.monotonic() >= deadline:
                print("IPO missing-detail budget reached; saved progress resumes next run.", flush=True)
                break
            current = details.get(identifier, {})
            endpoints = set(DETAIL_ENDPOINTS) if identifier in refresh else missing_endpoints(identifier)
            values, detail_errors = _refresh_detail(client, identifier, endpoints)
            # Preserve previous successful endpoints on partial or total failure.
            # Only a complete merged collection advances its timestamp; failures
            # remain eligible next run without exceeding this run's request budget.
            details[identifier] = {**current, "data": {**current.get("data", {}), **values},
                                   "errors": detail_errors, "last_attempt_at": now.isoformat()}
            if not detail_errors and not missing_endpoints(identifier):
                details[identifier]["fetched_at"] = now.isoformat()
            errors.extend(f"{identifier} {error}" for error in detail_errors)
            attempted += 1
            if any("provider requested backoff" in error for error in detail_errors):
                print("IPO collection paused by provider; saved progress resumes next run.", flush=True)
                break
            if missing_budget_seconds:
                # Persist each batch, including failures, so an interrupted run resumes.
                if attempted % 10 == 0:
                    _write_details_archive(root, details, datetime.now(timezone.utc).isoformat())
                print(f"IPO details [{attempted}/{len(ordered)}] {identifier}: "
                      f"{len(values)}/{len(DETAIL_ENDPOINTS)} sections fetched", flush=True)
    _write_details_archive(root, details, now.isoformat())
    complete = sum(not missing_endpoints(identifier) for identifier in candidates)
    coverage = {"total": len(candidates), "complete": complete,
                "incomplete": len(candidates) - complete, "attempted": attempted}
    print(f"IPO detail coverage: {complete}/{len(candidates)} complete; "
          f"{coverage['incomplete']} incomplete; {attempted} attempted this run.", flush=True)
    return {"schema_version": 2, "source": "Permitted IPO provider catalogue API", "available": bool(feeds or records),
            "recent_feed_available": "listed_60d" in feeds,
            "refresh_complete": len(feeds) == len(CATALOGUE_ENDPOINTS) and len(analytics) == len(ANALYTICS_ENDPOINTS),
            "fetched_at": now.isoformat(), "feeds": feeds, "analytics": analytics, "details": details,
            "records": records, "errors": errors, "detail_coverage": coverage}


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
                   "refresh_complete": False,
                   "fetched_at": datetime.now(timezone.utc).isoformat(), "feeds": {}, "analytics": {},
                   "details": cache["details"], "records": archive, "errors": [_safe_error(error)]}
        print(f"WARNING: IPO provider enrichment unavailable: {_safe_error(error)}")
    save_json(output, payload, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
