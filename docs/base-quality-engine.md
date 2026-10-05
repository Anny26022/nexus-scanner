# Base quality, strength and breakout implementation

The implementation extends the scanner engine from PRs #20 and #21. It uses a
Nexus detector with causal closing-price peaks and configured pullbacks. It does
not claim result parity with another platform's undisclosed base detector.

## Completion requirements

- [x] Isolated branch on scanner compatibility baseline.
- [x] Initial causal base candidate and episode model.
- [x] Base boundaries, age, depth, parent relationships and closing-price pivot.
- [x] Average ATR and volume contraction; equal base slices.
- [x] Quiet-day depth/recency and up/down volume metrics.
- [x] Frozen breakout measurements and armed MA trailing exits.
- [x] Finish detection policy: local peak confirmation, overlap selection, nested
  invalidation, confirmed failed pokes and history completeness.
- [x] Historical RS ledger, rank progression, base RS summaries and industry
  relative returns with explicitly defined peer membership.
- [x] Trend distance/ratio/slope, median turnover and base context metrics.
- [x] Configurable strict holding and retest policies; episode termination facts.
- [x] Daily pipeline generation, artifact validation and durable episode outputs.
- [x] Public scalar metrics and private R2 episodes bound to one release revision.
- [x] Python, browser and advanced Worker evaluation with formula parity.
- [x] Editable Strong Bases, Fresh Breakouts, Holding Breakouts, VCP, Blue Sky,
  Multi-year and IPO Base presets.
- [x] Existing filter UI, compact stage selection and explanation columns.
- [x] Per-symbol chart base/pivot/breakout overlays.
- [x] Historical replay, forward outcome measurement and costs.
- [x] Golden fixtures, prefix-invariance tests, integration and browser fixture checks.
- [x] PR #26 with scope, dependencies and validation evidence; CI passes.
- [ ] Independent code review (the automated review currently skips this PR).
- [ ] Final full-generation measurement and complete aligned-data release check.

## Formula contracts

Base-specific metrics use the inclusive detected start/end boundaries. At
breakout they exclude the breakout candle and freeze. Current distance to pivot
continues updating. ATR uses the existing Wilder implementation; half-volume and
half-ATR measures are daily means, with the first half receiving the extra
session for odd lengths. Parts divide into contiguous halves, thirds, quarters
and fifths. Zero denominators and missing warmup/RS observations are unavailable.

The initial detector confirms a candidate after a 5% close pullback from a local
peak. A close above its fixed pivot after at least 15 base sessions triggers an
episode. The default base depth ceiling is 60% and maximum duration 1500 sessions;
quality preset thresholds are tighter. These detector choices are versioned and
need historical validation.

Breakout volume uses the preceding 20-session median, excluding breakout day.
Fresh status covers ages 0 through 5 inclusive (six sessions including breakout day). The default exit
is a closing-price stop 8% below pivot or a close below SMA50 after that trail has
armed. Exit timing and execution costs must be explicit in replay; calculated
hypothetical outcomes are not real executions.

## Publication foundation

Publication computes episodes from histories aligned to the release session.
The technical pack contains one deterministic summary per lifecycle stage,
selected by the most recent breakout date (or start date for forming bases),
with the stable ID as a tie breaker. Detailed base slices and episode events
are stored in the matching private R2 auxiliary shard. All filters for one
stage must refer to that same selected ID; matching unrelated bases across
conditions would be incorrect. Python, browser and Worker evaluate the same selected episode IDs. Slice
arithmetic routes the complete expression to the Worker. Complete episodes
and dated rank ledgers remain in separate private archive shards, verified
with the manifest and excluded from latest-session scans.

The initial strength ledger uses weighted 63/126/189/252-session returns
(40/20/20/20 percent), ranked among the currently eligible aligned Nexus peers.
It is not a historical constituent universe and is not survivorship-free.
Missing observations are not forward-filled. Industry return context currently
uses equal-weight current-classification peers including the subject, with at
least three available peers; dated industry context uses the same current classification on each session.
Rank changes use the market session ledger.

Median turnover estimates traded value as close times volume; it does not
claim to reproduce exchange-reported turnover. Listing age uses an official
listing date and is unavailable when absent, rather than using cache length.

A breakout failure (first close back inside the base) is separate from a trade
exit. Forward 5/20/60-session returns and excursions are only populated after
the full horizon exists and continue measuring market outcomes after an exit.
Replay includes explicit fees, slippage, next-session execution and per-symbol
cohort aggregation.

