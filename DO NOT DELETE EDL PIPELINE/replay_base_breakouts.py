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
from edl_pipeline.scanner.base_publication import load_history_audits, build_base_records
from edl_pipeline.scanner.base_replay import replay_breakouts
from edl_pipeline.scanner.bases import BaseConfig


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=ROOT)
    parser.add_argument('--symbols',help='Optional comma-separated symbols; RS still uses the full eligible universe')
    parser.add_argument('--as-of',help='Optional replay cutoff (YYYY-MM-DD); defaults to the stock artifact session')
    parser.add_argument('--output',type=Path)
    parser.add_argument('--fee-bps',type=float,default=10)
    parser.add_argument('--slippage-bps',type=float,default=10)
    parser.add_argument('--stop-pct',type=float,default=8)
    parser.add_argument('--trail-period',type=int,default=50)
    parser.add_argument('--preset',default='lib-nexus-fresh-breakouts')
    parser.add_argument('--capital',type=float,help='Optional capital for integer-share sizing')
    parser.add_argument('--risk-pct',type=float,default=1.5)
    parser.add_argument('--max-position-pct',type=float,default=100)
    parser.add_argument('--breakeven-gain-pct',type=float,default=0,help='0 disables cost-aware breakeven arming')
    parser.add_argument('--max-depth-pct',type=float,default=60)
    parser.add_argument('--contraction-noise-pct',type=float,default=5)
    parser.add_argument('--min-contraction-legs',type=int,default=0)
    parser.add_argument('--max-contraction-leg-ratio',type=float,default=1)
    parser.add_argument('--contraction-method',choices=('RAW_TR','WILDER_ATR','SIMPLE_ATR'))
    parser.add_argument('--ath-policy',choices=('CLOSING_AVAILABLE','INTRADAY_AVAILABLE','AUDITED_INTRADAY'))
    parser.add_argument('--first-base-policy',choices=('REQUIRE','ALLOW'))
    parser.add_argument('--min-prior-advance-pct',type=float,default=0)
    parser.add_argument('--reclaim200-within',type=int,default=0)
    parser.add_argument('--slope-turn200-within',type=int,default=0)
    parser.add_argument('--above50-persistence',type=int,default=1)
    parser.add_argument('--min-breakout-volume',type=float,default=1.5)
    parser.add_argument('--min-breakout-close-in-range',type=float,default=0.7)
    parser.add_argument('--max-breakout-extension-pct',type=float,default=5)
    parser.add_argument('--max-breakout-age',type=int,default=5)
    parser.add_argument('--strict-contraction-legs',action='store_true')
    parser.add_argument('--require-accumulation',action='store_true')
    parser.add_argument('--require-rising200',action='store_true')
    parser.add_argument('--require-breakout-confirmation',action='store_true')
    args=parser.parse_args()
    config=BaseConfig(stop_pct=args.stop_pct,trail_period=args.trail_period,fee_bps=args.fee_bps,slippage_bps=args.slippage_bps,risk_pct=args.risk_pct,max_position_pct=args.max_position_pct,breakeven_gain_pct=args.breakeven_gain_pct,max_depth_pct=args.max_depth_pct,contraction_noise_pct=args.contraction_noise_pct)
    try:config.validate()
    except ValueError as error:parser.error(str(error))
    from edl_pipeline.scanner.base_execution import position_size
    from edl_pipeline.scanner.base_presets import materialize_base_preset
    from edl_pipeline.scanner.presets import get_preset
    parameters={'minContractionLegs':args.min_contraction_legs,'maxContractionLegRatio':args.max_contraction_leg_ratio}
    if args.contraction_method is not None:parameters['contractionMethod']=args.contraction_method
    if args.ath_policy is not None:parameters['athPolicy']=args.ath_policy
    if args.first_base_policy is not None:parameters['requireFirstBase']=args.first_base_policy=='REQUIRE'
    policy_keys={'minPriorAdvancePct':'min_prior_advance_pct','reclaim200Within':'reclaim200_within','slopeTurn200Within':'slope_turn200_within','above50Persistence':'above50_persistence','minBreakoutVolume':'min_breakout_volume','minBreakoutCloseInRange':'min_breakout_close_in_range','maxBreakoutExtensionPct':'max_breakout_extension_pct','maxBreakoutAge':'max_breakout_age','strictContractionLegs':'strict_contraction_legs','requireAccumulation':'require_accumulation','requireRising200':'require_rising200','requireBreakoutConfirmation':'require_breakout_confirmation'}
    try:
        preset=get_preset(args.preset)
        if preset.get('setupFamily'):
            if '--max-depth-pct' in sys.argv or any(arg.startswith('--max-depth-pct=') for arg in sys.argv):parameters['maxBaseDepth']=args.max_depth_pct
            parameters.update({key:getattr(args,value) for key,value in policy_keys.items()})
            parameters['setupStage']='FRESH_BREAKOUT'
            if args.strict_contraction_legs and not args.min_contraction_legs:parameters['minContractionLegs']=2
        elif any(flag in sys.argv for flag in ('--'+value.replace('_','-') for value in policy_keys.values())):raise ValueError('Setup policies require a setup-family preset')
        if not preset.get('setupFamily') and (args.min_contraction_legs or args.max_contraction_leg_ratio!=1 or args.contraction_method is not None or args.ath_policy is not None or args.first_base_policy is not None):raise ValueError('Setup policies require a setup-family preset')
        position_size(100,92,args.capital,args.risk_pct,args.max_position_pct,args.fee_bps,args.slippage_bps)
        materialize_base_preset(preset,parameters)
    except ValueError as error:parser.error(str(error))
    stocks={row['symbol']:row for item in _artifact(args.root,'all_stocks_fundamental_analysis.json',[]) if (row:=canonicalize_stock(item)).get('symbol') and row.get('default_screener_eligible',True)}
    if not stocks:parser.error('Canonical eligible stocks are required')
    metadata_session=max(str(row.get('as_of_date') or '')[:10] for row in stocks.values())
    session=args.as_of or metadata_session
    try:date.fromisoformat(session)
    except ValueError:parser.error('Replay cutoff must be a valid YYYY-MM-DD date')
    frames={}
    for symbol in stocks:
        path=args.root/'ohlcv_data'/f'{symbol}.csv'
        if not path.exists():continue
        frame=pd.read_csv(path,parse_dates=['Date'])
        frame=frame.loc[frame.Date<=pd.Timestamp(session)].reset_index(drop=True)
        if not frame.empty and str(frame.Date.iloc[-1].date())==session:frames[symbol]=frame
    if not frames:parser.error('Aligned local OHLCV histories are required')
    requested={symbol.strip().upper() for symbol in args.symbols.split(',')} if args.symbols else set(frames)
    missing=requested-set(frames)
    if missing:parser.error('Missing aligned history: '+', '.join(sorted(missing)))
    reports={}
    def replay_symbol(symbol, episodes):
        reports[symbol]=replay_breakouts(frames[symbol],episodes,preset_id=args.preset,fee_bps=args.fee_bps,slippage_bps=args.slippage_bps,preset_parameters=parameters,capital=args.capital,risk_pct=args.risk_pct,max_position_pct=args.max_position_pct)
    # Evaluate every historical episode before releasing it, preserving full
    # replay coverage without retaining the universe's raw episodes together.
    build_base_records(frames,stocks,config=config,symbols=requested,episode_sink=replay_symbol,setup_candidates=bool(preset.get('setupFamily')),history_audits=load_history_audits(args.root))
    from dataclasses import asdict
    payload={'detectorConfig':asdict(config),'schemaVersion':2,'asOfDate':session,'metadataAsOfDate':metadata_session,'symbols':reports,'membershipBasis':'CURRENT_NEXUS_ELIGIBLE',
             'note':'Current-universe historical replay; not survivorship-free. Defaults have not been optimized.'}
    output=args.output or args.root/'.scanner_cache/base-replay.json.gz'
    _write_gzip_json(output,payload)
    print(f'Wrote {len(reports)} symbol replays to {output}')
    return 0

if __name__=='__main__':raise SystemExit(main())
