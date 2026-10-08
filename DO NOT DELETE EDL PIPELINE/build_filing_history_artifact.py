"""Publish the persistent, normalized ScanX filing-history cache."""

from __future__ import annotations

import sys
import hashlib
import json
import resource
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from pipeline_utils import BASE_DIR, file_fingerprint, load_json, save_json, save_json_records
from filing_classification import VERSION, TAXONOMY, classify_filing, classify_filings
from filing_documents import enrich_documents

# Bump for changes to filing normalization/cache layout; classifier semantics use VERSION.
CACHE_VERSION = 1
CLASSIFICATION_FIELDS = {'interpretation', 'topics', 'events', 'subtypes', 'documentType',
                         'status', 'matchedRuleIds', 'method', 'basis'}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def classification_key(row):
    inputs = {key: row.get(key) for key in
              ('caption', 'news_body', 'descriptor', 'ann_type', 'cat', 'sourceLabels')}
    document = row.get('documentExtraction') or {}
    inputs['documentExtraction'] = {key: document.get(key) for key in ('status', 'pages')}
    return fingerprint(inputs)


def valid_classification(value):
    return (isinstance(value, dict) and value.get('version') == VERSION
            and CLASSIFICATION_FIELDS.issubset(value))


def classification_rules():
    # Implementation-only edits must not invalidate the historical archive.
    return [CACHE_VERSION, VERSION, file_fingerprint(ROOT / 'filing_source_labels.json')]


def progress(label, started):
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    mib = peak / (1024 * 1024 if sys.platform == 'darwin' else 1024)
    print(f"Filings {label}: {time.perf_counter() - started:.2f}s; peak RSS {mib:.1f} MiB", flush=True)
    return time.perf_counter()


def classify_cached(filings, path, rules, stats=None, legacy_rules=None):
    stats = Counter() if stats is None else stats
    if not filings:
        return []
    try:
        old = load_json(path, default={})
    except (OSError, ValueError):
        old = {}
    if not isinstance(old, dict):
        old = {}
    if old and old.get('rules') != rules and (legacy_rules is None or old.get('rules') != legacy_rules):
        stats['invalidated_companies'] += 1
        old = {}
    history_key = fingerprint(filings)
    previous = old.get('filings')
    cached = old.get('entries', {})
    if not isinstance(cached, dict):
        cached = {}
    if (old.get('rules') == rules and old.get('history_key') == history_key
            and isinstance(previous, list) and previous
            and all(isinstance(row, dict) and row.get('filingId')
                    and isinstance(row.get('classification'), str)
                    and valid_classification(cached.get(row['classification'])) for row in previous)):
        stats['unchanged_companies'] += 1
        stats['reused_filings'] += len(previous)
        return [{**row, 'classification': cached[row['classification']]} for row in previous]
    stats['rebuilt_companies'] += 1
    entries, keys = {}, []
    def classify(row):
        key = classification_key(row)
        keys.append(key)
        # Repeated text at different filing dates also shares classification on
        # a cold cache. Identity, dates and source observations stay separate.
        value = entries.get(key, cached.get(key))
        if not valid_classification(value):
            value = classify_filing(row)
            stats['fresh_filings'] += 1
        else:
            stats['reused_filings'] += 1
        entries[key] = value
        return value
    result = classify_filings(filings, classify=classify)
    # Repeated disclosures share one classification; normalized rows reference its key.
    current = {'rules': rules, 'history_key': history_key, 'entries': entries,
               'filings': [{**row, 'classification': key} for row, key in zip(result, keys)]}
    if current != old:
        try:
            save_json(path, current, ensure_ascii=False)
        except OSError as error:
            print(f'WARNING: Classification cache not saved: {error}', flush=True)
    return result


def main() -> int:
    started = time.perf_counter()
    root = Path(BASE_DIR)
    cache = load_json(root / "filing_history_data" / "filing_history.json", default={})
    symbols = cache.get("symbols") if isinstance(cache, dict) else None
    if not isinstance(symbols, dict) or not symbols:
        print("Cannot publish filing history without a populated persistent cache.")
        return 1
    started = progress("load", started)
    records = [{"symbol": symbol, **entry} for symbol, entry in symbols.items() if isinstance(entry, dict)]
    session = str(cache.get('updated_at') or '')[:10]
    if not session:
        session = max((str(f.get('news_date') or '')[:10] for row in records for f in row.get('filings', []) if f.get('news_date')), default='1970-01-01')
    pdf_coverage = enrich_documents(records, root, session)
    started = progress("document enrichment", started)
    rules = classification_rules()
    # Upgrade the deployed entry cache without rerunning rules when its source hash matches.
    legacy_rules = [file_fingerprint(ROOT / name) for name in ('filing_classification.py', 'filing_source_labels.json')]
    stats = Counter()
    for index, record in enumerate(records, 1):
        key = hashlib.sha256(record['symbol'].encode()).hexdigest()
        record["filings"] = classify_cached(record.get("filings") or [],
                                            root / 'filing_history_data/classification' / f'{key}.json', rules,
                                            stats, legacy_rules)
        if index % 100 == 0:
            print(f"Filing companies processed: {index}/{len(records)}; "
                  f"unchanged: {stats['unchanged_companies']}; fresh classifications: {stats['fresh_filings']}", flush=True)
        for filing in record['filings']:
            if 'documentExtraction' in filing:
                filing['documentExtraction'] = {k: v for k, v in filing['documentExtraction'].items() if k != 'pages'}
    started = progress("classification", started)
    print(f"Filing cache: unchanged companies={stats['unchanged_companies']}; "
          f"rebuilt companies={stats['rebuilt_companies']}; "
          f"invalidated companies={stats['invalidated_companies']}; "
          f"reused filings={stats['reused_filings']}; fresh classifications={stats['fresh_filings']}", flush=True)
    records.sort(key=lambda item: item["symbol"])
    if not records or not any(item.get("filings") for item in records):
        print("No usable filing-history records found.")
        return 1
    complete = sum(bool(item.get("lodr_backfill_complete")) for item in records)
    save_json_records(root / "filing_history.json", {
        "schema_version": 1,
        "classification_version": VERSION,
        "classification_interpretation": "evidence_based_topic_tags",
        "pdf_extraction": pdf_coverage,
        "taxonomy": TAXONOMY,
        "source": "ScanX static company_filings and LODR endpoints",
        "updated_at": cache.get("updated_at"),
        "coverage": {"symbols": len(records), "lodr_backfill_complete": complete, "lodr_backfill_pending": len(records) - complete,
                     "filings": sum(len(row["filings"]) for row in records),
                     "unclassified": sum(f["classification"]["topics"] == ["unclassified"] for row in records for f in row["filings"])},
        "records": records,
    }, ensure_ascii=False)
    progress("serialization", started)
    print(f"Published filing history for {len(records)} symbols ({complete} LODR backfills complete).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
