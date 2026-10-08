import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import type { Announcement } from '../api/announcements';

type Props = { symbol: string; revision: string; onClose: () => void };
export function AnnouncementsPanel({ symbol, revision, onClose }: Props) {
  const [year, setYear] = useState<number | 'recent'>('recent');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Announcement | null>(null);
  const recent = useQuery({queryKey: ['announcements', symbol, revision], queryFn: () => screenerApi.getAnnouncements(symbol, revision), staleTime: Infinity});
  const history = useQuery({queryKey: ['announcementHistory', symbol, year, page, revision],
    queryFn: () => screenerApi.getAnnouncementHistory(symbol, Number(year), page, revision), enabled: year !== 'recent', staleTime: Infinity});
  const detail = useQuery({queryKey: ['filingDetail', symbol, selected?.id, selected?.detailPage, revision],
    queryFn: () => screenerApi.getAnnouncementDetail(symbol, selected!, revision), enabled: Boolean(selected), staleTime: Infinity});
  const topics = useQuery({queryKey: ['announcementTopics', revision], queryFn: () => screenerApi.getAnnouncementTopics(revision), staleTime: Infinity});
  const labels = new Map(topics.data?.map(topic => [topic.id, topic.label]));
  const rows = year === 'recent' ? recent.data?.records : history.data?.records;
  const active = year === 'recent' ? recent : history;
  const events = (detail.data?.classification as {events?: Array<{topic: string; evidence?: {excerpt?: string}}> } | undefined)?.events ?? [];
  return <section aria-label={`${symbol} announcements`} className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-800">
    <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">{symbol} announcements</h3>
      <button type="button" onClick={onClose} className="text-slate-600">Close</button></div>
    <label>History <select aria-label="Announcement history" value={year} className="ml-2 rounded border border-slate-200 p-1.5"
      onChange={event => {setYear(event.target.value === 'recent' ? 'recent' : Number(event.target.value)); setPage(0); setSelected(null);}}>
      <option value="recent">Last 90 days</option>{recent.data?.years.map(value => <option key={value} value={value}>{value}</option>)}
    </select></label>
    {recent.data && <p className="mt-2 text-slate-500">Snapshot {new Date(recent.data.publishedAt).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}</p>}
    {active.isPending && <p role="status" className="py-4">Loading filings…</p>}
    {active.isError && <p role="alert" className="py-4">{active.error.message} <button type="button" onClick={() => void active.refetch()}>Retry</button></p>}
    {rows && !rows.length && <p className="py-4 text-slate-500">No filings in this period.</p>}
    <ul className="mt-3 max-h-80 divide-y divide-slate-100 overflow-auto">
      {rows?.map(row => <li key={row.id} className="py-3">
        <button type="button" onClick={() => setSelected(row)} className="text-left font-medium text-teal-800">{row.headline}</button>
        <p className="mt-1 text-slate-500">{new Date(row.publishedAt).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})} · {row.topics.map(id => labels.get(id) ?? id).join(', ')}</p>
      </li>)}
    </ul>
    {year !== 'recent' && history.data && <div className="mt-3 flex items-center gap-3">
      <button type="button" disabled={!page} onClick={() => {setPage(page - 1); setSelected(null);}}>Newer</button>
      <span>Page {page + 1} of {history.data.pages}</span>
      <button type="button" disabled={page + 1 >= history.data.pages} onClick={() => {setPage(page + 1); setSelected(null);}}>Older</button>
    </div>}
    {selected && <div className="mt-4 rounded-lg bg-slate-50 p-3" aria-live="polite">
      <strong>{selected.headline}</strong><p className="mt-1 capitalize">Status: {selected.status.replaceAll('_', ' ')}</p>
      {detail.isPending && <p className="mt-2">Loading evidence…</p>}
      {detail.isError && <p role="alert" className="mt-2">{detail.error.message} <button type="button" onClick={() => void detail.refetch()}>Retry</button></p>}
      {events.map((event, index) => event.evidence?.excerpt && <p key={index} className="mt-2"><span className="font-medium">{labels.get(event.topic) ?? event.topic}: </span>{event.evidence.excerpt}</p>)}
      {selected.url && /^https?:\/\//i.test(selected.url) && <a href={selected.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-teal-700 underline">Open source document</a>}
    </div>}
  </section>;
}
