# Tijori export

Install the one dependency:

```sh
python3 -m pip install -r tools/requirements-tijori.txt
```

Refresh the saved universe and reuse known company URLs:

```sh
python3 tools/export_tijori_overviews.py \
  --output reference/tijori \
  --sitemap reference/tijori/sitemap.xml \
  --refresh
```

One shared async HTTP connection pool starts at two requests in flight. Successful
requests gradually increase concurrency and throughput up to eight each by default.
`--concurrency` and `--rate` set ceilings. HTTP 429, server errors, and network
failures reduce both limits and pause requests. Retry-After is respected; persistent
429s stop the run. Good cached reports survive refresh failures.

Refresh downloads a fresh sitemap for URL discovery, then uses saved ETags and
Last-Modified headers for conditional requests. A 304 reuses the existing report.
Old exports need one refresh to save their HTTP validators. Savings depend on
whether Tijori supports those validators.

Without `--refresh`, the command resumes missing/failed records. Unmapped symbols
are retried only with `--retry-unmapped`. `--finalize-only` rebuilds exports without
network requests. Refresh reads the latest published NSE universe; resume and
finalize-only use the saved universe.json.

The weekly adjusted-history workflow runs this refresh after the data publication,
including scheduled Sunday runs and manual dispatch. It commits
`reference/tijori/tijori-overviews.json.gz` and `summary.json`. Fresh checkouts load
the compressed cache, so source URLs, reports and HTTP validators survive between
runs. The initial cache is seeded from the completed local NSE export. Per-company
errors preserve existing reports and appear in the summary/diagnostics; a failed
Tijori step does not block the market-data publication. Local HTML/checkpoint files
are excluded from Git.

Offline tests: `python3 -m unittest discover -s tools -p test_export_tijori_overviews.py`.

## Public dataset

The exporter also publishes `frontend/public/data/tijori/current.json` and
`revisions/<content-sha256>/overviews.json.gz`. The gzip JSON is an object keyed by
NSE symbol, containing only available company reports with source URLs and content
dates. Fetch metadata, checkpoints, validators, and failure diagnostics remain in
`reference/tijori/`. The dataset is written before the manifest; unchanged report
content reuses its revision. Weekly commits include the public manifest/revisions.

The manifest declares `encoding: gzip`. Consumers must explicitly decode gzip
bytes, unless the host supplies `Content-Encoding: gzip` and the browser already
decoded the response. The filename extension does not set that header.

A successful HTTP response missing valid embedded company data is an
`extraction_error`, not an unmapped company. The candidate URL is retained for
retry; company-symbol verification is still required before publication. HTTP
403 remains an HTTP error. These failures are retried on subsequent runs and
never replace a previously saved report.
