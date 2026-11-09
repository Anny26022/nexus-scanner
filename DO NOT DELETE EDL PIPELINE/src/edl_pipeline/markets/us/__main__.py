"""Build the US root: `PYTHONPATH=src python -m edl_pipeline.markets.us <root> [--limit N]` from the pipeline folder.

Exits 75 (EX_TEMPFAIL) when the snapshot is not yet for a closed session, so a scheduler can retry later.
"""

import argparse
import json
import sys
from pathlib import Path

from .build import SnapshotNotReady, build


def main(argv=None):
    parser = argparse.ArgumentParser(prog='python -m edl_pipeline.markets.us')
    parser.add_argument('root', type=Path, help='the US root (price history is kept between runs)')
    parser.add_argument('--limit', type=int, help='only the first N stocks by market cap (local checks)')
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--interval', type=float, default=0.25, help='seconds between history requests')
    args = parser.parse_args(argv)
    try:
        report = build(args.root, interval=args.interval, workers=args.workers, limit=args.limit)
    except SnapshotNotReady as error:
        print(f'::warning::{error}', flush=True)
        return 75
    print(json.dumps(report, indent=2), flush=True)
    history = report['history']
    # A rate limit or missing benchmark leaves a partial market: publish nothing rather than a thin release.
    if history.get('throttled') or report['benchmarks'].get('throttled') or not report['rs_ratings']:
        print('::error::The US history is incomplete (rate limited or no RS ratings); nothing to publish.', flush=True)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
