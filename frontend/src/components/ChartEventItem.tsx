import { ExternalLink, FileText } from 'lucide-react';
import { EVENT_BADGES, eventBadgeKey, type ChartEvent, type EventBadgeStyles } from '../chart/events';

const formatDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'});

/** One published event: lettered kind, date, headline, summary or filing body, and its document. */
export function ChartEventItem({event, styles}: {event: ChartEvent; styles?: EventBadgeStyles}) {
  const key = eventBadgeKey(event), [, letter, label, fallback] = EVENT_BADGES.find(item => item[0] === key)!;
  const color = styles?.[key]?.color ?? fallback;
  return <article className="chart-event-item">
    <header>
      <span className="chart-event-kind" style={{color, borderColor: color}} aria-hidden="true">{letter}</span>
      <span className="chart-event-label">{label}</span>
      <time dateTime={event.date}>{formatDate(event.date)}</time>
    </header>
    <h3>{event.title}</h3>
    {event.detail && <p>{event.detail}</p>}
    {event.url && <footer>
      <a href={event.url} target="_blank" rel="noopener noreferrer"><FileText size={12} aria-hidden="true" /> Document <ExternalLink size={11} aria-hidden="true" /></a>
    </footer>}
  </article>;
}
