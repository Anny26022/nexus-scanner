export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}
export type Interval = 'D' | 'W' | 'M';
export interface EmaLine {
  id:string; period:number; color:string; enabled:boolean;
  width:number; style:'solid'|'dashed'|'dotted'; opacity:number;
}
export const defaultEmaLines = (): EmaLine[] => [
  {id:'ema9',period:9,color:'#f59e0b',enabled:true,width:2,style:'solid',opacity:1},
  {id:'ema20',period:20,color:'#8b5cf6',enabled:true,width:2,style:'solid',opacity:1},
  {id:'ema50',period:50,color:'#22d3ee',enabled:false,width:2,style:'solid',opacity:1},
];
export function validEmaLine(line:EmaLine):boolean {
  return !!line && typeof line.id==='string' && Number.isInteger(line.period) && line.period>=1 && line.period<=500
    && /^#[0-9a-f]{6}$/i.test(line.color) && typeof line.enabled==='boolean'
    && Number.isFinite(line.width) && line.width>=1 && line.width<=4
    && ['solid','dashed','dotted'].includes(line.style) && Number.isFinite(line.opacity) && line.opacity>=.1 && line.opacity<=1;
}

// Reject malformed data rather than silently drawing a misleading series.
export function validateCandles(candles: readonly Candle[]): Candle[] {
  let previous = '';
  for (const c of candles) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date) || !Number.isFinite(Date.parse(c.date))
      || new Date(c.date).toISOString().slice(0, 10) !== c.date || c.date <= previous
      || ![c.open, c.high, c.low, c.close].every(Number.isFinite)
      || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close) || c.low > c.high
      || (c.volume !== null && (!Number.isFinite(c.volume) || c.volume < 0))) {
      throw new Error('Published chart contains invalid or unordered candles.');
    }
    previous = c.date;
  }
  return candles.map(c => ({...c}));
}

export function aggregate(candles: readonly Candle[], interval: Interval): Candle[] {
  if (interval === 'D') return candles.map(c => ({...c}));
  const result: Candle[] = [];
  let previous = '';
  for (const c of candles) {
    const day = new Date(`${c.date}T00:00:00Z`);
    if (interval === 'W') day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
    const key = interval === 'M' ? c.date.slice(0, 7) : day.toISOString().slice(0, 10);
    const last = result.at(-1);
    if (key !== previous || !last) result.push({...c});
    else {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume = last.volume === null || c.volume === null ? null : last.volume + c.volume;
    }
    previous = key;
  }
  return result;
}

export function ema(candles: readonly Candle[], period: number): Array<number | null> {
  let sum = 0, value = 0;
  return candles.map((c, i) => {
    if (i < period) sum += c.close;
    if (i < period - 1) return null;
    value = i === period - 1 ? sum / period : value + 2 / (period + 1) * (c.close - value);
    return value;
  });
}