## Editable Nexus presets

Seven `lib-nexus-*` definitions extend the original 45 offline presets. Strong
Bases, Fresh Breakouts, Holding Breakouts, VCP Base, Blue Sky, Multi-year Base
and IPO Base use the same stage-selected records as individual conditions.
Numeric thresholds and the holding policy are editable in the existing preset
panel. Changed thresholds are evaluated directly instead of using unchanged
precomputed matches. The defaults are research starting points.

Fresh Breakouts and Holding Breakouts apply quality checks to `selection`
(pre-breakout context) and contraction/depth checks to the frozen `base`.
Extension and pivot holding use current observations. Forming presets use
current context. Blue Sky requires no higher close in the available cache and history beginning
within seven calendar days of the official listing. This coverage check does
not independently audit missing bars or historical adjustments.

Targeted preset tests cover edited thresholds, frozen quality, session
alignment and strict/retest policies. Rendered fixture checks verify editing, Apply persistence, stage selection,
chart opening and Escape/focus restoration. Full-universe performance acceptance
and historical validation remain outstanding.

## Chart integration

Daily chart generation embeds the same deterministic selected base summaries
as scanner publication. Clicking a symbol opens its immutable-revision chart
on demand. The viewer shows daily candles and volume, the detected floor/pivot
range through the last base session, a pivot line, a breakout marker and concise
quality measurements. Stage selection is independent of filter editing. Missing
base records render plain candles; missing chart publication shows an error.
The chart payload remains backward compatible through an optional `bases` field.

Chart-generation fixtures verify equality with scanner base summaries, including
pre-breakout boundaries. SVG geometry tests verify the overlay coordinates and
missing-history behavior. Browser interactions have been verified with a labelled integration fixture.
Full-data performance acceptance remains outstanding.

## Local historical replay

From the pipeline directory, run:

```sh
python3 replay_base_breakouts.py --symbols RELIANCE --fee-bps 10 --slippage-bps 10
```

RS ranks still use the complete current eligible universe before optional symbol
selection. The default output is `.scanner_cache/base-replay.json.gz`. Qualified
Fresh Breakouts enter at the next session open. A closing stop or armed-MA exit
signal executes at the following session open. Fixed 5/20/60-session outcomes
exit at each horizon's final close and remain independent of trade exits.
Fees and slippage are applied on both sides. Incomplete observations stay null.
The output includes returns, excursions, failed pivot holds, counts and execution
assumptions. Historical membership reconstruction and validation of the proposed
thresholds on complete real histories are still required before interpreting
these results as an unbiased performance estimate.

## Detection and hierarchy policy

The newest mature episode per stage is selected deterministically. Overlapping
episodes remain in the private archive. A child increments its parent's nested
count only after reaching minimum duration while the parent remains forming.
Parent invalidation is recorded on active children; children remain independent
formations. A failed poke is confirmed when a close returns inside within ten
sessions without exceeding the frozen intraday ceiling. Configurable touch
tolerance is part of episode identity.

Invalid candles and duplicate dates are rejected. Missing trading sessions are
not fabricated. Closing 52-week measures require 252 sessions. Follow-through
continues after trade exit. Forward horizons require complete observations.
Intraday peak-to-trough drawdown is conservative: OHLCV cannot establish the
order of a session's high and low.

## Validation status

74 frontend TypeScript tests and 15 Worker tests passed, including base metric/arithmetic
parity; Wrangler dry build and frontend production build passed. The pipeline
suite passed 230 tests including hierarchy and failed-poke fixtures. Publication/bridge
coverage passed 46 tests, including the three new release-coverage audit tests. The latest
code and documentation CI checks pass. Final aligned-data and production performance
acceptance remain required.

The local stock artifact is dated 30 September 2026 while most OHLCV files
end on 1 October and omit 30 September. A separate 1 October benchmark covers
2,589 aligned histories; this is not a published release or proof that the
September snapshot was validated across the complete universe.

Public context includes the fields used by all seven presets and common strength
filters. Expanded SMA/EMA distance, slope and ratio variants remain in private
selected records; the dependency registry sends those complete expressions to
the advanced Worker. Published numeric values retain full precision.

Replay accepts `--stop-pct` and `--trail-period` to regenerate episodes under
a different exit policy. Each configuration changes stable episode identity.

