export interface Announcement {
  id: string;
  symbol?: string;
  publishedAt: string;
  headline: string;
  url?: string | null;
  topics: string[];
  status: string;
  detailPage: string;
}
export interface AnnouncementFilter {
  topics: string[];
  window: 'since_close' | '24h' | '7d';
}
export interface AnnouncementIndex {
  referenceSession: string;
  publishedAt: string;
  sinceLastClose: string;
  records: Announcement[];
}
export interface FilingTopic { id: string; group: string; label: string }
export interface AnnouncementCatalog {
  referenceSession: string;
  publishedAt: string;
  taxonomy: string;
  index: string;
  symbols: Record<string, {
    recent: string;
    years: Record<string, Array<{ summary: string; details: string; count: number }>>;
    fetchStatus: Record<string, unknown>;
  }>;
}

export function filterAnnouncements(index: AnnouncementIndex, filter: AnnouncementFilter): Announcement[] {
  const end = Date.parse(index.publishedAt);
  const start = filter.window === 'since_close' ? Date.parse(index.sinceLastClose)
    : end - (filter.window === '24h' ? 1 : 7) * 86400000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('Invalid announcement publication time');
  const topics = new Set(filter.topics);
  return index.records.filter(row => {
    const time = Date.parse(row.publishedAt);
    return time > start && time <= end && (!topics.size || row.topics.some(topic => topics.has(topic)));
  });
}
