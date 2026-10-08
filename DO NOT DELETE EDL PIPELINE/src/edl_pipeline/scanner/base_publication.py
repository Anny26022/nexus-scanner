"""Build dated Nexus strength ranks and base episodes from canonical candles."""
from __future__ import annotations
from dataclasses import replace
import numpy as np
import pandas as pd
from .bases import BaseConfig, detect_bases, finite, ratio
from .indicators import true_range, wilder_average


def load_history_audits(root):
    """Optional, independently verified provenance; absence is not certification."""
    import gzip
    import json
    from pathlib import Path
    root=Path(root)
    compressed=root/'base_history_audits.json.gz'
    plain=root/'base_history_audits.json'
    if plain.exists():payload=json.loads(plain.read_text())
    elif compressed.exists():
        with gzip.open(compressed,'rt') as source:payload=json.load(source)
    else:return {}
    if not isinstance(payload,dict) or any(not isinstance(value,dict) for value in payload.values()):raise ValueError('History audits must map symbols to provenance objects')
    return payload


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
            values[f'{kind.lower()}{period}MonthAgo']=series.shift(21)
            values[f'distance{kind}{period}']=(close/series-1)*100
            values[f'slope{kind}{period}']=(series/series.shift(21)-1)*100
        for a,b in ((50,200),(150,200),(10,20),(20,50)):
            values[f'ratio{kind}{a}_{b}']=values[f'{kind.lower()}{a}']/values[f'{kind.lower()}{b}']
    turnover=pd.to_numeric(frame.get('Turnover',pd.Series(index=frame.index,dtype=float)),errors='coerce')
    turnover=turnover.where(np.isfinite(turnover)&(turnover>=0))
    values['medianTurnover20']=(turnover/1e7).rolling(20,min_periods=20).median()
    raw_tr=true_range(frame)/close*100
    for period in (10,20,50,100,200):values[f'trMeanPct{period}']=raw_tr.rolling(period,min_periods=period).mean()
    values['historicalClosingHigh']=close.expanding().max()
    values['historicalIntradayHigh']=frame.High.expanding().max()
    values['atrWilder14Pct']=wilder_average(true_range(frame),14)/close*100
    values['atrSimple14Pct']=true_range(frame).rolling(14,min_periods=14).mean()/close*100
    values['adrClose14Pct']=((frame.High-frame.Low)/close*100).rolling(14,min_periods=14).mean()
    values['adrLow14Pct']=((frame.High-frame.Low)/frame.Low*100).rolling(14,min_periods=14).mean()
    above=close>values['sma50']
    values['aboveSMA50Sessions']=above.astype(int).groupby((~above).cumsum()).cumsum()
    values['aboveSMA50Sessions']=values['aboveSMA50Sessions'].where(above,0).where(values['sma50'].notna())
    for name,signal in (('reclaimSMA200',(close>values['sma200'])&(close.shift(1)<=values['sma200'].shift(1))),('slopeTurnSMA200',(values['slopeSMA200']>0)&(values['slopeSMA200'].shift(1)<=0))):
        events=pd.Series(np.where(signal,np.arange(len(frame)),np.nan),index=frame.index).ffill()
        values[name+'Age']=pd.Series(np.arange(len(frame)),index=frame.index)-events
    values['price']=close
    values['turnoverCr']=turnover/1e7
    values['volume']=frame.Volume.astype(float)
    for period in (10,20,50,100,200):
        values[f'averageTurnover{period}']=(turnover/1e7).rolling(period,min_periods=period).mean()
        values[f'averageVolume{period}']=frame.Volume.rolling(period,min_periods=period).mean()
    highest=close.rolling(252,min_periods=252).max();lowest=close.rolling(252,min_periods=252).min()
    values['closing52wHigh']=highest;values['closing52wLow']=lowest
    intraday_high=frame.High.rolling(252,min_periods=252).max();intraday_low=frame.Low.rolling(252,min_periods=252).min()
    values['intraday52wHigh']=intraday_high;values['intraday52wLow']=intraday_low
    values['distanceIntraday52wHigh']=(intraday_high-close)/intraday_high*100
    values['aboveIntraday52wLow']=(close/intraday_low-1)*100
    values['distanceClosing52wHigh']=(highest-close)/highest*100
    values['aboveClosing52wLow']=(close/lowest-1)*100
    listing=pd.to_datetime(listing_date,errors='coerce')
    values['historyFromListing']=float(abs((frame.Date.iloc[0]-listing).days)<=7) if pd.notna(listing) else np.nan
    values['historySessions']=pd.Series(np.arange(1,len(frame)+1),index=frame.index)
    values['listingAgeWeeks']=(frame.Date-listing).dt.days/7 if pd.notna(listing) else np.nan
    if ranks is not None:
        ranks=pd.Series(ranks,index=frame.index,dtype=float)
        values['rsRating']=ranks
        values['rsMonthAgo']=ranks.shift(22)
        for days in (5,22): values[f'rsChange{days}']=ranks-ranks.shift(days)
    return pd.DataFrame(values,index=frame.index).replace([np.inf,-np.inf],np.nan)


