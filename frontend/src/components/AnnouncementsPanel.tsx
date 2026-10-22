import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, FileText, ExternalLink } from 'lucide-react';
import { screenerApi } from '../api/screenerApi';
import type { Announcement } from '../api/announcements';
import { DataUnavailableError, retryAnnouncement } from '../api/dataErrors';
import { Dialog } from './Dialog';
import { Button } from './Button';

type Props = { symbol: string; revision: string; onClose: () => void };
export function AnnouncementsPanel({ symbol, revision, onClose }: Props) {
  const [year, setYear] = useState<number | 'recent'>('recent');
  const [page, setPage] = useState(0);
  const [topic, setTopic] = useState('');
  const [selected, setSelected] = useState<Announcement | null>(null);
  const recent = useQuery({queryKey: ['announcements', symbol, revision], queryFn: () => screenerApi.getAnnouncements(symbol, revision), staleTime: Infinity, retry: retryAnnouncement});
  const history = useQuery({queryKey: ['announcementHistory', symbol, year, page, revision],
    queryFn: () => screenerApi.getAnnouncementHistory(symbol, Number(year), page, revision), enabled: year !== 'recent', staleTime: Infinity, retry: retryAnnouncement});
  const detail = useQuery({queryKey: ['filingDetail', symbol, selected?.id, selected?.detailPage, revision],
    queryFn: () => screenerApi.getAnnouncementDetail(symbol, selected!, revision), enabled: Boolean(selected), staleTime: Infinity, retry: retryAnnouncement});
  const topics = useQuery({queryKey: ['announcementTopics', revision], queryFn: () => screenerApi.getAnnouncementTopics(revision),
    enabled: Boolean(recent.data), staleTime: Infinity, retry: retryAnnouncement});
  const labels = new Map(topics.data?.map(topic => [topic.id, topic.label]));
  const allRows = year === 'recent' ? recent.data?.records : history.data?.records;
  const rows = allRows?.filter(row => !topic || row.topics.includes(topic));
  const active = year === 'recent' ? recent : history;
  const events = (detail.data?.classification as {events?: Array<{topic: string; evidence?: {excerpt?: string}}> } | undefined)?.events ?? [];
  const unavailable = active.error instanceof DataUnavailableError && active.error.reason === 'not_published';
  return <Dialog label={`${symbol} announcements`} className="announcement-dialog" onClose={onClose}>
    <div className="dialog-header"><div><h2>{symbol} announcements</h2><p>Official company filings and supporting evidence.</p></div>
      <button type="button" className="icon-button" aria-label="Close announcements" onClick={onClose}><X size={20} /></button></div>
    <div className="dialog-content">
      <div className="announcement-toolbar">
        <label className="announcement-history"><span>History</span><select aria-label="Announcement history" value={year}
          onChange={event => {setYear(event.target.value === 'recent' ? 'recent' : Number(event.target.value)); setPage(0); setSelected(null);}}>
          <option value="recent">Last 90 days</option>{recent.data?.years.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label className="announcement-topic"><span>Classification</span><select aria-label="Filter filings by classification" value={topic}
          onChange={event => {setTopic(event.target.value); setSelected(null);}}>
          <option value="">All</option>{topics.data?.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>
        {recent.data && <p className="announcement-snapshot">Snapshot {new Date(recent.data.publishedAt).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}</p>}
      </div>
      {active.isPending && <div className="data-state" role="status"><FileText size={28} /><h2>Loading filings</h2><span className="skeleton" /></div>}
      {active.isError && <div className="data-state" role="alert"><FileText size={28} /><h2>{unavailable ? 'Announcements not published' : 'Announcements could not be loaded'}</h2><p>{active.error.message}</p>
        {!unavailable && <Button variant="secondary" onClick={() => void active.refetch()}>Retry</Button>}</div>}
      {rows && !rows.length && <div className="data-state"><FileText size={28} /><h2>{topic ? 'No filings in this classification' : 'No filings in this period'}</h2><p>{topic ? 'Choose another classification to see matching filings.' : 'Choose another year to view earlier announcements.'}</p></div>}
      {rows && rows.length > 0 && <ul className="announcement-list">
        {rows.map(row => {
          const expanded = selected?.id === row.id;
          return <li className="announcement-row" key={row.id}>
            <div className="announcement-row-heading">
              <button type="button" className="announcement-title" aria-expanded={expanded}
                onClick={() => setSelected(expanded ? null : row)}>{row.headline}</button>
              <div className="announcement-row-actions">
                {row.url && /^https?:\/\//i.test(row.url) && <a href={row.url} target="_blank" rel="noopener noreferrer" className="announcement-document">
                  <FileText size={14} /> Document <ExternalLink size={12} />
                </a>}
              </div>
            </div>
            <p className="cell-secondary">{new Date(row.publishedAt).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}</p>
            <p className="cell-secondary">{row.topics.map(id => labels.get(id) ?? id).join(', ')}</p>
            {expanded && <section className="announcement-evidence-inline" aria-label={`${row.headline} evidence`} aria-live="polite">
              <p className="announcement-status">Classification status: {row.status.replaceAll('_', ' ')}</p>
              {detail.isPending && <p>Loading evidence…</p>}
              {detail.isError && <p role="alert">{detail.error.message} <Button variant="ghost" onClick={() => void detail.refetch()}>Retry</Button></p>}
              {events.map((event, index) => event.evidence?.excerpt && <p key={index}><span className="font-medium">{labels.get(event.topic) ?? event.topic}: </span>{event.evidence.excerpt}</p>)}
            </section>}
          </li>;
        })}
      </ul>}
      {topics.isError && <p role="alert" className="notice">Category labels could not be loaded. Filing topic IDs are shown. <Button variant="ghost" onClick={() => void topics.refetch()}>Retry categories</Button></p>}
      {year !== 'recent' && history.data && <div className="pagination">
        <Button variant="secondary" disabled={!page || history.isFetching} onClick={() => {setPage(page - 1); setSelected(null);}}>Newer</Button>
        <span className="pagination-page">Page {page + 1} of {history.data.pages}</span>
        <Button variant="secondary" disabled={page + 1 >= history.data.pages || history.isFetching} onClick={() => {setPage(page + 1); setSelected(null);}}>Older</Button>
      </div>}
    </div>
  </Dialog>;
}