Worker integration fixtures now exercise a nested Nexus preset plus a private
MA metric through all 32 checksum-verified R2 shards and verify edge-cache reuse.
The base measurement optimization matched complete episode JSON on RELIANCE,
TCS, VENUSPIPES and HDFCBANK. The intermediate full-universe benchmark produced 503,808 episodes over 2,589 aligned histories in 1,086.6 seconds (18.1 minutes), compared with 1,599.1 seconds before date-position caching. Peak process RSS was 4.51 GB. A later array-reuse optimization has exact full-episode parity on the four stocks above; its full-universe timing remains to be measured.


### Browser and payload measurements

A local browser fixture merged real 1 October base summaries for 2,589 symbols
with the existing table snapshot. It explicitly aligned the base fields only;
other table fields were sizing fixtures, and no release was published. The
production snapshot Web Worker ran eleven distinct warm thresholds for each
case, avoiding identical-query result-cache reuse:

- Forming-base depth: 1.8–2.4 ms, returning 1,893–1,914 matching rows.
- Strong Bases preset: 9.2–11.0 ms; no matches on this particular dataset.
- Cold load plus first scan: 81.7 ms and 98.3 ms respectively on the local desktop.
- No main-thread long-task entries were observed during these runs.

These are desktop, local-fixture measurements, not mobile or network latency
claims. Real base summaries plus the existing stock fields compressed into
219,232-byte core, 2,334,640-byte technical and 351,616-byte fundamental packs
(2,905,488 bytes total). This passes the payload-size targets for the sizing
fixture; complete production session alignment remains a separate gate.

The exact CI pipeline test command now works without a custom PYTHONPATH. The
five new test modules resolve their source directory relative to their own file,
matching existing test conventions. The current results are 230 pipeline tests,
43 frontend Python publication/bridge tests and 74 frontend TypeScript tests.
Chart dialogs initialize to the base stage selected in the results table.


### Advanced runtime measurement and memory policy

A local private-runtime fixture used all 2,589 aligned histories, the production
32-shard binary encoder (up to 1,500 sessions per symbol), real selected base
contexts and the existing table metadata. It omitted dated filings/delivery,
base slices and complete episode archives; therefore it is not a complete
production upload or an upper bound for every condition.

A forming-base plus positive EMA150-distance expression returned 605 matches,
matching Python's count. The HTTP Worker handler verified all runtime objects
and exercised the revision response cache. Eager batch decoding measured
1.32 seconds and 157,922,942 bytes of observed Node heap plus array buffers.
The decoder now yields one stock at a time, uses views for dates/interleaved
values, and processes one shard at a time. With Node old space capped at 64 MB,
this fixture measured 1.64 seconds, 77,034,642 bytes observed heap plus array
buffers, and a 1.54 ms local cached response. Unrestricted Node GC can retain
more transient buffers; these are not Cloudflare isolate measurements or R2
network latency claims. Cloudflare runtime, complete auxiliary data and worst
supported-expression acceptance remain outstanding.

Private publication selects each symbol's runtime base IDs once, rather than
repeating selection for every historical episode. Archive contents and selected
IDs are unchanged, and the archive-isolation fixture verifies the single call.


### Latest publication and replay changes

Fresh breakouts include ages 0–5 sessions; age 6 enters the holding stage.
Replay accepts an explicit `--as-of` cutoff and a symbol subset. Strength and
industry observations still use the complete aligned universe, rather than
ranking only the requested replay symbols. Current context is shared read-only
between episodes, and frozen context is shared by observation date; public
projection creates independent output dictionaries.

Aligned native stock fields now live in auxiliary shards beside their histories.
The global metadata index retains only identity, universe and alignment fields.
Stocks without aligned history retain their full metadata for metadata-only
conditions. The Worker reconstructs compact public base explanations for response
rows, without exposing private base slices or expanded context fields.

One cold scan runs per isolate, with at most seven additional queued requests;
cache hits bypass that queue. A full queue returns a concise 503 response. The
scanner identity also fingerprints private publication and Worker code, so a
wire-format change requires matching publication and deployment.

The latest local Workerd run of this limited fixture returned 605 matches in
937 ms, with a 7.6 ms cached response. Four queued scans returned 570, 519,
483 and 444 matches in 3.46 seconds total. Eight inspector observations measured
a peak of 96,261,349 bytes of heap plus backing storage. Sampling can miss brief
peaks; complete auxiliary-data and worst-expression validation remain required.
These measurements used local R2 fixtures, with no production bucket updates.