def trend_context(frame,index,ranks=None,listing_date=None):
    return {key:finite(value) for key,value in trend_series(frame,ranks,listing_date).iloc[index].items()}


def prepare_base_peer_context(frames, stocks, benchmarks=None):
    """Compute dated cross-sectional context once for a fixed publication input."""
    frames=normalize_frames(frames)
    ranks=strength_history(frames) if frames else pd.DataFrame()
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
    return {'frames':frames,'ranks':ranks,'closes':closes,'industry_context':industry_context,'industry_breadth':industry_breadth,'benchmark_close':benchmark_close}


def build_base_records(frames, stocks, benchmarks=None, rank_history=None, config=None, symbols=None, selected_only=False, episode_sink=None, history_audits=None, setup_candidates=False, rank_sink=None, peer_context=None):
    if selected_only and episode_sink is not None:
        raise ValueError('Complete archives require all episodes before stage selection.')
    peer_context=peer_context if peer_context is not None else prepare_base_peer_context(frames,stocks,benchmarks)
    frames=peer_context['frames']
    config=config or BaseConfig()
    requested=set(frames) if symbols is None else set(symbols)
    missing=requested-set(frames)
    if missing:raise ValueError('Missing aligned history: '+', '.join(sorted(missing)))
    ranks=peer_context['ranks'];closes=peer_context['closes']
    industry_context=peer_context['industry_context'];industry_breadth=peer_context['industry_breadth']
    benchmark_close=peer_context['benchmark_close'];output={}
    for symbol,frame in sorted(frames.items()):
        if symbol not in requested:continue
        rank=ranks[symbol].reindex(frame.Date).to_numpy(float)
        if rank_history is not None or rank_sink is not None:
            ledger={'dates':[str(day.date()) for day in frame.Date], 'ratings':[finite(value) for value in rank]}
            if rank_history is not None:rank_history[symbol]=ledger
            if rank_sink is not None:rank_sink(symbol,ledger)
        episodes=detect_bases(frame,symbol,config=config,rs=rank)
        if setup_candidates:
            for basis in ('CLOSE','HIGH'):
                candidates=detect_bases(frame,symbol,config=replace(config,pivot_basis=basis,max_depth_pct=95,candidate_policy='SETUP'),rs=rank)
                for candidate in candidates:candidate['setupCandidateOnly']=True
                episodes += candidates
        mature=sorted((e for e in episodes if e.get('pivotBasis','CLOSE')=='CLOSE' and (not setup_candidates or e.get('setupCandidateOnly')) and e.get('structuralQualifiedDate')),key=lambda e:(e['structuralQualifiedDate'],e['base']['startDate'],e['id']))
        first_id=mature[0]['id'] if mature else None
        context_rows=trend_series(frame,rank,stocks[symbol].get('listing_date'))
        for days in (5,22):
            context_rows[f'rsChange{days}']=(ranks[symbol]-ranks[symbol].shift(days)).reindex(frame.Date).to_numpy(float)
        context_rows['rsMonthAgo']=ranks[symbol].shift(22).reindex(frame.Date).to_numpy(float)
        stock=stocks[symbol]
        listing=pd.to_datetime(stock.get('listing_date'),errors='coerce')
        observed_index=pd.DatetimeIndex(frame.Date)
        calendar=closes.index
        calendar_known=pd.notna(listing) and calendar[0]<=listing
        if calendar_known:
            expected=np.searchsorted(calendar.values,observed_index.values,side='right')-np.searchsorted(calendar.values,listing.to_datetime64(),side='left')
            actual=np.cumsum((observed_index>=listing).astype(int))
            missing=np.maximum(0,expected-actual)
            context_rows['listingAgeSessions']=expected
            context_rows['listingAgeSessionWeeks']=expected/5
            context_rows['historyMissingSessions']=missing
            context_rows['historyCoverageComplete']=((missing==0)&(context_rows['historyFromListing']==1)).astype(float)
        else:
            for key in ('listingAgeSessions','listingAgeSessionWeeks','historyMissingSessions','historyCoverageComplete'):context_rows[key]=np.nan
        audit=(history_audits or {}).get(symbol,{})
        verified=audit.get('pricesAdjusted') is True and audit.get('sessionsVerified') is True and isinstance(audit.get('source'),str) and bool(audit['source']) and str(audit.get('throughDate'))==str(frame.Date.iloc[-1].date()) and str(audit.get('historyStartDate'))==str(listing.date()) if pd.notna(listing) else False
        context_rows['lifetimePriceHistoryVerified']=np.where(context_rows['historyCoverageComplete']==1,1 if verified else np.nan,np.where(context_rows['historyCoverageComplete']==0,0,np.nan))
        cap=finite(stock.get('market_cap_crore'))
        aligned=str(stock.get('as_of_date'))==str(frame.Date.iloc[-1].date())
        context_rows['marketCapCr']=frame.Close/frame.Close.iloc[-1]*cap if aligned and cap is not None else np.nan
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
            episode['selection']={**selections[index],'distanceFromPivotPct':(frame.Close.iloc[index]/episode['pivot']-1)*100,'pivotVsHistoricalIntradayHigh':(episode['pivot']/context_rows['historicalIntradayHigh'].iloc[index]-1)*100}
            episode['current']={**current,'distanceFromPivotPct':(frame.Close.iloc[-1]/episode['pivot']-1)*100,'pivotVsHistoricalIntradayHigh':(episode['pivot']/context_rows['historicalIntradayHigh'].iloc[-1]-1)*100}
            episode['firstEligibleBase']=None if episode['selection']['historyCoverageComplete'] is None else int(episode['id']==first_id) if episode['selection']['historyCoverageComplete']==1 else None
            episode['historyCoverage']={'basis':'OBSERVED_RELEASE_MARKET_SESSION_LEDGER','firstDate':str(frame.Date.iloc[0].date()),'lastDate':str(frame.Date.iloc[-1].date()),'missingSessions':current.get('historyMissingSessions'),'adjustmentAuditSource':audit.get('source') if verified else None}
            episode['strengthUniverse']='CURRENT_NEXUS_ELIGIBLE'
        if selected_only and not setup_candidates:episodes=list(selected_base_episodes(episodes).values())
        if episode_sink is not None:
            # Archive one symbol before releasing its historical episodes. Runtime
            # publication needs only the same deterministic stage selections.
            episode_sink(symbol, episodes)
            output[symbol]=runtime_base_records(episodes) if setup_candidates else list(selected_base_episodes(episodes).values())
        else:
            output[symbol]=runtime_base_records(episodes) if selected_only and setup_candidates else episodes
    return output


