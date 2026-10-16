import { describe, expect, it } from 'vitest';
import { aggregate, ema, validateCandles, type Candle } from '../chart/model';

const bar = (date: string, close = 11): Candle => ({date, open:10, high:20, low:5, close, volume:100});
describe('independent chart model', () => {
  it('validates a copy without mutating published history', () => {
    const input = Object.freeze([Object.freeze(bar('2026-10-01'))]);
    const result = validateCandles(input);
    result[0].close = 12;
    expect(input[0].close).toBe(11);
  });
  it.each([
    [{...bar('2026-02-30')}], [bar('2026-10-02'),bar('2026-10-01')],
    [bar('2026-10-01'),bar('2026-10-01')], [{...bar('2026-10-01'), close:NaN}],
    [{...bar('2026-10-01'), volume:-1}], [{...bar('2026-10-01'), high:6}],
  ].map(candles => ({candles})))('rejects malformed candles %j', ({candles}) => expect(() => validateCandles(candles)).toThrow('invalid or unordered'));
  it('groups weeks across a year boundary using trading dates and OHLCV', () => {
    const input = [bar('2025-12-31',12), {...bar('2026-01-02',15), high:21}, bar('2026-01-05')];
    expect(aggregate(input,'W')).toEqual([{...bar('2025-12-31',15), high:21, volume:200},bar('2026-01-05')]);
    expect(input[0].close).toBe(12);
    expect(aggregate(input,'M')).toHaveLength(2);
  });
  it('does not manufacture volume when part of a period is missing', () => {
    expect(aggregate([bar('2026-10-01'),{...bar('2026-10-02'),volume:null}],'W')[0].volume).toBeNull();
  });
  it('seeds EMA with a full-period SMA and preserves warmup nulls', () => {
    const input = [1,2,3,4].map((close,i) => bar(`2026-10-0${i+1}`,close));
    expect(ema(input,3)).toEqual([null,null,2,3]);
    expect(ema(input,20)).toEqual([null,null,null,null]);
  });
});
