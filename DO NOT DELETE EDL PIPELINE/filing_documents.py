"""Bounded, cached extraction for ambiguous official disclosure attachments."""
from datetime import date, datetime, timedelta, timezone
import hashlib
import io
import os
import time
from urllib.parse import urlsplit, urljoin
import requests
from pipeline_utils import load_json, save_json

HOSTS = {'www.bseindia.com', 'bseindia.com', 'nsearchives.nseindia.com', 'archives.nseindia.com'}
MAX_BYTES = 4 * 1024 * 1024


def document_key(row):
    return hashlib.sha256(repr(tuple(row.get(k) for k in ('file_url', 'news_date', 'caption', 'news_body'))).encode()).hexdigest()


def download_pdf(url):
    started = time.monotonic()
    for _ in range(4):
        parts = urlsplit(url)
        if parts.scheme != 'https' or parts.hostname not in HOSTS or parts.port not in (None, 443) or parts.username:
            raise ValueError('Unsupported disclosure host')
        with requests.get(url, timeout=(5, 10), stream=True, allow_redirects=False) as response:
            if response.is_redirect:
                url = urljoin(url, response.headers['Location'])
                continue
            response.raise_for_status()
            data = bytearray()
            for chunk in response.iter_content(65536):
                if len(data) + len(chunk) > MAX_BYTES or time.monotonic() - started > 20:
                    raise ValueError('Disclosure download exceeds budget')
                data.extend(chunk)
            if not data.startswith(b'%PDF-'):
                raise ValueError('Disclosure is not a PDF')
            return bytes(data)
    raise ValueError('Too many disclosure redirects')


def extract_document(url):
    from pypdf import PdfReader
    data = download_pdf(url)
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise ValueError('Encrypted disclosure')
    pages = [{'page': i + 1, 'text': (reader.pages[i].extract_text() or '')[:4000]}
             for i in range(min(5, len(reader.pages)))]
    return {'status': 'extracted' if any(p['text'].strip() for p in pages) else 'unreadable',
            'sha256': hashlib.sha256(data).hexdigest(), 'pages': pages,
            'pagesExamined': len(pages), 'totalPages': len(reader.pages),
            'truncated': len(reader.pages) > 5 or any(len(p['text']) == 4000 for p in pages)}


def enrich_documents(records, root, as_of):
    from filing_classification import classify_filing, _WRAPPERS
    path = root / 'filing_history_data/document_text.json'
    cache = load_json(path, default={})
    limit = max(0, min(100, int(os.environ.get('EDL_FILING_PDF_LIMIT', '20'))))
    cutoff = (date.fromisoformat(as_of) - timedelta(days=14)).isoformat()
    # Include old cached documents for deterministic reclassification; only
    # uncached recent disclosures may trigger a download.
    candidates = [row for record in records for row in record.get('filings', [])
                  if urlsplit(str(row.get('file_url') or '')).hostname in HOSTS
                  and (document_key(row) in cache or cutoff <= str(row.get('news_date') or '')[:10] <= as_of)]
    candidates.sort(key=lambda row: str(row.get('news_date') or ''), reverse=True)
    fetched = 0
    now = datetime.now(timezone.utc)
    for row in candidates:
        key = document_key(row)
        cached = cache.get(key)
        if cached is None:
            topics = set(classify_filing(row)['topics'])
            if not topics <= _WRAPPERS | {'unclassified', 'strategic_agreement', 'corporate_guarantee', 'letter_of_intent'}:
                continue
        retry = cached and cached.get('status') == 'failed' and now - datetime.fromisoformat(cached['attemptedAt']) >= timedelta(days=1)
        recent = cutoff <= str(row.get('news_date') or '')[:10] <= as_of
        if recent and (cached is None or retry) and fetched < limit:
            fetched += 1
            try:
                cached = extract_document(row['file_url'])
            except Exception as error:
                cached = {'status': 'failed', 'error': type(error).__name__}
            cached['attemptedAt'] = now.isoformat()
            cache[key] = cached
        if cached:
            row['documentExtraction'] = cached
    if fetched:
        save_json(path, cache, ensure_ascii=False)
    print(f'Disclosure PDFs attempted: {fetched}; limit: {limit}.')
    return {'attempted': fetched, 'limit': limit}
