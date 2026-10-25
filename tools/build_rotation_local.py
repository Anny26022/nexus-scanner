"""Build the Rotation page's data from this checkout's caches, for local testing only.

Reads the pipeline's cached OHLCV (`ohlcv_data/`, `indices_ohlcv_data/`) and the current public release's
stock rows and theme classification, then writes the rotation objects to `frontend/public/data/rotation/`
(ignored by Git) with a `local.json` pointer that the dev server reads. The release manifest is not touched.

    python3 tools/build_rotation_local.py

Run it again whenever the caches change; the daily pipeline publishes the real data. Standard library only.
"""
import csv
from collections import Counter
import gzip
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
PIPELINE = ROOT / 'DO NOT DELETE EDL PIPELINE'
PUBLIC = ROOT / 'frontend' / 'public' / 'data'
OUTPUT = PUBLIC / 'rotation'
sys.path.insert(0, str(ROOT / 'frontend'))

import rotation_history  # noqa: E402
from market_overview import index_closes  # noqa: E402


def safe_symbol(symbol):
    # The index fetcher's file naming (fetch_indices_ohlcv.get_safe_sym), without its network imports.
    return ''.join(c if c.isalnum() else '_' for c in symbol)


def closes(path, session):
    if not path.exists():
        return []
    with path.open(newline='') as handle:
        return [(row['Date'][:10], float(row['Close'])) for row in csv.DictReader(handle)
                if row.get('Close') not in (None, '') and row['Date'][:10] <= session]


def main():
    current = json.loads((PUBLIC / 'current.json').read_text())
    revision, session = current['revision'], current['sessionDate']
    generation = PUBLIC / 'revisions' / revision
    rows = json.loads(gzip.decompress((generation / 'stocks.json.gz').read_bytes()))['stocks']
    classification = json.loads(gzip.decompress((generation / 'theme-classification.json.gz').read_bytes()))
    if classification['version'] != current['themeClassificationVersion']:
        sys.exit('Classification release mismatch; rebuild the complete release first.')
    taxonomy = classification['records']
    started = time.perf_counter()
    def stock_closes(symbol):
        return closes(PIPELINE / 'ohlcv_data' / f'{symbol}.csv', session)
    # A newer index snapshot must not turn stale stock caches into flat current prices.
    latest = Counter()
    for row in rows:
        points = stock_closes(row['symbol'])
        if points:
            latest[points[-1][0]] += 1
    price_date, covered = latest.most_common(1)[0] if latest else ('', 0)
    if covered < .9 * len(rows):
        sys.exit('Refresh the stock OHLCV caches: no session has 90% coverage.')
    history_path = PIPELINE / 'all_indices_history_v2.json.gz'
    source_bytes = {'all_indices_history_v2.json.gz': history_path.read_bytes()} if history_path.exists() else {}
    benchmarks = {code: index_closes(PIPELINE, source_bytes, symbol, price_date, csv_name=safe_symbol(symbol))[0]
                  for code, symbol in rotation_history.BENCHMARK_INDICES.items()}
    missing = sorted(code for code, points in benchmarks.items() if not points)
    if not benchmarks['N50']:
        sys.exit('No Nifty 50 history in indices_ohlcv_data; run the pipeline once to fill the caches.')
    ledger_path = OUTPUT / 'ledger.json.gz'
    ledger = json.loads(gzip.decompress(ledger_path.read_bytes())) if ledger_path.exists() else None
    index, shards, ledger = rotation_history.build(session, rows, stock_closes, benchmarks, taxonomy, ledger,
        price_date=price_date, classification_version=classification['version'])
    for stale in OUTPUT.glob('*.json.gz') if OUTPUT.exists() else []:
        if stale != ledger_path:
            stale.unlink()
    digest = rotation_history.write_objects(OUTPUT, index, shards)
    ledger_path.write_bytes(gzip.compress(json.dumps(ledger, separators=(',', ':'), sort_keys=True).encode(), mtime=0))
    (OUTPUT / 'local.json').write_text(json.dumps({'index': digest, 'sessionDate': session}) + '\n')
    last = index['frames']['D'][-1]
    print(f"Rotation data for {session} (prices to {last}): {len(index['stocks'])} stocks, {len(index['groups'])} groups"
          f" in {time.perf_counter() - started:.1f}s -> {OUTPUT.relative_to(ROOT)}")
    if last != session:
        print(f'Stock caches end on {last}; refresh them to include the {session} release session.')
    if missing:
        print('No cached history for benchmarks: ' + ', '.join(missing) + ' (left out)')


if __name__ == '__main__':
    main()
