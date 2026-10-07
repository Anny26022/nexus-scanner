import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { screenerApi } from '../api/screenerApi';
import { filterAnnouncements, type AnnouncementFilter } from '../api/announcements';

type Props = { revision?: string; value?: AnnouncementFilter; onChange: (value?: AnnouncementFilter) => void };
export function AnnouncementFilterControl({ revision, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [window, setWindow] = useState<AnnouncementFilter['window']>(value?.window ?? '7d');
  const data = useQuery({ queryKey: ['announcementFilterData', revision],
    queryFn: async () => {
      const [index, topics] = await Promise.all([screenerApi.getAnnouncementIndex(revision), screenerApi.getAnnouncementTopics(revision)]);
      return {index, topics};
    }, enabled: open, staleTime: Infinity });
  const records = data.data ? filterAnnouncements(data.data.index, {topics: [], window}) : [];
  const groups = [...new Set(data.data?.topics.map(topic => topic.group) ?? [])];
  return <details className="relative shrink-0 text-xs text-slate-800" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer whitespace-nowrap rounded-md border border-slate-200 bg-white px-3 py-1.5 text-slate-700">
      Announcements{value ? ` · ${value.topics.length || 'All'}` : ''}
    </summary>
    <div className="absolute left-0 z-30 mt-2 w-80 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
      <div className="mb-3 flex items-center justify-between"><strong>Filter announcements</strong>
        <button type="button" onClick={() => onChange(undefined)} className="text-teal-700">Clear</button></div>
      <label className="block">Period
        <select aria-label="Announcement period" value={window} className="my-2 w-full rounded border border-slate-200 p-2"
          onChange={event => { const next = event.target.value as AnnouncementFilter['window']; setWindow(next); if (value) onChange({...value, window: next}); }}>
          <option value="since_close">Since last close</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
        </select>
      </label>
      <input aria-label="Find announcement category" placeholder="Find a category" value={search} onChange={event => setSearch(event.target.value)}
        className="mb-3 w-full rounded border border-slate-200 p-2" />
      {data.isPending && <p role="status">Loading announcements…</p>}
      {data.isError && <p role="alert">{data.error.message}<button type="button" className="ml-2 text-teal-700" onClick={() => void data.refetch()}>Retry</button></p>}
      {data.data && <>
        <p className="mb-2 text-[11px] text-slate-500">Mainboard filings · snapshot {new Date(data.data.index.publishedAt).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}</p>
        <label className="flex gap-2 py-2"><input type="checkbox" checked={Boolean(value && !value.topics.length)}
          onChange={event => onChange(event.target.checked ? {topics: [], window} : undefined)} />Any announcement ({records.length})</label>
        <div className="max-h-72 overflow-auto">
          {groups.map(group => {
            const topics = data.data!.topics.filter(topic => topic.group === group && topic.label.toLowerCase().includes(search.toLowerCase()));
            if (!topics.length) return null;
            return <fieldset key={group} className="mb-3"><legend className="py-1 font-semibold capitalize">{group.replaceAll('_', ' ')}</legend>
              {topics.map(topic => <label key={topic.id} className="flex items-center gap-2 py-1.5">
                <input type="checkbox" checked={value?.topics.includes(topic.id) ?? false} onChange={event => {
                  const selected = event.target.checked ? [...(value?.topics ?? []), topic.id] : (value?.topics ?? []).filter(id => id !== topic.id);
                  onChange(selected.length ? {topics: selected, window} : undefined);
                }} /><span className="flex-1">{topic.label}</span><span className="text-slate-500">{records.filter(row => row.topics.includes(topic.id)).length}</span>
              </label>)}
            </fieldset>;
          })}
        </div>
      </>}
    </div>
  </details>;
}
