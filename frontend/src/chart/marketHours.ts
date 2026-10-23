/** NSE cash-market hours in IST (UTC+5:30). Holidays aren't modelled; weekends are. */
const IST_OFFSET_MINUTES = 330;
const OPEN_MINUTE = 9 * 60 + 15;
const CLOSE_MINUTE = 15 * 60 + 30;

function istParts(now: Date) {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {day: ist.getUTCDay(), minute: ist.getUTCHours() * 60 + ist.getUTCMinutes(), second: ist.getUTCSeconds()};
}

export function marketOpen(now = new Date()): boolean {
  const {day, minute} = istParts(now);
  return day >= 1 && day <= 5 && minute >= OPEN_MINUTE && minute < CLOSE_MINUTE;
}

/** Seconds until the next session close (when open) or open (when closed). */
export function secondsToNextBoundary(now = new Date()): {open: boolean; seconds: number} {
  const open = marketOpen(now);
  const {day, minute, second} = istParts(now);
  const elapsed = minute * 60 + second;
  if (open) return {open, seconds: CLOSE_MINUTE * 60 - elapsed};
  let days = 0;
  let weekday = day;
  if (elapsed >= OPEN_MINUTE * 60 || weekday === 0 || weekday === 6) { days = 1; weekday = (weekday + 1) % 7; }
  while (weekday === 0 || weekday === 6) { days += 1; weekday = (weekday + 1) % 7; }
  return {open, seconds: days * 86_400 + OPEN_MINUTE * 60 - elapsed};
}

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}
