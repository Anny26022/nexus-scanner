"""Build the US pipeline root: the same files India's root holds, so India's shared stages run on it unchanged.

    snapshot (one Dhan call) -> screenable universe -> price history (seed, or append the closed session)
    -> benchmark ETFs as indices -> breadth -> per-stock metrics -> stock artifact -> RS ratings

Amounts: US records carry honest dollar fields (`market_cap`, `dollar_volume`). The shared engine reads amounts
from India-named fields (`market_cap_crore`, `rupee_volume`, `daily_rupee_turnover_50_cr`, ...); `engine_amounts`
fills those in this market's amount unit, millions of dollars, and the published snapshot declares that unit.
"""

from __future__ import annotations

import gzip
import json
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from advanced_metrics_processor import process_symbol_csv
import build_rs_ratings
from edl_pipeline.breadth.config import load_methodology
from edl_pipeline.breadth.indices import generate_all_index_history
from edl_pipeline.breadth.pipeline import generate_market_breadth
from edl_pipeline.scanner.indicators import indicator_series
from ohlcv_utils import symbol_csv_path
from pipeline_utils import resource_path

from .. import UNITED_STATES
from . import calendar, dhan, fields, history, tradingview
from .universe import SCREENABLE, security_type

# Benchmark ETFs stand in for indices; SPY is the market benchmark for RS and breadth.
BENCHMARKS = {'SPY': 'S&P 500 (SPY)', 'QQQ': 'Nasdaq-100 (QQQ)', 'IWM': 'Russell 2000 (IWM)', 'DIA': 'Dow Jones (DIA)'}
BENCHMARK = UNITED_STATES.benchmark
# India's breadth methodology with US floors, in Dhan's US amount unit (millions of dollars).
BREADTH_FLOORS = {'version': 'mbi-xp-v2.2-us', 'minimum_price': 1.0, 'minimum_market_cap_crore': 100.0}
AMOUNT_UNIT = UNITED_STATES.provider_amount_unit
# The processor's India-unit amounts; this market's amounts come from engine_amounts instead.
INDIA_AMOUNTS = frozenset({'rupee_volume', 'avg_rupee_volume_20'})


class SnapshotNotReady(RuntimeError):
    """The snapshot is still trading, or has not yet caught up with the last closed session."""


def _write_json(path: Path, payload, compress: bool = False):
    data = json.dumps(payload, separators=(',', ':'), allow_nan=False, default=str).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    (path.with_name(path.name + '.gz') if compress else path).write_bytes(gzip.compress(data, mtime=0) if compress else data)


def _compress(path: Path):
    """India's shared readers take the .json.gz artifacts."""
    path.with_name(path.name + '.gz').write_bytes(gzip.compress(path.read_bytes(), mtime=0))


def snapshot_session(rows: list[dict], now: datetime) -> str:
    """The closed session the snapshot holds, or SnapshotNotReady."""
    if calendar.is_us_cash_session(now):
        raise SnapshotNotReady('The US session is still trading; run after the close.')
    session = calendar.last_closed_session(now)
    stamps = [stamp for stamp in (fields.canonical_row(row) or {} for row in rows) if stamp.get('provider_last_trade_ist')]
    latest = max((datetime.fromisoformat(stamp['provider_last_trade_ist']) for stamp in stamps), default=None)
    if latest is None or latest.astimezone(calendar.EASTERN).date() != session:
        raise SnapshotNotReady(f'The snapshot has not caught up with the {session} session (latest trade {latest}).')
    return session.isoformat()


def engine_amounts(record: dict, metrics: dict) -> dict:
    """The shared engine's India-named amount fields, in millions of dollars (see the module docstring)."""
    market_cap = record.get('market_cap')
    return {
        'market_cap_crore': market_cap / AMOUNT_UNIT if market_cap is not None else None,
        # The row engine divides this by ₹1 crore; the publisher restates it in this market's unit.
        'rupee_volume': record.get('dollar_volume'),
        **{f'daily_rupee_turnover_{period}_cr': metrics.get(f'turnover{period}') for period in (20, 50, 100)},
    }


def stock_metrics(path: Path) -> dict:
    """Per-stock technicals from its history, by India's own processor on the NYSE calendar, plus RSI(14)."""
    _symbol, metrics = process_symbol_csv(str(path), calendar.is_nyse_session_day)
    if not metrics:
        return {}
    frame = pd.read_csv(path)
    # The canonical scanner metrics are the processor's snake_case keys; its titled keys are India's display columns.
    result = {key: value for key, value in metrics.items()
              if key.isidentifier() and key == key.lower() and key not in INDIA_AMOUNTS}
    rsi = indicator_series(frame, 'RSI', 14).iloc[-1] if len(frame) > 14 else None
    result['rsi14'] = round(float(rsi), 2) if rsi is not None and pd.notna(rsi) else None
    traded = frame['Close'] * frame['Volume']
    for period in (20, 50, 100):
        result[f'turnover{period}'] = round(float(traded.tail(period).mean()) / AMOUNT_UNIT, 4) if len(frame) >= period else None
    return result


