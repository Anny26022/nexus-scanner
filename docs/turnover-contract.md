# Official turnover contract and migration audit

## Intent and data lineage

Use actual NSE daily traded value for closed-session scanner liquidity and base
liquidity. Retain valid price history when traded value is missing, return
unavailable for incomplete turnover windows, and never substitute close times
volume. BSE turnover and intraday turnover are outside this contract.

The canonical historical column is `Turnover` in rupees, keyed by symbol and
session in the existing OHLCV CSV. Full bhavcopy `TURNOVER_LACS` is multiplied
by 100,000; legacy bhavcopy `TOTTRDVAL` is already in rupees. Crore outputs divide
by 10,000,000. Historical traded value is retained as reported, without applying
price adjustment factors to it.

Price refresh merges preserve this optional column. Daily backfill runs after
price fetching, caches compressed date-level NSE files, and atomically updates
CSV files. A missing or malformed optional turnover value does not delete an
otherwise valid candle. EQ is preferred when selecting an exchange series;
ambiguous mappings remain unavailable.

## Earlier, intermediate and corrected behavior

| Path | Earlier behavior | Corrected behavior |
| --- | --- | --- |
| Python average-turnover condition | Close times volume | Complete official window |
| Native 20/50/100-session averages | Estimated traded value | Official values; native display fields remain rounded |
| Base median liquidity | Estimated 20-session median | Complete official 20-session median |
| Browser publisher | Still estimated after the first ingestion change | Shared Python official-average helper |
| Cloudflare common-window scans | Could use the estimated public scalar | Official public scalar |
| Cloudflare arbitrary-window scans | Derived from OHLCV | Date-aligned official auxiliary series |
| Compact Python cache | Omitted traded value | Float64 turnover array; old caches rebuild from CSV |
| Immutable revision digest | Hashed only OHLCV history | Includes turnover history, including old-day corrections |
| Legacy preset baseline | Rounded native 50-session turnover | Unrounded official aligned 50-session mean |
| Missing-history bridge fallback | Could use old native turnover | Unavailable |

The browser publisher and cache omissions were real defects in the intermediate
implementation. The audit fixes prevent cold/warm-cache and scalar/history
execution paths from disagreeing for official turnover. Cache/publication code
is also included in the engine identity, preventing clients from accepting a
release built with the older semantics as an identical engine.

## Different statistics are intentional

- `AVG_TURNOVER`: mean of the latest N sessions, including the final closed
  session; every observation must be finite and nonnegative.
- Base `medianTurnover20`: median of 20 sessions ending on the selected base's
  measurement date. Pre-breakout selection freezes that measurement.
- `avg_rupee_volume_20`: preceding 20-session mean, excluding the current day.
- Breakout volume: share volume divided by the preceding 20-session median
  share volume. This is not a rupee-turnover filter.
- The original library presets retain their separate strict 50-session
  turnover >5 Cr baseline, price >10 and market cap >1,000 Cr. An explicit
  20-session turnover condition adds another gate; removing that overlap would
  be a separate preset policy change.

Mean versus median, current versus preceding windows, strict versus inclusive
comparisons, and rupee turnover versus share volume must not be interchanged.

## Local data verification, 5 October 2026

The one-time ten-year job requested 2016-10-03 through 2026-10-01, enriching
existing candles rather than creating absent price history. Independent
verification matched 3,891,462 retained turnover observations to cached NSE
files across 2,602 price histories. Only 1,208 histories reach the requested
start. Complete current windows number 2,560 / 2,392 / 2,359 for 20 / 50 / 100
sessions. The pipeline now refreshes up to 1,500 sessions, matching the supported base
horizon; cached official files are reused and older observations remain stored.

On the complete latest available windows in that local dataset, without
universe eligibility or other preset gates:

| Window | Estimated mean >=5 Cr | Official mean >=5 Cr | Official median >=5 Cr |
| --- | ---: | ---: | ---: |
| 20 | 1,207 | 1,207 | 1,048 |
| 50 | 1,246 | 1,247 | 1,015 |
| 100 | 1,272 | 1,274 | 1,004 |

