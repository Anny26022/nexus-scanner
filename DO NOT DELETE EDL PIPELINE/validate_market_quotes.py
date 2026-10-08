"""Retry inconsistent ScanX mainboard quotes once, then fail before enrichment."""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / 'src'))
from edl_pipeline.quality import ohlc_error
from edl_pipeline.transforms.fundamentals import get_optional_float
from fetch_dhan_data import fetch_market_snapshot
from pipeline_utils import load_json, resolve_path, save_json


def quote_errors(rows, symbols):
    rejected = []
    for row in rows:
        if row.get('Sym') not in symbols:
            continue
        values = {key: get_optional_float(row.get(source)) for key, source in
                  (('open', 'Open'), ('high', 'High'), ('low', 'Low'), ('close', 'Ltp'))}
        values['volume'] = get_optional_float(row.get('Volume', row.get('volume')))
        missing = [key for key, value in values.items() if value is None]
        error = ('missing OHLCV fields: ' + ', '.join(missing)) if missing else ohlc_error(values)
        if error:
            rejected.append({'symbol': row['Sym'], 'error': error, 'ohlcv': values, 'raw_quote': row})
    return rejected


def main():
    path = resolve_path('dhan_data_response.json')
    rows = load_json(path)
    symbols = {row['Symbol'] for row in load_json('master_isin_map.json')}
    rejected = quote_errors(rows, symbols)
    report = {'source': 'ScanX live quote (Ltp with Open/High/Low)',
              'snapshot_received_at': datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
              'checked_at': datetime.now(timezone.utc).isoformat(),
              'rejected': rejected, 'retry_received_at': None, 'retry_quotes': [],
              'retry_error': None, 'errors': []}
    if rejected:
        print(f"Retrying one market snapshot for inconsistent quotes: {', '.join(row['symbol'] for row in rejected)}")
        affected = {row['symbol'] for row in rejected}
        try:
            retry = fetch_market_snapshot()
            report['retry_received_at'] = datetime.now(timezone.utc).isoformat()
            report['retry_quotes'] = [row for row in retry if row.get('Sym') in affected]
            # A different listing/security must never replace the original quote.
            replacements = {(row.get('Sym'), row.get('Isin'), str(row.get('Sid'))): row for row in retry}
            refreshed = []
            for row in rows:
                replacement = replacements.get((row.get('Sym'), row.get('Isin'), str(row.get('Sid'))))
                if row.get('Sym') in affected and replacement is not None:
                    # Apply the same completeness and consistency policy to retries.
                    if not quote_errors([replacement], affected):
                        row = replacement
                refreshed.append(row)
            rows = refreshed
        except Exception as error:
            report['retry_error'] = str(error)
        report['errors'] = quote_errors(rows, symbols)
    save_json('price_validation_report.json', report)
    if report['errors']:
        print('Price validation rejected: ' + '; '.join(f"{row['symbol']}: {row['error']}" for row in report['errors']))
        return 1
    if rejected:
        save_json(path, rows)
        save_json('mainboard_scanx_data.json', [row for row in rows if row.get('Sym') in symbols])
    print(f'Price validation passed for {len(symbols)} mainboard symbols.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
