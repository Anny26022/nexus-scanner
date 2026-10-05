"""Frozen hypothetical trade facts shared by publication and replay."""
import math


def validate_costs(fee_bps, slippage_bps):
    for value in (fee_bps, slippage_bps):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1000:
            raise ValueError('Execution costs must be finite basis points between 0 and 1000')


def net_return(entry, exit, fee_bps, slippage_bps):
    cost = (fee_bps + slippage_bps) / 10000
    return (exit * (1 - cost) / (entry * (1 + cost)) - 1) * 100


def position_size(entry, stop, capital=None, risk_pct=1.5, max_position_pct=100, fee_bps=10, slippage_bps=10):
    """Cost-aware planned sizing; close-based stops cannot guarantee the budget."""
    validate_costs(fee_bps,slippage_bps)
    for name,value in (('risk_pct',risk_pct),('max_position_pct',max_position_pct)):
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not 0<value<=100:raise ValueError('Invalid '+name)
    if capital is not None and (isinstance(capital,bool) or not isinstance(capital,(int,float)) or not math.isfinite(capital) or capital<=0):raise ValueError('Capital must be finite and positive')
    if not math.isfinite(entry) or not math.isfinite(stop) or not 0<stop<entry:
        return {'status':'INVALID_STOP','positionFraction':None,'shares':None,'plannedRiskPct':None,'plannedStopPrice':stop}
    cost=(fee_bps+slippage_bps)/10000
    loss=entry*(1+cost)-stop*(1-cost)
    fraction=min(max_position_pct/100,risk_pct/100/(loss/(entry*(1+cost))))
    shares=None if capital is None else math.floor(capital*fraction/(entry*(1+cost)))
    actual_fraction=fraction if shares is None else shares*entry*(1+cost)/capital
    return {'status':'BELOW_ONE_SHARE' if shares==0 else 'SIZED','positionFraction':actual_fraction,'shares':shares,'plannedRiskPct':actual_fraction*loss/(entry*(1+cost))*100,'plannedStopPrice':stop}


def trade_facts(dates, opens, episode, positions=None, fee_bps=10, slippage_bps=10, *, risk_pct=1.5, max_position_pct=100, capital=None):
    """Execute close signals at the next observed session open, never at a pivot.

    No entry/exit candle means pending, not an invented fill. Realized returns
    remain null until exit execution and then remain frozen as history grows.
    Dates must be ordered ISO trading-session dates from the validated history.
    """
    validate_costs(fee_bps, slippage_bps)
    result = dict(status='NOT_TRIGGERED', execution='NEXT_SESSION_OPEN',
                  feeBpsPerSide=fee_bps, slippageBpsPerSide=slippage_bps,
                  breakoutDate=None, entryDate=None, entryPrice=None,
                  exitSignalDate=None, exitReason=None, executionDate=None,
                  exitPrice=None, realizedReturnPct=None, netRealizedReturnPct=None)
    result['sizing']=None;result['capitalReturnPct']=None
    # Validate even an untriggered replay request.
    position_size(100,92,capital,risk_pct,max_position_pct,fee_bps,slippage_bps)
    breakout = episode.get('breakout')
    if not breakout:
        return result
    positions = positions if positions is not None else {date: i for i, date in enumerate(dates)}
    trigger = positions.get(breakout['date'])
    if trigger is None:
        raise ValueError('Breakout event lies outside execution history')
    result.update(status='ENTRY_PENDING', breakoutDate=breakout['date'])
    if trigger + 1 >= len(dates):
        return result
    entry = float(opens[trigger + 1])
    if not math.isfinite(entry) or entry <= 0:
        raise ValueError('Execution entry price must be finite and positive')
    result.update(status='OPEN', entryDate=dates[trigger + 1], entryPrice=entry)
    pivot=episode.get('pivot')
    stop_pct=episode.get('config',{}).get('stop_pct',8)
    if isinstance(pivot,(int,float)) and math.isfinite(pivot):result['sizing']=position_size(entry,pivot*(1-stop_pct/100),capital,risk_pct,max_position_pct,fee_bps,slippage_bps)
    signal = episode.get('exit')
    # A replay prefix must not disclose an exit from a later observation.
    exit_index = positions.get(signal['date']) if signal else None
    if exit_index is None:
        return result
    if exit_index <= trigger or signal['reason'] not in ('STOP', 'MA_TRAIL', 'BREAKEVEN'):
        raise ValueError('Trade exit must follow breakout and identify a stop or MA trail')
    result.update(status='EXIT_PENDING', exitSignalDate=signal['date'], exitReason=signal['reason'])
    if exit_index + 1 >= len(dates):
        return result
    price = float(opens[exit_index + 1])
    if not math.isfinite(price) or price <= 0:
        raise ValueError('Execution exit price must be finite and positive')
    result.update(status='CLOSED', executionDate=dates[exit_index + 1], exitPrice=price,
                  realizedReturnPct=(price / entry - 1) * 100,
                  netRealizedReturnPct=net_return(entry, price, fee_bps, slippage_bps))
    if result['sizing'] and result['sizing']['positionFraction'] is not None:result['capitalReturnPct']=result['netRealizedReturnPct']*result['sizing']['positionFraction']
    return result