PUBLIC_BASE_KEYS={'floor','quietTurnoverCr','medianTurnoverCr','startDate','endDate','ageSessions','ageWeeks','ageCalendarWeeks','depthPct','atrContraction','atrSimpleContraction','trueRangeContraction','volumeDryUp','overheadPct','overheadPriceDistancePct','level','rsAverage','upDownVolumeRatio','netUpDownVolume','quietDepth','quietAgeSessions','nestedCount','touchCount','squatCount','contractionLegCount','contractionMaxRatio','contractionFinalDepthPct'}


PUBLIC_CONTEXT_KEYS={
    'marketCapCr','listingAgeSessionWeeks','listingAgeSessions','distanceFromPivotPct','medianTurnover20','distanceClosing52wHigh','aboveClosing52wLow','listingAgeWeeks',
    'historyFromListing','historySessions','rsRating','rsChange5','rsChange22',
    'distanceSMA50','distanceSMA200','slopeSMA200',
}

def selected_base_episodes(episodes):
    """Select stable episode identities independently of their output projection."""
    selected = {}
    for stage in ('FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT'):
        candidates = [e for e in episodes if not e.get('setupCandidateOnly') and e.get('pivotBasis','CLOSE')=='CLOSE' and e['stage']==stage and e['base']['ageSessions']>=e['config']['min_sessions']]
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
            'returnSinceBreakoutPct','maxGainPct','maxDrawdownPct','measurementPolicy','firstEligibleBase','historyCoverage','breakevenArmed','breakevenArmedDate','breakoutFailed','exitSignaled','tradeClosed','selection','current','failedPokeCount','parentInvalidationDate','exit','trade')}
        if public:
            for scope in ('selection','current'):
                selected[stage][scope]={key:value for key,value in episode[scope].items() if key in PUBLIC_CONTEXT_KEYS}
        selected[stage]['base'] = {key:value for key,value in episode['base'].items() if (include_parts or key!='parts') and (not public or key in PUBLIC_BASE_KEYS)}
    return selected


