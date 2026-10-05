"""Frozen hypothetical trade facts shared by publication and replay."""
import math


def validate_costs(fee_bps, slippage_bps):
    for value in (fee_bps, slippage_bps):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1000:
            raise ValueError('Execution costs must be finite basis points between 0 and 1000')


def net_return(entry, exit, fee_bps, slippage_bps):
    cost = (fee_bps + slippage_bps) / 10000
    return (exit * (1 - cost) / (entry * (1 + cost)) - 1) * 100


def trade_facts(dates, opens, episode, positions=None, fee_bps=10, slippage_bps=10):
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
    signal = episode.get('exit')
    # A replay prefix must not disclose an exit from a later observation.
    exit_index = positions.get(signal['date']) if signal else None
    if exit_index is None:
        return result
    if exit_index <= trigger or signal['reason'] not in ('STOP', 'MA_TRAIL'):
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
    return result