### Deterministic base queries

The text compiler supports the same base conditions as the visual builder.
Stages and metric paths are validated against the published contract. Numeric
comparisons preserve strict `>` / `<` and inclusive `>=` / `<=` semantics.
Nested AND/OR groups and repeated clauses are retained; unsupported clauses
reject the entire query.

```text
Base Stage(FORMING)
AND Base Metric(FORMING, current.rsRating) >= 80
AND Base Metric(FORMING, base.depthPct) <= 25
AND Base Formula(FORMING, base.parts.half_2.volume, DIVIDE, base.parts.half_1.volume) <= 0.8
```

```text
Base Stage(FRESH_BREAKOUT)
AND Base Metric(FRESH_BREAKOUT, breakoutAgeSessions) <= 5
AND Base Metric(FRESH_BREAKOUT, breakout.volumeRatio) >= 1.5
```

`Base Stage(HOLDING, STRICT)` requires uninterrupted pivot holding; `RETEST`
requires the latest close to hold the pivot. Base Formula accepts ADD, SUBTRACT,
MULTIPLY or DIVIDE over two whitelisted metrics of the same selected episode.
Private metrics send the complete query to the advanced service. Results show
base explanations and stage-specific charts for text queries as well as filters.
Cross-language compiler tests cover all three functions and invalid syntax.

The current CLI was replayed through 1 October for RELIANCE, TCS, VENUSPIPES
and HDFCBANK while retaining full-universe strength calculations. It selected
five trades. An independent check against the source CSVs verified all five
next-session-open entries, five next-session trade exits and fifteen 5/20/60
session outcome returns, costs and excursion measurements. This small sample
checks execution correctness; it does not establish threshold effectiveness.
The report records the 30 September metadata date separately from the replay
cutoff, preserving the known current-classification limitation.

Private retention keeps seven complete revisions including the previous active
Git-pointer revision and the newly uploaded revision. The active revision is
protected even after multiple uploads fail later chart or pointer promotion.
Manifest-less uploads do not count as completed rollback revisions. Tests check
that an oldest active revision survives eight newer complete uploads, and that
the publication path passes its active pointer revision into private retention.

Chart generation uses `selected_only=True` to retain at most four full episodes
per symbol after detection. It computes strength against the complete universe
and uses the same deterministic stage selection as scanner publication. Tests
compare selected chart output, including detailed slices and frozen context,
against selection from full episode history. Full scanner archives and replay
continue retaining every episode; no historical observations are removed.


### Broad-result and auxiliary-data memory checks

An all-match local Workerd query exposed excessive retention: keeping full rows
before pagination sampled 142 MB. The Worker now retains only symbol, sort value
and shard location, then reconstructs complete rows for the requested page.
Cross-shard sorting/pagination tests verify native fields and base explanations.
Owned decompressed buffers and temporary candle columns are released after use
where ArrayBuffer transfer is supported; older engines retain the GC fallback.

Private delivery data is published as integer-day and percentage columns,
restricted to retained candle sessions. Duplicate ordering is preserved. Both
columnar and legacy row formats are supported by the shared engine; parity tests
cover duplicate dates, latest delivery, spikes and unavailable percentages.
Filings omit only identity/provenance strings unused by the scanner; numerical
fields, report basis and filing/quarter dates remain. Original provenance remains
in pipeline artifacts and chart events.

The broader fixture includes 2,586 delivery histories, 2,431 financial ledgers
and 346 benchmarks for 2,589 stocks. Runtime and selected-base archive objects
compressed to 60,497,474 bytes. An all-match scan with a 100-row page took
1,729 ms cold and 11.2 ms cached. Four queued cold scans took 6.69 seconds total;
ten inspector observations sampled a maximum of 81,072,852 bytes of heap plus
backing storage. This fixture still lacks detailed base slices and complete
historical episode archives; worst supported expressions and real R2 network
latency remain separate acceptance gates. No production data was published.


Detailed slices were subsequently calculated from each selected base's original
candle boundaries and added to the same full-auxiliary runtime fixture. An
all-match 100-row-page scan measured 1,896 ms cold, 11.0 ms cached and 96,293,572
bytes sampled heap plus backing storage. A separate maximum-leaf fixture used
one price comparison plus 31 private base-slice arithmetic leaves in a nested
boolean expression, with all leaves evaluated: 2,054 ms cold, 11.4 ms cached,
89,278,788 bytes sampled memory across five cold scans. No full-history archive
objects were read by these latest-session scans. These are observed local
measurements, not production Cloudflare CPU or guaranteed peak memory values.


