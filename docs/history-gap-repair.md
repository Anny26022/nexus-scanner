# Recent stock-history integrity

A current candle does not establish continuous history. On October 6, 2026, a
scanner-history cache miss restored adjusted EOD2 history through September 25;
applying the October 6 official candle then hid the intervening missing sessions
from the old readiness and first/last-date range checks.

## Daily and weekly pipeline behavior

Both workflows use the same pipeline. The existing official delivery-history
fetch now finishes in the OHLCV lane before stock history is checked. Its latest
30 date-aligned files define which sessions each current symbol actually traded.
No calendar-day approximation or guessed holiday calendar is introduced.

Readiness checks and the existing Dhan adjusted-history fallback now repair
missing sessions from each security's first observed date onward, including
trailing sessions; an empty cache must supply all expected dates. Existing
backward/forward bootstrap still handles the outer ranges. A healthy history
makes no additional per-stock history request. Fallback responses fill absent
dates only, preserving all existing adjusted candles and the official latest candle. An empty or partial provider response
that leaves an identified internal gap makes the required history stage fail.

Unusable ledger files are skipped with warnings; an entirely unusable ledger
fails the required history stage.

The publication gate requires all 30 expected dates from the official delivery
ledger through the benchmark session to be present exactly once in breadth:
each must cover at least 90% of the eligible population. It records deficient
dates in `data_quality_failure.json` on rejection and blocks promotion even if
today's coverage is healthy. The 90% threshold is an operational guard against widespread ingestion
failure, not proof that every stock has complete history.

This is bounded recent-gap recovery, not a certification of complete lifetime
history, corporate-action adjustments or every financial field. It retains the
existing cache, history provider, retries and publication rollback behavior.
Turnover preservation already implemented on the newer base-engine branch is
not duplicated here. Private R2 backups remain a separate recovery improvement.

## Recovering the affected release

Merge the repair and rerun the daily or weekly refresh. It restores/seeds history,
repairs recent internal gaps, regenerates the derived artifacts and publishes
only after the new gate passes. Do not edit breadth counts or release pointers
by hand. The existing published October 6 artifacts are not changed merely by
installing this code.
