# Filing classification

The pipeline publishes 60 disclosure topics using the versioned, deterministic
rulebook in `DO NOT DELETE EDL PIPELINE/filing_classification.py`. Classification
describes filing content, not financial impact or a recommendation. It does not
claim to reproduce any other site's private classifier.

## Sources and publication

`fetch_company_filings.py` retains Dhan/ScanX company-filings and LODR metadata,
including descriptor, announcement type, caption, body, publication time and
document URL. The resumable cache remains the raw source of record.
`build_filing_history_artifact.py` classifies the entire retained history every
publication, so rule changes also update old records without refetching them.
The artifact contains the taxonomy, classifier version, filing count and
unclassified count. Daily and weekly workflows already run this stage before
chart generation.

`build_chart_artifacts.py` carries the classification, original publication
timestamp, source labels, source endpoints and filing ID into per-symbol
compressed chart files. The existing R2 publisher uploads these with the chart
release. A taxonomy accompanies each chart for consumers; the existing generic
`category` field remains compatible. No classification runs in the browser.
This PR does not deploy or replace active R2 releases.

Official NSE corporate actions remain authoritative for action dates and price
adjustments. A filing publication date is not an ex-date or meeting date.
Filing topics do not change adjustment factors. Automatic cross-source action
linking is deferred until there is a reliable matching contract.

## Rules and meaning

Specific source labels precede caption/body fallback. Generic announcements and
procedural documents can be refined by their text. Multiple topics are allowed;
document type and status are separate fields. Status can be proposed, approved,
completed, withdrawn, cancelled, revised or unspecified. These are textual
signals, not confirmation that a transaction has settled.

Tax/legal orders are excluded from order wins. Trading-window notices and
trading plans are excluded from insider transactions. Meeting intimations do
not claim financial results have been announced. ESOP and daily buyback
paperwork have their own labels. Unknown records remain `unclassified`.
Every matched topic carries a stable rule ID and classifier version.

Identical same-time documents with the same URL, caption and body merge across
feeds while retaining source labels and endpoints. Revised content and different
timestamps remain separate. This conservative merge can leave duplicates where
the feeds use different timestamps or wording; it avoids erasing real updates.

## Limits and validation

Rules inspect metadata/text only, not PDF attachments. They cannot prove semantic
correctness for every record. Before enabling category filters, review a stratified
sample, especially legal orders, defaults, governance and fundraising. Track the
unclassified rate and refine the rulebook with regression fixtures. Importance
is a user display preference; no inferred importance score is published.

The historical archive is large. Publication reclassifies it in memory with the
existing artifact builder; an incremental classified cache is deferred until
measured runtime justifies the extra storage and invalidation logic.