### Reproducible release-data coverage audit

Run this read-only check against a pipeline directory before claiming complete
release-data coverage:

```sh
python3 scripts/check_base_data_alignment.py --root /path/to/pipeline --session 2026-09-30
```

It reports eligible-stock metadata dates, candle coverage at the requested
cutoff and representative missing symbols. Future candles cannot substitute for
a missing release session. Exit 0 means every eligible stock has metadata and a
candle at that exact session; exit 1 reports incomplete coverage, and exit 2
reports invalid inputs. Without `--session`, mixed metadata dates require an
explicit cutoff. This strict coverage audit does not replace candle integrity,
financial correctness or publication checksum tests. Suspended/new listings may
legitimately be unavailable; the runtime still handles them as unavailable rather
than inventing observations.

The current original local files contain 2,605 eligible stocks: 2,591 metadata
rows dated 30 September, 13 dated earlier, and one without a date. At the
30 September cutoff, only eight histories have that session, 2,591 omit it
and six have no history at the cutoff. This independently confirms that these
files cannot prove complete latest-session release alignment. Three focused tests
cover future-candle exclusion, eligible-universe selection and mismatched metadata.


### Bounded historical archive generation

The former full-history benchmark was stopped after a macOS process sample
reported a 25 GB physical memory footprint. Its final timing was not obtained;
that run must not be reported as passing generation acceptance.

Scanner publication now sends each symbol's complete episodes to 32 compressed
archive streams before retaining only its selected runtime episodes. The
archives preserve every episode, including invalidated formations; public and
private runtime selections retain the same IDs and numerical facts. Temporary
streams live outside source data and are removed on publication success or
failure. Private pack construction copies the finished archives and includes
their exact bytes and checksums in the upload manifest. Chart generation keeps
its existing selected-only path. Replay still supports complete episodes.

Regression tests compare complete episode objects with the sink output, compare
all selected metrics against the non-streaming implementation and check that
private packs contain the complete archived objects even when runtime episode
lists are empty. All 230 pipeline, 47 publication/bridge, 74 frontend TypeScript
and 15 Worker tests pass; frontend production build and Worker type/dry-build
checks pass. The replacement full-generation benchmark completed for 2,589
aligned stocks: 503,808 complete episodes archived, 5,360 selected episodes
retained for runtime, 1,355.82 seconds (22.60 minutes), and 3,530,702,848 bytes
peak process RSS. Complete compressed archives occupy 1,142,974,331 bytes.
This benchmark used the older local stock artifact with the 1 October candle
cutoff; the newer 2,603-row recovered-data publication is a separate check.


The local Python bridge also retains only selected stage episodes. Cached base
text queries preserve the same selected ID across different thresholds. The
replay CLI consumes complete episodes one symbol at a time and retains the
qualified trade reports, preserving all historical candidates. Its four-stock
real-data output is exactly equal to the preceding implementation's entire JSON
payload (five trades, all costs and outcomes). Publication/bridge coverage now
passes 48 tests.

The newer Git stock artifact has 2,603 eligible rows and resolves the latest
session to 1 October. Against the existing original OHLCV cache, 2,591 histories
match that session; eleven omit it and one has no history at the cutoff. The
2,591 matching rows also carry 1 October metadata. The remaining rows have
older or missing metadata. This is a materially stronger source-data check than
the earlier mixed-date sizing fixture, but complete publication with the
recovered Actions history and explicit unavailable handling remains to be run.


The Actions `recovered-scanner-history` archive from run `37202681739` was
downloaded and its ZIP SHA-256 verified against GitHub's artifact descriptor:
`84ab17f2ee364cd4708741d684abc72e54a373cd21953ba29aee44985ebb2bb7`.
It contains 5,644 files and was extracted only into a temporary validation root.
All 2,602 recovered OHLCV CSV files are byte-identical to their existing local
counterparts. The recovered cache confirms the same 2,591 aligned and twelve
stale/unavailable stocks for the newer 1 October Git artifact.

A separate all-symbol check found 76 OHLCV field differences between the Git
stock metadata and these authoritative candle files. Snapshot publication
already replaces aligned rows' open/high/low/close/volume with their candle
values; final release validation must verify those replacements rather than
assume date equality proves numeric equality. No source prices were edited.