SETUP_CONTEXT_KEYS = PUBLIC_CONTEXT_KEYS | {'historyCoverageComplete','lifetimePriceHistoryVerified','pivotVsHistoricalIntradayHigh','historicalIntradayHigh','aboveSMA50Sessions','reclaimSMA200Age','slopeTurnSMA200Age'}
SETUP_BASE_KEYS = PUBLIC_BASE_KEYS | {'priorAdvance63Pct'}

def setup_candidate_records(episodes):
    """Return every compact family witness for charts and replay consumers."""
    keys={'id','symbol','stage','pivot','pivotBasis','structuralQualifiedDate','firstEligibleBase','setupCandidateOnly','distanceFromPivotPct','breakout','breakoutAgeSessions','holdsPivot','continuousHolding','config'}
    family_records=[e for e in episodes if e.get('setupCandidateOnly')]
    source=family_records if family_records else episodes
    source=[e for e in source if e['stage'] in ('FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT') and e['base']['ageSessions']>=e['config']['min_sessions']]
    return [{**{key:e[key] for key in keys if key in e},
             'base':{key:value for key,value in e['base'].items() if key in SETUP_BASE_KEYS},
             **{scope:{key:value for key,value in e[scope].items() if key in SETUP_CONTEXT_KEYS} for scope in ('current','selection')}}
            for e in source]


# These fields are the complete dependency set for the four latest-session
# setup families.  Historical archives retain the complete episode object.
RUNTIME_SETUP_CONTEXT_KEYS = {
    'aboveClosing52wLow','aboveSMA50Sessions','distanceClosing52wHigh',
    'distanceFromPivotPct','distanceSMA50','distanceSMA200',
    'historyCoverageComplete','historyFromListing','lifetimePriceHistoryVerified',
    'listingAgeSessionWeeks','marketCapCr','medianTurnover20',
    'pivotVsHistoricalIntradayHigh','reclaimSMA200Age','rsChange22','rsRating',
    'slopeSMA200','slopeTurnSMA200Age',
}
RUNTIME_SETUP_BASE_KEYS = {
    'startDate','endDate','ageSessions','ageWeeks','atrContraction','atrSimpleContraction',
    'contractionLegCount','contractionMaxRatio','depthPct','netUpDownVolume',
    'overheadPct','priorAdvance63Pct','trueRangeContraction','volumeDryUp',
}
RUNTIME_SETUP_TOP_KEYS = {'id','symbol','stage','pivot','pivotBasis','firstEligibleBase','setupCandidateOnly',
                        'distanceFromPivotPct','breakoutAgeSessions','holdsPivot','continuousHolding'}
