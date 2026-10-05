"""Causal base episodes and frozen breakout measurements.

A closing-price high becomes a candidate after a configured pullback. Candidates
are independent ceilings; descendants start inside an older candidate's range.
Only information available at each close can create or update an episode.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
import hashlib
import json
import math
import numpy as np
import pandas as pd
from .indicators import true_range, wilder_average
from .base_execution import trade_facts, validate_costs

ENGINE_VERSION = "nexus-bases-4"


@dataclass(frozen=True)
class BaseConfig:
    min_sessions: int = 15
    max_sessions: int = 1500
    pullback_pct: float = 5.0
    max_depth_pct: float = 60.0
    atr_period: int = 14
    stop_pct: float = 8.0
    trail_period: int = 50
    fresh_sessions: int = 6
    touch_tolerance_pct: float = 1.0
    fee_bps: float = 10
    slippage_bps: float = 10
    contraction_noise_pct: float = 5.0
    breakeven_gain_pct: float = 0.0
    risk_pct: float = 1.5
    max_position_pct: float = 100.0

    def validate(self):
        validate_costs(self.fee_bps, self.slippage_bps)
        for name in ('min_sessions', 'max_sessions', 'atr_period', 'trail_period', 'fresh_sessions'):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f'{name} must be a positive integer')
        if self.max_sessions < self.min_sessions:
            raise ValueError('max_sessions must be at least min_sessions')
        for name in ('pullback_pct', 'max_depth_pct', 'stop_pct', 'touch_tolerance_pct', 'contraction_noise_pct'):
            value = getattr(self, name)
            if not math.isfinite(value) or not 0 < value < 100:
                raise ValueError(f'{name} must be between 0 and 100')

        for name,low,high in (('breakeven_gain_pct',0,1000),('risk_pct',0,100),('max_position_pct',0,100)):
            value=getattr(self,name)
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high or name!='breakeven_gain_pct' and value==0:
                raise ValueError(name+' is outside its supported range')


def confirmed_contractions(closes, highs, lows, noise_pct=5):
    """High-to-low legs whose reversal is confirmed inside the measured base."""
    if not len(closes):return []
    direction=0;extreme=0;pivots=[]
    for index in range(1,len(closes)):
        close=closes[index]
        if direction>=0:
            if close>=closes[extreme]:extreme=index
            elif (1-close/closes[extreme])*100>=noise_pct:
                pivots.append((float(highs[extreme]),'high'));direction=-1;extreme=index;continue
        if direction<=0:
            if close<=closes[extreme]:extreme=index
            elif (close/closes[extreme]-1)*100>=noise_pct:
                pivots.append((float(lows[extreme]),'low'));direction=1;extreme=index
    return [(left[0]-right[0])/left[0]*100 for left,right in zip(pivots,pivots[1:]) if left[1]=='high' and right[1]=='low']


def ratio(a, b):
    return float(a / b) if np.isfinite(a) and np.isfinite(b) and b != 0 else None


def finite(value):
    return float(value) if pd.notna(value) and np.isfinite(value) else None


def measure_base(frame, start, end, atr_pct, rs=None, touch_tolerance_pct=1, _arrays=None):
    """Measure inclusive base boundaries. Halves differ by at most one session."""
    arrays=_arrays or {'volume':frame.Volume.to_numpy(float),'close':frame.Close.to_numpy(float),
        'high':frame.High.to_numpy(float),'low':frame.Low.to_numpy(float),'change':frame.Close.diff().to_numpy(float),
        'dates':[str(day.date()) for day in frame.Date],'atr':atr_pct.to_numpy(float), 'atrSimple':(true_range(frame).rolling(14,min_periods=14).mean()/frame.Close*100).to_numpy(float), 'trPct':(true_range(frame)/frame.Close*100).to_numpy(float),
        'turnover':pd.to_numeric(frame.get('Turnover',pd.Series(index=frame.index,dtype=float)),errors='coerce').to_numpy(float)}
    volume=arrays['volume'][start:end+1];close=arrays['close'][start:end+1]
    high=arrays['high'][start:end+1];low=arrays['low'][start:end+1]
    size=end-start+1;pivot=float(close.max());midpoint=(size+1)//2
    averages=arrays['atr'][start:end+1];simple=arrays['atrSimple'][start:end+1];raw=arrays['trPct'][start:end+1];change=arrays['change'][start:end+1]
    up, down = float(volume[change > 0].sum()), float(volume[change < 0].sum())
    quiet = int(np.argmin(volume))
    turnover=arrays['turnover'][start:end+1]
    turnover= np.where(np.isfinite(turnover)&(turnover>=0),turnover,np.nan) / 1e7
    complete_turnover=bool(np.isfinite(turnover).all())
    quiet_turnover=int(np.argmin(turnover)) if complete_turnover else None
    def avg(values):
        return float(np.mean(values)) if len(values) and np.isfinite(values).all() else np.nan
    depth = (pivot - float(low.min())) / pivot * 100
    parts = {}
    for divisor, name in ((1,'full'), (2,'half'), (3,'third'), (4,'quarter'), (5,'fifth')):
        for number, positions in enumerate(np.array_split(np.arange(size), divisor), 1):
            if not len(positions): continue
            key = name if divisor == 1 else f'{name}_{number}'
            parts[key] = {'atrPct': finite(avg(averages[positions])), 'atrWilderPct': finite(avg(averages[positions])), 'atrSimplePct':finite(avg(simple[positions])), 'trueRangePct':finite(avg(raw[positions])), 'volume': float(volume[positions].mean()),
                          'highClose': float(close[positions].max()), 'lowClose': float(close[positions].min()),
                          'upVolume': float(volume[positions][change[positions] > 0].sum()),
                          'downVolume': float(volume[positions][change[positions] < 0].sum()),
                          'turnoverCr': finite(avg(turnover[positions])),
                          'upTurnoverCr': float(turnover[positions][change[positions]>0].sum()) if np.isfinite(turnover[positions]).all() else None,
                          'downTurnoverCr': float(turnover[positions][change[positions]<0].sum()) if np.isfinite(turnover[positions]).all() else None,
                          'upDays': int((change[positions]>0).sum()), 'downDays': int((change[positions]<0).sum()),
                          'changePct': float((close[positions[-1]]/close[positions[0]]-1)*100)}
    overhead_start=max(0,end-251)
    overhead_volume=arrays['volume'][overhead_start:end+1]
    overhead_close=arrays['close'][overhead_start:end+1]
    overhead_share=None if len(overhead_volume)<252 or overhead_volume.sum()==0 else float(overhead_volume[overhead_close>pivot].sum()/overhead_volume.sum()*100)
    legs=confirmed_contractions(close,high,low,arrays.get('contractionNoisePct',5))
    leg_ratios=[b/a for a,b in zip(legs,legs[1:]) if a>0]
    ranks = None if rs is None else np.asarray(rs[start:end + 1], dtype=float)
    return {'startDate': arrays['dates'][start], 'endDate': arrays['dates'][end],
            'ageSessions': size, 'ageWeeks': size/5, 'ageCalendarWeeks':(frame.Date.iloc[end]-frame.Date.iloc[start]).days/7, 'pivot': pivot, 'ceiling': float(high.max()),
            'floor': float(low.min()), 'depthPct': depth,
            'overheadCloseVolume252Pct':overhead_share,
            'trueRangeContraction':ratio(avg(raw[midpoint:]),avg(raw[:midpoint])),
            'contractionLegCount':len(legs),'contractionLegDepths':legs,'contractionMaxRatio':max(leg_ratios) if leg_ratios else None,'contractionFinalDepthPct':legs[-1] if legs else None,'contractionNoisePct':arrays.get('contractionNoisePct',5),
            'atrPeriod':arrays.get('atrPeriod',14), 'atrMethod':'WILDER_EWM_FIRST_TR', 'atrSimpleMethod':'ROLLING_MEAN_TR',
            'atrSimpleContraction':ratio(avg(simple[midpoint:]),avg(simple[:midpoint])),
            'atrContraction': ratio(avg(averages[midpoint:]), avg(averages[:midpoint])),
            'volumeDryUp': ratio(avg(volume[midpoint:]), avg(volume[:midpoint])),
            'quietDepth': ratio(volume[quiet], np.median(volume)),
            'quietVolume': float(volume[quiet]), 'medianVolume': float(np.median(volume)),
            'quietTurnoverCr': None if quiet_turnover is None else float(turnover[quiet_turnover]),
            'medianTurnoverCr': float(np.median(turnover)) if complete_turnover else None,
            'quietTurnoverDate': None if quiet_turnover is None else arrays['dates'][start+quiet_turnover],
            'quietTurnoverAgeSessions': None if quiet_turnover is None else size-1-quiet_turnover,
            'quietDate': arrays['dates'][start+quiet], 'quietAgeSessions': size-1-quiet,
            'upDownVolumeRatio': ratio(up, down), 'netUpDownVolume': ratio(up-down, up+down),
            'rsStart': None if ranks is None else finite(ranks[0]),
            'rsEnd': None if ranks is None else finite(ranks[-1]),
            'rsAverage': None if ranks is None else finite(avg(ranks)),
            'rsMinimum': None if ranks is None or not np.isfinite(ranks).all() else float(ranks.min()),
            'rsMaximum': None if ranks is None or not np.isfinite(ranks).all() else float(ranks.max()),
            'touchCount':int((np.abs(close/pivot-1)*100<=touch_tolerance_pct).sum()),
            'squatCount':int(((high>pivot)&(close<pivot)).sum()),
            'parts': parts}


def detect_bases(frame: pd.DataFrame, symbol: str, config: BaseConfig | None = None, rs=None):
    config = config or BaseConfig()
    config.validate()
    frame = frame.copy().reset_index(drop=True)
    frame['Date'] = pd.to_datetime(frame.Date)
    if not frame.Date.is_monotonic_increasing or frame.Date.duplicated().any():
        raise ValueError('Base history requires strictly increasing unique dates')
    if rs is not None and len(rs) != len(frame):
        raise ValueError('RS history must align with candles')
    columns = ['Open','High','Low','Close','Volume']
    if not np.isfinite(frame[columns].to_numpy(float)).all() or (frame[['Open','High','Low','Close']] <= 0).any().any() or (frame.Volume < 0).any():
        raise ValueError('Base history contains invalid OHLCV')
    if frame.empty: return []
    if (frame.High < frame[['Open','Close','Low']].max(axis=1)).any() or (frame.Low > frame[['Open','Close','High']].min(axis=1)).any():
        raise ValueError('Base history contains inconsistent candle ranges')
    atr_pct = wilder_average(true_range(frame), config.atr_period) / frame.Close * 100
    trail = frame.Close.rolling(config.trail_period, min_periods=config.trail_period).mean()
    arrays={'atrPeriod':config.atr_period,'contractionNoisePct':config.contraction_noise_pct,'volume':frame.Volume.to_numpy(float),'close':frame.Close.to_numpy(float),'high':frame.High.to_numpy(float),'low':frame.Low.to_numpy(float),'change':frame.Close.diff().to_numpy(float),'dates':[str(day.date()) for day in frame.Date],'atr':atr_pct.to_numpy(float), 'atrSimple':(true_range(frame).rolling(config.atr_period,min_periods=config.atr_period).mean()/frame.Close*100).to_numpy(float), 'trPct':(true_range(frame)/frame.Close*100).to_numpy(float),
        'turnover':pd.to_numeric(frame.get('Turnover',pd.Series(index=frame.index,dtype=float)),errors='coerce').to_numpy(float)}
    episodes, active = [], []
    peak = 0
    index = 0
    rows=list(frame.itertuples(index=False))
    closes=frame.Close.to_numpy(float)
    highest_close=closes[0]
    date_positions={str(day.date()):i for i,day in enumerate(frame.Date)}
    opens=frame.Open.to_numpy(float)
    for index,row in enumerate(rows[1:],1):
        date = str(row.Date.date())
        # Update existing candidates before creating today's new candidate.
        for episode in list(active):
            start, pivot = episode['_start'], episode['pivot']
            if episode['parentId'] and episode['parentInvalidationDate'] is None:
                parent=episode['_parent']
                if parent and parent['stage']=='INVALIDATED':episode['parentInvalidationDate']=parent['exit']['date']
            if episode['breakout'] is not None:
                bo = episode['breakout']
                episode['breakoutAgeSessions'] = index - episode['_breakout']
                episode['returnSinceBreakoutPct'] = (row.Close / bo['close'] - 1) * 100
                episode['maxGainPct'] = max(episode['maxGainPct'], (row.High / bo['close'] - 1) * 100)
                episode['maxDrawdownPct'] = min(episode['maxDrawdownPct'], (row.Low / bo['close'] - 1) * 100)
                episode['belowPivotCloses'] += int(row.Close < pivot)
                episode['continuousHolding'] &= bool(row.Close >= pivot)
                episode['_maxBreakoutHigh'] = max(episode['_maxBreakoutHigh'], float(row.High))
                episode['peakToTroughDrawdownPct'] = min(episode['peakToTroughDrawdownPct'], (row.Low / episode['_maxBreakoutHigh'] - 1) * 100)
                if row.Close < pivot and episode['breakoutFailure'] is None:
                    episode['breakoutFailure'] = {'date':date, 'reason':'CLOSE_BACK_INSIDE'}
                if not episode['failedPokeDates'] and index-episode['_breakout'] <= 10 and row.Close < pivot and episode['_maxBreakoutHigh'] <= episode['base']['ceiling']:
                    episode['failedPokeDates'].append(date)
                if row.Close < pivot: episode['retestDates'].append(date)
                episode['holdsPivot'] = bool(row.Close >= pivot)
                was_armed = episode['trailArmed']
                stop_level=pivot*(1-config.stop_pct/100)
                if config.breakeven_gain_pct and index>episode['_breakout'] and episode['_breakout']+1<len(frame):
                    entry=float(opens[episode['_breakout']+1])
                    if not episode.get('breakevenArmed') and row.Close>=max(entry*(1+config.breakeven_gain_pct/100),entry*(1+(config.fee_bps+config.slippage_bps)/10000)/(1-(config.fee_bps+config.slippage_bps)/10000)):episode['breakevenArmed']=True;episode['breakevenArmedDate']=date
                    if episode.get('breakevenArmed'):stop_level=max(stop_level,entry*(1+(config.fee_bps+config.slippage_bps)/10000)/(1-(config.fee_bps+config.slippage_bps)/10000))
                stop = row.Close < stop_level
                trail_exit = was_armed and pd.notna(trail.iloc[index]) and row.Close < trail.iloc[index]
                episode['trailArmed'] |= bool(pd.notna(trail.iloc[index]) and row.Close > trail.iloc[index])
                if stop or trail_exit:
                    episode['stage'] = 'PLAYED_OUT'
                    episode['exit'] = {'date':date, 'close':float(row.Close), 'reason':('BREAKEVEN' if episode.get('breakevenArmed') and stop_level>pivot*(1-config.stop_pct/100) else 'STOP') if stop else 'MA_TRAIL'}
                    active.remove(episode)
                else:
                    episode['stage'] = 'FRESH_BREAKOUT' if index-episode['_breakout'] < config.fresh_sessions else 'HOLDING'
                continue
            duration = index-start
            if episode['parentId'] and not episode['_nestedConfirmed'] and duration+1>=config.min_sessions:
                parent=episode['_parent']
                if parent is not None and parent['breakout'] is None:
                    parent['nestedCount']+=1
                episode['_nestedConfirmed']=True
            if row.Close > pivot:
                if duration < config.min_sessions:
                    active.remove(episode); episodes.remove(episode); continue
                episode['base'] = measure_base(frame,start,index-1,atr_pct,rs,config.touch_tolerance_pct,arrays)
                episode['base']['nestedCount'] = episode['nestedCount']
                episode['base']['level'] = episode['level']
                episode['base']['overheadPct'] = episode['overheadPct']
                episode['base']['overheadPriceDistancePct'] = episode['overheadPct']
                prior_volume = frame.Volume.iloc[max(0,index-20):index]
                episode['breakout'] = {'date':date, 'close':float(row.Close),
                    'volumeRatio':ratio(row.Volume, prior_volume.median()) if len(prior_volume)==20 else None,
                    'gapPct':(row.Open/pivot-1)*100, 'throughPct':(row.Close/pivot-1)*100,
                    'dailyGainPct':(row.Close/frame.Close.iloc[index-1]-1)*100,
                    'closeInRange':ratio(row.Close-row.Low,row.High-row.Low)}
                episode['_breakout'] = index; episode['_maxBreakoutHigh'] = float(row.High); episode['stage'] = 'FRESH_BREAKOUT'
                episode['trailArmed'] = bool(pd.notna(trail.iloc[index]) and row.Close > trail.iloc[index])
                continue
            episode['_floor']=min(episode['_floor'],float(row.Low))
            depth = (pivot-episode['_floor'])/pivot*100
            if row.High > pivot and row.Close < pivot: episode['squatDates'].append(date)
            if abs(row.Close/pivot-1)*100 <= config.touch_tolerance_pct: episode['touchDates'].append(date)
            if duration > config.max_sessions or depth > config.max_depth_pct:
                episode['stage'] = 'INVALIDATED'; episode['exit'] = {'date':date,'reason':'BASE_LIMIT'}; active.remove(episode)
        highest_close=max(highest_close,float(row.Close))
        if row.Close >= closes[peak]: peak=index
        elif (1-row.Close/closes[peak])*100 >= config.pullback_pct:
            if not any(e['_start']==peak for e in episodes):
                pivot = float(closes[peak])
                parents = [e for e in active if e['breakout'] is None and e['_start'] < peak and pivot <= e['pivot']]
                parent = max(parents,key=lambda e:e['_start']) if parents else None
                identity = f'{ENGINE_VERSION}:{symbol}:{frame.Date.iloc[peak].date()}:{json.dumps(asdict(config),sort_keys=True)}'
                episode = {'id':hashlib.sha256(identity.encode()).hexdigest()[:24], 'symbol':symbol,
                    'engineVersion':ENGINE_VERSION, 'config':asdict(config), '_start':peak,
                    '_parent':parent,'_nestedConfirmed':False,'parentInvalidationDate':None,'_floor':float(frame.Low.iloc[peak:index+1].min()),'parentId':parent['id'] if parent else None, 'nestedCount':0,
                    'level':min(4,parent['level']+1) if parent else (1 if pivot >= highest_close else 2),
                    'overheadPct':max(0,(highest_close/pivot-1)*100),
                    'pivot':pivot,'stage':'FORMING','breakout':None,'exit':None,
                    'breakoutFailure':None,'peakToTroughDrawdownPct':0.0,
                    'failedPokeDates':[], 'retestDates':[], 'continuousHolding':True, 'squatDates':[],'touchDates':[],'base':{},
                    'breakevenArmed':False,'breakevenArmedDate':None,'trailArmed':False,'breakoutAgeSessions':0,'returnSinceBreakoutPct':0.0,
                    'maxGainPct':0.0,'maxDrawdownPct':0.0,'belowPivotCloses':0,'holdsPivot':True}
                episodes.append(episode); active.append(episode)
            # Local peaks allow tighter children inside an older ceiling.
            peak=index
    for episode in episodes:
        if episode['breakout'] is None:
            end = index if episode['exit'] is None else date_positions[episode['exit']['date']]
            episode['base'] = measure_base(frame,episode['_start'],end,atr_pct,rs,config.touch_tolerance_pct,arrays)
            episode['base'].update(level=episode['level'],overheadPct=episode['overheadPct'],overheadPriceDistancePct=episode['overheadPct'],nestedCount=episode['nestedCount'])
        if episode['breakout'] is not None:
            origin = episode['_breakout']
            entry = episode['breakout']['close']
            # Follow-through describes market behavior through publication even
            # after a simulated trade exit; the exit facts stay immutable.
            observed=frame.iloc[origin+1:]
            episode['breakoutAgeSessions']=len(frame)-1-origin
            episode['returnSinceBreakoutPct']=(float(frame.Close.iloc[-1])/entry-1)*100
            episode['holdsPivot']=bool(frame.Close.iloc[-1]>=episode['pivot'])
            inside=observed.Close<episode['pivot']
            episode['belowPivotCloses']=int(inside.sum())
            episode['continuousHolding']=not bool(inside.any())
            episode['sessionsHeldAbovePivot']=int((observed.Close>=episode['pivot']).sum())
            episode['retestDates']=[str(day.date()) for day in observed.loc[inside,'Date']]
            if inside.any():
                episode['breakoutFailure']={'date':episode['retestDates'][0],'reason':'CLOSE_BACK_INSIDE'}
            episode['maxGainPct']=max(0,(float(observed.High.max())/entry-1)*100) if len(observed) else 0
            episode['maxDrawdownPct']=min(0,(float(observed.Low.min())/entry-1)*100) if len(observed) else 0
            recent=frame.iloc[origin:origin+11]
            pokes=recent.Close<episode['pivot']
            poke_candidates=pokes & (recent.High.cummax()<=episode['base']['ceiling'])
            episode['failedPokeDates']=[str(day.date()) for day in recent.loc[poke_candidates,'Date'].head(1)]
            episode['outcomes'] = {}
            for horizon in (5,20,60):
                if origin+horizon >= len(frame):
                    episode['outcomes'][str(horizon)] = None
                    continue
                window = frame.iloc[origin+1:origin+horizon+1]
                episode['outcomes'][str(horizon)] = {
                    'returnPct':(float(window.Close.iloc[-1])/entry-1)*100,
                    'maxAdverseExcursionPct':min(0,(float(window.Low.min())/entry-1)*100),
                    'maxFavorableExcursionPct':max(0,(float(window.High.max())/entry-1)*100),
                    'closedInsideBase':bool((window.Close < episode['pivot']).any())}
        episode.pop('_maxBreakoutHigh',None)
        episode['failedPokeCount']=len(episode['failedPokeDates'])
        episode['asOfDate'] = str(frame.Date.iloc[-1].date())
        episode['distanceFromPivotPct'] = (float(frame.Close.iloc[-1])/episode['pivot']-1)*100
        episode['trade'] = trade_facts(arrays['dates'], opens, episode,
                                      date_positions, config.fee_bps, config.slippage_bps, risk_pct=config.risk_pct, max_position_pct=config.max_position_pct)
        episode['breakoutFailed']=None if not episode['breakout'] else bool(episode['breakoutFailure'])
        episode['exitSignaled']=None if not episode['breakout'] else bool(episode['exit'])
        episode['tradeClosed']=None if not episode['breakout'] else episode['trade']['status']=='CLOSED'
        episode['measurementPolicy']={'atrPeriod':config.atr_period,'atrMethod':'WILDER_EWM_FIRST_TR','feeBpsPerSide':config.fee_bps,'slippageBpsPerSide':config.slippage_bps,'breakevenGainPct':config.breakeven_gain_pct,'riskPct':config.risk_pct,'maxPositionPct':config.max_position_pct,'detectorMaxDepthPct':config.max_depth_pct,'contractionNoisePct':config.contraction_noise_pct,'stopPct':config.stop_pct,'trailPeriod':config.trail_period,'stopTrigger':'CLOSE_BELOW_PIVOT_STOP','trailTrigger':'CLOSE_BELOW_ARMED_SMA','execution':'NEXT_SESSION_OPEN','failureTrigger':'CLOSE_BACK_INSIDE','overheadVolume':'252_SESSION_CLOSE_CLASSIFIED_VOLUME_NOT_VOLUME_AT_PRICE'}
        episode.pop('_start',None); episode.pop('_breakout',None);episode.pop('_floor',None);episode.pop('_parent',None);episode.pop('_nestedConfirmed',None)
    return episodes