The 50-session mean adds JLHL at this threshold. The 100-session mean adds
DAVANGERE, BANSALWIRE and JLHL and removes SWANDEF. These are liquidity-only
comparisons, not full screen results. Matching aggregate counts do not prove
matching numerical values: RELIANCE's 20-session estimate was 1,597.9164 Cr
against official mean 1,601.0791 Cr and median 1,449.5921 Cr.

## Source-of-truth limitations

This establishes a canonical official historical input and shared Python
average helper for conditions and publication. It does not establish one
application-wide turnover field or one executable implementation:

- `rupee_volume` / main and IPO table `rupeeVolumeCrore` still follow the legacy
  live/vendor quote path, which can use close times volume. Do not describe that
  display field as official historical NSE traded value.
- Python and TypeScript remain separate evaluators. Their comparison contract
  is tested, and public scalar publication reuses Python's helper.
- Native averages remain rounded for display; consumers must use official
  history/public unrounded scalar values for boundary comparisons.
- Missing source files can leave partial official coverage. The backfill reports
  failures; downstream complete-window rules remain unavailable rather than
  guessing values. Zero is a valid traded-value observation.
- Local files and Actions cache are not a durable historical backup guarantee.
  Private raw-history backup/recovery remains separate from scanner packs.
- Symbol/date matching does not reconstruct historical symbol renames, ISIN
  migrations or historical universe constituents.
- The private latest-session scanner pack retains at most 1,500 sessions per
  stock. A ten-year local CSV does not imply a ten-year arbitrary edge query.

This audit did not promote production data, upload R2 objects or deploy the
Worker. Adoption requires merging the branch and publishing/deploying one
matching revision and engine identity. Old immutable releases retain their
earlier values.

## Verification gates

Tests cover missing/invalid values, source unit conversions, NSE date validation,
series ambiguity, price-refresh preservation, old-cache reconstruction,
cold/warm publication equality, full-precision preset thresholds, private
official-window evaluation, and turnover-only immutable revision changes.
The production chart retention policy is independent of this history contract.

## Related base-engine differences to retain in the audit

The base engine now measures contraction, accumulation, strength and breakout
facts on one detected episode, freezes pre-breakout quality, and keeps subsequent
outcomes separate. This meets the stated causal measurement intent. It is not
proof that its detector, hierarchy or outcomes reproduce an external screener.

- Base RS uses a weighted 63/126/189/252-session score over current eligible
  Nexus peers. Ordinary scanner RS exposes multiple benchmark-relative horizons.
  The same 1–99 label does not make these populations/formulas identical.
- Current peer classifications and constituents are used in dated research;
  survivorship bias and historical industry reclassification remain unresolved.
- Structure levels derive from our closing-peak/parent policy. Overhead supply
  is currently a price-distance proxy `(past highest close / pivot - 1) * 100`,
  not measured volume distribution above the pivot.
- Quietest-day depth uses minimum share volume divided by median share volume.
  It must not silently become minimum rupee turnover divided by median turnover.
- Base ATR uses Wilder smoothing; a simple-mean ATR warehouse field is a
  different measurement. Base half-window contraction must use one specified
  smoothing convention on both halves.
- Legacy display ADR fields and `adr_percent_low_20` use `(high-low)/low`.
  Canonical `adr_percent_20`, scanner ADR and browser `adr20Pct` now consistently
  use `(high-low)/close`. The old display family remains for compatibility.
- Closing-price 52-week base context differs from intraday-high/low event gates.
- Outcomes depend on configured stop, trailing-average arming and execution
  timing. A frozen breakout-day summary is not a completed trade result.

These are disclosure/policy differences, not silently changed by the turnover
migration. Historical replay and real-cloud performance validation remain
necessary before claiming external parity or validated preset effectiveness.

The follow-up [measurement contract](measurement-contracts.md) makes these
distinctions selectable and corrects the publisher ATR initialization.
