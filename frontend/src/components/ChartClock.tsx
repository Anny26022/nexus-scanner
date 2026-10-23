import { useState } from 'react';
import { useMountEffect } from '../hooks/useMountEffect';
import { formatDuration, secondsToNextBoundary } from '../chart/marketHours';

/** Corner clock in the chosen timezone, with an optional countdown to the NSE session close or open. */
export function ChartClock({timezone, clock, countdown}: {timezone: string; clock: boolean; countdown: boolean}) {
  const [now, setNow] = useState(() => new Date());
  useMountEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  });
  let time = '';
  let zone = '';
  try {
    time = new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: timezone}).format(now);
    zone = new Intl.DateTimeFormat('en-GB', {timeZone: timezone, timeZoneName: 'shortOffset'}).formatToParts(now).find(part => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    time = now.toLocaleTimeString();
  }
  const next = secondsToNextBoundary(now);
  return <div className="chart-clock" role="status" aria-label="Chart clock">
    {countdown && <span className="chart-clock-countdown" title={next.open ? 'Time until the NSE session closes (15:30 IST)' : 'Time until the NSE session opens (09:15 IST)'}>
      {next.open ? 'Closes in' : 'Opens in'} {formatDuration(next.seconds)}
    </span>}
    {clock && <span className="chart-clock-time"><b>{time}</b> {zone}</span>}
  </div>;
}
