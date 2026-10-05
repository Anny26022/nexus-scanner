"""Build dated Nexus strength ranks and base episodes from canonical candles."""
from __future__ import annotations
import numpy as np
import pandas as pd
from .bases import detect_bases, finite, ratio


def normalize_frames(frames):
    output = {}
    for symbol, source in frames.items():
        frame = source.copy().reset_index(drop=True)
        frame['Date'] = pd.to_datetime(frame.Date)
        if frame.Date.duplicated().any() or not frame.Date.is_monotonic_increasing:
            raise ValueError(f'{symbol}: candle dates must increase strictly')
        if not frame.empty:
            output[symbol] = frame
    return output


def strength_history(frames):
    """Front-weighted 63/126/189/252-session returns, ranked among aligned peers.

    The peer universe is the current eligible Nexus publication universe. This
    must be disclosed for historical research: it is not survivorship-free.
    Missing prices are never filled across suspended or absent sessions.
    """
    frames = normalize_frames(frames)
    if not frames: return pd.DataFrame()
    closes = pd.concat({symbol:frame.set_index('Date').Close for symbol,frame in frames.items()},axis=1).sort_index()
    score = None
    for period, weight in ((63,.4),(126,.2),(189,.2),(252,.2)):
        returns = closes / closes.shift(period) - 1
        score = returns * weight if score is None else score + returns * weight
    ranks = score.rank(axis=1,method='average')
    counts = score.notna().sum(axis=1)
    ranks = 1 + (ranks-1).div((counts-1).replace(0,np.nan),axis=0)*98
    return ranks


def trend_context(frame, index, ranks=None, listing_date=None):
    prefix=frame.iloc[:index+1]
    close=float(prefix.Close.iloc[-1]); values={}
    for kind in ('SMA','EMA'):
        for period in (10,20,50,100,150,200):
            series=prefix.Close.rolling(period,min_periods=period).mean() if kind=='SMA' else prefix.Close.ewm(span=period,adjust=False,min_periods=period).mean()
            current=finite(series.iloc[-1])
            values[f'{kind.lower()}{period}']=current
            values[f'distance{kind}{period}']=None if current is None else (close/current-1)*100
            values[f'slope{kind}{period}']=ratio(current-series.iloc[-22],series.iloc[-22])*100 if current is not None and len(series)>21 and ratio(current-series.iloc[-22],series.iloc[-22]) is not None else None
        for a,b in ((50,200),(150,200),(10,20),(20,50)):
            left,right=values[f'{kind.lower()}{a}'],values[f'{kind.lower()}{b}']
            values[f'ratio{kind}{a}_{b}']=None if left is None or right is None else ratio(left,right)
    money=prefix.Close*prefix.Volume/1e7
    values['medianTurnover20']=finite(money.tail(20).median()) if len(prefix)>=20 else None
    values['distanceClosing52wHigh']=(prefix.Close.tail(252).max()-close)/prefix.Close.tail(252).max()*100
    values['aboveClosing52wLow']=(close/prefix.Close.tail(252).min()-1)*100
    # A truncated candle cache must never masquerade as the listing age.
    listing = pd.to_datetime(listing_date, errors='coerce')
    values['listingAgeWeeks'] = None if pd.isna(listing) or listing > prefix.Date.iloc[-1] else (prefix.Date.iloc[-1]-listing).days/7
    if ranks is not None:
        values['rsRating']=finite(ranks[index])
        for days in (5,22):
            values[f'rsChange{days}']=finite(ranks[index]-ranks[index-days]) if index>=days else None
    return values


def build_base_records(frames, stocks):
    frames=normalize_frames(frames)
    ranks=strength_history(frames) if frames else pd.DataFrame()
    output={}
    # Industry comparisons are equal-weight peer returns, include the subject,
    # and use today's taxonomy. Unknown industry is unavailable.
    peer_returns={}
    for symbol,frame in frames.items():
        industry=stocks[symbol].get('industry')
        if not industry or str(industry).lower() in ('unclassified','n/a'): continue
        for days in (63,252):
            if len(frame)>days:
                peer_returns.setdefault((industry,days),[]).append((symbol,float(frame.Close.iloc[-1]/frame.Close.iloc[-1-days]-1)*100))
    for symbol,frame in frames.items():
        rank=ranks[symbol].reindex(frame.Date).to_numpy(float)
        episodes=detect_bases(frame,symbol,rs=rank)
        for episode in episodes:
            marker=episode['base']['endDate']
            index=int(frame.index[frame.Date.dt.strftime('%Y-%m-%d').eq(marker)][0])
            episode['selection']=trend_context(frame,index,rank,stocks[symbol].get('listing_date'))
            episode['current']=trend_context(frame,len(frame)-1,rank,stocks[symbol].get('listing_date'))
            for days in (63,252):
                peers=peer_returns.get((stocks[symbol].get('industry'),days),[])
                subject=next((value for name,value in peers if name==symbol),None)
                episode['current'][f'industryRelative{days}']=subject-float(np.mean([value for _,value in peers])) if subject is not None and len(peers)>=3 else None
            episode['strengthUniverse']='CURRENT_NEXUS_ELIGIBLE'
        output[symbol]=episodes
    return output


def compact_base_records(episodes):
    """One deterministic episode per stage; every filter sees the same record."""
    selected = {}
    for stage in ('FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT'):
        candidates = [e for e in episodes if e['stage']==stage and e['base']['ageSessions']>=e['config']['min_sessions']]
        if not candidates: continue
        episode = max(candidates,key=lambda e:((e['breakout'] or {}).get('date',e['base']['startDate']),e['id']))
        selected[stage] = {key:episode[key] for key in (
            'id','stage','pivot','distanceFromPivotPct','breakout','breakoutAgeSessions',
            'holdsPivot','continuousHolding','belowPivotCloses','breakoutFailure',
            'returnSinceBreakoutPct','selection','current')}
        selected[stage]['base'] = {key:value for key,value in episode['base'].items() if key!='parts'}
    return selected
