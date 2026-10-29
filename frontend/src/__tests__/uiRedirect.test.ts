import {expect, it} from 'vitest';
import {isServedPath, pageRedirect} from '../../../workers/screener-ai/uiRedirect';

const journal = 'https://www.nexusjournal.co.in/scanner';

it('sends a browser opening the Worker pages to the journal, without caching the move', () => {
  for (const path of ['/', '/index.html', '/screener', '/ipo', '/assets/index-abc.js', '/favicon.svg']) {
    const response = pageRedirect(path, journal);
    expect(response?.status, path).toBe(302);
    expect(response?.headers.get('Location'), path).toBe(journal);
    expect(response?.headers.get('Cache-Control'), path).toBe('no-store');
  }
});

it('carries the query string, so shared screen links still open the screen in the journal', () => {
  expect(pageRedirect('/', journal, '?screen=eyJhIjoxfQ')?.headers.get('Location')).toBe(`${journal}?screen=eyJhIjoxfQ`);
  expect(pageRedirect('/', journal, '')?.headers.get('Location')).toBe(journal);
});

it('leaves the data and API the journal fetches from this address untouched', () => {
  for (const path of ['/data/current.json', '/data/revisions/abc/stocks.json.gz', '/api/screener/ai-compile', '/api/other']) {
    expect(isServedPath(path), path).toBe(true);
    expect(pageRedirect(path, journal), path).toBeNull();
  }
  // Prefixes only: a page named after them is still a page.
  expect(pageRedirect('/data', journal)?.status).toBe(302);
  expect(pageRedirect('/datasets', journal)?.status).toBe(302);
});

it('serves the UI itself when no redirect is configured (local development)', () => {
  expect(pageRedirect('/', undefined)).toBeNull();
  expect(pageRedirect('/screener', '')).toBeNull();
});
