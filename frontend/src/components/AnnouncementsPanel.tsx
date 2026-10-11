import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, FileText, ExternalLink } from 'lucide-react';
import { screenerApi } from '../api/screenerApi';
import type { Announcement } from '../api/announcements';
import { DataUnavailableError, retryAnnouncement } from '../api/dataErrors';
import { Dialog } from './Dialog';

type Props = { symbol: string; revision: string; onClose: () => void };
export function AnnouncementsPanel({ symbol, revision, onClose }: Props) {
  const [year, setYear] = useState<number | 'recent'>('recent');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Announcement | null>(null);
  const recent = useQuery({queryKey: ['announcements', symbol, revision], queryFn: () => screenerApi.getAnnouncements(symbol, revision), staleTime: Infinity, retry: retryAnnouncement});
  const history = useQuery({queryKey: ['announcementHistory', symbol, year, page, revision],
    queryFn: () => screenerApi.getAnnouncementHistory(symbol, Number(year), page, revision), enabled: year !== 'recent', staleTime: Infinity, retry: retryAnnouncement});
  const detail = useQuery({queryKey: ['filingDetail', symbol, selected?.id, selected?.detailPage, revision],
    queryFn: () => screenerApi.getAnnouncementDetail(symbol, selected!, revision), enabled: Boolean(selected), staleTime: Infinity, retry: retryAnnouncement});
  const topics = useQuery({queryKey: ['announcementTopics', revision], queryFn: () => screenerApi.getAnnouncementTopics(revision),
    enabled: Boolean(recent.data), staleTime: Infinity, retry: retryAnnouncement});
  const labels = new Map(topics.data?.map(topic => [topic.id, topic.label]));
  const rows = year === 'recent' ? recent.data?.records : history.data?.records;
  const active = year === 'recent' ? recent : history;
  const events = (detail.data?.classification as {events?: Array<{topic: string; evidence?: {excerpt?: string}}> } | undefined)?.events ?? [];
  const unavailable = active.error instanceof DataUnavailableError && active.error.reason === 'not_published';
  return <Dialog label={`${symbol} announcements`} className="announcement-dialog" onClose={onClose}>
    <div className="dialog-header"><div><h2>{symbol} announcements</h2><p>Official company filings and supporting evidence.</p></div>
      <button type="button" className="icon-button" aria-label="Close announcements" onClick={onClose}><X size={20} /></button></div>
    <div className="dialog-content">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="universe-control"><span className="field-label">History</span><select aria-label="Announcement history" value={year} className="w-full rounded-lg border border-slate-300 p-2 text-xs"
          onChange={event => {setYear(event.target.value === 'recent' ? 'recent' : Number(event.target.value)); setPage(0); setSelected(null);}}>
          <option value="recent">Last 90 days</option>{recent.data?.years.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
        {recent.data && <p className="cell-muted text-xs">Snapshot {new Date(recent.data.publishedAt).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}</p>}
      </div>
      {active.isPending && <div className="data-state" role="status"><FileText size={28} /><h2>Loading filings</h2><span className="skeleton" /></div>}
      {active.isError && <div className="data-state" role="alert"><FileText size={28} /><h2>{unavailable ? 'Announcements not published' : 'Announcements could not be loaded'}</h2><p>{active.error.message}</p>
        {!unavailable && <button type="button" className="button button-secondary" onClick={() => void active.refetch()}>Retry</button>}</div>}
      {rows && !rows.length && <div className="data-state"><FileText size={28} /><h2>No filings in this period</h2><p>Choose another year to view earlier announcements.</p></div>}
      {rows && rows.length > 0 && <ul className="announcement-list">
        {rows.map(row => <li key={row.id}>
          <button type="button" aria-pressed={selected?.id === row.id} onClick={() => setSelected(row)}>{row.headline}</button>
          <p className="cell-secondary">{new Date(row.publishedAt).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}</p>
          <p className="cell-secondary">{row.topics.map(id => labels.get(id) ?? id).join(', ')}</p>
        </li>)}
      </ul>}
      {topics.isError && <p role="alert" className="notice">Category labels could not be loaded. Filing topic IDs are shown. <button className="button button-ghost" onClick={() => void topics.refetch()}>Retry categories</button></p>}
      {year !== 'recent' && history.data && <div className="pagination">
        <button type="button" className="button button-secondary" disabled={!page || history.isFetching} onClick={() => {setPage(page - 1); setSelected(null);}}>Newer</button>
        <span className="pagination-page">Page {page + 1} of {history.data.pages}</span>
        <button type="button" className="button button-secondary" disabled={page + 1 >= history.data.pages || history.isFetching} onClick={() => {setPage(page + 1); setSelected(null);}}>Older</button>
      </div>}
      {selected && <section className="announcement-evidence" aria-label="Filing evidence" aria-live="polite">
        <strong>{selected.headline}</strong><p className="mt-1 capitalize">Status: {selected.status.replaceAll('_', ' ')}</p>
        {detail.isPending && <p className="mt-2">Loading evidence...</p>}
        {detail.isError && <p role="alert" className="mt-2">{detail.error.message} <button type="button" className="button button-ghost" onClick={() => void detail.refetch()}>Retry</button></p>}
        {events.map((event, index) => event.evidence?.excerpt && <p key={index} className="mt-2"><span className="font-medium">{labels.get(event.topic) ?? event.topic}: </span>{event.evidence.excerpt}</p>)}
        {selected.url && /^https?:\/\//i.test(selected.url) && <a href={selected.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-2 text-teal-700 underline">Open source document<ExternalLink size={13} /></a>}
      </section>}
    </div>
  </Dialog>;
}
