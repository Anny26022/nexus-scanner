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
# More stocks than this without TradingView's bar means its bars stopped arriving for part of the market. About 360 have
# none on a normal day (2026-11-20): listings Dhan still carries that no longer trade, and a few TradingView lacks.
MAX_FALLBACKS = 800


def _budget(value):
    seconds = float(value)
    if not 0 <= seconds < float('inf'):
        raise argparse.ArgumentTypeError('the page budget must be a finite number of seconds, 0 or more')
    return seconds


def main(argv=None):
    parser = argparse.ArgumentParser(prog='python -m edl_pipeline.markets.us')
    parser.add_argument('root', type=Path, help='the US root (price history is kept between runs)')
    parser.add_argument('--limit', type=int, help='only the first N stocks by market cap (local checks)')
    parser.add_argument('--workers', type=int, default=8, help='history workers (Yahoo is paced at YAHOO_INTERVAL)')
    parser.add_argument('--interval', type=float, default=0.25, help='seconds between Dhan history requests')
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
    # Without TradingView a release has no listing dates, index memberships, earnings dates or all-time highs.
    if report['tradingview'].get('error'):
        print(f"::error::TradingView US values are unavailable ({report['tradingview']['error']}); nothing to publish.",
              flush=True)
        return 1
    # Counted on the records, not on how each history was updated, so a cold cache's full fetches count too.
    without_bar = report['tradingview'].get('without_bar', 0)
    if without_bar > MAX_FALLBACKS:
        print(f"::error::{without_bar} US stocks had no TradingView bar for the session (over {MAX_FALLBACKS}); "
              "something upstream changed, so nothing is published.", flush=True)
        return 1
    if benchmarks.get('throttled') or lagging_benchmarks or not report['rs_ratings']:
        print('::error::The US history is incomplete (a benchmark rate limited or behind, or no RS ratings); nothing to publish.',
              flush=True)
        return 1
    # A wide provider failure leaves stocks on earlier sessions; a normal day has about 96% on the session.
    # Counted against every screenable stock: one whose first fetch failed has no file and no record in `stocks`.
    eligible = max(report.get('screenable', 0), report['stocks'])
    if eligible and report['aligned'] / eligible < MIN_ALIGNED_SHARE:
        print(f"::error::Only {report['aligned']} of {eligible} US stocks reached {report['session']}; nothing to publish.",
              flush=True)
        return 1
    # Dhan is the stocks' last resort, for the few Yahoo lacks (SPAC rights and CVRs, 31 on 2026-11-22), and it refuses
    # GitHub's runners. Those stocks stay out until a source has them; a wide failure fails the share check above.
    if history.get('throttled'):
        print(f"::warning::Dhan refused the stock-history fallback; {history.get('missing', 0)} stocks have no history.",
              flush=True)
    if history.get('yahoo_throttled') or benchmarks.get('yahoo_throttled'):
        print('::warning::Yahoo rate limited the history; the rest came from Dhan (new stocks seeded from 2021 onwards).',
              flush=True)
    if history.get('failed'):
        # One stock's failure keeps its earlier bars (its as_of_date lags); the count is shown on the run.
        print(f"::warning::{history['failed']} US stock histories could not be refreshed and stay at an earlier session.", flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