RUNTIME_SETUP_BREAKOUT_KEYS = {'date','volumeRatio','closeInRange','throughPct'}
RUNTIME_COMPLETED_SETUPS_PER_BASIS = 2


def _eligible_setup_candidates(episodes):
    family=[episode for episode in episodes if episode.get('setupCandidateOnly')]
    source=family if family else episodes
    return [episode for episode in source
            if episode.get('stage') in ('FORMING','FRESH_BREAKOUT','HOLDING','PLAYED_OUT')
            and episode.get('base',{}).get('ageSessions',0)>=episode.get('config',{}).get('min_sessions',0)]


def runtime_setup_candidate_history_complete(episodes):
    """Whether a live pack contains every completed family witness."""
    eligible=_eligible_setup_candidates(episodes)
    return all(sum(episode['stage']=='PLAYED_OUT' and episode.get('pivotBasis','CLOSE')==basis
                   for episode in eligible)<=RUNTIME_COMPLETED_SETUPS_PER_BASIS
               for basis in ('CLOSE','HIGH'))


def runtime_setup_candidate_records(episodes):
    """Project bounded, latest-session setup witnesses for Worker packs.

    Forming, fresh and holding candidates remain available because they can
    qualify a live scan.  Completed outcomes are research history: retain the
    two latest witnesses per pivot basis for the latest-session endpoint and
    keep every episode in ``base-history`` for durable replay.  This prevents
    years of played-out pivots from inflating a live 100-symbol shard beyond
    the Worker decoded-memory limit.
    """
    eligible=_eligible_setup_candidates(episodes)
    live=[episode for episode in eligible if episode['stage']!='PLAYED_OUT']
    completed=[]
    for basis in ('CLOSE','HIGH'):
        candidates=sorted((episode for episode in eligible
                           if episode['stage']=='PLAYED_OUT' and episode.get('pivotBasis','CLOSE')==basis),
                          key=lambda episode:(str((episode.get('breakout') or {}).get('date') or episode.get('base',{}).get('startDate') or ''),str(episode.get('id',''))), reverse=True)
        completed.extend(candidates[:RUNTIME_COMPLETED_SETUPS_PER_BASIS])
    keys=RUNTIME_SETUP_TOP_KEYS
    def project(episode):
        record={key:episode[key] for key in keys if key in episode}
        record['base']={key:value for key,value in episode.get('base',{}).items() if key in RUNTIME_SETUP_BASE_KEYS}
        breakout=episode.get('breakout')
        if isinstance(breakout,dict):
            record['breakout']={key:value for key,value in breakout.items() if key in RUNTIME_SETUP_BREAKOUT_KEYS}
        scope='current' if episode['stage']=='FORMING' else 'selection'
        record[scope]={key:value for key,value in episode.get(scope,{}).items() if key in RUNTIME_SETUP_CONTEXT_KEYS}
        return record
    return [project(episode) for episode in sorted(live+completed,key=lambda episode:(str((episode.get('breakout') or {}).get('date') or episode.get('base',{}).get('startDate') or ''),str(episode.get('id',''))))]

def runtime_base_records(episodes):
    selected=list(selected_base_episodes(episodes).values())
    selected_ids={e['id'] for e in selected}
    return selected+[e for e in setup_candidate_records(episodes) if e['id'] not in selected_ids]


def compact_setup_match(episode):
    """A public witness with the same ID and pivot used during qualification."""
    record=setup_candidate_records([episode])[0]
    record.pop('config',None)
    for scope in ('current','selection'):
        record[scope]={key:value for key,value in record[scope].items() if key in PUBLIC_CONTEXT_KEYS}
    return record
