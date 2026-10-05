#!/usr/bin/env python3
"""Read-only coverage check before validating a complete base-engine release."""
import argparse
import csv
import gzip
import json
from collections import Counter
from datetime import date
from pathlib import Path


def audit(root, session=None):
    with gzip.open(root / 'all_stocks_fundamental_analysis.json.gz', 'rt') as source:
        stocks = [row for row in json.load(source) if row.get('default_screener_eligible', True)]
    metadata_dates = Counter(str(row.get('as_of_date') or 'missing') for row in stocks)
    if session is None:
        candidates = set(metadata_dates) - {'missing'}
        if len(candidates) != 1:
            raise ValueError('Specify --session: eligible metadata has no unique session.')
        session = next(iter(candidates))
    date.fromisoformat(session)
    statuses = Counter()
    examples = {}
    for stock in stocks:
        path = root / 'ohlcv_data' / f"{stock['symbol']}.csv"
        latest = None
        if path.is_file():
            with path.open(newline='') as source:
                for candle in csv.DictReader(source):
                    candle_date = date.fromisoformat(candle['Date'][:10]).isoformat()
                    if candle_date <= session:
                        latest = max(latest or candle_date, candle_date)
        status = 'aligned' if latest == session else 'missing_history' if latest is None else 'missing_session'
        statuses[status] += 1
        if status != 'aligned' and len(examples.setdefault(status, [])) < 10:
            examples[status].append({'symbol': stock['symbol'], 'latestAtCutoff': latest})
    total = len(stocks)
    return {'session': session, 'eligibleStocks': total, 'metadataDates': dict(metadata_dates),
            'historyCounts': dict(statuses), 'alignedFraction': statuses['aligned'] / total if total else 0,
            'examples': examples, 'complete': bool(total) and statuses['aligned'] == total
            and metadata_dates.get(session, 0) == total}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1] / 'DO NOT DELETE EDL PIPELINE')
    parser.add_argument('--session', help='ISO session; default is the unique eligible metadata date.')
    args = parser.parse_args()
    try:
        report = audit(args.root, args.session)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(2, f'Alignment check failed: {error}\n')
    print(json.dumps(report, indent=2))
    return 0 if report['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
