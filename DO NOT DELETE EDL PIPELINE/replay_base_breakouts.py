"""Run a local, reproducible breakout replay; output stays outside Git by default."""
from pathlib import Path
import argparse
from datetime import date
import sys
import pandas as pd
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'src'))
from build_chart_artifacts import _artifact, _write_gzip_json
from standardize_stock_artifact import canonicalize_stock
from edl_pipeline.scanner.base_publication import build_base_records
from edl_pipeline.scanner.base_replay import replay_breakouts


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=ROOT)
    parser.add_argument('--symbols',help='Optional comma-separated symbols; RS still uses the full eligible universe')
    parser.add_argument('--output',type=Path)
    parser.add_argument('--fee-bps',type=float,default=10)
    parser.add_argument('--slippage-bps',type=float,default=10)
    args=parser.parse_args()
    stocks={row['symbol']:row for item in _artifact(args.root,'all_stocks_fundamental_analysis.json',[]) if (row:=canonicalize_stock(item)).get('symbol') and row.get('default_screener_eligible',True)}
    if not stocks:parser.error('Canonical eligible stocks are required')
    session=max(str(row.get('as_of_date') or '')[:10] for row in stocks.values())
    date.fromisoformat(session)  # Reject an absent or invalid publication session.
    frames={}
    for symbol in stocks:
        path=args.root/'ohlcv_data'/f'{symbol}.csv'
        if not path.exists():continue
        frame=pd.read_csv(path,parse_dates=['Date'])
        frame=frame.loc[frame.Date<=pd.Timestamp(session)].reset_index(drop=True)
        if not frame.empty and str(frame.Date.iloc[-1].date())==session:frames[symbol]=frame
    if not frames:parser.error('Aligned local OHLCV histories are required')
    episodes=build_base_records(frames,stocks)
    requested={symbol.strip().upper() for symbol in args.symbols.split(',')} if args.symbols else set(frames)
    missing=requested-set(frames)
    if missing:parser.error('Missing aligned history: '+', '.join(sorted(missing)))
    reports={symbol:replay_breakouts(frames[symbol],episodes[symbol],fee_bps=args.fee_bps,slippage_bps=args.slippage_bps) for symbol in sorted(requested)}
    payload={'schemaVersion':1,'asOfDate':session,'symbols':reports,'membershipBasis':'CURRENT_NEXUS_ELIGIBLE',
             'note':'Current-universe historical replay; not survivorship-free. Defaults have not been optimized.'}
    output=args.output or args.root/'.scanner_cache/base-replay.json.gz'
    _write_gzip_json(output,payload)
    print(f'Wrote {len(reports)} symbol replays to {output}')
    return 0

if __name__=='__main__':raise SystemExit(main())
