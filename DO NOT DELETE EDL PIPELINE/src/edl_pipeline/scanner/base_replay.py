"""Replay frozen breakout qualifications with next-open execution and costs.

This evaluates known breakout-day facts. It never uses the episode's current
rank, current pivot distance, final lifecycle stage or future outcome to decide
whether to enter. Historical membership still uses today's eligible universe.
"""
from __future__ import annotations
import math
import pandas as pd
from .base_conditions import evaluate_base_condition
from .presets import get_preset


def net_return(entry,exit,fee_bps,slippage_bps):
    cost=(fee_bps+slippage_bps)/10000
    return (exit*(1-cost)/(entry*(1+cost))-1)*100


def replay_breakouts(frame,episodes,preset_id='lib-nexus-fresh-breakouts',fee_bps=10,slippage_bps=10):
    """Horizon N exits at the Nth session close after next-session open entry.

    Fixed-horizon outcomes are measured independently of stop/trail exits.
    A stop or armed-trail close signal executes at the following session open.
    Incomplete entries/exits and horizon observations stay unavailable.
    """
    for value in (fee_bps,slippage_bps):
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not 0<=value<=1000:
            raise ValueError('Execution costs must be finite basis points between 0 and 1000')
    preset=get_preset(preset_id)
    leaves=preset['expression']['children']
    if any(leaf['params'].get('stage')!='FRESH_BREAKOUT' for leaf in leaves):
        raise ValueError('Breakout replay requires a fresh-breakout preset')
    frame=frame.copy().reset_index(drop=True)
    frame['Date']=pd.to_datetime(frame.Date)
    if frame.Date.duplicated().any() or not frame.Date.is_monotonic_increasing: raise ValueError('Replay requires strictly increasing candle dates')
    positions={str(value.date()):index for index,value in enumerate(frame.Date)}
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
        row={'baseId':episode['id'],'symbol':episode['symbol'],'signalDate':episode['breakout']['date'],
             'entryDate':None,'entryPrice':None,'execution':'NEXT_SESSION_OPEN','feeBpsPerSide':fee_bps,
             'slippageBpsPerSide':slippage_bps,'outcomes':{},'tradeExit':None}
        if trigger+1>=len(frame):
            row['outcomes']={str(h):None for h in (5,20,60)};trades.append(row);continue
        entry_index=trigger+1;entry=float(frame.Open.iloc[entry_index])
        if not math.isfinite(entry) or entry<=0: raise ValueError('Replay entry price must be finite and positive')
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
        exit=episode.get('exit')
        if exit and exit['date'] in positions:
            index=positions[exit['date']]+1
            if index<len(frame):
                price=float(frame.Open.iloc[index])
                row['tradeExit']={'signalDate':exit['date'],'executionDate':str(frame.Date.iloc[index].date()),
                    'price':price,'reason':exit['reason'],'netReturnPct':net_return(entry,price,fee_bps,slippage_bps)}
        trades.append(row)
    summary={}
    for horizon in ('5','20','60'):
        available=[trade['outcomes'][horizon] for trade in trades if trade['outcomes'][horizon] is not None]
        summary[horizon]={'complete':len(available),'incomplete':len(trades)-len(available),
            'meanNetReturnPct':sum(item['netReturnPct'] for item in available)/len(available) if available else None,
            'failurePct':sum(item['closedInsideBase'] for item in available)/len(available)*100 if available else None}
    return {'schemaVersion':1,'presetId':preset_id,'trades':trades,'summary':summary,
            'membershipBasis':'CURRENT_NEXUS_ELIGIBLE','execution':'NEXT_SESSION_OPEN',
            'assumptions':['No historical constituent reconstruction','Fixed-horizon outcomes continue after trade exits','Costs applied to both entry and exit','No intraday stop execution assumed']}
