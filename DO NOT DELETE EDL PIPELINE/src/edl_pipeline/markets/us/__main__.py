"""Build the US root: `PYTHONPATH=src python -m edl_pipeline.markets.us <root> [--limit N]` from the pipeline folder.

Exits 75 (EX_TEMPFAIL) when the snapshot is not yet for a closed session: the workflow then skips publication.
"""

import argparse
import json
import sys
from pathlib import Path

from .build import SnapshotNotReady, build

# The share of stocks whose history reached the session below which the release is not published.
MIN_ALIGNED_SHARE = 0.9


def _budget(value):
    seconds = float(value)
    if not 0 <= seconds < float('inf'):
        raise argparse.ArgumentTypeError('the page budget must be a finite number of seconds, 0 or more')
    return seconds


def main(argv=None):
    parser = argparse.ArgumentParser(prog='python -m edl_pipeline.markets.us')
    parser.add_argument('root', type=Path, help='the US root (price history is kept between runs)')
    parser.add_argument('--limit', type=int, help='only the first N stocks by market cap (local checks)')
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--interval', type=float, default=0.25, help='seconds between history requests')
    parser.add_argument('--page-budget', type=_budget, default=1200,
                        help='seconds to spend fetching stock pages; the rest wait for the next run')
    args = parser.parse_args(argv)
    try:
        report = build(args.root, interval=args.interval, workers=args.workers, limit=args.limit, page_budget=args.page_budget)
    except SnapshotNotReady as error:
        print(f'::warning::{error}', flush=True)
        return 75
    print(json.dumps(report, indent=2), flush=True)
    history, benchmarks = report['history'], report['benchmarks']
    # A rate limit or missing benchmark leaves a partial market: publish nothing rather than a thin release. The
    # benchmarks (SPY and the other index ETFs) carry RS, breadth and rotation, so any one of them failing stops it too.
    # `benchmarks_behind` checks each one's file reached the session (an ETF absent from the list reports no status).
    lagging_benchmarks = sum(benchmarks.get(status, 0) for status in ('failed', 'missing')) + len(report.get('benchmarks_behind', []))
    if history.get('throttled') or benchmarks.get('throttled') or lagging_benchmarks or not report['rs_ratings']:
        print('::error::The US history is incomplete (rate limited, a benchmark behind or no RS ratings); nothing to publish.',
              flush=True)
        return 1
    # A wide provider failure leaves stocks on earlier sessions; a normal day has about 96% on the session.
    # Counted against every screenable stock: one whose first fetch failed has no file and no record in `stocks`.
    eligible = max(report.get('screenable', 0), report['stocks'])
    if eligible and report['aligned'] / eligible < MIN_ALIGNED_SHARE:
        print(f"::error::Only {report['aligned']} of {eligible} US stocks reached {report['session']}; nothing to publish.",
              flush=True)
        return 1
    if history.get('yahoo_throttled') or benchmarks.get('yahoo_throttled'):
        print('::warning::Yahoo rate limited the history seed; the rest seeded from Dhan (2021 onwards) and lack deep history.',
              flush=True)
    if history.get('failed'):
        # One stock's failure keeps its earlier bars (its as_of_date lags); the count is shown on the run.
        print(f"::warning::{history['failed']} US stock histories could not be refreshed and stay at an earlier session.", flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
