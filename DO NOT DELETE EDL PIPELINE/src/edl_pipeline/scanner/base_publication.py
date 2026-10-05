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


def trend_series(frame, ranks=None, listing_date=None):
    """Calculate causal context columns once, rather than once per episode."""
    close=frame.Close.astype(float); values={}
    for kind in ('SMA','EMA'):
        for period in (10,20,50,100,150,200):
            series=close.rolling(period,min_periods=period).mean() if kind=='SMA' else close.ewm(span=period,adjust=False,min_periods=period).mean()
            values[f'{kind.lower()}{period}']=series
            values[f'distance{kind}{period}']=(close/series-1)*100
            values[f'slope{kind}{period}']=(series/series.shift(21)-1)*100
        for a,b in ((50,200),(150,200),(10,20),(20,50)):
            values[f'ratio{kind}{a}_{b}']=values[f'{kind.lower()}{a}']/values[f'{kind.lower()}{b}']
    values['medianTurnover20']=(close*frame.Volume/1e7).rolling(20,min_periods=20).median()
    highest=close.rolling(252,min_periods=252).max();lowest=close.rolling(252,min_periods=252).min()
    values['distanceClosing52wHigh']=(highest-close)/highest*100
    values['aboveClosing52wLow']=(close/lowest-1)*100
    listing=pd.to_datetime(listing_date,errors='coerce')
    values['historyFromListing']=float(abs((frame.Date.iloc[0]-listing).days)<=7) if pd.notna(listing) else np.nan
    values['historySessions']=pd.Series(np.arange(1,len(frame)+1),index=frame.index)
    values['listingAgeWeeks']=(frame.Date-listing).dt.days/7 if pd.notna(listing) else np.nan
    if ranks is not None:
        ranks=pd.Series(ranks,index=frame.index,dtype=float)
        values['rsRating']=ranks
        for days in (5,22): values[f'rsChange{days}']=ranks-ranks.shift(days)
    # Absolute averages are intermediate columns; the condition contract exposes
    # distances, slopes and ratios. Do not duplicate unused values in every episode.
    values={key:value for key,value in values.items() if not key.startswith(('sma','ema'))}
    return pd.DataFrame(values,index=frame.index).replace([np.inf,-np.inf],np.nan)


def trend_context(frame,index,ranks=None,listing_date=None):
    return {key:finite(value) for key,value in trend_series(frame,ranks,listing_date).iloc[index].items()}


