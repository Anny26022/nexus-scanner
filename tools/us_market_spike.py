"""Phase 0 check of Dhan's US data against the NYSE calendar. Read-only; prints a JSON report.

    python tools/us_market_spike.py [--sample 12] [--pages 3] [--interval 0.35]

Pulls the US stock and ETF lists, maps them to canonical records, then, for a sample of stocks across the size
range, fetches full daily history and checks every bar against the NYSE calendar: bars dated on non-session days,
sessions missing from the run of bars, and the latest bar against the last closed session. Finally reads a few
stocks' pages for statement depth. Paced (one request per --interval seconds); stops if Dhan rate-limits.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1] / 'DO NOT DELETE EDL PIPELINE'
for path in (PIPELINE / 'src', PIPELINE):
    sys.path.insert(0, str(path))

from edl_pipeline.markets.us import calendar, dhan, fields  # noqa: E402


def session_days(start: date, end: date):
    day = start
    while day <= end:
        if calendar.is_nyse_session_day(day):
            yield day
        day += timedelta(days=1)


def check_history(bars: list[dict]) -> dict:
    dates = [date.fromisoformat(bar['date']) for bar in bars]
    if not dates:
        return {'bars': 0}
    present = set(dates)
    return {
        'bars': len(dates), 'first': dates[0].isoformat(), 'last': dates[-1].isoformat(),
        'non_session_bars': [day.isoformat() for day in dates if not calendar.is_nyse_session_day(day)],
        'missing_sessions': [day.isoformat() for day in session_days(dates[0], dates[-1]) if day not in present],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--sample', type=int, default=12, help='stocks to fetch history for')
    parser.add_argument('--pages', type=int, default=3, help='stock pages to read')
    parser.add_argument('--interval', type=float, default=0.35, help='seconds between paced requests')
    args = parser.parse_args(argv)
    pacer = dhan.Pacer(args.interval)
    now = datetime.now(timezone.utc)
    report = {'run_at': now.isoformat(), 'last_closed_session': calendar.last_closed_session(now).isoformat(),
              'in_session': calendar.is_us_cash_session(now)}

    universe = {}
    for kind in ('stock', 'etf'):
        rows = dhan.fetch_universe(kind)
        records = [record for record in map(fields.canonical_row, rows) if record]
        universe[kind] = records
        filled = Counter(key for record in records for key, value in record.items() if value not in (None, ''))
        report[kind] = {
            'rows': len(rows), 'records': len(records),
            'by_exchange': dict(Counter(record['exchange'] for record in records).most_common()),
            'fill_rate': {key: round(count / len(records), 3) for key, count in sorted(filled.items())},
        }

    stocks = universe['stock']
    step = max(1, len(stocks) // args.sample)
    sample = stocks[::step][:args.sample]
    histories = []
    try:
        for record in sample:
            pacer.wait()
            bars = dhan.fetch_history(record['symbol'], record['security_id'], record['exchange'],
                                      now - timedelta(days=365 * 8), now)
            histories.append({'symbol': record['symbol'], 'exchange': record['exchange'],
                              'market_cap': record['market_cap'], **check_history(bars)})
        report['history'] = histories
        pages = StockPagesReport(pacer)
        report['pages'] = [pages.read(record) for record in stocks[:args.pages] if record.get('slug')]
    except dhan.Throttled as error:
        report['throttled'] = str(error)
    json.dump(report, sys.stdout, indent=2, default=str)
    print()
    return 0


class StockPagesReport:
    def __init__(self, pacer):
        self.pacer = pacer
        self.pages = dhan.StockPages()

    def read(self, record: dict) -> dict:
        self.pacer.wait()
        props = self.pages.fetch(record['slug'])
        statements = props.get('fundamentalsData') or {}
        return {
            'symbol': record['symbol'],
            'annual_years': (statements.get('incomeStat_sy') or {}).get('YEAR'),
            'quarters': (statements.get('incomeStat_sq') or {}).get('YEAR'),
            'classification': {key: (statements.get('CV') or {}).get(key) for key in ('SECTOR', 'INDUSTRY_NAME', 'SUB_SECTOR')},
            'analyst_ratings': props.get('analystRatingData'),
            'corporate_actions': [item.get('act_type') for item in props.get('corporateActionData') or []],
        }


if __name__ == '__main__':
    raise SystemExit(main())
