"""Replay frozen breakout qualifications with next-open execution and costs.

This evaluates known breakout-day facts. It never uses the episode's current
rank, current pivot distance, final lifecycle stage or future outcome to decide
whether to enter. Historical membership still uses today's eligible universe.
"""
from __future__ import annotations
import pandas as pd
from .base_conditions import evaluate_base_condition
from .presets import get_preset
from .base_presets import materialize_base_preset
from .base_execution import net_return, trade_facts, validate_costs, position_size


def replay_breakouts(frame,episodes,preset_id='lib-nexus-fresh-breakouts',fee_bps=10,slippage_bps=10, *, preset_parameters=None, capital=None, risk_pct=1.5, max_position_pct=100):
    """Horizon N exits at the Nth session close after next-session open entry.

    Fixed-horizon outcomes are measured independently of stop/trail exits.
    A stop or armed-trail close signal executes at the following session open.
    Incomplete entries/exits and horizon observations stay unavailable.
    """
    validate_costs(fee_bps,slippage_bps)
    position_size(100,92,capital,risk_pct,max_position_pct,fee_bps,slippage_bps)
    preset=get_preset(preset_id)
    parameters=dict(preset_parameters or {})
    if not preset.get('setupFamily') and (parameters.get('minContractionLegs',0) or parameters.get('maxContractionLegRatio',1)!=1 or any(key in parameters for key in ('contractionMethod','athPolicy','requireFirstBase','setupStage'))):raise ValueError('Setup policies require a setup-family preset')
    if preset.get('setupFamily'):parameters['setupStage']='FRESH_BREAKOUT'
    leaves=materialize_base_preset(preset,parameters)['children']
    if any(leaf['params'].get('stage')!='FRESH_BREAKOUT' for leaf in leaves):
        raise ValueError('Breakout replay requires a fresh-breakout preset')
    frame=frame.copy().reset_index(drop=True)
    frame['Date']=pd.to_datetime(frame.Date)
    if frame.Date.duplicated().any() or not frame.Date.is_monotonic_increasing: raise ValueError('Replay requires strictly increasing candle dates')
    positions={str(value.date()):index for index,value in enumerate(frame.Date)}
    dates=list(positions)
    opens=frame.Open.to_numpy(float)
    trades=[]
    for episode in episodes:
        if episode.get('breakout') is None: continue
        trigger=positions.get(episode['breakout']['date'])
        if trigger is None: raise ValueError('Breakout event lies outside replay history')
        # Qualification overrides only lifecycle scalars; frozen measurements
        # are read-only. Avoid copying every base slice for rejected episodes.
        record=dict(episode)
        record.update(stage='FRESH_BREAKOUT',breakoutAgeSessions=0,distanceFromPivotPct=episode['breakout']['throughPct'],holdsPivot=True,continuousHolding=True)
        results=[evaluate_base_condition({'FRESH_BREAKOUT':record},leaf['kind'],leaf['params']) for leaf in leaves]
        if not all(result is True for result in results): continue
        execution=trade_facts(dates,opens,episode,positions,fee_bps,slippage_bps,risk_pct=risk_pct,max_position_pct=max_position_pct,capital=capital)
        row={'baseId':episode['id'],'symbol':episode['symbol'],'signalDate':episode['breakout']['date'],
             'entryDate':None,'entryPrice':None,'execution':'NEXT_SESSION_OPEN','feeBpsPerSide':fee_bps,
             'slippageBpsPerSide':slippage_bps,'sizing':execution['sizing'],'capitalReturnPct':execution['capitalReturnPct'],'outcomes':{},'tradeExit':None}
        if trigger+1>=len(frame):
            row['outcomes']={str(h):None for h in (5,20,60)};trades.append(row);continue
        entry_index=trigger+1;entry=execution['entryPrice']
        row.update(entryDate=str(frame.Date.iloc[entry_index].date()),entryPrice=entry)
        for horizon in (5,20,60):
            exit_index=entry_index+horizon-1
            if exit_index>=len(frame):row['outcomes'][str(horizon)]=None;continue
            window=frame.iloc[entry_index:exit_index+1];price=float(window.Close.iloc[-1])
            row['outcomes'][str(horizon)]={'exitDate':str(window.Date.iloc[-1].date()),
                'grossReturnPct':(price/entry-1)*100,'netReturnPct':net_return(entry,price,fee_bps,slippage_bps),
                'maxAdverseExcursionPct':min(0,(float(window.Low.min())/entry-1)*100),
                'maxFavorableExcursionPct':max(0,(float(window.High.max())/entry-1)*100),
                'closedInsideBase':bool((window.Close<episode['pivot']).any())}
        if execution['status']=='CLOSED':
            row['tradeExit']={'signalDate':execution['exitSignalDate'],'executionDate':execution['executionDate'],
                'price':execution['exitPrice'],'reason':execution['exitReason'],
                'netReturnPct':execution['netRealizedReturnPct']}
        trades.append(row)
    summary={}
    for horizon in ('5','20','60'):
        available=[trade['outcomes'][horizon] for trade in trades if trade['outcomes'][horizon] is not None]
        summary[horizon]={'complete':len(available),'incomplete':len(trades)-len(available),
            'meanNetReturnPct':sum(item['netReturnPct'] for item in available)/len(available) if available else None,
            'failurePct':sum(item['closedInsideBase'] for item in available)/len(available)*100 if available else None}
    return {'schemaVersion':1,'presetId':preset_id,'presetParameters':parameters,'capital':capital,'riskPct':risk_pct,'maxPositionPct':max_position_pct,'trades':trades,'summary':summary,
            'membershipBasis':'CURRENT_NEXUS_ELIGIBLE','execution':'NEXT_SESSION_OPEN',
            'assumptions':['No historical constituent reconstruction','Fixed-horizon outcomes continue after trade exits','Costs applied to both entry and exit','No intraday stop execution assumed','Planned risk can be exceeded by next-open gaps','Per-signal sizing only; simultaneous positions are not a portfolio backtest']}