def build_base_records(frames, stocks, benchmarks=None, rank_history=None, config=None, symbols=None, selected_only=False):
    frames=normalize_frames(frames)
    requested=set(frames) if symbols is None else set(symbols)
    missing=requested-set(frames)
    if missing:raise ValueError('Missing aligned history: '+', '.join(sorted(missing)))
    ranks=strength_history(frames) if frames else pd.DataFrame()
    output={}
    closes=pd.concat({symbol:frame.set_index('Date').Close for symbol,frame in frames.items()},axis=1).sort_index() if frames else pd.DataFrame()
    industries={}
    for symbol in frames:
        industry=stocks[symbol].get('industry')
        if industry and str(industry).lower() not in ('unclassified','n/a'):
            industries.setdefault(industry,[]).append(symbol)
    industry_context={}
    for days in (63,252):
        returns=(closes/closes.shift(days)-1)*100
        for industry,symbols in industries.items():
            peers=returns[symbols]
            industry_context[(industry,days)]=peers.mean(axis=1).where(peers.count(axis=1)>=3)
    industry_breadth={}
    for period in (50,200):
        averages=closes.rolling(period,min_periods=period).mean()
        flags=(closes>averages).astype(float).where(closes.notna()&averages.notna())
        for industry,symbols in industries.items():
            peers=flags[symbols]
            industry_breadth[(industry,period)]=(peers.mean(axis=1)*100).where(peers.count(axis=1)>=3)
    benchmark=(benchmarks or {}).get('NIFTY_500')
    if benchmark is None:benchmark=(benchmarks or {}).get('NIFTY500')
    benchmark_close=None
    if benchmark is not None and not benchmark.empty:
        date_key='Date' if 'Date' in benchmark else 'date'
        price_key='Close' if 'Close' in benchmark else 'close'
        benchmark_close=benchmark.set_index(date_key)[price_key].reindex(closes.index)
    for symbol,frame in frames.items():
        if symbol not in requested:continue
        rank=ranks[symbol].reindex(frame.Date).to_numpy(float)
        if rank_history is not None:
            rank_history[symbol]={'dates':[str(day.date()) for day in frame.Date], 'ratings':[finite(value) for value in rank]}
        episodes=detect_bases(frame,symbol,config=config,rs=rank)
        if selected_only:
            episodes=list(selected_base_episodes(episodes).values())
        context_rows=trend_series(frame,rank,stocks[symbol].get('listing_date'))
        for days in (5,22):
            context_rows[f'rsChange{days}']=(ranks[symbol]-ranks[symbol].shift(days)).reindex(frame.Date).to_numpy(float)
        for days in (63,252):
            peers=industry_context.get((stocks[symbol].get('industry'),days))
            own=(closes[symbol]/closes[symbol].shift(days)-1)*100
            context_rows[f'industryRelative{days}']=(own-peers).reindex(frame.Date).to_numpy(float) if peers is not None else np.nan
        for period in (50,200):
            peers=industry_breadth.get((stocks[symbol].get('industry'),period))
            context_rows[f'industryAboveSMA{period}Pct']=peers.reindex(frame.Date).to_numpy(float) if peers is not None else np.nan
        if benchmark_close is not None:
            line=closes[symbol]/benchmark_close
            rolling=line.rolling(252,min_periods=252).max()
            signal=(line>=rolling).astype(float).where(rolling.notna() & line.notna())
            context_rows['rsLineAtHigh']=signal.reindex(frame.Date).to_numpy(float)
            trend=benchmark_close.rolling(200,min_periods=200).mean()
            context_rows['benchmarkDistanceSMA200']=((benchmark_close/trend-1)*100).reindex(frame.Date).to_numpy(float)
        else:
            context_rows['rsLineAtHigh']=np.nan
            context_rows['benchmarkDistanceSMA200']=np.nan
        dates={str(day.date()):i for i,day in enumerate(frame.Date)}
        current={key:finite(value) for key,value in context_rows.iloc[-1].items()}
        selections={}
        for episode in episodes:
            marker=episode['base']['endDate']
            index=dates[marker]
            if index not in selections:
                selections[index]={key:finite(value) for key,value in context_rows.iloc[index].items()}
            # These context observations are read-only publication inputs.
            # Overlapping episodes share current facts and dated observations.
            episode['selection']=selections[index]
            episode['current']=current
            episode['strengthUniverse']='CURRENT_NEXUS_ELIGIBLE'
        output[symbol]=episodes
    return output


PUBLIC_CONTEXT_KEYS={
    'medianTurnover20','distanceClosing52wHigh','aboveClosing52wLow','listingAgeWeeks',
    'historyFromListing','historySessions','rsRating','rsChange5','rsChange22',
    'industryRelative63','industryRelative252','rsLineAtHigh','benchmarkDistanceSMA200',
    'industryAboveSMA50Pct','industryAboveSMA200Pct','distanceSMA50','distanceSMA200','slopeSMA200',
}

def selected_base_episodes(episodes):
    """Select stable episode identities independently of their output projection."""
    selected = {}
    for stage in ('FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT'):
        candidates = [e for e in episodes if e['stage']==stage and e['base']['ageSessions']>=e['config']['min_sessions']]
        if not candidates: continue
        selected[stage] = max(candidates,key=lambda e:((e['breakout'] or {}).get('date',e['base']['startDate']),e['id']))
    return selected


def compact_base_records(episodes, include_parts=False, public=False):
    """One deterministic episode per stage; every filter sees the same record."""
    selected = {}
    for stage,episode in selected_base_episodes(episodes).items():
        selected[stage] = {key:episode[key] for key in (
            'id','stage','pivot','distanceFromPivotPct','breakout','breakoutAgeSessions',
            'holdsPivot','continuousHolding','belowPivotCloses','breakoutFailure',
            'returnSinceBreakoutPct','maxGainPct','maxDrawdownPct','selection','current','failedPokeCount','parentInvalidationDate')}
        if public:
            for scope in ('selection','current'):
                selected[stage][scope]={key:value for key,value in episode[scope].items() if key in PUBLIC_CONTEXT_KEYS}
        selected[stage]['base'] = {key:value for key,value in episode['base'].items() if include_parts or key!='parts'}
    return selected
