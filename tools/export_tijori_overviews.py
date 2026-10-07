"""Collect public Tijori snapshot/watch sections for a pinned NSE universe."""
import argparse
from collections import Counter, defaultdict
import asyncio
from datetime import datetime, timezone
import gzip
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
from urllib.parse import urlencode, urlparse
from email.utils import parsedate_to_datetime

import httpx
import xml.etree.ElementTree as ET

BASE = 'https://www.tijorifinance.com'


def now():
    return datetime.now(timezone.utc).isoformat()


def normalized(value):
    value = re.sub(r'\b(limited|ltd)\b', '', value.lower().replace('&', 'and'))
    return re.sub('[^a-z0-9]', '', value)


class ExtractionError(ValueError):
    def __init__(self, url, reason):
        super().__init__(reason)
        self.url = url


class CompanyParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script' and dict(attrs).get('id') == 'company_details_data':
            self.active = True

    def handle_data(self, value):
        if self.active:
            self.parts.append(value)

    def handle_endtag(self, tag):
        if tag == 'script':
            self.active = False


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def publish(public_root, rows, metadata):
    reports = {
        row['symbol']: {'name': row['name'], 'sourceUrl': row['sourceUrl'], **row['memory_overview']}
        for row in rows if row['status'] == 'available'
    }
    if not reports:
        return  # Preserve the current publication if no reports could be collected.
    content = json.dumps(reports, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    revision = hashlib.sha256(content).hexdigest()
    root = public_root / 'data/tijori'
    dataset = root / 'revisions' / revision / 'overviews.json.gz'
    dataset.parent.mkdir(parents=True, exist_ok=True)
    if dataset.exists():
        if gzip.decompress(dataset.read_bytes()) != content:
            raise ValueError('Existing Tijori revision does not match its content hash')
    else:
        temporary = dataset.with_suffix('.tmp')
        temporary.write_bytes(gzip.compress(content, mtime=0))
        temporary.replace(dataset)
    atomic_json(root / 'current.json', {
        'schemaVersion': 1, 'revision': revision, 'updatedAt': metadata['exportedAt'],
        'reportCount': len(reports), 'universeSessionDate': metadata['universeSessionDate'],
        'universeRevision': metadata['universeRevision'], 'encoding': 'gzip',
        'datasetUrl': f'/data/tijori/revisions/{revision}/overviews.json.gz',
    })


class Fetcher:
    """One connection pool with gradual growth and shared error backoff."""
    def __init__(self, client, rate, concurrency):
        self.client, self.max_rate, self.maximum = client, rate, concurrency
        self.rate, self.capacity = min(2, rate), min(2, concurrency)
        self.active = self.successes = self.requests = 0
        self.next_slot = self.paused_until = 0.0
        self.lock = asyncio.Lock()
        self.stopped = False

    async def request(self, url, headers=None):
        if urlparse(url).netloc != 'www.tijorifinance.com':
            raise ValueError('Unexpected source host')
        for attempt in range(3):
            while True:
                async with self.lock:
                    if self.stopped:
                        raise RuntimeError('collection_stopped')
                    current = time.monotonic()
                    if self.active < self.capacity and current >= max(self.next_slot, self.paused_until):
                        self.active += 1
                        self.requests += 1
                        self.next_slot = current + 1 / self.rate
                        break
                await asyncio.sleep(0.05)
            response = None
            try:
                response = await self.client.get(url, headers=headers or {})
                transient = response.status_code == 429 or response.status_code >= 500
            except httpx.TransportError:
                transient = True
                if attempt == 2:
                    raise
            finally:
                async with self.lock:
                    self.active -= 1
                    if response is None or response.status_code == 429 or response.status_code >= 500:
                        self.capacity = max(1, self.capacity // 2)
                        self.rate = max(0.2, self.rate / 2)
                        self.successes = 0
                        delay = 2 ** (attempt + 1)
                        if response is not None and response.status_code == 429:
                            delay = max(delay, 30)
                            retry = response.headers.get('Retry-After')
                            if retry:
                                try:
                                    delay = max(delay, float(retry))
                                except ValueError:
                                    try:
                                        delay = max(delay, parsedate_to_datetime(retry).timestamp() - time.time())
                                    except (ValueError, TypeError, OverflowError):
                                        pass
                            if attempt == 2:
                                self.stopped = True
                        self.paused_until = max(self.paused_until, time.monotonic() + delay)
                        print(f'Backing off: concurrency={self.capacity}, rate={self.rate:g}/s, pause={delay:g}s', flush=True)
                    elif response.is_success or response.status_code == 304:
                        self.successes += 1
                        if self.successes >= 20 and time.monotonic() >= self.paused_until:
                            self.capacity = min(self.maximum, self.capacity + 1)
                            self.rate = min(self.max_rate, self.rate + 1)
                            self.successes = 0
            if transient and attempt < 2:
                continue
            if response.status_code != 304:
                response.raise_for_status()
            return response


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-root', type=Path, default=Path('frontend/public'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sitemap', type=Path, required=True)
    parser.add_argument('--rate', type=float, default=8, help='Maximum requests/second; starts at 2')
    parser.add_argument('--concurrency', type=int, default=8)
    parser.add_argument('--refresh', action='store_true', help='Recheck cached reports and download a fresh sitemap')
    parser.add_argument('--finalize-only', action='store_true')
    parser.add_argument('--retry-unmapped', action='store_true')
    args = parser.parse_args()
    if args.rate <= 0 or args.concurrency < 1:
        parser.error('--rate and --concurrency must be positive')
    args.output.mkdir(parents=True, exist_ok=True)
    snapshot_path = args.output / 'universe.json'
    if snapshot_path.exists() and (not args.refresh or args.finalize_only):
        snapshot = json.loads(snapshot_path.read_text())
    else:
        manifest = json.loads((args.public_root / 'data/current.json').read_text())
        dataset = json.loads((args.public_root / manifest['datasetUrl'].lstrip('/')).read_text())
        stocks = [{'symbol': s['symbol'], 'name': s['name']} for s in dataset['stocks']]
        assert len(stocks) == len({s['symbol'] for s in stocks}) == manifest['totalStocks']
        snapshot = {'manifest': manifest, 'stocks': stocks}
        atomic_json(snapshot_path, snapshot)
    stocks, manifest = snapshot['stocks'], snapshot['manifest']
    limits = httpx.Limits(max_connections=args.concurrency, max_keepalive_connections=args.concurrency, keepalive_expiry=60)
    async with httpx.AsyncClient(limits=limits, timeout=30, follow_redirects=False,
                                headers={'User-Agent': 'NexusResearchExport/1.0'}) as client:
        fetcher = Fetcher(client, args.rate, args.concurrency)
        if args.refresh and not args.finalize_only:
            response = await fetcher.request(BASE + '/sitemap.xml')
            args.sitemap.write_bytes(response.content)
        entries = ET.parse(args.sitemap).getroot().findall('{*}url')
        index = defaultdict(list)
        for entry in entries:
            url = entry.findtext('{*}loc')
            path = urlparse(url).path.strip('/').split('/')
            if urlparse(url).netloc == 'www.tijorifinance.com' and len(path) == 2 and path[0] == 'company':
                index[normalized(path[1].replace('-', ' '))].append(url)
        journal = args.output / 'responses.jsonl'
        records = {}
        cache = args.output / 'tijori-overviews.json.gz'
        if cache.exists():
            records = {r['symbol']: r for r in json.loads(gzip.decompress(cache.read_bytes()))['records']}
        if journal.exists():
            for line in journal.read_text().splitlines():
                if line.strip():
                    record = json.loads(line)
                    records[record['symbol']] = record

        async def collect(stock):
            previous = records.get(stock['symbol'], {})
            row = {**stock, 'fetchedAt': now()}
            inspected = []
            identities = []
            try:
                async def inspect(url):
                    if url in inspected:
                        return None
                    inspected.append(url)
                    cached = previous if previous.get('sourceUrl') == url and previous.get('status') in ('available', 'no_overview') else {}
                    validators = {header: cached[key] for header, key in [('If-None-Match', 'etag'), ('If-Modified-Since', 'lastModified')] if cached.get(key)}
                    response = await fetcher.request(url, validators)
                    if response.status_code == 304:
                        if not cached:
                            raise ValueError('304 without a cached company report')
                        return {**{k: v for k, v in cached.items() if k != 'refreshError'}, 'checkedAt': now()}
                    html = response.text
                    p = CompanyParser()
                    p.feed(html)
                    if not p.parts:
                        raise ExtractionError(url, 'Missing company_details_data script')
                    try:
                        data = json.loads(''.join(p.parts))
                    except ValueError as error:
                        raise ExtractionError(url, 'Invalid company_details_data JSON') from error
                    if not isinstance(data, dict) or not data.get('symbol'):
                        raise ExtractionError(url, 'Missing company symbol in embedded data')
                    identities.append({'sourceUrl': url, 'company': data.get('company'), 'symbol': data.get('symbol')})
                    if str(data.get('symbol', '')).upper() != stock['symbol'].upper():
                        return None
                    overview = data.get('memory_overview')
                    valid = isinstance(overview, dict) and (overview.get('the_read') or overview.get('what_to_watch'))
                    return {**row, 'fetchedAt': now(), 'status': 'available' if valid else 'no_overview',
                            'sourceUrl': url, 'sourceSymbol': data['symbol'], 'sourceCompanyId': data.get('company_id'),
                            'memory_overview': overview, 'checkedAt': now(),
                            'etag': response.headers.get('ETag'), 'lastModified': response.headers.get('Last-Modified')}

                known_url = previous.get('sourceUrl') or previous.get('candidateUrl')
                if known_url:
                    result = await inspect(known_url)
                    if result:
                        return result
                candidates = index.get(normalized(stock['name']), [])
                if len(candidates) == 1:
                    result = await inspect(candidates[0])
                    if result:
                        return result
                matches = []
                words = re.findall(r'[A-Za-z]{4,}', stock['name'])
                generic = {'industries', 'limited', 'services', 'enterprises', 'technologies', 'chemical', 'chemicals'}
                words = sorted((w for w in words if w.lower() not in generic), key=len, reverse=True)[:2]
                queries = list(dict.fromkeys([stock['symbol'], stock['name'], *words]))
                for query in queries:
                    search_url = BASE + '/api/v1/ind/company_search/?' + urlencode({'q': query})
                    results = (await fetcher.request(search_url)).json()
                    if isinstance(results, str):
                        results = json.loads(results)
                    candidates = [r for r in results if r.get('type') == 'companies']
                    candidates.sort(key=lambda r: normalized(r['name']) != normalized(stock['name']))
                    matches.extend(candidates)
                    for match in candidates[:3]:
                        slug = match['slug']
                        if not re.fullmatch('[a-zA-Z0-9_-]+', slug):
                            continue
                        result = await inspect(BASE + '/company/' + slug + '/')
                        if result:
                            return result
                failure = {**row, 'status': 'unmapped', 'inspectedUrls': inspected,
                           'inspectedIdentities': identities,
                           'searchMatches': [{'name': r['name'], 'slug': r['slug']} for r in matches]}
                return {**previous, 'checkedAt': now(), 'refreshError': failure} if previous.get('status') in ('available', 'no_overview') else failure
            except ExtractionError as error:
                failure = {**row, 'status': 'extraction_error', 'candidateUrl': error.url,
                           'error': str(error), 'inspectedUrls': inspected}
                return {**previous, 'checkedAt': now(), 'refreshError': failure} if previous.get('status') in ('available', 'no_overview') else failure
            except httpx.HTTPStatusError as error:
                failure = {**row, 'status': 'rate_limited' if error.response.status_code == 429 else 'http_error', 'httpStatus': error.response.status_code, 'inspectedUrls': inspected}
                return {**previous, 'checkedAt': now(), 'refreshError': failure} if previous.get('status') in ('available', 'no_overview') else failure
            except RuntimeError as error:
                return {**row, 'status': 'not_fetched', 'reason': str(error)}
            except (httpx.TransportError, OSError, ValueError, TypeError, KeyError) as error:
                failure = {**row, 'status': 'error', 'error': str(error), 'inspectedUrls': inspected}
                return {**previous, 'checkedAt': now(), 'refreshError': failure} if previous.get('status') in ('available', 'no_overview') else failure

        terminal = ('available', 'no_overview') if args.retry_unmapped else ('available', 'no_overview', 'unmapped')
        pending = [s for s in stocks if (args.refresh and records.get(s['symbol'], {}).get('status') in ('available', 'no_overview')) or records.get(s['symbol'], {}).get('refreshError') or records.get(s['symbol'], {}).get('status') not in terminal]
        print(f'Universe {manifest["sessionDate"]}: {len(stocks)} symbols; {len(pending)} to collect; rate {args.rate}/s', flush=True)
        started = time.monotonic()
        slots = asyncio.Semaphore(args.concurrency)
        async def bounded_collect(stock):
            async with slots:
                return await collect(stock)
        with journal.open('a') as output:
            tasks = [asyncio.create_task(bounded_collect(stock)) for stock in ([] if args.finalize_only else pending)]
            for processed, future in enumerate(asyncio.as_completed(tasks), 1):
                row = await future
                if row['status'] != 'not_fetched' or row['symbol'] not in records:
                    records[row['symbol']] = row
                    output.write(json.dumps(row, ensure_ascii=False) + '\n')
                    output.flush()
                if processed % 100 == 0 or processed == len(tasks):
                    print(f'{processed}/{len(tasks)} processed; requests={fetcher.requests}; elapsed={int(time.monotonic()-started)}s', flush=True)
        rows = [records.get(s['symbol'], {**s, 'status': 'not_fetched'}) for s in stocks]
        counts = dict(Counter(r['status'] for r in rows))
        metadata = {'source': 'Tijori Finance public company pages', 'exportedAt': now(),
                    'universeSessionDate': manifest['sessionDate'], 'universeRevision': manifest['revision'],
                    'totalSymbols': len(stocks), 'counts': counts,
                    'attemptedSymbols': sum(r['status'] != 'not_fetched' for r in rows),
                    'withBothSections': sum(bool(r.get('memory_overview', {}).get('the_read')) and bool(r.get('memory_overview', {}).get('what_to_watch')) for r in rows if r['status'] == 'available'),
                    'refreshErrors': sum(bool(r.get('refreshError')) for r in rows),
                    'complete': not any(r.get('refreshError') or r['status'] in ('not_fetched', 'error', 'extraction_error', 'http_error', 'rate_limited') for r in rows),
                    'note': 'Source symbols are verified against the NSE list; as_of dates belong to Tijori. Narrative claims have not been independently verified.'}
        atomic_json(args.output / 'tijori-overviews.json', {'metadata': metadata, 'records': rows})
        atomic_json(args.output / 'available-overviews.json', {'metadata': metadata, 'records': [r for r in rows if r['status'] == 'available']})
        atomic_json(args.output / 'exceptions.json', {'metadata': metadata, 'records': [r for r in rows if r['status'] != 'available' or r.get('refreshError')]})
        atomic_json(args.output / 'summary.json', metadata)
        for filename in ('tijori-overviews.json', 'available-overviews.json'):
            source = args.output / filename
            target = source.with_suffix('.json.gz')
            temporary = target.with_suffix('.tmp')
            temporary.write_bytes(gzip.compress(source.read_bytes(), mtime=0))
            temporary.replace(target)
        publish(args.public_root, rows, metadata)
        print(json.dumps(metadata, indent=2), flush=True)


if __name__ == '__main__':
    asyncio.run(main())
