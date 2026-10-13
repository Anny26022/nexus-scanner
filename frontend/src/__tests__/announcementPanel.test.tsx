import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AnnouncementsPanel } from '../components/AnnouncementsPanel';
import { DataUnavailableError } from '../api/dataErrors';
import { screenerApi } from '../api/screenerApi';
import type { Announcement } from '../api/announcements';

vi.mock('../api/screenerApi', () => ({screenerApi: {getAnnouncements: vi.fn(), getAnnouncementTopics: vi.fn(), getAnnouncementHistory: vi.fn(), getAnnouncementDetail: vi.fn()}}));
afterEach(() => {cleanup(); vi.clearAllMocks();});
const filing: Announcement = {id: '1', headline: 'New supply order', publishedAt: '2026-10-09T10:00:00Z', topics: ['order_win'], status: 'approved', detailPage: 'f'.repeat(64), url: 'https://example.com/filing.pdf'};
function open(onClose = vi.fn()) {
  const client = new QueryClient({defaultOptions: {queries: {retry: 2, retryDelay: 10}}});
  render(<QueryClientProvider client={client}><AnnouncementsPanel symbol="TEST" revision={'a'.repeat(64)} onClose={onClose} /></QueryClientProvider>);
  return onClose;
}

it('distinguishes unpublished data from an empty filing period and does not retry it automatically', async () => {
  vi.mocked(screenerApi.getAnnouncements).mockRejectedValue(new DataUnavailableError('Configure storage and publish a complete release.', 'not_published'));
  const close = open();
  expect(await screen.findByRole('alert')).toHaveTextContent('Announcements not published');
  expect(screen.queryByText('No filings in this period')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', {name: 'Retry'})).not.toBeInTheDocument();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(screenerApi.getAnnouncements).toHaveBeenCalledTimes(1);
  fireEvent(screen.getByRole('dialog'), new Event('cancel', {bubbles: true}));
  expect(close).toHaveBeenCalledTimes(1);
});

it('shows missing-file errors and allows a deliberate retry without treating them as no filings', async () => {
  vi.mocked(screenerApi.getAnnouncements).mockRejectedValueOnce(new DataUnavailableError('Announcement file missing.', 'not_found'))
    .mockResolvedValueOnce({records: [], years: [], publishedAt: filing.publishedAt});
  vi.mocked(screenerApi.getAnnouncementTopics).mockResolvedValue([]);
  open();
  expect(await screen.findByRole('alert')).toHaveTextContent('Announcement file missing');
  fireEvent.click(screen.getByRole('button', {name: 'Retry'}));
  expect(await screen.findByText('No filings in this period')).toBeInTheDocument();
});

it('loads summaries first, then fetches evidence on selection and pages history', async () => {
  vi.mocked(screenerApi.getAnnouncements).mockResolvedValue({records: [filing], years: [2026], publishedAt: filing.publishedAt});
  vi.mocked(screenerApi.getAnnouncementTopics).mockResolvedValue([{id: 'order_win', group: 'business', label: 'Order win'}]);
  vi.mocked(screenerApi.getAnnouncementDetail).mockResolvedValue({classification: {events: [{topic: 'order_win', evidence: {excerpt: 'Signed supply contract'}}]}});
  vi.mocked(screenerApi.getAnnouncementHistory).mockResolvedValue({records: [filing], pages: 2});
  open();
  const summary = await screen.findByRole('button', {name: filing.headline});
  expect(screenerApi.getAnnouncementDetail).not.toHaveBeenCalled();
  fireEvent.click(summary);
  expect(await screen.findByText('Signed supply contract')).toBeInTheDocument();
  expect(screen.getByRole('link', {name: 'Document'})).toHaveAttribute('href', filing.url);
  expect(screenerApi.getAnnouncementDetail).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole('combobox', {name: 'Announcement history'}), {target: {value: '2026'}});
  fireEvent.click(await screen.findByRole('button', {name: 'Older'}));
  await waitFor(() => expect(screenerApi.getAnnouncementHistory).toHaveBeenLastCalledWith('TEST', 2026, 1, 'a'.repeat(64)));
});
