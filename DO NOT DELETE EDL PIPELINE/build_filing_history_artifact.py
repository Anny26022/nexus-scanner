"""Publish the persistent, normalized ScanX filing-history cache."""

from __future__ import annotations

import sys
import hashlib
import json
import resource
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from pipeline_utils import BASE_DIR, file_fingerprint, load_json, save_json
from filing_classification import VERSION, TAXONOMY, classify_filing, classify_filings
from filing_documents import enrich_documents


def progress(label, started):
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    mib = peak / (1024 * 1024 if sys.platform == 'darwin' else 1024)
    print(f"Filings {label}: {time.perf_counter() - started:.2f}s; peak RSS {mib:.1f} MiB", flush=True)
    return time.perf_counter()


def classify_cached(filings, path, rules):
    try:
        old = load_json(path, default={})
    except (OSError, ValueError):
        old = {}
    old = old if isinstance(old, dict) and old.get('rules') == rules else {}
    cached = old.get('entries', {})
    if not isinstance(cached, dict):
        cached = {}
    entries = {}
    def classify(row):
        inputs = {key: row.get(key) for key in
                  ('caption', 'news_body', 'descriptor', 'ann_type', 'cat', 'sourceLabels', 'documentExtraction')}
        key = hashlib.sha256(json.dumps(inputs, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        value = cached.get(key)
        if not isinstance(value, dict) or value.get('version') != VERSION or not {
                'interpretation', 'topics', 'events', 'subtypes', 'documentType', 'status',
                'matchedRuleIds', 'method', 'basis'}.issubset(value):
            value = classify_filing(row)
        entries[key] = value
        return value
    result = classify_filings(filings, classify=classify)
    current = {'rules': rules, 'entries': entries}
    if current != old:
        save_json(path, current, ensure_ascii=False)
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
    rules = [file_fingerprint(ROOT / name) for name in ('filing_classification.py', 'filing_source_labels.json')]
    for index, record in enumerate(records, 1):
        key = hashlib.sha256(record['symbol'].encode()).hexdigest()
        record["filings"] = classify_cached(record.get("filings") or [],
                                            root / 'filing_history_data/classification' / f'{key}.json', rules)
        if index % 100 == 0:
            print(f"Filings classified: {index}/{len(records)}", flush=True)
        for filing in record['filings']:
            if 'documentExtraction' in filing:
                filing['documentExtraction'] = {k: v for k, v in filing['documentExtraction'].items() if k != 'pages'}
    started = progress("classification", started)
    records.sort(key=lambda item: item["symbol"])
    if not records or not any(item.get("filings") for item in records):
        print("No usable filing-history records found.")
        return 1
    complete = sum(bool(item.get("lodr_backfill_complete")) for item in records)
    save_json(root / "filing_history.json", {
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