def stock_record(record: dict, metrics: dict, session: str) -> dict:
    """The canonical record the shared engine and publisher read."""
    aligned = metrics.get('as_of_date') == session
    return {
        # History-based values win over the snapshot's own (the 52-week distances), when the history has them.
        **record, **{key: value for key, value in metrics.items() if not key.startswith('turnover') and value is not None},
        **engine_amounts(record, metrics),
        'schema_version': '3.0', 'industry': None, 'listing_board': 'MAINBOARD', 'is_sme': False, 'listing_series': None,
        'default_screener_eligible': True, 'index_memberships': [], 'event_markers': [], 'recent_announcements': [],
        'news_feed': [], 'as_of_date': session if aligned else metrics.get('as_of_date'),
        # Only TradingView's (markets/us/tradingview.py): Dhan's history starts in 2021, so its high is not all-time.
        'all_time_high': record.get('all_time_high'), 'percent_from_ath': record.get('percent_from_ath'),
        # India's names for the trailing returns the snapshot carries.
        'return_1m': record.get('perf_1m'), 'return_1y': record.get('perf_12m'),
        'return_3y': record.get('perf_3y'), 'return_5y': record.get('perf_5y'),
    }


def update_histories(records: list[dict], directory: Path, session: str, *, interval: float, workers: int) -> dict:
    """Bring every file up to the session; full fetches are paced and stop at the first rate limit."""
    pacer, stopped, counts, lock = dhan.Pacer(interval), threading.Event(), {}, threading.Lock()

    def fetch(symbol, security_id, exchange):
        if stopped.is_set():
            return []
        pacer.wait()
        try:
            return history.fetch_full(symbol, security_id, exchange)
        except dhan.Throttled:
            stopped.set()
            return []

    def one(record):
        try:
            status = history.update(record, directory, session, fetch=fetch)
        except Exception as error:  # one stock's history must not stop the market
            print(f"  history {record['symbol']}: {error}", flush=True)
            status = 'failed'
        with lock:
            counts[status] = counts.get(status, 0) + 1

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, records))
    return {**counts, 'throttled': stopped.is_set()}


def build(root: Path, now: datetime | None = None, *, interval: float = 0.25, workers: int = 3, limit: int | None = None) -> dict:
    """Write the US root for the last closed session; returns a run report."""
    now = now or datetime.now(timezone.utc)
    stock_rows, etf_rows = dhan.fetch_universe('stock'), dhan.fetch_universe('etf')
    session = snapshot_session(stock_rows, now)
    rows = [row for row in stock_rows if security_type(row.get('Sym') or '', row.get('DispSym')) in SCREENABLE]
    rows = rows[:limit] if limit else rows
    records = [record for record in map(fields.canonical_row, rows) if record]
    for record in records:
        record['security_type'] = security_type(record['symbol'], record['name'])
    benchmarks = [record for record in map(fields.canonical_row, etf_rows) if record and record['symbol'] in BENCHMARKS]

    report = {'session': session, 'screenable': len(records), 'listed': len(stock_rows)}
    report['tradingview'] = tradingview.enrich(records, session)
    report['history'] = update_histories(records, root / 'ohlcv_data', session, interval=interval, workers=workers)
    report['benchmarks'] = update_histories(benchmarks, root / 'indices_ohlcv_data', session, interval=interval, workers=1)

    _write_json(root / 'mainboard_scanx_data.json', rows)
    methodology_path = root / 'breadth_methodology.json'
    _write_json(methodology_path, {**json.loads(resource_path('breadth_methodology.json').read_text()), **BREADTH_FLOORS})
    methodology = load_methodology(methodology_path)
    generated_at = now.isoformat()
    generate_all_index_history(
        index_rows=[{'Symbol': symbol, 'IndexName': name} for symbol, name in BENCHMARKS.items()],
        indices_dir=root / 'indices_ohlcv_data', output_path=root / 'all_indices_history_v2.json',
        output_sessions=methodology.output_sessions, rounding_digits=methodology.rounding_digits, generated_at=generated_at)
    generate_market_breadth(
        universe_rows=rows, ohlcv_dir=root / 'ohlcv_data', index_csv=root / 'indices_ohlcv_data' / f'{BENCHMARK}.csv',
        methodology=methodology, output_path=root / 'market_breadth_v2.json', snapshot_path=root / 'breadth_universe_snapshot.json',
        generated_at=generated_at, preparation_workers=0)
    for name in ('all_indices_history_v2.json', 'market_breadth_v2.json'):
        _compress(root / name)

    stocks = [stock_record(record, stock_metrics(symbol_csv_path(root / 'ohlcv_data', record['symbol'])), session)
              for record in records if symbol_csv_path(root / 'ohlcv_data', record['symbol']).exists()]
    _write_json(root / 'all_stocks_fundamental_analysis.json', stocks, compress=True)
    report['stocks'] = len(stocks)
    report['aligned'] = sum(stock['as_of_date'] == session for stock in stocks)
    report['rs_ratings'] = build_rs_ratings.main(root, f'{BENCHMARK}.csv', BENCHMARKS[BENCHMARK])
    # Phase 2 fills statements and earnings; the publisher still reads these files.
    _write_json(root / 'quarterly_financial_history.json', {'records': []}, compress=True)
    _write_json(root / 'ipo_screener.json', {'records': []}, compress=True)
    return report


def reset(root: Path):
    """Remove a root's generated files but keep its price history (the expensive part)."""
    for path in root.iterdir() if root.exists() else []:
        if path.name not in {'ohlcv_data', 'indices_ohlcv_data'}:
            shutil.rmtree(path) if path.is_dir() else path.unlink()
